# Vespera Client — User Guide

Welcome to **Vespera Client v1.2.5** for Windows 10 and Windows 11 (64-bit). This guide walks you through creating offline accounts, signing in with your official Microsoft Minecraft account, tuning FPS and shaders, customizing your in-game HUD, and managing isolated mod profiles.

---

## 1. Installation & First-Launch Setup Wizard

1. Run **`VesperaClient-1.2.5-win64-setup.exe`**.
   - Standard user permissions (`asInvoker`) are used—no Administrator UAC prompt is required when installing to your user profile.
   - Default binary path: `%LOCALAPPDATA%\Programs\VesperaClient\`
   - Default managed data path: `%APPDATA%\VesperaClient\`
2. Choose whether to create **Desktop** and **Start Menu** shortcuts, then click **Install Vespera**.
   - Every embedded binary (`VesperaClient.exe`, `VesperaUninstall.exe`, `vespera-client-1.2.2+mc1.21.4.jar`) is cryptographically verified via **SHA-256** during extraction.
   - Silent enterprise/power-user installation is also supported:
     ```powershell
     .\VesperaClient-1.2.5-win64-setup.exe /S /D=C:\Games\VesperaClient
     ```
3. On first launch, the **First-Launch Setup Wizard** detects your CPU cores, total system RAM, and Java runtime, and lets you pick your starting optimization preset (**Balanced**, **Maximum FPS**, or **Visual Quality + Shaders**) in one click.

---

## 2. Offline Accounts & Microsoft Authentication

### Create an Offline Account

1. Open the **Accounts** page and choose **Create Offline Account** (the first-launch form also offers this setup).
2. Enter a Minecraft username from 3 to 16 characters using letters, numbers, or underscores. The form previews the deterministic UUID that will be assigned.
3. Select the new Offline Account and launch Minecraft. Offline accounts work in Singleplayer, LAN, and multiplayer servers configured with `online-mode=false`; they cannot join servers that require official online authentication.
4. If a server rejects an offline session, Vespera explains that an authenticated Microsoft account is required.

### Sign In with Microsoft

1. On the **Accounts** page, click **Sign in with Microsoft**.
2. Complete the official sign-in in your default browser (including 2FA, passkeys, or Microsoft Authenticator). Vespera never sees your password.
3. Vespera verifies Xbox Live, XSTS, Minecraft Java Edition ownership, and your player profile. Microsoft tokens are encrypted at rest.

### Switch Accounts

Use the **Accounts** page or the bottom-dock account switcher to switch between Offline and Microsoft accounts. Both account types remain separately stored, and your selected account is remembered across launcher restarts. Microsoft sign-in requires the build maintainer to configure the OAuth application; an unconfigured build shows a clear notice when sign-in is attempted.

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
