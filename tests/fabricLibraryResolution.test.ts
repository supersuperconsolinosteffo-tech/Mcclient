import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { MinecraftLauncherService, mavenCoordToRelPath, parseMavenCoordinate } from '../server/minecraftLauncherService';

const roots: string[] = [];
const sha1 = (data: Buffer | string) => crypto.createHash('sha1').update(data).digest('hex');
const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vespera-fabric-libs-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeZip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = zlib.deflateRawSync(entry.bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(entry.bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([localHeader, name, body]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(entry.bytes.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name]));
    offset += localRecord.length;
  }
  const central = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, central, eocd]);
}

const settings = (gameDataDir: string) => ({
  gameDataDir,
  instancesDir: path.join(gameDataDir, 'instances'),
  concurrentDownloads: 4,
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

describe('Fabric/Mojang Maven library resolution', () => {
  it('parses classifiers and explicit Maven extensions while rejecting unsafe coordinates', () => {
    expect(mavenCoordToRelPath('org.lwjgl:lwjgl:3.3.3:natives-windows')).toBe(
      'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
    );
    expect(mavenCoordToRelPath('net.fabricmc:intermediary:1.21.4:v2@zip')).toBe(
      'net/fabricmc/intermediary/1.21.4/intermediary-1.21.4-v2.zip',
    );
    expect(parseMavenCoordinate('net.fabricmc:fabric-loader:0.16.10').classifier).toBeUndefined();
    expect(() => mavenCoordToRelPath('../escape:artifact:1.0')).toThrow(/Invalid Maven coordinate/);
    expect(() => mavenCoordToRelPath('g:a:1:two:extra')).toThrow(/Invalid Maven coordinate/);
  });

  it.each(['1.21.4', '1.20.4'])('installs Fabric %s with profile libraries that omit SHA-1, deduplicates them, and verifies published hashes', async (versionId) => {
    const root = tempDir();
    const gameDataDir = path.join(root, 'minecraft');
    const clientJar = makeZip([{ name: 'net/minecraft/client/Main.class', bytes: Buffer.from('client class') }]);
    const assetIndex = Buffer.from(JSON.stringify({ objects: {} }));
    const mojLibrary = makeZip([{ name: 'org/lwjgl/Version.class', bytes: Buffer.from('lwjgl') }]);
    const mojLegacyLibrary = makeZip([{ name: 'org/example/Legacy.class', bytes: Buffer.from('legacy') }]);
    const loaderJar = makeZip([{ name: 'net/fabricmc/loader/impl/launch/knot/KnotClient.class', bytes: Buffer.from('loader') }]);
    const intermediaryJar = makeZip([{ name: 'mappings/mappings.tiny', bytes: Buffer.from('tiny v2') }]);
    const checksumJar = makeZip([{ name: 'example/Checksum.class', bytes: Buffer.from('checksum') }]);
    const checksum = sha1(checksumJar);
    const repo = 'https://maven.fabricmc.net/';
    const coordinates = [
      { name: 'net.fabricmc:fabric-loader:0.16.10', url: repo },
      { name: `net.fabricmc:intermediary:${versionId}`, url: repo },
      { name: 'net.fabricmc:fabric-loader:0.16.10', url: repo }, // duplicate profile entry must resolve once
      { name: 'com.example:checksum-library:1.0.0', url: repo, sha1: checksum },
    ];
    const profileBytes = Buffer.from(JSON.stringify({
      id: `${versionId}-fabric-0.16.10`,
      inheritsFrom: versionId,
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: coordinates,
    }));
    const metadataBytes = Buffer.from(JSON.stringify({
      id: versionId,
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      javaVersion: { majorVersion: versionId === '1.21.4' ? 21 : 17 },
      downloads: { client: { url: `https://mock.test/${versionId}.jar`, sha1: sha1(clientJar), size: clientJar.length } },
      assetIndex: { id: `assets-${versionId}`, url: `https://mock.test/${versionId}-assets.json`, sha1: sha1(assetIndex), size: assetIndex.length },
      libraries: [{
        name: 'org.lwjgl:lwjgl:3.3.3',
        downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar', url: 'https://mock.test/mojang-lwjgl.jar', sha1: sha1(mojLibrary), size: mojLibrary.length } },
      }, {
        name: 'org.example:legacy-library:2.1.0',
        url: 'https://repo.mojang.test/maven/',
        downloads: { artifact: { path: 'org/example/legacy-library/2.1.0/legacy-library-2.1.0.jar', size: mojLegacyLibrary.length } },
      }],
    }));
    const versionMetadataUrl = `https://mock.test/meta/${versionId}.json`;
    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${versionId}/0.16.10/profile/json`;
    const artifactUrls: string[] = [];
    let invalidLoaderReplyOnce = true;
    const loaderArtifactUrl = `${repo}net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar`;
    const artifactBodies = new Map<string, Buffer>([
      [loaderArtifactUrl, loaderJar],
      [`${repo}net/fabricmc/intermediary/${versionId}/intermediary-${versionId}.jar`, intermediaryJar],
      [`${repo}com/example/checksum-library/1.0.0/checksum-library-1.0.0.jar`, checksumJar],
    ]);

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === manifestUrl) return Response.json({
        latest: { release: versionId, snapshot: '25w09b' },
        versions: [{ id: versionId, type: 'release', url: versionMetadataUrl, sha1: sha1(metadataBytes), releaseTime: '2025-01-01T00:00:00+00:00' }],
      });
      if (url === versionMetadataUrl) return new Response(new Uint8Array(metadataBytes), { status: 200 });
      if (url === `https://mock.test/${versionId}-assets.json`) return new Response(new Uint8Array(assetIndex), { status: 200 });
      if (url === `https://mock.test/${versionId}.jar`) return new Response(new Uint8Array(clientJar), { status: 200 });
      if (url === 'https://mock.test/mojang-lwjgl.jar') return new Response(new Uint8Array(mojLibrary), { status: 200 });
      if (url === 'https://repo.mojang.test/maven/org/example/legacy-library/2.1.0/legacy-library-2.1.0.jar') return new Response(new Uint8Array(mojLegacyLibrary), { status: 200 });
      if (url === profileUrl) return new Response(new Uint8Array(profileBytes), { status: 200 });
      const artifact = artifactBodies.get(url);
      if (artifact) {
        artifactUrls.push(url);
        if (url === loaderArtifactUrl && invalidLoaderReplyOnce) {
          invalidLoaderReplyOnce = false;
          return new Response(new Uint8Array(makeZip([{ name: 'unrelated.txt', bytes: Buffer.from('wrong content') }])), { status: 200 });
        }
        return new Response(new Uint8Array(artifact), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const service = new MinecraftLauncherService(root, { fetchImpl, targetOs: 'windows' });
    const staleLoaderPath = path.join(gameDataDir, 'libraries', mavenCoordToRelPath('net.fabricmc:fabric-loader:0.16.10'));
    fs.mkdirSync(path.dirname(staleLoaderPath), { recursive: true });
    fs.writeFileSync(staleLoaderPath, 'corrupt cached file without a published checksum');
    const receipt = await service.installMinecraftVersion({
      versionId,
      loader: 'fabric',
      loaderVersion: '0.16.10',
      settings: settings(gameDataDir),
    });

    const loaderRel = mavenCoordToRelPath('net.fabricmc:fabric-loader:0.16.10');
    const intermediaryRel = mavenCoordToRelPath(`net.fabricmc:intermediary:${versionId}`);
    const checksumRel = mavenCoordToRelPath('com.example:checksum-library:1.0.0');
    const mojLegacyRel = mavenCoordToRelPath('org.example:legacy-library:2.1.0');
    expect(receipt.loader).toBe('fabric');
    expect(receipt.javaMajor).toBe(versionId === '1.21.4' ? 21 : 17);
    expect(new Set(receipt.verifiedLibraries).size).toBe(receipt.verifiedLibraries.length);
    expect(receipt.verifiedLibraries).toEqual(expect.arrayContaining([loaderRel, intermediaryRel, checksumRel, mojLegacyRel]));
    expect(artifactUrls.filter((url) => url.includes('/fabric-loader/'))).toHaveLength(2); // one malformed body retried; duplicate profile entry deduplicated
    expect(receipt.verifiedHashes?.[path.join('libraries', checksumRel)]).toBe(checksum);
    expect(receipt.verifiedHashes?.[path.join('libraries', loaderRel)]).toBeUndefined(); // no checksum was published in the profile
    expect(receipt.verifiedHashes?.[path.join('libraries', mojLegacyRel)]).toBeUndefined(); // Mojang omitted this optional artifact checksum
    expect(fs.existsSync(path.join(gameDataDir, 'libraries', loaderRel))).toBe(true);
    expect(fs.existsSync(path.join(gameDataDir, 'libraries', mojLegacyRel))).toBe(true);
    expect(service.getVersionInstallStatus(versionId, gameDataDir)).toBe('ready');
  });
});
