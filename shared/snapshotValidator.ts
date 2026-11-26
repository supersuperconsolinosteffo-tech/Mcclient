import { createDefaultClientProfiles, createDefaultLauncherSettings, createDefaultResourcePacks, createDefaultShaderPacks } from './defaultProfilesAndPacks';
import { createDefaultHudLayouts } from './hudDefaults';
import { CURATED_MOD_CATALOG } from './modCatalog';
import { PERFORMANCE_MODE_PRESETS } from './performanceEngine';
import type {
  AppStateSnapshot,
  BenchmarkScenarioResult,
  BenchmarkSuiteReport,
  ClientProfile,
  DiagnosticFinding,
  GarbageCollectorMode,
  LauncherSettings,
  ModCategory,
  PerformanceModeId,
  SystemTelemetry,
} from './types';
import { MINECRAFT_VERSION_CATALOG } from './versionCatalog';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const VALID_SEVERITIES = new Set<DiagnosticFinding['severity']>([
  'healthy',
  'info',
  'warning',
  'critical',
]);

const VALID_DIAG_CATEGORIES = new Set<DiagnosticFinding['category']>([
  'memory',
  'mod_conflict',
  'missing_dependency',
  'java_runtime',
  'graphics',
  'crash_analysis',
  'integrity',
]);

const VALID_PERF_MODES = new Set<PerformanceModeId>([
  'max_fps',
  'balanced',
  'visual_quality',
  'custom',
]);

const VALID_GC_MODES = new Set<GarbageCollectorMode>([
  'adaptive_g1gc',
  'generational_zgc',
  'shenandoah_low_pause',
]);

const VALID_MOD_CATEGORIES = new Set<ModCategory>([
  'performance',
  'rendering',
  'shaders',
  'visuals',
  'pvp_hud',
  'survival_qol',
  'utility',
  'library',
]);

export function normalizeDiagnosticFinding(
  raw: unknown,
  index: number
): DiagnosticFinding | null {
  if (!isRecord(raw)) {
    return null;
  }

  const rawSeverity = asString(raw.severity, 'info');
  const severity: DiagnosticFinding['severity'] = VALID_SEVERITIES.has(
    rawSeverity as DiagnosticFinding['severity']
  )
    ? (rawSeverity as DiagnosticFinding['severity'])
    : 'info';

  const rawCategory = asString(raw.category, 'integrity');
  const category: DiagnosticFinding['category'] = VALID_DIAG_CATEGORIES.has(
    rawCategory as DiagnosticFinding['category']
  )
    ? (rawCategory as DiagnosticFinding['category'])
    : 'integrity';

  const title = asNonEmptyString(raw.title, '');
  const explanation = asNonEmptyString(
    raw.explanation,
    asNonEmptyString(raw.detail, '')
  );
  const recommendation = asNonEmptyString(
    raw.recommendation,
    asNonEmptyString(raw.remediation, 'No action required.')
  );

  // Reject completely empty/malformed objects that carry neither title nor explanation
  if (!title && !explanation) {
    return null;
  }

  const finding: DiagnosticFinding = {
    id: asNonEmptyString(raw.id, `diag-normalized-${index}`),
    severity,
    category,
    title: title || 'Configuration Advisory',
    explanation: explanation || title,
    recommendation,
  };

  const actionCandidate =
    typeof raw.autoFixActionId === 'string' && raw.autoFixActionId.trim().length > 0
      ? raw.autoFixActionId.trim()
      : typeof raw.actionId === 'string' && raw.actionId.trim().length > 0
        ? raw.actionId.trim()
        : undefined;

  if (actionCandidate) {
    finding.autoFixActionId = actionCandidate;
  }

  return finding;
}

export interface NormalizedDiagnosticsResult {
  findings: DiagnosticFinding[];
  degradedReason: string | null;
}

/**
 * Validates and normalizes `diagnostics` payloads from any backend host (Native Win32 C++ or Node).
 * - Accepts canonical `DiagnosticFinding[]` arrays.
 * - Normalizes object-wrapped `{ findings: [...] }` or `{ diagnostics: [...] }` structures without losing data.
 * - Safely handles `null`, `undefined`, primitives, or malformed entries without throwing.
 */
export function normalizeDiagnosticsPayload(raw: unknown): NormalizedDiagnosticsResult {
  if (Array.isArray(raw)) {
    const findings: DiagnosticFinding[] = [];
    let droppedCount = 0;
    raw.forEach((entry, idx) => {
      const normalized = normalizeDiagnosticFinding(entry, idx);
      if (normalized) {
        findings.push(normalized);
      } else {
        droppedCount++;
      }
    });
    return {
      findings,
      degradedReason:
        droppedCount > 0
          ? `Ignored ${droppedCount} malformed diagnostic entr${droppedCount === 1 ? 'y' : 'ies'}.`
          : null,
    };
  }

  if (isRecord(raw)) {
    const embeddedArray = Array.isArray(raw.findings)
      ? raw.findings
      : Array.isArray(raw.items)
        ? raw.items
        : Array.isArray(raw.diagnostics)
          ? raw.diagnostics
          : null;

    if (embeddedArray) {
      const inner = normalizeDiagnosticsPayload(embeddedArray);
      return {
        findings: inner.findings,
        degradedReason: inner.degradedReason,
      };
    }

    // Check if a single finding object was passed directly
    const single = normalizeDiagnosticFinding(raw, 0);
    if (single) {
      return { findings: [single], degradedReason: null };
    }

    return {
      findings: [],
      degradedReason: 'Diagnostics subsystem returned an unrecognized object format.',
    };
  }

  if (raw === null || raw === undefined) {
    return {
      findings: [],
      degradedReason: 'Diagnostics data is temporarily unavailable.',
    };
  }

  return {
    findings: [],
    degradedReason: `Diagnostics subsystem returned unexpected ${typeof raw} data.`,
  };
}

function normalizeTelemetry(raw: unknown, fallbackHeapMb: number): SystemTelemetry {
  const rec = isRecord(raw) ? raw : {};
  const totalRam = Math.max(1024, asNumber(rec.totalSystemRamMb, 8192));
  const availRam = Math.max(0, Math.min(totalRam, asNumber(rec.availableSystemRamMb, 4096)));
  const inGameRaw = isRecord(rec.inGameMetrics) ? rec.inGameMetrics : {};

  return {
    timestamp: asNumber(rec.timestamp, Date.now()),
    hostOs: asNonEmptyString(rec.hostOs, 'Windows 10/11 x64'),
    hostArch: asNonEmptyString(rec.hostArch, 'x64'),
    cpuModel: asNonEmptyString(rec.cpuModel, 'x86_64 Processor'),
    cpuCoresLogical: Math.max(1, asNumber(rec.cpuCoresLogical, 4)),
    cpuUtilizationPercent: Math.max(0, Math.min(100, asNumber(rec.cpuUtilizationPercent, 0))),
    totalSystemRamMb: totalRam,
    availableSystemRamMb: availRam,
    usedSystemRamMb: Math.max(0, asNumber(rec.usedSystemRamMb, totalRam - availRam)),
    recommendedMinecraftRamMb: Math.max(1536, asNumber(rec.recommendedMinecraftRamMb, fallbackHeapMb)),
    launcherProcessRamMb: Math.max(1, asNumber(rec.launcherProcessRamMb, 24)),
    gpuAdapterName: typeof rec.gpuAdapterName === 'string' && rec.gpuAdapterName.length > 0 ? rec.gpuAdapterName : null,
    gpuUtilizationPercent: asNullableNumber(rec.gpuUtilizationPercent),
    minecraftRunning: asBoolean(rec.minecraftRunning, false),
    minecraftPid: asNullableNumber(rec.minecraftPid),
    inGameMetrics: {
      measured: asBoolean(inGameRaw.measured, false),
      fps: asNullableNumber(inGameRaw.fps),
      avgFrameTimeMs: asNullableNumber(inGameRaw.avgFrameTimeMs),
      onePercentLowFps: asNullableNumber(inGameRaw.onePercentLowFps),
      jvmHeapUsedMb: asNullableNumber(inGameRaw.jvmHeapUsedMb),
      jvmHeapAllocatedMb: asNullableNumber(inGameRaw.jvmHeapAllocatedMb) ?? fallbackHeapMb,
      serverPingMs: asNullableNumber(inGameRaw.serverPingMs),
      mcVersion: typeof inGameRaw.mcVersion === 'string' ? inGameRaw.mcVersion : null,
      activeModsCount: Math.max(0, asNumber(inGameRaw.activeModsCount, 0)),
      activeProfileName: asNonEmptyString(inGameRaw.activeProfileName, 'Default Profile'),
    },
  };
}

function normalizeBenchmarkReport(raw: unknown): BenchmarkSuiteReport | null {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    return null;
  }

  const condRaw = isRecord(raw.reproducibleConditions) ? raw.reproducibleConditions : {};
  const results: BenchmarkScenarioResult[] = [];

  for (const item of raw.results) {
    if (!isRecord(item)) continue;
    const mRaw = isRecord(item.metrics) ? item.metrics : {};
    results.push({
      scenarioId: asNonEmptyString(
        item.scenarioId,
        'vespera_balanced'
      ) as BenchmarkScenarioResult['scenarioId'],
      scenarioName: asNonEmptyString(item.scenarioName, 'Benchmark Scenario'),
      dataOrigin: asNonEmptyString(
        item.dataOrigin,
        'measured_jvm_and_pipeline'
      ) as BenchmarkScenarioResult['dataOrigin'],
      available: asBoolean(item.available, true),
      mcVersion: asNonEmptyString(item.mcVersion, '1.21.4'),
      resolution: asNonEmptyString(item.resolution, '1920x1080'),
      renderDistanceChunks: asNumber(item.renderDistanceChunks, 16),
      simulationDistanceChunks: asNumber(item.simulationDistanceChunks, 10),
      jvmGcMode: asNonEmptyString(item.jvmGcMode, 'adaptive_g1gc'),
      allocatedRamMb: asNumber(item.allocatedRamMb, 4096),
      testDurationMs: asNumber(item.testDurationMs, 0),
      metrics: {
        avgFps: asNullableNumber(mRaw.avgFps),
        onePercentLowFps: asNullableNumber(mRaw.onePercentLowFps),
        frameTimeStdDevMs: asNullableNumber(mRaw.frameTimeStdDevMs),
        p99FrameTimeMs: asNullableNumber(mRaw.p99FrameTimeMs),
        chunkMeshThroughputPerSec: asNullableNumber(mRaw.chunkMeshThroughputPerSec),
        cullingEfficiencyPercent: asNullableNumber(mRaw.cullingEfficiencyPercent),
        jvmColdStartupMs: asNullableNumber(mRaw.jvmColdStartupMs),
        worldLoadInitMs: asNullableNumber(mRaw.worldLoadInitMs),
        peakHeapUsedMb: asNullableNumber(mRaw.peakHeapUsedMb),
        gcPauseAvgMs: asNullableNumber(mRaw.gcPauseAvgMs),
        cpuUsagePercent: asNullableNumber(mRaw.cpuUsagePercent),
        gpuUsagePercent: asNullableNumber(mRaw.gpuUsagePercent),
      },
      notes: asString(item.notes, ''),
    });
  }

  if (results.length === 0) {
    return null;
  }

  return {
    runId: asNonEmptyString(raw.runId, 'bench-run'),
    executedAt: asNonEmptyString(raw.executedAt, new Date().toISOString()),
    hardwareSummary: asNonEmptyString(raw.hardwareSummary, 'Local Host Hardware'),
    javaRuntimeVersion: asNonEmptyString(raw.javaRuntimeVersion, 'OpenJDK 21 LTS'),
    reproducibleConditions: {
      mcVersion: asNonEmptyString(condRaw.mcVersion, '1.21.4'),
      resolution: asNonEmptyString(condRaw.resolution, '1920x1080'),
      renderDistance: asNumber(condRaw.renderDistance, 16),
      simulationDistance: asNumber(condRaw.simulationDistance, 10),
      sceneSeed: asNonEmptyString(condRaw.sceneSeed, 'vespera-deterministic-seed'),
      sampleFramesPerScenario: asNumber(condRaw.sampleFramesPerScenario, 260),
    },
    limitationsAndMethodology: Array.isArray(raw.limitationsAndMethodology)
      ? raw.limitationsAndMethodology.filter((x): x is string => typeof x === 'string')
      : [],
    results,
  };
}

function normalizeProfile(raw: unknown, fallback: ClientProfile): ClientProfile {
  if (!isRecord(raw)) return fallback;
  const perfRaw = isRecord(raw.performance) ? raw.performance : {};
  const gfxRaw = isRecord(raw.graphics) ? raw.graphics : {};

  const modeCandidate = asString(perfRaw.mode, fallback.performance.mode);
  const mode: PerformanceModeId = VALID_PERF_MODES.has(modeCandidate as PerformanceModeId)
    ? (modeCandidate as PerformanceModeId)
    : 'balanced';
  const presetPerf = PERFORMANCE_MODE_PRESETS[mode].performance;

  const gcCandidate = asString(perfRaw.gcMode, presetPerf.gcMode);
  const gcMode: GarbageCollectorMode = VALID_GC_MODES.has(gcCandidate as GarbageCollectorMode)
    ? (gcCandidate as GarbageCollectorMode)
    : presetPerf.gcMode;

  return {
    id: asNonEmptyString(raw.id, fallback.id),
    name: asNonEmptyString(raw.name, fallback.name),
    archetype: (typeof raw.archetype === 'string' ? raw.archetype : fallback.archetype) as ClientProfile['archetype'],
    description: asString(raw.description, fallback.description),
    mcVersion: asNonEmptyString(raw.mcVersion, fallback.mcVersion),
    loader:
      raw.loader === 'vanilla'
        ? 'vanilla'
        : raw.loader === 'legacy_fabric'
          ? 'legacy_fabric'
          : 'fabric',
    loaderVersion: asNonEmptyString(raw.loaderVersion, fallback.loaderVersion),
    vesperaModCompatible:
      typeof raw.vesperaModCompatible === 'boolean'
        ? raw.vesperaModCompatible
        : raw.mcVersion === '1.21.4',
    customJavaPath: typeof raw.customJavaPath === 'string' ? raw.customJavaPath : undefined,
    customGameDir: typeof raw.customGameDir === 'string' ? raw.customGameDir : undefined,
    performance: {
      ...fallback.performance,
      ...presetPerf,
      mode,
      allocatedRamMb: Math.max(1024, asNumber(perfRaw.allocatedRamMb, fallback.performance.allocatedRamMb)),
      autoRecommendRam: asBoolean(perfRaw.autoRecommendRam, fallback.performance.autoRecommendRam),
      gcMode,
      alwaysPreTouch: asBoolean(perfRaw.alwaysPreTouch, presetPerf.alwaysPreTouch),
      chunkBuilderThreads: asNumber(perfRaw.chunkBuilderThreads, presetPerf.chunkBuilderThreads),
      deferChunkUpdates: asBoolean(perfRaw.deferChunkUpdates, presetPerf.deferChunkUpdates),
      useBlockFaceCulling: asBoolean(perfRaw.useBlockFaceCulling, presetPerf.useBlockFaceCulling),
      useCompactVertexFormat: asBoolean(perfRaw.useCompactVertexFormat, presetPerf.useCompactVertexFormat),
      useFogOcclusion: asBoolean(perfRaw.useFogOcclusion, presetPerf.useFogOcclusion),
      useEntityCulling: asBoolean(perfRaw.useEntityCulling, presetPerf.useEntityCulling),
      entityCullingMaxDistance: asNumber(perfRaw.entityCullingMaxDistance, presetPerf.entityCullingMaxDistance),
      ImmediatelyFastBatching: asBoolean(perfRaw.ImmediatelyFastBatching, presetPerf.ImmediatelyFastBatching),
      ferriteMemoryDeduplication: asBoolean(perfRaw.ferriteMemoryDeduplication, presetPerf.ferriteMemoryDeduplication),
      dynamicBackgroundFpsLimit: asNumber(perfRaw.dynamicBackgroundFpsLimit, presetPerf.dynamicBackgroundFpsLimit),
      keepLauncherIdleOnRun: asBoolean(perfRaw.keepLauncherIdleOnRun, presetPerf.keepLauncherIdleOnRun),
      lowLatencyFramePacing: asBoolean(perfRaw.lowLatencyFramePacing, presetPerf.lowLatencyFramePacing),
    },
    graphics: {
      ...fallback.graphics,
      renderDistanceChunks: Math.max(2, Math.min(32, asNumber(gfxRaw.renderDistanceChunks, fallback.graphics.renderDistanceChunks))),
      simulationDistanceChunks: Math.max(5, Math.min(32, asNumber(gfxRaw.simulationDistanceChunks, fallback.graphics.simulationDistanceChunks))),
      maxFps: asNumber(gfxRaw.maxFps, fallback.graphics.maxFps),
      vsync: asBoolean(gfxRaw.vsync, fallback.graphics.vsync),
      fullscreenMode: (typeof gfxRaw.fullscreenMode === 'string'
        ? gfxRaw.fullscreenMode
        : fallback.graphics.fullscreenMode) as ClientProfile['graphics']['fullscreenMode'],
      resolutionWidth: Math.max(640, asNumber(gfxRaw.resolutionWidth, fallback.graphics.resolutionWidth)),
      resolutionHeight: Math.max(480, asNumber(gfxRaw.resolutionHeight, fallback.graphics.resolutionHeight)),
      guiScale: asNumber(gfxRaw.guiScale, fallback.graphics.guiScale),
      particles: (typeof gfxRaw.particles === 'string' ? gfxRaw.particles : fallback.graphics.particles) as ClientProfile['graphics']['particles'],
      entityDistancePercent: asNumber(gfxRaw.entityDistancePercent, fallback.graphics.entityDistancePercent),
      clouds: (typeof gfxRaw.clouds === 'string' ? gfxRaw.clouds : fallback.graphics.clouds) as ClientProfile['graphics']['clouds'],
      smoothLighting: (typeof gfxRaw.smoothLighting === 'string'
        ? gfxRaw.smoothLighting
        : fallback.graphics.smoothLighting) as ClientProfile['graphics']['smoothLighting'],
      entityShadows: asBoolean(gfxRaw.entityShadows, fallback.graphics.entityShadows),
      biomeBlendRadius: asNumber(gfxRaw.biomeBlendRadius, fallback.graphics.biomeBlendRadius),
      mipmapLevels: asNumber(gfxRaw.mipmapLevels, fallback.graphics.mipmapLevels) as 0 | 1 | 2 | 3 | 4,
      anisotropicFiltering: asNumber(gfxRaw.anisotropicFiltering, fallback.graphics.anisotropicFiltering) as 1 | 2 | 4 | 8 | 16,
      connectedTextures: asBoolean(gfxRaw.connectedTextures, fallback.graphics.connectedTextures),
      customEntityModels: asBoolean(gfxRaw.customEntityModels, fallback.graphics.customEntityModels),
      emissiveTextures: asBoolean(gfxRaw.emissiveTextures, fallback.graphics.emissiveTextures),
      animationsAllEnabled: asBoolean(gfxRaw.animationsAllEnabled, fallback.graphics.animationsAllEnabled),
      shaderQualityPreset: (typeof gfxRaw.shaderQualityPreset === 'string'
        ? gfxRaw.shaderQualityPreset
        : fallback.graphics.shaderQualityPreset) as ClientProfile['graphics']['shaderQualityPreset'],
    },
    hudLayoutId: asNonEmptyString(raw.hudLayoutId, fallback.hudLayoutId),
    enabledModIds: Array.isArray(raw.enabledModIds)
      ? Array.from(new Set(raw.enabledModIds.filter((x): x is string => typeof x === 'string')))
      : fallback.enabledModIds,
    activeShaderPackId: typeof raw.activeShaderPackId === 'string' && raw.activeShaderPackId.length > 0 ? raw.activeShaderPackId : null,
    enabledResourcePackIds: Array.isArray(raw.enabledResourcePackIds)
      ? Array.from(new Set(raw.enabledResourcePackIds.filter((x): x is string => typeof x === 'string')))
      : fallback.enabledResourcePackIds,
    createdAt: asNonEmptyString(raw.createdAt, fallback.createdAt),
    updatedAt: asNonEmptyString(raw.updatedAt, fallback.updatedAt),
    lastPlayedAt: typeof raw.lastPlayedAt === 'string' ? raw.lastPlayedAt : undefined,
  };
}

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

/**
 * Validates and normalizes an incoming `AppStateSnapshot` at the frontend RPC boundary.
 * Throws `SnapshotValidationError` only when the root payload itself is not a JSON object;
 * gracefully normalizes non-critical subsystems (`diagnostics`, `latestBenchmark`, `recentLogs`, etc.)
 * so a partial or legacy backend field never freezes launcher initialization.
 */
export function validateAndNormalizeSnapshot(raw: unknown): AppStateSnapshot {
  if (!isRecord(raw)) {
    throw new SnapshotValidationError(
      `Invalid engine state payload: expected object, received ${raw === null ? 'null' : typeof raw}.`
    );
  }

  const defaultProfiles = createDefaultClientProfiles(4096);
  const rawProfiles = Array.isArray(raw.profiles) && raw.profiles.length > 0 ? raw.profiles : defaultProfiles;
  const profiles: ClientProfile[] = rawProfiles.map((p, idx) =>
    normalizeProfile(p, defaultProfiles[idx % defaultProfiles.length])
  );

  const requestedActiveId = asString(raw.activeProfileId, profiles[0].id);
  const activeProfile = profiles.find((p) => p.id === requestedActiveId) ?? profiles[0];

  const defaultSettings = createDefaultLauncherSettings('VesperaClient');
  const setRaw = isRecord(raw.settings) ? raw.settings : {};
  const settings: LauncherSettings = {
    ...defaultSettings,
    gameDataDir: asNonEmptyString(setRaw.gameDataDir, defaultSettings.gameDataDir),
    instancesDir: asNonEmptyString(setRaw.instancesDir, defaultSettings.instancesDir),
    concurrentDownloads: Math.max(1, Math.min(32, asNumber(setRaw.concurrentDownloads, defaultSettings.concurrentDownloads))),
    bandwidthLimitMbps: Math.max(0, asNumber(setRaw.bandwidthLimitMbps, defaultSettings.bandwidthLimitMbps)),
    verifyFileHashes: asBoolean(setRaw.verifyFileHashes, defaultSettings.verifyFileHashes),
    keepLauncherOpen: asBoolean(setRaw.keepLauncherOpen, defaultSettings.keepLauncherOpen),
    minimizeToTrayOnLaunch: asBoolean(setRaw.minimizeToTrayOnLaunch, defaultSettings.minimizeToTrayOnLaunch),
    closeBehavior: (typeof setRaw.closeBehavior === 'string'
      ? setRaw.closeBehavior
      : defaultSettings.closeBehavior) as LauncherSettings['closeBehavior'],
    updateChannel: setRaw.updateChannel === 'beta' ? 'beta' : 'stable',
    autoCheckUpdates: asBoolean(setRaw.autoCheckUpdates, defaultSettings.autoCheckUpdates),
    autoBackupBeforeProfileUpdate: asBoolean(
      setRaw.autoBackupBeforeProfileUpdate,
      defaultSettings.autoBackupBeforeProfileUpdate
    ),
    language: (typeof setRaw.language === 'string'
      ? setRaw.language
      : defaultSettings.language) as LauncherSettings['language'],
    customJvmExtraArgs: asString(setRaw.customJvmExtraArgs, ''),
    customJavaExecutablePath: asString(setRaw.customJavaExecutablePath, ''),
    showSnapshotsInVersionList: asBoolean(setRaw.showSnapshotsInVersionList, false),
    showHistoricalInVersionList: asBoolean(setRaw.showHistoricalInVersionList, false),
    microsoftAzureClientId: asString(setRaw.microsoftAzureClientId, ''),
    crashRecoveryEnabled: asBoolean(setRaw.crashRecoveryEnabled, true),
    firstLaunchCompleted: asBoolean(setRaw.firstLaunchCompleted, false),
  };

  const diagNormalized = normalizeDiagnosticsPayload(raw.diagnostics);
  const diagnostics = [...diagNormalized.findings];
  if (diagNormalized.degradedReason && diagnostics.length === 0) {
    diagnostics.push({
      id: 'diag-subsystem-degraded',
      severity: 'info',
      category: 'integrity',
      title: 'Diagnostics Subsystem Degraded',
      explanation: diagNormalized.degradedReason,
      recommendation: 'Launcher core is operational. Click "Verify & Repair Files" to refresh diagnostics.',
    });
  }

  const installedMods = Array.isArray(raw.installedMods)
    ? raw.installedMods.filter(isRecord).map((m, idx) => {
        const rawCat = asString(m.category, 'utility');
        const category: ModCategory = VALID_MOD_CATEGORIES.has(rawCat as ModCategory)
          ? (rawCat as ModCategory)
          : 'utility';
        return {
          id: asNonEmptyString(m.id, `mod-${idx}`),
          slug: asNonEmptyString(m.slug, asNonEmptyString(m.id, `mod-${idx}`)),
          name: asNonEmptyString(m.name, `Mod ${idx + 1}`),
          version: asNonEmptyString(m.version, '1.0.0'),
          author: asNonEmptyString(m.author, 'Verified Author'),
          category,
          mcVersion: asNonEmptyString(m.mcVersion, activeProfile.mcVersion),
          loader: (m.loader === 'legacy_fabric' ? 'legacy_fabric' : 'fabric') as 'fabric' | 'legacy_fabric',
          fileName: asNonEmptyString(m.fileName, `${asNonEmptyString(m.id, `mod-${idx}`)}.jar`),
          enabled: asBoolean(m.enabled, true),
          source: (
            m.source === 'vespera_builtin' ||
            m.source === 'curated_verified' ||
            m.source === 'modrinth_api' ||
            m.source === 'local_import'
              ? m.source
              : 'modrinth_api'
          ) as AppStateSnapshot['installedMods'][number]['source'],
          sha256: asNonEmptyString(m.sha256, '0000000000000000'),
          sizeBytes: Math.max(0, asNumber(m.sizeBytes, 0)),
          installedAt: asNonEmptyString(m.installedAt, new Date().toISOString()),
          updateAvailable: typeof m.updateAvailable === 'string' ? m.updateAvailable : undefined,
          requiredDependencies: Array.isArray(m.requiredDependencies)
            ? m.requiredDependencies.filter((d): d is string => typeof d === 'string')
            : [],
          incompatibleWith: Array.isArray(m.incompatibleWith)
            ? m.incompatibleWith.filter((d): d is string => typeof d === 'string')
            : [],
          license: asNonEmptyString(m.license, 'Open Source'),
        };
      })
    : [];

  const defaultHudLayouts = createDefaultHudLayouts();
  const hudLayouts =
    Array.isArray(raw.hudLayouts) && raw.hudLayouts.length > 0
      ? (raw.hudLayouts.filter(isRecord).filter((h) => Array.isArray(h.elements) && h.elements.length > 0) as unknown as AppStateSnapshot['hudLayouts'])
      : defaultHudLayouts;

  return {
    version: asNonEmptyString(raw.version, '1.2.4'),
    platformMode:
      raw.platformMode === 'windows_native_webview2'
        ? 'windows_native_webview2'
        : 'node_preview_bridge',
    oauthConfig: isRecord(raw.oauthConfig)
      ? {
          configured: asBoolean(raw.oauthConfig.configured, false),
          source: (typeof raw.oauthConfig.source === 'string'
            ? raw.oauthConfig.source
            : 'unconfigured') as NonNullable<AppStateSnapshot['oauthConfig']>['source'],
          supportsPkceLoopback: asBoolean(raw.oauthConfig.supportsPkceLoopback, true),
          supportsDeviceCodeFallback: asBoolean(raw.oauthConfig.supportsDeviceCodeFallback, true),
          developerSetupDocPath: asNonEmptyString(
            raw.oauthConfig.developerSetupDocPath,
            'docs/OAUTH_DEVELOPER_SETUP.md'
          ),
        }
      : undefined,
    authFlow: isRecord(raw.authFlow)
      ? (raw.authFlow as unknown as AppStateSnapshot['authFlow'])
      : undefined,
    offlineAvailability: isRecord(raw.offlineAvailability)
      ? (raw.offlineAvailability as unknown as AppStateSnapshot['offlineAvailability'])
      : undefined,
    lastMultiplayerNotice: isRecord(raw.lastMultiplayerNotice)
      ? (raw.lastMultiplayerNotice as unknown as AppStateSnapshot['lastMultiplayerNotice'])
      : null,
    accounts: Array.isArray(raw.accounts)
      ? raw.accounts.filter(isRecord).map((a) => {
          const isOffline =
            a.accountType === 'offline' || a.authProvider === 'offline';
          return {
            ...(a as unknown as AppStateSnapshot['accounts'][number]),
            accountType: isOffline ? 'offline' : 'microsoft',
            authProvider: isOffline ? 'offline' : 'microsoft_oauth',
            sessionStatus: isOffline
              ? 'offline_ready'
              : ((typeof a.sessionStatus === 'string'
                  ? a.sessionStatus
                  : 'valid') as AppStateSnapshot['accounts'][number]['sessionStatus']),
            ownsMinecraftJava: isOffline ? false : asBoolean(a.ownsMinecraftJava, false),
          };
        })
      : [],
    activeAccountId: typeof raw.activeAccountId === 'string' && raw.activeAccountId.length > 0 ? raw.activeAccountId : null,
    versions:
      Array.isArray(raw.versions) && raw.versions.length > 0
        ? (raw.versions.filter(isRecord) as unknown as AppStateSnapshot['versions'])
        : MINECRAFT_VERSION_CATALOG,
    latestReleaseId: typeof raw.latestReleaseId === 'string' ? raw.latestReleaseId : '1.21.4',
    latestSnapshotId: typeof raw.latestSnapshotId === 'string' ? raw.latestSnapshotId : undefined,
    manifestSource:
      raw.manifestSource === 'live_mojang' ||
      raw.manifestSource === 'local_cache' ||
      raw.manifestSource === 'embedded_seed'
        ? raw.manifestSource
        : 'embedded_seed',
    activeDownload: isRecord(raw.activeDownload)
      ? (raw.activeDownload as unknown as AppStateSnapshot['activeDownload'])
      : null,
    javaRuntimes: Array.isArray(raw.javaRuntimes)
      ? (raw.javaRuntimes.filter(isRecord) as unknown as AppStateSnapshot['javaRuntimes'])
      : [],
    profiles,
    activeProfileId: activeProfile.id,
    profileBackups: Array.isArray(raw.profileBackups)
      ? (raw.profileBackups.filter((b): b is Record<string, unknown> => isRecord(b) && isRecord(b.snapshot)) as unknown as AppStateSnapshot['profileBackups'])
      : [],
    installedMods,
    curatedCatalog:
      Array.isArray(raw.curatedCatalog) && raw.curatedCatalog.length > 0
        ? (raw.curatedCatalog.filter(isRecord) as unknown as AppStateSnapshot['curatedCatalog'])
        : CURATED_MOD_CATALOG,
    modHistory: Array.isArray(raw.modHistory)
      ? (raw.modHistory.filter(isRecord) as unknown as AppStateSnapshot['modHistory'])
      : [],
    shaderPacks:
      Array.isArray(raw.shaderPacks) && raw.shaderPacks.length > 0
        ? (raw.shaderPacks.filter(isRecord) as unknown as AppStateSnapshot['shaderPacks'])
        : createDefaultShaderPacks(),
    resourcePacks:
      Array.isArray(raw.resourcePacks) && raw.resourcePacks.length > 0
        ? (raw.resourcePacks.filter(isRecord) as unknown as AppStateSnapshot['resourcePacks'])
        : createDefaultResourcePacks(),
    hudLayouts: hudLayouts.length > 0 ? hudLayouts : defaultHudLayouts,
    settings,
    telemetry: normalizeTelemetry(raw.telemetry, activeProfile.performance.allocatedRamMb),
    diagnostics,
    latestBenchmark: normalizeBenchmarkReport(raw.latestBenchmark),
    recentLogs: Array.isArray(raw.recentLogs)
      ? raw.recentLogs.filter((l): l is string => typeof l === 'string')
      : [],
  };
}
