import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type {
  AuthErrorCode,
  AuthFlowState,
  AuthProgressStep,
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
import {
  generateOfflineMinecraftUuid,
  validateMinecraftUsername,
} from '../shared/offlineAccountUtils';
import { EncryptedTokenVault, redactSensitiveTokens } from './securityUtils';

interface SecretAccountRecord extends MinecraftAccount {
  /** Never exposed over RPC/UI snapshots — stored strictly inside AES-256-GCM / DPAPI vault */
  mcAccessToken?: string;
  msRefreshToken?: string;
}

export class AuthFlowException extends Error {
  public readonly errorCode: AuthErrorCode;
  public readonly userTitle: string;
  public readonly technicalDetail?: string;

  constructor(opts: {
    errorCode: AuthErrorCode;
    userTitle: string;
    userMessage: string;
    technicalDetail?: string;
  }) {
    super(opts.userMessage);
    this.name = 'AuthFlowException';
    this.errorCode = opts.errorCode;
    this.userTitle = opts.userTitle;
    this.technicalDetail = opts.technicalDetail;
  }
}

export interface AuthServiceOptions {
  /** Override build-time OAuth config (used by automated tests) */
  oauthConfigOverride?: Partial<ResolvedOAuthBuildConfig>;
  /** Custom HTTP fetch implementation (used by automated tests for deterministic OAuth/XBL/XSTS/MC mocking) */
  fetchImpl?: typeof fetch;
  /** Disable spawning OS browser during automated headless tests */
  openSystemBrowser?: boolean;
  /** Custom system browser launcher hook (returns true if launched, false/throws on failure) */
  browserLauncher?: (url: string) => Promise<boolean> | boolean;
  /** Override PKCE callback timeout in milliseconds (default 300,000 ms / 5 minutes) */
  pkceTimeoutMs?: number;
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

async function launchDefaultSystemBrowser(url: string): Promise<boolean> {
  if (!url.startsWith('https://login.microsoftonline.com/')) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    try {
      const cmd =
        process.platform === 'win32'
          ? 'rundll32.exe'
          : process.platform === 'darwin'
            ? 'open'
            : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
      });
      let settled = false;
      child.once('error', () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.once('spawn', () => {
        child.unref();
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      }, 120).unref?.();
    } catch {
      resolve(false);
    }
  });
}

/**
 * Production Microsoft Identity Platform OAuth 2.0 (Authorization Code + PKCE via System Browser
 * + `http://localhost` Loopback Callback, with Device Code fallback) -> Xbox Live -> XSTS ->
 * Minecraft Services authentication, ownership verification, and encrypted token storage service.
 *
 * Security invariants:
 * - Public Client ID belongs to Vespera Client (resolved at build/startup time via `VESPERA_MSA_CLIENT_ID`,
 *   `config/oauth.local.json`, `config/oauth.development.json`, or `config/oauth.release.json`).
 *   End users NEVER enter or register a Client ID.
 * - Never embeds a Client Secret or fabricates placeholder Client IDs, tokens, or Minecraft ownership.
 * - Prevents authorization-code replay and enforces timing-safe CSRF `state` verification.
 * - Tokens are encrypted at rest with AES-256-GCM (and Windows DPAPI in the native Win32 host) and
 *   redacted from all logs and UI snapshots.
 */
export class AuthService {
  private readonly vault: EncryptedTokenVault;
  private readonly oauthConfig: ResolvedOAuthBuildConfig;
  private readonly fetchFn: typeof fetch;
  private readonly shouldOpenBrowser: boolean;
  private readonly browserLauncherFn: (url: string) => Promise<boolean> | boolean;
  private readonly pkceTimeoutMs: number;
  private readonly log: (line: string) => void;

  private accounts: SecretAccountRecord[] = [];
  private consumedAuthCodes = new Set<string>();
  private latestDeviceCode: string | null = null;
  private pendingChallenges = new Map<
    string,
    { challenge: DeviceCodeAuthChallenge; clientId: string; cancelled: boolean }
  >();
  private activePkceSession: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    authorizeUrl: string;
    startedAt: number;
    expiresAt: number;
    server: http.Server;
    timeoutHandle: NodeJS.Timeout;
    callbackConsumed: boolean;
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
    const rawLog = options.onLog ?? (() => {});
    this.log = (line: string) => rawLog(redactSensitiveTokens(line));

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
    this.browserLauncherFn = options.browserLauncher ?? launchDefaultSystemBrowser;
    this.pkceTimeoutMs = Math.max(100, options.pkceTimeoutMs ?? 5 * 60_000);

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

  private setProgressStep(step: AuthProgressStep, message: string): void {
    this.authFlowState = {
      ...this.authFlowState,
      mode: 'pkce_browser',
      step,
      message,
    };
  }

  private setErrorState(err: unknown): AuthFlowException {
    const authEx =
      err instanceof AuthFlowException
        ? err
        : new AuthFlowException({
            errorCode: 'microsoft_auth_failed',
            userTitle: 'Sign-in could not be completed',
            userMessage:
              'Something went wrong while completing Microsoft sign-in. Please try again in a moment.',
            technicalDetail: err instanceof Error ? redactSensitiveTokens(err.message) : String(err),
          });

    this.authFlowState = {
      mode: authEx.errorCode === 'user_cancelled' ? 'cancelled' : 'error',
      errorCode: authEx.errorCode,
      userTitle: authEx.userTitle,
      message: authEx.message,
      technicalDetail: authEx.technicalDetail,
    };
    this.log(
      `[Auth] ${authEx.errorCode}: ${authEx.message}${
        authEx.technicalDetail ? ` (${authEx.technicalDetail})` : ''
      }`
    );
    return authEx;
  }

  public getActiveSessionMode(): 'online_authenticated' | 'offline_singleplayer' {
    return this.activeSessionMode;
  }

  public setSessionMode(
    mode: 'online_authenticated' | 'offline_singleplayer'
  ): OfflineAvailabilityState {
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
    const active = this.accounts.find(
      (a) =>
        a.accountType !== 'offline' &&
        a.active &&
        a.ownsMinecraftJava &&
        a.lastValidatedAt > 0
    );
    if (active) return active;
    return (
      this.accounts.find(
        (a) => a.accountType !== 'offline' && a.ownsMinecraftJava && a.lastValidatedAt > 0
      ) ?? null
    );
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
    this.accounts = Array.isArray(parsed)
      ? parsed.map((a) => {
          const isOffline =
            a.accountType === 'offline' || (a.authProvider as string) === 'offline';
          return {
            ...a,
            accountType: isOffline ? 'offline' : 'microsoft',
            authProvider: isOffline ? 'offline' : 'microsoft_oauth',
            ownsMinecraftJava: isOffline ? false : Boolean(a.ownsMinecraftJava),
          };
        })
      : [];
  }

  private saveVault(): void {
    this.vault.saveEncrypted(this.accounts);
  }

  /**
   * Creates and persists a genuine local Minecraft: Java Edition offline-mode account profile
   * using Mojang's deterministic `OfflinePlayer:<username>` MD5 v3 UUID algorithm.
   * Never requires Microsoft credentials and never pretends to be an online Microsoft account.
   */
  public createOfflineAccount(rawUsername: string): MinecraftAccount {
    const check = validateMinecraftUsername(rawUsername);
    if (!check.valid) {
      throw new Error(check.error || 'Invalid Minecraft username.');
    }
    const username = check.normalized;
    const duplicate = this.accounts.find(
      (a) => a.accountType === 'offline' && a.username.toLowerCase() === username.toLowerCase()
    );
    if (duplicate) {
      throw new Error(
        `An offline account named "${duplicate.username}" already exists. Select it in your accounts list.`
      );
    }

    const offlineUuid = generateOfflineMinecraftUuid(username);
    const record: SecretAccountRecord = {
      id: `acc-offline-${offlineUuid}`,
      uuid: offlineUuid,
      username,
      accountType: 'offline',
      authProvider: 'offline',
      tokenExpiresAt: 0,
      lastValidatedAt: 0,
      createdAt: new Date().toISOString(),
      sessionStatus: 'offline_ready',
      skinAvatarSeed: username,
      active: true,
      ownsMinecraftJava: false,
    };

    this.accounts = this.accounts.map((a) => ({ ...a, active: false }));
    this.accounts.unshift(record);
    this.saveVault();
    this.log(
      `[Accounts] Created local Offline Account "${username}" (UUID: ${offlineUuid}).`
    );
    return this.listAccounts().find((a) => a.id === record.id)!;
  }

  public listAccounts(): MinecraftAccount[] {
    const now = Date.now();
    return this.accounts.map((acc) => {
      if (acc.accountType === 'offline' || acc.authProvider === 'offline') {
        return {
          id: acc.id,
          uuid: acc.uuid,
          username: acc.username,
          accountType: 'offline',
          authProvider: 'offline',
          tokenExpiresAt: 0,
          lastValidatedAt: 0,
          createdAt: acc.createdAt,
          sessionStatus: 'offline_ready',
          skinAvatarSeed: acc.skinAvatarSeed || acc.username,
          active: acc.active,
          ownsMinecraftJava: false,
        };
      }

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
        accountType: 'microsoft',
        xuid: acc.xuid,
        skinUrl: acc.skinUrl,
        authProvider: 'microsoft_oauth',
        tokenExpiresAt: acc.tokenExpiresAt,
        lastValidatedAt: acc.lastValidatedAt,
        createdAt: acc.createdAt,
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
    const target = this.accounts.find((a) => a.id === accountId);
    if (!target) {
      throw new Error(`Account "${accountId}" not found.`);
    }
    this.accounts = this.accounts.map((a) => ({
      ...a,
      active: a.id === accountId,
    }));
    if (target.accountType === 'microsoft' && target.sessionStatus !== 'signed_out') {
      this.activeSessionMode = 'online_authenticated';
    }
    this.saveVault();
    return this.listAccounts();
  }

  /**
   * Signs out of a Microsoft account by purging its live access & refresh tokens from the encrypted vault
   * while retaining the verified account record.
   */
  public signOutAccount(accountId: string): MinecraftAccount[] {
    const record = this.accounts.find((a) => a.id === accountId);
    if (!record) {
      throw new Error(`Account "${accountId}" not found.`);
    }
    if (record.accountType === 'offline') {
      throw new Error(
        `Offline account "${record.username}" does not use an online session. Use Switch or Remove instead.`
      );
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
      throw this.setErrorState(
        new AuthFlowException({
          errorCode: 'missing_app_config',
          userTitle: 'Microsoft Sign-In Not Configured in This Build',
          userMessage:
            'This build of Vespera Client does not include a registered Microsoft OAuth Application ID yet, so Microsoft sign-in cannot start.',
          technicalDetail:
            'Missing build-time Microsoft Entra Application (client) ID. Configure VESPERA_MSA_CLIENT_ID, config/oauth.local.json, or config/oauth.release.json with http://localhost redirect URI (see docs/OAUTH_DEVELOPER_SETUP.md).',
        })
      );
    }
    return this.oauthConfig.clientId;
  }

  /**
   * Cancels any in-progress PKCE loopback browser sign-in or Device Code polling flow cleanly
   * and returns the launcher to the normal Accounts state without crashing.
   */
  public cancelActiveAuthFlow(): AuthFlowState {
    if (this.activePkceSession) {
      this.activePkceSession.cancelled = true;
      this.activePkceSession.callbackConsumed = true;
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
      mode: 'idle',
      message: 'Sign-in cancelled.',
    };
    return this.getAuthFlowState();
  }

  /**
   * Primary Vespera v1.2.0 sign-in flow:
   * Starts a temporary localhost loopback HTTP callback listener (`http://localhost:<port>`),
   * generates RFC 7636 PKCE (`S256`) + cryptographic `state`, opens the official Microsoft login
   * website in the OS default browser, validates callback & prevents replay, and completes
   * Xbox Live -> XSTS -> Minecraft Services -> Entitlement -> Profile automatically.
   */
  public async startBrowserPkceSignIn(): Promise<AuthFlowState> {
    const clientId = this.assertOAuthClientConfigured();

    // Clean up any prior unfinished PKCE listener first
    if (this.activePkceSession) {
      this.cancelActiveAuthFlow();
    }

    this.authFlowState = {
      mode: 'pkce_browser',
      step: 'opening_browser',
      message: 'Opening Microsoft login...',
    };

    const codeVerifier = toBase64Url(crypto.randomBytes(32));
    const codeChallenge = toBase64Url(
      crypto.createHash('sha256').update(codeVerifier, 'ascii').digest()
    );
    const csrfState = toBase64Url(crypto.randomBytes(24));

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

    const redirectPath = this.oauthConfig.loopbackRedirectPath;
    const redirectUri = `http://${this.oauthConfig.loopbackHost}:${port}${redirectPath}`;
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
    const expiresAt = startedAt + this.pkceTimeoutMs;

    const timeoutHandle = setTimeout(() => {
      if (this.activePkceSession?.state === csrfState && !this.activePkceSession.callbackConsumed) {
        this.closeActivePkceListener();
        this.setErrorState(
          new AuthFlowException({
            errorCode: 'callback_timeout',
            userTitle: 'Sign-In Timed Out',
            userMessage:
              'We did not receive a sign-in response from your browser in time. If you closed the browser window, click "Sign in with Microsoft" whenever you are ready to try again.',
            technicalDetail: `OAuth loopback callback timed out after ${this.pkceTimeoutMs}ms on ${redirectUri}.`,
          })
        );
      }
    }, this.pkceTimeoutMs);
    timeoutHandle.unref?.();

    this.activePkceSession = {
      state: csrfState,
      codeVerifier,
      redirectUri,
      authorizeUrl,
      startedAt,
      expiresAt,
      server,
      timeoutHandle,
      callbackConsumed: false,
      cancelled: false,
    };

    server.on('request', async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Method Not Allowed');
          return;
        }

        const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
        if (reqUrl.pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }

        const expectedPath = redirectPath || '/';
        const pathAllowed =
          reqUrl.pathname === expectedPath ||
          (redirectPath === '' && reqUrl.pathname === '/callback');
        if (!pathAllowed) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        if (!this.activePkceSession || this.activePkceSession.callbackConsumed) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            this.renderLoopbackHtml(
              false,
              'Sign-In Session Already Used',
              'This authorization callback has already been processed. Please return to Vespera Client.'
            )
          );
          return;
        }

        const returnedState = reqUrl.searchParams.get('state') || '';
        const oauthError = reqUrl.searchParams.get('error');
        const oauthErrorDesc = reqUrl.searchParams.get('error_description') || '';
        const authCode = reqUrl.searchParams.get('code') || '';

        const expectedBuf = Buffer.from(csrfState, 'utf8');
        const actualBuf = Buffer.from(returnedState, 'utf8');
        const stateMatches =
          returnedState.length > 0 &&
          expectedBuf.length === actualBuf.length &&
          crypto.timingSafeEqual(expectedBuf, actualBuf);

        if (!stateMatches) {
          this.activePkceSession.callbackConsumed = true;
          this.closeActivePkceListener();
          this.setErrorState(
            new AuthFlowException({
              errorCode: 'invalid_callback',
              userTitle: 'Security Verification Failed',
              userMessage:
                'The sign-in response did not match your active Vespera session and was blocked for your security. Please click "Sign in with Microsoft" to start a fresh login.',
              technicalDetail: 'OAuth 2.0 CSRF state parameter mismatch on loopback callback.',
            })
          );
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            this.renderLoopbackHtml(
              false,
              'Security Verification Failed',
              'The sign-in callback state did not match your active Vespera Client session. Please close this tab and try again from Vespera Client.'
            )
          );
          return;
        }

        if (oauthError) {
          this.activePkceSession.callbackConsumed = true;
          this.closeActivePkceListener();
          const classified = this.classifyOAuthProviderError(oauthError, oauthErrorDesc);
          this.setErrorState(classified);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, classified.userTitle, classified.message));
          return;
        }

        if (!authCode) {
          this.activePkceSession.callbackConsumed = true;
          this.closeActivePkceListener();
          const missingEx = new AuthFlowException({
            errorCode: 'invalid_callback',
            userTitle: 'Incomplete Sign-In Response',
            userMessage:
              'Microsoft redirected back without an authorization code. Please click "Sign in with Microsoft" to try again.',
            technicalDetail: 'Callback query omitted both error and code parameters.',
          });
          this.setErrorState(missingEx);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, missingEx.userTitle, missingEx.message));
          return;
        }

        // Prevent authorization-code replay across callbacks
        const codeHash = crypto.createHash('sha256').update(authCode).digest('hex');
        if (this.consumedAuthCodes.has(codeHash)) {
          this.activePkceSession.callbackConsumed = true;
          this.closeActivePkceListener();
          const replayEx = new AuthFlowException({
            errorCode: 'invalid_callback',
            userTitle: 'Duplicate Sign-In Callback Ignored',
            userMessage:
              'That authorization code was already used. Please start a new Microsoft sign-in if needed.',
            technicalDetail: 'Authorization code replay rejected.',
          });
          this.setErrorState(replayEx);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, replayEx.userTitle, replayEx.message));
          return;
        }
        if (this.consumedAuthCodes.size > 128) {
          this.consumedAuthCodes.clear();
        }
        this.consumedAuthCodes.add(codeHash);

        this.activePkceSession.callbackConsumed = true;
        const verifierToUse = codeVerifier;
        this.closeActivePkceListener();

        this.setProgressStep('verifying_microsoft', 'Verifying Microsoft account...');

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
              `Signed in as ${account.username}`,
              'Your Minecraft: Java Edition account is connected! You can close this browser tab and return to Vespera Client.'
            )
          );
          this.activeSessionMode = 'online_authenticated';
          this.authFlowState = {
            mode: 'completed',
            userTitle: 'Signed in to Minecraft',
            message: `Signed in as ${account.username}.`,
          };
        } catch (exchangeErr) {
          const authEx = this.setErrorState(exchangeErr);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, authEx.userTitle, authEx.message));
        }
      } catch (err) {
        const authEx = this.setErrorState(err);
        this.closeActivePkceListener();
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.renderLoopbackHtml(false, authEx.userTitle, authEx.message));
        }
      }
    });

    let browserOpened = true;
    if (this.shouldOpenBrowser) {
      try {
        browserOpened = await this.browserLauncherFn(authorizeUrl);
      } catch {
        browserOpened = false;
      }
      if (!browserOpened) {
        this.closeActivePkceListener();
        throw this.setErrorState(
          new AuthFlowException({
            errorCode: 'browser_launch_failed',
            userTitle: 'Could Not Open Default Browser',
            userMessage:
              'Vespera Client could not automatically open your default web browser. Check your Windows default browser settings and try again.',
            technicalDetail: 'OS browser launcher returned false for Microsoft OAuth URL.',
          })
        );
      }
    }

    this.authFlowState = {
      mode: 'pkce_browser',
      step: 'waiting_for_login',
      authorizeUrl,
      redirectUri,
      browserOpened,
      startedAt,
      expiresAt,
      message: 'Waiting for authentication in your default browser...',
    };

    return this.getAuthFlowState();
  }

  private classifyOAuthProviderError(error: string, description: string): AuthFlowException {
    const combined = `${error} ${description}`;
    if (error === 'access_denied' || /user_cancelled|cancelled/i.test(combined)) {
      return new AuthFlowException({
        errorCode: 'user_cancelled',
        userTitle: 'Sign-In Cancelled',
        userMessage: 'Microsoft sign-in was cancelled before completion.',
        technicalDetail: redactSensitiveTokens(combined),
      });
    }
    if (
      error === 'unauthorized_client' ||
      error === 'invalid_client' ||
      /AADSTS700016|AADSTS70002/i.test(combined)
    ) {
      return new AuthFlowException({
        errorCode: 'invalid_client_id',
        userTitle: 'Invalid Microsoft Application Configuration',
        userMessage:
          'Microsoft rejected this application ID or public-client configuration. Please contact the Vespera maintainer.',
        technicalDetail: redactSensitiveTokens(combined),
      });
    }
    if (/AADSTS50011|redirect_uri/i.test(combined)) {
      return new AuthFlowException({
        errorCode: 'invalid_redirect_uri',
        userTitle: 'Redirect URI Configuration Mismatch',
        userMessage:
          'Microsoft rejected the local callback redirect URI. Ensure http://localhost is registered under Mobile and desktop applications.',
        technicalDetail: redactSensitiveTokens(combined),
      });
    }
    return new AuthFlowException({
      errorCode: 'microsoft_auth_failed',
      userTitle: 'Microsoft Sign-In Failed',
      userMessage:
        'Microsoft could not complete your sign-in request. Please try signing in again.',
      technicalDetail: redactSensitiveTokens(combined),
    });
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

  private renderLoopbackHtml(success: boolean, heading: string, detail: string): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const accent = success ? '#F59E0B' : '#EF4444';
    const badgeLabel = success ? 'Connected to Vespera Client' : 'Sign-In Incomplete';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Vespera Client — Microsoft Sign-In</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090B10; color: #F8FAFC; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
    .card { max-width: 460px; padding: 34px 32px; border-radius: 16px; background: #111520; border: 1px solid rgba(245,158,11,0.28); box-shadow: 0 24px 48px rgba(0,0,0,0.55); text-align: center; }
    .badge { display: inline-block; padding: 5px 13px; border-radius: 999px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${accent}; background: rgba(255,255,255,0.04); border: 1px solid ${accent}; margin-bottom: 16px; }
    h1 { font-size: 21px; margin: 0 0 10px; font-weight: 700; }
    p { font-size: 14px; line-height: 1.6; color: #CBD5E1; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${esc(badgeLabel)}</div>
    <h1>${esc(heading)}</h1>
    <p>${esc(detail)}</p>
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
    let tokenRes: Response;
    try {
      tokenRes = await this.fetchFn(
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
    } catch (netErr) {
      throw new AuthFlowException({
        errorCode: 'network_error',
        userTitle: 'Network Connection Interrupted',
        userMessage:
          'Vespera could not reach Microsoft authentication servers. Check your internet connection and try again.',
        technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
      });
    }

    const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || !tokenJson.access_token) {
      throw this.classifyOAuthProviderError(
        tokenJson.error || `http_${tokenRes.status}`,
        tokenJson.error_description || 'Authorization code redemption failed.'
      );
    }

    return this.exchangeMicrosoftTokenToMinecraftAccount(
      tokenJson.access_token,
      tokenJson.refresh_token
    );
  }

  /**
   * Secondary fallback Microsoft OAuth 2.0 Device Code flow using the centrally configured build-time Client ID.
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
      throw this.setErrorState(
        new AuthFlowException({
          errorCode: 'network_error',
          userTitle: 'Unable to Reach Microsoft Sign-In',
          userMessage:
            'Could not connect to Microsoft authentication servers. Check your internet connection or use Offline Singleplayer if your account was previously verified.',
          technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
        })
      );
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw this.setErrorState(
        this.classifyOAuthProviderError(`http_${res.status}`, errBody.slice(0, 240))
      );
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
      if (this.authFlowState.mode === 'cancelled' || this.authFlowState.mode === 'idle') {
        return { status: 'cancelled', message: 'Sign-in was cancelled.' };
      }
      return {
        status: 'expired',
        message: 'Sign-in session expired. Click "Sign in with Microsoft" to start again.',
      };
    }

    if (pending.cancelled) {
      this.pendingChallenges.delete(resolvedCode);
      return { status: 'cancelled', message: 'Sign-in cancelled.' };
    }

    let tokenRes: Response;
    try {
      tokenRes = await this.fetchFn(
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
    } catch (netErr) {
      throw this.setErrorState(
        new AuthFlowException({
          errorCode: 'network_error',
          userTitle: 'Network Connection Interrupted',
          userMessage: 'Lost connection while verifying Microsoft sign-in. Please try again.',
          technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
        })
      );
    }

    const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
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
          message: 'Waiting for confirmation in your browser...',
        };
      }
      this.pendingChallenges.delete(resolvedCode);
      if (tokenJson.error === 'authorization_declined') {
        this.setErrorState(
          new AuthFlowException({
            errorCode: 'user_cancelled',
            userTitle: 'Sign-In Declined',
            userMessage: 'Microsoft sign-in was declined in the browser.',
          })
        );
        return { status: 'cancelled', message: 'Microsoft sign-in was declined in the browser.' };
      }
      const ex = this.setErrorState(
        new AuthFlowException({
          errorCode: 'token_expired',
          userTitle: 'Sign-In Code Expired',
          userMessage: 'That sign-in session expired. Click "Sign in with Microsoft" to try again.',
          technicalDetail: tokenJson.error_description || tokenJson.error,
        })
      );
      return { status: 'expired', message: ex.message };
    }

    this.pendingChallenges.delete(resolvedCode);
    if (!tokenJson.access_token) {
      throw this.setErrorState(
        new AuthFlowException({
          errorCode: 'microsoft_auth_failed',
          userTitle: 'Microsoft Sign-In Incomplete',
          userMessage: 'Microsoft did not return an access token. Please try again.',
        })
      );
    }

    try {
      const account = await this.exchangeMicrosoftTokenToMinecraftAccount(
        tokenJson.access_token,
        tokenJson.refresh_token
      );

      this.activeSessionMode = 'online_authenticated';
      this.authFlowState = {
        mode: 'completed',
        userTitle: 'Signed in to Minecraft',
        message: `Signed in as ${account.username}.`,
      };

      return {
        status: 'completed',
        account,
        message: this.authFlowState.message,
      };
    } catch (err) {
      throw this.setErrorState(err);
    }
  }

  /**
   * Executes the complete Xbox Live -> XSTS -> Minecraft Services -> Entitlement -> Profile sequence,
   * updating `authFlowState.step` at each milestone and classifying any failure into clear user messages.
   */
  public async exchangeMicrosoftTokenToMinecraftAccount(
    msAccessToken: string,
    msRefreshToken?: string
  ): Promise<MinecraftAccount> {
    if (this.authFlowState.mode === 'pkce_browser') {
      this.setProgressStep('connecting_xbox', 'Connecting to Xbox services...');
    }

    // 1. Xbox Live User Authenticate
    let xblRes: Response;
    try {
      xblRes = await this.fetchFn('https://user.auth.xboxlive.com/user/authenticate', {
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
    } catch (netErr) {
      throw new AuthFlowException({
        errorCode: 'network_error',
        userTitle: 'Could Not Reach Xbox Live',
        userMessage:
          'Vespera could not reach Xbox Live services. Check your internet connection and try again.',
        technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
      });
    }

    if (!xblRes.ok) {
      throw new AuthFlowException({
        errorCode: 'xbox_auth_failed',
        userTitle: 'Xbox Live Sign-In Failed',
        userMessage:
          'Your Microsoft sign-in succeeded, but Xbox Live could not verify your account. Please try again.',
        technicalDetail: `user.auth.xboxlive.com returned HTTP ${xblRes.status}`,
      });
    }

    const xblJson = (await xblRes.json()) as {
      Token: string;
      DisplayClaims: { xui: Array<{ uhs: string }> };
    };
    const userHash = xblJson.DisplayClaims?.xui?.[0]?.uhs;
    if (!xblJson.Token || !userHash) {
      throw new AuthFlowException({
        errorCode: 'xbox_auth_failed',
        userTitle: 'Incomplete Xbox Live Response',
        userMessage: 'Xbox Live did not return a valid gamer session. Please try signing in again.',
        technicalDetail: 'Missing Token or DisplayClaims.xui[0].uhs in XBL response.',
      });
    }

    // 2. XSTS Authorize for Minecraft Services
    let xstsRes: Response;
    try {
      xstsRes = await this.fetchFn('https://xsts.auth.xboxlive.com/xsts/authorize', {
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
    } catch (netErr) {
      throw new AuthFlowException({
        errorCode: 'network_error',
        userTitle: 'Could Not Reach Xbox Security Service',
        userMessage: 'Network connection dropped while connecting to Xbox services.',
        technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
      });
    }

    if (!xstsRes.ok) {
      let userMessage =
        'Xbox services could not authorize Minecraft access for this Microsoft account.';
      let tech = `xsts.auth.xboxlive.com HTTP ${xstsRes.status}`;
      try {
        const errObj = (await xstsRes.json()) as { XErr?: number };
        if (errObj.XErr) tech += ` (XErr=${errObj.XErr})`;
        if (errObj.XErr === 2148916233) {
          userMessage =
            'This Microsoft account does not have an Xbox profile yet. Sign in once at xbox.com to create your free Gamertag, then try again.';
        } else if (errObj.XErr === 2148916238) {
          userMessage =
            'This account belongs to a Microsoft Family group and needs an adult to enable third-party multiplayer in Xbox Family Settings.';
        } else if (errObj.XErr === 2148916235) {
          userMessage = 'Xbox Live is not available for the region configured on this account.';
        }
      } catch {
        // Keep default message
      }
      throw new AuthFlowException({
        errorCode: 'xsts_auth_failed',
        userTitle: 'Xbox Account Setup Needed',
        userMessage,
        technicalDetail: tech,
      });
    }

    const xstsJson = (await xstsRes.json()) as {
      Token: string;
      DisplayClaims?: { xui?: Array<{ xid?: string }> };
    };

    // 3. Minecraft Services login_with_xbox
    let mcAuthRes: Response;
    try {
      mcAuthRes = await this.fetchFn(
        'https://api.minecraftservices.com/authentication/login_with_xbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            identityToken: `XBL3.0 x=${userHash};${xstsJson.Token}`,
          }),
        }
      );
    } catch (netErr) {
      throw new AuthFlowException({
        errorCode: 'network_error',
        userTitle: 'Could Not Reach Minecraft Services',
        userMessage:
          'Vespera could not connect to official Minecraft authentication servers. Please check your internet connection.',
        technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
      });
    }

    if (!mcAuthRes.ok) {
      throw new AuthFlowException({
        errorCode: 'microsoft_auth_failed',
        userTitle: 'Minecraft Services Sign-In Failed',
        userMessage:
          'Minecraft Services rejected the Xbox session token. If this is a custom build, verify the OAuth app is approved for Minecraft Services.',
        technicalDetail: `api.minecraftservices.com/authentication/login_with_xbox HTTP ${mcAuthRes.status}`,
      });
    }
    const mcAuthJson = (await mcAuthRes.json()) as {
      access_token: string;
      expires_in: number;
    };

    // 4. Verify genuine Minecraft Java Edition game ownership / entitlement
    if (this.authFlowState.mode === 'pkce_browser') {
      this.setProgressStep('checking_ownership', 'Checking Minecraft ownership...');
    }

    let entitlementRes: Response;
    try {
      entitlementRes = await this.fetchFn(
        'https://api.minecraftservices.com/entitlements/mcstore',
        {
          headers: { Authorization: `Bearer ${mcAuthJson.access_token}` },
        }
      );
    } catch (netErr) {
      throw new AuthFlowException({
        errorCode: 'network_error',
        userTitle: 'Could Not Check Minecraft Ownership',
        userMessage: 'Network interrupted while checking your Minecraft: Java Edition license.',
        technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
      });
    }

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

    if (!ownsGame) {
      throw new AuthFlowException({
        errorCode: 'no_minecraft_entitlement',
        userTitle: 'Minecraft: Java Edition Not Found on This Account',
        userMessage:
          'This Microsoft account does not own an active Minecraft: Java Edition license (or PC Game Pass subscription). Make sure you signed in with the right Microsoft email.',
        technicalDetail: 'entitlements/mcstore contained neither product_minecraft nor game_minecraft.',
      });
    }

    // 5. Retrieve official Minecraft Java Profile (UUID, Username, and active Skin URL)
    if (this.authFlowState.mode === 'pkce_browser') {
      this.setProgressStep('retrieving_profile', 'Retrieving Minecraft profile...');
    }

    let profileRes: Response;
    try {
      profileRes = await this.fetchFn('https://api.minecraftservices.com/minecraft/profile', {
        headers: { Authorization: `Bearer ${mcAuthJson.access_token}` },
      });
    } catch (netErr) {
      throw new AuthFlowException({
        errorCode: 'network_error',
        userTitle: 'Could Not Load Minecraft Profile',
        userMessage: 'Network interrupted while retrieving your Minecraft username and skin.',
        technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
      });
    }

    if (!profileRes.ok) {
      throw new AuthFlowException({
        errorCode: 'no_minecraft_profile',
        userTitle: 'Minecraft Username Not Created Yet',
        userMessage:
          'Your Microsoft account owns Minecraft, but you have not chosen a Java Edition username yet. Visit minecraft.net/msaprofile once to pick your username, then sign in here.',
        technicalDetail: `api.minecraftservices.com/minecraft/profile HTTP ${profileRes.status}`,
      });
    }

    const profileJson = (await profileRes.json()) as {
      id: string;
      name: string;
      skins?: Array<{ id?: string; state?: string; url?: string }>;
    };

    if (!profileJson.id || !profileJson.name) {
      throw new AuthFlowException({
        errorCode: 'no_minecraft_profile',
        userTitle: 'Incomplete Minecraft Profile',
        userMessage: 'Minecraft Services returned an empty player profile. Please try again.',
      });
    }

    const activeSkinUrl =
      profileJson.skins?.find((s) => s.state === 'ACTIVE')?.url ?? profileJson.skins?.[0]?.url;

    const now = Date.now();
    const record: SecretAccountRecord = {
      id: `acc-${profileJson.id}`,
      uuid: profileJson.id,
      username: profileJson.name,
      accountType: 'microsoft',
      xuid: xstsJson.DisplayClaims?.xui?.[0]?.xid,
      skinUrl: activeSkinUrl,
      authProvider: 'microsoft_oauth',
      tokenExpiresAt: now + (mcAuthJson.expires_in || 86400) * 1000,
      lastValidatedAt: now,
      createdAt: new Date().toISOString(),
      sessionStatus: 'valid',
      skinAvatarSeed: profileJson.name,
      active: true,
      ownsMinecraftJava: true,
      mcAccessToken: mcAuthJson.access_token,
      msRefreshToken,
    };

    // Replace existing Microsoft entry for the same UUID, never touching any local Offline accounts!
    this.accounts = this.accounts
      .filter((a) => !(a.accountType === 'microsoft' && a.uuid === record.uuid))
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
    if (record.accountType === 'offline') {
      throw new Error(
        `Account "${record.username}" is an Offline Account and cannot be converted into or refreshed as a Microsoft session.`
      );
    }

    if (record.sessionStatus === 'signed_out') {
      throw new AuthFlowException({
        errorCode: 'token_expired',
        userTitle: 'Signed Out',
        userMessage: `You signed out of ${record.username}. Click "Sign in with Microsoft" to reconnect.`,
      });
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
      throw this.setErrorState(
        new AuthFlowException({
          errorCode: 'token_expired',
          userTitle: 'Session Expired',
          userMessage: `Your session for ${record.username} has expired. Click "Sign in with Microsoft" to reconnect.`,
        })
      );
    }

    const clientId = this.assertOAuthClientConfigured();
    let refreshRes: Response;
    try {
      refreshRes = await this.fetchFn(
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
    } catch (netErr) {
      throw this.setErrorState(
        new AuthFlowException({
          errorCode: 'network_error',
          userTitle: 'Could Not Refresh Session',
          userMessage:
            'Unable to reach Microsoft to refresh your login session. Check your internet connection or use Offline Singleplayer.',
          technicalDetail: netErr instanceof Error ? netErr.message : String(netErr),
        })
      );
    }

    if (!refreshRes.ok) {
      record.sessionStatus = 'expired';
      this.saveVault();
      throw this.setErrorState(
        new AuthFlowException({
          errorCode: 'token_expired',
          userTitle: 'Session Expired',
          userMessage: `Your Microsoft login for ${record.username} has expired. Please click "Sign in with Microsoft" to sign back in.`,
          technicalDetail: `Refresh token grant returned HTTP ${refreshRes.status}`,
        })
      );
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
    if (!record || record.accountType === 'offline' || record.sessionStatus === 'signed_out') {
      return null;
    }
    if (record.tokenExpiresAt <= Date.now()) return null;
    return record.mcAccessToken ?? null;
  }

  public async acquireLaunchSessionToken(): Promise<{
    account: MinecraftAccount;
    mcAccessToken: string;
  } | null> {
    const active = this.getActiveAccountRecord();
    if (!active || active.accountType === 'offline' || active.sessionStatus === 'signed_out') {
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
