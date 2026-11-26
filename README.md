# Vespera Client v1.1.0

**Precision Minecraft Java Edition Client & Native Windows 10/11 Launcher**  
*Performance + Visual Fidelity + Dynamic Multi-Version Management + Frictionless Microsoft OAuth — Zero Electron Bloat*

---

## Executive Summary

**Vespera Client** (`gg.vespera.client`) is a production-grade Minecraft Java Edition client ecosystem and native 64-bit Windows desktop launcher engineered as a modern, transparent, open-architecture alternative to Lunar Client and Badlion Client.

### What's New in v1.1.0
1. **Frictionless Microsoft Account Sign-In (OAuth 2.0 PKCE + Device Code Fallback)**:
   - End users **never** enter or create a Microsoft Azure/Entra Client ID in the UI. Public Client ID configuration is separated cleanly into build-time maintainer configuration (`config/oauth.release.json` / `config/oauth.local.json` / `VESPERA_MSA_CLIENT_ID`) with zero client secrets and zero fake IDs.
   - **Primary Browser PKCE Flow**: Opens the system default browser (`ShellExecuteW` on Windows) with RFC 7636 `S256` PKCE + CSRF `state` verification and an ephemeral `http://127.0.0.1:<port>/callback` loopback listener, completing **Microsoft -> Xbox Live -> XSTS -> Minecraft Services -> Java Ownership Entitlement -> Profile** automatically.
   - **Secondary Device Code Fallback**: Built-in fallback for restrictive local firewall environments.
   - **Legitimate Offline Singleplayer Mode**: Strictly gated to previously verified Java Edition accounts when local game files are already verified on disk (`--accessToken 0 --disableMultiplayer --disableChat`). Never fabricates tokens or bypasses online multiplayer authentication.
2. **Dynamic Official Minecraft Version Manager & Multi-Stage Installer**:
   - Live sync with Mojang's official `version_manifest_v2.json` across **Releases**, **Snapshots**, **Old Beta**, and **Old Alpha** (newest-to-oldest) with offline manifest caching.
   - **12-Stage Verified Downloader & Installer**: Downloads `<version>.json`, `<version>.jar`, `<assetIndex>.json` + asset objects, OS-filtered Maven libraries, native `.dll`/`.so` extraction, and optional **Fabric Loader** metadata—with **SHA-1 cryptographic verification**, **HTTP `Range` `.part` resumption**, cancellation, integrity repair, and safe version deletion.
   - **Automatic Per-Version Java Runtime Provisioning**: Auto-detects and provisions **Java 21** (`1.20.5+`), **Java 17** (`1.18–1.20.4`), and **Java 8** (`<= 1.16.5`, `1.12.2`, `1.8.9`, Beta/Alpha), or honors custom Java paths.
3. **Honest Version Compatibility & Strict Mod Isolation**:
   - `1.21.4` -> **Vespera Supported** (Vanilla + Fabric + `vespera-client-1.1.0+mc1.21.4.jar` custom HUD/QoL mod).
   - `1.14` – `1.21.x` (non-`1.21.4`) -> **Fabric Supported** (Vanilla + Fabric Loader; Vespera's `1.21.4`-compiled custom JAR is automatically isolated so older versions never crash with linkage mismatches).
   - `<= 1.13.2` (`1.12.2`, `1.8.9`, Beta, Alpha) -> **Vanilla Only** (100% selectable, installable, and launchable with legacy `minecraftArguments` expansion).
   - Snapshots -> **Experimental**.

---

## Verified Windows 10/11 (x86_64) Release Deliverables (`v1.1.0`)

All Windows binaries are compiled as native 64-bit (`PE32+ AMD64`, `IMAGE_SUBSYSTEM_WINDOWS_GUI`) executables with embedded multi-resolution `.ico` resources and `PerMonitorV2` High-DPI manifests:

| Deliverable | Path | Size | SHA-256 |
| :--- | :--- | ---: | :--- |
| **Windows Setup Installer** | `release/VesperaClient-1.1.0-win64-setup.exe` | `1,966.0 KB` | `047c69fda182dee1ffe3e18b239a4a8052e7ad266f177aefb92fecfc34777f4b` |
| **Native Desktop Launcher** | `release/bin/VesperaClient.exe` | `1,428.0 KB` | `a4539d786995cf3ed25ec599c426cddfd2dafce28761ddff5f36e895a0e0980f` |
| **Native Windows Uninstaller** | `release/bin/VesperaUninstall.exe` | `223.0 KB` | `52cbca40c1ba6c5a4b1916df892768520040878d3b5e7e4f0ccab476f21a7c13` |
| **Custom Fabric Client Mod** | `release/mods/vespera-client-1.1.0+mc1.21.4.jar` | `57.5 KB` | `fd05e3a520633d56fbe7a5c137d355917aa53b086366eba6c3d50d193c0edb4c` |
| **Windows Application Icon** | `release/vespera.ico` | `18.3 KB` | `9b58a181e96a143761c2234291d53545468d6d1fda507f6306dd090210e11cef` |
| **Release Checksums** | `release/SHA256SUMS.txt` | `0.5 KB` | Verified by `npm run test:verify-artifacts` |

### Verification Scope Note
- **Verified Automatically in Build & Test Pipeline**: Full TypeScript/UI compilation, OpenJDK 21 Kotlin Fabric Mod compilation & 23 unit tests, Zig/MinGW-w64 `x86_64-windows-gnu` C++17 native cross-compilation (`Win32` + `WebView2` + `WinHTTP` + `WinSock2` + `DPAPI` + `BCrypt`), PE32+ binary header/resource/SHA-256 inspection, and 25 automated Vitest unit & integration tests (PKCE loopback callback, CSRF state rejection, Device Code flow, token refresh, Offline Singleplayer gating, Mojang manifest parsing, SHA-1 + HTTP `Range` resumable installation, PKZIP native extraction, Java 8/17/21 selection, and v1.0.0 -> v1.1.0 profile migration).
- **Requires Native Windows Host + Registered Entra App ID for Live End-to-End Sign-In**: Live interactive Microsoft browser authentication and native DirectX/OpenGL Minecraft window execution require running `VesperaClient.exe` on Windows 10/11 with Edge WebView2 Runtime and a maintainer-configured Microsoft Entra Public Client ID (see [`docs/OAUTH_DEVELOPER_SETUP.md`](docs/OAUTH_DEVELOPER_SETUP.md)).

---

## Quickstart Commands

```bash
# Run full automated verification (25 Vitest tests + 23 Kotlin JVM 21 mod tests + PE32+ binary & OAuth security verification)
npm test

# Rebuild everything from source (UI -> Kotlin Fabric Mod JAR -> 64-bit Windows Binaries & Setup Installer)
npm run build

# Build with a registered Microsoft Entra Public Client ID embedded at build time
VESPERA_MSA_CLIENT_ID="YOUR-PUBLIC-CLIENT-UUID" npm run build

# Launch local desktop UI preview server (http://0.0.0.0:4173)
npm run preview
```

---

## Documentation Index

- **[Maintainer Microsoft OAuth 2.0 Setup Guide](docs/OAUTH_DEVELOPER_SETUP.md)** — Entra ID public client registration, loopback redirect URIs, `config/oauth.local.json` vs `VESPERA_MSA_CLIENT_ID`, and zero-secret security architecture.
- **[User Guide](docs/USER_GUIDE.md)** — Installation, Microsoft Sign-In & Offline Singleplayer, Dynamic Version Manager, Performance & Shader tuning, HUD Editor, and Profiles.
- **[Developer & Build Guide](docs/DEVELOPER_AND_BUILD_GUIDE.md)** — Repository layout, reproducible build toolchain, and automated test suites.
- **[Architecture, Compatibility Matrix & Fair-Play Policy](docs/ARCHITECTURE_AND_COMPATIBILITY.md)** — Native Win32/WebView2 IPC, version compatibility tiers, mod conflict matrix, and security design.
- **[Benchmark & Telemetry Report](docs/BENCHMARK_REPORT.md)** — Measured OpenJDK 21 frame-pacing, chunk-meshing, culling, and GC pause results.

---

## License

Released under the [MIT License](LICENSE). Minecraft is a trademark of Mojang Synergies AB / Microsoft Corporation; Vespera Client is an independent community project and is not affiliated with Mojang or Microsoft.
