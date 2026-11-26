import './styles.css';
import { computeRecommendedRam } from '@shared/performanceEngine';
import type {
  AppStateSnapshot,
  DeviceCodeAuthChallenge,
  HudElementType,
  LaunchPreparationReport,
  ModCategory,
  PageId,
} from '@shared/types';
import { bridge, type ModSearchResponse } from './bridge';
import { escapeHtml, NAV_ICONS } from './icons';
import {
  bindAccountsSettingsDiagEvents,
  renderAboutPage,
  renderAccountsPage,
  renderDiagnosticsPage,
  renderSettingsPage,
} from './pages/accountsSettingsDiagAbout';
import {
  bindHomeAndPlayEvents,
  renderHomePage,
  renderPlayPage,
} from './pages/homeAndPlay';
import {
  bindModsPageEvents,
  bindProfilesPageEvents,
  renderModsPage,
  renderProfilesPage,
  type ModsSubTab,
} from './pages/modsAndProfiles';
import {
  bindPerfAndGraphicsEvents,
  renderGraphicsPage,
  renderPerformancePage,
  renderResourcePacksPage,
  renderShaderPacksPage,
} from './pages/perfAndGraphics';

interface UiSessionState {
  snapshot: AppStateSnapshot | null;
  startupPhase: 'loading' | 'ready' | 'failed';
  startupError: string | null;
  currentPage: PageId;
  modsSubTab: ModsSubTab;
  modSearchQuery: string;
  modCategory: ModCategory | 'all';
  modSearchResults: ModSearchResponse | null;
  selectedHudElement: HudElementType;
  exportedProfileJson: string;
  authChallenge: DeviceCodeAuthChallenge | null;
  launchPrep: LaunchPreparationReport | null;
  runningBenchmarks: boolean;
  launchingGame: boolean;
}

const state: UiSessionState = {
  snapshot: null,
  startupPhase: 'loading',
  startupError: null,
  currentPage: 'home',
  modsSubTab: 'discover',
  modSearchQuery: '',
  modCategory: 'all',
  modSearchResults: null,
  selectedHudElement: 'fps',
  exportedProfileJson: '',
  authChallenge: null,
  launchPrep: null,
  runningBenchmarks: false,
  launchingGame: false,
};

const NAV_GROUPS: Array<{
  section: string;
  items: Array<{ id: PageId; label: string; badge?: (s: AppStateSnapshot) => string }>;
}> = [
  {
    section: 'Client Core',
    items: [
      { id: 'home', label: 'Home' },
      { id: 'play', label: 'Play & Versions', badge: (s) => `${s.versions.filter((v) => v.supportTier === 'supported').length}` },
      { id: 'mods', label: 'Mods & HUD Editor', badge: (s) => `${s.installedMods.length}` },
      { id: 'profiles', label: 'Profiles', badge: (s) => `${s.profiles.length}` },
    ],
  },
  {
    section: 'Engine & Visuals',
    items: [
      { id: 'performance', label: 'Performance' },
      { id: 'graphics', label: 'Graphics' },
      { id: 'shaders', label: 'Shader Packs' },
      { id: 'resourcepacks', label: 'Resource Packs' },
    ],
  },
  {
    section: 'System & Account',
    items: [
      { id: 'accounts', label: 'Accounts' },
      { id: 'diagnostics', label: 'Diagnostics & Bench' },
      { id: 'settings', label: 'Settings' },
      { id: 'about', label: 'About' },
    ],
  },
];

function showToast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const item = document.createElement('div');
  item.className = `toast ${kind === 'error' ? 'error' : kind === 'success' ? 'success' : ''}`;
  item.textContent = message;
  stack.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 4600);
}

async function refreshModSearch(): Promise<void> {
  try {
    state.modSearchResults = await bridge.searchMods(state.modSearchQuery, state.modCategory);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function renderStageContent(snap: AppStateSnapshot): string {
  switch (state.currentPage) {
    case 'home':
      return renderHomePage(snap);
    case 'play':
      return renderPlayPage(snap, state.launchPrep);
    case 'mods':
      return renderModsPage(
        snap,
        state.modsSubTab,
        state.modSearchQuery,
        state.modCategory,
        state.modSearchResults,
        state.selectedHudElement
      );
    case 'profiles':
      return renderProfilesPage(snap, state.exportedProfileJson);
    case 'performance':
      return renderPerformancePage(snap);
    case 'graphics':
      return renderGraphicsPage(snap);
    case 'shaders':
      return renderShaderPacksPage(snap);
    case 'resourcepacks':
      return renderResourcePacksPage(snap);
    case 'accounts':
      return renderAccountsPage(snap, state.authChallenge);
    case 'settings':
      return renderSettingsPage(snap);
    case 'diagnostics':
      return renderDiagnosticsPage(snap, state.runningBenchmarks);
    case 'about':
      return renderAboutPage(snap);
  }
}

function safeRenderStageContent(snap: AppStateSnapshot): string {
  try {
    return renderStageContent(snap);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return `
      <div class="card" style="border-color:rgba(239,68,68,0.45);max-width:720px;margin:24px auto">
        <div class="card-title">
          <span style="color:#fca5a5">Page Render Warning (${escapeHtml(state.currentPage)})</span>
          <span class="badge badge-critical">Isolated Subsystem Boundary</span>
        </div>
        <div class="card-desc" style="margin-top:8px">
          An unexpected error occurred while rendering the <strong>${escapeHtml(state.currentPage)}</strong> view. All other Vespera Client subsystems and navigation remain active.
        </div>
        <div class="console-box" style="margin-top:10px;max-height:140px">${escapeHtml(errMsg)}</div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn btn-primary" data-action="reload-engine-state">↻ Reload Engine State</button>
          ${
            state.currentPage !== 'home'
              ? `<button class="btn" data-nav-page="home">Return to Home</button>`
              : `<button class="btn" data-nav-page="play">Open Play &amp; Versions</button>`
          }
        </div>
      </div>
    `;
  }
}

function renderApp(): void {
  const root = document.getElementById('app');
  if (!root) return;

  const snap = state.snapshot;
  if (!snap) {
    if (state.startupPhase === 'failed') {
      root.innerHTML = `
        <div style="display:flex;height:100vh;align-items:center;justify-content:center;padding:24px">
          <div class="card elevated" style="max-width:580px;width:100%;border-color:rgba(239,68,68,0.45)">
            <div class="card-title">
              <span style="color:#fca5a5">Vespera Client Engine Initialization Error</span>
              <span class="badge badge-critical">Startup Halted</span>
            </div>
            <div class="card-desc" style="margin-top:8px">
              The desktop UI could not establish a valid initial state snapshot from the local engine backend.
            </div>
            <div class="console-box" style="margin-top:12px;max-height:160px">${escapeHtml(
              state.startupError || 'Unknown initialization error'
            )}</div>
            <div style="display:flex;gap:10px;margin-top:16px">
              <button class="btn btn-primary" id="btn-retry-bootstrap">↻ Retry Engine Initialization</button>
            </div>
          </div>
        </div>
      `;
      root.querySelector('#btn-retry-bootstrap')?.addEventListener('click', () => {
        void bootstrap();
      });
      return;
    }

    root.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-family:var(--font-mono);color:var(--text-secondary)">Initializing Vespera Client Engine…</div>`;
    return;
  }

  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const activeAcc = snap.accounts.find((a) => a.id === snap.activeAccountId) ?? null;

  root.innerHTML = `
    <header class="topbar">
      <div class="brand-lockup">
        <img src="./vespera-mark.svg" alt="Vespera" />
        <div>
          <span class="brand-title">VESPERA</span>
          <span class="brand-sub">PRECISION MINECRAFT CLIENT</span>
        </div>
      </div>

      <div class="topbar-metrics">
        <div class="metric-pill">
          <span class="label">CPU</span>
          <span class="val cyan">${snap.telemetry.cpuUtilizationPercent}%</span>
        </div>
        <div class="metric-pill">
          <span class="label">RAM FREE</span>
          <span class="val">${snap.telemetry.availableSystemRamMb} MB</span>
        </div>
        <div class="metric-pill">
          <span class="label">LAUNCHER</span>
          <span class="val emerald">${snap.telemetry.launcherProcessRamMb} MB</span>
        </div>
        <div class="metric-pill">
          <span class="label">TARGET</span>
          <span class="val amber">MC ${escapeHtml(activeProfile.mcVersion)} · ${escapeHtml(activeProfile.performance.mode.toUpperCase())}</span>
        </div>
      </div>
    </header>

    <div class="workspace">
      <aside class="nav-rail">
        ${NAV_GROUPS.map(
          (grp) => `
          <div class="nav-section-label">${escapeHtml(grp.section)}</div>
          ${grp.items
            .map((item) => {
              const badgeText = item.badge ? item.badge(snap) : '';
              return `
                <button class="nav-btn ${state.currentPage === item.id ? 'active' : ''}" data-nav-page="${item.id}">
                  ${NAV_ICONS[item.id]}
                  <span>${escapeHtml(item.label)}</span>
                  ${badgeText ? `<span class="nav-badge">${escapeHtml(badgeText)}</span>` : ''}
                </button>
              `;
            })
            .join('')}
        `
        ).join('')}
      </aside>

      <main class="stage" id="main-stage">
        ${safeRenderStageContent(snap)}
      </main>
    </div>

    <footer class="bottom-dock">
      <div class="dock-selectors">
        <div>
          <div style="font-size:10.5px;color:var(--text-muted);font-family:var(--font-mono)">ACTIVE PROFILE</div>
          <select class="select" id="dock-profile-select" style="min-width:215px;margin-top:2px">
            ${snap.profiles
              .map(
                (p) =>
                  `<option value="${escapeHtml(p.id)}" ${p.id === activeProfile.id ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.mcVersion)})</option>`
              )
              .join('')}
          </select>
        </div>

        <div>
          <div style="font-size:10.5px;color:var(--text-muted);font-family:var(--font-mono)">MINECRAFT ACCOUNT</div>
          <button class="btn" id="dock-account-btn" style="margin-top:2px">
            ${
              activeAcc
                ? `● ${escapeHtml(activeAcc.username)} (Verified MSA)`
                : '○ Sign In (Microsoft OAuth)'
            }
          </button>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:14px">
        <div style="text-align:right;font-size:11.5px;color:var(--text-secondary)">
          <div><strong>Fabric ${escapeHtml(activeProfile.loaderVersion)}</strong> · ${activeProfile.enabledModIds.length} Verified Mods</div>
          <div style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)">
            Heap ${activeProfile.performance.allocatedRamMb} MB · ${escapeHtml(activeProfile.graphics.resolutionWidth)}×${escapeHtml(activeProfile.graphics.resolutionHeight)}
          </div>
        </div>
        <button class="btn btn-primary btn-launch" data-action="launch-now" ${state.launchingGame ? 'disabled' : ''}>
          ${state.launchingGame ? 'PREPARING…' : `▶ PLAY ${escapeHtml(activeProfile.mcVersion)}`}
        </button>
      </div>
    </footer>
  `;

  bindGlobalAndStageEvents(root, snap);
}

function bindGlobalAndStageEvents(root: HTMLElement, snap: AppStateSnapshot): void {
  const navigateTo = async (page: PageId) => {
    state.currentPage = page;
    renderApp();
    if (page === 'mods' && !state.modSearchResults) {
      await refreshModSearch();
      renderApp();
    }
    if (page === 'play' && !state.launchPrep) {
      try {
        state.launchPrep = await bridge.prepareLaunch();
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    }
  };

  root.querySelectorAll<HTMLElement>('[data-action="reload-engine-state"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void bootstrap();
    });
  });

  root.querySelectorAll<HTMLElement>('[data-nav-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.navPage as PageId);
    });
  });

  root.querySelector('#dock-profile-select')?.addEventListener('change', async (ev) => {
    try {
      const id = (ev.target as HTMLSelectElement).value;
      state.snapshot = await bridge.selectProfile(id);
      state.launchPrep = null;
      if (state.currentPage === 'mods') await refreshModSearch();
      showToast('Switched active profile and synchronized HUD/Sodium configs.', 'success');
      renderApp();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  root.querySelector('#dock-account-btn')?.addEventListener('click', () => {
    navigateTo('accounts');
  });

  root.querySelectorAll<HTMLElement>('[data-action="launch-now"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        state.launchingGame = true;
        renderApp();
        const { launchRes, snapshot } = await bridge.launchMinecraft();
        state.snapshot = snapshot;
        state.launchPrep = launchRes.preparation;
        state.launchingGame = false;

        if (launchRes.launched) {
          showToast(launchRes.message, 'success');
        } else {
          showToast(launchRes.message, 'info');
          if (launchRes.stageReached === 'authentication_required') {
            state.currentPage = 'accounts';
          }
        }
        renderApp();
      } catch (err) {
        state.launchingGame = false;
        showToast(err instanceof Error ? err.message : String(err), 'error');
        renderApp();
      }
    });
  });

  root.querySelectorAll<HTMLElement>('[data-action="verify-repair"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const { repair, snapshot } = await bridge.verifyAndRepair();
        state.snapshot = snapshot;
        showToast(
          `Verified ${repair.verifiedCount} instance artifacts (${repair.repairedFiles.length} repaired).`,
          'success'
        );
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    });
  });

  const stage = root.querySelector<HTMLElement>('#main-stage');
  if (!stage) return;

  bindHomeAndPlayEvents(
    stage,
    navigateTo,
    async (mode) => {
      state.snapshot = await bridge.applyPerformanceMode(mode);
      showToast(`Applied ${mode.replace('_', ' ')} performance configuration.`, 'success');
      renderApp();
    },
    async (mcVersion) => {
      try {
        state.snapshot = await bridge.createProfile({
          name: `Vespera ${mcVersion}`,
          archetype: mcVersion === '1.8.9' ? 'pvp' : 'vanilla_plus',
          mcVersion,
        });
        showToast(`Created isolated Minecraft ${mcVersion} profile.`, 'success');
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    async () => {
      const res = await bridge.syncVersions();
      showToast(
        res.liveManifestFetched
          ? `Synced ${res.versions.length} versions from official Mojang manifest.`
          : 'Mojang Piston manifest offline in current network; verified local catalog active.',
        'info'
      );
    },
    async () => {
      state.launchPrep = await bridge.prepareLaunch();
      showToast('Generated and verified full Fabric KnotClient launch command.', 'success');
      renderApp();
    }
  );

  bindModsPageEvents(stage, snap, state.selectedHudElement, {
    onSubTab: async (tab) => {
      state.modsSubTab = tab;
      if (tab === 'discover') await refreshModSearch();
      renderApp();
    },
    onSearch: async (q, cat) => {
      state.modSearchQuery = q;
      state.modCategory = cat;
      await refreshModSearch();
      renderApp();
    },
    onInstallMod: async (modId) => {
      try {
        const res = await bridge.installMod(modId);
        state.snapshot = res.snapshot;
        await refreshModSearch();
        showToast(`Verified & installed "${modId}" (backup checkpoint saved).`, 'success');
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    onToggleMod: async (modId, enabled) => {
      try {
        state.snapshot = await bridge.toggleMod(modId, enabled);
        await refreshModSearch();
        showToast(`${enabled ? 'Enabled' : 'Disabled'} ${modId}.`, 'info');
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
        renderApp();
      }
    },
    onSelectHudElement: (id) => {
      state.selectedHudElement = id;
      renderApp();
    },
    onSelectHudLayoutId: async (layoutId) => {
      const found = snap.hudLayouts.find((h) => h.id === layoutId);
      if (found) {
        state.snapshot = await bridge.updateHudLayout(found);
        showToast(`Switched HUD layout to "${found.name}".`, 'success');
        renderApp();
      }
    },
    onSaveHudLayout: async (layout) => {
      state.snapshot = await bridge.updateHudLayout(layout);
      renderApp();
    },
  });

  bindProfilesPageEvents(stage, {
    onActivateProfile: async (id) => {
      state.snapshot = await bridge.selectProfile(id);
      showToast('Activated profile.', 'success');
      renderApp();
    },
    onCreateProfile: async (name, archetype, mcVersion) => {
      try {
        state.snapshot = await bridge.createProfile({ name, archetype, mcVersion });
        showToast(`Created profile "${name}".`, 'success');
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    onExportProfile: async (id) => {
      const { json } = await bridge.exportProfile(id);
      state.exportedProfileJson = json;
      showToast('Exported .vesperaprofile JSON to editor box below.', 'success');
      renderApp();
    },
    onImportProfile: async (json) => {
      try {
        state.snapshot = await bridge.importProfile(json);
        showToast('Imported .vesperaprofile cleanly!', 'success');
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    onManualBackup: async () => {
      state.snapshot = await bridge.createBackup(snap.activeProfileId, 'Manual user checkpoint');
      showToast('Saved profile rollback snapshot.', 'success');
      renderApp();
    },
    onRollback: async (backupId) => {
      state.snapshot = await bridge.rollbackBackup(backupId);
      showToast('Rolled back profile configuration to snapshot.', 'success');
      renderApp();
    },
  });

  const ramRec = computeRecommendedRam(snap.telemetry.totalSystemRamMb, 21);
  bindPerfAndGraphicsEvents(
    stage,
    {
      onSelectPerfMode: async (mode) => {
        state.snapshot = await bridge.applyPerformanceMode(mode);
        showToast(`Applied ${mode} performance mode.`, 'success');
        renderApp();
      },
      onUpdatePerf: async (patch) => {
        state.snapshot = await bridge.updatePerformance(patch);
        renderApp();
      },
      onApplyRecommendedRam: async (mb, gc) => {
        state.snapshot = await bridge.updatePerformance({
          allocatedRamMb: mb,
          gcMode: gc,
          autoRecommendRam: true,
        });
        showToast(`Applied hardware-optimal ${mb} MB heap (${gc}).`, 'success');
        renderApp();
      },
      onUpdateGraphics: async (patch) => {
        state.snapshot = await bridge.updateGraphics(patch);
        renderApp();
      },
      onSelectShader: async (shaderId, quality) => {
        state.snapshot = await bridge.selectShaderPack(shaderId, quality);
        showToast(
          shaderId ? `Activated shader pack (${quality || 'high'}).` : 'Disabled shaders (pure Sodium mode).',
          'success'
        );
        renderApp();
      },
      onToggleResourcePack: async (packId, enabled) => {
        state.snapshot = await bridge.toggleResourcePack(packId, enabled);
        renderApp();
      },
    },
    { mb: ramRec.recommendedMb, gc: ramRec.recommendedGc }
  );

  bindAccountsSettingsDiagEvents(stage, {
    onStartMsaAuth: async (clientId) => {
      try {
        state.authChallenge = await bridge.startDeviceAuth(clientId);
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    onPollMsaAuth: async () => {
      try {
        const { authStatus, snapshot } = await bridge.pollDeviceAuth();
        state.snapshot = snapshot;
        showToast(authStatus.message, authStatus.status === 'authenticated' ? 'success' : 'info');
        if (authStatus.status === 'authenticated') state.authChallenge = null;
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    onSwitchAccount: async (id) => {
      state.snapshot = await bridge.switchAccount(id);
      showToast('Switched active Minecraft session.', 'success');
      renderApp();
    },
    onRemoveAccount: async (id) => {
      state.snapshot = await bridge.removeAccount(id);
      showToast('Removed account from encrypted vault.', 'info');
      renderApp();
    },
    onUpdateSettings: async (patch) => {
      state.snapshot = await bridge.updateSettings(patch);
      showToast('Saved launcher settings.', 'success');
      renderApp();
    },
    onUpdateGraphics: async (patch) => {
      state.snapshot = await bridge.updateGraphics(patch);
      renderApp();
    },
    onRunBenchmarks: async () => {
      try {
        state.runningBenchmarks = true;
        renderApp();
        const { snapshot } = await bridge.runBenchmarks();
        state.snapshot = snapshot;
        state.runningBenchmarks = false;
        showToast('Completed OpenJDK 21 Reproducible Benchmark Suite!', 'success');
        renderApp();
      } catch (err) {
        state.runningBenchmarks = false;
        showToast(err instanceof Error ? err.message : String(err), 'error');
        renderApp();
      }
    },
    onApplyAutoFix: async (actionId) => {
      state.snapshot = await bridge.applyAutoFix(actionId);
      showToast('Applied Configuration Doctor automatic fix.', 'success');
      renderApp();
    },
  });
}

let activeBootstrapSeq = 0;

export async function bootstrap(): Promise<void> {
  const seq = ++activeBootstrapSeq;
  if (!state.snapshot) {
    state.startupPhase = 'loading';
    state.startupError = null;
  }
  renderApp();

  try {
    const snap = await bridge.getSnapshot();
    if (seq !== activeBootstrapSeq) return;
    state.snapshot = snap;
    state.startupPhase = 'ready';
    state.startupError = null;
    renderApp();
  } catch (err) {
    if (seq !== activeBootstrapSeq) return;
    const msg = err instanceof Error ? err.message : String(err);
    state.startupPhase = 'failed';
    state.startupError = msg;
    renderApp();
    showToast(msg, 'error');
  }
}

void bootstrap();
