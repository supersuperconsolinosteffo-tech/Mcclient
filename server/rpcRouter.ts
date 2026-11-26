import type {
  ClientProfile,
  GraphicsSettings,
  HudLayoutProfile,
  LauncherSettings,
  ModCategory,
  ModloaderType,
  PerformanceModeId,
  PerformanceSettings,
  ShaderPackEntry,
} from '../shared/types';
import { VesperaStateCoordinator } from './stateStore';

export async function dispatchRpcMethod(
  coordinator: VesperaStateCoordinator,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  switch (method) {
    case 'getSnapshot':
      return coordinator.getSnapshot();

    case 'selectProfile':
      coordinator.selectActiveProfile(String(params.profileId ?? ''));
      return coordinator.getSnapshot();

    case 'createProfile':
      coordinator.createNewProfile({
        name: String(params.name ?? 'Custom Profile'),
        archetype: (params.archetype as ClientProfile['archetype']) ?? 'custom',
        mcVersion: String(params.mcVersion ?? '1.21.4'),
        loader: params.loader ? (String(params.loader) as ModloaderType) : undefined,
        loaderVersion: params.loaderVersion ? String(params.loaderVersion) : undefined,
        customJavaPath: params.customJavaPath ? String(params.customJavaPath) : undefined,
        customGameDir: params.customGameDir ? String(params.customGameDir) : undefined,
        description: params.description ? String(params.description) : undefined,
      });
      return coordinator.getSnapshot();

    case 'updateProfileTarget':
      coordinator.updateProfileInstallationTarget({
        profileId: params.profileId ? String(params.profileId) : undefined,
        name: params.name !== undefined ? String(params.name) : undefined,
        mcVersion: params.mcVersion !== undefined ? String(params.mcVersion) : undefined,
        loader: params.loader ? (String(params.loader) as ModloaderType) : undefined,
        loaderVersion:
          params.loaderVersion !== undefined ? String(params.loaderVersion) : undefined,
        customJavaPath:
          params.customJavaPath !== undefined ? String(params.customJavaPath) : undefined,
        customGameDir:
          params.customGameDir !== undefined ? String(params.customGameDir) : undefined,
      });
      return coordinator.getSnapshot();

    case 'exportProfile':
      return {
        json: coordinator.exportProfileJson(
          String(params.profileId ?? coordinator.getActiveProfile().id)
        ),
      };

    case 'importProfile':
      coordinator.importProfileJson(String(params.json ?? ''));
      return coordinator.getSnapshot();

    case 'createBackup':
      coordinator.createProfileBackup(
        String(params.profileId ?? coordinator.getActiveProfile().id),
        String(params.reason ?? 'Manual user checkpoint')
      );
      return coordinator.getSnapshot();

    case 'rollbackBackup':
      coordinator.rollbackProfileToBackup(String(params.backupId ?? ''));
      return coordinator.getSnapshot();

    case 'applyPerformanceMode':
      coordinator.applyPerformanceMode(params.mode as PerformanceModeId);
      return coordinator.getSnapshot();

    case 'updatePerformance':
      coordinator.updatePerformanceSettings(params.patch as Partial<PerformanceSettings>);
      return coordinator.getSnapshot();

    case 'updateGraphics':
      coordinator.updateGraphicsSettings(params.patch as Partial<GraphicsSettings>);
      return coordinator.getSnapshot();

    case 'updateSettings':
      coordinator.updateLauncherSettings(params.patch as Partial<LauncherSettings>);
      return coordinator.getSnapshot();

    case 'updateHudLayout':
      coordinator.updateHudLayout(params.layout as HudLayoutProfile);
      return coordinator.getSnapshot();

    case 'selectShaderPack':
      coordinator.selectShaderPack(
        params.shaderId ? String(params.shaderId) : null,
        params.quality as ShaderPackEntry['selectedProfile'] | undefined
      );
      return coordinator.getSnapshot();

    case 'toggleResourcePack':
      coordinator.toggleResourcePack(String(params.packId ?? ''), Boolean(params.enabled));
      return coordinator.getSnapshot();

    case 'searchMods':
      return coordinator.searchMods(
        String(params.query ?? ''),
        (params.category as ModCategory | 'all') ?? 'all'
      );

    case 'installMod': {
      const result = await coordinator.installMod(String(params.modId ?? ''));
      return { result, snapshot: coordinator.getSnapshot() };
    }

    case 'toggleMod':
      coordinator.toggleMod(String(params.modId ?? ''), Boolean(params.enabled));
      return coordinator.getSnapshot();

    // --- Part 1 & 2: Microsoft OAuth 2.0 PKCE + Device Code Fallback + Offline Singleplayer ---
    case 'startPkceAuth': {
      const flow = await coordinator.authService.startBrowserPkceSignIn();
      return { flow, snapshot: coordinator.getSnapshot() };
    }

    case 'startDeviceAuth':
      return coordinator.authService.startDeviceCodeFlow();

    case 'pollDeviceAuth': {
      const authStatus = await coordinator.authService.pollDeviceCodeCompletion(
        params.deviceCode ? String(params.deviceCode) : undefined
      );
      return { authStatus, snapshot: coordinator.getSnapshot() };
    }

    case 'cancelAuthFlow':
      coordinator.authService.cancelActiveAuthFlow();
      return coordinator.getSnapshot();

    case 'refreshAccountSession':
      await coordinator.authService.refreshOrValidateSession(
        String(params.accountId ?? coordinator.authService.getActiveAccountId() ?? '')
      );
      return coordinator.getSnapshot();

    case 'createOfflineAccount': {
      const account = coordinator.createOfflineAccount(String(params.username ?? ''));
      return { account, snapshot: coordinator.getSnapshot() };
    }

    case 'dismissFirstLaunch':
      coordinator.dismissFirstLaunch();
      return coordinator.getSnapshot();

    case 'dismissMultiplayerNotice':
      coordinator.dismissMultiplayerNotice();
      return coordinator.getSnapshot();

    case 'switchAccount':
      coordinator.switchSelectedAccount(String(params.accountId ?? ''));
      return coordinator.getSnapshot();

    case 'signOutAccount':
      coordinator.authService.signOutAccount(
        String(params.accountId ?? coordinator.authService.getActiveAccountId() ?? '')
      );
      return coordinator.getSnapshot();

    case 'removeAccount':
      coordinator.removeAccountById(String(params.accountId ?? ''));
      return coordinator.getSnapshot();

    case 'setSessionMode':
      coordinator.authService.setSessionMode(
        params.mode === 'offline_singleplayer'
          ? 'offline_singleplayer'
          : 'online_authenticated'
      );
      return coordinator.getSnapshot();

    // --- Part 3 & 4: Dynamic Version Manager, Installer, Repair & Deletion ---
    case 'syncVersions': {
      await coordinator.launcherService.syncOfficialVersionManifest(
        coordinator.getSnapshot().settings.gameDataDir,
        { force: true }
      );
      return coordinator.getSnapshot();
    }

    case 'getFabricLoaders': {
      const mcVersion = String(
        params.mcVersion ?? coordinator.getActiveProfile().mcVersion
      );
      const loaders = await coordinator.launcherService.fetchCompatibleFabricLoaders(mcVersion);
      return { mcVersion, loaders };
    }

    case 'installVersion': {
      const receipt = await coordinator.installMinecraftVersionForTarget({
        versionId: params.versionId ? String(params.versionId) : undefined,
        loader: params.loader ? (String(params.loader) as ModloaderType) : undefined,
        loaderVersion: params.loaderVersion ? String(params.loaderVersion) : undefined,
        forceRepair: Boolean(params.forceRepair),
      });
      return { receipt, snapshot: coordinator.getSnapshot() };
    }

    case 'cancelVersionDownload': {
      const cancelled = coordinator.launcherService.cancelActiveDownload();
      coordinator.appendLog('[VersionManager] Cancelled active download operation.');
      return { cancelled, snapshot: coordinator.getSnapshot() };
    }

    case 'deleteVersion': {
      const versionId = String(params.versionId ?? '');
      coordinator.launcherService.deleteInstalledVersion(
        versionId,
        coordinator.getSnapshot().settings.gameDataDir
          ? coordinator.getSnapshot().settings
          : coordinator.getSnapshot().settings
      );
      coordinator.appendLog(
        `[VersionManager] Deleted local version binaries for Minecraft ${versionId} (profiles & world saves preserved).`
      );
      return coordinator.getSnapshot();
    }

    case 'prepareLaunch': {
      const mode =
        params.mode === 'offline_account'
          ? 'offline_account'
          : params.mode === 'offline_singleplayer'
            ? 'offline_singleplayer'
            : params.mode === 'online_authenticated'
              ? 'online_authenticated'
              : undefined;
      return coordinator.prepareActiveLaunch(mode);
    }

    case 'verifyAndRepair': {
      const active = coordinator.getActiveProfile();
      const snap = coordinator.getSnapshot();
      const integrity = coordinator.launcherService.verifyVersionIntegrity(
        active.mcVersion,
        snap.settings
      );
      const materialized = coordinator.launcherService.materializeInstanceFiles(
        active,
        snap.settings,
        snap.hudLayouts.find((h) => h.id === active.hudLayoutId) ?? snap.hudLayouts[0],
        snap.installedMods,
        snap.shaderPacks
      );
      let repairedVersion = false;
      if (!integrity.healthy) {
        try {
          await coordinator.installMinecraftVersionForTarget({
            versionId: active.mcVersion,
            loader: active.loader,
            loaderVersion: active.loaderVersion,
            forceRepair: true,
          });
          repairedVersion = true;
        } catch {
          // Offline environment: instance files materialized, version download deferred until online
        }
      }
      coordinator.appendLog(
        `[VerifyRepair] Verified ${materialized.instanceDir} (${integrity.healthy ? 'all version hashes intact' : repairedVersion ? 'repaired version files' : `${integrity.issues.length} missing online files noted`}).`
      );
      return {
        repair: {
          instanceDir: materialized.instanceDir,
          verifiedCount: materialized.syncedModFiles.length,
          repairedFiles: repairedVersion ? integrity.issues : [],
          issues: integrity.issues,
        },
        snapshot: coordinator.getSnapshot(),
      };
    }

    case 'launchMinecraft': {
      const mode =
        params.mode === 'offline_account'
          ? 'offline_account'
          : params.mode === 'offline_singleplayer'
            ? 'offline_singleplayer'
            : params.mode === 'online_authenticated'
              ? 'online_authenticated'
              : undefined;
      const launchRes = await coordinator.launchActiveProfile(mode);
      return { launchRes, snapshot: coordinator.getSnapshot() };
    }

    case 'inspectMultiplayerDisconnect': {
      const notice = coordinator.inspectMultiplayerDisconnect(String(params.logText ?? ''));
      return { notice, snapshot: coordinator.getSnapshot() };
    }

    case 'applyAutoFix':
      coordinator.applyDiagnosticAutoFix(String(params.actionId ?? ''));
      return coordinator.getSnapshot();

    case 'runBenchmarks': {
      const report = coordinator.runBenchmarks();
      return { report, snapshot: coordinator.getSnapshot() };
    }

    default:
      throw new Error(`Unknown RPC method: "${method}"`);
  }
}
