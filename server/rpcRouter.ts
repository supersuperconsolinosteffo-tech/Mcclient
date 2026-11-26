import type {
  ClientProfile,
  GraphicsSettings,
  HudLayoutProfile,
  LauncherSettings,
  ModCategory,
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
        description: params.description ? String(params.description) : undefined,
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

    case 'startDeviceAuth':
      return coordinator.authService.startDeviceCodeFlow(
        String(params.clientId ?? coordinator.getSnapshot().settings.microsoftAzureClientId ?? '')
      );

    case 'pollDeviceAuth': {
      const authStatus = await coordinator.authService.pollDeviceCodeCompletion();
      return { authStatus, snapshot: coordinator.getSnapshot() };
    }

    case 'switchAccount':
      coordinator.authService.switchActiveAccount(String(params.accountId ?? ''));
      return coordinator.getSnapshot();

    case 'removeAccount':
      coordinator.authService.removeAccount(String(params.accountId ?? ''));
      return coordinator.getSnapshot();

    case 'prepareLaunch': {
      const snap = coordinator.getSnapshot();
      const activeAcc = coordinator.authService.getActiveAccount();
      return coordinator.launcherService.prepareLaunchCommand(
        coordinator.getActiveProfile(),
        snap.settings,
        snap.installedMods,
        activeAcc
      );
    }

    case 'verifyAndRepair': {
      const snap = coordinator.getSnapshot();
      const repair = coordinator.launcherService.verifyAndMaterializeInstance(
        coordinator.getActiveProfile(),
        snap.settings,
        snap.installedMods
      );
      coordinator.appendLog(
        `[VerifyRepair] Verified ${repair.verifiedCount} artifacts in ${repair.instanceDir} (${repair.repairedFiles.length} repaired).`
      );
      return { repair, snapshot: coordinator.getSnapshot() };
    }

    case 'launchMinecraft': {
      const snap = coordinator.getSnapshot();
      let session: { account: import('../shared/types').MinecraftAccount; mcAccessToken: string } | null = null;
      try {
        session = await coordinator.authService.acquireLaunchSessionToken(
          snap.settings.microsoftAzureClientId
        );
      } catch {
        session = null;
      }
      const launchRes = await coordinator.launcherService.installAndLaunchMinecraft(
        coordinator.getActiveProfile(),
        snap.settings,
        snap.installedMods,
        session
      );
      return { launchRes, snapshot: coordinator.getSnapshot() };
    }

    case 'applyAutoFix':
      coordinator.applyDiagnosticAutoFix(String(params.actionId ?? ''));
      return coordinator.getSnapshot();

    case 'runBenchmarks': {
      const report = coordinator.runBenchmarks();
      return { report, snapshot: coordinator.getSnapshot() };
    }

    case 'syncVersions':
      return coordinator.launcherService.syncOfficialVersionManifest();

    default:
      throw new Error(`Unknown RPC method: "${method}"`);
  }
}
