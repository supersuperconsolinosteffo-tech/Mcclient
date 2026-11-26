import {
  computeRecommendedRam,
  PERFORMANCE_MODE_PRESETS,
  synthesizeJvmArguments,
} from '@shared/performanceEngine';
import type {
  AppStateSnapshot,
  GarbageCollectorMode,
  GraphicsSettings,
  PerformanceModeId,
  PerformanceSettings,
  ShaderPackEntry,
} from '@shared/types';
import { getVersionDescriptor } from '@shared/versionCatalog';
import { escapeHtml } from '../icons';

export function renderPerformancePage(snap: AppStateSnapshot): string {
  const active = snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const perf = active.performance;
  const ver = getVersionDescriptor(active.mcVersion);
  const javaMajor = ver?.recommendedJavaMajor ?? 21;
  const ramAdvice = computeRecommendedRam(
    snap.telemetry.totalSystemRamMb,
    javaMajor,
    active.enabledResourcePackIds.includes('rp-vespera-pbr-normals-128x'),
    Boolean(active.activeShaderPackId)
  );
  const { explanations } = synthesizeJvmArguments(perf, javaMajor, snap.settings.customJvmExtraArgs);

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Performance Engine & JVM Collector Architecture</h2>
        <p class="page-subtitle">
          Core Principle: <strong>Never make the game look unnecessarily worse just to inflate FPS.</strong> Vespera optimizes GPU indirect draw batching, voxel occlusion culling, memory canonicalization, and sub-millisecond GC before touching visual fidelity.
        </p>
      </div>
    </div>

    <div class="grid-4" style="margin-bottom:18px">
      ${(['max_fps', 'balanced', 'visual_quality', 'custom'] as const)
        .map((modeId) => {
          const preset = PERFORMANCE_MODE_PRESETS[modeId];
          const selected = perf.mode === modeId;
          return `
            <div class="card selectable ${selected ? 'selected' : ''}" data-select-perf-preset="${modeId}">
              <div class="card-title">
                <span>${escapeHtml(preset.title)}</span>
                ${selected ? `<span class="badge badge-supported">ACTIVE</span>` : ''}
              </div>
              <div style="font-size:11.5px;color:var(--accent-amber-bright);margin-top:4px">${escapeHtml(preset.subtitle)}</div>
              <div class="card-desc" style="margin-top:8px">${escapeHtml(preset.philosophy)}</div>
            </div>
          `;
        })
        .join('')}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Rendering & Culling Pipeline Controls (Sodium + EntityCulling + ImmediatelyFast)</div>

        <div class="form-row" style="margin-top:8px">
          <div>
            <div class="form-label">Compact 20-Byte Vertex Format</div>
            <div class="form-hint">Cuts chunk VBO VRAM bandwidth by ~28% with identical block pixel output.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-perf-bool="useCompactVertexFormat" ${perf.useCompactVertexFormat ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Block-Face & Fog Occlusion Culling</div>
            <div class="form-hint">Skips unseen interior chunk faces and geometry hidden completely behind fog horizon.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-perf-bool="useBlockFaceCulling" ${perf.useBlockFaceCulling ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Async Raycast Entity & Block-Entity Culling</div>
            <div class="form-hint">Off-thread visibility checks skip chests, signs, & mobs occluded behind solid walls.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-perf-bool="useEntityCulling" ${perf.useEntityCulling ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">ImmediatelyFast Draw-Call Batching</div>
            <div class="form-hint">Batches consecutive entity, armor, text, and HUD quads into single OpenGL submissions.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-perf-bool="ImmediatelyFastBatching" ${perf.ImmediatelyFastBatching ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Unfocused Window FPS Limiter (${perf.dynamicBackgroundFpsLimit} FPS)</div>
            <div class="form-hint">Throttles GPU power & heat when Alt-Tabbed while keeping multiplayer packets alive.</div>
          </div>
          <input type="range" id="perf-bg-fps" min="10" max="60" step="5" value="${perf.dynamicBackgroundFpsLimit}" style="width:130px" />
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Suspend Launcher Polling During Gameplay</div>
            <div class="form-hint">Drops Vespera Launcher CPU utilization to 0.0% while Minecraft is running.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-perf-bool="keepLauncherIdleOnRun" ${perf.keepLauncherIdleOnRun ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Intelligent Memory & Garbage Collector Configuration</span>
          <button class="btn btn-sm btn-cyan" id="btn-apply-ram-recommendation">Apply Recommended (${ramAdvice.recommendedMb} MB)</button>
        </div>
        <div class="card-desc">${escapeHtml(ramAdvice.rationale)}</div>

        <div class="form-row" style="margin-top:10px">
          <div>
            <div class="form-label">Allocated JVM Heap: <span style="color:var(--accent-amber-bright);font-family:var(--font-mono)">${perf.allocatedRamMb} MB</span></div>
            <div class="form-hint">Host Total: ${snap.telemetry.totalSystemRamMb} MB · Safe Range: ${ramAdvice.minSafeMb}–${ramAdvice.maxSafeMb} MB</div>
          </div>
          <input
            type="range"
            id="perf-ram-slider"
            min="1536"
            max="${Math.max(8192, Math.min(16384, Math.floor(snap.telemetry.totalSystemRamMb * 0.85)))}"
            step="256"
            value="${perf.allocatedRamMb}"
            style="width:165px"
          />
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Garbage Collector Strategy</div>
            <div class="form-hint">Generational ZGC (Java 21+) delivers &lt;0.5ms concurrent pauses; Adaptive G1GC minimizes footprint.</div>
          </div>
          <select class="select" id="perf-gc-select">
            <option value="adaptive_g1gc" ${perf.gcMode === 'adaptive_g1gc' ? 'selected' : ''}>Client-Tuned Adaptive G1GC</option>
            <option value="generational_zgc" ${perf.gcMode === 'generational_zgc' ? 'selected' : ''}>Java 21 Generational ZGC</option>
            <option value="shenandoah_low_pause" ${perf.gcMode === 'shenandoah_low_pause' ? 'selected' : ''}>Shenandoah Low-Pause GC</option>
          </select>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Pre-Touch Physical Pages at Boot (-XX:+AlwaysPreTouch)</div>
            <div class="form-hint">Adds ~20–80ms to cold boot in exchange for zero OS page-fault stutters in PvP combat.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-perf-bool="alwaysPreTouch" ${perf.alwaysPreTouch ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div style="margin-top:12px;font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase">
          Transparent JVM Flag Breakdown (${explanations.length} Active Flags)
        </div>
        <div style="max-height:175px;overflow-y:auto;margin-top:8px;display:flex;flex-direction:column;gap:5px">
          ${explanations
            .map(
              (item) => `
            <div style="padding:6px 8px;background:var(--bg-canvas);border-radius:4px;font-size:11.5px">
              <code style="color:var(--accent-cyan)">${escapeHtml(item.flag)}</code>
              <span style="color:var(--text-secondary)"> — ${escapeHtml(item.description)}</span>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;
}

export function renderGraphicsPage(snap: AppStateSnapshot): string {
  const active = snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const g = active.graphics;

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Granular Graphics & Visual Quality Configuration</h2>
        <p class="page-subtitle">
          Synchronized directly to your instance's <code>options.txt</code> and <code>config/sodium-options.json</code>. All vanilla visual features remain fully available and transparent.
        </p>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">World Horizon, Lighting & Geometry</div>

        <div class="form-row" style="margin-top:8px">
          <div>
            <div class="form-label">Render Distance: <strong style="color:var(--accent-amber-bright)">${g.renderDistanceChunks} Chunks</strong></div>
            <div class="form-hint">Sodium MultiDrawIndirect renders 16–20 chunks faster than vanilla renders 8 chunks.</div>
          </div>
          <input type="range" data-gfx-num="renderDistanceChunks" min="4" max="32" step="1" value="${g.renderDistanceChunks}" style="width:150px" />
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Simulation Distance: <strong>${g.simulationDistanceChunks} Chunks</strong></div>
            <div class="form-hint">Controls redstone, crop, and mob ticking radius in singleplayer (optimized by Lithium).</div>
          </div>
          <input type="range" data-gfx-num="simulationDistanceChunks" min="5" max="24" step="1" value="${g.simulationDistanceChunks}" style="width:150px" />
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Entity Render Distance: <strong>${g.entityDistancePercent}%</strong></div>
            <div class="form-hint">Percentage of vanilla entity visibility distance; occluded entities still culled via raycast.</div>
          </div>
          <input type="range" data-gfx-num="entityDistancePercent" min="50" max="300" step="25" value="${g.entityDistancePercent}" style="width:150px" />
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Smooth Lighting (Ambient Occlusion)</div>
            <div class="form-hint">Preserves smooth corner shading across terrain blocks.</div>
          </div>
          <select class="select" data-gfx-str="smoothLighting">
            <option value="maximum" ${g.smoothLighting === 'maximum' ? 'selected' : ''}>Maximum (Recommended)</option>
            <option value="minimum" ${g.smoothLighting === 'minimum' ? 'selected' : ''}>Minimum</option>
            <option value="off" ${g.smoothLighting === 'off' ? 'selected' : ''}>Off</option>
          </select>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Biome Color Blend (${g.biomeBlendRadius}×${g.biomeBlendRadius})</div>
            <div class="form-hint">Smooths grass, foliage, and water transitions across biome borders.</div>
          </div>
          <select class="select" data-gfx-num-select="biomeBlendRadius">
            <option value="0" ${g.biomeBlendRadius === 0 ? 'selected' : ''}>Off (1×1)</option>
            <option value="3" ${g.biomeBlendRadius === 3 ? 'selected' : ''}>Fast (3×3)</option>
            <option value="5" ${g.biomeBlendRadius === 5 ? 'selected' : ''}>Smooth (5×5)</option>
            <option value="7" ${g.biomeBlendRadius === 7 ? 'selected' : ''}>Ultra (7×7)</option>
          </select>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Textures, Effects & Visual Enhancement Stack</div>

        <div class="form-row" style="margin-top:8px">
          <div>
            <div class="form-label">Mipmap Levels (${g.mipmapLevels}x) & Anisotropic Filtering (${g.anisotropicFiltering}x)</div>
            <div class="form-hint">Eliminates distant moiré shimmer on high-detail textures without blurring close blocks.</div>
          </div>
          <select class="select" data-gfx-num-select="mipmapLevels">
            <option value="4" ${g.mipmapLevels === 4 ? 'selected' : ''}>4x Trilinear (Crisp)</option>
            <option value="3" ${g.mipmapLevels === 3 ? 'selected' : ''}>3x</option>
            <option value="2" ${g.mipmapLevels === 2 ? 'selected' : ''}>2x</option>
            <option value="0" ${g.mipmapLevels === 0 ? 'selected' : ''}>Off</option>
          </select>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Particles & Clouds</div>
            <div class="form-hint">Keep All particles for full combat/potion clarity or Decreased in dense raids.</div>
          </div>
          <div style="display:flex;gap:8px">
            <select class="select" data-gfx-str="particles">
              <option value="all" ${g.particles === 'all' ? 'selected' : ''}>Particles: All</option>
              <option value="decreased" ${g.particles === 'decreased' ? 'selected' : ''}>Decreased</option>
              <option value="minimal" ${g.particles === 'minimal' ? 'selected' : ''}>Minimal</option>
            </select>
            <select class="select" data-gfx-str="clouds">
              <option value="fancy" ${g.clouds === 'fancy' ? 'selected' : ''}>Clouds: Fancy</option>
              <option value="fast" ${g.clouds === 'fast' ? 'selected' : ''}>Fast</option>
              <option value="off" ${g.clouds === 'off' ? 'selected' : ''}>Off</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Connected Block Textures (Continuity CTM)</div>
            <div class="form-hint">Borderless glass, sandstone, and bookshelves baked asynchronously on worker threads.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-gfx-bool="connectedTextures" ${g.connectedTextures ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Custom Entity Models & Emissives (EMF + ETF)</div>
            <div class="form-hint">Supports Fresh Animations, random biome mob skins, and glowing ore/mob eyes.</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-gfx-bool="customEntityModels" ${g.customEntityModels ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Entity Drop Shadows & VSync</div>
            <div class="form-hint">Disable VSync for lowest mouse latency on G-Sync/FreeSync displays.</div>
          </div>
          <div style="display:flex;gap:14px;font-size:12.5px">
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
              <input type="checkbox" data-gfx-bool="entityShadows" ${g.entityShadows ? 'checked' : ''} /> Shadows
            </label>
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
              <input type="checkbox" data-gfx-bool="vsync" ${g.vsync ? 'checked' : ''} /> VSync
            </label>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderShaderPacksPage(snap: AppStateSnapshot): string {
  const active = snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const irisEnabled = active.enabledModIds.includes('iris');

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Iris Shader Pack Pipeline</h2>
        <p class="page-subtitle">
          Integrated with Sodium shadow-pass frustum culling and LabPBR specular/emissive materials. Selecting a shader pack automatically verifies Iris + Sodium compatibility.
        </p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${irisEnabled ? 'badge-supported' : 'badge-warning'}">
          ${irisEnabled ? 'Iris 1.8.5 Pipeline Ready' : 'Iris Currently Disabled (Auto-enables on selection)'}
        </span>
        <button class="btn btn-sm" data-select-shader="">Disable Shaders (Pure Sodium)</button>
      </div>
    </div>

    <div class="grid-3">
      ${snap.shaderPacks
        .map(
          (sp) => `
        <div class="card selectable ${sp.active ? 'selected' : ''}">
          <div class="card-title">
            <span>${escapeHtml(sp.name)}</span>
            <span class="badge ${sp.active ? 'badge-supported' : ''}">${sp.active ? 'ACTIVE' : escapeHtml(sp.estimatedGpuLoad.toUpperCase())}</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px">
            by ${escapeHtml(sp.author)} · Shadow Map: ${sp.shadowMapResolution}px · File: <code>${escapeHtml(sp.fileName)}</code>
          </div>
          <div class="card-desc" style="margin-top:8px">${escapeHtml(sp.description)}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:14px;padding-top:10px;border-top:1px solid var(--border-subtle)">
            <select class="select" data-shader-quality-for="${escapeHtml(sp.id)}" style="font-size:12px;padding:4px 8px">
              ${sp.presetSupport
                .map(
                  (q) =>
                    `<option value="${q}" ${sp.selectedProfile === q ? 'selected' : ''}>Preset: ${q.toUpperCase()}</option>`
                )
                .join('')}
            </select>
            <button class="btn btn-sm ${sp.active ? 'btn-cyan' : 'btn-primary'}" data-select-shader="${escapeHtml(sp.id)}">
              ${sp.active ? '✓ Active Shader' : 'Activate Pack'}
            </button>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

export function renderResourcePacksPage(snap: AppStateSnapshot): string {
  const active = snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const totalVramMb = snap.resourcePacks
    .filter((r) => r.enabled)
    .reduce((acc, r) => acc + r.estimatedVramMb, 0);

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Resource Pack Manager & VRAM Atlas Advisor</h2>
        <p class="page-subtitle">
          Supports 16x–512x HD & LabPBR resource packs with automatic <code>pack.mcmeta</code> format compatibility verification for Minecraft ${escapeHtml(active.mcVersion)}.
        </p>
      </div>
      <div class="metric-pill">
        <span class="label">EST. ATLAS VRAM:</span>
        <span class="val cyan">${totalVramMb} MB</span>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:12px">
      ${snap.resourcePacks
        .map(
          (rp) => `
        <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div style="display:flex;align-items:center;gap:14px">
            <div style="width:46px;height:46px;border-radius:8px;background:var(--bg-canvas);border:2px solid ${escapeHtml(rp.accentColor)};display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:800;font-size:12px;color:${escapeHtml(rp.accentColor)};flex-shrink:0">
              ${escapeHtml(rp.resolution)}
            </div>
            <div>
              <div style="font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span>${escapeHtml(rp.name)}</span>
                <span class="badge">format ${rp.packFormat} (${escapeHtml(rp.compatibleMcRange)})</span>
                <span class="badge ${rp.compatibleWithCurrent ? 'badge-supported' : 'badge-warning'}">
                  ${rp.compatibleWithCurrent ? 'Verified Compatible' : 'Version Mismatch'}
                </span>
              </div>
              <div class="card-desc">${escapeHtml(rp.description)}</div>
              ${
                !rp.compatibleWithCurrent && rp.compatibilityWarning
                  ? `<div style="margin-top:6px;font-size:11.5px;color:#fbbf24">⚠ ${escapeHtml(rp.compatibilityWarning)}</div>`
                  : ''
              }
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:14px;flex-shrink:0">
            <span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-muted)">~${rp.estimatedVramMb} MB VRAM</span>
            <label class="switch">
              <input type="checkbox" data-toggle-rp="${escapeHtml(rp.id)}" ${rp.enabled ? 'checked' : ''} />
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

export function bindPerfAndGraphicsEvents(
  stage: HTMLElement,
  callbacks: {
    onSelectPerfMode: (mode: PerformanceModeId) => void;
    onUpdatePerf: (patch: Partial<PerformanceSettings>) => void;
    onApplyRecommendedRam: (mb: number, gc: GarbageCollectorMode) => void;
    onUpdateGraphics: (patch: Partial<GraphicsSettings>) => void;
    onSelectShader: (shaderId: string | null, quality?: ShaderPackEntry['selectedProfile']) => void;
    onToggleResourcePack: (packId: string, enabled: boolean) => void;
  },
  recommendedRam: { mb: number; gc: GarbageCollectorMode }
): void {
  stage.querySelectorAll<HTMLElement>('[data-select-perf-preset]').forEach((card) => {
    card.addEventListener('click', () => {
      callbacks.onSelectPerfMode(card.dataset.selectPerfPreset as PerformanceModeId);
    });
  });

  stage.querySelectorAll<HTMLInputElement>('[data-perf-bool]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const key = chk.dataset.perfBool as keyof PerformanceSettings;
      callbacks.onUpdatePerf({ [key]: chk.checked } as Partial<PerformanceSettings>);
    });
  });

  stage.querySelector('#perf-bg-fps')?.addEventListener('change', (ev) => {
    callbacks.onUpdatePerf({
      dynamicBackgroundFpsLimit: Number((ev.target as HTMLInputElement).value),
    });
  });

  stage.querySelector('#perf-ram-slider')?.addEventListener('change', (ev) => {
    callbacks.onUpdatePerf({
      allocatedRamMb: Number((ev.target as HTMLInputElement).value),
      autoRecommendRam: false,
    });
  });

  stage.querySelector('#perf-gc-select')?.addEventListener('change', (ev) => {
    callbacks.onUpdatePerf({
      gcMode: (ev.target as HTMLSelectElement).value as GarbageCollectorMode,
    });
  });

  stage.querySelector('#btn-apply-ram-recommendation')?.addEventListener('click', () => {
    callbacks.onApplyRecommendedRam(recommendedRam.mb, recommendedRam.gc);
  });

  // Graphics controls
  stage.querySelectorAll<HTMLInputElement>('[data-gfx-num]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.gfxNum as keyof GraphicsSettings;
      callbacks.onUpdateGraphics({ [k]: Number(inp.value) } as Partial<GraphicsSettings>);
    });
  });

  stage.querySelectorAll<HTMLSelectElement>('[data-gfx-num-select]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const k = sel.dataset.gfxNumSelect as keyof GraphicsSettings;
      callbacks.onUpdateGraphics({ [k]: Number(sel.value) } as Partial<GraphicsSettings>);
    });
  });

  stage.querySelectorAll<HTMLSelectElement>('[data-gfx-str]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const k = sel.dataset.gfxStr as keyof GraphicsSettings;
      callbacks.onUpdateGraphics({ [k]: sel.value } as Partial<GraphicsSettings>);
    });
  });

  stage.querySelectorAll<HTMLInputElement>('[data-gfx-bool]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const k = chk.dataset.gfxBool as keyof GraphicsSettings;
      callbacks.onUpdateGraphics({ [k]: chk.checked } as Partial<GraphicsSettings>);
    });
  });

  // Shader Pack controls
  stage.querySelectorAll<HTMLElement>('[data-select-shader]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rawId = btn.dataset.selectShader || '';
      const shaderId = rawId.length > 0 ? rawId : null;
      const qualSel = shaderId
        ? stage.querySelector<HTMLSelectElement>(`[data-shader-quality-for="${shaderId}"]`)
        : null;
      callbacks.onSelectShader(
        shaderId,
        qualSel?.value as ShaderPackEntry['selectedProfile'] | undefined
      );
    });
  });

  // Resource Pack controls
  stage.querySelectorAll<HTMLInputElement>('[data-toggle-rp]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.toggleRp;
      if (id) callbacks.onToggleResourcePack(id, chk.checked);
    });
  });
}
