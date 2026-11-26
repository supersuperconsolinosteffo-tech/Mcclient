# Vespera Client v1.0.0

**Precision Minecraft Java Edition Client & Native Windows 10/11 Launcher**  
*Performance + Visual Fidelity + Fair-Play Functionality — Zero Electron Bloat*

---

## Executive Summary

**Vespera Client** (`gg.vespera.client`) is an original, production-grade Minecraft Java Edition client ecosystem and native 64-bit Windows desktop launcher engineered as a modern, transparent, open-architecture alternative to Lunar Client and Badlion Client.

Most Minecraft clients force an artificial compromise: closed-source PvP clients lock down mod extensibility, while generic modpacks pile on overlapping mods and ship bloated 250 MB Chromium/Electron wrappers. **Vespera Client** solves all three dimensions simultaneously:

1. **Performance Engine (Without Visual Degradation)**: Coordinates a verified non-conflicting modern Fabric rendering stack (**Sodium 0.6.5**, **Lithium**, **FerriteCore**, **ImmediatelyFast**, **ModernFix**, **Entity Culling**, **More Culling**, **Dynamic FPS**) paired with hardware-aware **OpenJDK 21 Generational ZGC** or **Client-Tuned Adaptive G1GC** flags. Even in **Maximum FPS** mode, Vespera preserves Smooth Lighting (`Maximum`), `4x` Mipmaps, Biome Blend, and >=12 chunk render distance.
2. **Graphics & Shader Studio**: First-class **Iris Shaders 1.8.5** pipeline management, curated visual mods (**Entity Texture Features**, **Entity Model Features**, **Continuity**), 4 one-click shader quality tiers, and ordered Resource Pack profile management.
3. **Custom Kotlin Fabric Client Mod + Modrinth Ecosystem**: Ships `vespera-client-1.0.0+mc1.21.4.jar` (compiled for Java 21 / Fabric 1.21.4) providing 12 customizable PvP & Survival HUD modules, a live drag-and-snap **HUD Layout Studio** (`Right Shift`), smooth scroll-zoom (`C`), vanilla-legal Toggle Sprint, chat compacting, rich durability/food tooltips, and bidirectional atomic sync with the desktop launcher—while keeping full **Modrinth API v2** mod search, dependency resolution, conflict blocking, and 1-click profile rollback.

---

## Verified Windows 10/11 (x86_64) Release Deliverables

All release binaries are compiled natively as 64-bit Windows (`PE32+ AMD64`, `IMAGE_SUBSYSTEM_WINDOWS_GUI`) executables with embedded multi-resolution `.ico` resources and `PerMonitorV2` High-DPI Windows 10/11 manifests:

| Deliverable | Path | Size | Description |
| :--- | :--- | ---: | :--- |
| **Windows Setup Installer** | `release/VesperaClient-1.0.0-win64-setup.exe` | `1,637.0 KB` | Self-contained GUI + silent (`/S`) Setup Wizard with SHA-256 payload verification, Start Menu/Desktop shortcuts, and Windows Add/Remove Programs registration |
| **Native Desktop Launcher** | `release/bin/VesperaClient.exe` | `1,099.0 KB` | Lightweight C++17 + Microsoft Edge WebView2 native GUI launcher (~1.1 MB binary; <45 MB active RAM; auto-idles when Minecraft runs) |
| **Native Windows Uninstaller** | `release/bin/VesperaUninstall.exe` | `223.0 KB` | Clean GUI + silent (`/S`) uninstaller with optional preservation of `%APPDATA%\VesperaClient` worlds, screenshots, and profiles |
| **Custom Fabric Client Mod** | `release/mods/vespera-client-1.0.0+mc1.21.4.jar` | `57.5 KB` | Compiled Kotlin 2.4 / JVM 21 client-side Fabric mod (`1.21.4`) with HUD engine, HUD Studio, Zoom, Toggle Sprint, QoL helpers, and IPC sync |
| **Windows Application Icon** | `release/vespera.ico` | `18.3 KB` | Custom 7-layer 32-bit RGBA `.ico` (`16`, `24`, `32`, `48`, `64`, `128`, `256` px) |
| **Release Checksums** | `release/SHA256SUMS.txt` | `0.4 KB` | Cryptographic SHA-256 manifest verified by `npm run test:verify-artifacts` |

---

## Brand & Interface Architecture

- **Brand Identity**: **Vespera Client** — *Precision Obsidian & Solar Amber* (`#090B10` deep obsidian surfaces, `#F59E0B` solar amber primary accent, `#38BDF8` horizon cyan telemetry accent). Distinct geometry, iconography, and 3-column workbench ergonomics (`Navigation Rail` + `Main Workbench` + `Collapsible Launch & Telemetry Drawer`).
- **All 12 Launcher Pages Implemented**:
  1. **Home** — Active profile overview, system readiness, one-click Launch & HUD Studio access, optimization matrix.
  2. **Play** — Minecraft version selector (`Supported` vs `Experimental` vs `Unsupported`), Fabric Loader & Java 21 readiness, pre-flight pipeline validator, real JVM command builder.
  3. **Mods** — Installed stack control, **Modrinth API v2** live catalog search, compatibility & conflict gatekeeper (`OptiFabric`/`Indium` blocker), dependency resolver, history, and 1-click rollback.
  4. **Performance** — 4 Performance Modes (`Maximum FPS`, `Balanced`, `Visual Quality`, `Custom`), hardware-aware RAM recommender, Generational ZGC vs Tuned G1GC selector, Sodium/Culling tuning.
  5. **Graphics** — Render/Simulation/Shadow distance sliders, Clouds, Smooth Lighting, Mipmaps, Biome Blend, Entity Shadows, ETF/EMF/Continuity controls.
  6. **Shader Packs** — Master shader toggle, 4 Iris Shader quality presets (`Low`, `Medium`, `High`, `Ultra`), pack switcher.
  7. **Resource Packs** — Ordered priority stack (`Move Up` / `Move Down`), resolution & VRAM badges, texture previews.
  8. **Accounts** — Official Microsoft OAuth 2.0 Device-Code authentication flow, multi-account switcher, token refresh, Windows DPAPI / AES-256-GCM encrypted vault, Client ID setup.
  9. **Profiles** — Isolated game directories across PvP, Survival, Performance, Graphics, Vanilla+, and Custom archetypes; `.vesperaprofile` JSON import/export; timestamped backups & rollback.
  10. **Settings** — Launcher behavior when game runs (`Idle Low-Memory`, `Minimize`, `Close`), update channel (`Stable`/`Beta`) & GitHub release checker, telemetry toggles, managed data path.
  11. **Diagnostics** — Real host CPU/RAM/JVM sensors, 1-click **Diagnostics Doctor** with Auto-Fix, Crash Log Analyzer, and **Integrated OpenJDK 21 Benchmark Suite** (`Vanilla` vs `Max FPS` vs `Balanced` vs `Graphics`).
  12. **About** — Architecture summary, Fair-Play policy, open-source notices, release build verification.

---

## Quickstart Commands

```bash
# Run full automated verification (Vitest core tests + Kotlin JVM 21 mod tests + PE32+ binary inspection)
npm test

# Rebuild everything from source (Branding -> UI -> Kotlin Fabric Mod JAR -> 64-bit Windows Binaries & Setup Installer)
npm run build:all

# Execute reproducible OpenJDK 21 benchmark suite and update docs/BENCHMARK_LATEST.json
npm run benchmark

# Launch local cross-platform desktop UI preview server (http://0.0.0.0:4173)
npm run preview
```

---

## Documentation Index

- **[User Guide](docs/USER_GUIDE.md)** — Installation, First-Launch Setup Wizard, Microsoft Sign-In, Performance & Shader tuning, HUD Editor, Profiles, and Troubleshooting.
- **[Developer & Build Guide](docs/DEVELOPER_AND_BUILD_GUIDE.md)** — Repository layout, reproducible build toolchain, Microsoft Azure/Entra OAuth Client ID configuration, and test suites.
- **[Architecture, Compatibility Matrix & Fair-Play Policy](docs/ARCHITECTURE_AND_COMPATIBILITY.md)** — Deep dive into native Win32/WebView2 IPC, version support (`1.21.4` primary + `1.8.9` legacy PvP evaluation), mod conflict matrix, and security design.
- **[Benchmark & Telemetry Report](docs/BENCHMARK_REPORT.md)** — Measured OpenJDK 21.0.13.1 frame-pacing, chunk-meshing, culling, and GC pause results (`+95.7%` throughput, `-52%` P99 frame time vs Vanilla baseline).

---

## License

Released under the [MIT License](LICENSE). Minecraft is a trademark of Mojang Synergies AB / Microsoft Corporation; Vespera Client is an independent community project and is not affiliated with Mojang or Microsoft.
