import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { MinecraftLauncherService, mavenCoordToRelPath, parseMavenCoordinate } from '../server/minecraftLauncherService';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vespera-metadata-'));
  tempDirs.push(dir);
  return dir;
}

function zip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = zlib.deflateRawSync(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.concat([header, name, compressed]);
    local.push(record);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHeader, name]));
    offset += record.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, eocd]);
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const sha1 = (value: Buffer | string) => crypto.createHash('sha1').update(value).digest('hex');
const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const emptyAssetIndexBytes = Buffer.from(JSON.stringify({ objects: {} }));
const goodMetadata = Buffer.from(JSON.stringify({
  id: '1.20.4',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { majorVersion: 17 },
  downloads: { client: { url: 'https://mock.test/client.jar', sha1: 'a'.repeat(40), size: 10 } },
  assetIndex: {
    id: '1.20.4', url: 'https://mock.test/assets/1.20.4.json',
    sha1: sha1(emptyAssetIndexBytes), size: emptyAssetIndexBytes.length,
  },
  libraries: [],
}));

const settings = (gameDataDir: string) => ({
  gameDataDir,
  instancesDir: path.join(gameDataDir, 'instances'),
  concurrentDownloads: 2,
  bandwidthLimitMbps: 0,
  verifyFileHashes: true,
  keepLauncherOpen: true,
  minimizeToTrayOnLaunch: false,
  closeBehavior: 'keep_open' as const,
  updateChannel: 'stable' as const,
  autoCheckUpdates: true,
  autoBackupBeforeProfileUpdate: true,
  language: 'en-US' as const,
  customJvmExtraArgs: '',
  microsoftAzureClientId: '',
  crashRecoveryEnabled: true,
  firstLaunchCompleted: true,
});

function manifestResponse(url: string, metadataBytes = goodMetadata) {
  return Response.json({
    latest: { release: '1.20.4', snapshot: '25w09b' },
    versions: [{
      id: '1.20.4', type: 'release', url, sha1: sha1(metadataBytes),
      releaseTime: '2023-12-07T12:56:20+00:00',
    }],
  });
}

describe('Mojang version metadata pipeline regressions', () => {
  it('refreshes the official manifest after a metadata 404, retries the exact version, and never marks incomplete installs ready', async () => {
    const root = tempDir();
    const gameDataDir = path.join(root, 'minecraft');
    let manifestCalls = 0;
    let clientStatus = 404;
    const metadataUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === manifestUrl) {
        manifestCalls++;
        return manifestResponse(manifestCalls === 1
          ? 'https://mock.test/old/1.20.4.json'
          : 'https://mock.test/current/1.20.4.json');
      }
      if (url === 'https://mock.test/old/1.20.4.json') return new Response('gone', { status: 404 });
      if (url === 'https://mock.test/current/1.20.4.json') {
        metadataUrls.push(url);
        return new Response(goodMetadata, { status: 200 });
      }
      if (url === 'https://mock.test/assets/1.20.4.json') return new Response(emptyAssetIndexBytes, { status: 200 });
      if (url === 'https://mock.test/client.jar') return new Response('client', { status: clientStatus });
      return new Response('not found', { status: 404 });
    };

    const service = new MinecraftLauncherService(root, { fetchImpl, targetOs: 'linux' });
    await expect(service.installMinecraftVersion({
      versionId: '1.20.4', loader: 'vanilla', settings: settings(gameDataDir),
    })).rejects.toThrow(/Missing client JAR.*HTTP 404/);
    expect(manifestCalls).toBe(2);
    expect(metadataUrls).toEqual(['https://mock.test/current/1.20.4.json']);
    expect(service.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('failed');
    expect(fs.existsSync(path.join(gameDataDir, 'versions', '1.20.4', 'vespera-install-receipt.json'))).toBe(false);

    clientStatus = 403;
    await expect(service.installMinecraftVersion({
      versionId: '1.20.4', loader: 'vanilla', settings: settings(gameDataDir),
    })).rejects.toThrow(/Missing client JAR.*HTTP 403/);
    expect(service.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('failed');
  });

  it('rejects a metadata SHA-1 mismatch before planning any client download', async () => {
    const root = tempDir();
    const gameDataDir = path.join(root, 'minecraft');
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === manifestUrl) return manifestResponse('https://mock.test/1.20.4.json');
      if (url === 'https://mock.test/1.20.4.json') return new Response(Buffer.from('{tampered'), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    };
    const service = new MinecraftLauncherService(root, { fetchImpl, targetOs: 'linux' });
    await expect(service.installMinecraftVersion({
      versionId: '1.20.4', loader: 'vanilla', settings: settings(gameDataDir),
    })).rejects.toThrow(/SHA-1 mismatch for version metadata 1\.20\.4/);
    expect(service.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('failed');
    expect(fs.existsSync(path.join(gameDataDir, 'versions', '1.20.4', '1.20.4.jar'))).toBe(false);
  });

  it('reports invalid metadata JSON separately from HTTP and hash failures', async () => {
    const root = tempDir();
    const gameDataDir = path.join(root, 'minecraft');
    const invalidJson = Buffer.from('{invalid-json');
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === manifestUrl) return manifestResponse('https://mock.test/1.20.4.json', invalidJson);
      if (url === 'https://mock.test/1.20.4.json') return new Response(invalidJson, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    };
    const service = new MinecraftLauncherService(root, { fetchImpl, targetOs: 'linux' });
    await expect(service.installMinecraftVersion({
      versionId: '1.20.4', loader: 'vanilla', settings: settings(gameDataDir),
    })).rejects.toThrow(/Invalid JSON for Minecraft 1\.20\.4 metadata/);
    expect(service.getVersionInstallStatus('1.20.4', gameDataDir)).toBe('failed');
  });

  it('never installs from the embedded browse-only catalogue when the official manifest is unavailable', async () => {
    const root = tempDir();
    const gameDataDir = path.join(root, 'minecraft');
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(String(input));
      throw new Error('offline');
    };
    const service = new MinecraftLauncherService(root, { fetchImpl, targetOs: 'windows' });
    await expect(service.installMinecraftVersion({
      versionId: '1.21.4', loader: 'vanilla', settings: settings(gameDataDir),
    })).rejects.toThrow(/no validated official Mojang manifest is available/);
    expect(requested).toEqual([manifestUrl]);
  });

  it('replaces a corrupt cached official manifest and atomically persists refreshed manifest freshness metadata', async () => {
    const root = tempDir();
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'version_manifest_v2.json'), '{partial');
    fs.writeFileSync(path.join(cacheDir, 'version_manifest_v2.json.info.json'), '{bad');
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === manifestUrl) return manifestResponse('https://mock.test/1.20.4.json');
      throw new Error('offline');
    };
    const service = new MinecraftLauncherService(root, { fetchImpl });
    expect(service.getManifestMetadata().manifestSource).toBe('embedded_seed');
    const entries = await service.syncOfficialVersionManifest();
    expect(entries.some((entry) => entry.id === '1.20.4' && entry.sha1 === sha1(goodMetadata))).toBe(true);
    expect(service.getManifestMetadata().manifestSource).toBe('live_mojang');
    const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, 'version_manifest_v2.json'), 'utf8'));
    const info = JSON.parse(fs.readFileSync(path.join(cacheDir, 'version_manifest_v2.json.info.json'), 'utf8'));
    expect(cached.versions[0].url).toBe('https://mock.test/1.20.4.json');
    expect(info.fetchedAt).toBeGreaterThan(0);
  });
});
