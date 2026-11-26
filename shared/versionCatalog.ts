import type { MinecraftVersionDescriptor, SupportTier } from './types';

export interface RawMojangManifestEntry {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha' | string;
  url: string;
  time?: string;
  releaseTime: string;
  sha1?: string;
  complianceLevel?: number;
}

export interface RawMojangManifestV2 {
  latest?: {
    release?: string;
    snapshot?: string;
  };
  versions: RawMojangManifestEntry[];
}

/**
 * Parses semver-like release numbers ("1.21.4" -> [1, 21, 4], "1.8.9" -> [1, 8, 9], "1.20" -> [1, 20, 0]).
 * Returns null for snapshots / beta / alpha IDs.
 */
export function parseReleaseTuple(versionId: string): [number, number, number] | null {
  const m = versionId.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] !== undefined ? Number(m[3]) : 0];
}

/**
 * Infers required Java major version from Minecraft version ID & releaseTime when the per-version JSON
 * hasn't been fetched yet. Once `<id>.json` is fetched, `javaVersion.majorVersion` overrides this directly.
 */
export function inferJavaMajorForVersion(
  versionId: string,
  type: string,
  releaseTimeIso: string
): 8 | 17 | 21 {
  const tuple = parseReleaseTuple(versionId);
  if (tuple) {
    const [maj, min, patch] = tuple;
    if (maj > 1) return 21;
    if (min > 20 || (min === 20 && patch >= 5)) return 21; // 1.20.5+ requires Java 21
    if (min >= 17) return 17; // 1.17 .. 1.20.4 runs on Java 17 LTS
    return 8; // <= 1.16.5 (including 1.12.2, 1.8.9, 1.7.10) requires Java 8
  }

  if (type === 'old_beta' || type === 'old_alpha') {
    return 8;
  }

  // Snapshots / RCs / Pre-releases: infer by release timestamp
  const ts = Date.parse(releaseTimeIso);
  if (!Number.isNaN(ts)) {
    if (ts >= Date.parse('2024-04-01T00:00:00Z')) return 21;
    if (ts >= Date.parse('2021-05-01T00:00:00Z')) return 17;
    return 8;
  }
  return 21;
}

/**
 * Determines whether Vespera's compiled custom Kotlin Fabric mod (`vespera-client`) has a verified build
 * for the given Minecraft version. Never claims compatibility where no compiled JAR exists.
 */
export function isVesperaCustomModCompatible(versionId: string): boolean {
  return versionId === '1.21.4';
}

/**
 * Classifies any official Mojang `version_manifest_v2.json` entry into Vespera's version-aware
 * compatibility model without hardcoding a tiny list of versions.
 */
export function classifyMojangVersionEntry(
  entry: RawMojangManifestEntry
): MinecraftVersionDescriptor {
  const normType: MinecraftVersionDescriptor['type'] =
    entry.type === 'release' ||
    entry.type === 'snapshot' ||
    entry.type === 'old_beta' ||
    entry.type === 'old_alpha'
      ? entry.type
      : 'snapshot';

  const javaMajor = inferJavaMajorForVersion(entry.id, normType, entry.releaseTime);
  const tuple = parseReleaseTuple(entry.id);
  const vesperaModOk = isVesperaCustomModCompatible(entry.id);

  // Official Fabric Loader supports Minecraft >= 1.14 releases and modern snapshots (>= 2018-11)
  const isModernFabricRelease = Boolean(tuple && tuple[0] === 1 && tuple[1] >= 14);
  const releaseTs = Date.parse(entry.releaseTime);
  const isModernFabricSnapshot =
    normType === 'snapshot' &&
    !Number.isNaN(releaseTs) &&
    releaseTs >= Date.parse('2019-01-01T00:00:00Z');
  const isLegacy189 = entry.id === '1.8.9';

  const fabricOk = isModernFabricRelease || isModernFabricSnapshot;
  const sodiumOk = Boolean(tuple && tuple[0] === 1 && tuple[1] >= 16);
  const irisOk = Boolean(tuple && tuple[0] === 1 && tuple[1] >= 16);

  let supportTier: SupportTier;
  let compatibilityLabel: NonNullable<MinecraftVersionDescriptor['compatibilityLabel']>;
  let recommendedFabricLoader: string | null = null;
  let legacyNotes: string | undefined;
  let verifiedModsCount = 0;

  if (vesperaModOk) {
    supportTier = 'supported';
    compatibilityLabel = 'Vespera Supported';
    recommendedFabricLoader = '0.16.10';
    verifiedModsCount = 15;
  } else if (normType === 'snapshot') {
    supportTier = 'experimental';
    compatibilityLabel = 'Experimental';
    recommendedFabricLoader = fabricOk ? '0.16.10' : null;
    verifiedModsCount = fabricOk ? 4 : 0;
    legacyNotes =
      'Snapshot / pre-release build from official Mojang manifest. Vanilla launches directly; third-party Fabric mods may lag behind snapshot mappings.';
  } else if (isModernFabricRelease) {
    supportTier = 'fabric_supported';
    compatibilityLabel = 'Fabric Supported';
    recommendedFabricLoader = '0.16.10';
    verifiedModsCount = sodiumOk ? 12 : 4;
    legacyNotes =
      'Supports official Vanilla and Fabric Loader with isolated mod directory. Custom Vespera 1.21.4 HUD JAR is not injected on this version.';
  } else if (isLegacy189) {
    supportTier = 'legacy_pvp';
    compatibilityLabel = 'Vanilla Only';
    recommendedFabricLoader = '0.15.11-legacyfabric';
    verifiedModsCount = 0;
    legacyNotes =
      'Legacy 1.8.9 target (Java 8, LWJGL 2). Installs and launches cleanly as isolated official Vanilla (or Legacy Fabric) without modern 1.21 Sodium/Iris/Vespera mods.';
  } else {
    supportTier = 'vanilla_only';
    compatibilityLabel = 'Vanilla Only';
    recommendedFabricLoader = null;
    verifiedModsCount = 0;
    legacyNotes =
      normType === 'old_beta' || normType === 'old_alpha'
        ? 'Historical Minecraft archive build (Java 8). Runs in an isolated Vanilla game directory.'
        : `Legacy Minecraft ${entry.id} release (Java ${javaMajor}). Installs and launches as isolated official Vanilla.`;
  }

  return {
    id: entry.id,
    type: normType,
    supportTier,
    compatibilityLabel,
    recommendedJavaMajor: javaMajor,
    recommendedFabricLoader,
    fabricSupported: fabricOk,
    vanillaSupported: true,
    estimatedDownloadMb: javaMajor === 21 ? 72 : javaMajor === 17 ? 58 : 34,
    sha1: entry.sha1,
    legacyNotes,
    releaseTime: entry.releaseTime,
    manifestUrl: entry.url,
    verifiedModsCount,
    sodiumSupported: sodiumOk,
    irisSupported: irisOk,
    vesperaModSupported: vesperaModOk,
  };
}

/**
 * Converts a full official Mojang `version_manifest_v2.json` document into sorted newest-to-oldest
 * `MinecraftVersionDescriptor[]` entries across all categories (release, snapshot, old_beta, old_alpha).
 */
export function parseMojangManifestV2(manifest: RawMojangManifestV2): {
  versions: MinecraftVersionDescriptor[];
  latestReleaseId: string;
  latestSnapshotId: string;
} {
  const rawList = Array.isArray(manifest?.versions) ? manifest.versions : [];
  const descriptors = rawList
    .filter((e) => e && typeof e.id === 'string' && typeof e.url === 'string' && e.url.length > 0)
    .map((e) => classifyMojangVersionEntry(e))
    .sort((a, b) => {
      const ta = Date.parse(a.releaseTime) || 0;
      const tb = Date.parse(b.releaseTime) || 0;
      return tb - ta;
    });

  const firstRelease = descriptors.find((d) => d.type === 'release')?.id ?? '1.21.4';
  const firstSnapshot = descriptors.find((d) => d.type === 'snapshot')?.id ?? firstRelease;

  return {
    versions: descriptors,
    latestReleaseId: manifest?.latest?.release || firstRelease,
    latestSnapshotId: manifest?.latest?.snapshot || firstSnapshot,
  };
}

/**
 * Offline fallback seed manifest containing real Mojang Piston metadata URLs across modern releases,
 * snapshots, legacy releases (1.16.5, 1.12.2, 1.8.9, 1.7.10), Old Beta, and Old Alpha.
 * Whenever Mojang's CDN (`piston-meta.mojang.com`) is reachable or cached on disk, the full 850+ entry
 * dynamic manifest replaces this seed automatically.
 */
export const OFFICIAL_MOJANG_SEED_MANIFEST: RawMojangManifestV2 = {
  latest: {
    release: '1.21.4',
    snapshot: '25w09b',
  },
  versions: [
    {
      id: '25w09b',
      type: 'snapshot',
      url: 'https://piston-meta.mojang.com/v1/packages/cd80217508f3d8a7f13d19555ca43bc840d23ef4/25w09b.json',
      releaseTime: '2025-02-27T13:32:10+00:00',
    },
    {
      id: '1.21.4',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/a3bc7d72f5f2f5b4e4b457ef95e0b67d1b49d273/1.21.4.json',
      releaseTime: '2024-12-03T10:12:57+00:00',
    },
    {
      id: '1.21.3',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/21393b018bfbe6de97f36a4a9d96f008ffc7e4ab/1.21.3.json',
      releaseTime: '2024-10-23T13:17:09+00:00',
    },
    {
      id: '1.21.1',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/59ef10f8403025796e92c34801f3673d3d007f57/1.21.1.json',
      releaseTime: '2024-08-08T12:24:45+00:00',
    },
    {
      id: '1.20.6',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/45821f6f51b8902116479e653a07ca038eb9a9e5/1.20.6.json',
      releaseTime: '2024-04-29T12:41:59+00:00',
    },
    {
      id: '1.20.4',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/883210b3a05967d0c19d753b73f5b102f8b8e533/1.20.4.json',
      releaseTime: '2023-12-07T12:56:20+00:00',
    },
    {
      id: '1.20.1',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/715f3802f72301a49e8a8d8d679f5f59c4d19118/1.20.1.json',
      releaseTime: '2023-06-12T13:25:51+00:00',
    },
    {
      id: '1.19.4',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/ed7871a0e4fd4c3a407978f845e00bfcfcf7d0a6/1.19.4.json',
      releaseTime: '2023-03-14T12:56:18+00:00',
    },
    {
      id: '1.18.2',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/822082221c9b8f01d8f4e2a89efbb1e1bc49368f/1.18.2.json',
      releaseTime: '2022-02-28T10:42:45+00:00',
    },
    {
      id: '1.17.1',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/f63b69923c84c74bf40f53c2473be43da09d5901/1.17.1.json',
      releaseTime: '2021-07-06T12:04:40+00:00',
    },
    {
      id: '1.16.5',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/436877f330578e0a7e0886d80e0a710726862f2b/1.16.5.json',
      releaseTime: '2021-01-14T16:05:32+00:00',
    },
    {
      id: '1.14.4',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/132979c36455cc1e17e5f9cc767b4e13c6947033/1.14.4.json',
      releaseTime: '2019-07-19T09:25:47+00:00',
    },
    {
      id: '1.12.2',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/05e4b48fbc01f0385174bcff9751d3a652486c19/1.12.2.json',
      releaseTime: '2017-09-18T08:39:46+00:00',
    },
    {
      id: '1.8.9',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/f6ad102bcaa53b1a58358f16e376d548d44933ec/1.8.9.json',
      releaseTime: '2015-12-03T09:24:39+00:00',
    },
    {
      id: '1.7.10',
      type: 'release',
      url: 'https://piston-meta.mojang.com/v1/packages/2e818dc89e364c7efc554bec7e873c5f00b38400/1.7.10.json',
      releaseTime: '2014-05-14T17:29:23+00:00',
    },
    {
      id: 'b1.7.3',
      type: 'old_beta',
      url: 'https://piston-meta.mojang.com/v1/packages/4707c07c9a6a9c9646d121bc0f4ea67e56790d4a/b1.7.3.json',
      releaseTime: '2011-07-07T22:00:00+00:00',
    },
    {
      id: 'a1.2.6',
      type: 'old_alpha',
      url: 'https://piston-meta.mojang.com/v1/packages/9c85b8d0fe3fd4db5eb526b91c09c84418ae5462/a1.2.6.json',
      releaseTime: '2010-12-02T22:00:00+00:00',
    },
  ],
};

export const MINECRAFT_VERSION_CATALOG: MinecraftVersionDescriptor[] = [
  ...parseMojangManifestV2(OFFICIAL_MOJANG_SEED_MANIFEST).versions,
  {
    id: '1.12.2-forge',
    type: 'release',
    supportTier: 'unsupported',
    compatibilityLabel: 'Unsupported',
    recommendedJavaMajor: 8,
    recommendedFabricLoader: null,
    fabricSupported: false,
    vanillaSupported: false,
    legacyNotes:
      'Unsupported configuration: Legacy Minecraft Forge 1.12.2 FML coremods are not supported; select official Minecraft 1.12.2 above for Vanilla 1.12.2.',
    releaseTime: '2017-09-18T08:39:45+00:00',
    manifestUrl: '',
    verifiedModsCount: 0,
    sodiumSupported: false,
    irisSupported: false,
    vesperaModSupported: false,
  },
];

export function getVersionDescriptor(
  mcVersion: string,
  dynamicCatalog: MinecraftVersionDescriptor[] = MINECRAFT_VERSION_CATALOG
): MinecraftVersionDescriptor | undefined {
  const found = dynamicCatalog.find((v) => v.id === mcVersion);
  if (found) return found;
  if (!mcVersion || mcVersion.endsWith('-forge')) return undefined;
  return classifyMojangVersionEntry({
    id: mcVersion,
    type: parseReleaseTuple(mcVersion) ? 'release' : 'snapshot',
    url: '',
    releaseTime: new Date().toISOString(),
  });
}
