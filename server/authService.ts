import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  AuthFlowState,
  DeviceCodeAuthChallenge,
  MinecraftAccount,
  OAuthAppConfigState,
  OfflineAvailabilityState,
} from '../shared/types';
import {
  isValidMicrosoftPublicClientId,
  resolveBuildTimeOAuthConfig,
  type ResolvedOAuthBuildConfig,
} from '../shared/oauthBuildConfig';
import { EncryptedTokenVault } from './securityUtils';

interface SecretAccountRecord extends MinecraftAccount {
  /** Never exposed over RPC/UI snapshots — stored strictly inside AES-256-GCM / DPAPI vault */
  mcAccessToken?: string;
  msRefreshToken?: string;
}

export interface AuthServiceOptions {
  /** Override build-time OAuth config (used by automated tests) */
  oauthConfigOverride?: Partial<ResolvedOAuthBuildConfig>;
  /** Custom HTTP fetch implementation (used by automated tests for deterministic OAuth/XBL/XSTS/MC mocking) */
  fetchImpl?: typeof fetch;
  /** Disable spawning OS browser during automated headless tests */
  openSystemBrowser?: boolean;
  /** Optional log sink */
  onLog?: (line: string) => void;
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function tryOpenExternalBrowser(url: string): void {
  try {
    if (!url.startsWith('https://')) return;
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        /* Headless environment: user can open URL via UI button */
      });
      child.unref();
    }
  } catch {
    // Non-fatal in headless Linux environments; authorizeUrl is exposed in AuthFlowState
  }
}

/**
 * Production Microsoft OAuth 2.0 (Authorization Code + PKCE via System Browser + Localhost Loopback,
 * with Device Code fallback) -> Xbox Live -> XSTS -> Minecraft Services authentication & encrypted
 * token storage service, plus legitimate Offline Singleplayer verification.
 *
 * Security invariants:
 * - Public Client ID is resolved at build/startup time (`config/oauth.release.json`, `config/oauth.local.json`,
 *   or `VESPERA_MSA_CLIENT_ID`). Ordinary users NEVER enter or register a Client ID.
 * - Never embeds a Client Secret or fabricates placeholder Client IDs, tokens, or Minecraft ownership.
 * - Tokens are encrypted at rest with AES-256-GCM (and Windows DPAPI in the native Win32 host) and never
 *   returned in UI snapshots or written to logs.
 */
export class AuthService {
  private readonly vault: EncryptedTokenVault;
  private readonly oauthConfig: ResolvedOAuthBuildConfig;
  private readonly fetchFn: typeof fetch;
  private readonly shouldOpenBrowser: boolean;
  private readonly log: (line: string) => void;

  private accounts: SecretAccountRecord[] = [];
  private latestDeviceCode: string | null = null;
  private pendingChallenges = new Map<
    string,
    { challenge: DeviceCodeAuthChallenge; clientId: string; cancelled: boolean }
  >();
  private activePkceSession: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    server: http.Server;
    timeoutHandle: NodeJS.Timeout;
    cancelled: boolean;
  } | null = null;

  private authFlowState: AuthFlowState = {
    mode: 'idle',
    message: 'Ready to sign in with Microsoft.',
  };

  private activeSessionMode: 'online_authenticated' | 'offline_singleplayer' =
    'online_authenticated';

  constructor(
    dataDir: string,
    optionsOrLogSink: AuthServiceOptions | ((line: string) => void) = {}
  ) {
    const options: AuthServiceOptions =
      typeof optionsOrLogSink === 'function' ? { onLog: optionsOrLogSink } : optionsOrLogSink;

    this.vault = new EncryptedTokenVault(dataDir);
    this.log = options.onLog ?? (() => {});

    const baseConfig = resolveBuildTimeOAuthConfig();
    const mergedClientId =
      options.oauthConfigOverride?.clientId !== undefined
        ? options.oauthConfigOverride.clientId
        : baseConfig.clientId;
    const configured =
      options.oauthConfigOverride?.configured !== undefined
        ? options.oauthConfigOverride.configured
        : isValidMicrosoftPublicClientId(mergedClientId);

    this.oauthConfig = {
      ...baseConfig,
      ...options.oauthConfigOverride,
      clientId: configured ? mergedClientId.trim() : '',
      configured,
      source:
        options.oauthConfigOverride?.source ??
        (configured ? baseConfig.source : 'unconfigured'),
    };

    this.fetchFn = options.fetchImpl ?? fetch;
    this.shouldOpenBrowser =
      options.openSystemBrowser ?? (process.env.NODE_ENV !== 'test' && !process.env.VITEST);

    this.loadVault();
  }

  public getOAuthConfigState(): OAuthAppConfigState {
    return {
      configured: this.oauthConfig.configured,
      source: this.oauthConfig.source,
      supportsPkceLoopback: true,
      supportsDeviceCodeFallback: true,
      developerSetupDocPath: 'docs/OAUTH_DEVELOPER_SETUP.md',
    };
  }

  public getAuthFlowState(): AuthFlowState {
    return { ...this.authFlowState };
  }

  public getActiveSessionMode(): 'online_authenticated' | 'offline_singleplayer' {
    return this.activeSessionMode;
  }

  public setSessionMode(mode: 'online_authenticated' | 'offline_singleplayer'): OfflineAvailabilityState {
    if (mode === 'offline_singleplayer') {
      const verified = this.getVerifiedOfflineCandidateAccount();
      if (!verified) {
        throw new Error(
          'Offline singleplayer requires an account that has previously completed Microsoft authentication and Minecraft Java Edition ownership verification on this device.'
        );
      }
      this.activeSessionMode = 'offline_singleplayer';
      return this.computeOfflineAvailability(true);
    }

    const active = this.getActiveAccountRecord();
    if (!active || active.sessionStatus === 'signed_out' || !active.mcAccessToken) {
      throw new Error(
        'Cannot restore online multiplayer session without a valid authenticated Microsoft session. Sign in or refresh your session first.'
      );
    }
    this.activeSessionMode = 'online_authenticated';
    return this.computeOfflineAvailability(true);
  }

  private getVerifiedOfflineCandidateAccount(): SecretAccountRecord | null {
    const active = this.accounts.find((a) => a.active && a.ownsMinecraftJava && a.lastValidatedAt > 0);
    if (active) return active;
    return this.accounts.find((a) => a.ownsMinecraftJava && a.lastValidatedAt > 0) ?? null;
  }

  public computeOfflineAvailability(localGameReady: boolean): OfflineAvailabilityState {
    const verified = this.getVerifiedOfflineCandidateAccount();
    const restrictions = [
      'Singleplayer and local worlds only (--disableMultiplayer enforced).',
      'Multiplayer server connections and Realms authentication are disabled while offline.',
      'Locked to your previously Microsoft-verified Minecraft username and UUID (no identity spoofing).',
    ];

    if (!verified) {
      return {
        eligible: false,
        verifiedAccountId: null,
        verifiedUsername: null,
        verifiedUuid: null,
        lastOnlineAuthAt: null,
        localGameReady,
        activeSessionMode: this.activeSessionMode,
        restrictions,
        statusReason:
          'Sign in online with Microsoft at least once on this PC to verify Minecraft: Java Edition ownership before offline singleplayer becomes available.',
      };
    }

    if (!localGameReady) {
      return {
        eligible: false,
        verifiedAccountId: verified.id,
        verifiedUsername: verified.username,
        verifiedUuid: verified.uuid,
        lastOnlineAuthAt: verified.lastValidatedAt,
        localGameReady: false,
        activeSessionMode: this.activeSessionMode,
        restrictions,
        statusReason:
          'Account verified, but the selected Minecraft version files are not installed locally yet. Download the version while online to unlock offline singleplayer.',
      };
    }

    return {
      eligible: true,
      verifiedAccountId: verified.id,
      verifiedUsername: verified.username,
      verifiedUuid: verified.uuid,
      lastOnlineAuthAt: verified.lastValidatedAt,
      localGameReady: true,
      activeSessionMode: this.activeSessionMode,
      restrictions,
      statusReason:
        this.activeSessionMode === 'offline_singleplayer'
          ? `Offline Singleplayer active as ${verified.username}. Reconnect anytime to restore full online multiplayer.`
          : `Ready for Offline Singleplayer as ${verified.username} (verified Java Edition owner).`,
    };
  }

  private loadVault(): void {
    const parsed = this.vault.loadDecrypted<SecretAccountRecord[]>([]);
    this.accounts = Array.isArray(parsed) ? parsed : [];
  }

  private saveVault(): void {
    this.vault.saveEncrypted(this.accounts);
  }

  public listAccounts(): MinecraftAccount[] {
    const now = Date.now();
    return this.accounts.map((acc) => {
      let sessionStatus: MinecraftAccount['sessionStatus'] = 'expired';
      if (acc.sessionStatus === 'signed_out' || (!acc.mcAccessToken && !acc.msRefreshToken)) {
        sessionStatus = 'signed_out';
      } else if (acc.tokenExpiresAt > now + 60_000) {
        sessionStatus = 'valid';
      } else if (acc.msRefreshToken) {
        sessionStatus = 'refresh_required';
      }
      return {
        id: acc.id,
        uuid: acc.uuid,
        username: acc.username,
        xuid: acc.xuid,
        skinUrl: acc.skinUrl,
        authProvider: 'microsoft_oauth',
        tokenExpiresAt: acc.tokenExpiresAt,
        lastValidatedAt: acc.lastValidatedAt,
        sessionStatus,
        skinAvatarSeed: acc.skinAvatarSeed,
        active: acc.active,
        ownsMinecraftJava: acc.ownsMinecraftJava,
      };
    });
  }

  public getActiveAccount(): MinecraftAccount | null {
    const all = this.listAccounts();
    return all.find((a) => a.active) ?? all[0] ?? null;
  }

  public getActiveAccountId(): string | null {
    return this.getActiveAccount()?.id ?? null;
  }

  private getActiveAccountRecord(): SecretAccountRecord | null {
    const active = this.accounts.find((a) => a.active);
    return active ?? this.accounts[0] ?? null;
  }

  public switchActiveAccount(accountId: string): MinecraftAccount[] {
    return this.switchAccount(accountId);
  }

  public switchAccount(accountId: string): MinecraftAccount[] {
    const exists = this.accounts.some((a) => a.id === accountId);
    if (!exists) {
      throw new Error(`Account "${accountId}" not found.`);
    }
    this.accounts = this.accounts.map((a) => ({
      ...a,
      active: a.id === accountId,
    }));
    this.saveVault();
    return this.listAccounts();
  }

  /**
   * Signs out of an account by purging its live access & refresh tokens from the encrypted vault
   * while retaining the verified account record (so the user can easily sign back in or use legitimate
   * offline singleplayer if previously verified).
   */
  public signOutAccount(accountId: string): MinecraftAccount[] {
    const record = this.accounts.find((a) => a.id === accountId);
    if (!record) {
      throw new Error(`Account "${accountId}" not found.`);
    }
    delete record.mcAccessToken;
    delete record.msRefreshToken;
    record.tokenExpiresAt = 0;
    record.sessionStatus = 'signed_out';
    this.saveVault();
    return this.listAccounts();
  }

  /**
   * Permanently removes an account and all associated encrypted data from this device.
   */
  public removeAccount(accountId: string): MinecraftAccount[] {
    this.accounts = this.accounts.filter((a) => a.id !== accountId);
    if (this.accounts.length > 0 && !this.accounts.some((a) => a.active)) {
      this.accounts[0].active = true;
    }
    if (this.accounts.length === 0) {
      this.activeSessionMode = 'online_authenticated';
    }
    this.saveVault();
    return this.listAccounts();
  }

  private assertOAuthClientConfigured(): string {
    if (!this.oauthConfig.configured || !this.oauthConfig.clientId) {
      this.authFlowState = {
        mode: 'error',
        message:
          'Developer Build Configuration Required: No Microsoft Entra public Client ID was injected at build time. Configure VESPERA_MSA_CLIENT_ID or config/oauth.local.json (see docs/OAUTH_DEVELOPER_SETUP.md).',
      };
      throw new Error(this.authFlowState.message);
    }
    return this.oauthConfig.clientId;
  }

  /**
   * Cancels any in-progress PKCE loopback browser sign-in or Device Code polling flow cleanly.
   */
  public cancelActiveAuthFlow(): AuthFlowState {
    if (this.activePkceSession) {
      this.activePkceSession.cancelled = true;
      clearTimeout(this.activePkceSession.timeoutHandle);
      try {
        this.activePkceSession.server.close();
      } catch {
        // Ignore already closed socket
      }
      this.activePkceSession = null;
    }

    for (const entry of this.pendingChallenges.values()) {
      entry.cancelled = true;
    }
    this.pendingChallenges.clear();

    this.authFlowState = {
      mode: 'cancelled',
      message: 'Microsoft sign-in cancelled.',
    };
    return this.getAuthFlowState();
  }

  /**
   * Primary Vespera v1.1.0 sign-in flow:
   * Starts a temporary localhost loopback HTTP callback server (`127.0.0.1:<ephemeral>/callback`),
   * generates RFC 7636 PKCE (`S256`) + CSRF `state`, opens the official system browser to Microsoft's
   * OAuth 2.0 authorization endpoint, and completes Xbox Live -> XSTS -> Minecraft Services exchange
   * automatically when the redirect arrives.
   */
  public async startBrowserPkceSignIn(): Promise<AuthFlowState> {
    const clientId = this.assertOAuthClientConfigured();

    // Clean up any prior unfinished PKCE listener first
    if (this.activePkceSession) {
      this.cancelActiveAuthFlow();
    }

    const codeVerifier = toBase64Url(crypto.randomBytes(32));
    const codeChallenge = toBase64Url(
      crypto.createHash('sha256').update(codeVerifier, 'ascii').digest()
    );
    const csrfState = toBase64Url(crypto.randomBytes(18));

    const server = http.createServer();

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind ephemeral localhost callback port.'));
          return;
        }
        resolve(addr.port);
      });
    });

    const redirectUri = `http://127.0.0.1:${port}${this.oauthConfig.loopbackRedirectPath}`;
    const authorizeParams = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: this.oauthConfig.scopes.join(' '),
      state: csrfState,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    const authorizeUrl = `https://login.microsoftonline.com/${this.oauthConfig.tenant}/oauth2/v2.0/authorize?${authorizeParams.toString()}`;
    const startedAt = Date.now();
    const expiresAt = startedAt + 5 * 60_000;

    const timeoutHandle = setTimeout(() => {
      if (this.activePkceSession?.state === csrfState) {
        this.cancelActiveAuthFlow();
        this.authFlowState = {
          mode: 'error',
          message:
            'Browser sign-in timed out after 5 minutes. Click "Sign in with Microsoft" to try again or use Device Code fallback.',
        };
      }
    }, 5 * 60_000);
    timeoutHandle.unref?.();

    this.activePkceSession = {
      state: csrfState,
      codeVerifier,
      redirectUri,
      server,
      timeoutHandle,
      cancelled: false,
    };

    server.on('request', async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', redirectUri);
        if (reqUrl.pathname !== this.oauthConfig.loopbackRedirectPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }

        const returnedState = reqUrl.searchParams.get('state') || '';
        const oauthError = reqUrl.searchParams.get('error');
        const oauthErrorDesc = reqUrl.searchParams.get('error_description');
        const authCode = reqUrl.searchParams.get('code');

        const expectedBuf = Buffer.from(csrfState, 'utf8');
        const actualBuf = Buffer.from(returnedState, 'utf8');
        const stateMatches =
          expectedBuf.length === actualBuf.length &&
          crypto.timingSafeEqual(expectedBuf, actualBuf);

        if (!stateMatches) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, 'Security state mismatch. Sign-in rejected.'));
          this.authFlowState = {
            mode: 'error',
            message: 'OAuth state mismatch rejected for security. Please start sign-in again.',
          };
          this.closeActivePkceListener();
          return;
        }

        if (oauthError) {
          const msg =
            oauthError === 'access_denied'
              ? 'Sign-in was cancelled in the Microsoft browser window.'
              : `Microsoft sign-in returned "${oauthError}": ${oauthErrorDesc || 'authentication failed'}.`;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, msg));
          this.authFlowState = {
            mode: oauthError === 'access_denied' ? 'cancelled' : 'error',
            message: msg,
          };
          this.closeActivePkceListener();
          return;
        }

        if (!authCode) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, 'Missing authorization code from Microsoft.'));
          this.authFlowState = {
            mode: 'error',
            message: 'Missing authorization code in Microsoft callback.',
          };
          this.closeActivePkceListener();
          return;
        }

        this.authFlowState = {
          mode: 'pkce_browser',
          authorizeUrl,
          redirectUri,
          startedAt,
          expiresAt,
          message:
            'Authorization code received! Verifying Xbox Live, XSTS, Minecraft entitlement, and profile...',
        };

        const verifierToUse = codeVerifier;
        this.closeActivePkceListener();

        try {
          const account = await this.exchangeAuthorizationCodePkce(
            clientId,
            authCode,
            verifierToUse,
            redirectUri
          );
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            this.renderLoopbackHtml(
              true,
              `Welcome, ${account.username}! Your Minecraft: Java Edition account is verified. You may close this browser tab and return to Vespera Client.`
            )
          );
          this.activeSessionMode = 'online_authenticated';
          this.authFlowState = {
            mode: 'completed',
            message: `Signed in as ${account.username} (Minecraft: Java Edition verified).`,
          };
        } catch (exchangeErr) {
          const errMessage =
            exchangeErr instanceof Error ? exchangeErr.message : String(exchangeErr);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, errMessage));
          this.authFlowState = {
            mode: 'error',
            message: errMessage,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal callback error');
        this.authFlowState = { mode: 'error', message: msg };
        this.closeActivePkceListener();
      }
    });

    this.authFlowState = {
      mode: 'pkce_browser',
      authorizeUrl,
      redirectUri,
      startedAt,
      expiresAt,
      message:
        'Complete sign-in in your default browser. Vespera Client will finish verification automatically once Microsoft redirects back.',
    };

    if (this.shouldOpenBrowser) {
      tryOpenExternalBrowser(authorizeUrl);
    }

    return this.getAuthFlowState();
  }

  private closeActivePkceListener(): void {
    if (!this.activePkceSession) return;
    clearTimeout(this.activePkceSession.timeoutHandle);
    try {
      this.activePkceSession.server.close();
    } catch {
      // Ignore
    }
    this.activePkceSession = null;
  }

  private renderLoopbackHtml(success: boolean, detail: string): string {
    const safeDetail = detail
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const accent = success ? '#10B981' : '#EF4444';
    const heading = success
      ? 'Microsoft Authentication Complete'
      : 'Microsoft Authentication Notice';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Vespera Client — Microsoft Authentication</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #070B14; color: #F8FAFC; font-family: system-ui, -apple-system, sans-serif; }
    .card { max-width: 460px; padding: 32px; border-radius: 16px; background: #0F172A; border: 1px solid rgba(148,163,184,0.2); box-shadow: 0 24px 48px rgba(0,0,0,0.45); text-align: center; }
    .badge { display: inline-block; padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${accent}; background: rgba(255,255,255,0.05); border: 1px solid ${accent}; margin-bottom: 14px; }
    h1 { font-size: 20px; margin: 0 0 10px; }
    p { font-size: 14px; line-height: 1.55; color: #CBD5E1; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Vespera Client</div>
    <h1>${heading}</h1>
    <p>${safeDetail}</p>
  </div>
</body>
</html>`;
  }

  private async exchangeAuthorizationCodePkce(
    clientId: string,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<MinecraftAccount> {
    const tokenRes = await this.fetchFn(
      `https://login.microsoftonline.com/${this.oauthConfig.tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          scope: this.oauthConfig.scopes.join(' '),
        }),
      }
    );

    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(
        `Microsoft PKCE token exchange failed: ${tokenJson.error_description || tokenJson.error || tokenRes.status}`
      );
    }

    return this.exchangeMicrosoftTokenToMinecraftAccount(
      tokenJson.access_token,
      tokenJson.refresh_token
    );
  }

  /**
   * Fallback Microsoft OAuth 2.0 Device Code flow using the centrally configured build-time Client ID.
   */
  public async startDeviceCodeFlow(): Promise<DeviceCodeAuthChallenge> {
    const clientId = this.assertOAuthClientConfigured();

    let res: Response;
    try {
      res = await this.fetchFn(
        `https://login.microsoftonline.com/${this.oauthConfig.tenant}/oauth2/v2.0/devicecode`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            scope: this.oauthConfig.scopes.join(' '),
          }),
        }
      );
    } catch (netErr) {
      const msg = `Unable to reach Microsoft authentication servers (${netErr instanceof Error ? netErr.message : 'network offline'}). Check your internet connection or use Offline Singleplayer if your account was previously verified.`;
      this.authFlowState = { mode: 'error', message: msg };
      throw new Error(msg);
    }

    if (!res.ok) {
      const errBody = await res.text();
      const msg = `Microsoft OAuth devicecode endpoint returned HTTP ${res.status}: ${errBody.slice(0, 220)}`;
      this.authFlowState = { mode: 'error', message: msg };
      throw new Error(msg);
    }

    const data = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
      message?: string;
    };

    const challenge: DeviceCodeAuthChallenge = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri || 'https://www.microsoft.com/link',
      expiresInSeconds: data.expires_in || 900,
      intervalSeconds: data.interval || 5,
      startedAt: Date.now(),
      clientIdConfigured: true,
      statusMessage:
        data.message ||
        `Open ${data.verification_uri || 'https://www.microsoft.com/link'} and enter code ${data.user_code}.`,
    };

    this.latestDeviceCode = challenge.deviceCode;
    this.pendingChallenges.set(challenge.deviceCode, {
      challenge,
      clientId,
      cancelled: false,
    });

    this.authFlowState = {
      mode: 'device_code',
      deviceChallenge: challenge,
      startedAt: challenge.startedAt,
      expiresAt: challenge.startedAt + challenge.expiresInSeconds * 1000,
      message: challenge.statusMessage,
    };

    return challenge;
  }

  /**
   * Polls Microsoft token endpoint for Device Code completion and runs Xbox Live -> XSTS -> Minecraft Services.
   */
  public async pollDeviceCodeCompletion(deviceCode?: string): Promise<{
    status: 'pending' | 'completed' | 'expired' | 'cancelled';
    account?: MinecraftAccount;
    message: string;
  }> {
    const resolvedCode = deviceCode || this.latestDeviceCode || '';
    const pending = this.pendingChallenges.get(resolvedCode);
    if (!pending) {
      if (this.authFlowState.mode === 'cancelled') {
        return { status: 'cancelled', message: 'Device code sign-in was cancelled.' };
      }
      return {
        status: 'expired',
        message: 'Device code session not found or already completed.',
      };
    }

    if (pending.cancelled) {
      this.pendingChallenges.delete(resolvedCode);
      return { status: 'cancelled', message: 'Device code sign-in cancelled.' };
    }

    const tokenRes = await this.fetchFn(
      `https://login.microsoftonline.com/${this.oauthConfig.tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: pending.clientId,
          device_code: resolvedCode,
        }),
      }
    );

    const tokenJson = (await tokenRes.json()) as {
      error?: string;
      error_description?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokenRes.ok) {
      if (tokenJson.error === 'authorization_pending' || tokenJson.error === 'slow_down') {
        return {
          status: 'pending',
          message: 'Waiting for browser authorization at microsoft.com/link...',
        };
      }
      this.pendingChallenges.delete(resolvedCode);
      if (tokenJson.error === 'authorization_declined') {
        this.authFlowState = { mode: 'cancelled', message: 'Authorization declined in browser.' };
        return { status: 'cancelled', message: 'Authorization declined in browser.' };
      }
      const msg = tokenJson.error_description || 'Device code expired or was declined.';
      this.authFlowState = { mode: 'error', message: msg };
      return { status: 'expired', message: msg };
    }

    this.pendingChallenges.delete(resolvedCode);
    if (!tokenJson.access_token) {
      throw new Error('Microsoft token response omitted access_token.');
    }

    const account = await this.exchangeMicrosoftTokenToMinecraftAccount(
      tokenJson.access_token,
      tokenJson.refresh_token
    );

    this.activeSessionMode = 'online_authenticated';
    this.authFlowState = {
      mode: 'completed',
      message: `Authenticated as ${account.username} (Minecraft: Java Edition ownership verified).`,
    };

    return {
      status: 'completed',
      account,
      message: this.authFlowState.message,
    };
  }

  /**
   * Executes the full Xbox Live -> XSTS -> Minecraft Services -> Entitlement -> Profile chain.
   */
  public async exchangeMicrosoftTokenToMinecraftAccount(
    msAccessToken: string,
    msRefreshToken?: string
  ): Promise<MinecraftAccount> {
    // 1. Xbox Live User Authenticate
    const xblRes = await this.fetchFn('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `d=${msAccessToken}`,
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      }),
    });
    if (!xblRes.ok) {
      throw new Error(`Xbox Live user authentication failed (HTTP ${xblRes.status}).`);
    }
    const xblJson = (await xblRes.json()) as {
      Token: string;
      DisplayClaims: { xui: Array<{ uhs: string }> };
    };
    const userHash = xblJson.DisplayClaims?.xui?.[0]?.uhs;
    if (!xblJson.Token || !userHash) {
      throw new Error('Xbox Live authentication response missing token or user hash (uhs).');
    }

    // 2. XSTS Authorize for Minecraft Services
    const xstsRes = await this.fetchFn('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Properties: {
          SandboxId: 'RETAIL',
          UserTokens: [xblJson.Token],
        },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      }),
    });
    if (!xstsRes.ok) {
      let xerrDetail = `HTTP ${xstsRes.status}`;
      try {
        const errObj = (await xstsRes.json()) as { XErr?: number };
        if (errObj.XErr === 2148916233) {
          xerrDetail =
            'This Microsoft account does not have an Xbox Live profile yet. Sign into xbox.com once to create a Gamertag.';
        } else if (errObj.XErr === 2148916238) {
          xerrDetail =
            'Child/Family Microsoft account requires parental consent for third-party multiplayer in Xbox Family Settings.';
        }
      } catch {
        // Keep HTTP status fallback
      }
      throw new Error(`XSTS authorization failed: ${xerrDetail}`);
    }
    const xstsJson = (await xstsRes.json()) as {
      Token: string;
      DisplayClaims?: { xui?: Array<{ xid?: string }> };
    };

    // 3. Minecraft Services login_with_xbox
    const mcAuthRes = await this.fetchFn(
      'https://api.minecraftservices.com/authentication/login_with_xbox',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          identityToken: `XBL3.0 x=${userHash};${xstsJson.Token}`,
        }),
      }
    );
    if (!mcAuthRes.ok) {
      throw new Error(`Minecraft Services authentication failed (HTTP ${mcAuthRes.status}).`);
    }
    const mcAuthJson = (await mcAuthRes.json()) as {
      access_token: string;
      expires_in: number;
    };

    // 4. Verify genuine Minecraft Java Edition game entitlement
    const entitlementRes = await this.fetchFn(
      'https://api.minecraftservices.com/entitlements/mcstore',
      {
        headers: { Authorization: `Bearer ${mcAuthJson.access_token}` },
      }
    );
    let ownsGame = false;
    if (entitlementRes.ok) {
      const entJson = (await entitlementRes.json()) as { items?: Array<{ name: string }> };
      ownsGame = Boolean(
        entJson.items &&
          entJson.items.some(
            (i) => i.name === 'product_minecraft' || i.name === 'game_minecraft'
          )
      );
    }

    // 5. Fetch official Minecraft Java Profile (UUID, Username, and active Skin URL)
    const profileRes = await this.fetchFn('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${mcAuthJson.access_token}` },
    });
    if (!profileRes.ok || !ownsGame) {
      throw new Error(
        'Authenticated Microsoft account does not own an active Minecraft: Java Edition license or Java profile.'
      );
    }
    const profileJson = (await profileRes.json()) as {
      id: string;
      name: string;
      skins?: Array<{ id?: string; state?: string; url?: string }>;
    };

    const activeSkinUrl =
      profileJson.skins?.find((s) => s.state === 'ACTIVE')?.url ??
      profileJson.skins?.[0]?.url;

    const now = Date.now();
    const record: SecretAccountRecord = {
      id: `acc-${profileJson.id}`,
      uuid: profileJson.id,
      username: profileJson.name,
      xuid: xstsJson.DisplayClaims?.xui?.[0]?.xid,
      skinUrl: activeSkinUrl,
      authProvider: 'microsoft_oauth',
      tokenExpiresAt: now + (mcAuthJson.expires_in || 86400) * 1000,
      lastValidatedAt: now,
      sessionStatus: 'valid',
      skinAvatarSeed: profileJson.name,
      active: true,
      ownsMinecraftJava: true,
      mcAccessToken: mcAuthJson.access_token,
      msRefreshToken,
    };

    this.accounts = this.accounts
      .filter((a) => a.uuid !== record.uuid)
      .map((a) => ({ ...a, active: false }));
    this.accounts.unshift(record);
    this.saveVault();

    const sanitized = this.listAccounts().find((a) => a.id === record.id)!;
    return sanitized;
  }

  /**
   * Silent refresh or online session validation before launching Minecraft in online mode.
   */
  public async refreshOrValidateSession(accountId: string): Promise<MinecraftAccount> {
    const record = this.accounts.find((a) => a.id === accountId);
    if (!record) {
      throw new Error(`Account "${accountId}" not found.`);
    }

    if (record.sessionStatus === 'signed_out') {
      throw new Error(
        `Account "${record.username}" is signed out. Click "Sign in with Microsoft" to authenticate again.`
      );
    }

    if (record.mcAccessToken && record.tokenExpiresAt > Date.now() + 120_000) {
      record.lastValidatedAt = Date.now();
      record.sessionStatus = 'valid';
      this.saveVault();
      return this.listAccounts().find((a) => a.id === accountId)!;
    }

    if (!record.msRefreshToken) {
      record.sessionStatus = 'expired';
      this.saveVault();
      throw new Error(
        `Session for "${record.username}" has expired and requires signing in with Microsoft again.`
      );
    }

    const clientId = this.assertOAuthClientConfigured();
    const refreshRes = await this.fetchFn(
      `https://login.microsoftonline.com/${this.oauthConfig.tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: record.msRefreshToken,
          scope: this.oauthConfig.scopes.join(' '),
        }),
      }
    );

    if (!refreshRes.ok) {
      record.sessionStatus = 'expired';
      this.saveVault();
      throw new Error('Microsoft refresh token expired or was revoked. Please sign in again.');
    }

    const refreshJson = (await refreshRes.json()) as {
      access_token: string;
      refresh_token?: string;
    };

    const refreshed = await this.exchangeMicrosoftTokenToMinecraftAccount(
      refreshJson.access_token,
      refreshJson.refresh_token || record.msRefreshToken
    );
    this.activeSessionMode = 'online_authenticated';
    return refreshed;
  }

  /**
   * Retrieves the decrypted Minecraft access token strictly at process-spawn time for online sessions.
   * Never exposed over HTTP/WebView RPC.
   */
  public getDecryptedMcAccessToken(accountId: string): string | null {
    const record = this.accounts.find((a) => a.id === accountId);
    if (!record || record.sessionStatus === 'signed_out') return null;
    if (record.tokenExpiresAt <= Date.now()) return null;
    return record.mcAccessToken ?? null;
  }

  public async acquireLaunchSessionToken(): Promise<{
    account: MinecraftAccount;
    mcAccessToken: string;
  } | null> {
    const active = this.getActiveAccountRecord();
    if (!active || active.sessionStatus === 'signed_out') {
      return null;
    }
    const validated = await this.refreshOrValidateSession(active.id);
    const token = this.getDecryptedMcAccessToken(validated.id);
    if (!token) return null;
    this.log(`[Auth] Verified online Minecraft session for ${validated.username}.`);
    return { account: validated, mcAccessToken: token };
  }
}

export { AuthService as MicrosoftAuthService };
