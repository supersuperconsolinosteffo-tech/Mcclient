import type {
  AppStateSnapshot,
  ClientProfile,
  HudElementType,
  HudLayoutProfile,
  ModCategory,
} from '@shared/types';
import type { ModSearchResponse } from '../bridge';
import { bindHudEditorInteractions, renderHudEditorMarkup } from '../hudEditorView';
import { escapeHtml } from '../icons';

export type ModsSubTab = 'discover' | 'installed' | 'hud_editor';

export function renderModsPage(
  snap: AppStateSnapshot,
  subTab: ModsSubTab,
  searchQuery: string,
  categoryFilter: ModCategory | 'all',
  searchData: ModSearchResponse | null,
  selectedHudElement: HudElementType
): string {
  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const activeHud =
    snap.hudLayouts.find((h) => h.id === activeProfile.hudLayoutId) ?? snap.hudLayouts[0];

  let bodyHtml = '';

  if (subTab === 'hud_editor') {
    bodyHtml = renderHudEditorMarkup(snap.hudLayouts, activeHud, selectedHudElement);
  } else if (subTab === 'installed') {
    bodyHtml = `
      <div class="grid-2">
        <div class="card">
          <div class="card-title">
            <span>Installed Mods in "${escapeHtml(activeProfile.name)}" (${snap.installedMods.length})</span>
            <span class="badge badge-supported">MC ${escapeHtml(activeProfile.mcVersion)}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
            ${snap.installedMods
              .map((mod) => {
                const isEnabled = activeProfile.enabledModIds.includes(mod.id);
                return `
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px">
                    <div>
                      <div style="font-weight:700;font-size:13px">
                        ${escapeHtml(mod.name)}
                        <span class="badge" style="margin-left:6px">${escapeHtml(mod.version)}</span>
                        <span class="badge" style="margin-left:4px">${escapeHtml(mod.license)}</span>
                      </div>
                      <div style="font-size:11.5px;color:var(--text-secondary);margin-top:3px">
                        By ${escapeHtml(mod.author)} · SHA-256: <code>${escapeHtml(mod.sha256.slice(0, 12))}…</code>
                        ${mod.requiredDependencies.length ? ` · Deps: ${escapeHtml(mod.requiredDependencies.join(', '))}` : ''}
                      </div>
                    </div>
                    <label class="switch">
                      <input type="checkbox" data-toggle-installed-mod="${escapeHtml(mod.id)}" ${isEnabled ? 'checked' : ''} />
                      <span class="switch-slider"></span>
                    </label>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-title">Mod Installation & Rollback Audit Ledger</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px;max-height:520px;overflow-y:auto">
            ${snap.modHistory
              .map(
                (ev) => `
              <div style="padding:9px 11px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;font-size:12px">
                <div style="display:flex;justify-content:space-between">
                  <strong>[${escapeHtml(ev.action.toUpperCase())}] ${escapeHtml(ev.modName)}</strong>
                  <span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)">${escapeHtml(ev.timestamp.slice(0, 19).replace('T', ' '))}</span>
                </div>
                <div style="color:var(--text-secondary);margin-top:3px">${escapeHtml(ev.details)}</div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    `;
  } else {
    // Discover tab
    const items = searchData?.items ?? [];
    bodyHtml = `
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
          <div style="display:flex;gap:8px;flex:1;min-width:280px">
            <input
              type="text"
              class="input"
              id="mod-search-input"
              placeholder="Search Modrinth & Curated Database (try 'sodium', 'rei', 'optifabric', 'indium')..."
              value="${escapeHtml(searchQuery)}"
              style="flex:1"
            />
            <select class="select" id="mod-category-select">
              <option value="all" ${categoryFilter === 'all' ? 'selected' : ''}>All Categories</option>
              <option value="performance" ${categoryFilter === 'performance' ? 'selected' : ''}>Performance</option>
              <option value="rendering" ${categoryFilter === 'rendering' ? 'selected' : ''}>Rendering</option>
              <option value="shaders" ${categoryFilter === 'shaders' ? 'selected' : ''}>Shaders</option>
              <option value="visuals" ${categoryFilter === 'visuals' ? 'selected' : ''}>Visual Quality</option>
              <option value="pvp_hud" ${categoryFilter === 'pvp_hud' ? 'selected' : ''}>PvP & HUD</option>
              <option value="survival_qol" ${categoryFilter === 'survival_qol' ? 'selected' : ''}>Survival QoL</option>
              <option value="library" ${categoryFilter === 'library' ? 'selected' : ''}>Libraries</option>
            </select>
            <button class="btn btn-primary" id="btn-mod-search">Search</button>
          </div>
          <span class="badge ${searchData?.liveApiConnected ? 'badge-supported' : 'badge-experimental'}">
            ${searchData?.liveApiConnected ? 'Modrinth v2 API Live + Verified Catalog' : 'Verified Compatibility Database Mode'}
          </span>
        </div>
      </div>

      <div class="grid-2">
        ${items
          .map((item) => {
            const compat = item.compatibility;
            return `
              <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;gap:10px">
                <div>
                  <div class="card-title">
                    <span>${escapeHtml(item.name)}</span>
                    <span class="badge ${compat.allowed ? 'badge-supported' : 'badge-critical'}">
                      ${compat.allowed ? 'Compatible' : 'Blocked'}
                    </span>
                  </div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">
                    by ${escapeHtml(item.author)} · License: ${escapeHtml(item.license)} · Loader: ${escapeHtml(item.loader)}
                  </div>
                  <div class="card-desc">${escapeHtml(item.summary)}</div>
                  ${
                    !compat.allowed
                      ? `<div style="margin-top:8px;padding:8px;border-radius:5px;background:var(--accent-danger-dim);border:1px solid rgba(239,68,68,0.35);font-size:11.5px;color:#fca5a5">
                          <strong>Why this mod cannot be installed:</strong> ${escapeHtml(compat.reasons.join(' '))}
                        </div>`
                      : ''
                  }
                  ${
                    compat.allowed && compat.warnings.length > 0
                      ? `<div style="margin-top:8px;padding:7px;border-radius:5px;background:var(--accent-cyan-dim);font-size:11.5px;color:var(--accent-cyan)">
                          ${escapeHtml(compat.warnings.join(' '))}
                        </div>`
                      : ''
                  }
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border-subtle)">
                  <span style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted)">
                    MC: ${escapeHtml(item.supportedMcVersions.slice(0, 4).join(', '))}
                  </span>
                  ${
                    item.installed
                      ? `<button class="btn btn-sm ${item.enabled ? 'btn-cyan' : ''}" data-toggle-installed-mod-btn="${escapeHtml(item.id)}" data-next-enabled="${!item.enabled}">
                          ${item.enabled ? '✓ Enabled (Click to Disable)' : 'Disabled (Click to Enable)'}
                        </button>`
                      : `<button class="btn btn-sm btn-primary" data-install-mod="${escapeHtml(item.id)}" ${!compat.allowed ? 'disabled' : ''}>
                          + Verify & Install
                        </button>`
                  }
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Integrated Mod Manager & Precision HUD Editor</h2>
        <p class="page-subtitle">
          Every mod installation verifies Minecraft ${escapeHtml(activeProfile.mcVersion)} compatibility, Fabric loader constraints, dependency trees, SHA-256 hashes, and ecosystem conflicts before touching your profile.
        </p>
      </div>
    </div>

    <div class="subtabs">
      <button class="subtab-btn ${subTab === 'discover' ? 'active' : ''}" data-mods-subtab="discover">Discover & Verify Mods</button>
      <button class="subtab-btn ${subTab === 'installed' ? 'active' : ''}" data-mods-subtab="installed">Installed Stack (${snap.installedMods.length})</button>
      <button class="subtab-btn ${subTab === 'hud_editor' ? 'active' : ''}" data-mods-subtab="hud_editor">Interactive HUD Editor (14 Built-in Modules)</button>
    </div>

    ${bodyHtml}
  `;
}

export function renderProfilesPage(snap: AppStateSnapshot, exportedJsonPreview: string): string {
  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Isolated Mod & Performance Profiles</h2>
        <p class="page-subtitle">
          Each profile maintains independent enabled mods, shaders, resource packs, HUD layouts, graphics options, and JVM heap settings—protected by automatic pre-change rollback snapshots.
        </p>
      </div>
      <button class="btn btn-primary" id="btn-checkpoint-backup">+ Create Manual Snapshot Backup</button>
    </div>

    <div class="grid-2" style="margin-bottom:18px">
      ${snap.profiles
        .map((prof) => {
          const isActive = prof.id === snap.activeProfileId;
          return `
            <div class="card selectable ${isActive ? 'selected' : ''}" data-activate-profile="${escapeHtml(prof.id)}">
              <div class="card-title">
                <span>${escapeHtml(prof.name)}</span>
                <span class="badge ${isActive ? 'badge-supported' : ''}">${isActive ? 'ACTIVE' : escapeHtml(prof.archetype.toUpperCase())}</span>
              </div>
              <div class="card-desc">${escapeHtml(prof.description)}</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">
                <span>MC ${escapeHtml(prof.mcVersion)}</span> ·
                <span>${escapeHtml(prof.loader)} ${escapeHtml(prof.loaderVersion)}</span> ·
                <span>${prof.enabledModIds.length} mods</span> ·
                <span>${prof.performance.allocatedRamMb} MB (${escapeHtml(prof.performance.gcMode)})</span>
              </div>
              <div style="display:flex;gap:8px;margin-top:12px">
                <button class="btn btn-sm" data-export-profile="${escapeHtml(prof.id)}">Export .vesperaprofile</button>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Create New Independent Profile</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
          <input type="text" class="input" id="new-prof-name" placeholder="Profile Name (e.g. Tournament Crystal PvP)" />
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <select class="select" id="new-prof-archetype">
              <option value="pvp">PvP Competitive</option>
              <option value="survival">Survival SMP</option>
              <option value="vanilla_plus">Vanilla Plus</option>
              <option value="performance">Extreme Performance</option>
              <option value="graphics">Graphics & Shaders</option>
              <option value="custom">Custom</option>
            </select>
            <select class="select" id="new-prof-version">
              ${snap.versions
                .filter((v) => v.supportTier !== 'unsupported')
                .slice(0, 150)
                .map(
                  (v) =>
                    `<option value="${escapeHtml(v.id)}">Minecraft ${escapeHtml(v.id)} (${escapeHtml(v.compatibilityLabel || v.type)})</option>`
                )
                .join('')}
            </select>
          </div>
          <button class="btn btn-primary" id="btn-create-profile">Create Isolated Profile</button>
        </div>

        <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-subtle)">
          <div class="card-title">Import / Export Profile JSON (.vesperaprofile)</div>
          <textarea
            class="input"
            id="profile-json-box"
            rows="5"
            placeholder="Paste exported .vesperaprofile JSON here to import, or click 'Export .vesperaprofile' on any card above..."
            style="width:100%;margin-top:8px;font-family:var(--font-mono);font-size:11px"
          >${escapeHtml(exportedJsonPreview)}</textarea>
          <button class="btn btn-sm btn-cyan" id="btn-import-profile" style="margin-top:8px">Import Profile from JSON</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Safeguard Snapshots & One-Click Rollback (${snap.profileBackups.length})</div>
        <div class="card-desc">Automatic checkpoints created prior to mod installations and preset changes.</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px;max-height:360px;overflow-y:auto">
          ${
            snap.profileBackups.length === 0
              ? `<div style="color:var(--text-muted);font-size:12.5px">No snapshots recorded yet. Click "+ Create Manual Snapshot Backup" or modify a profile to see automatic safeguards.</div>`
              : snap.profileBackups
                  .map(
                    (b) => `
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px">
                    <div>
                      <div style="font-weight:700;font-size:12.5px">${escapeHtml(b.profileName)}</div>
                      <div style="font-size:11.5px;color:var(--text-secondary)">${escapeHtml(b.reason)} · <span style="font-family:var(--font-mono)">${escapeHtml(b.createdAt.slice(11, 19))}</span></div>
                    </div>
                    <button class="btn btn-sm" data-rollback-id="${escapeHtml(b.id)}">↺ Rollback</button>
                  </div>
                `
                  )
                  .join('')
          }
        </div>
      </div>
    </div>
  `;
}

export function bindModsPageEvents(
  stage: HTMLElement,
  snap: AppStateSnapshot,
  selectedHudElement: HudElementType,
  callbacks: {
    onSubTab: (tab: ModsSubTab) => void;
    onSearch: (q: string, cat: ModCategory | 'all') => void;
    onInstallMod: (modId: string) => void;
    onToggleMod: (modId: string, enabled: boolean) => void;
    onSelectHudElement: (id: HudElementType) => void;
    onSelectHudLayoutId: (layoutId: string) => void;
    onSaveHudLayout: (layout: HudLayoutProfile) => void;
  }
): void {
  stage.querySelectorAll<HTMLElement>('[data-mods-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      callbacks.onSubTab(btn.dataset.modsSubtab as ModsSubTab);
    });
  });

  const triggerSearch = () => {
    const q = (stage.querySelector('#mod-search-input') as HTMLInputElement | null)?.value ?? '';
    const cat =
      ((stage.querySelector('#mod-category-select') as HTMLSelectElement | null)?.value as
        | ModCategory
        | 'all') ?? 'all';
    callbacks.onSearch(q, cat);
  };

  stage.querySelector('#btn-mod-search')?.addEventListener('click', triggerSearch);
  stage.querySelector('#mod-search-input')?.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') triggerSearch();
  });
  stage.querySelector('#mod-category-select')?.addEventListener('change', triggerSearch);

  stage.querySelectorAll<HTMLElement>('[data-install-mod]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.installMod;
      if (id) callbacks.onInstallMod(id);
    });
  });

  stage.querySelectorAll<HTMLInputElement>('[data-toggle-installed-mod]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.toggleInstalledMod;
      if (id) callbacks.onToggleMod(id, chk.checked);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-toggle-installed-mod-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggleInstalledModBtn;
      const next = btn.dataset.nextEnabled === 'true';
      if (id) callbacks.onToggleMod(id, next);
    });
  });

  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const activeHud =
    snap.hudLayouts.find((h) => h.id === activeProfile.hudLayoutId) ?? snap.hudLayouts[0];

  bindHudEditorInteractions(
    stage,
    activeHud,
    selectedHudElement,
    callbacks.onSelectHudElement,
    callbacks.onSelectHudLayoutId,
    (updated) => callbacks.onSaveHudLayout(updated)
  );
}

export function bindProfilesPageEvents(
  stage: HTMLElement,
  callbacks: {
    onActivateProfile: (id: string) => void;
    onCreateProfile: (name: string, archetype: ClientProfile['archetype'], mcVersion: string) => void;
    onExportProfile: (id: string) => void;
    onImportProfile: (json: string) => void;
    onManualBackup: () => void;
    onRollback: (backupId: string) => void;
  }
): void {
  stage.querySelectorAll<HTMLElement>('[data-activate-profile]').forEach((card) => {
    card.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      const id = card.dataset.activateProfile;
      if (id) callbacks.onActivateProfile(id);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-export-profile]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.exportProfile;
      if (id) callbacks.onExportProfile(id);
    });
  });

  stage.querySelector('#btn-create-profile')?.addEventListener('click', () => {
    const name = (stage.querySelector('#new-prof-name') as HTMLInputElement)?.value || 'Custom Profile';
    const arch = ((stage.querySelector('#new-prof-archetype') as HTMLSelectElement)?.value ||
      'custom') as ClientProfile['archetype'];
    const ver = (stage.querySelector('#new-prof-version') as HTMLSelectElement)?.value || '1.21.4';
    callbacks.onCreateProfile(name, arch, ver);
  });

  stage.querySelector('#btn-import-profile')?.addEventListener('click', () => {
    const raw = (stage.querySelector('#profile-json-box') as HTMLTextAreaElement)?.value || '';
    callbacks.onImportProfile(raw);
  });

  stage.querySelector('#btn-checkpoint-backup')?.addEventListener('click', callbacks.onManualBackup);

  stage.querySelectorAll<HTMLElement>('[data-rollback-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.rollbackId;
      if (id) callbacks.onRollback(id);
    });
  });
}
