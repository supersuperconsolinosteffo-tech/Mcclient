# Vespera Client v1.2.4

**Precision Minecraft Java Edition Client & Native Windows 10/11 Launcher**  
*Performance + Visual Fidelity + Dynamic Multi-Version Management + Offline Accounts + Seamless Microsoft Sign-In — Zero Electron Bloat*

---

## Executive Summary

**Vespera Client** (`gg.vespera.client`) is a production-grade Minecraft Java Edition client ecosystem and native 64-bit Windows desktop launcher engineered as a modern, transparent, open-architecture alternative to Lunar Client and Badlion Client.

### Highlights in v1.2.4 — Validated Native ZIP Extraction & Recoverable Installation
1. **Mojang and Fabric Dependency Metadata Are Parsed Separately**:
   - Mojang library URLs and optional SHA-1 checksums are taken from Mojang's metadata; Fabric libraries are resolved from the Fabric loader profile's Maven coordinates and declared repository URLs. [Fabric Meta's profile builder](https://github.com/FabricMC/fabric-meta/blob/master/src/main/java/net/fabricmc/meta/web/ProfileHandler.java#L114-L181) generates intermediary/loader entries with only `name` and `url`, while [Fabric Loader 0.16.10 metadata](https://github.com/FabricMC/fabric-loader/blob/0.16.10/src/main/resources/fabric-installer.json) shows common library records can include checksums.
   - Missing upstream checksums are not fabricated or treated as an invalid URL. Published hashes are verified; hashless library downloads must pass HTTP, JAR/ZIP structure, and Fabric Loader entry validation.
   - Maven classifiers/extensions and Windows-safe artifact paths are validated, duplicate downloads are collapsed, incomplete/corrupt files are retried or invalidated, and complete artifacts are required before an install receipt is written.
   - Library diagnostics include upstream source, full Maven coordinate, resolved URL, checksum availability, and destination. The previous Mojang metadata refresh/retry and cache-corruption protections remain in place.
2. **Offline Accounts for Singleplayer, LAN & Offline Servers**:
   - Create multiple local Minecraft usernames without Microsoft credentials; each receives Minecraft's deterministic `OfflinePlayer:<username>` UUID (MD5 v3) and is clearly labeled as an Offline Account.
   - Offline accounts launch with legacy authentication (`--accessToken 0 --userType legacy`) and retain multiplayer support for LAN and servers configured with `online-mode=false`. Servers requiring online authentication receive a clear in-launcher explanation.
3. **One Accounts Hub for Offline and Microsoft Profiles**:
   - Switch between account types without overwriting either profile, persist the selected account across launcher restarts, and manage accounts from the Accounts page or bottom-dock switcher.
   - First launch offers a username form with live UUID preview; usernames are validated against Minecraft's 3–16 character rules.
4. **Clean, Player-First Microsoft Login Experience**:
   - Presents distinct **Add Offline Account** and **Add Microsoft Account** paths, with a clear **Sign in with Microsoft** button—no manual Client ID inputs, no verification-code copying required for standard login, and no intimidating developer setup panels in the user interface.
   - Displays a real-time 6-stage authentication progress view (*Opening Microsoft login... $\rightarrow$ Waiting for authentication... $\rightarrow$ Verifying Microsoft account... $\rightarrow$ Connecting to Xbox services... $\rightarrow$ Checking Minecraft ownership... $\rightarrow$ Retrieving Minecraft profile...*) with instant cancellation and automatic refresh upon completion.
5. **Native OAuth 2.0 Authorization Code + PKCE (`S256`) Desktop Architecture**:
   - Opens Microsoft's official login page (`login.microsoftonline.com/consumers/oauth2/v2.0/authorize`) in the OS default browser and listens on a temporary local loopback callback (`http://localhost:<port>`), enforcing timing-safe CSRF `state` validation, PKCE `S256` code redemption, and authorization-code replay prevention.
   - Executes the complete **Microsoft OAuth $\rightarrow$ Xbox Live $\rightarrow$ XSTS $\rightarrow$ Minecraft Services $\rightarrow$ Java Edition Entitlement Verification $\rightarrow$ Minecraft Profile** chain with DPAPI / AES-256-GCM encrypted token storage, multi-account switching, silent session refresh, and clear human-readable error messages.
   - **External Registration Status**: No fabricated Client ID is included in the repository (`config/oauth.release.json` and `config/oauth.development.json` ship with `"clientId": ""`). Before live Microsoft authentication can complete end-to-end, a maintainer must supply a registered Microsoft Entra Public Client ID (`http://localhost` Mobile & desktop redirect URI) via `VESPERA_MSA_CLIENT_ID`, `config/oauth.local.json`, or `config/oauth.release.json` (see [`docs/OAUTH_DEVELOPER_SETUP.md`](docs/OAUTH_DEVELOPER_SETUP.md)). If unset, Vespera surfaces a friendly notice *only* when attempting sign-in.
6. **Dynamic Official Minecraft Version Manager & Honest Mod Isolation**:
   - Live sync with Mojang's official `version_manifest_v2.json` across **Releases**, **Snapshots**, **Old Beta**, and **Old Alpha**; listing a version is not a claim that every historical, modded, or snapshot configuration has been live-tested. Downloads are verified against upstream SHA-1 when supplied, and Windows native DLLs are extracted by the bundled ZIP engine with ZIP CRC/path checks and Mojang exclusion prefixes.

### Installation engine changes in v1.2.4

- Long native install, launch, manifest-sync and verification RPCs are dispatched through WebView's asynchronous binding. Snapshot polling and cancellation remain serviceable while a job runs, and a second long task is refused instead of queued against the same files.
- The Windows installer writes an atomic per-install artifact journal (source, coordinate, URL, destination, expected size/hash, state, and failure) and revalidates existing files when resuming. Valid files are retained; corrupt or incomplete files are repaired individually.
- Download totals remain indeterminate when upstream sizes are absent. Existing valid downloads are retained and checked before reuse; native JARs are read-only inputs and extraction uses a clean staging directory, activating output only after all selected archives pass validation.
- Native extraction no longer shells out to `tar.exe`. The bundled ZIP reader verifies selected DLL entries' local/central headers, decompressed lengths and CRC-32, honors Mojang exclusions, rejects traversal and conflicting duplicate outputs, and emits archive/coordinate-specific diagnostics. Windows native classifier template expansion follows the compiled launcher's x86/x64 architecture; this build is 64-bit Windows, and no claim is made for ARM64 or other operating systems.
- Audit and evidence: [`docs/NATIVE_EXTRACTION_AUDIT_V1.2.4.md`](docs/NATIVE_EXTRACTION_AUDIT_V1.2.4.md). The reported `%APPDATA%` JAR and original `tar.exe` stderr were not available in this workspace, so the reported artifact's integrity and exact tar failure remain unverified.
- **Test scope:** synthetic ZIP regression tests and a Windows x86_64 cross-build are available. No native Windows execution, installation or game launch was performed here. In particular, the requested 1.21.4 Vanilla, 1.21.4 Fabric 0.16.10, another modern release, and historical release reaching the main menu remain unverified.

---

## v1.2.4 Windows 10/11 (x86_64) Release Deliverables

Build the release artifacts with `npm run build`. The build produces:

| Deliverable | Path |
| :--- | :--- |
| **Windows Setup Installer** | `release/VesperaClient-1.2.4-win64-setup.exe` |
| **Native Desktop Launcher** | `release/bin/VesperaClient.exe` |
| **Native Windows Uninstaller** | `release/bin/VesperaUninstall.exe` |
| **Custom Fabric Client Mod** | `release/mods/vespera-client-1.2.2+mc1.21.4.jar` |
| **Windows Application Icon** | `release/vespera.ico` |
| **Release Checksums** | `release/SHA256SUMS.txt` (SHA-256 for all release binaries) |

Run `npm run test:verify-artifacts` to validate the Windows PE64 binaries and the compiled Fabric JAR.

---

## Quickstart Commands

```bash
# Run full automated verification (Vitest + Kotlin JVM 21 mod tests + PE32+ binary & UX verification)
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

- **[One-Time Microsoft Entra OAuth Setup (Maintainers)](docs/OAUTH_DEVELOPER_SETUP.md)** — Entra ID `http://localhost` desktop public-client registration, `VESPERA_MSA_CLIENT_ID`, development vs production config files, and Minecraft Services approval.
- **[User Guide](docs/USER_GUIDE.md)** — Installation, Microsoft Sign-In & Offline Singleplayer, Dynamic Version Manager, Performance & Shader tuning, HUD Editor, and Profiles.
- **[Developer & Build Guide](docs/DEVELOPER_AND_BUILD_GUIDE.md)** — Repository layout, reproducible build toolchain, and automated test suites.
- **[Architecture, Compatibility Matrix & Fair-Play Policy](docs/ARCHITECTURE_AND_COMPATIBILITY.md)** — Native Win32/WebView2 IPC, version compatibility tiers, mod conflict matrix, and security design.
- **[Benchmark & Telemetry Report](docs/BENCHMARK_REPORT.md)** — Measured OpenJDK 21 frame-pacing, chunk-meshing, culling, and GC pause results.

---

## License

Released under the [MIT License](LICENSE). Minecraft is a trademark of Mojang Synergies AB / Microsoft Corporation; Vespera Client is an independent community project and is not affiliated with Mojang or Microsoft.
