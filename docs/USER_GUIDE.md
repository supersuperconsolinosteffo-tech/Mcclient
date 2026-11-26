# Vespera Client — User Guide

Welcome to **Vespera Client v1.0.0** for Windows 10 and Windows 11 (64-bit). This guide walks you through installation, signing in with your official Microsoft Minecraft account, tuning FPS and shaders, customizing your in-game HUD, and managing isolated mod profiles.

---

## 1. Installation & First-Launch Setup Wizard

1. Run **`VesperaClient-1.0.0-win64-setup.exe`**.
   - Standard user permissions (`asInvoker`) are used—no Administrator UAC prompt is required when installing to your user profile.
   - Default binary path: `%LOCALAPPDATA%\Programs\VesperaClient\`
   - Default managed data path: `%APPDATA%\VesperaClient\`
2. Choose whether to create **Desktop** and **Start Menu** shortcuts, then click **Install Vespera**.
   - Every embedded binary (`VesperaClient.exe`, `VesperaUninstall.exe`, `vespera-client-1.0.0+mc1.21.4.jar`) is cryptographically verified via **SHA-256** during extraction.
   - Silent enterprise/power-user installation is also supported:
     ```powershell
     .\VesperaClient-1.0.0-win64-setup.exe /S /D=C:\Games\VesperaClient
     ```
3. On first launch, the **First-Launch Setup Wizard** detects your CPU cores, total system RAM, and Java runtime, and lets you pick your starting optimization preset (**Balanced**, **Maximum FPS**, or **Visual Quality + Shaders**) in one click.

---

## 2. Signing In with Your Official Microsoft Account

1. Open the **Accounts** page in the left navigation rail (or click the account chip in the top bar).
2. Click **Sign in with Microsoft**.
   - Vespera requests an official Microsoft OAuth 2.0 Device Verification Code and displays the verification URL (`https://www.microsoft.com/link`) and one-time code.
   - Complete sign-in in your default browser (supporting 2FA, passkeys, and Microsoft Authenticator—Vespera never sees your password).
3. Click **Complete Verification** once approved in your browser. Vespera verifies your Xbox Live token, XSTS token, Minecraft Java Edition ownership entitlement, and player UUID/skin.
4. **Multiple Accounts**: You can link multiple Microsoft accounts, switch active accounts in one click, refresh expiring tokens, or sign out cleanly.
   - *Note on OAuth Client ID*: If no `VESPERA_MSA_CLIENT_ID` is configured yet, paste your Azure Public Client Application ID directly in the **OAuth Client ID Setup** card on the **Accounts** page (see `docs/DEVELOPER_AND_BUILD_GUIDE.md` for creating a free personal Client ID in 2 minutes).

---

## 3. Launching Minecraft & Choosing Versions

1. Open **Play** (or use the right-hand **Launch & Live Telemetry** drawer from any page).
2. Select your **Active Profile** (`Competitive PvP`, `Survival+ QoL`, `Cinema Shaders`, `Pure Max FPS`, or a custom profile) and target **Minecraft Version** (`1.21.4` recommended).
3. Click **Verify & Prepare** to run a pre-flight check (Java runtime detection, isolated instance `options.txt` & `sodium-options.json` generation, HUD sync, and SHA-256 mod verification), or click **Launch Minecraft 1.21.4** directly.
4. While Minecraft is running, Vespera automatically enters **Idle Low-Memory Mode** (configurable in **Settings**) so your CPU and RAM stay dedicated to the game.

---

## 4. Tuning Performance Without Sacrificing Visual Quality

Open the **Performance** page to choose from four presets:

- **Maximum FPS**: Enables **Generational ZGC** (`-XX:+UseZGC -XX:+ZGenerational -XX:+AlwaysPreTouch`), `Sodium` Indirect Multi-Draw chunk rendering, aggressive entity/block-face culling, and disables heavy shaders—while keeping `Maximum` Smooth Lighting, `4x` Mipmaps, and crisp textures.
- **Balanced (Recommended)**: Uses **Client-Tuned Adaptive G1GC** (`MaxGCPauseMillis=35`), `16` chunk render distance, and balanced culling for ultra-consistent 1% low frame pacing.
- **Visual Quality**: Allocates extra heap headroom for **Iris Shaders** + PBR resource packs with `18` chunk render distance and `14` chunk shadow distance.
- **Custom**: Automatically activates whenever you customize individual RAM sliders, GC strategies, or culling toggles.

---

## 5. Shaders, Graphics & Resource Packs

- **Graphics Page**: Fine-tune Render Distance (`2–32` chunks), Simulation Distance, Shadow Distance, Clouds (`Off` / `Fast` / `Fancy`), Smooth Lighting, Mipmap Levels (`0–4`), Biome Blend, Entity Shadows, and toggle **Entity Texture Features**, **Entity Model Features**, and **Continuity** connected textures.
- **Shader Packs Page**: Toggle the Iris Shader pipeline and switch between **Low (Fast Shadowless)**, **Medium (Balanced Bloom)**, **High (PBR + Volumetric)**, and **Ultra (Raytraced GI)** presets.
- **Resource Packs Page**: Enable/disable texture packs (`Vanilla Default`, `Vespera Crisp PvP 16x`, `Vespera Faithful PBR 32x`, `Low-Fire Clear Glass Overlay`) and reorder pack priority with **Up / Down** controls.

---

## 6. Interactive HUD Studio & In-Game Shortcuts

Click **HUD Editor** in the top bar (or press **`Right Shift`** inside Minecraft `1.21.4`) to open the **HUD Layout Studio**:

- **Drag & Snap**: Drag any of the 12 modules (`FPS + 1% Low`, `Keystrokes`, `CPS L/R`, `Ping & Est. TPS`, `Coordinates + Nether /8`, `Compass`, `Armor Durability`, `Active Potions`, `Crosshair`, `Toggle Sprint`, `Chunk Cache`, `Speedometer`) across the 16:9 canvas with automatic center-line alignment guides.
- **Customize**: Adjust scale (`0.5x–2.25x`), foreground/background colors, backdrop blur, borders, and module-specific modes (e.g., Crosshair `Cross` / `Dot` / `Circle` + dynamic hit indicator).
- **Multiple Saved Layouts**: Switch instantaneously between **Competitive PvP Clean**, **Survival Explorer**, and **Minimalist Pro**, or save new layouts—changes sync atomically between the launcher and running game within 1.5 seconds.
- **Default In-Game Keybinds**:
  - `Right Shift` — Open Vespera HUD & Feature Studio
  - `C` — Hold for Smooth Cinematic/Instant Zoom (scroll wheel adjusts zoom from `2x` to `16x`)
  - `G` — Toggle Vanilla-Legal Sprint

---

## 7. Modrinth Mod Manager, Profiles & Rollback

- **Install Mods Safely**: Open **Mods -> Browse Modrinth**, search any Fabric mod (e.g., *Zoomify*, *Mod Menu*, *Sodium Extra*, *AppleSkin*), and click **Install**. Vespera automatically verifies Minecraft version + loader compatibility, downloads required dependencies, verifies SHA-1/SHA-256 hashes, and blocks conflicting mods like `OptiFabric` with a clear explanation.
- **Isolated Profiles & Rollback**: Open **Profiles** to create new isolated instances, export/import `.vesperaprofile` JSON files, or click **Rollback** on any automatic pre-change snapshot if you ever want to undo a mod or config change.

---

## 8. Diagnostics Doctor, Crash Recovery & Uninstallation

- **Diagnostics Doctor**: Open **Diagnostics** and click **Run Full Scan** (or **Repair Instance** on the Play page). If an issue has an automated remediation (such as over-allocated heap RAM or missing instance directories), click **Auto-Fix**.
- **Crash Analyzer**: Paste any Minecraft crash log or `hs_err_pid` snippet into the **Crash & Conflict Log Analyzer** for instant root-cause diagnosis and remediation steps.
- **Clean Uninstallation**: Run **Uninstall Vespera Client** from Windows *Settings -> Installed Apps* (or `%LOCALAPPDATA%\Programs\VesperaClient\VesperaUninstall.exe`). You will be asked whether you want to keep your saved worlds, screenshots, and profiles in `%APPDATA%\VesperaClient` or remove everything cleanly.
