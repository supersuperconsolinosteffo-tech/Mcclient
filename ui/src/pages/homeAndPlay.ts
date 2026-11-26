import { PERFORMANCE_MODE_PRESETS } from '@shared/performanceEngine';
import type {
  AppStateSnapshot,
  LaunchPreparationReport,
  MinecraftVersionDescriptor,
  ModloaderType,
  PageId,
  SupportTier,
  VersionInstallStatus,
} from '@shared/types';
import { escapeHtml } from '../icons';

export interface PlayPageFilterState {
  searchQuery: string;
  showReleases: boolean;
  showSnapshots: boolean;
  showHistorical: boolean;
  installedOnly: boolean;
  showNewProfileDrawer: boolean;
  fabricLoadersForActive: Array<{ version: string; stable: boolean }>;
}

function compatibilityBadgeHtml(v: MinecraftVersionDescriptor): string {
  const label =
    v.compatibilityLabel ||
    (v.vesperaModSupported
      ? 'Vespera Supported'
      : v.fabricSupported
        ? 'Fabric Supported'
        : v.type === 'snapshot'
          ? 'Experimental'
          : v.supportTier === 'unsupported'
            ? 'Unsupported'
            : 'Vanilla Only');

  switch (label) {
    case 'Vespera Supported':
      return `<span class="badge badge-supported">${escapeHtml(label)}</span>`;
    case 'Fabric Supported':
      return `<span class="badge badge-healthy">${escapeHtml(label)}</span>`;
    case 'Vanilla Only':
      return `<span class="badge badge-legacy">${escapeHtml(label)}</span>`;
    case 'Experimental':
      return `<span class="badge badge-experimental">${escapeHtml(label)}</span>`;
    default:
      return `<span class="badge badge-unsupported">${escapeHtml(label)}</span>`;
  }
}

function installStatusBadgeHtml(status: VersionInstallStatus | undefined): string {
  switch (status) {
    case 'ready':
    case 'installed':
      return `<span class="badge badge-supported">✓ Ready to Launch</span>`;
    case 'downloading':
      return `<span class="badge badge-experimental">⬇ Downloading…</span>`;
    case 'installing':
      return `<span class="badge badge-experimental">⚙ Extracting Natives…</span>`;
    case 'partially_downloaded':
      return `<span class="badge badge-warning">◐ Partially Downloaded</span>`;
    case 'metadata_cached':
      return `<span class="badge badge-legacy">◌ Metadata Cached</span>`;
    case 'update_available':
      return `<span class="badge badge-warning">↑ Update Available</span>`;
    case 'failed':
      return `<span class="badge badge-critical">✕ Install Failed</span>`;
    default:
      return `<span class="badge" style="background:rgba(148,163,184,0.12);color:var(--text-secondary)">○ Not Installed</span>`;
  }
}

function formatBytesHuman(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatReleaseDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function renderHomePage(snap: AppStateSnapshot): string {
  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const activeAcc = snap.accounts.find((a) => a.id === snap.activeAccountId) ?? null;
  const modePreset = PERFORMANCE_MODE_PRESETS[activeProfile.performance.mode];
  const healthyFindings = snap.diagnostics.filter(
    (d) => d.severity === 'critical' || d.severity === 'warning'
  );
  const benchBest = snap.latestBenchmark?.results.find((r) => r.scenarioId === 'vespera_max_fps');
  const benchBase = snap.latestBenchmark?.results.find((r) => r.scenarioId === 'vanilla_baseline');
  const isOfflineMode =
    snap.offlineAvailability?.activeSessionMode === 'offline_singleplayer';

  const loaderLabel =
    activeProfile.loader === 'vanilla'
      ? 'OFFICIAL VANILLA'
      : activeProfile.loader === 'legacy_fabric'
        ? `LEGACY FABRIC ${activeProfile.loaderVersion}`
        : `FABRIC ${activeProfile.loaderVersion}`;

  return `
    <div class="hero-banner">
      <div style="max-width:640px">
        <div class="hero-kicker">VESPERA ENGINE v${escapeHtml(snap.version)} · ${escapeHtml(loaderLabel)} · DYNAMIC MOJANG MANIFEST</div>
        <h1 class="hero-heading">Zero Visual Compromise. Any Official Minecraft Version.</h1>
        <p style="color:var(--text-secondary);font-size:13.5px;margin-bottom:16px">
          Active Profile: <strong style="color:var(--text-primary)">${escapeHtml(activeProfile.name)}</strong> ·
          Minecraft <strong style="color:var(--accent-amber-bright)">${escapeHtml(activeProfile.mcVersion)}</strong> ·
          ${
            activeProfile.loader === 'vanilla'
              ? 'Unmodified Official Vanilla Runtime'
              : `${activeProfile.enabledModIds.length} compatible client modules enabled`
          } ·
          Render Distance ${activeProfile.graphics.renderDistanceChunks} chunks
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <button class="btn btn-primary btn-launch" data-action="launch-now">
            ▶ ${isOfflineMode ? `Play Offline Singleplayer (${escapeHtml(activeProfile.mcVersion)})` : `Launch Minecraft ${escapeHtml(activeProfile.mcVersion)}`}
          </button>
          <button class="btn" data-nav-target="play">Browse Versions (${snap.versions.filter((v) => v.supportTier !== 'unsupported').length})</button>
          <button class="btn" data-nav-target="mods">Mods &amp; HUD Studio</button>
          <button class="btn btn-cyan" data-nav-target="diagnostics">Run Benchmark Suite</button>
        </div>
      </div>

      <div class="card elevated" style="min-width:275px">
        <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted);text-transform:uppercase">Session Readiness</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;font-size:12.5px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <span style="color:var(--text-secondary)">Session:</span>
            <strong style="color:${isOfflineMode ? '#38bdf8' : activeAcc && activeAcc.sessionStatus !== 'signed_out' ? '#34d399' : '#fbbf24'}">
              ${
                isOfflineMode
                  ? `${escapeHtml(snap.offlineAvailability?.verifiedUsername || 'Verified')} (Offline SP)`
                  : activeAcc && activeAcc.sessionStatus !== 'signed_out'
                    ? escapeHtml(activeAcc.username)
                    : 'Sign-In Required'
              }
            </strong>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Modloader:</span>
            <strong>${escapeHtml(activeProfile.loader.toUpperCase())}</strong>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Allocated Heap:</span>
            <span style="font-family:var(--font-mono)">${activeProfile.performance.allocatedRamMb} MB (${escapeHtml(modePreset.title.split(' ')[0])})</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Config Doctor:</span>
            <span class="${healthyFindings.length === 0 ? 'badge badge-healthy' : 'badge badge-warning'}">
              ${healthyFindings.length === 0 ? 'Verified Clean' : `${healthyFindings.length} Advisory`}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-4" style="margin-bottom:18px">
      <div class="card">
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">LAUNCHER FOOTPRINT</div>
        <div style="font-size:22px;font-weight:800;font-family:var(--font-mono);color:var(--accent-cyan);margin-top:4px">${snap.telemetry.launcherProcessRamMb} MB</div>
        <div class="card-desc">Idle background mode enabled during gameplay</div>
      </div>
      <div class="card">
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">HOST SYSTEM RAM</div>
        <div style="font-size:22px;font-weight:800;font-family:var(--font-mono);margin-top:4px">${snap.telemetry.availableSystemRamMb} <span style="font-size:13px;color:var(--text-secondary)">/ ${snap.telemetry.totalSystemRamMb} MB free</span></div>
        <div class="card-desc">Recommended MC Heap: ${snap.telemetry.recommendedMinecraftRamMb} MB</div>
      </div>
      <div class="card">
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">VERSION CATALOG</div>
        <div style="font-size:22px;font-weight:800;font-family:var(--font-mono);color:var(--accent-amber-bright);margin-top:4px">${snap.versions.filter((v) => v.supportTier !== 'unsupported').length} Versions</div>
        <div class="card-desc">Vanilla + Fabric + Vespera 1.21.4 + Legacy Java 8/17/21</div>
      </div>
      <div class="card">
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">MEASURED PIPELINE GAIN</div>
        <div style="font-size:22px;font-weight:800;font-family:var(--font-mono);color:#34d399;margin-top:4px">
          ${
            benchBest && benchBase && benchBest.metrics.avgFps && benchBase.metrics.avgFps
              ? `+${Math.round(((benchBest.metrics.avgFps - benchBase.metrics.avgFps) / benchBase.metrics.avgFps) * 100)}%`
              : 'Run Suite'
          }
        </div>
        <div class="card-desc">
          ${
            benchBest?.metrics.peakHeapUsedMb
              ? `Peak Heap ${benchBest.metrics.peakHeapUsedMb} MB vs ${benchBase?.metrics.peakHeapUsedMb} MB baseline`
              : 'Open Diagnostics to measure on OpenJDK 21'
          }
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>Quick Performance Mode Switcher</span>
          <button class="btn btn-sm" data-nav-target="performance">Full Tuning →</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px">
          ${(['max_fps', 'balanced', 'visual_quality', 'custom'] as const)
            .map((modeId) => {
              const p = PERFORMANCE_MODE_PRESETS[modeId];
              const isSelected = activeProfile.performance.mode === modeId;
              return `
                <div class="card selectable ${isSelected ? 'selected' : ''}" data-quick-perf-mode="${modeId}" style="padding:12px">
                  <div style="font-weight:700;font-size:13px;color:${isSelected ? 'var(--accent-amber-bright)' : 'var(--text-primary)'}">${escapeHtml(p.title)}</div>
                  <div style="font-size:11.5px;color:var(--text-secondary);margin-top:3px">${escapeHtml(p.subtitle)}</div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Recent Client Activity &amp; Integrity Feed</span>
          <button class="btn btn-sm" data-action="verify-repair">Verify &amp; Repair Files</button>
        </div>
        <div class="console-box" style="margin-top:12px;max-height:175px">${escapeHtml(
          snap.recentLogs.slice(-12).reverse().join('\n') || 'Ready.'
        )}</div>
      </div>
    </div>
  `;
}

const DEFAULT_PLAY_FILTER_STATE: PlayPageFilterState = {
  searchQuery: '',
  showReleases: true,
  showSnapshots: false,
  showHistorical: false,
  installedOnly: false,
  showNewProfileDrawer: false,
  fabricLoadersForActive: [],
};

export function renderPlayPage(
  snap: AppStateSnapshot,
  prepReport: LaunchPreparationReport | null,
  playStateInput?: PlayPageFilterState | null,
  installingVersionId: string | null = null
): string {
  const playState = playStateInput ?? DEFAULT_PLAY_FILTER_STATE;
  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const activeAcc = snap.accounts.find((a) => a.id === snap.activeAccountId) ?? null;
  const activeVersionDesc =
    snap.versions.find((v) => v.id === activeProfile.mcVersion) ?? snap.versions[0];
  const activeInstallStatus = activeVersionDesc?.installStatus ?? 'not_installed';
  const isOfflineMode =
    snap.offlineAvailability?.activeSessionMode === 'offline_singleplayer';
  const dl = snap.activeDownload;

  const q = playState.searchQuery.trim().toLowerCase();
  const filteredVersions = snap.versions.filter((v) => {
    if (v.supportTier === 'unsupported') return false;
    if (playState.installedOnly && v.installStatus !== 'ready' && v.installStatus !== 'installed') {
      return false;
    }
    const isRelease = v.type === 'release';
    const isSnap = v.type === 'snapshot';
    const isHist = v.type === 'old_beta' || v.type === 'old_alpha';
    // When user types an explicit search query, search across enabled categories (or all if query matches exact ID)
    if (!q) {
      if (isRelease && !playState.showReleases) return false;
      if (isSnap && !playState.showSnapshots) return false;
      if (isHist && !playState.showHistorical) return false;
    } else {
      const matchesText =
        v.id.toLowerCase().includes(q) ||
        v.type.toLowerCase().includes(q) ||
        (v.compatibilityLabel || '').toLowerCase().includes(q);
      if (!matchesText) return false;
    }
    return true;
  });

  const resolvedJava =
    snap.javaRuntimes.find((r) => r.major === (activeVersionDesc?.recommendedJavaMajor ?? 21)) ??
    snap.javaRuntimes[0];

  const resolvedGameDir =
    activeProfile.customGameDir && activeProfile.customGameDir.trim()
      ? activeProfile.customGameDir
      : `${snap.settings.instancesDir}/${activeProfile.id}`;

  const primaryBtnLabel =
    installingVersionId === activeProfile.mcVersion || dl?.active
      ? `⬇ INSTALLING ${activeProfile.mcVersion}…`
      : isOfflineMode
        ? `▶ PLAY OFFLINE SINGLEPLAYER (${activeProfile.mcVersion})`
        : activeInstallStatus === 'ready'
          ? `▶ PLAY MINECRAFT ${activeProfile.mcVersion}`
          : activeInstallStatus === 'partially_downloaded'
            ? `↻ RESUME & PLAY ${activeProfile.mcVersion}`
            : `⬇ INSTALL & PLAY ${activeProfile.mcVersion}`;

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Play &amp; Dynamic Minecraft Version Manager</h2>
        <p class="page-subtitle">
          Select, download, verify, repair, and launch any official Minecraft: Java Edition version (Vanilla, Fabric Loader, or Vespera 1.21.4) with isolated game directories and automatic Java 8 / 17 / 21 runtime matching.
        </p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="btn-toggle-new-install-drawer">+ New Installation Profile</button>
        <button class="btn" id="btn-sync-mojang-manifest">↻ Refresh Mojang Manifest</button>
        <button class="btn" data-action="verify-repair">✓ Verify &amp; Repair</button>
      </div>
    </div>

    <!-- 1. CENTRAL PLAY & INSTALLATION HERO HUB -->
    <div class="card elevated" style="margin-bottom:18px;border-color:rgba(245,158,11,0.35)">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px">
        <div style="flex:1;min-width:290px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
            <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);text-transform:uppercase">ACTIVE INSTALLATION</span>
            ${activeVersionDesc ? compatibilityBadgeHtml(activeVersionDesc) : ''}
            ${installStatusBadgeHtml(activeInstallStatus)}
            ${
              isOfflineMode
                ? `<span class="badge badge-experimental">OFFLINE SINGLEPLAYER MODE</span>`
                : ''
            }
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:8px">
            <div>
              <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">INSTALLATION PROFILE</div>
              <select class="select" id="play-profile-selector" style="width:100%;margin-top:4px">
                ${snap.profiles
                  .map(
                    (p) =>
                      `<option value="${escapeHtml(p.id)}" ${p.id === activeProfile.id ? 'selected' : ''}>${escapeHtml(p.name)} — MC ${escapeHtml(p.mcVersion)} (${escapeHtml(p.loader.toUpperCase())})</option>`
                  )
                  .join('')}
              </select>
            </div>

            <div>
              <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">MINECRAFT VERSION</div>
              <div style="margin-top:4px;padding:7px 11px;border-radius:6px;background:var(--bg-canvas);border:1px solid var(--border-subtle);font-family:var(--font-mono);font-weight:700;font-size:13px;display:flex;justify-content:space-between;align-items:center">
                <span>${escapeHtml(activeProfile.mcVersion)}</span>
                <span style="font-size:11px;color:var(--text-secondary)">Java ${activeVersionDesc?.recommendedJavaMajor ?? 21}</span>
              </div>
            </div>

            <div>
              <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">SELECTED ACCOUNT</div>
              <button class="btn" id="play-account-jump" style="width:100%;margin-top:4px;justify-content:space-between">
                <span>
                  ${
                    isOfflineMode
                      ? `◐ ${escapeHtml(snap.offlineAvailability?.verifiedUsername || 'Verified Local')} (Offline SP)`
                      : activeAcc && activeAcc.sessionStatus !== 'signed_out'
                        ? `● ${escapeHtml(activeAcc.username)}`
                        : '○ Sign in with Microsoft'
                  }
                </span>
                <span style="font-size:11px;color:var(--text-muted)">Manage →</span>
              </button>
            </div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;min-width:250px">
          <button
            class="btn btn-primary btn-launch"
            data-action="launch-now"
            style="width:100%;justify-content:center;padding:13px 20px;font-size:14px"
            ${dl?.active || installingVersionId ? 'disabled' : ''}
          >
            ${escapeHtml(primaryBtnLabel)}
          </button>
          <div style="display:flex;gap:8px">
            <button
              class="btn btn-sm btn-cyan"
              id="btn-install-active-version-only"
              style="flex:1"
              ${dl?.active || installingVersionId ? 'disabled' : ''}
            >
              ${activeInstallStatus === 'ready' ? '↻ Re-Verify / Repair Files' : '⬇ Download & Install Files'}
            </button>
            ${
              snap.offlineAvailability?.eligible && !isOfflineMode
                ? `<button class="btn btn-sm" id="btn-switch-offline-sp" title="Launch local singleplayer worlds without multiplayer">Offline SP</button>`
                : isOfflineMode
                  ? `<button class="btn btn-sm" id="btn-restore-online-sp">Go Online</button>`
                  : ''
            }
          </div>
        </div>
      </div>

      ${
        dl && (dl.active || dl.status === 'failed' || dl.percent === 100)
          ? `
        <div style="margin-top:16px;padding:12px 14px;border-radius:8px;background:var(--bg-canvas);border:1px solid ${
          dl.status === 'failed' ? 'rgba(239,68,68,0.45)' : 'var(--accent-cyan)'
        }">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div>
              <strong style="font-size:13px;color:var(--text-primary)">
                Minecraft ${escapeHtml(dl.versionId || activeProfile.mcVersion)} (${escapeHtml(dl.loader.toUpperCase())})
              </strong>
              <span style="font-size:12px;color:var(--text-secondary);margin-left:8px">${escapeHtml(dl.stage)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:12px;font-family:var(--font-mono);font-size:11.5px">
              <span>${formatBytesHuman(dl.bytesDownloaded)} / ${formatBytesHuman(dl.totalBytes)}</span>
              ${
                dl.active && dl.speedBytesPerSec > 0
                  ? `<span style="color:var(--accent-cyan)">${formatBytesHuman(dl.speedBytesPerSec)}/s</span>`
                  : ''
              }
              ${
                dl.active && dl.etaSeconds !== null
                  ? `<span>ETA ${dl.etaSeconds}s</span>`
                  : ''
              }
              <strong>${dl.percent}%</strong>
              ${
                dl.cancellable
                  ? `<button class="btn btn-sm btn-danger" id="btn-cancel-version-download">✕ Cancel</button>`
                  : ''
              }
            </div>
          </div>
          <div style="margin-top:8px;height:8px;border-radius:999px;background:rgba(148,163,184,0.16);overflow:hidden">
            <div style="height:100%;width:${Math.max(2, dl.percent)}%;background:${
              dl.status === 'failed'
                ? '#ef4444'
                : dl.status === 'ready'
                  ? '#10b981'
                  : 'linear-gradient(90deg,var(--accent-amber),var(--accent-cyan))'
            };transition:width 0.2s ease"></div>
          </div>
        </div>
      `
          : ''
      }
    </div>

    ${
      playState.showNewProfileDrawer
        ? `
      <div class="card" style="margin-bottom:18px;border-color:var(--accent-cyan)">
        <div class="card-title">
          <span>Create Isolated Installation Profile</span>
          <button class="btn btn-sm" id="btn-close-new-install-drawer">Close</button>
        </div>
        <div class="card-desc">Every installation uses an isolated directory so Vanilla, Fabric, modern 1.21.4, 1.20.4, and legacy 1.8.9 / 1.12.2 configurations never collide.</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:12px">
          <div>
            <div class="form-label">Profile Name</div>
            <input type="text" class="input" id="new-prof-name" placeholder="e.g. Vanilla 1.20.4 SMP" style="width:100%;margin-top:4px" />
          </div>
          <div>
            <div class="form-label">Minecraft Version</div>
            <select class="select" id="new-prof-mcver" style="width:100%;margin-top:4px">
              ${snap.versions
                .filter((v) => v.supportTier !== 'unsupported')
                .slice(0, 120)
                .map(
                  (v) =>
                    `<option value="${escapeHtml(v.id)}" ${v.id === activeProfile.mcVersion ? 'selected' : ''}>${escapeHtml(v.id)} (${escapeHtml(v.type)} · Java ${v.recommendedJavaMajor})</option>`
                )
                .join('')}
            </select>
          </div>
          <div>
            <div class="form-label">Modloader</div>
            <select class="select" id="new-prof-loader" style="width:100%;margin-top:4px">
              <option value="vanilla">Vanilla (Official Unmodified)</option>
              <option value="fabric" selected>Fabric Loader</option>
            </select>
          </div>
          <div>
            <div class="form-label">Custom Java Path (Optional)</div>
            <input type="text" class="input" id="new-prof-java" placeholder="Auto-managed Java 8/17/21" style="width:100%;margin-top:4px;font-family:var(--font-mono)" />
          </div>
        </div>
        <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
          <button class="btn btn-primary" id="btn-submit-new-install-profile">Create &amp; Switch to Profile</button>
        </div>
      </div>
    `
        : ''
    }

    <!-- 2. DYNAMIC VERSION SELECTOR & BROWSER -->
    <div class="card" style="margin-bottom:18px">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px">
        <div>
          <div class="card-title" style="margin-bottom:2px">
            <span>Official Minecraft Version Browser (${filteredVersions.length} shown of ${snap.versions.filter((v) => v.supportTier !== 'unsupported').length})</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-muted)">
            Manifest Source: <code style="color:var(--accent-cyan)">${escapeHtml(
              snap.manifestSource === 'live_mojang'
                ? 'Live Mojang Piston Manifest (version_manifest_v2.json)'
                : snap.manifestSource === 'local_cache'
                  ? 'Cached Mojang Manifest (version_manifest_v2.json)'
                  : 'Embedded Official Mojang Seed (Click Refresh when online for all 850+ versions)'
            )}</code>
          </div>
        </div>

        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${
            snap.latestReleaseId
              ? `<button class="btn btn-sm" data-quick-select-version="${escapeHtml(snap.latestReleaseId)}">★ Latest Release (${escapeHtml(snap.latestReleaseId)})</button>`
              : ''
          }
          ${
            snap.latestSnapshotId
              ? `<button class="btn btn-sm" data-quick-select-version="${escapeHtml(snap.latestSnapshotId)}">⚡ Latest Snapshot (${escapeHtml(snap.latestSnapshotId)})</button>`
              : ''
          }
        </div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
        <input
          type="search"
          class="input"
          id="play-version-search"
          placeholder="Search version ID (e.g. 1.21.4, 1.21.1, 1.20.4, 1.20.1, 1.16.5, 1.12.2, 1.8.9)…"
          value="${escapeHtml(playState.searchQuery)}"
          style="flex:1;min-width:260px;font-family:var(--font-mono)"
        />
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="flt-releases" ${playState.showReleases ? 'checked' : ''} /> Releases
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="flt-snapshots" ${playState.showSnapshots ? 'checked' : ''} /> Snapshots
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="flt-historical" ${playState.showHistorical ? 'checked' : ''} /> Historical (Beta/Alpha)
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="flt-installed-only" ${playState.installedOnly ? 'checked' : ''} /> Installed Only
        </label>
      </div>

      <div style="overflow-x:auto;max-height:370px;overflow-y:auto;border:1px solid var(--border-subtle);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead style="position:sticky;top:0;background:var(--bg-elevated);z-index:1">
            <tr style="border-bottom:1px solid var(--border-strong);text-align:left;color:var(--text-muted);font-family:var(--font-mono);font-size:11px">
              <th style="padding:9px 10px">VERSION</th>
              <th style="padding:9px 10px">CATEGORY</th>
              <th style="padding:9px 10px">RELEASED</th>
              <th style="padding:9px 10px">JAVA</th>
              <th style="padding:9px 10px">COMPATIBILITY</th>
              <th style="padding:9px 10px">INSTALL STATUS</th>
              <th style="padding:9px 10px;text-align:right">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            ${
              filteredVersions.length === 0
                ? `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-muted)">No versions match your current search/category filters. Enable Snapshots or Historical above to browse archive builds.</td></tr>`
                : filteredVersions
                    .slice(0, 200)
                    .map((v) => {
                      const isCurrent = v.id === activeProfile.mcVersion;
                      const isReady =
                        v.installStatus === 'ready' || v.installStatus === 'installed';
                      return `
                      <tr style="border-bottom:1px solid var(--border-subtle);background:${
                        isCurrent ? 'rgba(245,158,11,0.08)' : 'transparent'
                      }">
                        <td style="padding:9px 10px;font-weight:700;font-family:var(--font-mono)">
                          ${escapeHtml(v.id)}
                          ${isCurrent ? `<span style="color:var(--accent-amber-bright);font-size:10.5px;margin-left:4px">● ACTIVE</span>` : ''}
                        </td>
                        <td style="padding:9px 10px;font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary)">${escapeHtml(v.type)}</td>
                        <td style="padding:9px 10px;font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary)">${escapeHtml(formatReleaseDate(v.releaseTime))}</td>
                        <td style="padding:9px 10px;font-family:var(--font-mono)">Java ${v.recommendedJavaMajor}</td>
                        <td style="padding:9px 10px">${compatibilityBadgeHtml(v)}</td>
                        <td style="padding:9px 10px">${installStatusBadgeHtml(v.installStatus)}</td>
                        <td style="padding:9px 10px;text-align:right;white-space:nowrap">
                          <button class="btn btn-sm ${isCurrent ? 'btn-primary' : ''}" data-select-version-for-active="${escapeHtml(v.id)}">
                            ${isCurrent ? 'Selected' : 'Select'}
                          </button>
                          <button class="btn btn-sm" data-install-version-id="${escapeHtml(v.id)}" ${dl?.active ? 'disabled' : ''}>
                            ${isReady ? '↻ Repair' : '⬇ Install'}
                          </button>
                          <button class="btn btn-sm" data-create-version-profile="${escapeHtml(v.id)}">+ Profile</button>
                          ${
                            isReady || v.installStatus === 'partially_downloaded'
                              ? `<button class="btn btn-sm btn-danger" data-delete-version-id="${escapeHtml(v.id)}" title="Delete downloaded version JAR & natives (keeps profiles & world saves)">Delete</button>`
                              : ''
                          }
                        </td>
                      </tr>
                    `;
                    })
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>

    <!-- 3. INSTALLATION DETAILS & PRE-FLIGHT JVM INSPECTOR -->
    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>Installation Details — ${escapeHtml(activeProfile.name)}</span>
          <span class="badge badge-healthy">Isolated Instance</span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px">
          <div>
            <div class="form-label">Modloader Mode</div>
            <select class="select" id="detail-loader-select" style="width:100%;margin-top:4px">
              <option value="vanilla" ${activeProfile.loader === 'vanilla' ? 'selected' : ''}>Official Vanilla</option>
              ${
                activeVersionDesc?.fabricSupported !== false
                  ? `<option value="fabric" ${activeProfile.loader === 'fabric' ? 'selected' : ''}>Fabric Loader</option>`
                  : ''
              }
              ${
                activeProfile.mcVersion === '1.8.9'
                  ? `<option value="legacy_fabric" ${activeProfile.loader === 'legacy_fabric' ? 'selected' : ''}>Legacy Fabric (1.8.9)</option>`
                  : ''
              }
            </select>
          </div>

          <div>
            <div class="form-label">Loader Version</div>
            <select class="select" id="detail-loader-ver-select" style="width:100%;margin-top:4px" ${activeProfile.loader === 'vanilla' ? 'disabled' : ''}>
              ${
                activeProfile.loader === 'vanilla'
                  ? `<option value="vanilla">Official Mojang Vanilla</option>`
                  : (playState.fabricLoadersForActive.length > 0
                      ? playState.fabricLoadersForActive
                      : [{ version: activeProfile.loaderVersion || '0.16.10', stable: true }]
                    )
                      .map(
                        (l) =>
                          `<option value="${escapeHtml(l.version)}" ${l.version === activeProfile.loaderVersion ? 'selected' : ''}>${escapeHtml(l.version)}${l.stable ? ' (stable)' : ''}</option>`
                      )
                      .join('')
              }
            </select>
          </div>
        </div>

        <div style="margin-top:12px;display:flex;flex-direction:column;gap:7px;font-size:12.5px;padding:10px 12px;border-radius:8px;background:var(--bg-canvas);border:1px solid var(--border-subtle)">
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Vespera Custom Mod:</span>
            <strong>${
              activeProfile.loader === 'fabric' && activeVersionDesc?.vesperaModSupported
                ? '✓ Enabled & Verified (1.21.4)'
                : `Not Injected (Isolated ${escapeHtml(activeProfile.loader.toUpperCase())} ${escapeHtml(activeProfile.mcVersion)})`
            }</strong>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Resolved Java Runtime:</span>
            <span style="font-family:var(--font-mono)">Java ${activeVersionDesc?.recommendedJavaMajor ?? 21} (${escapeHtml(
              activeProfile.customJavaPath || resolvedJava?.vendor || 'Temurin'
            )})</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Enabled Mods:</span>
            <span>${activeProfile.loader === 'vanilla' ? '0 (Pure Vanilla)' : `${activeProfile.enabledModIds.length} modules`}</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:12px">
            <span style="color:var(--text-secondary)">Game Directory:</span>
            <code style="font-size:11px;color:var(--accent-cyan);word-break:break-all">${escapeHtml(resolvedGameDir)}</code>
          </div>
        </div>

        <div class="form-row" style="margin-top:10px">
          <div style="flex:1">
            <div class="form-label">Custom Java Executable Override (Optional)</div>
            <input
              type="text"
              class="input"
              id="detail-custom-java-input"
              value="${escapeHtml(activeProfile.customJavaPath || '')}"
              placeholder="Leave blank to auto-select Java ${activeVersionDesc?.recommendedJavaMajor ?? 21}"
              style="width:100%;margin-top:4px;font-family:var(--font-mono)"
            />
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Verified Pre-Flight JVM Command (${escapeHtml(activeProfile.mcVersion)})</span>
          <button class="btn btn-sm btn-primary" data-action="inspect-launch-cmd">Inspect JVM Command</button>
        </div>
        <div class="card-desc">
          Main Class: <code style="color:var(--accent-cyan)">${escapeHtml(
            prepReport?.mainClass ??
              (activeProfile.loader === 'vanilla'
                ? 'net.minecraft.client.main.Main'
                : 'net.fabricmc.loader.impl.launch.knot.Client')
          )}</code>
        </div>
        ${
          prepReport && prepReport.warnings.length > 0
            ? `<div style="margin-top:10px;padding:10px;border-radius:6px;background:var(--accent-amber-dim);border:1px solid rgba(245,158,11,0.35);font-size:12px;color:var(--accent-amber-bright)">
                ${prepReport.warnings.map((w) => `<div>• ${escapeHtml(w)}</div>`).join('')}
              </div>`
            : ''
        }
        <div class="console-box" style="margin-top:12px;max-height:145px">${escapeHtml(
          prepReport?.commandPreview ??
            'Click "Inspect JVM Command" to preview full classpath, Java runtime, natives path, and arguments (session tokens redacted).'
        )}</div>

        <div style="font-size:11.5px;font-weight:700;color:var(--text-secondary);margin-top:12px">Recent Installer &amp; Launch Logs</div>
        <div class="console-box" style="margin-top:6px;max-height:110px">${escapeHtml(
          snap.recentLogs.slice(-10).reverse().join('\n') || 'Ready.'
        )}</div>
      </div>
    </div>
  `;
}

export interface HomeAndPlayCallbacks {
  onNavigate: (page: PageId) => void;
  onQuickPerfMode: (mode: 'max_fps' | 'balanced' | 'visual_quality' | 'custom') => void;
  onSelectProfile: (profileId: string) => void;
  onSelectVersionForActive: (mcVersion: string) => void;
  onCreateVersionInstance: (params: {
    name?: string;
    mcVersion: string;
    loader?: ModloaderType;
    customJavaPath?: string;
  }) => void;
  onUpdateActiveInstallation: (patch: {
    loader?: ModloaderType;
    loaderVersion?: string;
    customJavaPath?: string;
  }) => void;
  onInstallVersion: (versionId: string, forceRepair?: boolean) => void;
  onCancelDownload: () => void;
  onDeleteVersion: (versionId: string) => void;
  onSyncManifest: () => void;
  onInspectLaunch: () => void;
  onFilterChange: (patch: Partial<PlayPageFilterState>) => void;
  onToggleSessionMode: (mode: 'online_authenticated' | 'offline_singleplayer') => void;
}

export function bindHomeAndPlayEvents(
  stage: HTMLElement,
  callbacks: HomeAndPlayCallbacks
): void {
  stage.querySelectorAll<HTMLElement>('[data-nav-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      callbacks.onNavigate(btn.dataset.navTarget as PageId);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-quick-perf-mode]').forEach((card) => {
    card.addEventListener('click', () => {
      callbacks.onQuickPerfMode(
        card.dataset.quickPerfMode as 'max_fps' | 'balanced' | 'visual_quality' | 'custom'
      );
    });
  });

  stage.querySelector('#play-profile-selector')?.addEventListener('change', (ev) => {
    callbacks.onSelectProfile((ev.target as HTMLSelectElement).value);
  });

  stage.querySelector('#play-account-jump')?.addEventListener('click', () => {
    callbacks.onNavigate('accounts');
  });

  stage.querySelector('#btn-toggle-new-install-drawer')?.addEventListener('click', () => {
    callbacks.onFilterChange({ showNewProfileDrawer: true });
  });
  stage.querySelector('#btn-close-new-install-drawer')?.addEventListener('click', () => {
    callbacks.onFilterChange({ showNewProfileDrawer: false });
  });

  stage.querySelector('#btn-submit-new-install-profile')?.addEventListener('click', () => {
    const name =
      (stage.querySelector('#new-prof-name') as HTMLInputElement | null)?.value.trim() || '';
    const mcVersion =
      (stage.querySelector('#new-prof-mcver') as HTMLSelectElement | null)?.value || '1.21.4';
    const loader = ((stage.querySelector('#new-prof-loader') as HTMLSelectElement | null)
      ?.value || 'vanilla') as ModloaderType;
    const customJavaPath =
      (stage.querySelector('#new-prof-java') as HTMLInputElement | null)?.value.trim() ||
      undefined;
    callbacks.onCreateVersionInstance({ name, mcVersion, loader, customJavaPath });
  });

  stage.querySelector('#play-version-search')?.addEventListener('input', (ev) => {
    callbacks.onFilterChange({ searchQuery: (ev.target as HTMLInputElement).value });
  });
  stage.querySelector('#flt-releases')?.addEventListener('change', (ev) => {
    callbacks.onFilterChange({ showReleases: (ev.target as HTMLInputElement).checked });
  });
  stage.querySelector('#flt-snapshots')?.addEventListener('change', (ev) => {
    callbacks.onFilterChange({ showSnapshots: (ev.target as HTMLInputElement).checked });
  });
  stage.querySelector('#flt-historical')?.addEventListener('change', (ev) => {
    callbacks.onFilterChange({ showHistorical: (ev.target as HTMLInputElement).checked });
  });
  stage.querySelector('#flt-installed-only')?.addEventListener('change', (ev) => {
    callbacks.onFilterChange({ installedOnly: (ev.target as HTMLInputElement).checked });
  });

  stage.querySelectorAll<HTMLElement>('[data-quick-select-version]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ver = btn.dataset.quickSelectVersion;
      if (ver) callbacks.onSelectVersionForActive(ver);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-select-version-for-active]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ver = btn.dataset.selectVersionForActive;
      if (ver) callbacks.onSelectVersionForActive(ver);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-create-version-profile]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ver = btn.dataset.createVersionProfile;
      if (ver) callbacks.onCreateVersionInstance({ mcVersion: ver });
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-install-version-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ver = btn.dataset.installVersionId;
      const isRepair = btn.textContent?.includes('Repair') ?? false;
      if (ver) callbacks.onInstallVersion(ver, isRepair);
    });
  });

  stage.querySelector('#btn-install-active-version-only')?.addEventListener('click', () => {
    const activeVer = stage
      .querySelector('[data-select-version-for-active].btn-primary')
      ?.getAttribute('data-select-version-for-active');
    const isRepair =
      stage
        .querySelector('#btn-install-active-version-only')
        ?.textContent?.includes('Repair') ?? false;
    callbacks.onInstallVersion(activeVer || '', isRepair);
  });

  stage.querySelector('#btn-cancel-version-download')?.addEventListener('click', () => {
    callbacks.onCancelDownload();
  });

  stage.querySelectorAll<HTMLElement>('[data-delete-version-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ver = btn.dataset.deleteVersionId;
      if (ver) callbacks.onDeleteVersion(ver);
    });
  });

  stage.querySelector('#detail-loader-select')?.addEventListener('change', (ev) => {
    callbacks.onUpdateActiveInstallation({
      loader: (ev.target as HTMLSelectElement).value as ModloaderType,
    });
  });

  stage.querySelector('#detail-loader-ver-select')?.addEventListener('change', (ev) => {
    callbacks.onUpdateActiveInstallation({
      loaderVersion: (ev.target as HTMLSelectElement).value,
    });
  });

  stage.querySelector('#detail-custom-java-input')?.addEventListener('change', (ev) => {
    callbacks.onUpdateActiveInstallation({
      customJavaPath: (ev.target as HTMLInputElement).value.trim(),
    });
  });

  stage.querySelector('#btn-switch-offline-sp')?.addEventListener('click', () => {
    callbacks.onToggleSessionMode('offline_singleplayer');
  });

  stage.querySelector('#btn-restore-online-sp')?.addEventListener('click', () => {
    callbacks.onToggleSessionMode('online_authenticated');
  });

  stage
    .querySelector('#btn-sync-mojang-manifest')
    ?.addEventListener('click', callbacks.onSyncManifest);

  stage
    .querySelector('[data-action="inspect-launch-cmd"]')
    ?.addEventListener('click', callbacks.onInspectLaunch);
}
