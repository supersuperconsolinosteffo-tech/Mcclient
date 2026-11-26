import { PERFORMANCE_MODE_PRESETS } from '@shared/performanceEngine';
import type {
  AppStateSnapshot,
  LaunchPreparationReport,
  PageId,
  SupportTier,
} from '@shared/types';
import { escapeHtml } from '../icons';

function tierBadgeClass(tier: SupportTier): string {
  switch (tier) {
    case 'supported':
      return 'badge badge-supported';
    case 'experimental':
      return 'badge badge-experimental';
    case 'legacy_pvp':
      return 'badge badge-legacy';
    default:
      return 'badge badge-unsupported';
  }
}

export function renderHomePage(snap: AppStateSnapshot): string {
  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const activeAcc = snap.accounts.find((a) => a.id === snap.activeAccountId) ?? null;
  const modePreset = PERFORMANCE_MODE_PRESETS[activeProfile.performance.mode];
  const healthyFindings = snap.diagnostics.filter((d) => d.severity === 'critical' || d.severity === 'warning');
  const benchBest = snap.latestBenchmark?.results.find((r) => r.scenarioId === 'vespera_max_fps');
  const benchBase = snap.latestBenchmark?.results.find((r) => r.scenarioId === 'vanilla_baseline');

  return `
    <div class="hero-banner">
      <div style="max-width:640px">
        <div class="hero-kicker">VESPERA ENGINE v${escapeHtml(snap.version)} · FABRIC ${escapeHtml(activeProfile.loaderVersion)} · JAVA 21 ZGC READY</div>
        <h1 class="hero-heading">Zero Visual Compromise. Sub-Millisecond Frame Pacing.</h1>
        <p style="color:var(--text-secondary);font-size:13.5px;margin-bottom:16px">
          Active Profile: <strong style="color:var(--text-primary)">${escapeHtml(activeProfile.name)}</strong> ·
          Minecraft <strong style="color:var(--accent-amber-bright)">${escapeHtml(activeProfile.mcVersion)}</strong> ·
          ${activeProfile.enabledModIds.length} verified client modules enabled ·
          Render Distance ${activeProfile.graphics.renderDistanceChunks} chunks (${escapeHtml(activeProfile.graphics.smoothLighting)} lighting)
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <button class="btn btn-primary btn-launch" data-action="launch-now">▶ Launch Minecraft ${escapeHtml(activeProfile.mcVersion)}</button>
          <button class="btn" data-nav-target="mods">Configure Mods & HUD Editor</button>
          <button class="btn btn-cyan" data-nav-target="diagnostics">Run Benchmark Suite</button>
        </div>
      </div>

      <div class="card elevated" style="min-width:265px">
        <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted);text-transform:uppercase">Session Readiness</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;font-size:12.5px">
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Account:</span>
            <strong style="color:${activeAcc ? '#34d399' : '#fbbf24'}">${activeAcc ? escapeHtml(activeAcc.username) : 'Sign-In Required'}</strong>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Perf Preset:</span>
            <strong>${escapeHtml(modePreset.title.split(' ')[0])}</strong>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Allocated Heap:</span>
            <span style="font-family:var(--font-mono)">${activeProfile.performance.allocatedRamMb} MB</span>
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
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">VERIFIED MOD STACK</div>
        <div style="font-size:22px;font-weight:800;font-family:var(--font-mono);color:var(--accent-amber-bright);margin-top:4px">${activeProfile.enabledModIds.length} Active</div>
        <div class="card-desc">Sodium 0.6 + Lithium + FerriteCore + Iris + Vespera</div>
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
          <span>Recent Client Activity & Integrity Feed</span>
          <button class="btn btn-sm" data-action="verify-repair">Verify & Repair Files</button>
        </div>
        <div class="console-box" style="margin-top:12px;max-height:175px">${escapeHtml(
          snap.recentLogs.slice(-12).reverse().join('\n') || 'Ready.'
        )}</div>
      </div>
    </div>
  `;
}

export function renderPlayPage(
  snap: AppStateSnapshot,
  prepReport: LaunchPreparationReport | null
): string {
  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Minecraft Version & Launch Manager</h2>
        <p class="page-subtitle">
          Dynamic Mojang Piston metadata & Fabric Loader integration. Supported, Experimental, Legacy 1.8.9 PvP, and Unsupported targets are strictly separated so mods are never cross-loaded blindly.
        </p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="btn-sync-mojang-manifest">↻ Sync Official Mojang Manifest</button>
        <button class="btn" data-action="verify-repair">✓ Repair & Materialize Instance</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="card-title">Minecraft Java Edition Compatibility Matrix</div>
      <div style="overflow-x:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead>
            <tr style="border-bottom:1px solid var(--border-strong);text-align:left;color:var(--text-muted);font-family:var(--font-mono);font-size:11px">
              <th style="padding:8px">VERSION</th>
              <th style="padding:8px">SUPPORT TIER</th>
              <th style="padding:8px">JAVA RUNTIME</th>
              <th style="padding:8px">MODLOADER</th>
              <th style="padding:8px">OPTIMIZATION STACK</th>
              <th style="padding:8px">ACTION</th>
            </tr>
          </thead>
          <tbody>
            ${snap.versions
              .map(
                (v) => `
              <tr style="border-bottom:1px solid var(--border-subtle)">
                <td style="padding:10px 8px;font-weight:700;font-family:var(--font-mono)">${escapeHtml(v.id)}</td>
                <td style="padding:10px 8px"><span class="${tierBadgeClass(v.supportTier)}">${escapeHtml(v.supportTier.toUpperCase())}</span></td>
                <td style="padding:10px 8px;font-family:var(--font-mono)">Temurin Java ${v.recommendedJavaMajor}</td>
                <td style="padding:10px 8px;font-family:var(--font-mono)">${escapeHtml(v.recommendedFabricLoader ?? 'N/A')}</td>
                <td style="padding:10px 8px;color:var(--text-secondary)">
                  ${
                    v.sodiumSupported
                      ? `Sodium + ${v.irisSupported ? 'Iris + ' : ''}${v.vesperaModSupported ? 'Vespera HUD' : 'Core Mods'} (${v.verifiedModsCount} verified)`
                      : escapeHtml(v.legacyNotes || 'Incompatible')
                  }
                </td>
                <td style="padding:10px 8px">
                  ${
                    v.supportTier === 'unsupported'
                      ? `<span style="color:var(--text-muted);font-size:11.5px">Blocked (Forge Legacy)</span>`
                      : `<button class="btn btn-sm" data-create-version-profile="${escapeHtml(v.id)}">Create ${escapeHtml(v.id)} Instance</button>`
                  }
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>Verified Launch Pipeline (${escapeHtml(activeProfile.name)})</span>
          <button class="btn btn-sm btn-primary" data-action="inspect-launch-cmd">Inspect JVM Command</button>
        </div>
        <div class="card-desc">
          Main Class: <code style="color:var(--accent-cyan)">${escapeHtml(prepReport?.mainClass ?? 'net.fabricmc.loader.impl.launch.knot.Client')}</code>
        </div>
        ${
          prepReport && prepReport.warnings.length > 0
            ? `<div style="margin-top:10px;padding:10px;border-radius:6px;background:var(--accent-amber-dim);border:1px solid rgba(245,158,11,0.35);font-size:12px;color:var(--accent-amber-bright)">
                ${prepReport.warnings.map((w) => `<div>• ${escapeHtml(w)}</div>`).join('')}
              </div>`
            : ''
        }
        <div class="console-box" style="margin-top:12px">${escapeHtml(
          prepReport?.commandPreview ??
            'Click "Inspect JVM Command" or "Launch" to synthesize and verify full classpath, natives, options.txt, and sodium-options.json.'
        )}</div>
      </div>

      <div class="card">
        <div class="card-title">Live Game & Installer Log Stream (Tokens Scrubbed)</div>
        <div class="console-box" style="margin-top:12px">${escapeHtml(
          snap.recentLogs.slice().reverse().join('\n')
        )}</div>
      </div>
    </div>
  `;
}

export function bindHomeAndPlayEvents(
  stage: HTMLElement,
  onNavigate: (page: PageId) => void,
  onQuickPerfMode: (mode: 'max_fps' | 'balanced' | 'visual_quality' | 'custom') => void,
  onCreateVersionInstance: (mcVersion: string) => void,
  onSyncManifest: () => void,
  onInspectLaunch: () => void
): void {
  stage.querySelectorAll<HTMLElement>('[data-nav-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onNavigate(btn.dataset.navTarget as PageId);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-quick-perf-mode]').forEach((card) => {
    card.addEventListener('click', () => {
      onQuickPerfMode(
        card.dataset.quickPerfMode as 'max_fps' | 'balanced' | 'visual_quality' | 'custom'
      );
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-create-version-profile]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ver = btn.dataset.createVersionProfile;
      if (ver) onCreateVersionInstance(ver);
    });
  });

  stage.querySelector('#btn-sync-mojang-manifest')?.addEventListener('click', onSyncManifest);
  stage.querySelector('[data-action="inspect-launch-cmd"]')?.addEventListener('click', onInspectLaunch);
}
