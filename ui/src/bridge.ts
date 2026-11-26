import type {
  AppStateSnapshot,
  BenchmarkSuiteReport,
  ClientProfile,
  DeviceCodeAuthChallenge,
  GraphicsSettings,
  HudLayoutProfile,
  LaunchPreparationReport,
  LauncherSettings,
  MinecraftVersionDescriptor,
  ModCategory,
  PerformanceModeId,
  PerformanceSettings,
  ShaderPackEntry,
} from '@shared/types';

declare global {
  interface Window {
    vesperaNativeInvoke?: (payloadJson: string) => Promise<string>;
  }
}

export interface ModSearchResponse {
  items: Array<{
    id: string;
    slug: string;
    name: string;
    author: string;
    summary: string;
    category: ModCategory;
    downloads: number;
    license: string;
    supportedMcVersions: string[];
    loader: 'fabric' | 'legacy_fabric';
    requiredDependencies: string[];
    incompatibleWith: string[];
    source: 'modrinth_live' | 'curated_verified';
    installed: boolean;
    enabled: boolean;
    compatibility: {
      allowed: boolean;
      reasons: string[];
      warnings: string[];
      missingDependencies: string[];
      conflictingMods: string[];
    };
  }>;
  liveApiConnected: boolean;
}

class VesperaRpcBridge {
  async invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // 1. Native Windows 10/11 Edge WebView2 C++ Host binding (VesperaClient.exe)
    if (typeof window !== 'undefined' && typeof window.vesperaNativeInvoke === 'function') {
      const rawResp = await window.vesperaNativeInvoke(JSON.stringify({ method, params }));
      const parsed = JSON.parse(rawResp) as { ok: boolean; data?: T; error?: string };
      if (!parsed.ok) {
        throw new Error(parsed.error || `Native RPC error in ${method}`);
      }
      return parsed.data as T;
    }

    // 2. Relative HTTP RPC endpoint (works seamlessly on any preview host or local daemon)
    const response = await fetch('./api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const json = (await response.json()) as { ok: boolean; data?: T; error?: string };
    if (!response.ok || !json.ok) {
      throw new Error(json.error || `RPC request "${method}" failed (${response.status})`);
    }
    return json.data as T;
  }

  getSnapshot() {
    return this.invoke<AppStateSnapshot>('getSnapshot');
  }
  selectProfile(profileId: string) {
    return this.invoke<AppStateSnapshot>('selectProfile', { profileId });
  }
  createProfile(params: {
    name: string;
    archetype: ClientProfile['archetype'];
    mcVersion: string;
    description?: string;
  }) {
    return this.invoke<AppStateSnapshot>('createProfile', params);
  }
  exportProfile(profileId: string) {
    return this.invoke<{ json: string }>('exportProfile', { profileId });
  }
  importProfile(json: string) {
    return this.invoke<AppStateSnapshot>('importProfile', { json });
  }
  createBackup(profileId: string, reason: string) {
    return this.invoke<AppStateSnapshot>('createBackup', { profileId, reason });
  }
  rollbackBackup(backupId: string) {
    return this.invoke<AppStateSnapshot>('rollbackBackup', { backupId });
  }
  applyPerformanceMode(mode: PerformanceModeId) {
    return this.invoke<AppStateSnapshot>('applyPerformanceMode', { mode });
  }
  updatePerformance(patch: Partial<PerformanceSettings>) {
    return this.invoke<AppStateSnapshot>('updatePerformance', { patch });
  }
  updateGraphics(patch: Partial<GraphicsSettings>) {
    return this.invoke<AppStateSnapshot>('updateGraphics', { patch });
  }
  updateSettings(patch: Partial<LauncherSettings>) {
    return this.invoke<AppStateSnapshot>('updateSettings', { patch });
  }
  updateHudLayout(layout: HudLayoutProfile) {
    return this.invoke<AppStateSnapshot>('updateHudLayout', { layout });
  }
  selectShaderPack(shaderId: string | null, quality?: ShaderPackEntry['selectedProfile']) {
    return this.invoke<AppStateSnapshot>('selectShaderPack', { shaderId, quality });
  }
  toggleResourcePack(packId: string, enabled: boolean) {
    return this.invoke<AppStateSnapshot>('toggleResourcePack', { packId, enabled });
  }
  searchMods(query: string, category: ModCategory | 'all') {
    return this.invoke<ModSearchResponse>('searchMods', { query, category });
  }
  installMod(modId: string) {
    return this.invoke<{ result: unknown; snapshot: AppStateSnapshot }>('installMod', { modId });
  }
  toggleMod(modId: string, enabled: boolean) {
    return this.invoke<AppStateSnapshot>('toggleMod', { modId, enabled });
  }
  startDeviceAuth(clientId: string) {
    return this.invoke<DeviceCodeAuthChallenge>('startDeviceAuth', { clientId });
  }
  pollDeviceAuth() {
    return this.invoke<{
      authStatus: { status: 'pending' | 'authenticated'; message: string };
      snapshot: AppStateSnapshot;
    }>('pollDeviceAuth');
  }
  switchAccount(accountId: string) {
    return this.invoke<AppStateSnapshot>('switchAccount', { accountId });
  }
  removeAccount(accountId: string) {
    return this.invoke<AppStateSnapshot>('removeAccount', { accountId });
  }
  prepareLaunch() {
    return this.invoke<LaunchPreparationReport>('prepareLaunch');
  }
  verifyAndRepair() {
    return this.invoke<{
      repair: { instanceDir: string; repairedFiles: string[]; verifiedCount: number };
      snapshot: AppStateSnapshot;
    }>('verifyAndRepair');
  }
  launchMinecraft() {
    return this.invoke<{
      launchRes: {
        launched: boolean;
        pid: number | null;
        stageReached: string;
        message: string;
        preparation: LaunchPreparationReport;
      };
      snapshot: AppStateSnapshot;
    }>('launchMinecraft');
  }
  applyAutoFix(actionId: string) {
    return this.invoke<AppStateSnapshot>('applyAutoFix', { actionId });
  }
  runBenchmarks() {
    return this.invoke<{ report: BenchmarkSuiteReport; snapshot: AppStateSnapshot }>('runBenchmarks');
  }
  syncVersions() {
    return this.invoke<{ versions: MinecraftVersionDescriptor[]; liveManifestFetched: boolean }>('syncVersions');
  }
}

export const bridge = new VesperaRpcBridge();
