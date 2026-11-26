import type { HudElementConfig, HudElementType, HudLayoutProfile } from '@shared/types';
import { escapeHtml } from './icons';

function hexToRgbaCss(hex: string, opacity: number): string {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16) || 0x0b0d11;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`;
}

function renderWidgetSampleInner(el: HudElementConfig): string {
  switch (el.id) {
    case 'fps':
      return `<div><strong style="color:${escapeHtml(el.accentColor)}">418 FPS</strong> <span style="opacity:0.78">1%L: 294</span></div>`;
    case 'cps':
      return `<div><strong style="color:${escapeHtml(el.accentColor)}">11</strong> | <strong>2</strong> CPS</div>`;
    case 'ping':
      return `<div><span style="color:${escapeHtml(el.accentColor)}">●</span> 18 ms</div>`;
    case 'coordinates':
      return `<div>X: 248.4 Y: 68.0 Z: -912.2</div><div style="font-size:9.5px;opacity:0.78">Nether: 31 / -114 · Plains</div>`;
    case 'direction_compass':
      return `<div style="text-align:center;letter-spacing:2px">NW ··· <strong style="color:${escapeHtml(el.accentColor)}">[ N 0° ]</strong> ··· NE</div>`;
    case 'keystrokes':
      return `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px;text-align:center;font-weight:700">
          <div></div><div style="border:1px solid ${escapeHtml(el.accentColor)};padding:3px 0;background:rgba(245,158,11,0.22)">W</div><div></div>
          <div style="border:1px solid rgba(255,255,255,0.22);padding:3px 0">A</div>
          <div style="border:1px solid rgba(255,255,255,0.22);padding:3px 0">S</div>
          <div style="border:1px solid rgba(255,255,255,0.22);padding:3px 0">D</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:3px;text-align:center;font-size:9.5px">
          <div style="border:1px solid rgba(255,255,255,0.22);padding:2px">LMB 11</div>
          <div style="border:1px solid rgba(255,255,255,0.22);padding:2px">RMB 2</div>
        </div>
        <div style="border:1px solid rgba(255,255,255,0.22);margin-top:3px;text-align:center;font-size:9px;padding:1px">━━ SPACE ━━</div>
      `;
    case 'armor_status':
      return `
        <div style="font-size:10px;line-height:1.45">
          <div>⛑ Netherite <span style="color:#34d399">98%</span></div>
          <div>🦺 Chestplate <span style="color:#34d399">94%</span></div>
          <div>👖 Leggings <span style="color:#fbbf24">61%</span></div>
          <div>🥾 Boots <span style="color:#34d399">96%</span></div>
        </div>`;
    case 'potion_effects':
      return `
        <div style="font-size:10px;line-height:1.5">
          <div>⚡ Speed II <span style="color:${escapeHtml(el.accentColor)}">1:24</span></div>
          <div>🔥 Fire Res I <span style="color:#94a3b8">3:42</span></div>
        </div>`;
    case 'toggle_sprint':
      return `<div>[Sprinting <span style="color:${escapeHtml(el.accentColor)}">Toggled</span>]</div>`;
    case 'custom_crosshair':
      return `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:15px;font-weight:900;color:${escapeHtml(el.foregroundColor)}">✛</div>`;
    case 'speedometer':
      return `<div>5.61 m/s</div>`;
    case 'server_info':
      return `<div>eu.competitive.gg · <span style="color:#34d399">20.0 TPS</span></div>`;
    case 'memory_hud':
      return `<div>Heap: 1,180 / 4,096 MB</div>`;
    case 'pack_badge':
      return `<div>Pack: Vespera 32x</div>`;
  }
}

export function renderHudEditorMarkup(
  layouts: HudLayoutProfile[],
  activeLayout: HudLayoutProfile,
  selectedElementId: HudElementType
): string {
  const selected =
    activeLayout.elements.find((e) => e.id === selectedElementId) ?? activeLayout.elements[0];

  const widgetsHtml = activeLayout.elements
    .filter((e) => e.enabled)
    .map((el) => {
      const bg = hexToRgbaCss(el.backgroundColor, el.backgroundOpacity);
      const border = el.showBorder ? `1px solid ${el.accentColor}66` : '1px solid transparent';
      const shadow = el.showShadow ? '0 2px 8px rgba(0,0,0,0.55)' : 'none';
      const isSelected = el.id === selected.id;
      return `
        <div
          class="hud-widget-box ${isSelected ? 'selected-widget' : ''}"
          data-hud-widget="${escapeHtml(el.id)}"
          style="
            left:${el.xPercent.toFixed(2)}%;
            top:${el.yPercent.toFixed(2)}%;
            width:${Math.round(el.widthPx * el.scale)}px;
            height:${Math.round(el.heightPx * el.scale)}px;
            color:${escapeHtml(el.foregroundColor)};
            background:${bg};
            border:${border};
            box-shadow:${shadow};
          "
        >
          ${renderWidgetSampleInner(el)}
          ${isSelected ? `<div class="hud-resize-handle" data-hud-resize="${escapeHtml(el.id)}" title="Drag to resize/scale"></div>` : ''}
        </div>
      `;
    })
    .join('');

  return `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="form-label">Active HUD Layout:</span>
          <select class="select" id="hud-layout-select">
            ${layouts
              .map(
                (l) =>
                  `<option value="${escapeHtml(l.id)}" ${l.id === activeLayout.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
              )
              .join('')}
          </select>
          <button class="btn btn-sm" id="btn-hud-save-as-new">+ Save Copy As New Layout</button>
        </div>
        <div style="font-size:12px;color:var(--text-secondary)">
          Drag widgets on the 16:9 viewport · Hold <kbd style="background:#1e293b;padding:1px 5px;border-radius:3px">Shift</kbd> for grid snap · Drag corner handle to scale · Syncs live to <code>ipc/hud-profile.json</code>
        </div>
      </div>
    </div>

    <div class="hud-editor-layout">
      <div>
        <div class="hud-canvas-frame" id="hud-editor-canvas">
          <div class="hud-grid-overlay"></div>
          <div class="hud-snap-line-v" id="hud-snap-v"></div>
          <div class="hud-snap-line-h" id="hud-snap-h"></div>
          ${widgetsHtml}
          <div class="hud-hotbar-mock">
            ${Array.from({ length: 9 })
              .map(() => `<div class="hud-hotbar-slot"></div>`)
              .join('')}
          </div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="card-title">Built-in Client Gameplay & QoL Controls (Fair-Play Verified)</div>
          <div class="grid-3" style="margin-top:12px">
            <div>
              <div class="form-label">Cinematic Zoom Factor (${activeLayout.zoomDefaultFactor.toFixed(1)}x)</div>
              <input type="range" id="hud-zoom-factor" min="2" max="12" step="0.5" value="${activeLayout.zoomDefaultFactor}" style="width:100%;margin-top:6px" />
              <div class="form-hint">Keybind: ${escapeHtml(activeLayout.zoomKeybind)} · Scroll-wheel variable zoom enabled</div>
            </div>
            <div>
              <div class="form-label">Custom Hit Particles</div>
              <select class="select" id="hud-hit-particles" style="width:100%;margin-top:6px">
                <option value="vanilla" ${activeLayout.customHitParticles === 'vanilla' ? 'selected' : ''}>Vanilla Default</option>
                <option value="crit_amber" ${activeLayout.customHitParticles === 'crit_amber' ? 'selected' : ''}>Solar Amber Sparks</option>
                <option value="sharpness_spark" ${activeLayout.customHitParticles === 'sharpness_spark' ? 'selected' : ''}>Sharpness Prism</option>
                <option value="minimal" ${activeLayout.customHitParticles === 'minimal' ? 'selected' : ''}>Minimal Low-Clutter</option>
              </select>
            </div>
            <div>
              <div class="form-label">Chat & Inventory QoL</div>
              <label style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12.5px;cursor:pointer">
                <input type="checkbox" id="hud-chat-stack" ${activeLayout.chatCompactStacking ? 'checked' : ''} />
                Compact Duplicate Chat [x2]
              </label>
              <label style="display:flex;align-items:center;gap:8px;margin-top:4px;font-size:12.5px;cursor:pointer">
                <input type="checkbox" id="hud-rich-tooltips" ${activeLayout.richItemTooltips ? 'checked' : ''} />
                Exact Durability & Saturation Tooltips
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Inspector: ${escapeHtml(selected.name)}</span>
          <span class="badge">${escapeHtml(selected.category)}</span>
        </div>

        <div class="form-row" style="margin-top:8px">
          <span class="form-label">Widget Enabled</span>
          <label class="switch">
            <input type="checkbox" id="hud-prop-enabled" ${selected.enabled ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Position (X% / Y%)</div>
            <div class="form-hint">${selected.xPercent.toFixed(1)}% , ${selected.yPercent.toFixed(1)}%</div>
          </div>
          <div style="display:flex;gap:6px">
            <input type="number" class="input" id="hud-prop-x" value="${selected.xPercent.toFixed(1)}" min="0" max="96" step="0.5" style="width:68px" />
            <input type="number" class="input" id="hud-prop-y" value="${selected.yPercent.toFixed(1)}" min="0" max="96" step="0.5" style="width:68px" />
          </div>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Scale (${selected.scale.toFixed(2)}x)</div>
            <div class="form-hint">${Math.round(selected.widthPx * selected.scale)}×${Math.round(selected.heightPx * selected.scale)} px</div>
          </div>
          <input type="range" id="hud-prop-scale" min="0.6" max="2.0" step="0.05" value="${selected.scale}" style="width:120px" />
        </div>

        <div class="form-row">
          <span class="form-label">Background Opacity (${Math.round(selected.backgroundOpacity * 100)}%)</span>
          <input type="range" id="hud-prop-opacity" min="0" max="1" step="0.05" value="${selected.backgroundOpacity}" style="width:120px" />
        </div>

        <div class="form-row">
          <span class="form-label">Text / Accent / BG Colors</span>
          <div style="display:flex;gap:6px">
            <input type="color" id="hud-prop-fg" value="${escapeHtml(selected.foregroundColor)}" title="Foreground" />
            <input type="color" id="hud-prop-accent" value="${escapeHtml(selected.accentColor)}" title="Accent" />
            <input type="color" id="hud-prop-bg" value="${escapeHtml(selected.backgroundColor)}" title="Background" />
          </div>
        </div>

        <div class="form-row">
          <span class="form-label">Precision Border & Shadow</span>
          <div style="display:flex;gap:10px;font-size:12px">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="hud-prop-border" ${selected.showBorder ? 'checked' : ''} /> Border
            </label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="hud-prop-shadow" ${selected.showShadow ? 'checked' : ''} /> Shadow
            </label>
          </div>
        </div>

        <div style="margin-top:14px;font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">
          All 14 Built-in HUD Modules
        </div>
        <div style="max-height:220px;overflow-y:auto;margin-top:8px;display:flex;flex-direction:column;gap:4px">
          ${activeLayout.elements
            .map(
              (item) => `
            <div
              data-select-hud-item="${escapeHtml(item.id)}"
              style="
                display:flex;align-items:center;justify-content:space-between;
                padding:6px 9px;border-radius:5px;cursor:pointer;
                background:${item.id === selected.id ? 'var(--accent-amber-dim)' : 'var(--bg-canvas)'};
                border:1px solid ${item.id === selected.id ? 'rgba(245,158,11,0.4)' : 'var(--border-subtle)'};
              "
            >
              <span style="font-size:12px;font-weight:600;color:${item.enabled ? 'var(--text-primary)' : 'var(--text-muted)'}">${escapeHtml(item.name)}</span>
              <span class="badge ${item.enabled ? 'badge-supported' : ''}">${item.enabled ? 'ON' : 'OFF'}</span>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;
}

export function bindHudEditorInteractions(
  container: HTMLElement,
  activeLayout: HudLayoutProfile,
  selectedElementId: HudElementType,
  onSelectElement: (id: HudElementType) => void,
  onSelectLayoutId: (layoutId: string) => void,
  onSaveLayout: (updated: HudLayoutProfile, createCopy?: boolean) => void
): void {
  const cloneLayout = (): HudLayoutProfile => JSON.parse(JSON.stringify(activeLayout)) as HudLayoutProfile;

  container.querySelector('#hud-layout-select')?.addEventListener('change', (ev) => {
    const val = (ev.target as HTMLSelectElement).value;
    onSelectLayoutId(val);
  });

  container.querySelector('#btn-hud-save-as-new')?.addEventListener('click', () => {
    const copy = cloneLayout();
    copy.id = `hud-custom-${Date.now()}`;
    copy.name = `${activeLayout.name} (Custom)`;
    onSaveLayout(copy, true);
  });

  container.querySelectorAll<HTMLElement>('[data-select-hud-item]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.selectHudItem as HudElementType;
      if (id) onSelectElement(id);
    });
  });

  // Inspector controls
  const updateSelectedProp = (mutator: (el: HudElementConfig, layout: HudLayoutProfile) => void) => {
    const copy = cloneLayout();
    const target = copy.elements.find((e) => e.id === selectedElementId);
    if (!target) return;
    mutator(target, copy);
    onSaveLayout(copy);
  };

  container.querySelector('#hud-prop-enabled')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.enabled = (e.target as HTMLInputElement).checked;
    });
  });
  container.querySelector('#hud-prop-x')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.xPercent = Math.max(0, Math.min(96, Number((e.target as HTMLInputElement).value) || 0));
    });
  });
  container.querySelector('#hud-prop-y')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.yPercent = Math.max(0, Math.min(96, Number((e.target as HTMLInputElement).value) || 0));
    });
  });
  container.querySelector('#hud-prop-scale')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.scale = Math.max(0.5, Math.min(2.5, Number((e.target as HTMLInputElement).value) || 1));
    });
  });
  container.querySelector('#hud-prop-opacity')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.backgroundOpacity = Math.max(0, Math.min(1, Number((e.target as HTMLInputElement).value) || 0));
    });
  });
  container.querySelector('#hud-prop-fg')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.foregroundColor = (e.target as HTMLInputElement).value;
    });
  });
  container.querySelector('#hud-prop-accent')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.accentColor = (e.target as HTMLInputElement).value;
    });
  });
  container.querySelector('#hud-prop-bg')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.backgroundColor = (e.target as HTMLInputElement).value;
    });
  });
  container.querySelector('#hud-prop-border')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.showBorder = (e.target as HTMLInputElement).checked;
    });
  });
  container.querySelector('#hud-prop-shadow')?.addEventListener('change', (e) => {
    updateSelectedProp((el) => {
      el.showShadow = (e.target as HTMLInputElement).checked;
    });
  });

  // Global gameplay controls inside HUD layout
  container.querySelector('#hud-zoom-factor')?.addEventListener('change', (e) => {
    updateSelectedProp((_, layout) => {
      layout.zoomDefaultFactor = Number((e.target as HTMLInputElement).value) || 4.0;
    });
  });
  container.querySelector('#hud-hit-particles')?.addEventListener('change', (e) => {
    updateSelectedProp((_, layout) => {
      layout.customHitParticles = (e.target as HTMLSelectElement).value as HudLayoutProfile['customHitParticles'];
    });
  });
  container.querySelector('#hud-chat-stack')?.addEventListener('change', (e) => {
    updateSelectedProp((_, layout) => {
      layout.chatCompactStacking = (e.target as HTMLInputElement).checked;
    });
  });
  container.querySelector('#hud-rich-tooltips')?.addEventListener('change', (e) => {
    updateSelectedProp((_, layout) => {
      layout.richItemTooltips = (e.target as HTMLInputElement).checked;
    });
  });

  // Canvas drag & resize pointer interactions
  const canvas = container.querySelector<HTMLElement>('#hud-editor-canvas');
  const snapV = container.querySelector<HTMLElement>('#hud-snap-v');
  const snapH = container.querySelector<HTMLElement>('#hud-snap-h');
  if (!canvas) return;

  canvas.querySelectorAll<HTMLElement>('[data-hud-widget]').forEach((box) => {
    const widgetId = box.dataset.hudWidget as HudElementType;

    box.addEventListener('mousedown', (downEv) => {
      const targetEl = downEv.target as HTMLElement;
      const isResize = Boolean(targetEl.dataset.hudResize);
      downEv.preventDefault();
      downEv.stopPropagation();

      if (widgetId !== selectedElementId && !isResize) {
        onSelectElement(widgetId);
      }

      const rect = canvas.getBoundingClientRect();
      const copy = cloneLayout();
      const model = copy.elements.find((e) => e.id === widgetId);
      if (!model) return;

      const startMouseX = downEv.clientX;
      const startMouseY = downEv.clientY;
      const origXPct = model.xPercent;
      const origYPct = model.yPercent;
      const origScale = model.scale;

      const onMove = (moveEv: MouseEvent) => {
        const dx = moveEv.clientX - startMouseX;
        const dy = moveEv.clientY - startMouseY;

        if (isResize) {
          const nextScale = Math.max(0.55, Math.min(2.2, origScale + dx / 140));
          model.scale = Number(nextScale.toFixed(2));
          box.style.width = `${Math.round(model.widthPx * model.scale)}px`;
          box.style.height = `${Math.round(model.heightPx * model.scale)}px`;
          return;
        }

        let nextXPct = origXPct + (dx / rect.width) * 100;
        let nextYPct = origYPct + (dy / rect.height) * 100;

        const wPct = ((model.widthPx * model.scale) / rect.width) * 100;
        const hPct = ((model.heightPx * model.scale) / rect.height) * 100;

        nextXPct = Math.max(0, Math.min(100 - wPct, nextXPct));
        nextYPct = Math.max(0, Math.min(100 - hPct, nextYPct));

        // Magnetic center snap
        const centerTargetX = 50 - wPct / 2;
        const centerTargetY = 50 - hPct / 2;
        const vMatched = Math.abs(nextXPct - centerTargetX) < 1.2;
        const hMatched = Math.abs(nextYPct - centerTargetY) < 1.2;

        if (vMatched) nextXPct = centerTargetX;
        if (hMatched) nextYPct = centerTargetY;

        if (moveEv.shiftKey && !vMatched) nextXPct = Math.round(nextXPct * 2) / 2;
        if (moveEv.shiftKey && !hMatched) nextYPct = Math.round(nextYPct * 2) / 2;

        snapV?.classList.toggle('visible', vMatched);
        snapH?.classList.toggle('visible', hMatched);

        model.xPercent = Number(nextXPct.toFixed(2));
        model.yPercent = Number(nextYPct.toFixed(2));
        box.style.left = `${model.xPercent}%`;
        box.style.top = `${model.yPercent}%`;
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        snapV?.classList.remove('visible');
        snapH?.classList.remove('visible');
        onSaveLayout(copy);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}
