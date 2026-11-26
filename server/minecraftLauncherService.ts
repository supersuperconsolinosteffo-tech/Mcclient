import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type {
  ClientProfile,
  HudLayoutProfile,
  InstalledModRecord,
  JavaRuntimeInfo,
  LaunchPreparationReport,
  LauncherSettings,
  MinecraftAccount,
  MinecraftVersionDescriptor,
  ModloaderType,
  MultiplayerRejectionNotice,
  ShaderPackEntry,
  VersionDownloadProgress,
  VersionInstallStatus,
} from '../shared/types';
import { classifyMultiplayerServerRejection } from '../shared/offlineAccountUtils';
import {
  MINECRAFT_VERSION_CATALOG,
  OFFICIAL_MOJANG_SEED_MANIFEST,
  getVersionDescriptor,
  isVesperaCustomModCompatible,
  parseMojangManifestV2,
  type RawMojangManifestV2,
} from '../shared/versionCatalog';
import { synthesizeJvmArguments } from '../shared/performanceEngine';

export interface MojangRule {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

export interface MojangLibraryArtifact {
  path?: string;
  sha1?: string;
  size?: number;
  url?: string;
}

export interface MojangLibraryEntry {
  name: string;
  url?: string;
  rules?: MojangRule[];
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
  downloads?: {
    artifact?: MojangLibraryArtifact;
    classifiers?: Record<string, MojangLibraryArtifact>;
  };
}

export interface MojangVersionMetadata {
  id: string;
  type?: string;
  mainClass: string;
  minecraftArguments?: string;
  arguments?: {
    game?: Array<string | { rules?: MojangRule[]; value: string | string[] }>;
    jvm?: Array<string | { rules?: MojangRule[]; value: string | string[] }>;
  };
  javaVersion?: {
    component?: string;
    majorVersion?: number;
  };
  assetIndex?: {
    id: string;
    sha1?: string;
    size?: number;
    totalSize?: number;
    url: string;
  };
  assets?: string;
  downloads?: {
    client?: {
      sha1: string;
      size?: number;
      url: string;
    };
  };
  libraries?: MojangLibraryEntry[];
}

export interface InstallReceipt {
  schemaVersion: 1;
  versionId: string;
  loader: ModloaderType;
  loaderVersion: string | null;
  javaMajor: number;
  mainClass: string;
  assetIndexId: string;
  clientJarSha1: string;
  verifiedLibraries: string[];
  verifiedLibraryIntegrity?: Array<{ path: string; source: string; coordinate: string; requiredEntry?: string }>;
  verifiedAssets?: string[];
  verifiedHashes?: Record<string, string>;
  nativesExtractedCount: number;
  installedAt: string;
}

export interface MinecraftLauncherServiceOptions {
  fetchImpl?: typeof fetch;
  targetOs?: 'windows' | 'linux' | 'osx';
}

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function sha1File(filePath: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function atomicWriteFile(filePath: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, contents);
  fs.renameSync(tempPath, filePath);
}

function errorWithNetworkCategory(error: unknown, url: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = String((err as NodeJS.ErrnoException).code || (err.cause as NodeJS.ErrnoException | undefined)?.code || '');
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return new Error(`Network timeout fetching ${url} (request exceeded its deadline).`);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
    return new Error(`DNS failure fetching ${url}${code ? ` (${code})` : ''}.`);
  }
  return new Error(`Network failure fetching ${url}${code ? ` (${code})` : ''}: ${err.message}`);
}

function validateOfficialManifest(value: unknown): value is RawMojangManifestV2 {
  if (!value || typeof value !== 'object') return false;
  const versions = (value as RawMojangManifestV2).versions;
  if (!Array.isArray(versions) || versions.length === 0) return false;
  const ids = new Set<string>();
  for (const entry of versions) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.url !== 'string' || !/^https:\/\//i.test(entry.url) ||
        typeof entry.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(entry.sha1) ||
        typeof entry.releaseTime !== 'string') return false;
    ids.add(entry.id);
  }
  return true;
}

function validateVersionMetadata(value: unknown, expectedId: string): value is MojangVersionMetadata {
  if (!value || typeof value !== 'object') return false;
  const meta = value as MojangVersionMetadata;
  return meta.id === expectedId && typeof meta.mainClass === 'string' && meta.mainClass.length > 0 &&
    Boolean(meta.downloads?.client?.url && /^https:\/\//i.test(meta.downloads.client.url)) &&
    Boolean(meta.downloads?.client?.sha1 && /^[a-f0-9]{40}$/i.test(meta.downloads.client.sha1)) &&
    Array.isArray(meta.libraries) &&
    Boolean(meta.assetIndex?.id && meta.assetIndex.url && /^https:\/\//i.test(meta.assetIndex.url) &&
      meta.assetIndex.sha1 && /^[a-f0-9]{40}$/i.test(meta.assetIndex.sha1));
}

/**
 * Converts Maven coordinates (`org.lwjgl:lwjgl:3.3.3` or `org.lwjgl:lwjgl:3.3.3:natives-windows`)
 * into standard repository relative path (`org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3[-natives-windows].jar`).
 */
export interface ParsedMavenCoordinate {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
  extension: string;
  relativePath: string;
}

/** Strict Maven coordinate resolver supporting classifiers and the optional @extension form. */
export function parseMavenCoordinate(coordinate: string): ParsedMavenCoordinate {
  const raw = coordinate.trim();
  const at = raw.indexOf('@');
  if (at !== raw.lastIndexOf('@')) throw new Error(`Invalid Maven coordinate "${coordinate}": multiple extensions.`);
  const base = at >= 0 ? raw.slice(0, at) : raw;
  const extension = at >= 0 ? raw.slice(at + 1) : 'jar';
  const parts = base.split(':');
  if ((parts.length !== 3 && parts.length !== 4) || parts.some((part) => !part)) {
    throw new Error(`Invalid Maven coordinate "${coordinate}": expected group:artifact:version[:classifier][@extension].`);
  }
  const [group, artifact, version, classifier] = parts;
  const validToken = /^[A-Za-z0-9_.+~-]+$/;
  if (!group.split('.').every((part) => /^[A-Za-z0-9_-]+$/.test(part)) ||
      !validToken.test(artifact) || !validToken.test(version) ||
      (classifier !== undefined && !validToken.test(classifier)) || !/^[A-Za-z0-9]+$/.test(extension)) {
    throw new Error(`Invalid Maven coordinate "${coordinate}": unsupported path characters.`);
  }
  const groupPath = group.replace(/\./g, '/');
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  const relativePath = `${groupPath}/${artifact}/${version}/${fileName}`;
  if (relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid Maven coordinate "${coordinate}": unsafe resolved path.`);
  }
  return { group, artifact, version, classifier, extension, relativePath };
}

export function mavenCoordToRelPath(coord: string): string {
  return parseMavenCoordinate(coord).relativePath;
}

function validHttpsRepository(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function safeLibraryDestination(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe Maven artifact path "${relativePath}".`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split('/'));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Maven artifact path escaped libraries directory: ${relativePath}`);
  return resolved;
}

function validOptionalSha1(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`${context}: upstream SHA-1 is malformed.`);
  }
  return value;
}

/** Validate a ZIP/JAR central directory and optionally require a key entry. */
function validateJarArchive(bytes: Buffer, expectedEntry?: string): boolean {
  if (bytes.length < 22) return false;
  const minOffset = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) return false;
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (!entries || centralOffset + centralSize > eocd) return false;
  let cursor = centralOffset;
  let found = false;
  for (let n = 0; n < entries; n++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) return false;
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const recordEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > eocd) return false;
    if (expectedEntry && bytes.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8') === expectedEntry) found = true;
    cursor = recordEnd;
  }
  return cursor <= centralOffset + centralSize && (!expectedEntry || found);
}

function validateFabricProfileBytes(bytes: Buffer): boolean {
  try {
    const profile = JSON.parse(bytes.toString('utf8')) as {
      mainClass?: unknown;
      libraries?: Array<{ name?: unknown; url?: unknown; sha1?: unknown }>;
    };
    if (typeof profile.mainClass !== 'string' || !profile.mainClass || !Array.isArray(profile.libraries)) return false;
    for (const library of profile.libraries) {
      if (typeof library?.name !== 'string') return false;
      parseMavenCoordinate(library.name);
      if (!validHttpsRepository(library.url)) return false;
      validOptionalSha1(library.sha1, `Fabric Loader library ${library.name}`);
    }
    return true;
  } catch { return false; }
}

/**
 * Evaluates Mojang version metadata OS/feature rules accurately for Windows, Linux, or macOS.
 */
export function evaluateMojangRules(
  rules: MojangRule[] | undefined,
  targetOs: 'windows' | 'linux' | 'osx'
): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.features) {
      // Skip conditional feature rules like is_demo_user or has_custom_resolution unless matched elsewhere
      continue;
    }
    let matches = true;
    if (rule.os?.name && rule.os.name !== targetOs) {
      matches = false;
    }
    if (matches && rule.os?.arch) {
      const wantX86 = rule.os.arch === 'x86';
      if (wantX86) matches = false; // Vespera targets 64-bit x64 runtimes
    }
    if (matches) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

/**
 * Self-contained PKZIP / JAR extractor using Node's built-in `node:zlib` to safely extract native
 * `.dll` / `.so` / `.dylib` shared libraries without external binaries and with strict Zip-Slip protection.
 */
export function extractNativeLibrariesFromJar(
  jarBuffer: Buffer,
  destDir: string,
  excludePrefixes: string[] = ['META-INF/']
): number {
  fs.mkdirSync(destDir, { recursive: true });
  const resolvedRoot = path.resolve(destDir);
  let extractedCount = 0;

  // Locate End of Central Directory (EOCD: 0x06054b50)
  let eocdOffset = -1;
  const minOffset = Math.max(0, jarBuffer.length - 65557);
  for (let i = jarBuffer.length - 22; i >= minOffset; i--) {
    if (jarBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    return 0;
  }

  const totalEntries = jarBuffer.readUInt16LE(eocdOffset + 10);
  let cdOffset = jarBuffer.readUInt32LE(eocdOffset + 16);

  for (let idx = 0; idx < totalEntries && cdOffset + 46 <= jarBuffer.length; idx++) {
    if (jarBuffer.readUInt32LE(cdOffset) !== 0x02014b50) break;

    const compressionMethod = jarBuffer.readUInt16LE(cdOffset + 10);
    const compressedSize = jarBuffer.readUInt32LE(cdOffset + 20);
    const nameLen = jarBuffer.readUInt16LE(cdOffset + 28);
    const extraLen = jarBuffer.readUInt16LE(cdOffset + 30);
    const commentLen = jarBuffer.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = jarBuffer.readUInt32LE(cdOffset + 42);

    const entryName = jarBuffer
      .subarray(cdOffset + 46, cdOffset + 46 + nameLen)
      .toString('utf8')
      .replace(/\\/g, '/');

    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (!entryName || entryName.endsWith('/')) continue;
    if (excludePrefixes.some((p) => entryName.startsWith(p))) continue;

    const lower = entryName.toLowerCase();
    const isNativeBinary =
      lower.endsWith('.dll') ||
      lower.endsWith('.so') ||
      lower.endsWith('.dylib') ||
      lower.endsWith('.jnilib');
    if (!isNativeBinary) continue;

    // Flatten or preserve safe relative path while strictly preventing Zip-Slip (`..`)
    const baseFileName = path.basename(entryName);
    const outPath = path.resolve(resolvedRoot, baseFileName);
    if (!outPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Security Violation: Blocked Zip-Slip native entry "${entryName}".`);
    }

    if (
      localHeaderOffset + 30 > jarBuffer.length ||
      jarBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      continue;
    }

    const localNameLen = jarBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = jarBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = jarBuffer.subarray(dataStart, dataStart + compressedSize);

    let uncompressed: Buffer;
    if (compressionMethod === 0) {
      uncompressed = rawSlice;
    } else if (compressionMethod === 8) {
      uncompressed = zlib.inflateRawSync(rawSlice);
    } else {
      continue;
    }

    fs.writeFileSync(outPath, uncompressed);
    extractedCount++;
  }

  return extractedCount;
}

/**
 * Dynamic Minecraft Version Manager, Multi-Stage Official Downloader/Verifier,
 * Java 8/17/21+ Runtime Manager, and Version-Aware Vanilla/Fabric/Vespera Launch Engine.
 */
export class MinecraftLauncherService {
  private readonly runtimesDir: string;
  private readonly cacheDir: string;
  private readonly manifestCachePath: string;
  private readonly manifestCacheInfoPath: string;
  private readonly fetchFn: typeof fetch;
  private readonly targetOs: 'windows' | 'linux' | 'osx';

  private activeChildProcess: ChildProcess | null = null;
  private activeMcVersion: string | null = null;
  private manifestSource: 'live_mojang' | 'local_cache' | 'embedded_seed' = 'embedded_seed';
  private manifestFetchedAt = 0;
  private lastManifestError: string | null = null;
  private latestReleaseId = '1.21.4';
  private latestSnapshotId = '25w09b';
  private cachedDescriptors: MinecraftVersionDescriptor[] = [];

  private activeDownloadProgress: VersionDownloadProgress | null = null;
  private activeDownloadAbort: AbortController | null = null;
  private failedInstallErrors = new Map<string, string>();

  constructor(private readonly dataDir: string, options: MinecraftLauncherServiceOptions = {}) {
    this.runtimesDir = path.join(dataDir, 'runtimes');
    this.cacheDir = path.join(dataDir, 'cache');
    this.manifestCachePath = path.join(this.cacheDir, 'version_manifest_v2.json');
    this.manifestCacheInfoPath = `${this.manifestCachePath}.info.json`;
    fs.mkdirSync(this.runtimesDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });

    this.fetchFn = options.fetchImpl ?? fetch;
    this.targetOs =
      options.targetOs ??
      (process.platform === 'win32'
        ? 'windows'
        : process.platform === 'darwin'
          ? 'osx'
          : 'linux');

    this.loadInitialManifestFromCacheOrSeed();
  }

  private loadInitialManifestFromCacheOrSeed(): void {
    if (fs.existsSync(this.manifestCachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.manifestCachePath, 'utf8')) as unknown;
        if (validateOfficialManifest(raw)) {
          const parsed = parseMojangManifestV2(raw);
          this.cachedDescriptors = parsed.versions;
          this.latestReleaseId = parsed.latestReleaseId;
          this.latestSnapshotId = parsed.latestSnapshotId;
          this.manifestSource = 'local_cache';
          if (fs.existsSync(this.manifestCacheInfoPath)) {
            const info = JSON.parse(fs.readFileSync(this.manifestCacheInfoPath, 'utf8')) as { fetchedAt?: number };
            this.manifestFetchedAt = Number.isFinite(info.fetchedAt) ? Number(info.fetchedAt) : 0;
          }
          return;
        }
        throw new Error('Cached Mojang manifest has an invalid structure.');
      } catch {
        // Corrupt or incomplete cache is never trusted; remove both cache pieces atomically by invalidation.
        for (const file of [this.manifestCachePath, this.manifestCacheInfoPath]) {
          try { fs.unlinkSync(file); } catch { /* absent */ }
        }
      }
    }

    const seeded = parseMojangManifestV2(OFFICIAL_MOJANG_SEED_MANIFEST);
    this.cachedDescriptors = seeded.versions;
    this.latestReleaseId = seeded.latestReleaseId;
    this.latestSnapshotId = seeded.latestSnapshotId;
    this.manifestSource = 'embedded_seed';
    this.manifestFetchedAt = 0;
  }

  private manifestIsFresh(): boolean {
    // The embedded catalogue is browse-only; a future timestamp is not a valid freshness proof.
    const age = Date.now() - this.manifestFetchedAt;
    return this.manifestSource !== 'embedded_seed' && this.manifestFetchedAt > 0 &&
      age >= 0 && age < 6 * 60 * 60 * 1000;
  }

  public getManifestMetadata(): {
    latestReleaseId: string;
    latestSnapshotId: string;
    manifestSource: 'live_mojang' | 'local_cache' | 'embedded_seed';
    manifestError: string | null;
  } {
    return {
      latestReleaseId: this.latestReleaseId,
      latestSnapshotId: this.latestSnapshotId,
      manifestSource: this.manifestSource,
      manifestError: this.lastManifestError,
    };
  }

  public getActiveDownloadProgress(): VersionDownloadProgress | null {
    return this.activeDownloadProgress ? { ...this.activeDownloadProgress } : null;
  }

  /**
   * Computes the exact real-time installation status of a Minecraft version on disk.
   * Never reports `ready` unless `vespera-install-receipt.json` AND verified `client.jar` exist.
   */
  public getVersionInstallStatus(
    versionId: string,
    gameDataDir: string
  ): VersionInstallStatus {
    if (
      this.activeDownloadProgress?.active &&
      this.activeDownloadProgress.versionId === versionId
    ) {
      return this.activeDownloadProgress.status;
    }

    if (this.failedInstallErrors.has(versionId)) {
      return 'failed';
    }

    const versionDir = path.join(gameDataDir, 'versions', versionId);
    if (!fs.existsSync(versionDir)) {
      return 'not_installed';
    }

    const receiptPath = path.join(versionDir, 'vespera-install-receipt.json');
    const jarPath = path.join(versionDir, `${versionId}.jar`);
    const partJarPath = `${jarPath}.part`;
    const metaPath = path.join(versionDir, `${versionId}.json`);

    if (fs.existsSync(receiptPath) && fs.existsSync(jarPath) && fs.existsSync(metaPath)) {
      try {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as InstallReceipt;
        const metaBytes = fs.readFileSync(metaPath);
        const parsedMeta: unknown = JSON.parse(metaBytes.toString('utf8'));
        const verifiedMetadata = this.readVerifiedCachedVersionMetadata(versionId, metaPath, this.cachedDescriptors.find((entry) => entry.id === versionId));
        if (verifiedMetadata && receipt.clientJarSha1 && fs.statSync(jarPath).size > 0 &&
            sha1File(jarPath).toLowerCase() === receipt.clientJarSha1.toLowerCase() &&
            validateVersionMetadata(parsedMeta, versionId) &&
            receipt.verifiedLibraries.every((rel) => {
              const libraryPath = path.join(path.dirname(path.dirname(versionDir)), 'libraries', rel);
              return fs.existsSync(libraryPath) && fs.statSync(libraryPath).size > 0 &&
                validateJarArchive(fs.readFileSync(libraryPath));
            }) &&
            (!receipt.verifiedLibraryIntegrity || receipt.verifiedLibraryIntegrity.every((artifact) => {
              const fullPath = path.join(gameDataDir, artifact.path);
              return fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0 &&
                validateJarArchive(fs.readFileSync(fullPath), artifact.requiredEntry);
            })) &&
            Array.isArray(receipt.verifiedAssets) &&
            receipt.verifiedAssets.every((rel) => fs.existsSync(path.join(path.dirname(path.dirname(versionDir)), rel))) &&
            Object.entries(receipt.verifiedHashes || {}).every(([rel, expected]) => {
              const fullPath = path.join(path.dirname(path.dirname(versionDir)), rel);
              return fs.existsSync(fullPath) && sha1File(fullPath).toLowerCase() === expected.toLowerCase();
            })) {
          return 'ready';
        }
        try { fs.unlinkSync(receiptPath); } catch { /* invalid receipt */ }
        return 'partially_downloaded';
      } catch {
        return 'partially_downloaded';
      }
    }

    if (fs.existsSync(partJarPath) || fs.existsSync(jarPath)) {
      return 'partially_downloaded';
    }

    if (fs.existsSync(metaPath)) {
      return 'metadata_cached';
    }

    return 'not_installed';
  }

  /**
   * Returns all dynamically loaded versions annotated with their real on-disk installation state
   * and any cached metadata `javaVersion.majorVersion` overrides.
   */
  public getAnnotatedVersions(gameDataDir: string): MinecraftVersionDescriptor[] {
    return this.cachedDescriptors.map((desc) => {
      const installStatus = this.getVersionInstallStatus(desc.id, gameDataDir);
      let recommendedJavaMajor = desc.recommendedJavaMajor;
      const metaPath = path.join(gameDataDir, 'versions', desc.id, `${desc.id}.json`);
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MojangVersionMetadata;
          const mj = meta.javaVersion?.majorVersion;
          if (mj === 8 || mj === 17 || mj === 21) {
            recommendedJavaMajor = mj;
          } else if (mj === 16) {
            recommendedJavaMajor = 17;
          }
        } catch {
          // Keep inferred Java major
        }
      }
      return {
        ...desc,
        recommendedJavaMajor,
        installStatus,
      };
    });
  }

  /**
   * Fetches the complete official Mojang `version_manifest_v2.json` dynamically, caches it on disk,
   * and returns all Release, Snapshot, Old Beta, and Old Alpha versions sorted newest-to-oldest.
   */
  public async syncOfficialVersionManifest(
    gameDataDir?: string,
    options: { force?: boolean } = {}
  ): Promise<MinecraftVersionDescriptor[]> {
    if (options.force || !this.manifestIsFresh()) {
      const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await this.fetchFn(manifestUrl, { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} fetching official Mojang version manifest ${manifestUrl}`);
        }
        let manifest: unknown;
        try {
          manifest = await res.json();
        } catch (err) {
          throw new Error(`Invalid JSON from official Mojang version manifest ${manifestUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!validateOfficialManifest(manifest)) {
          throw new Error(`Invalid Mojang version manifest structure from ${manifestUrl}.`);
        }
        const parsed = parseMojangManifestV2(manifest);
        if (!parsed.versions.length) throw new Error(`Invalid Mojang version manifest: no usable version entries at ${manifestUrl}.`);

        // Commit data first, then freshness metadata; a crash between writes leaves a stale cache, not a falsely fresh one.
        atomicWriteFile(this.manifestCachePath, JSON.stringify(manifest, null, 2));
        const fetchedAt = Date.now();
        atomicWriteFile(this.manifestCacheInfoPath, JSON.stringify({ fetchedAt, manifestUrl }, null, 2));
        this.cachedDescriptors = parsed.versions;
        this.latestReleaseId = parsed.latestReleaseId;
        this.latestSnapshotId = parsed.latestSnapshotId;
        this.manifestSource = 'live_mojang';
        this.manifestFetchedAt = fetchedAt;
        this.lastManifestError = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastManifestError = /^HTTP \d{3}\b|^Invalid JSON|^Invalid Mojang version manifest/.test(message)
          ? message
          : errorWithNetworkCategory(err, manifestUrl).message;
      } finally {
        clearTimeout(timeout);
      }
    }

    return gameDataDir ? this.getAnnotatedVersions(gameDataDir) : [...this.cachedDescriptors];
  }

  private async fetchVersionMetadata(versionId: string, descriptor: MinecraftVersionDescriptor, destPath: string, signal: AbortSignal): Promise<MojangVersionMetadata> {
    const metadataUrl = descriptor.manifestUrl;
    const expectedSha1 = descriptor.sha1;
    if (!metadataUrl || !expectedSha1 || !/^[a-f0-9]{40}$/i.test(expectedSha1)) {
      throw new Error(`Invalid version metadata entry for ${versionId}: the official manifest must provide its metadata URL and SHA-1.`);
    }
    const fetchOnce = async (url: string, sha1: string): Promise<{ meta: MojangVersionMetadata; bytes: Buffer }> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const combined = AbortSignal.any([signal, controller.signal]);
      try {
        const res = await this.fetchFn(url, { signal: combined, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching metadata for Minecraft ${versionId} from ${url}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!bytes.length) throw new Error(`Invalid version metadata for ${versionId}: empty response from ${url}.`);
        const actualSha1 = sha1Hex(bytes);
        if (actualSha1.toLowerCase() !== sha1.toLowerCase()) {
          throw new Error(`SHA-1 mismatch for version metadata ${versionId} from ${url}: expected ${sha1}, got ${actualSha1}.`);
        }
        let value: unknown;
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch (err) { throw new Error(`Invalid JSON for Minecraft ${versionId} metadata from ${url}: ${err instanceof Error ? err.message : String(err)}.`); }
        if (!validateVersionMetadata(value, versionId)) {
          throw new Error(`Invalid version metadata for Minecraft ${versionId} from ${url}: required fields or version ID are missing/incorrect.`);
        }
        return { meta: value, bytes };
      } catch (err) {
        if (err instanceof Error && /^(HTTP \d{3}|SHA-1 mismatch|Invalid JSON|Invalid version metadata)/.test(err.message)) throw err;
        throw errorWithNetworkCategory(err, url);
      } finally { clearTimeout(timeout); }
    };

    try {
      const result = await fetchOnce(metadataUrl, expectedSha1);
      atomicWriteFile(destPath, result.bytes);
      atomicWriteFile(`${destPath}.cache.json`, JSON.stringify({ url: metadataUrl, sha1: expectedSha1, fetchedAt: Date.now() }, null, 2));
      return result.meta;
    } catch (firstError) {
      if (!(firstError instanceof Error) || !firstError.message.startsWith('HTTP 404')) throw firstError;
      // A 404 is a strong stale-manifest signal. Refresh even if the manifest's normal freshness window has not elapsed.
      await this.syncOfficialVersionManifest(undefined, { force: true });
      const refreshed = this.cachedDescriptors.find((entry) => entry.id === versionId);
      if (!refreshed?.manifestUrl || !refreshed.sha1) {
        throw new Error(`Mojang metadata HTTP 404 for Minecraft ${versionId}: ${metadataUrl} (HTTP 404). Official manifest refresh did not return a URL and SHA-1 for the exact version ID.${this.lastManifestError ? ` Manifest refresh diagnostic: ${this.lastManifestError}` : ''}`);
      }
      try {
        const result = await fetchOnce(refreshed.manifestUrl, refreshed.sha1);
        atomicWriteFile(destPath, result.bytes);
        atomicWriteFile(`${destPath}.cache.json`, JSON.stringify({ url: refreshed.manifestUrl, sha1: refreshed.sha1, fetchedAt: Date.now() }, null, 2));
        return result.meta;
      } catch (retryError) {
        if (retryError instanceof Error && retryError.message.startsWith('HTTP 404')) {
          throw new Error(`Mojang metadata HTTP 404 for Minecraft ${versionId}: ${refreshed.manifestUrl} (HTTP 404) after refreshing the official version manifest.${this.lastManifestError ? ` Manifest refresh diagnostic: ${this.lastManifestError}` : ''}`);
        }
        throw retryError;
      }
    }
  }

  private readVerifiedCachedVersionMetadata(versionId: string, metaPath: string, descriptor?: MinecraftVersionDescriptor): MojangVersionMetadata | null {
    if (!fs.existsSync(metaPath)) return null;
    try {
      const bytes = fs.readFileSync(metaPath);
      let expectedSha1 = descriptor?.sha1;
      if (!expectedSha1 && fs.existsSync(`${metaPath}.cache.json`)) {
        const cacheInfo = JSON.parse(fs.readFileSync(`${metaPath}.cache.json`, 'utf8')) as { sha1?: string };
        expectedSha1 = cacheInfo.sha1;
      }
      if (!expectedSha1 || sha1Hex(bytes).toLowerCase() !== expectedSha1.toLowerCase()) throw new Error('cached metadata SHA-1 mismatch or unavailable');
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!validateVersionMetadata(parsed, versionId)) throw new Error('cached metadata schema or ID is invalid');
      return parsed;
    } catch {
      for (const file of [metaPath, `${metaPath}.cache.json`, `${metaPath}.part`]) {
        try { fs.unlinkSync(file); } catch { /* absent */ }
      }
      return null;
    }
  }

  /**
   * Queries `meta.fabricmc.net` for official Fabric Loader versions compatible with `mcVersion`,
   * caching the response per version so offline sessions retain known loader versions.
   */
  public async fetchCompatibleFabricLoaders(
    mcVersion: string
  ): Promise<Array<{ version: string; stable: boolean }>> {
    const desc = getVersionDescriptor(mcVersion, this.cachedDescriptors);
    if (desc && desc.fabricSupported === false && mcVersion !== '1.8.9') {
      return [];
    }
    if (mcVersion === '1.8.9') {
      return [{ version: '0.15.11-legacyfabric', stable: true }];
    }

    const cacheFile = path.join(
      this.cacheDir,
      `fabric-loaders-${mcVersion.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
    );

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6_000);
      const res = await this.fetchFn(
        `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (res.ok) {
        const items = (await res.json()) as Array<{
          loader?: { version?: string; stable?: boolean };
        }>;
        const parsed = items
          .filter((i) => typeof i?.loader?.version === 'string')
          .map((i) => ({
            version: i.loader!.version!,
            stable: Boolean(i.loader?.stable),
          }));
        if (parsed.length > 0) {
          fs.writeFileSync(cacheFile, JSON.stringify(parsed, null, 2), 'utf8');
          return parsed;
        }
      }
    } catch {
      // Fall back to cache or default compatible loader list
    }

    if (fs.existsSync(cacheFile)) {
      try {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Array<{
          version: string;
          stable: boolean;
        }>;
      } catch {
        // Fall through
      }
    }

    return [
      { version: '0.16.10', stable: true },
      { version: '0.16.9', stable: true },
      { version: '0.15.11', stable: true },
    ];
  }

  /**
   * Detects installed Java runtimes (Java 8, 17, 21) across managed isolated runtimes,
   * system installations (`JAVA_HOME`, Adoptium, Oracle, Zulu, Linux/Windows paths),
   * and optional user-specified custom Java executable path.
   */
  public detectJavaRuntimes(customJavaPath?: string): JavaRuntimeInfo[] {
    const candidates: Array<{
      path: string;
      source: JavaRuntimeInfo['source'];
    }> = [];

    if (customJavaPath && customJavaPath.trim().length > 0 && fs.existsSync(customJavaPath.trim())) {
      candidates.push({ path: customJavaPath.trim(), source: 'user_custom' });
    }

    // 1. Vespera isolated managed runtimes
    for (const major of [21, 17, 8] as const) {
      const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
      const managedBin = path.join(this.runtimesDir, `temurin-${major}`, 'bin', exeName);
      if (fs.existsSync(managedBin)) {
        candidates.push({ path: managedBin, source: 'bundled_managed' });
      }
    }

    // 2. Environment & standard OS locations
    const envJavaHome = process.env.JAVA_HOME;
    if (envJavaHome) {
      const exe = path.join(
        envJavaHome,
        'bin',
        process.platform === 'win32' ? 'java.exe' : 'java'
      );
      if (fs.existsSync(exe)) {
        candidates.push({ path: exe, source: 'system_detected' });
      }
    }

    const extraPaths = [
      path.join(process.cwd(), '.venv/lib/python3.11/site-packages/jdk/jdk-21.0.8+9/bin/java'),
      '/usr/bin/java',
      '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
      '/usr/lib/jvm/java-17-openjdk-amd64/bin/java',
      '/usr/lib/jvm/java-8-openjdk-amd64/bin/java',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-17\\bin\\java.exe',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-8\\bin\\java.exe',
    ];
    for (const p of extraPaths) {
      if (fs.existsSync(p)) {
        candidates.push({ path: p, source: 'system_detected' });
      }
    }

    const discovered = new Map<string, JavaRuntimeInfo>();
    for (const cand of candidates) {
      try {
        const probeOut = execFileSync(cand.path, ['-version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 3500,
        });
        const combined = String(probeOut);
        discovered.set(cand.path, this.parseJavaVersionOutput(combined, cand.path, cand.source));
      } catch (err: unknown) {
        const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString() || '';
        const stdout = (err as { stdout?: Buffer | string })?.stdout?.toString() || '';
        const text = `${stdout}\n${stderr}`;
        if (text.includes('version')) {
          discovered.set(cand.path, this.parseJavaVersionOutput(text, cand.path, cand.source));
        }
      }
    }

    const result = Array.from(discovered.values());
    for (const targetMajor of [21, 17, 8] as const) {
      if (!result.some((r) => r.major === targetMajor)) {
        result.push({
          major: targetMajor,
          vendor: 'Eclipse Temurin (Auto-Provision Ready)',
          version:
            targetMajor === 21
              ? '21.0.6+7-LTS'
              : targetMajor === 17
                ? '17.0.14+7-LTS'
                : '8u442-b06',
          architecture: 'x64',
          path: path.join(
            this.runtimesDir,
            `temurin-${targetMajor}`,
            'bin',
            process.platform === 'win32' ? 'javaw.exe' : 'java'
          ),
          installed: false,
          verifiedSha256: false,
          source: 'adoptium_temurin',
        });
      }
    }

    return result.sort((a, b) => b.major - a.major);
  }

  private parseJavaVersionOutput(
    output: string,
    exePath: string,
    source: JavaRuntimeInfo['source']
  ): JavaRuntimeInfo {
    const match = output.match(/version\s+"([^"]+)"/);
    const verStr = match ? match[1] : '21.0.0';
    let major: 8 | 17 | 21 = 21;
    if (verStr.startsWith('1.8') || verStr.startsWith('8.')) major = 8;
    else if (verStr.startsWith('16.') || verStr.startsWith('17.')) major = 17;

    const vendor = output.includes('Temurin')
      ? 'Eclipse Temurin'
      : output.includes('OpenJDK')
        ? 'OpenJDK'
        : 'Java SE';

    return {
      major,
      vendor,
      version: verStr,
      architecture: 'x64',
      path: exePath,
      installed: true,
      verifiedSha256: true,
      source,
    };
  }

  /**
   * Provisions an isolated Eclipse Temurin JRE for Java 8, 17, or 21 via Adoptium API v3 with SHA-256 verification.
   */
  public async provisionManagedJavaRuntime(major: 8 | 17 | 21): Promise<JavaRuntimeInfo> {
    const existing = this.detectJavaRuntimes().find((r) => r.major === major && r.installed);
    if (existing) {
      return existing;
    }

    const osName =
      process.platform === 'win32'
        ? 'windows'
        : process.platform === 'darwin'
          ? 'mac'
          : 'linux';
    const adoptiumMetaUrl = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=${osName}&vendor=eclipse`;

    const res = await this.fetchFn(adoptiumMetaUrl);
    if (!res.ok) {
      throw new Error(`Adoptium JRE ${major} metadata query returned HTTP ${res.status}`);
    }
    const assets = (await res.json()) as Array<{
      binary?: { package?: { link: string; checksum: string; name: string } };
      version?: { openjdk_version?: string };
    }>;
    const pkg = assets[0]?.binary?.package;
    if (!pkg?.link || !pkg?.checksum) {
      throw new Error(`No Adoptium JRE ${major} x64 binary package returned.`);
    }

    const binRes = await this.fetchFn(pkg.link);
    if (!binRes.ok) {
      throw new Error(`Failed downloading JRE ${major} archive: HTTP ${binRes.status}`);
    }
    const buffer = Buffer.from(await binRes.arrayBuffer());
    const computedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (computedSha256.toLowerCase() !== pkg.checksum.toLowerCase()) {
      throw new Error(
        `Java ${major} SHA-256 verification failed! Expected ${pkg.checksum}, got ${computedSha256}`
      );
    }

    const destDir = path.join(this.runtimesDir, `temurin-${major}`);
    fs.mkdirSync(destDir, { recursive: true });
    const archivePath = path.join(destDir, pkg.name);
    fs.writeFileSync(archivePath, buffer);

    if (pkg.name.endsWith('.tar.gz')) {
      execFileSync('tar', ['-xzf', archivePath, '-C', destDir, '--strip-components=1']);
    }
    fs.unlinkSync(archivePath);

    const exe = path.join(destDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    return {
      major,
      vendor: 'Eclipse Temurin',
      version: assets[0]?.version?.openjdk_version || `${major}.0-LTS`,
      architecture: 'x64',
      path: exe,
      installed: fs.existsSync(exe),
      verifiedSha256: true,
      source: 'adoptium_temurin',
    };
  }

  /**
   * Cancels an active version download/installation cleanly while keeping verified partial `.part` files
   * for HTTP Range resumption on the next attempt.
   */
  public cancelActiveDownload(): VersionDownloadProgress | null {
    if (this.activeDownloadAbort) {
      this.activeDownloadAbort.abort();
      this.activeDownloadAbort = null;
    }
    if (this.activeDownloadProgress) {
      const cancelledSnapshot: VersionDownloadProgress = {
        ...this.activeDownloadProgress,
        active: false,
        status: 'partially_downloaded',
        stage: 'Download cancelled — partial progress saved for resume.',
        cancellable: false,
      };
      this.activeDownloadProgress = null;
      return cancelledSnapshot;
    }
    return null;
  }

  /**
   * Downloads a single artifact with retry backoff, HTTP `Range` resume support on `.part` files,
   * live byte-level progress tracking, and strict SHA-1 hash verification.
   */
  private async downloadVerifiedFile(params: {
    url: string;
    destPath: string;
    expectedSha1?: string;
    verifyHashes: boolean;
    signal: AbortSignal;
    validateArtifact?: (bytes: Buffer) => boolean;
    onChunkBytes?: (deltaBytes: number) => void;
  }): Promise<Buffer> {
    const { url, destPath, expectedSha1, verifyHashes, signal, validateArtifact, onChunkBytes } = params;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // Reuse only a non-empty file that passes every available upstream integrity check.
    if (fs.existsSync(destPath)) {
      const existingBuf = fs.readFileSync(destPath);
      const hashOk = !expectedSha1 || !verifyHashes || sha1Hex(existingBuf).toLowerCase() === expectedSha1.toLowerCase();
      const contentOk = !validateArtifact || validateArtifact(existingBuf);
      if (existingBuf.length > 0 && hashOk && contentOk) return existingBuf;
      try { fs.unlinkSync(destPath); } catch { /* invalid cache entry; download below will fail closed */ }
    }

    const partPath = `${destPath}.part`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal.aborted) {
        throw new Error('Download cancelled by user.');
      }

      let requestTimeout: NodeJS.Timeout | undefined;
      try {
        const requestController = new AbortController();
        requestTimeout = setTimeout(() => requestController.abort(), 45_000);
        const requestSignal = AbortSignal.any([signal, requestController.signal]);
        const existingOffset = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
        const headers: Record<string, string> = {};
        if (existingOffset > 0) {
          headers.Range = `bytes=${existingOffset}-`;
        }

        const res = await this.fetchFn(url, { headers, signal: requestSignal });
        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status} fetching ${url}`);
        }

        const isPartialContent = res.status === 206 && existingOffset > 0;
        const bodyBytes = Buffer.from(await res.arrayBuffer());
        if (bodyBytes.length === 0) throw new Error(`Empty artifact response from ${url}.`);
        onChunkBytes?.(bodyBytes.length);

        const combined = isPartialContent
          ? Buffer.concat([fs.readFileSync(partPath), bodyBytes])
          : bodyBytes;

        fs.writeFileSync(partPath, combined);

        if (expectedSha1 && (verifyHashes || /\/(?:assets|libraries|versions)\//i.test(destPath))) {
          const actualSha1 = sha1Hex(combined);
          if (actualSha1.toLowerCase() !== expectedSha1.toLowerCase()) {
            try { fs.unlinkSync(partPath); } catch { /* ignore */ }
            throw new Error(
              `SHA-1 integrity mismatch for ${path.basename(destPath)} (expected ${expectedSha1}, got ${actualSha1}).`
            );
          }
        }
        if (validateArtifact && !validateArtifact(combined)) {
          try { fs.unlinkSync(partPath); } catch { /* invalid or incomplete content must not be resumed */ }
          throw new Error(`Artifact content validation failed for ${url}: ${path.basename(destPath)} has invalid format or required contents.`);
        }

        fs.renameSync(partPath, destPath);
        return combined;
      } catch (err) {
        if (signal.aborted) {
          throw new Error('Download cancelled by user.');
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (/^HTTP (?:403|404)\b/.test(lastError.message)) {
          try { fs.unlinkSync(partPath); } catch { /* absent */ }
          break;
        }
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      } finally {
        if (requestTimeout) clearTimeout(requestTimeout);
      }
    }

    const finalError = lastError ?? new Error(`Failed downloading ${url}`);
    if (/^HTTP \d{3}\b|SHA-1 integrity mismatch|Artifact content validation failed|HTTP 403|HTTP 404/.test(finalError.message)) throw finalError;
    throw errorWithNetworkCategory(finalError, url);
  }

  /**
   * Executes the complete 12-stage official Mojang (+ optional Fabric) download, SHA-1 verification,
   * and native DLL/SO extraction pipeline for any selected Minecraft version.
   * Marks the version `ready` ONLY after every required artifact passes verification.
   */
  public async installMinecraftVersion(params: {
    versionId: string;
    loader: ModloaderType;
    loaderVersion?: string | null;
    profileId?: string | null;
    settings: LauncherSettings;
    forceRepair?: boolean;
    onProgress?: (progress: VersionDownloadProgress) => void;
  }): Promise<InstallReceipt> {
    const {
      versionId,
      loader,
      profileId = null,
      settings,
      forceRepair = false,
      onProgress,
    } = params;

    if (this.activeDownloadProgress?.active) {
      throw new Error(
        `Another installation (${this.activeDownloadProgress.versionId}) is currently in progress.`
      );
    }

    // Consult the official manifest for every install. If the network is unavailable, only a
    // previously validated on-disk official manifest may serve as offline fallback; the embedded
    // browse catalogue is never an install authority.
    await this.syncOfficialVersionManifest(undefined, { force: true });
    if (this.manifestSource === 'embedded_seed') {
      throw new Error(`Cannot install Minecraft ${versionId}: no validated official Mojang manifest is available.${this.lastManifestError ? ` Manifest diagnostic: ${this.lastManifestError}` : ''}`);
    }
    let versionDescriptor = this.cachedDescriptors.find((entry) => entry.id === versionId);
    if (!versionDescriptor) {
      throw new Error(`Minecraft version "${versionId}" is not present in the official Mojang manifest.${this.lastManifestError ? ` Manifest diagnostic: ${this.lastManifestError}` : ''}`);
    }
    if (versionDescriptor.supportTier === 'unsupported') {
      throw new Error(`Minecraft version "${versionId}" is not a supported official version.`);
    }

    if (loader === 'fabric' && versionDescriptor.fabricSupported === false) {
      throw new Error(
        `Minecraft ${versionId} does not support modern Fabric Loader. Select "Vanilla" modloader for ${versionId}.`
      );
    }

    this.failedInstallErrors.delete(versionId);
    const abortController = new AbortController();
    this.activeDownloadAbort = abortController;

    const startedAtMs = Date.now();
    let bytesDownloaded = 0;
    let totalBytes = 1;
    let completedFiles = 0;
    let totalFiles = 1;

    const emitProgress = (
      status: VersionInstallStatus,
      stage: string,
      overridePercent?: number,
      error: string | null = null
    ) => {
      const elapsedSec = Math.max(0.15, (Date.now() - startedAtMs) / 1000);
      const speedBytesPerSec = bytesDownloaded > 0 ? Math.round(bytesDownloaded / elapsedSec) : 0;
      const remainingBytes = Math.max(0, totalBytes - bytesDownloaded);
      const etaSeconds =
        speedBytesPerSec > 0 && remainingBytes > 0
          ? Math.ceil(remainingBytes / speedBytesPerSec)
          : status === 'ready'
            ? 0
            : null;
      const computedPct =
        overridePercent !== undefined
          ? overridePercent
          : totalBytes > 1
            ? Math.min(99, Math.round((bytesDownloaded / totalBytes) * 100))
            : Math.min(99, Math.round((completedFiles / Math.max(1, totalFiles)) * 100));

      const snapshot: VersionDownloadProgress = {
        active: status === 'downloading' || status === 'installing',
        versionId,
        profileId,
        loader,
        status,
        stage,
        percent: Math.max(0, Math.min(100, computedPct)),
        bytesDownloaded,
        totalBytes,
        speedBytesPerSec,
        etaSeconds,
        completedFiles,
        totalFiles,
        cancellable: status === 'downloading' || status === 'installing',
        error,
      };
      this.activeDownloadProgress = snapshot;
      onProgress?.(snapshot);
    };

    try {
      const versionDir = path.join(settings.gameDataDir, 'versions', versionId);
      const librariesRoot = path.join(settings.gameDataDir, 'libraries');
      const assetsRoot = path.join(settings.gameDataDir, 'assets');
      const nativesDir = path.join(versionDir, 'natives');
      fs.mkdirSync(versionDir, { recursive: true });
      fs.mkdirSync(librariesRoot, { recursive: true });
      fs.mkdirSync(path.join(assetsRoot, 'indexes'), { recursive: true });
      fs.mkdirSync(path.join(assetsRoot, 'objects'), { recursive: true });

      const receiptPath = path.join(versionDir, 'vespera-install-receipt.json');
      if (forceRepair && fs.existsSync(receiptPath)) {
        fs.unlinkSync(receiptPath);
      }

      // Stage 1: use only exact-ID official manifest entries, with the entry SHA-1 for metadata itself.
      emitProgress('downloading', `Fetching Mojang metadata for Minecraft ${versionId}...`, 3);
      const metaPath = path.join(versionDir, `${versionId}.json`);
      let metaJson: MojangVersionMetadata | null = forceRepair
        ? null
        : this.readVerifiedCachedVersionMetadata(versionId, metaPath, versionDescriptor);
      if (metaJson) {
        bytesDownloaded += fs.statSync(metaPath).size;
      } else {
        try {
          metaJson = await this.fetchVersionMetadata(versionId, versionDescriptor, metaPath, abortController.signal);
          bytesDownloaded += fs.statSync(metaPath).size;
          versionDescriptor = this.cachedDescriptors.find((entry) => entry.id === versionId) || versionDescriptor;
        } catch (err) {
          throw err;
        }
      }
      if (!validateVersionMetadata(metaJson, versionId)) {
        throw new Error(`Invalid version metadata for Minecraft ${versionId}: required launch fields are absent.`);
      }

      // Stage 2: Resolve Java requirement & library/native graph
      const javaMajor =
        metaJson.javaVersion?.majorVersion || versionDescriptor.recommendedJavaMajor;
      const clientInfo = metaJson.downloads?.client;
      if (!clientInfo?.url || !clientInfo?.sha1) {
        throw new Error(`Invalid version metadata for ${versionId}: client.jar URL or SHA-1 is missing.`);
      }

      interface PlannedDownload {
        kind: 'client_jar' | 'library' | 'native_jar' | 'asset' | 'fabric_lib';
        url: string;
        destPath: string;
        sha1?: string;
        size: number;
        source?: 'Mojang' | 'Fabric Loader';
        coordinate?: string;
        validateJar?: boolean;
        requiredJarEntry?: string;
        excludePrefixes?: string[];
        legacyVirtualRelPath?: string;
      }

      const planned: PlannedDownload[] = [
        {
          kind: 'client_jar',
          url: clientInfo.url,
          destPath: path.join(versionDir, `${versionId}.jar`),
          sha1: clientInfo.sha1,
          size: clientInfo.size || 24_000_000,
          source: 'Mojang',
          coordinate: `${versionId} client.jar`,
          validateJar: true,
        },
      ];

      const verifiedLibraryRelPaths: string[] = [];

      for (const lib of metaJson.libraries || []) {
        if (!evaluateMojangRules(lib.rules, this.targetOs)) continue;

        if (lib.downloads?.artifact) {
          const coordinate = String(lib.name || '');
          const maven = parseMavenCoordinate(coordinate);
          const artifact = lib.downloads.artifact;
          const relPath = artifact.path || maven.relativePath;
          const destPath = safeLibraryDestination(librariesRoot, relPath);
          const sha1 = validOptionalSha1(artifact.sha1, `Mojang library ${coordinate}`);
          let artifactUrl = artifact.url;
          if (!artifactUrl && validHttpsRepository(lib.url)) {
            const repository = lib.url.endsWith('/') ? lib.url : `${lib.url}/`;
            artifactUrl = new URL(relPath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), repository).toString();
          }
          if (!validHttpsRepository(artifactUrl)) {
            throw new Error(`Invalid Mojang library metadata for Minecraft ${versionId}: ${coordinate} has no valid HTTPS artifact or declared repository URL.`);
          }
          const isNativeCoord = Boolean(maven.classifier?.includes(`natives-${this.targetOs}`));
          planned.push({
            kind: isNativeCoord ? 'native_jar' : 'library',
            url: artifactUrl,
            destPath,
            sha1,
            size: artifact.size || 64_000,
            source: 'Mojang',
            coordinate,
            validateJar: true,
            excludePrefixes: lib.extract?.exclude,
          });
          verifiedLibraryRelPaths.push(relPath.replace(/\\/g, '/'));
        } else if (lib.name) {
          // Legacy Mojang entries may publish a repository base and Maven coordinate instead of downloads.artifact.
          // Use only the repository supplied by Mojang metadata; do not synthesize a repository URL.
          const coordinate = String(lib.name);
          const relPath = mavenCoordToRelPath(coordinate);
          const baseRepo = lib.url;
          if (!validHttpsRepository(baseRepo)) {
            throw new Error(`Invalid Mojang library metadata for Minecraft ${versionId}: ${coordinate} has no valid HTTPS repository URL.`);
          }
          const url = new URL(relPath.split('/').map(encodeURIComponent).join('/'), baseRepo.endsWith('/') ? baseRepo : `${baseRepo}/`).toString();
          planned.push({
            kind: 'library',
            url,
            destPath: safeLibraryDestination(librariesRoot, relPath),
            size: 64_000,
            source: 'Mojang',
            coordinate,
            validateJar: true,
          });
          verifiedLibraryRelPaths.push(relPath);
        }

        const nativeClassifierTemplate = lib.natives?.[this.targetOs];
        if (nativeClassifierTemplate && lib.downloads?.classifiers) {
          const classifierKey = nativeClassifierTemplate.replace(/\$\{arch\}/g, '64');
          const natArt = lib.downloads.classifiers[classifierKey];
          if (natArt?.url) {
            const natRel =
              natArt.path || mavenCoordToRelPath(`${lib.name}:${classifierKey}`);
            const natCoordinate = `${lib.name}:${classifierKey}`;
            const natSha1 = validOptionalSha1(natArt.sha1, `Mojang native library ${natCoordinate}`);
            let natUrl = natArt.url;
            if (!natUrl && validHttpsRepository(lib.url)) {
              const repository = lib.url.endsWith('/') ? lib.url : `${lib.url}/`;
              natUrl = new URL(natRel.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), repository).toString();
            }
            if (!validHttpsRepository(natUrl)) {
              throw new Error(`Invalid Mojang native library metadata for Minecraft ${versionId}: ${natCoordinate} has no valid HTTPS artifact or declared repository URL.`);
            }
            planned.push({
              kind: 'native_jar',
              url: natUrl,
              destPath: safeLibraryDestination(librariesRoot, natRel),
              sha1: natSha1,
              size: natArt.size || 128_000,
              source: 'Mojang',
              coordinate: `${lib.name}:${classifierKey}`,
              validateJar: true,
              excludePrefixes: lib.extract?.exclude,
            });
            verifiedLibraryRelPaths.push(natRel);
          }
        }
      }

      // Stage 3: Fetch & parse official Asset Index JSON
      let assetIndexId = metaJson.assetIndex?.id || metaJson.assets || 'legacy';
      let verifiedAssetIndexPath: string | null = null;
      let mapToResources = false;
      let virtualAssets = false;
      if (metaJson.assetIndex?.url) {
        emitProgress('downloading', `Fetching asset index (${assetIndexId})...`, 8);
        const indexDest = path.join(assetsRoot, 'indexes', `${assetIndexId}.json`);
        verifiedAssetIndexPath = indexDest;
        let indexBuf: Buffer;
        try {
          indexBuf = await this.downloadVerifiedFile({
            url: metaJson.assetIndex.url,
            destPath: indexDest,
            expectedSha1: metaJson.assetIndex.sha1,
            verifyHashes: true,
            signal: abortController.signal,
            onChunkBytes: (n) => { bytesDownloaded += n; },
          });
        } catch (err) {
          throw new Error(`Missing asset index ${assetIndexId} (${metaJson.assetIndex.url}): ${err instanceof Error ? err.message : String(err)}`);
        }
        let indexJson: {
          map_to_resources?: boolean;
          virtual?: boolean;
          objects?: Record<string, { hash: string; size: number }>;
        };
        try { indexJson = JSON.parse(indexBuf.toString('utf8')); }
        catch (err) { throw new Error(`Invalid JSON for asset index ${assetIndexId} (${metaJson.assetIndex.url}): ${err instanceof Error ? err.message : String(err)}`); }
        if (!indexJson || typeof indexJson !== 'object' || !indexJson.objects || typeof indexJson.objects !== 'object') {
          throw new Error(`Invalid version metadata: asset index ${assetIndexId} has no objects map.`);
        }
        mapToResources = Boolean(indexJson.map_to_resources);
        virtualAssets = Boolean(indexJson.virtual);

        for (const [logicalName, obj] of Object.entries(indexJson.objects || {})) {
          if (!obj?.hash || !/^[a-f0-9]{40}$/i.test(obj.hash) || !Number.isFinite(obj.size) || obj.size < 0) {
            throw new Error(`Invalid version metadata: asset index ${assetIndexId} contains an invalid hash/size for "${logicalName}".`);
          }
          const prefix = obj.hash.slice(0, 2);
          planned.push({
            kind: 'asset',
            url: `https://resources.download.minecraft.net/${prefix}/${obj.hash}`,
            destPath: path.join(assetsRoot, 'objects', prefix, obj.hash),
            sha1: obj.hash,
            size: obj.size || 4096,
            legacyVirtualRelPath:
              mapToResources || virtualAssets ? logicalName : undefined,
          });
        }
      }

      // Stage 4: Resolve Fabric Loader profile & Maven libraries when `loader === 'fabric'`
      let mainClass = metaJson.mainClass || 'net.minecraft.client.main.Main';
      let resolvedLoaderVersion: string | null = null;

      if (loader === 'fabric') {
        const requestedLoader =
          params.loaderVersion && params.loaderVersion !== 'vanilla'
            ? params.loaderVersion
            : (await this.fetchCompatibleFabricLoaders(versionId))[0]?.version || '0.16.10';
        resolvedLoaderVersion = requestedLoader;

        emitProgress(
          'downloading',
          `Resolving Fabric Loader ${requestedLoader} metadata for ${versionId}...`,
          11
        );

        const fabricProfileUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(versionId)}/${encodeURIComponent(requestedLoader)}/profile/json`;
        const fabricJsonPath = path.join(
          versionDir,
          `${versionId}-fabric-${requestedLoader}.json`
        );
        const fabricBuf = await this.downloadVerifiedFile({
          url: fabricProfileUrl,
          destPath: fabricJsonPath,
          verifyHashes: false,
          signal: abortController.signal,
          validateArtifact: validateFabricProfileBytes,
          onChunkBytes: (n) => {
            bytesDownloaded += n;
          },
        });
        let fabricMeta: {
          mainClass?: string;
          libraries?: Array<{ name?: string; url?: string; sha1?: string; size?: number }>;
        };
        try {
          fabricMeta = JSON.parse(fabricBuf.toString('utf8'));
        } catch (err) {
          throw new Error(`Invalid Fabric Loader profile JSON from ${fabricProfileUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (typeof fabricMeta.mainClass !== 'string' || !fabricMeta.mainClass || !Array.isArray(fabricMeta.libraries)) {
          throw new Error(`Invalid Fabric Loader profile from ${fabricProfileUrl}: expected mainClass and libraries array.`);
        }
        mainClass = fabricMeta.mainClass;
        for (const flib of fabricMeta.libraries) {
          const coordinate = String(flib.name || '');
          if (!coordinate) throw new Error(`Invalid Fabric Loader library metadata from ${fabricProfileUrl}: missing Maven coordinate.`);
          const maven = parseMavenCoordinate(coordinate);
          if (!validHttpsRepository(flib.url)) {
            throw new Error(`Invalid Fabric Loader library metadata from ${fabricProfileUrl}: ${coordinate} has no valid HTTPS repository URL.`);
          }
          const sha1 = validOptionalSha1(flib.sha1, `Fabric Loader library ${coordinate}`);
          const repository = flib.url.endsWith('/') ? flib.url : `${flib.url}/`;
          const artifactUrl = new URL(maven.relativePath.split('/').map(encodeURIComponent).join('/'), repository).toString();
          const relPath = maven.relativePath;
          const requiredJarEntry = maven.artifact === 'fabric-loader'
            ? 'net/fabricmc/loader/impl/launch/knot/KnotClient.class'
            : maven.artifact === 'intermediary' ? 'mappings/mappings.tiny' : undefined;
          planned.push({
            kind: 'fabric_lib',
            url: artifactUrl,
            destPath: safeLibraryDestination(librariesRoot, relPath),
            sha1,
            size: flib.size || 96_000,
            source: 'Fabric Loader',
            coordinate,
            validateJar: true,
            requiredJarEntry,
          });
          verifiedLibraryRelPaths.push(relPath);
        }
      }

      // Collapse duplicate coordinates before scheduling downloads. Conflicting hashes or unresolved
      // same-path repository definitions are rejected rather than silently choosing one.
      const uniquePlanned: PlannedDownload[] = [];
      const plannedByPath = new Map<string, PlannedDownload>();
      for (const item of planned) {
        const key = path.resolve(item.destPath).toLowerCase();
        const prior = plannedByPath.get(key);
        if (prior) {
          if ((prior.sha1 && item.sha1 && prior.sha1.toLowerCase() !== item.sha1.toLowerCase()) ||
              (prior.url !== item.url && !(prior.sha1 && item.sha1 && prior.sha1.toLowerCase() === item.sha1.toLowerCase()))) {
            throw new Error(`Conflicting dependency metadata for ${item.source || item.kind} coordinate ${item.coordinate || item.destPath}: ${prior.url} vs ${item.url}.`);
          }
          if (!prior.sha1 && item.sha1) prior.sha1 = item.sha1;
          continue;
        }
        plannedByPath.set(key, item);
        uniquePlanned.push(item);
      }
      planned.splice(0, planned.length, ...uniquePlanned);
      for (const item of planned.filter((entry) => entry.kind === 'library' || entry.kind === 'native_jar' || entry.kind === 'fabric_lib')) {
        console.info(`[LibraryResolver] source=${item.source || 'Mojang'} coordinate=${item.coordinate || item.destPath} url=${item.url} upstreamSha1=${item.sha1 || 'not-published'} destination=${item.destPath}`);
      }

      // Stage 5: Execute concurrent verified downloads with live speed & ETA
      totalFiles = planned.length;
      totalBytes = Math.max(
        1,
        bytesDownloaded + planned.reduce((acc, item) => acc + Math.max(1, item.size), 0)
      );

      const concurrency = Math.max(1, Math.min(16, settings.concurrentDownloads || 8));
      let cursor = 0;
      const nativeJarsToExtract: Array<{ path: string; exclude?: string[] }> = [];

      const runWorker = async () => {
        while (cursor < planned.length) {
          if (abortController.signal.aborted) {
            throw new Error('Download cancelled by user.');
          }
          const idx = cursor++;
          const item = planned[idx];

          const label =
            item.kind === 'client_jar'
              ? `Downloading Minecraft ${versionId} client.jar`
              : item.kind === 'native_jar'
                ? `Downloading native runtime library (${completedFiles + 1}/${totalFiles})`
                : item.kind === 'fabric_lib'
                  ? `Downloading Fabric Loader dependency (${completedFiles + 1}/${totalFiles})`
                  : item.kind === 'library'
                    ? `Downloading JVM library (${completedFiles + 1}/${totalFiles})`
                    : `Verifying & downloading game assets (${completedFiles + 1}/${totalFiles})`;

          emitProgress('downloading', label);

          let countedChunkBytes = 0;
          try {
            await this.downloadVerifiedFile({
              url: item.url,
              destPath: item.destPath,
              expectedSha1: item.sha1,
              verifyHashes: true,
              signal: abortController.signal,
              validateArtifact: item.validateJar
                ? (bytes) => validateJarArchive(bytes, item.requiredJarEntry)
                : undefined,
              onChunkBytes: (n) => {
                countedChunkBytes += n;
                bytesDownloaded += n;
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (item.kind === 'library' || item.kind === 'native_jar' || item.kind === 'fabric_lib') {
              const source = item.source || 'Mojang';
              const coordinate = item.coordinate || item.destPath;
              throw new Error(`Missing/invalid ${source} library ${coordinate} (${item.destPath}): ${message}`);
            }
            const kindLabel = item.kind === 'asset' ? 'Missing asset' : item.kind === 'client_jar' ? 'Missing client JAR' : 'Missing required library';
            throw new Error(`${kindLabel} (${item.destPath}): ${message}`);
          }

          if (countedChunkBytes === 0) {
            // Cached & verified locally: advance progress smoothly
            bytesDownloaded += item.size;
          }

          if (item.kind === 'native_jar') {
            nativeJarsToExtract.push({
              path: item.destPath,
              exclude: item.excludePrefixes,
            });
          }

          if (item.legacyVirtualRelPath) {
            const legacyDest = path.join(
              assetsRoot,
              'virtual',
              'legacy',
              item.legacyVirtualRelPath
            );
            fs.mkdirSync(path.dirname(legacyDest), { recursive: true });
            if (!fs.existsSync(legacyDest)) {
              fs.copyFileSync(item.destPath, legacyDest);
            }
          }

          completedFiles++;
          emitProgress('downloading', label);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, planned.length) }, () => runWorker())
      );

      // Stage 6: Extract platform-specific native libraries cleanly
      emitProgress('installing', `Extracting platform natives for Minecraft ${versionId}...`, 96);
      fs.mkdirSync(nativesDir, { recursive: true });
      let nativesExtractedCount = 0;
      for (const nat of nativeJarsToExtract) {
        const buf = fs.readFileSync(nat.path);
        nativesExtractedCount += extractNativeLibrariesFromJar(
          buf,
          nativesDir,
          nat.exclude ?? ['META-INF/']
        );
      }

      // Stage 7: Final integrity gate before writing install receipt
      const clientJarPath = path.join(versionDir, `${versionId}.jar`);
      const finalJarSha1 = sha1File(clientJarPath);
      if (
        clientInfo.sha1 &&
        finalJarSha1.toLowerCase() !== clientInfo.sha1.toLowerCase()
      ) {
        throw new Error(
          `Final verification failed for ${versionId}.jar (expected ${clientInfo.sha1}, got ${finalJarSha1}).`
        );
      }

      const receipt: InstallReceipt = {
        schemaVersion: 1,
        versionId,
        loader,
        loaderVersion: resolvedLoaderVersion,
        javaMajor,
        mainClass,
        assetIndexId,
        clientJarSha1: finalJarSha1,
        verifiedLibraries: Array.from(new Set(verifiedLibraryRelPaths)),
        verifiedLibraryIntegrity: planned
          .filter((item) => item.validateJar && item.coordinate && item.source)
          .map((item) => ({
            path: path.relative(settings.gameDataDir, item.destPath),
            source: item.source!,
            coordinate: item.coordinate!,
            requiredEntry: item.requiredJarEntry,
          })),
        verifiedAssets: planned.filter((item) => item.kind === 'asset').map((item) => path.relative(settings.gameDataDir, item.destPath)),
        verifiedHashes: Object.fromEntries([
          ...planned.filter((item) => item.sha1).map((item) => [path.relative(settings.gameDataDir, item.destPath), item.sha1!]),
          ...(verifiedAssetIndexPath && metaJson.assetIndex?.sha1
            ? [[path.relative(settings.gameDataDir, verifiedAssetIndexPath), metaJson.assetIndex.sha1] as [string, string]]
            : []),
        ]),
        nativesExtractedCount,
        installedAt: new Date().toISOString(),
      };

      const tmpReceipt = `${receiptPath}.tmp`;
      fs.writeFileSync(tmpReceipt, JSON.stringify(receipt, null, 2), 'utf8');
      fs.renameSync(tmpReceipt, receiptPath);

      emitProgress(
        'ready',
        `Minecraft ${versionId} (${loader === 'vanilla' ? 'Vanilla' : `Fabric ${resolvedLoaderVersion}`}) verified and ready to launch.`,
        100
      );
      this.activeDownloadAbort = null;
      return receipt;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const wasCancelled = msg.toLowerCase().includes('cancelled');
      if (!wasCancelled) {
        try { fs.unlinkSync(path.join(settings.gameDataDir, 'versions', versionId, 'vespera-install-receipt.json')); } catch { /* no prior receipt */ }
        this.failedInstallErrors.set(versionId, msg);
        emitProgress('failed', `Installation failed: ${msg}`, undefined, msg);
      }
      this.activeDownloadAbort = null;
      throw err;
    }
  }

  /**
   * Verifies all core artifacts of an installed version (`<id>.json`, `<id>.jar` SHA-1, libraries)
   * and triggers targeted repair if any file is missing or corrupted.
   */
  public verifyVersionIntegrity(
    versionId: string,
    settings: LauncherSettings
  ): { healthy: boolean; issues: string[] } {
    const issues: string[] = [];
    const versionDir = path.join(settings.gameDataDir, 'versions', versionId);
    const receiptPath = path.join(versionDir, 'vespera-install-receipt.json');
    const jarPath = path.join(versionDir, `${versionId}.jar`);
    const metaPath = path.join(versionDir, `${versionId}.json`);

    if (!fs.existsSync(metaPath)) {
      issues.push(`Missing Mojang version metadata (${versionId}.json).`);
    } else if (!this.readVerifiedCachedVersionMetadata(versionId, metaPath, this.cachedDescriptors.find((entry) => entry.id === versionId))) {
      issues.push(`Invalid or SHA-1-mismatched Mojang version metadata (${versionId}.json).`);
    }
    if (!fs.existsSync(jarPath)) {
      issues.push(`Missing Minecraft client JAR (${versionId}.jar).`);
    }
    if (!fs.existsSync(receiptPath)) {
      issues.push(`Missing verified installation receipt for Minecraft ${versionId}.`);
      return { healthy: false, issues };
    }

    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as InstallReceipt;
      if (fs.existsSync(jarPath) && receipt.clientJarSha1) {
        const actualSha1 = sha1File(jarPath);
        if (actualSha1.toLowerCase() !== receipt.clientJarSha1.toLowerCase()) {
          issues.push(
            `Corrupted ${versionId}.jar detected (SHA-1 ${actualSha1.slice(0, 10)} != ${receipt.clientJarSha1.slice(0, 10)}).`
          );
        }
      }
      for (const relLib of receipt.verifiedLibraries) {
        const libFull = path.join(settings.gameDataDir, 'libraries', relLib);
        if (!fs.existsSync(libFull) || fs.statSync(libFull).size === 0) {
          issues.push(`Missing required library: ${relLib}`);
        } else if (!validateJarArchive(fs.readFileSync(libFull))) {
          issues.push(`Invalid JAR archive for required library: ${relLib}`);
        }
      }
      for (const artifact of receipt.verifiedLibraryIntegrity || []) {
        const fullPath = path.join(settings.gameDataDir, artifact.path);
        if (!fs.existsSync(fullPath) || !validateJarArchive(fs.readFileSync(fullPath), artifact.requiredEntry)) {
          issues.push(`Library integrity check failed for ${artifact.source} coordinate ${artifact.coordinate} (${artifact.path}).`);
        }
      }
      for (const relAsset of receipt.verifiedAssets || []) {
        const assetFull = path.join(settings.gameDataDir, relAsset);
        if (!fs.existsSync(assetFull) || fs.statSync(assetFull).size === 0) {
          issues.push(`Missing required asset: ${relAsset}`);
        }
      }
      for (const [relPath, expected] of Object.entries(receipt.verifiedHashes || {})) {
        const fullPath = path.join(settings.gameDataDir, relPath);
        if (!fs.existsSync(fullPath)) {
          issues.push(`Missing verified artifact: ${relPath}`);
        } else {
          const actual = sha1File(fullPath);
          if (actual.toLowerCase() !== expected.toLowerCase()) {
            issues.push(`SHA-1 mismatch for installed artifact ${relPath} (expected ${expected}, got ${actual}).`);
          }
        }
      }
    } catch {
      issues.push('Installation receipt JSON is unreadable.');
    }

    if (issues.length > 0) {
      try {
        fs.unlinkSync(receiptPath);
      } catch {
        // Ignore
      }
    }

    return { healthy: issues.length === 0, issues };
  }

  /**
   * Deletes an installed Minecraft version's binaries (`versions/<id>`) cleanly without touching
   * user accounts, installation profiles, or world saves in `instances/`.
   */
  public deleteInstalledVersion(versionId: string, settings: LauncherSettings): void {
    const safeId = path.basename(versionId);
    if (!safeId || safeId !== versionId) {
      throw new Error(`Invalid version identifier "${versionId}".`);
    }
    if (
      this.activeDownloadProgress?.active &&
      this.activeDownloadProgress.versionId === versionId
    ) {
      this.cancelActiveDownload();
    }
    this.failedInstallErrors.delete(versionId);
    const versionDir = path.join(settings.gameDataDir, 'versions', safeId);
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
  }

  /**
   * Resolves the isolated instance directory for a profile and materializes its `options.txt`,
   * shaderpacks config, and strictly version-compatible mods (never injecting the 1.21.4 Vespera JAR
   * or incompatible Fabric mods into Vanilla or non-matching Minecraft versions).
   */
  public materializeInstanceFiles(
    profile: ClientProfile,
    settings: LauncherSettings,
    hudLayout: HudLayoutProfile,
    installedMods: InstalledModRecord[],
    shaderPacks: ShaderPackEntry[]
  ): { instanceDir: string; syncedModFiles: string[] } {
    const instanceDir =
      profile.customGameDir && profile.customGameDir.trim().length > 0
        ? path.resolve(profile.customGameDir.trim())
        : path.join(settings.instancesDir, profile.id);

    const modsDir = path.join(instanceDir, 'mods');
    const configDir = path.join(instanceDir, 'config');
    const shaderDir = path.join(instanceDir, 'shaderpacks');
    const rpDir = path.join(instanceDir, 'resourcepacks');

    fs.mkdirSync(modsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(shaderDir, { recursive: true });
    fs.mkdirSync(rpDir, { recursive: true });

    const g = profile.graphics;
    const optionsLines = [
      `version:4189`,
      `renderDistance:${g.renderDistanceChunks}`,
      `simulationDistance:${g.simulationDistanceChunks}`,
      `maxFps:${g.maxFps}`,
      `enableVsync:${g.vsync}`,
      `fullscreen:${g.fullscreenMode === 'exclusive_fullscreen'}`,
      `guiScale:${g.guiScale}`,
      `particles:${g.particles === 'all' ? 0 : g.particles === 'decreased' ? 1 : 2}`,
      `entityDistanceScaling:${(g.entityDistancePercent / 100).toFixed(2)}`,
      `renderClouds:"${g.clouds === 'off' ? 'false' : g.clouds === 'fast' ? 'fast' : 'true'}"`,
      `ao:${g.smoothLighting !== 'off'}`,
      `entityShadows:${g.entityShadows}`,
      `biomeBlendRadius:${Math.floor(g.biomeBlendRadius / 2)}`,
      `mipmapLevels:${g.mipmapLevels}`,
    ];
    fs.writeFileSync(path.join(instanceDir, 'options.txt'), optionsLines.join('\n') + '\n', 'utf8');

    const syncedModFiles: string[] = [];

    if (profile.loader !== 'vanilla') {
      // Only write Sodium/Iris/Vespera configs on Fabric profiles
      if (isVesperaCustomModCompatible(profile.mcVersion)) {
        fs.writeFileSync(
          path.join(configDir, 'vespera-hud.json'),
          JSON.stringify(
            {
              profileId: profile.id,
              hudLayout,
              performance: profile.performance,
              graphics: profile.graphics,
            },
            null,
            2
          ),
          'utf8'
        );
      }

      const versionDesc = getVersionDescriptor(profile.mcVersion, this.cachedDescriptors);
      if (versionDesc?.sodiumSupported) {
        const sodiumOpts = {
          quality: {
            weather_quality: 'DEFAULT',
            leaves_quality: profile.performance.mode === 'max_fps' ? 'FAST' : 'DEFAULT',
            enable_vignette: profile.performance.mode !== 'max_fps',
          },
          performance: {
            chunk_builder_threads: profile.performance.chunkBuilderThreads,
            always_defer_chunk_updates: profile.performance.deferChunkUpdates,
            animate_only_visible_textures: true,
            use_entity_culling: profile.performance.useEntityCulling,
            use_fog_occlusion: profile.performance.useFogOcclusion,
            use_block_face_culling: profile.performance.useBlockFaceCulling,
            use_compact_vertex_format: profile.performance.useCompactVertexFormat,
          },
        };
        fs.writeFileSync(
          path.join(configDir, 'sodium-options.json'),
          JSON.stringify(sodiumOpts, null, 2),
          'utf8'
        );
      }

      if (versionDesc?.irisSupported) {
        const activeShader = shaderPacks.find((s) => s.id === profile.activeShaderPackId);
        const irisLines = [
          `shaderPack=${activeShader && g.shaderQualityPreset !== 'off' ? activeShader.fileName : ''}`,
          `enableShaders=${Boolean(activeShader && g.shaderQualityPreset !== 'off')}`,
          `maxShadowRenderDistance=${g.shaderQualityPreset === 'cinematic_ultra' ? 16 : g.shaderQualityPreset === 'balanced_pbr' ? 12 : 8}`,
        ];
        fs.writeFileSync(
          path.join(configDir, 'iris.properties'),
          irisLines.join('\n') + '\n',
          'utf8'
        );
      }

      const modCacheDir = path.join(this.dataDir, 'mods-cache');
      const releaseModJar = path.join(
        process.cwd(),
        'release',
        'mods',
        'vespera-client-1.2.2+mc1.21.4.jar'
      );
      const legacyReleaseModJar = path.join(
        process.cwd(),
        'release',
        'mods',
        'vespera-client-1.2.0+mc1.21.4.jar'
      );

      // Clean stale Vespera custom JAR if profile version is NOT 1.21.4
      if (!isVesperaCustomModCompatible(profile.mcVersion)) {
        for (const f of fs.readdirSync(modsDir)) {
          if (f.startsWith('vespera-client-')) {
            fs.unlinkSync(path.join(modsDir, f));
          }
        }
      }

      for (const modId of profile.enabledModIds) {
        if (modId === 'vespera-client' && !isVesperaCustomModCompatible(profile.mcVersion)) {
          // Never inject Vespera 1.21.4 custom mod into incompatible Minecraft versions!
          continue;
        }
        const record = installedMods.find(
          (m) => m.id === modId && m.enabled && m.mcVersion === profile.mcVersion
        );
        if (!record) continue;

        const cachedJar = path.join(modCacheDir, record.fileName);
        const destJar = path.join(modsDir, record.fileName);
        if (fs.existsSync(cachedJar)) {
          fs.copyFileSync(cachedJar, destJar);
          syncedModFiles.push(record.fileName);
        } else if (
          record.id === 'vespera-client' &&
          isVesperaCustomModCompatible(profile.mcVersion)
        ) {
          if (fs.existsSync(releaseModJar)) {
            fs.copyFileSync(releaseModJar, destJar);
            syncedModFiles.push(record.fileName);
          } else if (fs.existsSync(legacyReleaseModJar)) {
            fs.copyFileSync(legacyReleaseModJar, destJar);
            syncedModFiles.push(record.fileName);
          }
        }
      }
    }

    return { instanceDir, syncedModFiles };
  }

  /**
   * Builds a deterministic, version-accurate `LaunchPreparationReport` supporting:
   * - Official Vanilla, Fabric Loader, and Legacy 1.8.9/1.12.2/Beta/Alpha `minecraftArguments`
   * - Java 8, Java 17, Java 21, and custom Java executable overrides
   * - Online Authenticated sessions AND Legitimate Offline Singleplayer (`--disableMultiplayer`)
   */
  public prepareLaunchCommand(params: {
    profile: ClientProfile;
    settings: LauncherSettings;
    account: MinecraftAccount | null;
    totalSystemRamMb: number;
    installedMods: InstalledModRecord[];
    sessionMode?: 'offline_account' | 'online_authenticated' | 'offline_singleplayer';
  }): LaunchPreparationReport {
    const {
      profile,
      settings,
      account,
      totalSystemRamMb,
      installedMods,
      sessionMode = account?.accountType === 'offline'
        ? 'offline_account'
        : 'online_authenticated',
    } = params;
    const warnings: string[] = [];

    const versionDescriptor = getVersionDescriptor(profile.mcVersion, this.cachedDescriptors);
    if (!versionDescriptor || versionDescriptor.supportTier === 'unsupported') {
      return {
        ready: false,
        profileId: profile.id,
        mcVersion: profile.mcVersion,
        loader: profile.loader,
        vesperaModActive: false,
        sessionMode,
        javaExecutable: 'none',
        jvmArguments: [],
        gameArguments: [],
        mainClass: '',
        verifiedLibrariesCount: 0,
        enabledMods: [],
        warnings: [
          `Minecraft version "${profile.mcVersion}" is unsupported. Choose any official Mojang release, snapshot, or historical version.`,
        ],
        commandPreview: '',
      };
    }

    if (profile.loader === 'fabric' && versionDescriptor.fabricSupported === false) {
      warnings.push(
        `Minecraft ${profile.mcVersion} is Vanilla-only and does not support modern Fabric Loader. Switch this profile's modloader to "Vanilla".`
      );
    }

    // Inspect cached Mojang metadata if already downloaded on disk
    const versionDir = path.join(settings.gameDataDir, 'versions', profile.mcVersion);
    const metaPath = path.join(versionDir, `${profile.mcVersion}.json`);
    const receiptPath = path.join(versionDir, 'vespera-install-receipt.json');
    let metaJson: MojangVersionMetadata | null = null;
    let receipt: InstallReceipt | null = null;

    if (fs.existsSync(metaPath)) {
      try {
        metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MojangVersionMetadata;
      } catch {
        metaJson = null;
      }
    }
    if (fs.existsSync(receiptPath)) {
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as InstallReceipt;
      } catch {
        receipt = null;
      }
    }

    const requiredJavaMajor: 8 | 17 | 21 =
      metaJson?.javaVersion?.majorVersion === 8
        ? 8
        : metaJson?.javaVersion?.majorVersion === 16 || metaJson?.javaVersion?.majorVersion === 17
          ? 17
          : metaJson?.javaVersion?.majorVersion && metaJson.javaVersion.majorVersion >= 21
            ? 21
            : versionDescriptor.recommendedJavaMajor;

    // Resolve custom Java override (profile-level -> global settings -> auto-detected runtime for requiredJavaMajor)
    const customJavaCandidate =
      profile.customJavaPath?.trim() || settings.customJavaExecutablePath?.trim() || '';
    const runtimes = this.detectJavaRuntimes(customJavaCandidate);

    let matchingJava: JavaRuntimeInfo | undefined;
    if (customJavaCandidate) {
      if (fs.existsSync(customJavaCandidate)) {
        matchingJava =
          runtimes.find((r) => r.path === customJavaCandidate) ?? {
            major: requiredJavaMajor,
            vendor: 'Custom User Runtime',
            version: 'custom',
            architecture: 'x64',
            path: customJavaCandidate,
            installed: true,
            verifiedSha256: true,
            source: 'user_custom',
          };
      } else {
        warnings.push(
          `Custom Java executable "${customJavaCandidate}" was not found on disk. Falling back to managed Java ${requiredJavaMajor}.`
        );
      }
    }

    if (!matchingJava) {
      matchingJava =
        runtimes.find((r) => r.major === requiredJavaMajor && r.installed) ??
        runtimes.find((r) => r.major === requiredJavaMajor);
    }

    if (!matchingJava?.installed) {
      warnings.push(
        `Java ${requiredJavaMajor} runtime will be automatically provisioned from Eclipse Temurin (SHA-256 verified) before launch.`
      );
    }

    // Validate account readiness according to account type & session mode
    if (sessionMode === 'offline_account') {
      if (!account || account.accountType !== 'offline') {
        warnings.push(
          'Select or create an Offline Account (or sign in with Microsoft) on the Accounts page before launching.'
        );
      }
    } else if (sessionMode === 'offline_singleplayer') {
      if (!account || !account.ownsMinecraftJava || account.lastValidatedAt <= 0) {
        warnings.push(
          'Offline Singleplayer fallback requires a Microsoft account previously verified on this device, or create an Offline Account directly.'
        );
      }
      if (!receipt) {
        warnings.push(
          `Minecraft ${profile.mcVersion} is not installed locally yet. Download it before launching.`
        );
      }
    } else {
      if (!account) {
        warnings.push(
          'No account selected. Create an Offline Account or sign in with Microsoft on the Accounts page.'
        );
      } else if (account.accountType === 'offline') {
        warnings.push(
          `Account "${account.username}" is an Offline Account and uses offline session behavior (cannot authenticate to online-mode Microsoft servers).`
        );
      } else if (!account.ownsMinecraftJava) {
        warnings.push(
          'Selected Microsoft account does not hold an active Minecraft: Java Edition entitlement.'
        );
      } else if (account.sessionStatus === 'signed_out') {
        warnings.push(
          `Microsoft account "${account.username}" is signed out. Click "Sign in with Microsoft" or switch to an Offline Account.`
        );
      }
    }

    const instanceDir =
      profile.customGameDir && profile.customGameDir.trim().length > 0
        ? path.resolve(profile.customGameDir.trim())
        : path.join(settings.instancesDir, profile.id);
    const nativesDir = path.join(versionDir, 'natives');
    const assetsDir = path.join(settings.gameDataDir, 'assets');
    const clientJar = path.join(versionDir, `${profile.mcVersion}.jar`);

    const cpSeparator = process.platform === 'win32' ? ';' : ':';
    const classpathEntries: string[] = [];
    if (receipt?.verifiedLibraries?.length) {
      for (const relLib of receipt.verifiedLibraries) {
        classpathEntries.push(path.join(settings.gameDataDir, 'libraries', relLib));
      }
    }
    classpathEntries.push(clientJar);
    const classpathStr = classpathEntries.join(cpSeparator);

    const { flags: baseFlags } = synthesizeJvmArguments(
      profile.performance,
      requiredJavaMajor,
      settings.customJvmExtraArgs
    );

    const isUnauthenticatedOfflineToken =
      sessionMode === 'offline_account' || sessionMode === 'offline_singleplayer';

    const jvmArguments = [
      ...baseFlags,
      `-Djava.library.path=${nativesDir}`,
      `-Dminecraft.launcher.brand=VesperaClient`,
      `-Dminecraft.launcher.version=1.2.2`,
      ...(sessionMode === 'offline_account' ? ['-Dvespera.accountType=offline'] : []),
      ...(sessionMode === 'offline_singleplayer'
        ? ['-Dvespera.offlineSingleplayer=true']
        : []),
      `-cp`,
      classpathStr,
    ];

    const assetIndexName =
      receipt?.assetIndexId ||
      metaJson?.assetIndex?.id ||
      metaJson?.assets ||
      profile.mcVersion;

    const playerName = account?.username || '<unauthenticated>';
    const playerUuid = account?.uuid || '00000000000000000000000000000000';
    const userType = isUnauthenticatedOfflineToken ? 'legacy' : 'msa';

    let gameArguments: string[];
    if (metaJson?.minecraftArguments && !metaJson.arguments?.game) {
      // Legacy Minecraft (1.12.2, 1.8.9, 1.7.10, old_beta, old_alpha) template expansion
      const substitutions: Record<string, string> = {
        auth_player_name: playerName,
        version_name: profile.mcVersion,
        game_directory: instanceDir,
        assets_root: assetsDir,
        game_assets: path.join(assetsDir, 'virtual', 'legacy'),
        assets_index_name: assetIndexName,
        auth_uuid: playerUuid,
        auth_access_token: isUnauthenticatedOfflineToken ? '0' : '[REDACTED_MC_TOKEN]',
        user_properties: '{}',
        user_type: userType,
        version_type: versionDescriptor.type,
      };
      gameArguments = metaJson.minecraftArguments
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) =>
          tok.replace(/\$\{([^}]+)\}/g, (_, key: string) => substitutions[key] ?? tok)
        );
    } else {
      gameArguments = [
        '--username',
        playerName,
        '--version',
        profile.mcVersion,
        '--gameDir',
        instanceDir,
        '--assetsDir',
        assetsDir,
        '--assetIndex',
        assetIndexName,
        '--uuid',
        playerUuid,
        '--accessToken',
        isUnauthenticatedOfflineToken ? '0' : '[REDACTED_MC_TOKEN]',
        '--userType',
        userType,
        '--versionType',
        profile.loader === 'vanilla' ? 'Vespera-Vanilla/1.2.2' : 'Vespera-Fabric/1.2.2',
        '--width',
        String(profile.graphics.resolutionWidth),
        '--height',
        String(profile.graphics.resolutionHeight),
      ];
    }

    // Note: Genuine Offline Accounts (`offline_account`) keep multiplayer enabled for LAN & `online-mode=false` servers!
    // `--disableMultiplayer` is ONLY passed for the restricted Microsoft-account offline singleplayer fallback.
    if (sessionMode === 'offline_singleplayer') {
      gameArguments.push('--disableMultiplayer', '--disableChat');
    }

    const mainClass =
      profile.loader === 'vanilla'
        ? metaJson?.mainClass || 'net.minecraft.client.main.Main'
        : receipt?.mainClass || 'net.fabricmc.loader.impl.launch.knot.Client';

    const vesperaModActive =
      profile.loader === 'fabric' &&
      isVesperaCustomModCompatible(profile.mcVersion) &&
      profile.enabledModIds.includes('vespera-client');

    const enabledMods =
      profile.loader === 'vanilla'
        ? []
        : profile.enabledModIds
            .filter(
              (id) =>
                id !== 'vespera-client' || isVesperaCustomModCompatible(profile.mcVersion)
            )
            .map((id) => {
              const found = installedMods.find(
                (m) => m.id === id && m.enabled && m.mcVersion === profile.mcVersion
              );
              return found ? `${found.name} (${found.version})` : null;
            })
            .filter((x): x is string => Boolean(x));

    const javaExe = matchingJava?.path || 'javaw.exe';
    const commandPreview = `"${javaExe}" ${jvmArguments.join(' ')} ${mainClass} ${gameArguments.join(' ')}`;

    const authOk =
      sessionMode === 'offline_account'
        ? Boolean(account && account.accountType === 'offline')
        : sessionMode === 'offline_singleplayer'
          ? Boolean(account && account.ownsMinecraftJava && account.lastValidatedAt > 0 && receipt)
          : Boolean(
              account &&
                account.accountType === 'microsoft' &&
                account.ownsMinecraftJava &&
                account.sessionStatus !== 'signed_out'
            );

    return {
      ready:
        authOk &&
        !(profile.loader === 'fabric' && versionDescriptor.fabricSupported === false),
      profileId: profile.id,
      mcVersion: profile.mcVersion,
      loader: profile.loader,
      vesperaModActive,
      sessionMode,
      javaExecutable: javaExe,
      jvmArguments,
      gameArguments,
      mainClass,
      verifiedLibrariesCount: classpathEntries.length,
      enabledMods,
      warnings,
      commandPreview,
    };
  }

  /**
   * Installs/verifies all missing Minecraft files (if not already `ready`) and spawns the JVM process
   * in either Online Authenticated mode or Legitimate Offline Singleplayer mode.
   */
  public async installAndLaunchMinecraft(params: {
    profile: ClientProfile;
    settings: LauncherSettings;
    account: MinecraftAccount;
    mcAccessToken: string | null;
    sessionMode: 'offline_account' | 'online_authenticated' | 'offline_singleplayer';
    hudLayout: HudLayoutProfile;
    installedMods: InstalledModRecord[];
    shaderPacks: ShaderPackEntry[];
    totalSystemRamMb: number;
    onLog: (line: string) => void;
    onMultiplayerRejection?: (notice: MultiplayerRejectionNotice) => void;
    onProgress?: (progress: VersionDownloadProgress) => void;
  }): Promise<{ pid: number; instanceDir: string; sessionMode: string }> {
    const {
      profile,
      settings,
      account,
      mcAccessToken,
      sessionMode,
      hudLayout,
      installedMods,
      shaderPacks,
      totalSystemRamMb,
      onLog,
      onMultiplayerRejection,
      onProgress,
    } = params;

    if (sessionMode === 'online_authenticated') {
      if (account.accountType !== 'microsoft' || !account.ownsMinecraftJava || !mcAccessToken) {
        throw new Error(
          'Online-mode authenticated launch requires an active Microsoft account with verified Minecraft: Java Edition ownership.'
        );
      }
    } else if (sessionMode === 'offline_account') {
      if (account.accountType !== 'offline') {
        throw new Error('Offline account launch requires a local Offline Account profile.');
      }
    } else {
      if (!account.ownsMinecraftJava || account.lastValidatedAt <= 0) {
        throw new Error(
          'Offline Singleplayer fallback requires a Microsoft account previously verified on this device.'
        );
      }
    }

    // 1. Verify or run complete installation pipeline before launching
    const integrity = this.verifyVersionIntegrity(profile.mcVersion, settings);
    if (!integrity.healthy) {
      if (sessionMode === 'offline_singleplayer') {
        throw new Error(
          `Offline Singleplayer unavailable: Minecraft ${profile.mcVersion} files are missing or unverified (${integrity.issues[0]}). Install this version while online first.`
        );
      }
      onLog(
        `[VersionManager] Installing & verifying Minecraft ${profile.mcVersion} (${profile.loader})...`
      );
      await this.installMinecraftVersion({
        versionId: profile.mcVersion,
        loader: profile.loader,
        loaderVersion: profile.loaderVersion,
        profileId: profile.id,
        settings,
        onProgress,
      });
    }

    // 2. Materialize isolated profile directory & version-safe mods
    const { instanceDir, syncedModFiles } = this.materializeInstanceFiles(
      profile,
      settings,
      hudLayout,
      installedMods,
      shaderPacks
    );
    onLog(
      `[Instance] Prepared isolated directory ${instanceDir} (${profile.loader === 'vanilla' ? 'Vanilla — 0 mods' : `${syncedModFiles.length} compatible mods`}).`
    );

    // 3. Build launch report & ensure required Java runtime is installed
    let prep = this.prepareLaunchCommand({
      profile,
      settings,
      account,
      totalSystemRamMb,
      installedMods,
      sessionMode,
    });

    if (!fs.existsSync(prep.javaExecutable)) {
      const versionDesc = getVersionDescriptor(profile.mcVersion, this.cachedDescriptors);
      const major = versionDesc?.recommendedJavaMajor ?? 21;
      onLog(`[Java] Provisioning isolated Eclipse Temurin Java ${major} runtime...`);
      await this.provisionManagedJavaRuntime(major);
      prep = this.prepareLaunchCommand({
        profile,
        settings,
        account,
        totalSystemRamMb,
        installedMods,
        sessionMode,
      });
    }

    if (!prep.ready) {
      throw new Error(
        `Launch blocked by pre-flight checks: ${prep.warnings.join(' | ') || 'not ready'}`
      );
    }

    // Inject real access token ONLY in memory for online_authenticated; use '0' for offline_singleplayer
    const finalGameArgs = prep.gameArguments.map((arg) =>
      arg === '[REDACTED_MC_TOKEN]'
        ? sessionMode === 'online_authenticated' && mcAccessToken
          ? mcAccessToken
          : '0'
        : arg
    );

    const spawnArgs = [...prep.jvmArguments, prep.mainClass, ...finalGameArgs];
    onLog(
      `[Launch] Starting Minecraft ${profile.mcVersion} (${profile.loader.toUpperCase()}, ${
        sessionMode === 'offline_account'
          ? `OFFLINE ACCOUNT "${account.username}"`
          : sessionMode === 'offline_singleplayer'
            ? 'OFFLINE SINGLEPLAYER — multiplayer disabled'
            : `MICROSOFT AUTHENTICATED "${account.username}"`
      }) via ${prep.javaExecutable}...`
    );

    const child = spawn(prep.javaExecutable, spawnArgs, {
      cwd: instanceDir,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.activeChildProcess = child;
    this.activeMcVersion = profile.mcVersion;

    const inspectLine = (line: string, prefix: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      onLog(`${prefix} ${trimmed}`);
      const notice = classifyMultiplayerServerRejection(
        trimmed,
        account.accountType,
        account.username
      );
      if (notice && onMultiplayerRejection) {
        onMultiplayerRejection(notice);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        inspectLine(line, '[MC]');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        inspectLine(line, '[MC:ERR]');
      }
    });
    child.on('exit', (code) => {
      onLog(`[Launch] Minecraft ${profile.mcVersion} exited with code ${code ?? 0}.`);
      this.activeChildProcess = null;
      this.activeMcVersion = null;
    });

    return {
      pid: child.pid || 0,
      instanceDir,
      sessionMode,
    };
  }

  public isGameRunning(): {
    running: boolean;
    pid: number | null;
    mcVersion: string | null;
  } {
    return this.getRunningMinecraftStatus();
  }

  public getRunningMinecraftStatus(): {
    running: boolean;
    pid: number | null;
    mcVersion: string | null;
  } {
    if (this.activeChildProcess && this.activeChildProcess.exitCode === null) {
      return {
        running: true,
        pid: this.activeChildProcess.pid ?? null,
        mcVersion: this.activeMcVersion,
      };
    }
    return { running: false, pid: null, mcVersion: null };
  }
}
