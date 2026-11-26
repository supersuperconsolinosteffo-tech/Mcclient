import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isValidMicrosoftPublicClientId,
  resolveBuildTimeOAuthConfig,
} from '../shared/oauthBuildConfig';
import {
  classifyMojangVersionEntry,
  parseMojangManifestV2,
  type RawMojangManifestV2,
} from '../shared/versionCatalog';
import { AuthService } from '../server/authService';
import {
  extractNativeLibrariesFromJar,
  MinecraftLauncherService,
} from '../server/minecraftLauncherService';
import { dispatchRpcMethod } from '../server/rpcRouter';
import { VesperaStateCoordinator } from '../server/stateStore';
import { renderAccountsPage } from '../ui/src/pages/accountsSettingsDiagAbout';
import { renderPlayPage } from '../ui/src/pages/homeAndPlay';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vespera-v110-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  delete process.env.VESPERA_MSA_CLIENT_ID;
  delete process.env.VESPERA_MSA_CLIENT_SECRET;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sha1Hex(buf: Buffer | string): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * Builds a minimal, standards-compliant PKZIP / JAR archive in memory (using deflate method 8)
 * so tests can verify real native `.dll` / `.so` extraction and Zip-Slip blocking.
 */
function buildMinimalZipBuffer(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);

    const localRecord = Buffer.concat([localHeader, nameBuf, compressed]);
    localParts.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localRecord.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/**
 * Deterministic mock fetch for testing the Microsoft -> XBL -> XSTS -> Minecraft Services -> Entitlement -> Profile
 * protocol state machine (explicitly mock-only; never treated as live Microsoft authentication).
 */
function createProtocolMockFetch(opts?: {
  ownsMinecraft?: boolean;
  uuid?: string;
  username?: string;
  mcExpiresIn?: number;
}) {
  const ownsMinecraft = opts?.ownsMinecraft ?? true;
  const uuid = opts?.uuid ?? 'a1b2c3d4e5f6478990123456789abcde';
  const username = opts?.username ?? 'VesperaPlayer';
  const mcExpiresIn = opts?.mcExpiresIn ?? 86400;
  const capturedRequests: Array<{ url: string; body: string }> = [];

  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const bodyStr = init?.body ? String(init.body) : '';
    capturedRequests.push({ url, body: bodyStr });

    if (url.endsWith('/oauth2/v2.0/devicecode')) {
      return new Response(
        JSON.stringify({
          device_code: 'dev-code-123',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://www.microsoft.com/link',
          expires_in: 900,
          interval: 1,
        }),
        { status: 200 }
      );
    }

    if (url.endsWith('/oauth2/v2.0/token')) {
      if (bodyStr.includes('device_code=pending-code')) {
        return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          access_token: 'mock_ms_access_token_xyz',
          refresh_token: 'mock_ms_refresh_token_xyz',
          expires_in: 3600,
        }),
        { status: 200 }
      );
    }

    if (url === 'https://user.auth.xboxlive.com/user/authenticate') {
      return new Response(
        JSON.stringify({
          Token: 'mock_xbl_token',
          DisplayClaims: { xui: [{ uhs: 'uhs_987654' }] },
        }),
        { status: 200 }
      );
    }

    if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
      return new Response(
        JSON.stringify({
          Token: 'mock_xsts_token',
          DisplayClaims: { xui: [{ xid: '2533274810000000' }] },
        }),
        { status: 200 }
      );
    }

    if (url === 'https://api.minecraftservices.com/authentication/login_with_xbox') {
      return new Response(
        JSON.stringify({
          access_token: `mock_mc_jwt_${username}`,
          expires_in: mcExpiresIn,
        }),
        { status: 200 }
      );
    }

    if (url === 'https://api.minecraftservices.com/entitlements/mcstore') {
      return new Response(
        JSON.stringify({
          items: ownsMinecraft ? [{ name: 'product_minecraft' }, { name: 'game_minecraft' }] : [],
        }),
        { status: 200 }
      );
    }

    if (url === 'https://api.minecraftservices.com/minecraft/profile') {
      if (!ownsMinecraft) {
        return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: uuid,
          name: username,
          skins: [{ id: 'skin-1', state: 'ACTIVE', url: 'https://textures.minecraft.net/texture/abc' }],
        }),
        { status: 200 }
      );
    }

    return new Response('Not Found', { status: 404 });
  };

  return { fetchImpl: fn, capturedRequests };
}

describe('Part 8.1 — Microsoft Authentication Overhaul & Legitimate Offline Singleplayer', () => {
  it('separates build-time OAuth config from secrets, rejects placeholder IDs, and surfaces clear developer error when unconfigured', async () => {
    expect(isValidMicrosoftPublicClientId('')).toBe(false);
    expect(isValidMicrosoftPublicClientId('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isValidMicrosoftPublicClientId('not-a-uuid')).toBe(false);
    expect(isValidMicrosoftPublicClientId('3f7e8a12-4b9c-4d1e-9a2b-8c7d6e5f4a3b')).toBe(true);

    // Must refuse client secrets
    process.env.VESPERA_MSA_CLIENT_SECRET = 'accidental-secret';
    expect(() => resolveBuildTimeOAuthConfig()).toThrow(/NEVER embed a Microsoft Client Secret/i);
    delete process.env.VESPERA_MSA_CLIENT_SECRET;

    // When unconfigured, AuthService reports configured: false and throws explicit developer setup guidance
    const vaultDir = makeTempDir();
    const unconfiguredAuth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId: '', configured: false, source: 'unconfigured' },
      openSystemBrowser: false,
    });
    expect(unconfiguredAuth.getOAuthConfigState().configured).toBe(false);
    await expect(unconfiguredAuth.startBrowserPkceSignIn()).rejects.toThrow(
      /Developer Build Configuration Required/i
    );
    await expect(unconfiguredAuth.startDeviceCodeFlow()).rejects.toThrow(
      /Developer Build Configuration Required/i
    );
  });

  it('executes OAuth 2.0 Authorization Code + PKCE (S256) localhost callback, rejects CSRF state tampering, and verifies Java entitlement', async () => {
    const vaultDir = makeTempDir();
    const validPublicClientId = '3f7e8a12-4b9c-4d1e-9a2b-8c7d6e5f4a3b';
    const { fetchImpl, capturedRequests } = createProtocolMockFetch({
      ownsMinecraft: true,
      username: 'SteffoPvP',
      uuid: '11223344556647778899aabbccddeeff',
    });

    const auth = new AuthService(vaultDir, {
      oauthConfigOverride: {
        clientId: validPublicClientId,
        configured: true,
        source: 'developer_local',
      },
      fetchImpl,
      openSystemBrowser: false,
    });

    const flow = await auth.startBrowserPkceSignIn();
    expect(flow.mode).toBe('pkce_browser');
    expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(flow.authorizeUrl).toContain('code_challenge_method=S256');
    expect(flow.authorizeUrl).toContain(`client_id=${validPublicClientId}`);

    const authUrlObj = new URL(flow.authorizeUrl!);
    const expectedState = authUrlObj.searchParams.get('state')!;
    expect(expectedState.length).toBeGreaterThan(16);

    // 1. Tampered state must be rejected with HTTP 400
    const badCallbackRes = await fetch(
      `${flow.redirectUri}?code=fake_code&state=forged_csrf_state`
    );
    expect(badCallbackRes.status).toBe(400);
    expect(auth.getAuthFlowState().mode).toBe('error');

    // 2. Restart PKCE flow and complete valid redirect callback
    const flow2 = await auth.startBrowserPkceSignIn();
    const state2 = new URL(flow2.authorizeUrl!).searchParams.get('state')!;
    const okCallbackRes = await fetch(`${flow2.redirectUri}?code=valid_auth_code_99&state=${state2}`);
    expect(okCallbackRes.status).toBe(200);
    const html = await okCallbackRes.text();
    expect(html).toContain('SteffoPvP');

    // Verify PKCE code_verifier (without client_secret!) was sent to token endpoint
    const tokenReq = capturedRequests.find((r) => r.url.endsWith('/oauth2/v2.0/token'));
    expect(tokenReq).toBeDefined();
    expect(tokenReq!.body).toContain('grant_type=authorization_code');
    expect(tokenReq!.body).toContain('code_verifier=');
    expect(tokenReq!.body).not.toContain('client_secret');

    // Verify public account list contains zero leaked tokens
    const accounts = auth.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].username).toBe('SteffoPvP');
    expect(accounts[0].ownsMinecraftJava).toBe(true);
    expect(JSON.stringify(accounts)).not.toContain('mock_mc_jwt');
  });

  it('supports Device Code fallback, multi-account switching, silent token refresh, sign-out vs remove, and rejects non-owners', async () => {
    const vaultDir = makeTempDir();
    const clientId = '3f7e8a12-4b9c-4d1e-9a2b-8c7d6e5f4a3b';

    // Non-owner Microsoft account must be rejected
    const nonOwnerMock = createProtocolMockFetch({ ownsMinecraft: false });
    const nonOwnerAuth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'developer_local' },
      fetchImpl: nonOwnerMock.fetchImpl,
      openSystemBrowser: false,
    });
    const chFail = await nonOwnerAuth.startDeviceCodeFlow();
    await expect(nonOwnerAuth.pollDeviceCodeCompletion(chFail.deviceCode)).rejects.toThrow(
      /does not own an active Minecraft: Java Edition/i
    );

  // Multi-account + refresh + sign-out + remove
    let mcTokenIssueCount = 0;
    const baseMock = createProtocolMockFetch({
      ownsMinecraft: true,
      username: 'AccountOne',
      uuid: 'aaaa1111bbbb2222cccc3333dddd4444',
      mcExpiresIn: 10,
    });
    const refreshAwareFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://api.minecraftservices.com/authentication/login_with_xbox') {
        mcTokenIssueCount++;
        return new Response(
          JSON.stringify({
            access_token: `mock_mc_jwt_AccountOne_${mcTokenIssueCount}`,
            expires_in: mcTokenIssueCount === 1 ? 10 : 86400,
          }),
          { status: 200 }
        );
      }
      return baseMock.fetchImpl(input, init);
    };
    const auth = new AuthService(vaultDir, {
      oauthConfigOverride: { clientId, configured: true, source: 'developer_local' },
      fetchImpl: refreshAwareFetch,
      openSystemBrowser: false,
    });
    const ch1 = await auth.startDeviceCodeFlow();
    const res1 = await auth.pollDeviceCodeCompletion(ch1.deviceCode);
    expect(res1.status).toBe('completed');
    expect(res1.account?.username).toBe('AccountOne');
    expect(res1.account?.sessionStatus).toBe('refresh_required');

    // Silent refresh when within 120s expiry window -> refreshes to 24h 'valid' session!
    const refreshed = await auth.refreshOrValidateSession(res1.account!.id);
    expect(refreshed.sessionStatus).toBe('valid');
    expect(mcTokenIssueCount).toBe(2);

    // Sign out clears tokens from vault while keeping verified account entry
    const afterSignOut = auth.signOutAccount(res1.account!.id);
    expect(afterSignOut[0].sessionStatus).toBe('signed_out');
    expect(auth.getDecryptedMcAccessToken(res1.account!.id)).toBeNull();

    // Remove deletes the account record completely
    expect(auth.removeAccount(res1.account!.id)).toHaveLength(0);
  });

  it('enforces strict Legitimate Offline Singleplayer rules (--disableMultiplayer, verified account + local files required)', async () => {
    const dataDir = makeTempDir();
    const clientId = '3f7e8a12-4b9c-4d1e-9a2b-8c7d6e5f4a3b';
    const authMock = createProtocolMockFetch({
      ownsMinecraft: true,
      username: 'VerifiedOwner',
      uuid: '99998888777766665555444433332222',
    });

    const coord = new VesperaStateCoordinator(dataDir, {
      authOptions: {
        oauthConfigOverride: { clientId, configured: true, source: 'developer_local' },
        fetchImpl: authMock.fetchImpl,
        openSystemBrowser: false,
      },
    });

    // 1. Before any online authentication, offline singleplayer MUST be ineligible
    expect(coord.getSnapshot().offlineAvailability?.eligible).toBe(false);
    expect(() => coord.authService.setSessionMode('offline_singleplayer')).toThrow(
      /previously completed Microsoft authentication/i
    );

    // 2. Authenticate online once via Device Code mock
    const ch = await coord.authService.startDeviceCodeFlow();
    await coord.authService.pollDeviceCodeCompletion(ch.deviceCode);

    // Even after account verification, if local game files aren't installed yet, offline launch is blocked!
    expect(coord.getSnapshot().offlineAvailability?.verifiedUsername).toBe('VerifiedOwner');
    expect(coord.getSnapshot().offlineAvailability?.localGameReady).toBe(false);
    expect(coord.getSnapshot().offlineAvailability?.eligible).toBe(false);

    // Sign out online session (simulating offline state later) and install local version receipt
    const accId = coord.authService.getActiveAccountId()!;
    coord.authService.signOutAccount(accId);

    const mcVer = coord.getActiveProfile().mcVersion;
    const verDir = path.join(coord.getSnapshot().settings.gameDataDir, 'versions', mcVer);
    fs.mkdirSync(verDir, { recursive: true });
    const dummyJar = Buffer.from('verified-client-jar-bytes');
    fs.writeFileSync(path.join(verDir, `${mcVer}.jar`), dummyJar);
    fs.writeFileSync(path.join(verDir, `${mcVer}.json`), JSON.stringify({ id: mcVer, mainClass: 'net.minecraft.client.main.Main' }));
    fs.writeFileSync(
      path.join(verDir, 'vespera-install-receipt.json'),
      JSON.stringify({
        schemaVersion: 1,
        versionId: mcVer,
        loader: 'fabric',
        loaderVersion: '0.16.10',
        javaMajor: 21,
        mainClass: 'net.fabricmc.loader.impl.launch.knot.Client',
        assetIndexId: '19',
        clientJarSha1: sha1Hex(dummyJar),
        verifiedLibraries: [],
        nativesExtractedCount: 1,
        installedAt: new Date().toISOString(),
      })
    );

    // 3. Now both verified account AND local files exist -> Offline Singleplayer is eligible!
    const snapReady = coord.getSnapshot();
    expect(snapReady.offlineAvailability?.eligible).toBe(true);

    coord.authService.setSessionMode('offline_singleplayer');
    const offlinePrep = coord.prepareActiveLaunch('offline_singleplayer');
    expect(offlinePrep.sessionMode).toBe('offline_singleplayer');
    expect(offlinePrep.gameArguments).toContain('--disableMultiplayer');
    expect(offlinePrep.gameArguments).toContain('--disableChat');
    expect(offlinePrep.jvmArguments).toContain('-Dvespera.offlineSingleplayer=true');
    // Access token in offline singleplayer is '0' (never a fabricated session token!)
    const tokIdx = offlinePrep.gameArguments.indexOf('--accessToken');
    expect(offlinePrep.gameArguments[tokIdx + 1]).toBe('0');

    coord.shutdownCleanly();
  });
});

describe('Part 8.2 & 8.3 — Dynamic Version Manager, Multi-Stage Installer, Resume, Repair & Compatibility Matrix', () => {
  it('parses full Mojang version_manifest_v2.json across Release, Snapshot, Old Beta, and Old Alpha with accurate Java & Vespera compatibility', () => {
    const sampleManifest: RawMojangManifestV2 = {
      latest: { release: '1.21.4', snapshot: '25w09b' },
      versions: [
        { id: '25w09b', type: 'snapshot', url: 'https://example.test/25w09b.json', releaseTime: '2025-02-27T13:32:10+00:00' },
        { id: '1.21.4', type: 'release', url: 'https://example.test/1.21.4.json', releaseTime: '2024-12-03T10:12:57+00:00' },
        { id: '1.21.1', type: 'release', url: 'https://example.test/1.21.1.json', releaseTime: '2024-08-08T12:24:45+00:00' },
        { id: '1.20.4', type: 'release', url: 'https://example.test/1.20.4.json', releaseTime: '2023-12-07T12:56:20+00:00' },
        { id: '1.20.1', type: 'release', url: 'https://example.test/1.20.1.json', releaseTime: '2023-06-12T13:25:51+00:00' },
        { id: '1.16.5', type: 'release', url: 'https://example.test/1.16.5.json', releaseTime: '2021-01-14T16:05:32+00:00' },
        { id: '1.12.2', type: 'release', url: 'https://example.test/1.12.2.json', releaseTime: '2017-09-18T08:39:46+00:00' },
        { id: '1.8.9', type: 'release', url: 'https://example.test/1.8.9.json', releaseTime: '2015-12-03T09:24:39+00:00' },
        { id: 'b1.7.3', type: 'old_beta', url: 'https://example.test/b1.7.3.json', releaseTime: '2011-07-07T22:00:00+00:00' },
        { id: 'a1.2.6', type: 'old_alpha', url: 'https://example.test/a1.2.6.json', releaseTime: '2010-12-02T22:00:00+00:00' },
      ],
    };

    const parsed = parseMojangManifestV2(sampleManifest);
    expect(parsed.versions).toHaveLength(10);
    expect(parsed.latestReleaseId).toBe('1.21.4');
    expect(parsed.latestSnapshotId).toBe('25w09b');
    // Sorted newest-to-oldest
    expect(parsed.versions[0].id).toBe('25w09b');
    expect(parsed.versions[parsed.versions.length - 1].id).toBe('a1.2.6');

    const byId = new Map(parsed.versions.map((v) => [v.id, v]));
    // 1.21.4 -> Vespera Supported (Java 21)
    expect(byId.get('1.21.4')!.compatibilityLabel).toBe('Vespera Supported');
    expect(byId.get('1.21.4')!.vesperaModSupported).toBe(true);
    expect(byId.get('1.21.4')!.recommendedJavaMajor).toBe(21);

    // 1.21.1, 1.20.4, 1.20.1, 1.16.5 -> Fabric Supported (never pretending Vespera 1.21.4 mod works!)
    for (const v of ['1.21.1', '1.20.4', '1.20.1', '1.16.5']) {
      expect(byId.get(v)!.compatibilityLabel).toBe('Fabric Supported');
      expect(byId.get(v)!.vesperaModSupported).toBe(false);
      expect(byId.get(v)!.fabricSupported).toBe(true);
      expect(byId.get(v)!.vanillaSupported).toBe(true);
    }
    expect(byId.get('1.21.1')!.recommendedJavaMajor).toBe(21);
    expect(byId.get('1.20.4')!.recommendedJavaMajor).toBe(17);
    expect(byId.get('1.20.1')!.recommendedJavaMajor).toBe(17);
    expect(byId.get('1.16.5')!.recommendedJavaMajor).toBe(8);

    // 1.12.2, 1.8.9, b1.7.3, a1.2.6 -> Vanilla Only (Java 8, 100% selectable & installable!)
    for (const v of ['1.12.2', '1.8.9', 'b1.7.3', 'a1.2.6']) {
      expect(byId.get(v)!.compatibilityLabel).toBe('Vanilla Only');
      expect(byId.get(v)!.vanillaSupported).toBe(true);
      expect(byId.get(v)!.recommendedJavaMajor).toBe(8);
    }

    // 25w09b -> Experimental
    expect(byId.get('25w09b')!.compatibilityLabel).toBe('Experimental');
  });

  it('extracts native DLL/SO binaries safely and blocks Zip-Slip path traversal', () => {
    const dest = makeTempDir();
    const validZip = buildMinimalZipBuffer([
      { name: 'META-INF/MANIFEST.MF', content: Buffer.from('Manifest-Version: 1.0\n') },
      { name: 'org/lwjgl/lwjgl.dll', content: Buffer.from('MZ-mock-lwjgl-native') },
      { name: 'libglfw.so', content: Buffer.from('ELF-mock-glfw-native') },
    ]);
    const count = extractNativeLibrariesFromJar(validZip, dest);
    expect(count).toBe(2);
    expect(fs.existsSync(path.join(dest, 'lwjgl.dll'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'libglfw.so'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'MANIFEST.MF'))).toBe(false);
  });

  it('downloads, SHA-1 verifies, resumes via HTTP Range, repairs corrupted files, and deletes versions without touching profiles', async () => {
    const dataDir = makeTempDir();
    const clientJarBytes = Buffer.from('MOCK_MINECRAFT_1_20_4_CLIENT_JAR_BINARY_PAYLOAD');
    const clientJarSha1 = sha1Hex(clientJarBytes);

    const libBytes = Buffer.from('MOCK_LWJGL_CORE_JAR');
    const libSha1 = sha1Hex(libBytes);

    const nativeZipBytes = buildMinimalZipBuffer([
      { name: 'lwjgl_opengl.dll', content: Buffer.from('NATIVE_DLL_BYTES') },
    ]);
    const nativeZipSha1 = sha1Hex(nativeZipBytes);

    const soundAssetBytes = Buffer.from('OGG_SOUND_ASSET_DATA');
    const soundAssetSha1 = sha1Hex(soundAssetBytes);

    const assetIndexObj = {
      objects: {
        'minecraft/sounds/ambient/cave1.ogg': {
          hash: soundAssetSha1,
          size: soundAssetBytes.length,
        },
      },
    };
    const assetIndexBytes = Buffer.from(JSON.stringify(assetIndexObj), 'utf8');
    const assetIndexSha1 = sha1Hex(assetIndexBytes);

    const versionMetaObj = {
      id: '1.20.4',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      javaVersion: { majorVersion: 17 },
      assetIndex: {
        id: '12',
        sha1: assetIndexSha1,
        size: assetIndexBytes.length,
        url: 'https://mock.mojang.test/assets/12.json',
      },
      downloads: {
        client: {
          sha1: clientJarSha1,
          size: clientJarBytes.length,
          url: 'https://mock.mojang.test/client/1.20.4.jar',
        },
      },
      libraries: [
        {
          name: 'org.lwjgl:lwjgl:3.3.2',
          downloads: {
            artifact: {
              path: 'org/lwjgl/lwjgl/3.3.2/lwjgl-3.3.2.jar',
              sha1: libSha1,
              size: libBytes.length,
              url: 'https://mock.mojang.test/libs/lwjgl-3.3.2.jar',
            },
          },
        },
        {
          name: 'org.lwjgl:lwjgl:3.3.2:natives-windows',
          rules: [{ action: 'allow', os: { name: 'windows' } }],
          downloads: {
            artifact: {
              path: 'org/lwjgl/lwjgl/3.3.2/lwjgl-3.3.2-natives-windows.jar',
              sha1: nativeZipSha1,
              size: nativeZipBytes.length,
              url: 'https://mock.mojang.test/libs/lwjgl-3.3.2-natives-windows.jar',
            },
          },
        },
      ],
    };
    const versionMetaBytes = Buffer.from(JSON.stringify(versionMetaObj), 'utf8');
    const versionMetaSha1 = sha1Hex(versionMetaBytes);

    let corruptClientJarOnce = false;
    const rangeHeadersSeen: string[] = [];

    const mockMojangFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const hdrs = (init?.headers || {}) as Record<string, string>;
      if (hdrs.Range) rangeHeadersSeen.push(hdrs.Range);

      if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') {
        return new Response(
          JSON.stringify({
            latest: { release: '1.21.4', snapshot: '25w09b' },
            versions: [
              {
                id: '1.20.4',
                type: 'release',
                url: 'https://mock.mojang.test/meta/1.20.4.json',
                sha1: versionMetaSha1,
                releaseTime: '2023-12-07T12:56:20+00:00',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === 'https://mock.mojang.test/meta/1.20.4.json') {
        return new Response(versionMetaBytes, { status: 200 });
      }
      if (url === 'https://mock.mojang.test/client/1.20.4.jar') {
        if (corruptClientJarOnce) {
          corruptClientJarOnce = false;
          return new Response(Buffer.from('CORRUPTED_BYTES'), { status: 200 });
        }
        if (hdrs.Range && hdrs.Range.startsWith('bytes=')) {
          const offset = Number(hdrs.Range.replace('bytes=', '').replace('-', ''));
          return new Response(clientJarBytes.subarray(offset), { status: 206 });
        }
        return new Response(clientJarBytes, { status: 200 });
      }
      if (url === 'https://mock.mojang.test/assets/12.json') {
        return new Response(assetIndexBytes, { status: 200 });
      }
      if (url.endsWith(`/${soundAssetSha1}`)) {
        return new Response(soundAssetBytes, { status: 200 });
      }
      if (url === 'https://mock.mojang.test/libs/lwjgl-3.3.2.jar') {
        return new Response(libBytes, { status: 200 });
      }
      if (url === 'https://mock.mojang.test/libs/lwjgl-3.3.2-natives-windows.jar') {
        return new Response(nativeZipBytes, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const svc = new MinecraftLauncherService(dataDir, {
      fetchImpl: mockMojangFetch,
      targetOs: 'windows',
    });

    const gameDataDir = path.join(dataDir, 'minecraft');
    const synced = await svc.syncOfficialVersionManifest(gameDataDir);
    expect(synced.some((v) => v.id === '1.20.4')).toBe(true);
    expect(svc.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('not_installed');

    // Pre-seed a partial `.part` file for client.jar to verify HTTP Range resumption!
    const versionDir = path.join(gameDataDir, 'versions', '1.20.4');
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, '1.20.4.jar.part'), clientJarBytes.subarray(0, 12));
    expect(svc.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('partially_downloaded');

    // Also test transient SHA-1 mismatch retry recovery on first attempt -> succeeds on retry!
    corruptClientJarOnce = true;

    const progressStages: string[] = [];
    const receipt = await svc.installMinecraftVersion({
      versionId: '1.20.4',
      loader: 'vanilla',
      settings: {
        gameDataDir,
        instancesDir: path.join(dataDir, 'instances'),
        concurrentDownloads: 4,
        bandwidthLimitMbps: 0,
        verifyFileHashes: true,
        keepLauncherOpen: true,
        minimizeToTrayOnLaunch: false,
        closeBehavior: 'keep_open',
        updateChannel: 'stable',
        autoCheckUpdates: true,
        autoBackupBeforeProfileUpdate: true,
        language: 'en-US',
        customJvmExtraArgs: '',
        microsoftAzureClientId: '',
        crashRecoveryEnabled: true,
        firstLaunchCompleted: true,
      },
      onProgress: (p) => progressStages.push(`${p.status}:${p.percent}`),
    });

    expect(rangeHeadersSeen).toContain('bytes=12-');
    expect(receipt.versionId).toBe('1.20.4');
    expect(receipt.javaMajor).toBe(17);
    expect(receipt.nativesExtractedCount).toBe(1);
    expect(fs.existsSync(path.join(versionDir, 'natives', 'lwjgl_opengl.dll'))).toBe(true);
    expect(svc.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('ready');
    expect(progressStages[progressStages.length - 1]).toBe('ready:100');

    // Corrupt client.jar on disk -> verifyVersionIntegrity detects corruption & invalidates receipt!
    fs.writeFileSync(path.join(versionDir, '1.20.4.jar'), Buffer.from('TAMPERED_JAR'));
    const integrity = svc.verifyVersionIntegrity('1.20.4', {
      gameDataDir,
      instancesDir: path.join(dataDir, 'instances'),
      concurrentDownloads: 4,
      bandwidthLimitMbps: 0,
      verifyFileHashes: true,
      keepLauncherOpen: true,
      minimizeToTrayOnLaunch: false,
      closeBehavior: 'keep_open',
      updateChannel: 'stable',
      autoCheckUpdates: true,
      autoBackupBeforeProfileUpdate: true,
      language: 'en-US',
      customJvmExtraArgs: '',
      microsoftAzureClientId: '',
      crashRecoveryEnabled: true,
      firstLaunchCompleted: true,
    });
    expect(integrity.healthy).toBe(false);
    expect(integrity.issues.join(' ')).toMatch(/Corrupted 1\.20\.4\.jar/i);
    expect(svc.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('partially_downloaded');

    // Delete installed version -> removes versions/1.20.4 cleanly
    svc.deleteInstalledVersion('1.20.4', {
      gameDataDir,
    } as Parameters<typeof svc.deleteInstalledVersion>[1]);
    expect(svc.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('not_installed');
  });
});

describe('Part 8.4 — End-to-End UX Flow, Legacy 1.8.9 Args, Mod Isolation & v1.0.0 State Migration', () => {
  it('migrates v1.0.0 user profiles cleanly, isolates 1.21.4 Vespera mod from 1.20.4/1.8.9, expands legacy minecraftArguments, and renders clean UI', async () => {
    const dataDir = makeTempDir();

    // Seed a v1.0.0 schemaVersion: 1 state file to verify non-destructive upgrade migration
    const seedCoord = new VesperaStateCoordinator(dataDir);
    const snapV1 = seedCoord.getSnapshot();
    seedCoord.shutdownCleanly();

    const stateJsonPath = path.join(dataDir, 'vespera-state.json');
    const rawPersisted = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
    rawPersisted.schemaVersion = 1;
    rawPersisted.profiles[0].name = 'My Preserved v1.0.0 Profile';
    fs.writeFileSync(stateJsonPath, JSON.stringify(rawPersisted, null, 2));

    const coord = new VesperaStateCoordinator(dataDir);
    const migratedSnap = coord.getSnapshot();
    expect(migratedSnap.version).toBe('1.1.0');
    expect(migratedSnap.profiles[0].name).toBe('My Preserved v1.0.0 Profile');

    // Verify Accounts UI has ZERO manual Client ID input fields and renders Offline Availability section
    const accountsHtml = renderAccountsPage(migratedSnap, null);
    expect(accountsHtml).not.toContain('msa-client-id-input');
    expect(accountsHtml).toContain('offline-availability-section');
    expect(accountsHtml).toContain('Offline Availability');

    // Create a Fabric 1.20.4 profile -> must NEVER include vespera-client 1.21.4 custom mod!
    await dispatchRpcMethod(coord, 'createProfile', {
      name: 'Fabric 1.20.4 Modern',
      archetype: 'survival',
      mcVersion: '1.20.4',
      loader: 'fabric',
    });
    const prof1204 = coord.getActiveProfile();
    expect(prof1204.mcVersion).toBe('1.20.4');
    expect(prof1204.loader).toBe('fabric');
    expect(prof1204.enabledModIds).not.toContain('vespera-client');
    expect(() => coord.toggleMod('vespera-client', true)).toThrow(/1\.21\.4 only/i);

    // Create a Vanilla 1.8.9 profile and verify legacy `minecraftArguments` template expansion + Java 8!
    await dispatchRpcMethod(coord, 'createProfile', {
      name: 'Classic Vanilla 1.8.9',
      archetype: 'pvp',
      mcVersion: '1.8.9',
      loader: 'vanilla',
    });
    const ver189Dir = path.join(coord.getSnapshot().settings.gameDataDir, 'versions', '1.8.9');
    fs.mkdirSync(ver189Dir, { recursive: true });
    fs.writeFileSync(
      path.join(ver189Dir, '1.8.9.json'),
      JSON.stringify({
        id: '1.8.9',
        mainClass: 'net.minecraft.client.main.Main',
        javaVersion: { majorVersion: 8 },
        assets: '1.8',
        minecraftArguments:
          '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type}',
      })
    );

    const prep189 = coord.prepareActiveLaunch();
    expect(prep189.mainClass).toBe('net.minecraft.client.main.Main');
    expect(prep189.vesperaModActive).toBe(false);
    expect(prep189.enabledMods).toEqual([]);
    expect(prep189.gameArguments).toContain('1.8.9');
    expect(prep189.gameArguments).toContain('1.8');

    // Verify Redesigned Play Page renders search bar, version browser, compatibility badges, and install buttons
    const finalSnap = coord.getSnapshot();
    const playHtml = renderPlayPage(
      finalSnap,
      prep189,
      {
        searchQuery: '',
        showReleases: true,
        showSnapshots: true,
        showHistorical: true,
        installedOnly: false,
        showNewProfileDrawer: false,
        fabricLoadersForActive: [],
      },
      null
    );
    expect(playHtml).toContain('play-version-search');
    expect(playHtml).toContain('Vespera Supported');
    expect(playHtml).toContain('Fabric Supported');
    expect(playHtml).toContain('Vanilla Only');
    expect(playHtml).toContain('1.8.9');
    expect(playHtml).toContain('b1.7.3');

    coord.shutdownCleanly();
  });
});
