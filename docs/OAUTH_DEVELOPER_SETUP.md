# Vespera Client v1.1.0 — Maintainer Microsoft OAuth 2.0 Setup Guide

## Overview & Security Model

Starting in **Vespera Client v1.1.0**, ordinary players **never** create a Microsoft Entra application or type an Application (client) ID into the launcher UI. Instead, the **public Microsoft Application (client) ID** is configured once by the project maintainer at build time and compiled into the desktop binary (`VesperaClient.exe` and the local bridge).

### Mandatory Security Rules
1. **Zero Client Secrets**: Desktop launchers are native OAuth 2.0 Public Clients (RFC 8252 + RFC 7636 PKCE `S256`). **Never** generate or embed a Microsoft Client Secret. `resolveBuildTimeOAuthConfig()` actively throws a build-halting security error if `VESPERA_MSA_CLIENT_SECRET` or a `"clientSecret"` JSON field is present.
2. **Zero Fake or Placeholder Client IDs**: `config/oauth.release.json` ships with `"clientId": ""` until a maintainer injects a real registered UUID. All-zero or malformed UUIDs are rejected at build time.
3. **Explicit Unconfigured Build Behavior**: When built without a Client ID, the Accounts page displays a clean **Maintainer / Developer Build Configuration Notice** rather than a broken sign-in button or an end-user Client ID input box.

---

## Step-by-Step Microsoft Entra ID Registration (Maintainers Only)

1. Open the [Microsoft Entra Admin Center — App Registrations](https://entra.microsoft.com/) and click **New registration**.
2. **Name**: `Vespera Client`
3. **Supported account types**: Select **Personal Microsoft accounts only** (`consumers` tenant — required for Xbox Live / Minecraft consumer authentication) or *Accounts in any organizational directory and personal Microsoft accounts* if supporting broader MSA tenants.
4. **Redirect URI (Public client / native — mobile & desktop)**:
   - Platform: **Mobile and desktop applications**
   - Add redirect URI: `http://127.0.0.1` (Microsoft Entra automatically allows dynamic ephemeral ports such as `http://127.0.0.1:<port>/callback` on RFC 8252 loopback registrations for native public clients; you may also add `http://localhost`).
5. Under **Authentication -> Advanced settings**:
   - Set **Allow public client flows** = **Yes** (enables the Device Code Flow fallback for environments where local firewall rules block loopback browser redirects).
6. **Xbox Live / Minecraft Services API Access**:
   - Commercial third-party Minecraft launchers using custom Entra App IDs require [Minecraft Services OAuth App Approval](https://help.minecraft.net/hc/en-us/articles/16254801392141) so `user.auth.xboxlive.com` / `api.minecraftservices.com` permit `XboxLive.signin` tokens issued to the app's Client ID.

---

## Configuring Local Developer Builds vs. Release Builds

### Option A — Local Developer Override (Gitignored)
Create `config/oauth.local.json` (automatically ignored by `.gitignore`):
```json
{
  "clientId": "YOUR-REGISTERED-ENTRA-PUBLIC-CLIENT-UUID",
  "tenant": "consumers"
}
```

### Option B — CI / Release Pipeline Environment Variable
Pass `VESPERA_MSA_CLIENT_ID` during the Windows release build:
```bash
VESPERA_MSA_CLIENT_ID="YOUR-REGISTERED-ENTRA-PUBLIC-CLIENT-UUID" npm run build
```

### Option C — Repository Release Configuration
Maintainers publishing official signed releases can populate `"clientId"` in `config/oauth.release.json` (public Client ID UUID only — never a secret).
