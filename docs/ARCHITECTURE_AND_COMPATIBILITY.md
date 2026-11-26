# Vespera Client — Architecture, Compatibility Matrix & Fair-Play Policy

## 1. System Architecture

Vespera Client is engineered as a cleanly decoupled four-layer architecture so every component is fast, testable, and maintainable:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Frontend UI Workbench (ui/src/* — TypeScript + Modern CSS)           │
│    - 12 pages + Interactive Drag/Snap HUD Studio + First-Launch Wizard  │
│    - 29.0 KB gzipped JS + 3.3 KB gzipped CSS (Zero heavy UI frameworks) │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ Typed JSON-RPC Bridge (bridge.ts)
        ┌───────────────────────┴────────────────────────┐
        ▼                                                ▼
┌───────────────────────────────────────┐  ┌──────────────────────────────┐
│ 2A. Native Windows 10/11 Host         │  │ 2B. Cross-Platform Node Core │
│ (native/src/vespera_launcher.cpp)     │  │ (server/*.ts + shared/*.ts)  │
│ - C++17 + Microsoft Edge WebView2     │  │ - Vitest-verified reference  │
│ - WinHTTP TLS 1.2/1.3 (Mojang/Modrinth│  │   implementation & preview   │
│   /Microsoft OAuth2/Fabric Meta)      │  │ - AES-256-GCM token vault    │
│ - Windows CNG BCrypt SHA-1 / SHA-256  │  │ - Real JVM benchmark runner  │
│ - Windows CryptProtectData (DPAPI)    │  └──────────────────────────────┘
│ - CreateProcessW real JVM launcher    │
└───────────────────┬───────────────────┘
                    │ Atomic JSON File Sync (%APPDATA%\VesperaClient\ipc\)
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. Custom Fabric Client Mod (mod/src/main/kotlin/gg/vespera/client/*)   │
│    - Compiled Kotlin 2.4 -> Java 21 Bytecode (vespera-client-1.0.0.jar) │
│    - 12 HUD Modules, In-Game HUD Studio (RShift), Zoom (C), ToggleSprint│
│    - LauncherSyncBridge: live hot-reload of HUD layouts + telemetry IPC │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why Native Win32 + WebView2 Instead of Electron?
- **Binary Size**: `VesperaClient.exe` is **1.10 MB** (`VesperaClient-1.0.0-win64-setup.exe` is **1.64 MB** total), compared to **180–320 MB** for Electron-based launchers.
- **Memory Overhead**: Uses Windows 10/11's built-in Evergreen WebView2 shared runtime and automatically sheds UI buffers (`idle_low_memory` mode) the moment Minecraft launches, freeing maximum physical RAM for the Java heap and GPU shader caches.
- **Optional Tauri 2 Scaffold**: `src-tauri/` is also included for environments where a Rust/Cargo Tauri 2 build target is desired alongside the standalone C++17/Zig Windows build.

---

## 2. Minecraft Version Support Matrix & 1.8.9 PvP Evaluation

Vespera Client never pretends every mod works across every Minecraft release. Each version is explicitly classified into **Supported**, **Experimental**, or **Unsupported**:

| Minecraft Version | Tier | Mod Loader | Required Java | Optimization & Mod Stack Status |
| :--- | :--- | :--- | :--- | :--- |
| **`1.21.4`** *(Primary)* | **Supported** | Fabric `0.16.10` | **Java 21 LTS** | Full Vespera Client Mod `1.0.0`, Sodium `0.6.5`, Iris `1.8.5`, Lithium, FerriteCore, ModernFix, ImmediatelyFast, ETF/EMF, Continuity |
| **`1.21.3`** | **Experimental** | Fabric `0.16.10` | **Java 21 LTS** | Transitional protocol; select visual add-ons skip `1.21.3` in favor of `1.21.4` |
| **`1.21.1`** | **Supported** | Fabric `0.16.10` | **Java 21 LTS** | Broad community modpack ecosystem; Sodium `0.6+` & Iris `1.8+` verified |
| **`1.20.4`** | **Supported** | Fabric `0.16.9` | **Java 17 / 21** | Stable modern competitive multiplayer target |
| **`1.20.1`** | **Supported** | Fabric `0.16.9` | **Java 17 LTS** | Long-term modded survival target |
| **`1.8.9`** *(Legacy PvP)* | **Experimental** | Legacy Fabric `0.15.11` | **Java 8 (1.8.0_422)** | **Isolated Legacy PvP Profile** — see technical tradeoff evaluation below |
| **`1.12.2`** | **Unsupported** | None | Java 8 | Explicitly unsupported: incompatible legacy Forge LWJGL2 pipeline |

### Engineering Evaluation: Modern `1.21.4` vs Legacy `1.8.9` PvP
1. **Why `1.21.4` is Primary**: Modern Minecraft (`1.21.4`) runs on LWJGL 3 + OpenGL 4.6 Core Profile + Java 21 Generational ZGC, enabling Sodium's multi-draw indirect chunk renderer, Iris PBR shaders, high-DPI PerMonitorV2 scaling, and modern competitive gamemodes (Mace PvP, Crystal, SMP, Minigames).
2. **How `1.8.9` Legacy PvP is Supported Safely**: Legacy `1.8.9` uses LWJGL 2, Java 8 (`UseG1GC` without `ZGenerational`), and completely different obfuscation mappings (`Intermediary` vs `Legacy Yarn`). Vespera Client supports `1.8.9` via **strict profile & directory isolation**:
   - Creating a `1.8.9` profile automatically assigns `loader: "legacy_fabric"`, `javaMajor: 8`, its own isolated `%APPDATA%\VesperaClient\instances\<profile-id>\` directory, and clears all `1.21.x` mods so `1.21.4` bytecode never crashes a `1.8.9` launch.
   - Tradeoff: Modern Sodium/Iris (`1.20+` OpenGL 4.x) cannot run on `1.8.9` LWJGL 2; legacy `1.8.9` profiles run clean Legacy Fabric + Java 8 tuned G1GC flags without modern shader pipelines.

---

## 3. Curated Mod Stack & Conflict Prevention Rules

Vespera's compatibility engine (`server/modManagerService.ts` & `shared/modCatalog.ts`) enforces strict rules before any `.jar` touches disk:

### Verified Non-Overlapping Core Stack (`1.21.4`)
- **Chunk & Terrain Rendering**: `Sodium 0.6.5` (replaces vanilla chunk mesher; includes built-in FRAPI support).
- **Server/Tick Physics & AI**: `Lithium 0.14.7` (zero rendering overlap with Sodium).
- **Memory Footprint**: `FerriteCore 7.1.1` (deduplicates blockstate/model quads in heap) + `ModernFix 5.20.2` (dynamic model loading & faster startup).
- **Immediate-Mode Entity/HUD Batching**: `ImmediatelyFast 1.3.4` (batches entities, block entities, text, and Vespera's HUD draw calls).
- **Visibility Culling**: `Entity Culling 1.7.2` (async raycast occlusion) + `More Culling 1.2.6` (block-state/leaves face culling).
- **Background Power Saving**: `Dynamic FPS 3.7.7` (throttles unfocused window only; zero impact while actively playing).
- **Optional Visual Stack**: `Iris Shaders 1.8.5`, `Entity Texture Features 6.2.9`, `Entity Model Features 2.4.1`, `Continuity 3.0.0`.

### Automated Conflict & Redundancy Blocklist
| Mod Slug | Action | Technical Reason |
| :--- | :--- | :--- |
| `optifabric` / `optifine` | **Blocked** | Directly overwrites Sodium, Iris, ImmediatelyFast, ETF, EMF, and Continuity render mixins, causing startup Mixin crashes. |
| `indium` *(on MC >= 1.21.1)* | **Blocked** | Sodium `0.6.0+` integrates the Fabric Rendering API natively. Installing old Indium builds causes `IncompatibleModException` on startup. |
| `starlight` *(on MC >= 1.20)* | **Blocked** | Mojang rewrote the lighting engine in Minecraft `1.20`, making Starlight obsolete on `1.21.x`. |
| `phosphor` | **Blocked** | Legacy lighting mod superseded by vanilla `1.20+` lighting engine. |

---

## 4. Security & Competitive Fair-Play Architecture

### Official Authentication & Credential Protection
- **Official Microsoft OAuth 2.0 Only**: Implements Microsoft Identity Platform Device-Code Flow -> Xbox Live (`user.auth.xboxlive.com`) -> XSTS (`xsts.auth.xboxlive.com`) -> Minecraft Services (`api.minecraftservices.com/authentication/login_with_xbox`) -> Game Entitlement & Profile check.
- **Zero Cracked / Offline Bypass**: Unauthenticated launch attempts halt cleanly at `authentication_required`. Passwords are never entered into Vespera Client.
- **OS-Backed Token Encryption**: Refresh tokens and Minecraft JWTs are encrypted on Windows via **CryptProtectData (`DPAPI`)** scoped to the current Windows user SID, and cross-platform via **AES-256-GCM** (`scrypt` key derivation + 96-bit IV + 128-bit authentication tag).
- **Automatic Log Scrubbing**: `redactSensitiveTokens()` strips `--accessToken <jwt>`, `Bearer <token>`, and `refresh_token` fields from every log line, crash report, and diagnostic export.

### Strictly Fair-Play Client Mod Policy
Vespera Client (`vespera-client`) is 100% compliant with competitive multiplayer server rules (Hypixel, Hoplite, MCC Island, TubNet, Vanilla SMP):
- **Allowed & Included**: Keystrokes, real ring-buffer CPS counter, FPS/1% Low, Ping/TPS estimator, Armor & Potion HUD, Coordinates/Direction, Custom Crosshair, Smooth Zoom, Vanilla-Legal Toggle Sprint (blocks sprint when `foodLevel <= 6`, while sneaking, using items, or moving backward), decorative client-only Hit Particles, Chat Duplicate Compacting, Durability/Food Tooltips.
- **Strictly Prohibited (Zero Code Present)**: No autoclickers/macros, no reach/hitbox expansion, no velocity/knockback modification, no scaffold/freelook/omni-sprint, no X-Ray/cave-finder/entity-radar, and no packet spoofing.
