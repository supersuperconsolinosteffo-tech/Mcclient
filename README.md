# Vespera Client v1.1.1

**Precision Minecraft Java Edition Client & Native Windows 10/11 Launcher**  
*Performance + Visual Fidelity + Dynamic Multi-Version Management + Seamless Microsoft Sign-In — Zero Electron Bloat*

---

## Executive Summary

**Vespera Client** (`gg.vespera.client`) is a production-grade Minecraft Java Edition client ecosystem and native 64-bit Windows desktop launcher engineered as a modern, transparent, open-architecture alternative to Lunar Client and Badlion Client.

### Highlights in v1.1.1 — Seamless Microsoft Login Experience
1. **Clean, Player-First Accounts Interface**:
   - Presents a polished **Connect your Minecraft account** view with a single prominent **Sign in with Microsoft** button—no manual Client ID inputs, no verification-code copying required for standard login, and no intimidating developer setup panels in the user interface.
   - Displays a real-time 6-stage authentication progress view (*Opening Microsoft login... $\rightarrow$ Waiting for authentication... $\rightarrow$ Verifying Microsoft account... $\rightarrow$ Connecting to Xbox services... $\rightarrow$ Checking Minecraft ownership... $\rightarrow$ Retrieving Minecraft profile...*) with instant cancellation and automatic refresh upon completion.
2. **Native OAuth 2.0 Authorization Code + PKCE (`S256`) Desktop Architecture**:
   - Opens Microsoft's official login page (`login.microsoftonline.com/consumers/oauth2/v2.0/authorize`) in the OS default browser and listens on a temporary local loopback callback (`http://localhost:<port>`), enforcing timing-safe CSRF `state` validation, PKCE `S256` code redemption, and authorization-code replay prevention.
   - Executes the complete **Microsoft OAuth $\rightarrow$ Xbox Live $\rightarrow$ XSTS $\rightarrow$ Minecraft Services $\rightarrow$ Java Edition Entitlement Verification $\rightarrow$ Minecraft Profile** chain with DPAPI / AES-256-GCM encrypted token storage, multi-account switching, silent session refresh, and clear human-readable error messages.
   - **External Registration Status**: No fabricated Client ID is included in the repository (`config/oauth.release.json` and `config/oauth.development.json` ship with `"clientId": ""`). Before live Microsoft authentication can complete end-to-end, a maintainer must supply a registered Microsoft Entra Public Client ID (`http://localhost` Mobile & desktop redirect URI) via `VESPERA_MSA_CLIENT_ID`, `config/oauth.local.json`, or `config/oauth.release.json` (see [`docs/OAUTH_DEVELOPER_SETUP.md`](docs/OAUTH_DEVELOPER_SETUP.md)). If unset, Vespera surfaces a friendly notice *only* when attempting sign-in.
3. **Dynamic Official Minecraft Version Manager & Honest Mod Isolation**:
   - Live sync with Mojang's official `version_manifest_v2.json` across **Releases**, **Snapshots**, **Old Beta**, and **Old Alpha**, with 12-stage SHA-1 verified downloading, HTTP `Range` `.part` resumption, native `.dll`/`.so` extraction, automatic Java 8/17/21 provisioning, and strict isolation of `vespera-client-1.1.1+mc1.21.4.jar` to Minecraft `1.21.4`.

---

## Verified Windows 10/11 (x86_64) Release Deliverables (`v1.1.1`)

| Deliverable | Path | Size | SHA-256 |
| :--- | :--- | ---: | :--- |
| **Windows Setup Installer** | `release/VesperaClient-1.1.1-win64-setup.exe` | `1,986.5 KB` | `c08e0ad2690485bc51c2b12d6a0b736983efdc6ded59c73b0ff3746e63235961` |
| **Native Desktop Launcher** | `release/bin/VesperaClient.exe` | `1,448.5 KB` | `9e6b6016b0542a6426bf980fa65ec0e2aacf1dcf692b7c7ea8abe47578ac9d02` |
| **Native Windows Uninstaller** | `release/bin/VesperaUninstall.exe` | `223.0 KB` | `99d094e10d72354c98c360ed825002a3a832fdf5ef1f1caf99811dc38adcb971` |
| **Custom Fabric Client Mod** | `release/mods/vespera-client-1.1.1+mc1.21.4.jar` | `57.5 KB` | `0adb8d4c2fcbe48e75f79c29ba9ab563ed7272623ee3c8acfd2e2273d1a70d35` |
| **Windows Application Icon** | `release/vespera.ico` | `18.3 KB` | `9b58a181e96a143761c2234291d53545468d6d1fda507f6306dd090210e11cef` |
| **Release Checksums** | `release/SHA256SUMS.txt` | `0.5 KB` | Verified by `npm run test:verify-artifacts` |

---

## Quickstart Commands

```bash
# Run full automated verification (31 Vitest tests + 23 Kotlin JVM 21 mod tests + PE32+ binary & UX verification)
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
