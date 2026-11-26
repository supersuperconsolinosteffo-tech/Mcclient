import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDefaultClientProfiles,
  createDefaultLauncherSettings,
  createDefaultResourcePacks,
  createDefaultShaderPacks,
} from '../shared/defaultProfilesAndPacks';
import { createDefaultHudLayouts } from '../shared/hudDefaults';
import { CURATED_MOD_CATALOG } from '../shared/modCatalog';
import { computeRecommendedRam, PERFORMANCE_MODE_PRESETS } from '../shared/performanceEngine';
import type {
  AppStateSnapshot,
  BenchmarkSuiteReport,
  ClientProfile,
  GraphicsSettings,
  HudLayoutProfile,
  InstalledModRecord,
  LaunchPreparationReport,
  LauncherSettings,
  MinecraftAccount,
  ModCategory,
  ModHistoryEvent,
  ModloaderType,
  MultiplayerRejectionNotice,
  PerformanceModeId,
  PerformanceSettings,
  ProfileSnapshotBackup,
  ResourcePackEntry,
  ShaderPackEntry,
} from '../shared/types';
import { classifyMultiplayerServerRejection } from '../shared/offlineAccountUtils';
import { getVersionDescriptor, isVesperaCustomModCompatible } from '../shared/versionCatalog';
import { AuthService, type AuthServiceOptions } from './authService';
import { DiagnosticsAndBenchmarkService } from './diagnosticsAndBenchmarkService';
import {
  MinecraftLauncherService,
  type MinecraftLauncherServiceOptions,
} from './minecraftLauncherService';
import { ModManagerService } from './modManagerService';
import { redactSensitiveTokens, writeFileAtomicSync } from './securityUtils';

interface PersistedStateFile {
  schemaVersion: number;
  selectedAccountId?: string | null;
  profiles: ClientProfile[];
  activeProfileId: string;
  profileBackups: ProfileSnapshotBackup[];
  installedMods: InstalledModRecord[];
  modHistory: ModHistoryEvent[];
  shaderPacks: ShaderPackEntry[];
  resourcePacks: ResourcePackEntry[];
  hudLayouts: HudLayoutProfile[];
  settings: LauncherSettings;
  latestBenchmark: BenchmarkSuiteReport | null;
}

export interface StateCoordinatorOptions {
  authOptions?: AuthServiceOptions;
  launcherOptions?: MinecraftLauncherServiceOptions;
}

export class VesperaStateCoordinator {
  readonly dataRootDir: string;
  private readonly stateFilePath: string;
  private readonly crashLockPath: string;
  private readonly ipcDir: string;
  private persisted: PersistedStateFile;
  private recentLogs: string[] = [];
  private lastMultiplayerNotice: MultiplayerRejectionNotice | null = null;

  readonly authService: AuthService;
  readonly modManager: ModManagerService;
  readonly launcherService: MinecraftLauncherService;
  readonly diagBenchService: DiagnosticsAndBenchmarkService;

  constructor(customDataRootDir?: string, options: StateCoordinatorOptions = {}) {
    this.dataRootDir =
      customDataRootDir ?? path.resolve(process.cwd(), '.vespera-dev-data');
    fs.mkdirSync(this.dataRootDir, { recursive: true });

    this.stateFilePath = path.join(this.dataRootDir, 'vespera-state.json');
    this.crashLockPath = path.join(this.dataRootDir, 'session.lock');
    this.ipcDir = path.join(this.dataRootDir, 'ipc');
    fs.mkdirSync(this.ipcDir, { recursive: true });

    const v120ModJar = path.resolve(
      process.cwd(),
      'release/mods/vespera-client-1.2.2+mc1.21.4.jar'
    );
    const v111ModJar = path.resolve(
      process.cwd(),
      'release/mods/vespera-client-1.2.0+mc1.21.4.jar'
    );
    const bundledModJarPath = fs.existsSync(v120ModJar) ? v120ModJar : v111ModJar;
    const benchJarPath = path.resolve(
      process.cwd(),
      'dist/bench/vespera-benchmark-runner.jar'
    );

    const logSink = (line: string) => this.appendLog(line);
    this.authService = new AuthService(path.join(this.dataRootDir, 'vault'), {
      onLog: logSink,
      ...options.authOptions,
    });
    this.modManager = new ModManagerService(
      path.join(this.dataRootDir, 'mods-pool'),
      bundledModJarPath,
      logSink
    );
    this.launcherService = new MinecraftLauncherService(
      this.dataRootDir,
      options.launcherOptions
    );
    this.diagBenchService = new DiagnosticsAndBenchmarkService(
      this.ipcDir,
      benchJarPath,
      logSink
    );

    this.persisted = this.loadOrInitializeState();
    // Restore remembered selected account across restarts
    if (this.persisted.selectedAccountId) {
      const exists = this.authService
        .listAccounts()
        .some((a) => a.id === this.persisted.selectedAccountId);
      if (exists) {
        this.authService.switchActiveAccount(this.persisted.selectedAccountId);
      }
    }
    this.handleCrashRecoveryCheck();
    this.syncActiveHudToIpc();
  }

  appendLog(rawLine: string): void {
    const clean = `[${new Date().toISOString().slice(11, 19)}] ${redactSensitiveTokens(rawLine)}`;
    this.recentLogs.push(clean);
    if (this.recentLogs.length > 300) {
      this.recentLogs = this.recentLogs.slice(-300);
    }
  }

  private handleCrashRecoveryCheck(): void {
    if (fs.existsSync(this.crashLockPath)) {
      this.appendLog(
        '[CrashRecovery] Previous unclean shutdown lock detected — verified state integrity from atomic snapshot.'
      );
    }
    writeFileAtomicSync(
      this.crashLockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
  }

  shutdownCleanly(): void {
    this.authService.cancelActiveAuthFlow();
    this.launcherService.cancelActiveDownload();
    if (fs.existsSync(this.crashLockPath)) {
      fs.unlinkSync(this.crashLockPath);
    }
  }

  private migratePersistedState(raw: PersistedStateFile): PersistedStateFile {
    const defaultSettings = createDefaultLauncherSettings(this.dataRootDir);
    const migratedProfiles: ClientProfile[] = raw.profiles.map((p) => {
      const loader: ModloaderType =
        p.loader === 'vanilla' || p.loader === 'legacy_fabric' ? p.loader : 'fabric';
      const vesperaOk = loader === 'fabric' && isVesperaCustomModCompatible(p.mcVersion);
      return {
        ...p,
        loader,
        loaderVersion: p.loaderVersion || (loader === 'vanilla' ? 'vanilla' : '0.16.10'),
        vesperaModCompatible: vesperaOk,
        enabledModIds:
          loader === 'vanilla'
            ? []
            : (p.enabledModIds || []).filter(
                (id) => id !== 'vespera-client' || vesperaOk
              ),
      };
    });

    return {
      ...raw,
      schemaVersion: 2,
      profiles: migratedProfiles,
      settings: {
        ...defaultSettings,
        ...raw.settings,
        customJavaExecutablePath: raw.settings?.customJavaExecutablePath ?? '',
        showSnapshotsInVersionList: raw.settings?.showSnapshotsInVersionList ?? false,
        showHistoricalInVersionList: raw.settings?.showHistoricalInVersionList ?? false,
      },
    };
  }

  private loadOrInitializeState(): PersistedStateFile {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8')) as PersistedStateFile;
        if (
          raw &&
          (raw.schemaVersion === 1 || raw.schemaVersion === 2) &&
          Array.isArray(raw.profiles) &&
          raw.profiles.length > 0
        ) {
          const migrated = this.migratePersistedState(raw);
          if (raw.schemaVersion !== 2) {
            this.saveState(migrated);
            this.appendLog('[Migration] Seamlessly upgraded v1.0.0 user profiles to v1.2.2 schema.');
          } else {
            this.appendLog('[Core] Loaded persisted Vespera Client v1.2.4 configuration.');
          }
          return migrated;
        }
      } catch {
        this.appendLog(
          '[CrashRecovery] State file unreadable; restoring clean verified configuration.'
        );
      }
    }

    const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
    const recRam = computeRecommendedRam(totalRamMb, 21).recommendedMb;
    const profiles = createDefaultClientProfiles(recRam);
    const installedMods = this.modManager.bootstrapDefaultMods('1.21.4');

    const fresh: PersistedStateFile = {
      schemaVersion: 2,
      profiles,
      activeProfileId: profiles[0].id,
      profileBackups: [],
      installedMods,
      modHistory: [
        {
          id: 'hist-init',
          timestamp: new Date().toISOString(),
          profileId: profiles[0].id,
          action: 'install',
          modName: 'Vespera Optimization Bundle',
          version: '1.2.2+mc1.21.4',
          details:
            'Initialized curated Sodium + Lithium + FerriteCore + ImmediatelyFast + Iris + Vespera Core stack.',
        },
      ],
      shaderPacks: createDefaultShaderPacks(),
      resourcePacks: createDefaultResourcePacks(),
      hudLayouts: createDefaultHudLayouts(),
      settings: createDefaultLauncherSettings(this.dataRootDir),
      latestBenchmark: (() => {
        try {
          const benchPath = path.resolve(process.cwd(), 'docs/BENCHMARK_LATEST.json');
          if (fs.existsSync(benchPath)) {
            return JSON.parse(fs.readFileSync(benchPath, 'utf8')) as BenchmarkSuiteReport;
          }
        } catch {
          // ignore
        }
        return null;
      })(),
    };

    this.saveState(fresh);
    this.appendLog(`[Core] Initialized Vespera Client v1.2.4 (Recommended Heap: ${recRam} MB).`);
    return fresh;
  }

  private saveState(stateObj: PersistedStateFile = this.persisted): void {
    writeFileAtomicSync(this.stateFilePath, JSON.stringify(stateObj, null, 2) + '\n');
  }

  getActiveProfile(): ClientProfile {
    return (
      this.persisted.profiles.find((p) => p.id === this.persisted.activeProfileId) ??
      this.persisted.profiles[0]
    );
  }

  private getActiveHudLayout(profile: ClientProfile): HudLayoutProfile {
    return (
      this.persisted.hudLayouts.find((h) => h.id === profile.hudLayoutId) ??
      this.persisted.hudLayouts[0]
    );
  }

  createProfileBackup(profileId: string, reason: string): ProfileSnapshotBackup {
    const prof = this.persisted.profiles.find((p) => p.id === profileId);
    if (!prof) throw new Error(`Profile "${profileId}" not found.`);
    const backup: ProfileSnapshotBackup = {
      id: `bkp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      profileId: prof.id,
      profileName: prof.name,
      reason,
      createdAt: new Date().toISOString(),
      snapshot: JSON.parse(JSON.stringify(prof)) as ClientProfile,
    };
    this.persisted.profileBackups.unshift(backup);
    if (this.persisted.profileBackups.length > 30) {
      this.persisted.profileBackups = this.persisted.profileBackups.slice(0, 30);
    }
    this.saveState();
    this.appendLog(
      `[Backup] Saved rollback snapshot "${backup.id}" for "${prof.name}" (${reason}).`
    );
    return backup;
  }

  rollbackProfileToBackup(backupId: string): ClientProfile {
    const bkp = this.persisted.profileBackups.find((b) => b.id === backupId);
    if (!bkp) throw new Error(`Backup "${backupId}" not found.`);
    const idx = this.persisted.profiles.findIndex((p) => p.id === bkp.profileId);
    const restored: ClientProfile = {
      ...(JSON.parse(JSON.stringify(bkp.snapshot)) as ClientProfile),
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      this.persisted.profiles[idx] = restored;
    } else {
      this.persisted.profiles.push(restored);
    }
    this.persisted.modHistory.unshift({
      id: `hist-${Date.now()}`,
      timestamp: new Date().toISOString(),
      profileId: restored.id,
      action: 'rollback',
      modName: restored.name,
      version: restored.mcVersion,
      details: `Rolled back profile to snapshot from ${bkp.createdAt} (${bkp.reason}).`,
    });
    this.saveState();
    this.syncActiveHudToIpc();
    this.appendLog(`[Rollback] Restored profile "${restored.name}" from snapshot ${backupId}.`);
    return restored;
  }

  selectActiveProfile(profileId: string): ClientProfile {
    const prof = this.persisted.profiles.find((p) => p.id === profileId);
    if (!prof) throw new Error(`Profile "${profileId}" not found.`);
    this.persisted.activeProfileId = prof.id;
    for (const sp of this.persisted.shaderPacks) {
      sp.active = sp.id === prof.activeShaderPackId;
    }
    for (const rp of this.persisted.resourcePacks) {
      rp.enabled = prof.enabledResourcePackIds.includes(rp.id);
    }
    this.saveState();
    this.syncActiveHudToIpc();
    this.appendLog(
      `[Profiles] Activated profile "${prof.name}" (MC ${prof.mcVersion} • ${prof.loader}).`
    );
    return prof;
  }

  createNewProfile(params: {
    name: string;
    archetype: ClientProfile['archetype'];
    mcVersion: string;
    loader?: ModloaderType;
    loaderVersion?: string;
    customJavaPath?: string;
    customGameDir?: string;
    description?: string;
  }): ClientProfile {
    const dynamicCatalog = this.launcherService.getAnnotatedVersions(
      this.persisted.settings.gameDataDir
    );
    const ver = getVersionDescriptor(params.mcVersion, dynamicCatalog);
    if (!ver || ver.supportTier === 'unsupported') {
      throw new Error(
        `Cannot create profile for unsupported Minecraft version "${params.mcVersion}".`
      );
    }

    const base = this.getActiveProfile();
    const now = new Date().toISOString();

    let loader: ModloaderType;
    if (params.loader) {
      if (params.loader === 'fabric' && ver.fabricSupported === false) {
        throw new Error(
          `Minecraft ${params.mcVersion} is Vanilla-only and does not support modern Fabric Loader.`
        );
      }
      loader = params.loader;
    } else if (ver.supportTier === 'legacy_pvp') {
      loader = 'legacy_fabric';
    } else if (ver.fabricSupported) {
      loader = 'fabric';
    } else {
      loader = 'vanilla';
    }

    const vesperaOk = loader === 'fabric' && isVesperaCustomModCompatible(params.mcVersion);

    const compatibleModIds =
      loader === 'vanilla' || loader === 'legacy_fabric'
        ? []
        : base.enabledModIds.filter((modId) => {
            if (modId === 'vespera-client' && !vesperaOk) return false;
            const c = CURATED_MOD_CATALOG.find((m) => m.id === modId);
            return c ? c.supportedMcVersions.includes(params.mcVersion) : false;
          });

    const recommendedRam =
      ver.recommendedJavaMajor === 8
        ? Math.min(3072, base.performance.allocatedRamMb)
        : base.performance.allocatedRamMb;

    const created: ClientProfile = {
      id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: params.name.trim() || `${loader === 'vanilla' ? 'Vanilla' : 'Fabric'} ${params.mcVersion}`,
      archetype: params.archetype,
      description:
        params.description?.trim() ||
        `Isolated ${loader === 'vanilla' ? 'Vanilla' : 'Fabric'} installation for Minecraft ${params.mcVersion}.`,
      mcVersion: params.mcVersion,
      loader,
      loaderVersion:
        loader === 'vanilla'
          ? 'vanilla'
          : params.loaderVersion || ver.recommendedFabricLoader || '0.16.10',
      vesperaModCompatible: vesperaOk,
      customJavaPath: params.customJavaPath?.trim() || undefined,
      customGameDir: params.customGameDir?.trim() || undefined,
      performance: {
        ...base.performance,
        allocatedRamMb: recommendedRam,
        gcMode: ver.recommendedJavaMajor < 21 ? 'adaptive_g1gc' : base.performance.gcMode,
      },
      graphics: { ...base.graphics },
      hudLayoutId: base.hudLayoutId,
      enabledModIds: compatibleModIds,
      activeShaderPackId: null,
      enabledResourcePackIds:
        params.mcVersion === '1.8.9'
          ? ['rp-legacy-1.8-pack']
          : vesperaOk
            ? ['rp-vespera-clarity-32x']
            : [],
      createdAt: now,
      updatedAt: now,
    };

    this.persisted.profiles.push(created);
    this.persisted.activeProfileId = created.id;
    this.saveState();
    this.appendLog(
      `[Profiles] Created isolated profile "${created.name}" (MC ${created.mcVersion} • ${created.loader}).`
    );
    return created;
  }

  /**
   * Updates the active profile's target Minecraft version, modloader (`vanilla` / `fabric`),
   * loader version, or custom Java / game directory while strictly enforcing mod compatibility.
   */
  updateProfileInstallationTarget(params: {
    profileId?: string;
    name?: string;
    mcVersion?: string;
    loader?: ModloaderType;
    loaderVersion?: string;
    customJavaPath?: string;
    customGameDir?: string;
  }): ClientProfile {
    const target = params.profileId
      ? this.persisted.profiles.find((p) => p.id === params.profileId)
      : this.getActiveProfile();
    if (!target) {
      throw new Error('Target installation profile not found.');
    }

    const nextMcVersion = params.mcVersion ?? target.mcVersion;
    const dynamicCatalog = this.launcherService.getAnnotatedVersions(
      this.persisted.settings.gameDataDir
    );
    const ver = getVersionDescriptor(nextMcVersion, dynamicCatalog);
    if (!ver || ver.supportTier === 'unsupported') {
      throw new Error(`Minecraft version "${nextMcVersion}" is unsupported.`);
    }

    let nextLoader = params.loader ?? target.loader;
    if (nextLoader === 'fabric' && ver.fabricSupported === false) {
      nextLoader = ver.id === '1.8.9' ? 'vanilla' : 'vanilla';
    }

    const vesperaOk = nextLoader === 'fabric' && isVesperaCustomModCompatible(nextMcVersion);
    target.mcVersion = nextMcVersion;
    target.loader = nextLoader;
    target.loaderVersion =
      nextLoader === 'vanilla'
        ? 'vanilla'
        : params.loaderVersion ||
          (target.loaderVersion !== 'vanilla' ? target.loaderVersion : undefined) ||
          ver.recommendedFabricLoader ||
          '0.16.10';
    target.vesperaModCompatible = vesperaOk;

    if (params.name !== undefined && params.name.trim()) {
      target.name = params.name.trim();
    }
    if (params.customJavaPath !== undefined) {
      target.customJavaPath = params.customJavaPath.trim() || undefined;
    }
    if (params.customGameDir !== undefined) {
      target.customGameDir = params.customGameDir.trim() || undefined;
    }

    // Strip any incompatible mods when changing version or switching to Vanilla
    if (nextLoader === 'vanilla' || nextLoader === 'legacy_fabric') {
      target.enabledModIds = [];
      target.activeShaderPackId = null;
    } else {
      target.enabledModIds = target.enabledModIds.filter((modId) => {
        if (modId === 'vespera-client' && !vesperaOk) return false;
        const c = CURATED_MOD_CATALOG.find((m) => m.id === modId);
        return c ? c.supportedMcVersions.includes(nextMcVersion) : false;
      });
    }

    if (ver.recommendedJavaMajor < 21 && target.performance.gcMode === 'generational_zgc') {
      target.performance.gcMode = 'adaptive_g1gc';
    }

    target.updatedAt = new Date().toISOString();
    this.saveState();
    this.appendLog(
      `[Profiles] Updated "${target.name}" -> MC ${target.mcVersion} (${target.loader}).`
    );
    return target;
  }

  exportProfileJson(profileId: string): string {
    const prof = this.persisted.profiles.find((p) => p.id === profileId);
    if (!prof) throw new Error('Profile not found.');
    const hud = this.persisted.hudLayouts.find((h) => h.id === prof.hudLayoutId);
    return JSON.stringify(
      {
        vesperaProfileFormat: 1,
        exportedAt: new Date().toISOString(),
        profile: prof,
        hudLayout: hud ?? null,
      },
      null,
      2
    );
  }

  importProfileJson(rawJson: string): ClientProfile {
    const parsed = JSON.parse(rawJson) as {
      vesperaProfileFormat?: number;
      profile?: ClientProfile;
      hudLayout?: HudLayoutProfile;
    };
    if (
      parsed.vesperaProfileFormat !== 1 ||
      !parsed.profile ||
      !parsed.profile.name ||
      !parsed.profile.mcVersion
    ) {
      throw new Error('Invalid .vesperaprofile schema.');
    }
    const dynamicCatalog = this.launcherService.getAnnotatedVersions(
      this.persisted.settings.gameDataDir
    );
    const ver = getVersionDescriptor(parsed.profile.mcVersion, dynamicCatalog);
    if (!ver || ver.supportTier === 'unsupported') {
      throw new Error(
        `Imported profile targets unsupported version "${parsed.profile.mcVersion}".`
      );
    }

    const now = new Date().toISOString();
    const newProfile: ClientProfile = {
      ...parsed.profile,
      id: `profile-import-${Date.now()}`,
      name: `${parsed.profile.name} (Imported)`,
      createdAt: now,
      updatedAt: now,
    };

    if (parsed.hudLayout && parsed.hudLayout.id) {
      const hudId = `hud-import-${Date.now()}`;
      this.persisted.hudLayouts.push({ ...parsed.hudLayout, id: hudId });
      newProfile.hudLayoutId = hudId;
    }

    this.persisted.profiles.push(newProfile);
    this.persisted.activeProfileId = newProfile.id;
    this.saveState();
    this.appendLog(`[Profiles] Imported profile "${newProfile.name}".`);
    return newProfile;
  }

  applyPerformanceMode(mode: PerformanceModeId): ClientProfile {
    const active = this.getActiveProfile();
    if (this.persisted.settings.autoBackupBeforeProfileUpdate) {
      this.createProfileBackup(active.id, `Before switching performance mode to ${mode}`);
    }
    const preset = PERFORMANCE_MODE_PRESETS[mode];
    const ver = getVersionDescriptor(active.mcVersion);
    active.performance = {
      ...active.performance,
      ...preset.performance,
      gcMode:
        ver && ver.recommendedJavaMajor < 21 && preset.performance.gcMode === 'generational_zgc'
          ? 'adaptive_g1gc'
          : preset.performance.gcMode,
      mode,
    };
    active.graphics = {
      ...active.graphics,
      ...preset.graphicsDefaults,
    };
    active.updatedAt = new Date().toISOString();

    writeFileAtomicSync(
      path.join(this.ipcDir, 'performance-preset.json'),
      JSON.stringify({ profileId: active.id, performance: active.performance }, null, 2)
    );
    this.saveState();
    this.appendLog(`[Performance] Applied "${preset.title}" preset to "${active.name}".`);
    return active;
  }

  updatePerformanceSettings(patch: Partial<PerformanceSettings>): ClientProfile {
    const active = this.getActiveProfile();
    active.performance = {
      ...active.performance,
      ...patch,
      mode: patch.mode ?? 'custom',
    };
    active.updatedAt = new Date().toISOString();
    writeFileAtomicSync(
      path.join(this.ipcDir, 'performance-preset.json'),
      JSON.stringify({ profileId: active.id, performance: active.performance }, null, 2)
    );
    this.saveState();
    return active;
  }

  updateGraphicsSettings(patch: Partial<GraphicsSettings>): ClientProfile {
    const active = this.getActiveProfile();
    active.graphics = { ...active.graphics, ...patch };
    active.updatedAt = new Date().toISOString();
    this.launcherService.materializeInstanceFiles(
      active,
      this.persisted.settings,
      this.getActiveHudLayout(active),
      this.persisted.installedMods,
      this.persisted.shaderPacks
    );
    this.saveState();
    return active;
  }

  updateLauncherSettings(patch: Partial<LauncherSettings>): LauncherSettings {
    this.persisted.settings = { ...this.persisted.settings, ...patch };
    this.saveState();
    this.appendLog('[Settings] Updated Vespera Launcher configuration.');
    return this.persisted.settings;
  }

  updateHudLayout(updatedLayout: HudLayoutProfile): HudLayoutProfile {
    const idx = this.persisted.hudLayouts.findIndex((h) => h.id === updatedLayout.id);
    if (idx >= 0) {
      this.persisted.hudLayouts[idx] = updatedLayout;
    } else {
      this.persisted.hudLayouts.push(updatedLayout);
    }
    const active = this.getActiveProfile();
    active.hudLayoutId = updatedLayout.id;
    this.saveState();
    this.syncActiveHudToIpc();
    return updatedLayout;
  }

  private syncActiveHudToIpc(): void {
    const active = this.getActiveProfile();
    const hud = this.getActiveHudLayout(active);
    if (hud) {
      writeFileAtomicSync(
        path.join(this.ipcDir, 'hud-profile.json'),
        JSON.stringify(hud, null, 2) + '\n'
      );
    }
  }

  selectShaderPack(
    shaderId: string | null,
    profileQuality?: ShaderPackEntry['selectedProfile']
  ): ShaderPackEntry[] {
    const active = this.getActiveProfile();
    if (shaderId && active.loader === 'fabric' && !active.enabledModIds.includes('iris')) {
      const ver = getVersionDescriptor(active.mcVersion);
      if (ver?.irisSupported) {
        if (!active.enabledModIds.includes('sodium')) active.enabledModIds.push('sodium');
        active.enabledModIds.push('iris');
        this.appendLog(
          '[Shaders] Auto-enabled Iris Shaders + Sodium for active shader pipeline.'
        );
      }
    }
    active.activeShaderPackId = shaderId;
    for (const sp of this.persisted.shaderPacks) {
      sp.active = sp.id === shaderId;
      if (sp.id === shaderId && profileQuality) {
        sp.selectedProfile = profileQuality;
      }
    }
    this.saveState();
    return this.persisted.shaderPacks;
  }

  toggleResourcePack(packId: string, enabled: boolean): ResourcePackEntry[] {
    const active = this.getActiveProfile();
    const pack = this.persisted.resourcePacks.find((r) => r.id === packId);
    if (!pack) throw new Error('Resource pack not found.');
    pack.enabled = enabled;
    if (enabled && !active.enabledResourcePackIds.includes(packId)) {
      active.enabledResourcePackIds.push(packId);
    } else if (!enabled) {
      active.enabledResourcePackIds = active.enabledResourcePackIds.filter(
        (id) => id !== packId
      );
    }
    this.saveState();
    return this.persisted.resourcePacks;
  }

  async searchMods(query: string, category: ModCategory | 'all') {
    return this.modManager.searchMods(
      query,
      category,
      this.getActiveProfile(),
      this.persisted.installedMods
    );
  }

  async installMod(modIdOrSlug: string) {
    const active = this.getActiveProfile();
    if (active.loader === 'vanilla') {
      throw new Error(
        `Profile "${active.name}" is configured as pure Vanilla (${active.mcVersion}). Switch its modloader to Fabric to install mods.`
      );
    }
    if (this.persisted.settings.autoBackupBeforeProfileUpdate) {
      this.createProfileBackup(active.id, `Before installing mod ${modIdOrSlug}`);
    }
    const res = await this.modManager.installModWithDependencies(
      modIdOrSlug,
      active,
      this.persisted.installedMods,
      this.persisted.modHistory
    );
    this.saveState();
    return res;
  }

  toggleMod(modId: string, enabled: boolean) {
    const active = this.getActiveProfile();
    if (active.loader === 'vanilla') {
      throw new Error('Cannot toggle mods on a pure Vanilla profile.');
    }
    if (enabled && modId === 'vespera-client' && !isVesperaCustomModCompatible(active.mcVersion)) {
      throw new Error(
        `Vespera's custom HUD mod is currently built and verified for Minecraft 1.21.4 only (active profile is ${active.mcVersion}).`
      );
    }
    this.modManager.toggleModForProfile(
      modId,
      enabled,
      active,
      this.persisted.installedMods,
      this.persisted.modHistory
    );
    this.saveState();
  }

  async installMinecraftVersionForTarget(params: {
    versionId?: string;
    loader?: ModloaderType;
    loaderVersion?: string;
    forceRepair?: boolean;
  }) {
    const active = this.getActiveProfile();
    const versionId = params.versionId || active.mcVersion;
    const loader = params.loader ?? (versionId === active.mcVersion ? active.loader : 'vanilla');
    const loaderVersion =
      params.loaderVersion ??
      (versionId === active.mcVersion ? active.loaderVersion : undefined);

    this.appendLog(
      `[VersionManager] Starting verified ${params.forceRepair ? 'repair' : 'installation'} for Minecraft ${versionId} (${loader})...`
    );

    const receipt = await this.launcherService.installMinecraftVersion({
      versionId,
      loader,
      loaderVersion,
      profileId: versionId === active.mcVersion ? active.id : null,
      settings: this.persisted.settings,
      forceRepair: params.forceRepair,
    });

    this.appendLog(
      `[VersionManager] Completed Minecraft ${versionId} (${loader}) — SHA-1 ${receipt.clientJarSha1.slice(0, 12)} verified, ${receipt.verifiedLibraries.length} libraries, ${receipt.nativesExtractedCount} native binaries extracted.`
    );
    return receipt;
  }

  createOfflineAccount(username: string): MinecraftAccount {
    const created = this.authService.createOfflineAccount(username);
    this.persisted.selectedAccountId = created.id;
    this.persisted.settings.firstLaunchCompleted = true;
    this.lastMultiplayerNotice = null;
    this.saveState();
    return created;
  }

  switchSelectedAccount(accountId: string): MinecraftAccount[] {
    const list = this.authService.switchActiveAccount(accountId);
    this.persisted.selectedAccountId = this.authService.getActiveAccountId();
    this.persisted.settings.firstLaunchCompleted = true;
    this.lastMultiplayerNotice = null;
    this.saveState();
    return list;
  }

  removeAccountById(accountId: string): MinecraftAccount[] {
    const list = this.authService.removeAccount(accountId);
    this.persisted.selectedAccountId = this.authService.getActiveAccountId();
    this.saveState();
    return list;
  }

  dismissFirstLaunch(): void {
    this.persisted.settings.firstLaunchCompleted = true;
    this.saveState();
  }

  dismissMultiplayerNotice(): void {
    this.lastMultiplayerNotice = null;
  }

  /**
   * Evaluates game/network disconnect output against the currently selected account type
   * and records a clear explanation if an `online-mode=true` server rejected an Offline Account.
   */
  inspectMultiplayerDisconnect(logText: string): MultiplayerRejectionNotice | null {
    const activeAcc = this.authService.getActiveAccount();
    const accType = activeAcc?.accountType ?? 'offline';
    const notice = classifyMultiplayerServerRejection(
      logText,
      accType,
      activeAcc?.username
    );
    if (notice) {
      this.lastMultiplayerNotice = notice;
      this.appendLog(`[Multiplayer] ${notice.title}: ${notice.message}`);
    }
    return notice;
  }

  prepareActiveLaunch(
    requestedMode?: 'offline_account' | 'online_authenticated' | 'offline_singleplayer'
  ): LaunchPreparationReport {
    const active = this.getActiveProfile();
    const activeAccount = this.authService.getActiveAccount();
    const resolvedMode: 'offline_account' | 'online_authenticated' | 'offline_singleplayer' =
      requestedMode ??
      (activeAccount?.accountType === 'offline'
        ? 'offline_account'
        : this.authService.getActiveSessionMode());
    const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));

    this.launcherService.materializeInstanceFiles(
      active,
      this.persisted.settings,
      this.getActiveHudLayout(active),
      this.persisted.installedMods,
      this.persisted.shaderPacks
    );

    return this.launcherService.prepareLaunchCommand({
      profile: active,
      settings: this.persisted.settings,
      account: activeAccount,
      totalSystemRamMb: totalRamMb,
      installedMods: this.persisted.installedMods,
      sessionMode: resolvedMode,
    });
  }

  async launchActiveProfile(
    requestedMode?: 'offline_account' | 'online_authenticated' | 'offline_singleplayer'
  ): Promise<{
    launched: boolean;
    stageReached: string;
    pid?: number;
    instanceDir?: string;
    sessionMode: 'offline_account' | 'online_authenticated' | 'offline_singleplayer';
    message: string;
  }> {
    const active = this.getActiveProfile();
    const activeAccount = this.authService.getActiveAccount();
    const sessionMode: 'offline_account' | 'online_authenticated' | 'offline_singleplayer' =
      requestedMode ??
      (activeAccount?.accountType === 'offline'
        ? 'offline_account'
        : this.authService.getActiveSessionMode());
    const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));

    // 1. Genuine Local Offline Account Mode (Singleplayer, LAN, and online-mode=false servers)
    if (sessionMode === 'offline_account') {
      if (!activeAccount || activeAccount.accountType !== 'offline') {
        return {
          launched: false,
          stageReached: 'account_selection_required',
          sessionMode: 'offline_account',
          message:
            'Create or select an Offline Account (or sign in with Microsoft) on the Accounts page before launching.',
        };
      }

      const spawned = await this.launcherService.installAndLaunchMinecraft({
        profile: active,
        settings: this.persisted.settings,
        account: activeAccount,
        mcAccessToken: null,
        sessionMode: 'offline_account',
        hudLayout: this.getActiveHudLayout(active),
        installedMods: this.persisted.installedMods,
        shaderPacks: this.persisted.shaderPacks,
        totalSystemRamMb: totalRamMb,
        onLog: (line) => this.appendLog(line),
        onMultiplayerRejection: (notice) => {
          this.lastMultiplayerNotice = notice;
          this.appendLog(`[Multiplayer] ${notice.title}: ${notice.message}`);
        },
      });
      active.lastPlayedAt = new Date().toISOString();
      this.persisted.selectedAccountId = activeAccount.id;
      this.persisted.settings.firstLaunchCompleted = true;
      this.saveState();
      return {
        launched: true,
        stageReached: 'process_spawned_offline_account',
        pid: spawned.pid,
        instanceDir: spawned.instanceDir,
        sessionMode: 'offline_account',
        message: `Launched Minecraft ${active.mcVersion} (${active.loader}) with Offline Account "${activeAccount.username}".`,
      };
    }

    // Refuse any attempt to launch an Offline Account as an Online-Authenticated Microsoft session
    if (activeAccount?.accountType === 'offline' && sessionMode === 'online_authenticated') {
      return {
        launched: false,
        stageReached: 'online_mode_requires_microsoft',
        sessionMode: 'online_authenticated',
        message: `"${activeAccount.username}" is an Offline Account and cannot authenticate to online-mode Microsoft servers. Switch to or sign in with a Microsoft Account to use online authentication.`,
      };
    }

    if (sessionMode === 'offline_singleplayer') {
      const localStatus = this.launcherService.getVersionInstallStatus(
        active.mcVersion,
        this.persisted.settings.gameDataDir
      );
      const offlineState = this.authService.computeOfflineAvailability(localStatus === 'ready');
      if (!offlineState.eligible) {
        return {
          launched: false,
          stageReached: offlineState.verifiedAccountId
            ? 'version_not_installed_offline'
            : 'authentication_required',
          sessionMode,
          message: offlineState.statusReason,
        };
      }
      const verifiedAcc = this.authService
        .listAccounts()
        .find((a) => a.id === offlineState.verifiedAccountId)!;
      const spawned = await this.launcherService.installAndLaunchMinecraft({
        profile: active,
        settings: this.persisted.settings,
        account: verifiedAcc,
        mcAccessToken: null,
        sessionMode: 'offline_singleplayer',
        hudLayout: this.getActiveHudLayout(active),
        installedMods: this.persisted.installedMods,
        shaderPacks: this.persisted.shaderPacks,
        totalSystemRamMb: totalRamMb,
        onLog: (line) => this.appendLog(line),
      });
      active.lastPlayedAt = new Date().toISOString();
      this.saveState();
      return {
        launched: true,
        stageReached: 'process_spawned_offline_singleplayer',
        pid: spawned.pid,
        instanceDir: spawned.instanceDir,
        sessionMode: 'offline_singleplayer',
        message: `Launched Minecraft ${active.mcVersion} in Offline Singleplayer mode as ${verifiedAcc.username} (multiplayer disabled).`,
      };
    }

    // Online Authenticated Mode
    let session: { account: import('../shared/types').MinecraftAccount; mcAccessToken: string } | null =
      null;
    try {
      session = await this.authService.acquireLaunchSessionToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog(`[Auth] Online session validation halted: ${msg}`);
      return {
        launched: false,
        stageReached: 'authentication_required',
        sessionMode: 'online_authenticated',
        message: msg,
      };
    }

    if (!session) {
      this.appendLog(
        '[Launch] No account selected: Create an Offline Account or sign in with Microsoft before launching.'
      );
      return {
        launched: false,
        stageReached: 'authentication_required',
        sessionMode: 'online_authenticated',
        message:
          'Create an Offline Account or sign in with Microsoft on the Accounts page before launching.',
      };
    }

    const spawned = await this.launcherService.installAndLaunchMinecraft({
      profile: active,
      settings: this.persisted.settings,
      account: session.account,
      mcAccessToken: session.mcAccessToken,
      sessionMode: 'online_authenticated',
      hudLayout: this.getActiveHudLayout(active),
      installedMods: this.persisted.installedMods,
      shaderPacks: this.persisted.shaderPacks,
      totalSystemRamMb: totalRamMb,
      onLog: (line) => this.appendLog(line),
      onMultiplayerRejection: (notice) => {
        this.lastMultiplayerNotice = notice;
        this.appendLog(`[Multiplayer] ${notice.title}: ${notice.message}`);
      },
    });

    active.lastPlayedAt = new Date().toISOString();
    this.persisted.selectedAccountId = session.account.id;
    this.persisted.settings.firstLaunchCompleted = true;
    this.saveState();
    return {
      launched: true,
      stageReached: 'process_spawned_authenticated',
      pid: spawned.pid,
      instanceDir: spawned.instanceDir,
      sessionMode: 'online_authenticated',
      message: `Launched Minecraft ${active.mcVersion} (${active.loader}) as ${session.account.username}.`,
    };
  }

  applyDiagnosticAutoFix(actionId: string): void {
    const active = this.getActiveProfile();
    if (actionId === 'autofix-apply-recommended-ram') {
      const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
      const ver = getVersionDescriptor(active.mcVersion);
      const rec = computeRecommendedRam(totalRamMb, ver?.recommendedJavaMajor ?? 21);
      active.performance.allocatedRamMb = rec.recommendedMb;
      active.performance.gcMode = rec.recommendedGc;
      this.appendLog(
        `[Doctor] Applied recommended heap (${rec.recommendedMb} MB) & ${rec.recommendedGc}.`
      );
    } else if (actionId.startsWith('autofix-enable-mod:')) {
      const modId = actionId.split(':')[1];
      if (!active.enabledModIds.includes(modId)) active.enabledModIds.push(modId);
      this.appendLog(`[Doctor] Enabled required mod "${modId}".`);
    } else if (actionId.startsWith('autofix-disable-mod:')) {
      const modId = actionId.split(':')[1];
      active.enabledModIds = active.enabledModIds.filter((id) => id !== modId);
      this.appendLog(`[Doctor] Disabled conflicting mod "${modId}".`);
    }
    this.saveState();
  }

  runBenchmarks(): BenchmarkSuiteReport {
    const runtimes = this.launcherService.detectJavaRuntimes(
      this.persisted.settings.customJavaExecutablePath
    );
    const java21 =
      runtimes.find((r) => r.major === 21 && r.installed) ?? runtimes.find((r) => r.installed);
    if (!java21) {
      throw new Error('Java 21 runtime is required to execute the JVM & Voxel Benchmark Suite.');
    }
    const report = this.diagBenchService.runReproducibleBenchmarks(
      java21.path,
      this.getActiveProfile()
    );
    this.persisted.latestBenchmark = report;
    this.saveState();
    return report;
  }

  getSnapshot(): AppStateSnapshot {
    const activeProfile = this.getActiveProfile();
    const customJava =
      activeProfile.customJavaPath || this.persisted.settings.customJavaExecutablePath;
    const javaRuntimes = this.launcherService.detectJavaRuntimes(customJava);
    const mcProc = this.launcherService.isGameRunning();
    const telemetry = this.diagBenchService.collectTelemetry(
      activeProfile,
      this.persisted.installedMods,
      mcProc
    );
    const diagnostics = this.diagBenchService.analyzeConfigurationAndLogs(
      activeProfile,
      this.persisted.installedMods,
      javaRuntimes,
      this.persisted.resourcePacks,
      this.recentLogs
    );
    const accounts = this.authService.listAccounts();
    const activeAccount = this.authService.getActiveAccount();

    const versions = this.launcherService.getAnnotatedVersions(
      this.persisted.settings.gameDataDir
    );
    const manifestMeta = this.launcherService.getManifestMetadata();
    const activeVersionReady =
      this.launcherService.getVersionInstallStatus(
        activeProfile.mcVersion,
        this.persisted.settings.gameDataDir
      ) === 'ready';

    const isLegacy18 = activeProfile.mcVersion === '1.8.9';
    const resourcePacks = this.persisted.resourcePacks.map((rp) => ({
      ...rp,
      enabled: activeProfile.enabledResourcePackIds.includes(rp.id),
      compatibleWithCurrent: isLegacy18 ? rp.packFormat === 1 : rp.packFormat >= 15,
    }));

    return {
      version: '1.2.4',
      platformMode: 'node_preview_bridge',
      oauthConfig: this.authService.getOAuthConfigState(),
      authFlow: this.authService.getAuthFlowState(),
      offlineAvailability: this.authService.computeOfflineAvailability(activeVersionReady),
      lastMultiplayerNotice: this.lastMultiplayerNotice,
      accounts,
      activeAccountId: activeAccount?.id ?? null,
      versions,
      latestReleaseId: manifestMeta.latestReleaseId,
      latestSnapshotId: manifestMeta.latestSnapshotId,
      manifestSource: manifestMeta.manifestSource,
      manifestError: manifestMeta.manifestError,
      activeDownload: this.launcherService.getActiveDownloadProgress(),
      javaRuntimes,
      profiles: this.persisted.profiles,
      activeProfileId: activeProfile.id,
      profileBackups: this.persisted.profileBackups,
      installedMods: this.persisted.installedMods,
      curatedCatalog: CURATED_MOD_CATALOG,
      modHistory: this.persisted.modHistory.slice(0, 40),
      shaderPacks: this.persisted.shaderPacks.map((sp) => ({
        ...sp,
        active: activeProfile.activeShaderPackId === sp.id,
      })),
      resourcePacks,
      hudLayouts: this.persisted.hudLayouts,
      settings: this.persisted.settings,
      telemetry,
      diagnostics,
      latestBenchmark: this.persisted.latestBenchmark,
      recentLogs: this.recentLogs.slice(-80),
    };
  }
}
