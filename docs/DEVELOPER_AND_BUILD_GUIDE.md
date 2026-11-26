# Vespera Client — Developer & Build Guide

This guide explains the repository layout, prerequisite toolchains, reproducible build commands for every subsystem, Microsoft Entra ID (Azure) OAuth Client ID setup, and automated verification suites.

---

## 1. Repository Structure

```
/home/user/Mcclient
├── shared/                      # Cross-platform TypeScript domain models, version catalog,
│   ├── types.ts                 #   mod compatibility database, RAM/GC synthesizer, HUD defaults
│   ├── versionCatalog.ts
│   ├── modCatalog.ts
│   ├── performanceEngine.ts
│   ├── hudDefaults.ts
│   └── defaultProfilesAndPacks.ts
├── ui/                          # Native Launcher Frontend (TypeScript + Modern CSS + Vite)
│   ├── index.html
│   ├── public/                  # Generated SVG/PNG brand marks
│   └── src/                     # 12 Launcher pages + Interactive HUD Studio + RPC bridge
├── server/                      # Node/TypeScript Reference Backend, Auth, Modrinth, Diagnostics
│   ├── securityUtils.ts         # AES-256-GCM vault, path traversal guards, log token redaction
│   ├── authService.ts           # Official Microsoft OAuth 2.0 -> XBL -> XSTS -> MC Services
│   ├── modManagerService.ts     # Modrinth v2 client, dependency solver, conflict gatekeeper
│   ├── minecraftLauncherService.ts # Official Mojang/Fabric downloader, SHA-1/256, JVM spawner
│   ├── diagnosticsAndBenchmarkService.ts # Doctor, Crash Analyzer, OpenJDK 21 Benchmark Suite
│   ├── stateStore.ts            # Atomic state persistence, backups, rollback, crash lock
│   └── rpcRouter.ts             # Unified JSON-RPC dispatcher
├── native/                      # Native Windows 10/11 (x86_64) C++17 Desktop Host & Installer
│   ├── src/
│   │   ├── win32_platform.hpp   # WinHTTP TLS, CNG BCrypt SHA-1/256, DPAPI vault, COM shortcuts
│   │   └── vespera_launcher.cpp # Standalone WebView2 GUI Launcher + Full Native RPC Engine
│   ├── installer/
│   │   ├── vespera_setup.cpp    # Native Win32 GUI + Silent (/S) Setup Installer Wizard
│   │   └── vespera_uninstall.cpp# Native Win32 GUI + Silent (/S) Clean Uninstaller
│   ├── resources/               # vespera.ico (7-size RGBA), vespera.manifest, *.rc descriptors
│   └── third_party/             # webview/webview, WebView2 COM headers, nlohmann/json v3.12.0
├── src-tauri/                   # Optional Tauri 2 Rust desktop wrapper configuration
├── mod/                         # Custom Kotlin Fabric Client-Side Mod (MC 1.21.4 / Java 21)
│   ├── build.gradle.kts         # Standard Fabric Loom Gradle build definition
│   ├── src/main/kotlin/gg/vespera/client/ # Mod entrypoint, 12 HUD modules, Zoom, Sprint, QoL, Sync
│   ├── src/main/resources/      # fabric.mod.json, vespera.mixins.json, assets/vespera/icon.png
│   └── src/test/kotlin/         # 23-assertion JVM 21 unit test suite
├── scripts/                     # Build, branding generator, mod compiler, benchmark, PE32+ verifier
├── tests/                       # Vitest unit & integration test suite
└── release/                     # Final verified Windows x64 executables, Setup .exe, .ico, .jar
```

---

## 2. Reproducible Build Pipeline

### Prerequisites
- **Node.js 20+ / 22+** and **npm 10+**
- **Java 21 LTS** (Eclipse Temurin / OpenJDK 21; provided in `.venv` via `jdk4py` or `JAVA_HOME`)
- **Kotlin Compiler 2.0+** (installed automatically via `npm install` in `node_modules/kotlin-compiler`)
- **Zig 0.14+ / 0.17+** C++17 & Windows RC cross-compiler (`zig c++ -target x86_64-windows-gnu` and `zig rc`; provided in `.venv` via `ziglang`, or native MSVC/MinGW-w64 on Windows)

### Step-by-Step Build Commands

```bash
# 1. Install Node & Kotlin compiler dependencies
npm install

# 2. Generate brand SVGs, 128px PNGs, and 7-resolution Windows native/resources/vespera.ico
npm run build:branding

# 3. Typecheck and bundle the TypeScript/CSS desktop UI into dist/ui/
npx tsc --noEmit
npm run build:ui

# 4. Compile the Kotlin Fabric 1.21.4 Client Mod JAR (release/mods/vespera-client-1.2.1+mc1.21.4.jar)
#    and standalone JVM benchmark harness (dist/bench/vespera-benchmark-runner.jar)
npm run build:mod

# 5. Compile all 64-bit Windows PE32+ GUI executables and Setup Wizard into release/
npm run build:windows

# Or run the entire end-to-end build in a single command:
npm run build:all
```

### Standard Gradle Fabric Loom Build (When Online with Fabric Maven Access)
Developers working on machines with direct access to `maven.fabricmc.net` and `maven.terraformersmc.com` can also open `mod/` directly in IntelliJ IDEA and run:
```bash
cd mod
gradle build runClient
```

---

## 3. Configuring a Microsoft Entra ID (Azure) OAuth Client ID

Vespera Client never hardcodes secret third-party credentials and never uses unofficial authentication workarounds. To enable official Microsoft account sign-in for your own build or deployment:

1. Sign in to the [Microsoft Entra Admin Center](https://entra.microsoft.com/) -> **Identity** -> **Applications** -> **App registrations** -> **New registration**.
2. Set **Name** to `Vespera Client` and **Supported account types** to:  
   *Accounts in any organizational directory and personal Microsoft accounts (e.g. Xbox, Outlook.com)*.
3. Under **Redirect URI**, select **Public client/native (mobile & desktop)** and enter:  
   `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Open **Authentication** -> **Advanced settings** -> set **Allow public client flows** to **Yes** (enables OAuth 2.0 Device-Code Flow) and click **Save**.
5. Copy the **Application (client) ID** UUID and configure it in either of two ways:
   - **In the Launcher UI**: Go to **Accounts -> Microsoft OAuth Client ID Setup**, paste the UUID, and click **Save Client ID**.
   - **Via Environment Variable**: Set `VESPERA_MSA_CLIENT_ID=<your-client-id-uuid>` before launching Vespera Client.

*(Note: For public commercial distribution to external players, submit the standard [Minecraft Services API Access Form](https://help.minecraft.net/hc/en-us/articles/16254801392141) so Microsoft whitelists your Entra Client ID for `XboxLive.signin` Minecraft token exchange.)*

---

## 4. Running Automated Tests & Release Verification

```bash
# Run the complete verification pipeline:
npm test
```

What `npm test` executes:
1. **`npm run test:unit` (Vitest)**: Tests path-traversal defenses, token log redaction, AES-256-GCM encrypted vault tamper detection, RAM/GC flag synthesis, visual-fidelity preservation, Modrinth conflict blocking (`OptiFabric`/`Indium`), transitive dependency auto-installation, profile isolation, backup/rollback, `.vesperaprofile` import/export, `options.txt` materialization, and official auth gatekeeping.
2. **`npm run test:mod` (OpenJDK 21)**: Compiles and runs 23 unit assertions against the Kotlin Fabric Mod classes (`FrameTimeAnalyzer`, `CpsRingTracker`, `ServerTpsEstimator`, `HudEditorSolver`, `HudColorCodec`, `HudFormatters`, `ZoomController`, `ToggleSprintController`, `ChatCompactProcessor`, `TooltipEnhancer`, and `LauncherSyncBridge`).
3. **`npm run test:verify-artifacts` (PE32+ & Checksum Verifier)**: Parses the binary DOS/COFF/PE32+ headers of `VesperaClient-1.2.1-win64-setup.exe`, `VesperaClient.exe`, and `VesperaUninstall.exe` to confirm `IMAGE_FILE_MACHINE_AMD64` (`0x8664`), `IMAGE_SUBSYSTEM_WINDOWS_GUI` (`2`), embedded `.rsrc` icon/manifest sections, clean Fabric Mod JAR contents, and exact `SHA256SUMS.txt` integrity.
