# Vespera Client v1.2.2 — One-Time Microsoft Entra OAuth Setup (Maintainers Only)

## Architectural Principle

The Microsoft Application (`client_id`) belongs to **Vespera Client**, **never** to individual players:
- Players **never** enter a Client ID, register an Azure app, copy verification codes, or edit config files.
- The Accounts tab always presents a clean, player-first **Connect your Minecraft account** / **Sign in with Microsoft** experience.
- If a developer builds Vespera from source without configuring an Application ID yet, the normal Accounts UI remains clean and uncluttered, surfacing a friendly configuration message **only** when sign-in is attempted (with technical details tucked inside a collapsible diagnostics section).
- Desktop builds **never** embed a Microsoft Client Secret (`VESPERA_MSA_CLIENT_SECRET` and `"clientSecret"` fields are actively rejected at build time).

---

## Current Repository Status (External Registration Requirement)

This repository does **not** fabricate a fake Client ID (`config/oauth.release.json` and `config/oauth.development.json` ship with `"clientId": ""`). Before live interactive Microsoft login can complete against `login.microsoftonline.com` and `api.minecraftservices.com`, the project maintainer must complete the one-time Microsoft Entra registration below and supply the resulting Application (client) ID UUID.

---

## One-Time Microsoft Entra ID Registration Steps

1. Sign in to the [Microsoft Entra Admin Center — App Registrations](https://entra.microsoft.com/) and click **New registration**.
2. **Name**: `Vespera Client`
3. **Supported account types**:
   - Select **Personal Microsoft accounts only** (`consumers` audience — standard for consumer Xbox Live & Minecraft: Java Edition accounts) or *Accounts in any organizational directory and personal Microsoft accounts* (`common`) if desired.
4. **Redirect URI**:
   - Platform: **Mobile and desktop applications** (native public client)
   - Redirect URI: `http://localhost`
   - *(Per RFC 8252 and Microsoft Identity Platform v2.0 rules, registering `http://localhost` under Mobile & desktop applications automatically permits dynamic ephemeral loopback ports `http://localhost:<port>` used by Vespera's temporary PKCE callback listener.)*
5. **Authentication -> Advanced settings**:
   - **Allow public client flows**: **Yes**
   - Do **not** create any Client Secret under *Certificates & secrets*.
6. **Minecraft Services OAuth Approval**:
   - Submit the registered Application (client) ID via the [Minecraft Services OAuth Approval Form](https://help.minecraft.net/hc/en-us/articles/16254801392141) so `api.minecraftservices.com/authentication/login_with_xbox` accepts Xbox tokens issued to your custom Entra App ID.

---

## Supplying the Application ID at Build Time

Vespera resolves the Application (client) ID in the following priority order (`shared/oauthBuildConfig.ts`):

1. **Environment Variable (`VESPERA_MSA_CLIENT_ID`)** — Recommended for CI/CD release builds and quick local shell testing:
   ```bash
   VESPERA_MSA_CLIENT_ID="xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx" npm run build
   ```
2. **Local Developer Override (`config/oauth.local.json`)** — Gitignored automatically:
   ```json
   {
     "clientId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
     "tenant": "consumers",
     "loopbackHost": "localhost"
   }
   ```
3. **Development Configuration (`config/oauth.development.json`)** — Used when `NODE_ENV=development`.
4. **Production Release Configuration (`config/oauth.release.json`)** — Embedded into `VesperaClient.exe` and `VesperaClient-1.2.2-win64-setup.exe` during production builds.
