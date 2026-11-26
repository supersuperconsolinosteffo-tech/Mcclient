import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBuildTimeOAuthConfig } from '../shared/oauthBuildConfig';
import { AuthService } from '../server/authService';
import { VesperaStateCoordinator } from '../server/stateStore';
import { renderAccountsPage } from '../ui/src/pages/accountsSettingsDiagAbout';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vespera-v111-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.VESPERA_MSA_CLIENT_ID;
  delete process.env.VESPERA_MSA_CLIENT_SECRET;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sha256Base64Url(str: string): string {
  return crypto
    .createHash('sha256')
    .update(str, 'ascii')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('Vespera Client v1.1.1 — Seamless Microsoft Login UX & PKCE Regression Suite', () => {
  it('1. renders clean "Connect your Minecraft account" + "Sign in with Microsoft" UX without any developer notices on initial load', () => {
    const dataDir = makeTempDir();
    const coord = new VesperaStateCoordinator(dataDir);
    const snap = coord.getSnapshot();

    // Even when built without an embedded Client ID, the normal Accounts page MUST NOT show developer notices
    expect(snap.oauthConfig?.configured).toBe(false);
    const html = renderAccountsPage(snap, null);

    expect(html).toContain('Add Offline Account');
    expect(html).toContain('Add Microsoft Account');
    expect(html).toContain('Offline Accounts');
    expect(html).toContain('Sign in with Microsoft');
    expect(html).toContain('Vespera never asks for your password');
    expect(html).not.toContain('Developer Config Required');
    expect(html).not.toContain('Maintainer / Developer Build Configuration Notice');
    expect(html).not.toContain('msa-client-id-input');

    coord.shutdownCleanly();
  });

  it('2. surfaces a friendly, non-stack-trace configuration error ONLY when attempting authentication without a Client ID', async () => {
    const dataDir = makeTempDir();
    const coord = new VesperaStateCoordinator(dataDir, {
      authOptions: {
        oauthConfigOverride: { clientId: '', configured: false, source: 'unconfigured' },
        openSystemBrowser: false,
      },
    });

    await expect(coord.authService.startBrowserPkceSignIn()).rejects.toThrow(
      /does not include a registered Microsoft OAuth Application ID yet/i
    );

    const errSnap = coord.getSnapshot();
    expect(errSnap.authFlow?.mode).toBe('error');
    expect(errSnap.authFlow?.errorCode).toBe('missing_app_config');
    expect(errSnap.authFlow?.message).not.toContain('at AuthService.');

    const errHtml = renderAccountsPage(errSnap, null);
    expect(errHtml).toContain('Microsoft Sign-In Not Configured in This Build');
    // Developer diagnostics remain tucked inside a separate <details> element
    expect(errHtml).toContain('View developer diagnostics');
    // Offline account creation remains available when Microsoft OAuth is unconfigured.
    expect(errHtml).toContain('Add Offline Account');

    coord.authService.cancelActiveAuthFlow();
    expect(coord.getSnapshot().authFlow?.mode).toBe('idle');

    coord.shutdownCleanly();
  });

  it('3. supports separate development vs production OAuth build-time configurations and VESPERA_MSA_CLIENT_ID', () => {
    const fakeProj = makeTempDir();
    fs.mkdirSync(path.join(fakeProj, 'config'), { recursive: true });
    const devUuid = '11111111-2222-4333-8444-555555555555';
    const prodUuid = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
    const envUuid = '99999999-8888-4777-a666-555555555555';

    fs.writeFileSync(
      path.join(fakeProj, 'config/oauth.development.json'),
      JSON.stringify({ clientId: devUuid, tenant: 'consumers', loopbackHost: 'localhost' })
    );
    fs.writeFileSync(
      path.join(fakeProj, 'config/oauth.release.json'),
      JSON.stringify({ clientId: prodUuid, tenant: 'consumers', loopbackHost: 'localhost' })
    );

    const devResolved = resolveBuildTimeOAuthConfig(fakeProj, 'development');
    expect(devResolved.configured).toBe(true);
    expect(devResolved.clientId).toBe(devUuid);
    expect(devResolved.source).toBe('development_config');
    expect(devResolved.loopbackHost).toBe('localhost');
    expect(devResolved.loopbackRedirectPath).toBe('');

    const prodResolved = resolveBuildTimeOAuthConfig(fakeProj, 'production');
    expect(prodResolved.configured).toBe(true);
    expect(prodResolved.clientId).toBe(prodUuid);
    expect(prodResolved.source).toBe('release_config');

    process.env.VESPERA_MSA_CLIENT_ID = envUuid;
    const envResolved = resolveBuildTimeOAuthConfig(fakeProj, 'production');
    expect(envResolved.clientId).toBe(envUuid);
    expect(envResolved.source).toBe('env_override');
  });

  it('4. launches the system default browser to official login.microsoftonline.com with http://localhost redirect + S256 PKCE, and handles browser launch failure', async () => {
    const vaultDir = makeTempDir();
    const clientId = '3f7e8a12-4b9c-4d1e-9a2b-8c7d6e5f4a3b';
    const launchedUrls: string[] = [];

    const auth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'release_config' },
      openSystemBrowser: true,
      browserLauncher: async (url) => {
        launchedUrls.push(url);
        return true;
      },
    });

    const flow = await auth.startBrowserPkceSignIn();
    expect(launchedUrls).toHaveLength(1);
    expect(launchedUrls[0].startsWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?')).toBe(true);
    expect(flow.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    expect(flow.browserOpened).toBe(true);
    expect(flow.step).toBe('waiting_for_login');

    const parsedUrl = new URL(launchedUrls[0]);
    expect(parsedUrl.searchParams.get('client_id')).toBe(clientId);
    expect(parsedUrl.searchParams.get('response_type')).toBe('code');
    expect(parsedUrl.searchParams.get('redirect_uri')).toBe(flow.redirectUri);
    expect(parsedUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsedUrl.searchParams.get('scope')).toBe('XboxLive.signin offline_access');
    auth.cancelActiveAuthFlow();

    // Test browser launch failure handling
    const failingBrowserAuth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'release_config' },
      openSystemBrowser: true,
      browserLauncher: () => false,
    });
    await expect(failingBrowserAuth.startBrowserPkceSignIn()).rejects.toThrow(
      /could not automatically open your default web browser/i
    );
    expect(failingBrowserAuth.getAuthFlowState().errorCode).toBe('browser_launch_failed');
  });

  it('5. renders all 6 live authentication progress steps, verifies PKCE code_verifier == SHA256(challenge), ignores /favicon.ico, and blocks code replay', async () => {
    const dataDir = makeTempDir();
    const clientId = '3f7e8a12-4b9c-4d1e-9a2b-8c7d6e5f4a3b';
    const observedSteps: string[] = [];
    let capturedVerifier = '';

    let coord!: VesperaStateCoordinator;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const stepNow = coord.authService.getAuthFlowState().step;
      if (stepNow) observedSteps.push(stepNow);

      if (url.endsWith('/oauth2/v2.0/token')) {
        const params = new URLSearchParams(String(init?.body || ''));
        capturedVerifier = params.get('code_verifier') || '';
        return new Response(
          JSON.stringify({
            access_token: 'secret_msa_access_tok_999999999999',
            refresh_token: 'secret_msa_refresh_tok_999999999999',
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }
      if (url === 'https://user.auth.xboxlive.com/user/authenticate') {
        return new Response(
          JSON.stringify({ Token: 'xbl_tok', DisplayClaims: { xui: [{ uhs: 'uhs_1' }] } }),
          { status: 200 }
        );
      }
      if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
        return new Response(
          JSON.stringify({ Token: 'xsts_tok', DisplayClaims: { xui: [{ xid: 'xuid_1' }] } }),
          { status: 200 }
        );
      }
      if (url === 'https://api.minecraftservices.com/authentication/login_with_xbox') {
        return new Response(
          JSON.stringify({ access_token: 'secret_mc_jwt_tok_999999999999', expires_in: 86400 }),
          { status: 200 }
        );
      }
      if (url === 'https://api.minecraftservices.com/entitlements/mcstore') {
        return new Response(
          JSON.stringify({ items: [{ name: 'product_minecraft' }, { name: 'game_minecraft' }] }),
          { status: 200 }
        );
      }
      if (url === 'https://api.minecraftservices.com/minecraft/profile') {
        return new Response(
          JSON.stringify({
            id: '0123456789abcdef0123456789abcdef',
            name: 'LunarGradeUser',
            skins: [{ state: 'ACTIVE', url: 'https://textures.minecraft.net/texture/123' }],
          }),
          { status: 200 }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    coord = new VesperaStateCoordinator(dataDir, {
      authOptions: {
        oauthConfigOverride: { clientId, configured: true, source: 'release_config' },
        fetchImpl: mockFetch,
        openSystemBrowser: false,
      },
    });

    const flow = await coord.authService.startBrowserPkceSignIn();
    const progressHtml = renderAccountsPage(coord.getSnapshot(), null);
    expect(progressHtml).toContain('Opening Microsoft login...');
    expect(progressHtml).toContain('Waiting for authentication...');
    expect(progressHtml).toContain('Verifying Microsoft account...');
    expect(progressHtml).toContain('Connecting to Xbox services...');
    expect(progressHtml).toContain('Checking Minecraft ownership...');
    expect(progressHtml).toContain('Retrieving Minecraft profile...');
    expect(progressHtml).toContain('id="btn-cancel-auth-flow"');

    // Non-GET must return 405 without killing the listener
    const postRes = await fetch(flow.redirectUri!, { method: 'POST' });
    expect(postRes.status).toBe(405);

    // Browser /favicon.ico request must return 204 without killing the listener
    const favRes = await fetch(`${flow.redirectUri}/favicon.ico`);
    expect(favRes.status).toBe(204);

    const authUrl = new URL(flow.authorizeUrl!);
    const state = authUrl.searchParams.get('state')!;
    const expectedChallenge = authUrl.searchParams.get('code_challenge')!;

    // Complete real HTTP loopback redirect to http://localhost:<port>/?code=...&state=...
    const cbRes = await fetch(`${flow.redirectUri}/?code=one_time_auth_code_777&state=${state}`);
    expect(cbRes.status).toBe(200);

    // Cryptographically prove PKCE S256 verifier matches challenge
    expect(sha256Base64Url(capturedVerifier)).toBe(expectedChallenge);

    // Verify all progression milestones executed in order
    expect(observedSteps).toContain('verifying_microsoft');
    expect(observedSteps).toContain('connecting_xbox');
    expect(observedSteps).toContain('checking_ownership');
    expect(observedSteps).toContain('retrieving_profile');

    // Verify account connected & progress card closed automatically
    const afterSnap = coord.getSnapshot();
    expect(afterSnap.authFlow?.mode).toBe('completed');
    expect(afterSnap.accounts).toHaveLength(1);
    expect(afterSnap.accounts[0].username).toBe('LunarGradeUser');

    const connectedHtml = renderAccountsPage(afterSnap, null);
    expect(connectedHtml).not.toContain('id="auth-progress-panel"');
    expect(connectedHtml).toContain('LunarGradeUser');
    expect(connectedHtml).toContain('Authenticated');
    expect(connectedHtml).not.toContain('secret_mc_jwt_tok_999999999999');

    // Replay protection: trying to reuse the exact same authorization code in a new session must be blocked!
    const flowReplay = await coord.authService.startBrowserPkceSignIn();
    const stateReplay = new URL(flowReplay.authorizeUrl!).searchParams.get('state')!;
    const replayRes = await fetch(
      `${flowReplay.redirectUri}/?code=one_time_auth_code_777&state=${stateReplay}`
    );
    expect(replayRes.status).toBe(400);
    expect(coord.authService.getAuthFlowState().errorCode).toBe('invalid_callback');

    coord.shutdownCleanly();
  });

  it('6. handles callback timeout, browser cancellation, XSTS Gamertag error, and missing Java profile cleanly', async () => {
    const vaultDir = makeTempDir();
    const clientId = '3f7e8a12-4b9c-4d1e-9a2b-8c7d6e5f4a3b';

    // A. Callback timeout test (120ms timeout)
    const timeoutAuth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'release_config' },
      openSystemBrowser: false,
      pkceTimeoutMs: 120,
    });
    await timeoutAuth.startBrowserPkceSignIn();
    await new Promise((r) => setTimeout(r, 220));
    expect(timeoutAuth.getAuthFlowState().mode).toBe('error');
    expect(timeoutAuth.getAuthFlowState().errorCode).toBe('callback_timeout');

    // B. Browser access_denied cancellation returns cleanly without crashing
    const cancelAuth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'release_config' },
      openSystemBrowser: false,
    });
    const cFlow = await cancelAuth.startBrowserPkceSignIn();
    const cState = new URL(cFlow.authorizeUrl!).searchParams.get('state')!;
    const cRes = await fetch(`${cFlow.redirectUri}/?error=access_denied&state=${cState}`);
    expect(cRes.status).toBe(400);
    expect(cancelAuth.getAuthFlowState().mode).toBe('cancelled');
    expect(cancelAuth.getAuthFlowState().errorCode).toBe('user_cancelled');

    // C. XSTS XErr 2148916233 (No Xbox profile / Gamertag yet)
    const xstsAuth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'release_config' },
      openSystemBrowser: false,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/token')) {
          return new Response(JSON.stringify({ access_token: 'ms_tok' }), { status: 200 });
        }
        if (url.includes('user.auth.xboxlive.com')) {
          return new Response(
            JSON.stringify({ Token: 'xbl', DisplayClaims: { xui: [{ uhs: 'u1' }] } }),
            { status: 200 }
          );
        }
        if (url.includes('xsts.auth.xboxlive.com')) {
          return new Response(JSON.stringify({ XErr: 2148916233 }), { status: 401 });
        }
        return new Response('{}', { status: 404 });
      },
    });
    const xFlow = await xstsAuth.startBrowserPkceSignIn();
    const xState = new URL(xFlow.authorizeUrl!).searchParams.get('state')!;
    await fetch(`${xFlow.redirectUri}/?code=code_xsts_1&state=${xState}`);
    expect(xstsAuth.getAuthFlowState().errorCode).toBe('xsts_auth_failed');
    expect(xstsAuth.getAuthFlowState().message).toContain('xbox.com');

    // D. Owns entitlement, but no Minecraft Java username created yet (HTTP 404 on /minecraft/profile)
    const noProfAuth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'release_config' },
      openSystemBrowser: false,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/token')) {
          return new Response(JSON.stringify({ access_token: 'ms_tok' }), { status: 200 });
        }
        if (url.includes('user.auth.xboxlive.com')) {
          return new Response(
            JSON.stringify({ Token: 'xbl', DisplayClaims: { xui: [{ uhs: 'u1' }] } }),
            { status: 200 }
          );
        }
        if (url.includes('xsts.auth.xboxlive.com')) {
          return new Response(JSON.stringify({ Token: 'xsts' }), { status: 200 });
        }
        if (url.includes('login_with_xbox')) {
          return new Response(JSON.stringify({ access_token: 'mc_tok', expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url.includes('entitlements/mcstore')) {
          return new Response(JSON.stringify({ items: [{ name: 'game_minecraft' }] }), {
            status: 200,
          });
        }
        if (url.includes('minecraft/profile')) {
          return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
        }
        return new Response('{}', { status: 404 });
      },
    });
    const pFlow = await noProfAuth.startBrowserPkceSignIn();
    const pState = new URL(pFlow.authorizeUrl!).searchParams.get('state')!;
    await fetch(`${pFlow.redirectUri}/?code=code_noprof_1&state=${pState}`);
    expect(noProfAuth.getAuthFlowState().errorCode).toBe('no_minecraft_profile');
    expect(noProfAuth.listAccounts()).toHaveLength(0);
  });
});
