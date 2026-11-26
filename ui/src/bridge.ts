import { validateAndNormalizeSnapshot } from '@shared/snapshotValidator';
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
    vesperaNativeInvoke?: (
      payloadJson: string
    ) => Promise<string | { ok: boolean; data?: unknown; error?: string }>;
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
    source: 'modrinth_live' | 'modrinth_api' | 'curated_verified';
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

function withRpcTimeout<T>(promise: Promise<T>, method: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`RPC call "${method}" timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function waitForNativeBridgeIfEmbedded(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (typeof window.vesperaNativeInvoke === 'function') return;
  const proto = window.location?.protocol ?? '';
  if (proto === 'http:' || proto === 'https:') return;

  // Embedded WebView2 NavigateToString context (about:blank / data:) — wait briefly if user-script bind is finishing
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (typeof window.vesperaNativeInvoke === 'function') return;
  }
}

class VesperaRpcBridge {
  async invoke<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000
  ): Promise<T> {
    const exec = async (): Promise<T> => {
      await waitForNativeBridgeIfEmbedded();
      // 1. Native Windows 10/11 Edge WebView2 C++ Host binding (VesperaClient.exe)
      // Note: webview/webview's internal JS bridge (Webview_.prototype.onReply) already runs JSON.parse()
      // on the C++ binding return string before resolving the Promise, so rawResp is already an object.
      if (typeof window !== 'undefined' && typeof window.vesperaNativeInvoke === 'function') {
        const rawResp = await window.vesperaNativeInvoke(JSON.stringify({ method, params }));
        const parsed = (
          typeof rawResp === 'string' ? JSON.parse(rawResp) : rawResp
        ) as { ok?: boolean; data?: T; error?: string } | null;
        if (!parsed || typeof parsed !== 'object' || !parsed.ok) {
          throw new Error(
            (parsed && typeof parsed.error === 'string' && parsed.error) ||
              `Native RPC error in "${method}"`
          );
        }
        return parsed.data as T;
      }

      // 2. Relative HTTP RPC endpoint (works seamlessly on any preview host or local daemon)
      const response = await fetch('./api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });
      const json = (await response.json()) as { ok?: boolean; data?: T; error?: string };
      if (!response.ok || !json || !json.ok) {
        throw new Error(json?.error || `RPC request "${method}" failed (${response.status})`);
      }
      return json.data as T;
    };

    return withRpcTimeout(exec(), method, timeoutMs);
  }

  private async invokeSnapshot(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000
  ): Promise<AppStateSnapshot> {
    const raw = await this.invoke<unknown>(method, params, timeoutMs);
    return validateAndNormalizeSnapshot(raw);
  }

  getSnapshot() {
    return this.invokeSnapshot('getSnapshot', {}, 15000);
  }
  selectProfile(profileId: string) {
    return this.invokeSnapshot('selectProfile', { profileId });
  }
  createProfile(params: {
    name: string;
    archetype: ClientProfile['archetype'];
    mcVersion: string;
    description?: string;
  }) {
    return this.invokeSnapshot('createProfile', params);
  }
  exportProfile(profileId: string) {
    return this.invoke<{ json: string }>('exportProfile', { profileId });
  }
  importProfile(json: string) {
    return this.invokeSnapshot('importProfile', { json });
  }
  createBackup(profileId: string, reason: string) {
    return this.invokeSnapshot('createBackup', { profileId, reason });
  }
  rollbackBackup(backupId: string) {
    return this.invokeSnapshot('rollbackBackup', { backupId });
  }
  applyPerformanceMode(mode: PerformanceModeId) {
    return this.invokeSnapshot('applyPerformanceMode', { mode });
  }
  updatePerformance(patch: Partial<PerformanceSettings>) {
    return this.invokeSnapshot('updatePerformance', { patch });
  }
  updateGraphics(patch: Partial<GraphicsSettings>) {
    return this.invokeSnapshot('updateGraphics', { patch });
  }
  updateSettings(patch: Partial<LauncherSettings>) {
    return this.invokeSnapshot('updateSettings', { patch });
  }
  updateHudLayout(layout: HudLayoutProfile) {
    return this.invokeSnapshot('updateHudLayout', { layout });
  }
  selectShaderPack(shaderId: string | null, quality?: ShaderPackEntry['selectedProfile']) {
    return this.invokeSnapshot('selectShaderPack', { shaderId, quality });
  }
  toggleResourcePack(packId: string, enabled: boolean) {
    return this.invokeSnapshot('toggleResourcePack', { packId, enabled });
  }
  async searchMods(query: string, category: ModCategory | 'all'): Promise<ModSearchResponse> {
    const raw = await this.invoke<Partial<ModSearchResponse>>('searchMods', { query, category });
    return {
      items: Array.isArray(raw?.items) ? raw.items : [],
      liveApiConnected: Boolean(raw?.liveApiConnected),
    };
  }
  async installMod(modId: string) {
    const raw = await this.invoke<{ result: unknown; snapshot: unknown }>(
      'installMod',
      { modId },
      90000
    );
    return {
      result: raw?.result,
      snapshot: validateAndNormalizeSnapshot(raw?.snapshot),
    };
  }
  toggleMod(modId: string, enabled: boolean) {
    return this.invokeSnapshot('toggleMod', { modId, enabled });
  }
  startDeviceAuth(clientId: string) {
    return this.invoke<DeviceCodeAuthChallenge>('startDeviceAuth', { clientId });
  }
  async pollDeviceAuth() {
    const raw = await this.invoke<{
      authStatus: { status: 'pending' | 'authenticated'; message: string };
      snapshot: unknown;
    }>('pollDeviceAuth');
    return {
      authStatus: raw.authStatus,
      snapshot: validateAndNormalizeSnapshot(raw.snapshot),
    };
  }
  switchAccount(accountId: string) {
    return this.invokeSnapshot('switchAccount', { accountId });
  }
  removeAccount(accountId: string) {
    return this.invokeSnapshot('removeAccount', { accountId });
  }
  prepareLaunch() {
    return this.invoke<LaunchPreparationReport>('prepareLaunch');
  }
  async verifyAndRepair() {
    const raw = await this.invoke<{
      repair: { instanceDir: string; repairedFiles: string[]; verifiedCount: number };
      snapshot: unknown;
    }>('verifyAndRepair', {}, 60000);
    return {
      repair: raw.repair,
      snapshot: validateAndNormalizeSnapshot(raw.snapshot),
    };
  }
  async launchMinecraft() {
    const raw = await this.invoke<{
      launchRes: {
        launched: boolean;
        pid: number | null;
        stageReached: string;
        message: string;
        preparation: LaunchPreparationReport;
      };
      snapshot: unknown;
    }>('launchMinecraft', {}, 180000);
    return {
      launchRes: raw.launchRes,
      snapshot: validateAndNormalizeSnapshot(raw.snapshot),
    };
  }
  applyAutoFix(actionId: string) {
    return this.invokeSnapshot('applyAutoFix', { actionId });
  }
  async runBenchmarks() {
    const raw = await this.invoke<{ report: BenchmarkSuiteReport; snapshot: unknown }>(
      'runBenchmarks',
      {},
      120000
    );
    const snapshot = validateAndNormalizeSnapshot(raw.snapshot);
    return {
      report: snapshot.latestBenchmark ?? raw.report,
      snapshot,
    };
  }
  syncVersions() {
    return this.invoke<{ versions: MinecraftVersionDescriptor[]; liveManifestFetched: boolean }>(
      'syncVersions'
    );
  }
}

export const bridge = new VesperaRpcBridge();
