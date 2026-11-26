import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeRecommendedRam,
  PERFORMANCE_MODE_PRESETS,
  synthesizeJvmArguments,
} from '../shared/performanceEngine';
import { dispatchRpcMethod } from '../server/rpcRouter';
import {
  EncryptedTokenVault,
  redactSensitiveTokens,
  resolveSafeChildPath,
  validateSafeFileName,
} from '../server/securityUtils';
import { VesperaStateCoordinator } from '../server/stateStore';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vespera-test-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Security, Token Vault & Path Hardening', () => {
  it('blocks directory traversal and reserved Windows filenames', () => {
    const base = makeTempDir();
    expect(() => resolveSafeChildPath(base, '../../etc/passwd')).toThrow(/escapes managed directory/);
    expect(resolveSafeChildPath(base, 'instances/profile-1')).toBe(path.join(base, 'instances/profile-1'));
    expect(validateSafeFileName('sodium-fabric-0.6.5+mc1.21.4.jar')).toBe(true);
    expect(validateSafeFileName('../evil.jar')).toBe(false);
    expect(validateSafeFileName('CON.jar')).toBe(false);
  });

  it('scrubs Minecraft accessTokens, Bearer headers, and OAuth refresh tokens from logs', () => {
    const raw =
      'java Main --username Steve --accessToken eyJhbGciOiJIUzI1NiJ9.secret123 Authorization: Bearer tok_abc999 {"refresh_token":"M.C507_BL2.xyz"}';
    const scrubbed = redactSensitiveTokens(raw);
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9.secret123');
    expect(scrubbed).not.toContain('tok_abc999');
    expect(scrubbed).not.toContain('M.C507_BL2.xyz');
    expect(scrubbed).toContain('[REDACTED_MC_TOKEN]');
    expect(scrubbed).toContain('[REDACTED_BEARER]');
  });

  it('encrypts and decrypts OAuth records via AES-256-GCM vault and rejects tampered ciphertext', () => {
    const dir = makeTempDir();
    const vault = new EncryptedTokenVault(dir, 'unit-test-host-key');
    vault.saveEncrypted([{ id: 'acc-1', token: 'super-secret-oauth-token' }]);

    const vaultFile = path.join(dir, 'accounts.vault.bin');
    const rawBytes = fs.readFileSync(vaultFile);
    expect(rawBytes.toString('utf8')).not.toContain('super-secret-oauth-token');

    const loaded = vault.loadDecrypted<Array<{ id: string; token: string }>>([]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].token).toBe('super-secret-oauth-token');

    // Tamper with ciphertext byte -> GCM authTag verification must reject
    rawBytes[rawBytes.length - 1] ^= 0xff;
    fs.writeFileSync(vaultFile, rawBytes);
    expect(vault.loadDecrypted([])).toEqual([]);
  });
});

describe('Performance Engine & Visual Quality Preservation', () => {
  it('computes sensible hardware-aware RAM allocations across 4GB, 8GB, 16GB, and 32GB systems', () => {
    expect(computeRecommendedRam(4096, 21).recommendedMb).toBe(2048);
    expect(computeRecommendedRam(8192, 21).recommendedMb).toBeGreaterThanOrEqual(3072);
    expect(computeRecommendedRam(8192, 21).recommendedMb).toBeLessThanOrEqual(4096);
    const rec16 = computeRecommendedRam(16384, 21, true, true);
    expect(rec16.recommendedMb).toBe(5632);
    expect(rec16.recommendedGc).toBe('generational_zgc');
    expect(computeRecommendedRam(32768, 21).recommendedMb).toBeLessThanOrEqual(8192);
  });

  it('synthesizes valid OpenJDK 21 Generational ZGC and Adaptive G1GC flags', () => {
    const zgc = synthesizeJvmArguments(
      {
        ...PERFORMANCE_MODE_PRESETS.max_fps.performance,
        allocatedRamMb: 4096,
        autoRecommendRam: true,
      },
      21
    );
    expect(zgc.flags).toContain('-XX:+UseZGC');
    expect(zgc.flags).toContain('-XX:+ZGenerational');
    expect(zgc.flags).toContain('-XX:+AlwaysPreTouch');

    const g1 = synthesizeJvmArguments(
      {
        ...PERFORMANCE_MODE_PRESETS.balanced.performance,
        allocatedRamMb: 4096,
        autoRecommendRam: true,
      },
      21
    );
    const unlockIdx = g1.flags.indexOf('-XX:+UnlockExperimentalVMOptions');
    const newSizeIdx = g1.flags.indexOf('-XX:G1NewSizePercent=28');
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(unlockIdx).toBeLessThan(newSizeIdx);
  });

  it('never silently downgrades core visual quality even in Maximum FPS mode', () => {
    const maxFpsGfx = PERFORMANCE_MODE_PRESETS.max_fps.graphicsDefaults;
    expect(maxFpsGfx.renderDistanceChunks).toBeGreaterThanOrEqual(12);
    expect(maxFpsGfx.smoothLighting).toBe('maximum');
    expect(maxFpsGfx.mipmapLevels).toBe(4);
  });
});

describe('State Coordinator, Mod Compatibility Gatekeeper, Profiles & Launch Pipeline', () => {
  it('blocks incompatible/obsolete mods (OptiFabric, Indium on 1.21.4) with clear explanations and resolves transitive dependencies', async () => {
    const dataDir = makeTempDir();
    const coord = new VesperaStateCoordinator(dataDir);

    // Search for optifabric -> must appear as blocked with explicit explanation
    const searchOpti = await coord.searchMods('optifabric', 'all');
    const optiHit = searchOpti.items.find((i) => i.slug === 'optifabric');
    expect(optiHit).toBeDefined();
    expect(optiHit!.compatibility.allowed).toBe(false);
    expect(optiHit!.compatibility.reasons.join(' ')).toMatch(/OptiFabric|Sodium/i);

    await expect(coord.installMod('optifabric')).rejects.toThrow(/OptiFabric/);
    await expect(coord.installMod('indium')).rejects.toThrow(/Sodium 0\.6/);

    // Install Entity Model Features -> must automatically resolve and install Entity Texture Features dependency!
    const installRes = await coord.installMod('entity-model-features');
    expect(installRes.installedRecord.id).toBe('entity-model-features');
    expect(installRes.autoInstalledDeps.some((d) => d.id === 'entitytexturefeatures')).toBe(true);

    // Prevent disabling fabric-api while dependent mods remain enabled
    expect(() => coord.toggleMod('fabric-api', false)).toThrow(/dependent mod/);

    coord.shutdownCleanly();
  });

  it('maintains isolated profiles, automatic pre-mutation backups, rollback, and .vesperaprofile import/export', async () => {
    const dataDir = makeTempDir();
    const coord = new VesperaStateCoordinator(dataDir);

    const origSnap = coord.getSnapshot();
    const origMode = origSnap.profiles[0].performance.mode;
    expect(origMode).toBe('balanced');

    // Switching performance mode automatically creates a backup snapshot
    await dispatchRpcMethod(coord, 'applyPerformanceMode', { mode: 'max_fps' });
    const afterMode = coord.getSnapshot();
    expect(afterMode.profiles[0].performance.mode).toBe('max_fps');
    expect(afterMode.profileBackups.length).toBeGreaterThanOrEqual(1);

    // Rollback restores balanced mode
    const bkpId = afterMode.profileBackups[0].id;
    await dispatchRpcMethod(coord, 'rollbackBackup', { backupId: bkpId });
    expect(coord.getActiveProfile().performance.mode).toBe('balanced');

    // Export & Import profile JSON
    const exported = (await dispatchRpcMethod(coord, 'exportProfile', {
      profileId: coord.getActiveProfile().id,
    })) as { json: string };
    expect(exported.json).toContain('vesperaProfileFormat');

    await dispatchRpcMethod(coord, 'importProfile', { json: exported.json });
    expect(coord.getSnapshot().profiles.some((p) => p.name.includes('(Imported)'))).toBe(true);

    // Legacy 1.8.9 profile isolates modern 1.21 mods cleanly
    const legacy = coord.createNewProfile({
      name: 'Hypixel 1.8.9 Legacy',
      archetype: 'pvp',
      mcVersion: '1.8.9',
    });
    expect(legacy.loader).toBe('legacy_fabric');
    expect(legacy.enabledModIds).toEqual([]);

    coord.shutdownCleanly();
  });

  it('materializes options.txt & sodium-options.json, enforces official MSA authentication gate, and never fabricates GPU metrics', async () => {
    const dataDir = makeTempDir();
    const coord = new VesperaStateCoordinator(dataDir);

    const prep = (await dispatchRpcMethod(coord, 'prepareLaunch', {})) as {
      mainClass: string;
      commandPreview: string;
    };
    expect(prep.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.Client');
    expect(prep.commandPreview).toContain('[REDACTED_MC_TOKEN]');

    const instanceDir = path.join(dataDir, 'instances', coord.getActiveProfile().id);
    expect(fs.existsSync(path.join(instanceDir, 'options.txt'))).toBe(true);
    expect(fs.existsSync(path.join(instanceDir, 'config/sodium-options.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'ipc/hud-profile.json'))).toBe(true);

    // Launch without Microsoft authentication must halt cleanly at authentication_required (never fake launch!)
    const launchAttempt = (await dispatchRpcMethod(coord, 'launchMinecraft', {})) as {
      launchRes: { launched: boolean; stageReached: string };
    };
    expect(launchAttempt.launchRes.launched).toBe(false);
    expect(launchAttempt.launchRes.stageReached).toBe('authentication_required');

    // Telemetry must never fabricate GPU % in headless environment
    const snap = coord.getSnapshot();
    expect(snap.telemetry.gpuUtilizationPercent).toBeNull();

    coord.shutdownCleanly();
  });
});
