export type SupportTier =
  | 'vespera_supported'
  | 'fabric_supported'
  | 'vanilla_only'
  | 'supported'
  | 'experimental'
  | 'legacy_pvp'
  | 'unsupported';

export type VersionInstallStatus =
  | 'not_installed'
  | 'metadata_cached'
  | 'partially_downloaded'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'ready'
  | 'update_available'
  | 'failed';

export type ModloaderType = 'vanilla' | 'fabric' | 'legacy_fabric';

export type PerformanceModeId = 'max_fps' | 'balanced' | 'visual_quality' | 'custom';

export type GarbageCollectorMode = 'adaptive_g1gc' | 'generational_zgc' | 'shenandoah_low_pause';

export type ModCategory =
  | 'performance'
  | 'rendering'
  | 'shaders'
  | 'visuals'
  | 'pvp_hud'
  | 'survival_qol'
  | 'utility'
  | 'library';

export type PageId =
  | 'home'
  | 'play'
  | 'mods'
  | 'performance'
  | 'graphics'
  | 'shaders'
  | 'resourcepacks'
  | 'accounts'
  | 'profiles'
  | 'settings'
  | 'diagnostics'
  | 'about';

export interface MinecraftVersionDescriptor {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  supportTier: SupportTier;
  compatibilityLabel?:
    | 'Vespera Supported'
    | 'Fabric Supported'
    | 'Vanilla Only'
    | 'Experimental'
    | 'Unsupported';
  recommendedJavaMajor: 8 | 17 | 21;
  recommendedFabricLoader: string | null;
  fabricSupported?: boolean;
  vanillaSupported?: boolean;
  installStatus?: VersionInstallStatus;
  estimatedDownloadMb?: number;
  sha1?: string;
  legacyNotes?: string;
  releaseTime: string;
  manifestUrl: string;
  verifiedModsCount: number;
  sodiumSupported: boolean;
  irisSupported: boolean;
  vesperaModSupported: boolean;
}

export interface VersionDownloadProgress {
  active: boolean;
  versionId: string | null;
  profileId: string | null;
  loader: ModloaderType;
  status: VersionInstallStatus;
  stage: string;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  completedFiles: number;
  totalFiles: number;
  cancellable: boolean;
  error: string | null;
}

export interface JavaRuntimeInfo {
  major: 8 | 17 | 21;
  vendor: string;
  version: string;
  architecture: 'x64';
  path: string;
  installed: boolean;
  verifiedSha256: boolean;
  source: 'bundled_managed' | 'system_detected' | 'adoptium_temurin' | 'user_custom';
}

export interface MinecraftAccount {
  id: string;
  uuid: string;
  username: string;
  accountType: 'offline' | 'microsoft';
  xuid?: string;
  skinUrl?: string;
  authProvider: 'offline' | 'microsoft_oauth';
  tokenExpiresAt: number;
  lastValidatedAt: number;
  createdAt?: string;
  sessionStatus: 'offline_ready' | 'valid' | 'refresh_required' | 'expired' | 'signed_out';
  skinAvatarSeed: string;
  active: boolean;
  ownsMinecraftJava: boolean;
}

export interface MultiplayerRejectionNotice {
  timestamp: string;
  accountType: 'offline' | 'microsoft';
  username: string;
  reasonCode: 'online_mode_required' | 'microsoft_session_expired';
  title: string;
  message: string;
}

export interface OAuthAppConfigState {
  configured: boolean;
  source:
    | 'env_override'
    | 'developer_local'
    | 'development_config'
    | 'release_config'
    | 'unconfigured';
  supportsPkceLoopback: boolean;
  supportsDeviceCodeFallback: boolean;
  developerSetupDocPath: string;
}

export type AuthProgressStep =
  | 'opening_browser'
  | 'waiting_for_login'
  | 'verifying_microsoft'
  | 'connecting_xbox'
  | 'checking_ownership'
  | 'retrieving_profile';

export type AuthErrorCode =
  | 'missing_app_config'
  | 'user_cancelled'
  | 'invalid_client_id'
  | 'invalid_redirect_uri'
  | 'microsoft_auth_failed'
  | 'xbox_auth_failed'
  | 'xsts_auth_failed'
  | 'no_minecraft_entitlement'
  | 'no_minecraft_profile'
  | 'network_error'
  | 'token_expired'
  | 'callback_timeout'
  | 'browser_launch_failed'
  | 'invalid_callback';

export interface AuthFlowState {
  mode: 'idle' | 'pkce_browser' | 'device_code' | 'completed' | 'cancelled' | 'error';
  step?: AuthProgressStep;
  errorCode?: AuthErrorCode;
  userTitle?: string;
  authorizeUrl?: string;
  redirectUri?: string;
  browserOpened?: boolean;
  startedAt?: number;
  expiresAt?: number;
  deviceChallenge?: DeviceCodeAuthChallenge | null;
  message: string;
  technicalDetail?: string;
}

export interface OfflineAvailabilityState {
  eligible: boolean;
  verifiedAccountId: string | null;
  verifiedUsername: string | null;
  verifiedUuid: string | null;
  lastOnlineAuthAt: number | null;
  localGameReady: boolean;
  activeSessionMode: 'online_authenticated' | 'offline_singleplayer';
  restrictions: string[];
  statusReason: string;
}

export interface DeviceCodeAuthChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
  startedAt: number;
  clientIdConfigured: boolean;
  statusMessage: string;
}

export interface CuratedModEntry {
  id: string;
  modrinthProjectId: string;
  slug: string;
  name: string;
  author: string;
  summary: string;
  category: ModCategory;
  license: string;
  loader: 'fabric' | 'legacy_fabric';
  supportedMcVersions: string[];
  requiredDependencies: string[];
  incompatibleWith: string[];
  defaultEnabledInModes: PerformanceModeId[];
  performanceImpact: {
    fpsGainEstimate: string;
    ramImpact: string;
    visualImpact: 'none' | 'enhances_visuals' | 'configurable';
    technicalMechanism: string;
  };
  bundledByDefault: boolean;
  verifiedSha512Prefix: string;
  versionByMc: Record<string, { versionNumber: string; fileName: string; downloadUrl: string; sha256?: string }>;
}

export interface InstalledModRecord {
  id: string;
  slug: string;
  name: string;
  version: string;
  author: string;
  category: ModCategory;
  mcVersion: string;
  loader: 'fabric' | 'legacy_fabric';
  fileName: string;
  enabled: boolean;
  source: 'vespera_builtin' | 'curated_verified' | 'modrinth_api' | 'local_import';
  sha256: string;
  sizeBytes: number;
  installedAt: string;
  updateAvailable?: string;
  requiredDependencies: string[];
  incompatibleWith: string[];
  license: string;
}

export interface ModInstallCheckResult {
  allowed: boolean;
  modId: string;
  targetMcVersion: string;
  loaderCompatible: boolean;
  versionCompatible: boolean;
  missingDependencies: string[];
  conflictingMods: string[];
  integrityVerified: boolean;
  reasons: string[];
  warnings: string[];
}

export interface ModHistoryEvent {
  id: string;
  timestamp: string;
  profileId: string;
  action: 'install' | 'update' | 'enable' | 'disable' | 'remove' | 'rollback';
  modName: string;
  version: string;
  details: string;
}

export interface PerformanceSettings {
  mode: PerformanceModeId;
  allocatedRamMb: number;
  autoRecommendRam: boolean;
  gcMode: GarbageCollectorMode;
  alwaysPreTouch: boolean;
  chunkBuilderThreads: number; // 0 = auto optimal
  deferChunkUpdates: boolean;
  useBlockFaceCulling: boolean;
  useCompactVertexFormat: boolean;
  useFogOcclusion: boolean;
  useEntityCulling: boolean;
  entityCullingMaxDistance: number;
  ImmediatelyFastBatching: boolean;
  ferriteMemoryDeduplication: boolean;
  dynamicBackgroundFpsLimit: number; // e.g., 30 FPS when unfocused
  keepLauncherIdleOnRun: boolean;
  lowLatencyFramePacing: boolean;
}

export interface GraphicsSettings {
  renderDistanceChunks: number; // 2 - 32 (default 12-16, never downgraded to tiny!)
  simulationDistanceChunks: number; // 5 - 32
  maxFps: number; // 0 = unlimited, or 60..360
  vsync: boolean;
  fullscreenMode: 'windowed' | 'borderless_fullscreen' | 'exclusive_fullscreen';
  resolutionWidth: number;
  resolutionHeight: number;
  guiScale: number; // 0 = auto, 1-4
  particles: 'all' | 'decreased' | 'minimal';
  entityDistancePercent: number; // 50 - 500%
  clouds: 'fancy' | 'fast' | 'off';
  smoothLighting: 'maximum' | 'minimum' | 'off';
  entityShadows: boolean;
  biomeBlendRadius: number; // 0, 3, 5, 7
  mipmapLevels: 0 | 1 | 2 | 3 | 4;
  anisotropicFiltering: 1 | 2 | 4 | 8 | 16;
  connectedTextures: boolean;
  customEntityModels: boolean;
  emissiveTextures: boolean;
  animationsAllEnabled: boolean;
  shaderQualityPreset: 'off' | 'competitive_lite' | 'balanced_pbr' | 'cinematic_ultra';
}

export interface ShaderPackEntry {
  id: string;
  name: string;
  author: string;
  fileName: string;
  installed: boolean;
  active: boolean;
  presetSupport: ('low' | 'medium' | 'high' | 'ultra')[];
  selectedProfile: 'low' | 'medium' | 'high' | 'ultra';
  irisCompatible: boolean;
  sodiumMinVersion: string;
  estimatedGpuLoad: 'light' | 'moderate' | 'heavy';
  shadowMapResolution: 1024 | 2048 | 4096;
  handheldDynamicLight: boolean;
  description: string;
}

export interface ResourcePackEntry {
  id: string;
  name: string;
  author: string;
  fileName: string;
  resolution: '16x' | '32x' | '64x' | '128x' | '256x' | '512x';
  packFormat: number;
  compatibleMcRange: string;
  compatibleWithCurrent: boolean;
  compatibilityWarning?: string;
  enabled: boolean;
  priorityOrder: number;
  estimatedVramMb: number;
  category: 'pvp_clean' | 'faithful_hd' | 'pbr_realistic' | 'connected_ctm' | 'utility';
  accentColor: string;
  description: string;
}

export type HudElementType =
  | 'fps'
  | 'cps'
  | 'keystrokes'
  | 'ping'
  | 'armor_status'
  | 'potion_effects'
  | 'coordinates'
  | 'direction_compass'
  | 'speedometer'
  | 'toggle_sprint'
  | 'custom_crosshair'
  | 'server_info'
  | 'memory_hud'
  | 'pack_badge';

export interface HudElementConfig {
  id: HudElementType;
  name: string;
  category: 'pvp' | 'survival' | 'telemetry';
  enabled: boolean;
  xPercent: number; // 0..100 normalized viewport X
  yPercent: number; // 0..100 normalized viewport Y
  widthPx: number;
  heightPx: number;
  scale: number; // 0.5 .. 2.5
  foregroundColor: string;
  backgroundColor: string;
  accentColor: string;
  backgroundOpacity: number; // 0.0 .. 1.0
  showBorder: boolean;
  showShadow: boolean;
  chromaWave: boolean;
  options: Record<string, boolean | number | string>;
}

export interface HudLayoutProfile {
  id: string;
  name: string;
  description: string;
  elements: HudElementConfig[];
  zoomKeybind: string;
  zoomDefaultFactor: number;
  zoomSmoothScroll: boolean;
  customHitParticles: 'vanilla' | 'sharpness_spark' | 'crit_amber' | 'minimal';
  chatCompactStacking: boolean;
  chatTimestamps: boolean;
  richItemTooltips: boolean;
  minimapEnabled: boolean;
  minimapFairPlayMode: boolean;
}

export interface ClientProfile {
  id: string;
  name: string;
  archetype: 'pvp' | 'survival' | 'vanilla_plus' | 'performance' | 'graphics' | 'custom';
  description: string;
  mcVersion: string;
  loader: ModloaderType;
  loaderVersion: string;
  vesperaModCompatible?: boolean;
  customJavaPath?: string;
  customGameDir?: string;
  performance: PerformanceSettings;
  graphics: GraphicsSettings;
  hudLayoutId: string;
  enabledModIds: string[];
  activeShaderPackId: string | null;
  enabledResourcePackIds: string[];
  createdAt: string;
  updatedAt: string;
  lastPlayedAt?: string;
}

export interface ProfileSnapshotBackup {
  id: string;
  profileId: string;
  profileName: string;
  reason: string;
  createdAt: string;
  snapshot: ClientProfile;
}

export interface LauncherSettings {
  gameDataDir: string;
  instancesDir: string;
  concurrentDownloads: number;
  bandwidthLimitMbps: number; // 0 = unlimited
  verifyFileHashes: boolean;
  keepLauncherOpen: boolean;
  minimizeToTrayOnLaunch: boolean;
  closeBehavior: 'minimize_idle' | 'keep_open' | 'exit_launcher';
  updateChannel: 'stable' | 'beta';
  autoCheckUpdates: boolean;
  autoBackupBeforeProfileUpdate: boolean;
  language: 'en-US' | 'it-IT' | 'de-DE' | 'fr-FR' | 'es-ES';
  customJvmExtraArgs: string;
  customJavaExecutablePath?: string;
  showSnapshotsInVersionList?: boolean;
  showHistoricalInVersionList?: boolean;
  microsoftAzureClientId: string;
  crashRecoveryEnabled: boolean;
  firstLaunchCompleted: boolean;
}

export interface SystemTelemetry {
  timestamp: number;
  hostOs: string;
  hostArch: string;
  cpuModel: string;
  cpuCoresLogical: number;
  cpuUtilizationPercent: number;
  totalSystemRamMb: number;
  availableSystemRamMb: number;
  usedSystemRamMb: number;
  recommendedMinecraftRamMb: number;
  launcherProcessRamMb: number;
  gpuAdapterName: string | null;
  gpuUtilizationPercent: number | null; // null when hardware counter unavailable — never fabricated!
  minecraftRunning: boolean;
  minecraftPid: number | null;
  inGameMetrics: {
    measured: boolean;
    fps: number | null;
    avgFrameTimeMs: number | null;
    onePercentLowFps: number | null;
    jvmHeapUsedMb: number | null;
    jvmHeapAllocatedMb: number | null;
    serverPingMs: number | null;
    mcVersion: string | null;
    activeModsCount: number;
    activeProfileName: string;
  };
}

export interface DiagnosticFinding {
  id: string;
  severity: 'healthy' | 'info' | 'warning' | 'critical';
  category: 'memory' | 'mod_conflict' | 'missing_dependency' | 'java_runtime' | 'graphics' | 'crash_analysis' | 'integrity';
  title: string;
  explanation: string;
  recommendation: string;
  autoFixActionId?: string;
}

export interface BenchmarkScenarioResult {
  scenarioId: 'vanilla_baseline' | 'vespera_max_fps' | 'vespera_balanced' | 'vespera_visual_quality' | 'vespera_custom' | 'lunar_comparison';
  scenarioName: string;
  dataOrigin: 'measured_jvm_and_pipeline' | 'measured_ingame_session' | 'not_installed_in_environment';
  available: boolean;
  mcVersion: string;
  resolution: string;
  renderDistanceChunks: number;
  simulationDistanceChunks: number;
  jvmGcMode: string;
  allocatedRamMb: number;
  testDurationMs: number;
  metrics: {
    avgFps: number | null;
    onePercentLowFps: number | null;
    frameTimeStdDevMs: number | null;
    p99FrameTimeMs: number | null;
    chunkMeshThroughputPerSec: number | null;
    cullingEfficiencyPercent: number | null;
    jvmColdStartupMs: number | null;
    worldLoadInitMs: number | null;
    peakHeapUsedMb: number | null;
    gcPauseAvgMs: number | null;
    cpuUsagePercent: number | null;
    gpuUsagePercent: number | null;
  };
  notes: string;
}

export interface BenchmarkSuiteReport {
  runId: string;
  executedAt: string;
  hardwareSummary: string;
  javaRuntimeVersion: string;
  reproducibleConditions: {
    mcVersion: string;
    resolution: string;
    renderDistance: number;
    simulationDistance: number;
    sceneSeed: string;
    sampleFramesPerScenario: number;
  };
  limitationsAndMethodology: string[];
  results: BenchmarkScenarioResult[];
}

export interface LaunchPreparationReport {
  ready: boolean;
  profileId: string;
  mcVersion: string;
  loader?: ModloaderType;
  vesperaModActive?: boolean;
  sessionMode?: 'offline_account' | 'online_authenticated' | 'offline_singleplayer';
  javaExecutable: string;
  jvmArguments: string[];
  gameArguments: string[];
  mainClass: string;
  verifiedLibrariesCount: number;
  enabledMods: string[];
  warnings: string[];
  commandPreview: string;
}

export interface AppStateSnapshot {
  version: string;
  platformMode: 'windows_native_webview2' | 'node_preview_bridge';
  oauthConfig?: OAuthAppConfigState;
  authFlow?: AuthFlowState;
  offlineAvailability?: OfflineAvailabilityState;
  lastMultiplayerNotice?: MultiplayerRejectionNotice | null;
  accounts: MinecraftAccount[];
  activeAccountId: string | null;
  versions: MinecraftVersionDescriptor[];
  latestReleaseId?: string;
  latestSnapshotId?: string;
  manifestSource?: 'live_mojang' | 'local_cache' | 'embedded_seed';
  activeDownload?: VersionDownloadProgress | null;
  javaRuntimes: JavaRuntimeInfo[];
  profiles: ClientProfile[];
  activeProfileId: string;
  profileBackups: ProfileSnapshotBackup[];
  installedMods: InstalledModRecord[];
  curatedCatalog: CuratedModEntry[];
  modHistory: ModHistoryEvent[];
  shaderPacks: ShaderPackEntry[];
  resourcePacks: ResourcePackEntry[];
  hudLayouts: HudLayoutProfile[];
  settings: LauncherSettings;
  telemetry: SystemTelemetry;
  diagnostics: DiagnosticFinding[];
  latestBenchmark: BenchmarkSuiteReport | null;
  recentLogs: string[];
}
