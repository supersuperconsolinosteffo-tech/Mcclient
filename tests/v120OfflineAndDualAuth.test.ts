import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyMultiplayerServerRejection, generateOfflineMinecraftUuid } from '../shared/offlineAccountUtils';
import { AuthService } from '../server/authService';
import { VesperaStateCoordinator } from '../server/stateStore';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vespera-v120-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeMicrosoftProtocolFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('user.auth.xboxlive.com/user/authenticate')) {
      return Response.json({ Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'user-hash' }] } });
    }
    if (url.includes('xsts.auth.xboxlive.com/xsts/authorize')) {
      return Response.json({ Token: 'xsts-token', DisplayClaims: { xui: [{ xid: '123456789' }] } });
    }
    if (url.includes('/authentication/login_with_xbox')) {
      return Response.json({ access_token: 'minecraft-access-token', expires_in: 3600 });
    }
    if (url.includes('/entitlements/mcstore')) {
      return Response.json({ items: [{ name: 'product_minecraft' }] });
    }
    if (url.includes('/minecraft/profile')) {
      return Response.json({ id: '0123456789abcdef0123456789abcdef', name: 'MicrosoftPlayer' });
    }
    throw new Error(`Unexpected Microsoft protocol URL: ${url}`);
  }) as typeof fetch;
}

function javaOfflineUuidReference(dataDir: string, usernames: string[]): string[] {
  const kotlinc = path.resolve(process.cwd(), 'node_modules/kotlin-compiler/bin/kotlinc');
  const javaHome = process.env.JAVA_HOME || path.resolve(
    process.cwd(), '.venv/lib/python3.11/site-packages/jdk4py/java-runtime'
  );
  const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const source = path.join(dataDir, 'OfflineUuidReference.kt');
  const jar = path.join(dataDir, 'offline-uuid-reference.jar');
  fs.writeFileSync(
    source,
    [
      'import java.util.UUID',
      'fun main(args: Array<String>) {',
      '  args.forEach { name ->',
      '    println(UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).toByteArray(Charsets.UTF_8)))',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  execFileSync(kotlinc, ['-jvm-target', '21', '-include-runtime', source, '-d', jar], {
    env: { ...process.env, JAVA_HOME: javaHome },
    stdio: 'pipe',
  });
  const output = execFileSync(java, ['-jar', jar, ...usernames], {
    encoding: 'utf8',
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  return output.trim().split(/\r?\n/);
}

describe('Vespera Client v1.2.0 — Offline Accounts & Dual Authentication', () => {
  it('creates distinct offline accounts and rejects invalid or duplicate usernames', () => {
    const auth = new AuthService(makeTempDir(), { openSystemBrowser: false });
    const first = auth.createOfflineAccount('Builder_One');
    const second = auth.createOfflineAccount('PixelCrafter');

    expect(first.accountType).toBe('offline');
    expect(first.authProvider).toBe('offline');
    expect(first.sessionStatus).toBe('offline_ready');
    expect(first.ownsMinecraftJava).toBe(false);
    expect(first.uuid).toBe(generateOfflineMinecraftUuid('Builder_One'));
    expect(second.uuid).not.toBe(first.uuid);
    expect(() => auth.createOfflineAccount('ab')).toThrow(/at least 3 characters/i);
    expect(() => auth.createOfflineAccount('Not A Name')).toThrow(/only contain letters/i);
    expect(() => auth.createOfflineAccount('Builder_One')).toThrow(/already exists/i);
    expect(() => auth.createOfflineAccount('builder_one')).toThrow(/already exists/i);
    expect(auth.listAccounts()).toHaveLength(2);
  });

  it('matches Java UUID.nameUUIDFromBytes for the OfflinePlayer username namespace', () => {
    const usernames = ['Steve', 'Notch', 'Builder_One', 'A_very_long_name'];
    const javaUuids = javaOfflineUuidReference(makeTempDir(), usernames);
    expect(javaUuids).toHaveLength(usernames.length);
    usernames.forEach((name, index) => {
      expect(generateOfflineMinecraftUuid(name)).toBe(javaUuids[index]);
    });
  });

  it('prepares offline-account launches with legacy auth and keeps multiplayer enabled', () => {
    const coordinator = new VesperaStateCoordinator(makeTempDir());
    const account = coordinator.createOfflineAccount('LanBuilder');
    const report = coordinator.prepareActiveLaunch('offline_account');

    expect(report.ready).toBe(true);
    expect(report.sessionMode).toBe('offline_account');
    expect(report.gameArguments).toContain('--username');
    expect(report.gameArguments).toContain('LanBuilder');
    expect(report.gameArguments).toContain('--uuid');
    expect(report.gameArguments).toContain(account.uuid);
    expect(report.gameArguments).toContain('--accessToken');
    expect(report.gameArguments).toContain('0');
    expect(report.gameArguments).toContain('--userType');
    expect(report.gameArguments).toContain('legacy');
    expect(report.gameArguments).not.toContain('--disableMultiplayer');
    expect(report.jvmArguments).toContain('-Dvespera.accountType=offline');
    coordinator.shutdownCleanly();
  });

  it('switches between Offline and Microsoft accounts without replacing either and restores selection after restart', async () => {
    const root = makeTempDir();
    const coordinator = new VesperaStateCoordinator(root, {
      authOptions: { fetchImpl: makeMicrosoftProtocolFetch(), openSystemBrowser: false },
    });
    const offline = coordinator.createOfflineAccount('LocalBuilder');
    const microsoft = await coordinator.authService.exchangeMicrosoftTokenToMinecraftAccount(
      'microsoft-access-token', 'microsoft-refresh-token'
    );

    expect(microsoft.accountType).toBe('microsoft');
    expect(microsoft.ownsMinecraftJava).toBe(true);
    expect(coordinator.authService.getActiveAccount()?.id).toBe(microsoft.id);

    coordinator.switchSelectedAccount(offline.id);
    expect(coordinator.authService.getActiveAccount()?.accountType).toBe('offline');
    coordinator.switchSelectedAccount(microsoft.id);
    expect(coordinator.authService.getActiveAccount()?.accountType).toBe('microsoft');
    coordinator.switchSelectedAccount(offline.id);

    const accountsBeforeRestart = coordinator.authService.listAccounts();
    expect(accountsBeforeRestart.find((account) => account.id === offline.id)).toMatchObject({
      accountType: 'offline',
      username: 'LocalBuilder',
      ownsMinecraftJava: false,
      sessionStatus: 'offline_ready',
    });
    expect(accountsBeforeRestart.find((account) => account.id === microsoft.id)).toMatchObject({
      accountType: 'microsoft',
      username: 'MicrosoftPlayer',
      ownsMinecraftJava: true,
    });
    coordinator.shutdownCleanly();

    const restarted = new VesperaStateCoordinator(root);
    expect(restarted.authService.getActiveAccount()?.id).toBe(offline.id);
    expect(restarted.getSnapshot().activeAccountId).toBe(offline.id);
    expect(restarted.authService.listAccounts()).toHaveLength(2);
    expect(restarted.authService.listAccounts().find((account) => account.id === microsoft.id))
      .toMatchObject({ accountType: 'microsoft', ownsMinecraftJava: true });
    restarted.shutdownCleanly();
  });

  it('classifies online-mode rejection but ignores online-mode=false / ordinary disconnects', () => {
    const coordinator = new VesperaStateCoordinator(makeTempDir());
    coordinator.createOfflineAccount('ServerTester');

    expect(classifyMultiplayerServerRejection(
      '[Server thread/INFO]: Disconnecting ServerTester: Failed to verify username!',
      'offline',
      'ServerTester'
    )).toMatchObject({ accountType: 'offline', reasonCode: 'online_mode_required' });
    expect(coordinator.inspectMultiplayerDisconnect('Joined a server configured with online-mode=false')).toBeNull();
    expect(coordinator.getSnapshot().lastMultiplayerNotice).toBeNull();

    const notice = coordinator.inspectMultiplayerDisconnect(
      '[Client thread/INFO]: Failed to verify username!'
    );
    expect(notice).toMatchObject({
      accountType: 'offline',
      username: 'ServerTester',
      reasonCode: 'online_mode_required',
    });
    expect(coordinator.getSnapshot().lastMultiplayerNotice).toEqual(notice);
    coordinator.dismissMultiplayerNotice();
    expect(coordinator.getSnapshot().lastMultiplayerNotice).toBeNull();
    coordinator.shutdownCleanly();
  });
});
