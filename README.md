# Vespera Client v1.2.0

**Precision Minecraft Java Edition Client & Native Windows 10/11 Launcher**  
*Performance + Visual Fidelity + Dynamic Multi-Version Management + Offline Accounts + Seamless Microsoft Sign-In — Zero Electron Bloat*

---

## Executive Summary

**Vespera Client** (`gg.vespera.client`) is a production-grade Minecraft Java Edition client ecosystem and native 64-bit Windows desktop launcher engineered as a modern, transparent, open-architecture alternative to Lunar Client and Badlion Client.

### Highlights in v1.2.0 — Offline Accounts & Dual Authentication
1. **Offline Accounts for Singleplayer, LAN & Offline Servers**:
   - Create multiple local Minecraft usernames without Microsoft credentials; each receives Minecraft's deterministic `OfflinePlayer:<username>` UUID (MD5 v3) and is clearly labeled as an Offline Account.
   - Offline accounts launch with legacy authentication (`--accessToken 0 --userType legacy`) and retain multiplayer support for LAN and servers configured with `online-mode=false`. Servers requiring online authentication receive a clear in-launcher explanation.
2. **One Accounts Hub for Offline and Microsoft Profiles**:
   - Switch between account types without overwriting either profile, persist the selected account across launcher restarts, and manage accounts from the Accounts page or bottom-dock switcher.
   - First launch offers a username form with live UUID preview; usernames are validated against Minecraft's 3–16 character rules.
3. **Clean, Player-First Microsoft Login Experience**:
   - Presents distinct **Add Offline Account** and **Add Microsoft Account** paths, with a clear **Sign in with Microsoft** button—no manual Client ID inputs, no verification-code copying required for standard login, and no intimidating developer setup panels in the user interface.
   - Displays a real-time 6-stage authentication progress view (*Opening Microsoft login... $\rightarrow$ Waiting for authentication... $\rightarrow$ Verifying Microsoft account... $\rightarrow$ Connecting to Xbox services... $\rightarrow$ Checking Minecraft ownership... $\rightarrow$ Retrieving Minecraft profile...*) with instant cancellation and automatic refresh upon completion.
4. **Native OAuth 2.0 Authorization Code + PKCE (`S256`) Desktop Architecture**:
   - Opens Microsoft's official login page (`login.microsoftonline.com/consumers/oauth2/v2.0/authorize`) in the OS default browser and listens on a temporary local loopback callback (`http://localhost:<port>`), enforcing timing-safe CSRF `state` validation, PKCE `S256` code redemption, and authorization-code replay prevention.
   - Executes the complete **Microsoft OAuth $\rightarrow$ Xbox Live $\rightarrow$ XSTS $\rightarrow$ Minecraft Services $\rightarrow$ Java Edition Entitlement Verification $\rightarrow$ Minecraft Profile** chain with DPAPI / AES-256-GCM encrypted token storage, multi-account switching, silent session refresh, and clear human-readable error messages.
   - **External Registration Status**: No fabricated Client ID is included in the repository (`config/oauth.release.json` and `config/oauth.development.json` ship with `"clientId": ""`). Before live Microsoft authentication can complete end-to-end, a maintainer must supply a registered Microsoft Entra Public Client ID (`http://localhost` Mobile & desktop redirect URI) via `VESPERA_MSA_CLIENT_ID`, `config/oauth.local.json`, or `config/oauth.release.json` (see [`docs/OAUTH_DEVELOPER_SETUP.md`](docs/OAUTH_DEVELOPER_SETUP.md)). If unset, Vespera surfaces a friendly notice *only* when attempting sign-in.
5. **Dynamic Official Minecraft Version Manager & Honest Mod Isolation**:
   - Live sync with Mojang's official `version_manifest_v2.json` across **Releases**, **Snapshots**, **Old Beta**, and **Old Alpha**, with 12-stage SHA-1 verified downloading, HTTP `Range` `.part` resumption, native `.dll`/`.so` extraction, automatic Java 8/17/21 provisioning, and strict isolation of `vespera-client-1.2.0+mc1.21.4.jar` to Minecraft `1.21.4`.

---

## v1.2.0 Windows 10/11 (x86_64) Release Deliverables

Build the release artifacts with `npm run build`. The build produces:

| Deliverable | Path |
| :--- | :--- |
| **Windows Setup Installer** | `release/VesperaClient-1.2.0-win64-setup.exe` |
| **Native Desktop Launcher** | `release/bin/VesperaClient.exe` |
| **Native Windows Uninstaller** | `release/bin/VesperaUninstall.exe` |
| **Custom Fabric Client Mod** | `release/mods/vespera-client-1.2.0+mc1.21.4.jar` |
| **Windows Application Icon** | `release/vespera.ico` |
| **Release Checksums** | `release/SHA256SUMS.txt` (SHA-256 for all release binaries) |

Run `npm run test:verify-artifacts` to validate the Windows PE64 binaries and the compiled Fabric JAR.

---

## Quickstart Commands

```bash
# Run full automated verification (36 Vitest tests + 23 Kotlin JVM 21 mod tests + PE32+ binary & UX verification)
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
