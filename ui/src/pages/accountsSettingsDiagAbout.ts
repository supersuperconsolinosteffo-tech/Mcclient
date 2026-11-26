import type {
  AppStateSnapshot,
  DeviceCodeAuthChallenge,
  GraphicsSettings,
  LauncherSettings,
} from '@shared/types';
import { escapeHtml } from '../icons';

export function renderAccountsPage(
  snap: AppStateSnapshot,
  authChallenge: DeviceCodeAuthChallenge | null
): string {
  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Microsoft / Minecraft Account Authentication</h2>
        <p class="page-subtitle">
          Official OAuth 2.0 Device Code + PKCE → Xbox Live → XSTS → Minecraft Services authentication chain. Zero passwords stored, zero tokens logged, DPAPI/AES-256-GCM encrypted local vault, and zero cracked-account shortcuts.
        </p>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>Sign In with Official Microsoft Account</span>
          <span class="badge badge-supported">DPAPI / AES-256-GCM Vault</span>
        </div>
        <div class="card-desc">
          Vespera uses Microsoft's official OAuth 2.0 Device Code & PKCE endpoints (<code>login.microsoftonline.com/consumers/oauth2/v2.0</code>) with scope <code>XboxLive.signin offline_access</code>.
        </div>

        <div class="form-row" style="margin-top:12px">
          <div style="flex:1">
            <div class="form-label">Microsoft Entra (Azure) Application Client ID</div>
            <div class="form-hint">Register a Public Client App with Device Code / Live SDK support, then paste its Client ID below.</div>
            <input
              type="text"
              class="input"
              id="msa-client-id-input"
              placeholder="e.g. 00000000-0000-0000-0000-000000000000"
              value="${escapeHtml(snap.settings.microsoftAzureClientId)}"
              style="width:100%;margin-top:6px;font-family:var(--font-mono)"
            />
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn btn-primary" id="btn-start-msa-auth">Sign In with Microsoft (Device Code)</button>
          ${
            authChallenge && authChallenge.clientIdConfigured
              ? `<button class="btn btn-cyan" id="btn-poll-msa-auth">Verify Browser Authorization</button>`
              : ''
          }
        </div>

        ${
          authChallenge
            ? `<div style="margin-top:14px;padding:12px 14px;border-radius:8px;background:var(--bg-canvas);border:1px solid ${
                authChallenge.clientIdConfigured ? 'var(--accent-cyan)' : 'var(--accent-amber)'
              }">
                ${
                  authChallenge.clientIdConfigured
                    ? `<div style="font-size:12px;color:var(--text-secondary)">Open <a href="${escapeHtml(authChallenge.verificationUri)}" target="_blank" rel="noreferrer" style="color:var(--accent-cyan)">${escapeHtml(authChallenge.verificationUri)}</a> and enter code:</div>
                       <div style="font-size:24px;font-weight:800;font-family:var(--font-mono);letter-spacing:3px;color:var(--accent-amber-bright);margin:6px 0">${escapeHtml(authChallenge.userCode)}</div>`
                    : ''
                }
                <div style="font-size:12px;color:var(--text-primary)">${escapeHtml(authChallenge.statusMessage)}</div>
              </div>`
            : ''
        }
      </div>

      <div class="card">
        <div class="card-title">Authenticated Accounts (${snap.accounts.length})</div>
        <div class="card-desc">Switch active profile session or revoke stored OAuth tokens at any time.</div>

        <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px">
          ${
            snap.accounts.length === 0
              ? `<div style="padding:18px;background:var(--bg-canvas);border:1px dashed var(--border-strong);border-radius:8px;color:var(--text-secondary);font-size:12.5px">
                  No Microsoft/Minecraft account currently signed in.<br/><br/>
                  <strong>Security Notice:</strong> Vespera never fabricates fake offline accounts or bypasses Mojang session servers. Configure your Azure Client ID on the left to authenticate a genuine Minecraft: Java Edition account.
                </div>`
              : snap.accounts
                  .map(
                    (acc) => `
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-canvas);border:1px solid ${
                    acc.active ? 'var(--accent-amber)' : 'var(--border-subtle)'
                  };border-radius:8px">
                    <div>
                      <div style="font-weight:700;font-size:13.5px">
                        ${escapeHtml(acc.username)}
                        <span class="badge ${acc.sessionStatus === 'valid' ? 'badge-supported' : 'badge-warning'}">${escapeHtml(acc.sessionStatus)}</span>
                      </div>
                      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">UUID: ${escapeHtml(acc.uuid)}</div>
                    </div>
                    <div style="display:flex;gap:6px">
                      ${
                        !acc.active
                          ? `<button class="btn btn-sm" data-switch-account="${escapeHtml(acc.id)}">Use Account</button>`
                          : `<span class="badge badge-supported">ACTIVE</span>`
                      }
                      <button class="btn btn-sm btn-danger" data-remove-account="${escapeHtml(acc.id)}">Sign Out</button>
                    </div>
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

export function renderSettingsPage(snap: AppStateSnapshot): string {
  const s = snap.settings;
  const active = snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];
  const g = active.graphics;

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Launcher, Java Runtime & Installation Settings</h2>
        <p class="page-subtitle">
          Manage automatic Eclipse Temurin Java runtimes, game directories, window display geometry, concurrent asset workers, crash recovery, and update policies.
        </p>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Managed Java Runtimes (Automatic Provisioning — Zero Manual Setup)</div>
        <div class="card-desc">Vespera resolves the exact Java major version required by each Minecraft release via Adoptium Temurin LTS with SHA-256 verification.</div>

        <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
          ${snap.javaRuntimes
            .map(
              (rt) => `
            <div style="padding:10px 12px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:10px">
              <div>
                <div style="font-weight:700;font-size:13px">
                  Java ${rt.major} LTS — ${escapeHtml(rt.vendor)}
                  <span class="badge ${rt.installed ? 'badge-supported' : 'badge-experimental'}">${rt.installed ? 'Installed & Verified' : 'Auto-Fetch On Demand'}</span>
                </div>
                <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-top:3px">
                  v${escapeHtml(rt.version)} · ${escapeHtml(rt.path)}
                </div>
              </div>
            </div>
          `
            )
            .join('')}
        </div>

        <div class="form-row" style="margin-top:12px">
          <div style="flex:1">
            <div class="form-label">Additional Expert JVM Flags</div>
            <div class="form-hint">Optional extra <code>-XX:</code> or <code>-D</code> arguments appended after Vespera's collector flags. Leave blank unless profiling specific GC behavior.</div>
            <input
              type="text"
              class="input"
              id="set-extra-jvm"
              value="${escapeHtml(s.customJvmExtraArgs)}"
              placeholder="e.g. -XX:+PrintFlagsFinal"
              style="width:100%;margin-top:6px;font-family:var(--font-mono)"
            />
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Directories, Window Geometry, Downloads & Reliability</div>

        <div class="form-row" style="margin-top:8px">
          <div style="flex:1">
            <div class="form-label">Managed Game Assets & Libraries Directory</div>
            <input type="text" class="input" id="set-gamedir" value="${escapeHtml(s.gameDataDir)}" style="width:100%;margin-top:5px;font-family:var(--font-mono);font-size:12px" />
          </div>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Window Mode & Launch Resolution</div>
            <div class="form-hint">Borderless Fullscreen offers instant Alt-Tab with DWM flip-model presentation on Windows 11.</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="select" id="set-winmode">
              <option value="borderless_fullscreen" ${g.fullscreenMode === 'borderless_fullscreen' ? 'selected' : ''}>Borderless Fullscreen</option>
              <option value="windowed" ${g.fullscreenMode === 'windowed' ? 'selected' : ''}>Windowed</option>
              <option value="exclusive_fullscreen" ${g.fullscreenMode === 'exclusive_fullscreen' ? 'selected' : ''}>Exclusive Fullscreen</option>
            </select>
            <input type="number" class="input" id="set-res-w" value="${g.resolutionWidth}" style="width:74px" />
            <span>×</span>
            <input type="number" class="input" id="set-res-h" value="${g.resolutionHeight}" style="width:74px" />
          </div>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Parallel Asset Download Workers (${s.concurrentDownloads} threads)</div>
            <div class="form-hint">Verified with SHA-1 / SHA-256 atomic resume on interrupted network transfers.</div>
          </div>
          <input type="range" id="set-dl-workers" min="2" max="16" step="2" value="${s.concurrentDownloads}" style="width:130px" />
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Automatic Pre-Update Profile Safeguard Backups</div>
            <div class="form-hint">Creates an instant rollback checkpoint before installing mods or switching performance presets.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="set-auto-backup" ${s.autoBackupBeforeProfileUpdate ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Update Channel & Interface Language</div>
          </div>
          <div style="display:flex;gap:8px">
            <select class="select" id="set-update-channel">
              <option value="stable" ${s.updateChannel === 'stable' ? 'selected' : ''}>Stable Releases</option>
              <option value="beta" ${s.updateChannel === 'beta' ? 'selected' : ''}>Beta Preview</option>
            </select>
            <select class="select" id="set-language">
              <option value="en-US" ${s.language === 'en-US' ? 'selected' : ''}>English (US)</option>
              <option value="it-IT" ${s.language === 'it-IT' ? 'selected' : ''}>Italiano (IT)</option>
              <option value="de-DE" ${s.language === 'de-DE' ? 'selected' : ''}>Deutsch (DE)</option>
              <option value="fr-FR" ${s.language === 'fr-FR' ? 'selected' : ''}>Français (FR)</option>
              <option value="es-ES" ${s.language === 'es-ES' ? 'selected' : ''}>Español (ES)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderDiagnosticsPage(snap: AppStateSnapshot, isRunningBench: boolean): string {
  const t = snap.telemetry;
  const bench = snap.latestBenchmark;
  const maxMeasuredFps = Math.max(
    1,
    ...(bench?.results.map((r) => r.metrics.avgFps ?? 0) ?? [1000])
  );

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">System Telemetry, Diagnostics Doctor & Reproducible Benchmarks</h2>
        <p class="page-subtitle">
          Honest, unfabricated hardware & JVM measurements. Unavailable hardware counters (such as kernel GPU % in headless sessions) are explicitly shown as <code>N/A</code>—never invented.
        </p>
      </div>
      <button class="btn btn-primary" id="btn-run-benchmarks" ${isRunningBench ? 'disabled' : ''}>
        ${isRunningBench ? '⏳ Running OpenJDK 21 Suite…' : '⚡ Execute Reproducible Benchmark Suite'}
      </button>
    </div>

    <div class="grid-4" style="margin-bottom:18px">
      <div class="card">
        <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted)">HOST CPU UTILIZATION</div>
        <div style="font-size:21px;font-weight:800;font-family:var(--font-mono);color:var(--accent-cyan);margin-top:4px">${t.cpuUtilizationPercent}%</div>
        <div class="card-desc">${escapeHtml(t.cpuModel)} (${t.cpuCoresLogical} threads)</div>
      </div>
      <div class="card">
        <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted)">SYSTEM RAM USED / TOTAL</div>
        <div style="font-size:21px;font-weight:800;font-family:var(--font-mono);margin-top:4px">${t.usedSystemRamMb} / ${t.totalSystemRamMb} MB</div>
        <div class="card-desc">Launcher RSS: ${t.launcherProcessRamMb} MB</div>
      </div>
      <div class="card">
        <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted)">IN-GAME LIVE TELEMETRY</div>
        <div style="font-size:21px;font-weight:800;font-family:var(--font-mono);color:var(--accent-amber-bright);margin-top:4px">
          ${t.inGameMetrics.measured && t.inGameMetrics.fps !== null ? `${t.inGameMetrics.fps} FPS` : 'Idle (Not In-World)'}
        </div>
        <div class="card-desc">
          1% Low: ${t.inGameMetrics.onePercentLowFps !== null ? `${t.inGameMetrics.onePercentLowFps} FPS` : 'N/A'} ·
          Ping: ${t.inGameMetrics.serverPingMs !== null ? `${t.inGameMetrics.serverPingMs} ms` : 'N/A'}
        </div>
      </div>
      <div class="card">
        <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted)">GPU HARDWARE COUNTER</div>
        <div style="font-size:21px;font-weight:800;font-family:var(--font-mono);color:var(--text-secondary);margin-top:4px">
          ${t.gpuUtilizationPercent !== null ? `${t.gpuUtilizationPercent}%` : 'N/A (Unexposed)'}
        </div>
        <div class="card-desc">${escapeHtml(t.gpuAdapterName || 'Populated via DXGI on Windows GPU host')}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="card-title">
        <span>Integrated Reproducible Benchmark Suite (OpenJDK 21 + Deterministic Voxel Pipeline)</span>
        ${bench ? `<span class="badge badge-supported">Measured ${escapeHtml(bench.executedAt.slice(11, 19))} UTC</span>` : `<span class="badge">Not Yet Run</span>`}
      </div>
      ${
        !bench
          ? `<div class="card-desc" style="margin-top:10px">
              Click <strong>"⚡ Execute Reproducible Benchmark Suite"</strong> above to spawn real OpenJDK 21 processes comparing Vanilla Baseline, Vespera Maximum FPS (Generational ZGC + PreTouch + Indirect Culling), Vespera Balanced (Adaptive G1GC), Vespera Visual Quality (LabPBR Pass), and your Active Profile.
            </div>`
          : `
            <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">
              <strong>Test Conditions:</strong> ${escapeHtml(bench.hardwareSummary)} · ${escapeHtml(bench.javaRuntimeVersion)} · Scene: ${escapeHtml(bench.reproducibleConditions.sceneSeed)}
            </div>
            <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
              ${bench.results
                .map((r) => {
                  if (!r.available) {
                    return `
                      <div style="padding:10px 12px;background:var(--bg-canvas);border:1px dashed var(--border-strong);border-radius:6px">
                        <div style="font-weight:700;font-size:13px;color:var(--text-secondary)">${escapeHtml(r.scenarioName)} <span class="badge">External Binary Absent</span></div>
                        <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px">${escapeHtml(r.notes)}</div>
                      </div>
                    `;
                  }
                  const pct = Math.min(100, Math.round(((r.metrics.avgFps ?? 0) / maxMeasuredFps) * 100));
                  return `
                    <div style="padding:12px 14px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:8px">
                      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px">
                        <strong style="font-size:13.5px">${escapeHtml(r.scenarioName)}</strong>
                        <div style="font-family:var(--font-mono);font-size:12px;display:flex;gap:14px;flex-wrap:wrap">
                          <span style="color:var(--accent-amber-bright)">Avg: <strong>${r.metrics.avgFps} FPS</strong></span>
                          <span style="color:var(--accent-cyan)">1% Low: <strong>${r.metrics.onePercentLowFps} FPS</strong></span>
                          <span>P99: <strong>${r.metrics.p99FrameTimeMs} ms</strong></span>
                          <span>Culling: <strong>${r.metrics.cullingEfficiencyPercent}%</strong></span>
                          <span style="color:#34d399">Peak Heap: <strong>${r.metrics.peakHeapUsedMb} MB</strong></span>
                          <span>Boot: <strong>${r.metrics.jvmColdStartupMs} ms</strong></span>
                        </div>
                      </div>
                      <div class="bench-bar-track"><div class="bench-bar-fill" style="width:${pct}%"></div></div>
                      <div style="font-size:11.5px;color:var(--text-muted);margin-top:5px">${escapeHtml(r.notes)}</div>
                    </div>
                  `;
                })
                .join('')}
            </div>
            <div style="margin-top:12px;padding:10px 12px;background:var(--bg-elevated);border-radius:6px;font-size:11.5px;color:var(--text-secondary)">
              <strong>Methodology & Limitations:</strong>
              ${bench.limitationsAndMethodology.map((m) => `<div>• ${escapeHtml(m)}</div>`).join('')}
            </div>
          `
      }
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Automated Configuration & Crash Doctor</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
          ${
            snap.diagnostics.length === 0
              ? `<div style="padding:12px;background:var(--bg-canvas);border:1px dashed var(--border-strong);border-radius:6px;font-size:12px;color:var(--text-secondary)">
                  Diagnostic findings are currently empty or temporarily unavailable. Click <strong>Verify &amp; Repair Files</strong> on Home/Play to run a fresh integrity check.
                </div>`
              : snap.diagnostics
                  .map(
                    (d) => `
            <div style="padding:10px 12px;background:var(--bg-canvas);border:1px solid var(--border-subtle);border-radius:6px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <strong style="font-size:13px">${escapeHtml(d.title)}</strong>
                <span class="badge badge-${escapeHtml(d.severity)}">${escapeHtml(d.severity.toUpperCase())}</span>
              </div>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${escapeHtml(d.explanation)}</div>
              <div style="font-size:12px;color:var(--accent-cyan);margin-top:4px">Recommendation: ${escapeHtml(d.recommendation)}</div>
              ${
                d.autoFixActionId
                  ? `<button class="btn btn-sm btn-primary" data-autofix-id="${escapeHtml(d.autoFixActionId)}" style="margin-top:8px">Apply Automatic Fix</button>`
                  : ''
              }
            </div>
          `
                  )
                  .join('')
          }
        </div>
      </div>

      <div class="card">
        <div class="card-title">Diagnostic Log Inspector</div>
        <div class="console-box" style="margin-top:12px;max-height:310px">${escapeHtml(
          snap.recentLogs.slice().reverse().join('\n')
        )}</div>
      </div>
    </div>
  `;
}

export function renderAboutPage(snap: AppStateSnapshot): string {
  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">About Vespera Client</h2>
        <p class="page-subtitle">
          Next-Generation Precision Minecraft Java Edition Client & Native Windows 10/11 Desktop Launcher — Engineered for Exceptional Frame Pacing Without Visual Downgrades.
        </p>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:18px">
      <div class="card">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
          <img src="./vespera-mark.svg" alt="Vespera Logo" style="width:52px;height:52px" />
          <div>
            <div style="font-size:18px;font-weight:800;letter-spacing:1.5px">VESPERA CLIENT v${escapeHtml(snap.version)}</div>
            <div style="font-family:var(--font-mono);font-size:11.5px;color:var(--accent-amber-bright)">Windows 10/11 x64 Native WebView2 + Fabric 1.21.4 Kotlin JVM 21</div>
          </div>
        </div>
        <div class="card-desc">
          Vespera separates its lightweight native Windows desktop launcher (<code>VesperaClient.exe</code>, Win32 + Edge WebView2 + WinHTTP + DPAPI + CNG BCrypt) from its decoupled client-side Fabric integration mod (<code>vespera-client-1.0.0+mc1.21.4.jar</code>), keeping launcher RAM overhead minimal and background CPU utilization at 0.0% during gameplay.
        </div>
      </div>

      <div class="card">
        <div class="card-title">Security, Privacy & Fair-Play Guarantees</div>
        <ul style="margin-top:10px;padding-left:18px;color:var(--text-secondary);font-size:12.5px;display:flex;flex-direction:column;gap:6px">
          <li><strong>Zero Hardcoded Secrets & DPAPI Token Protection:</strong> OAuth tokens are encrypted per-user via Windows CryptProtectData / AES-256-GCM and scrubbed from all logs.</li>
          <li><strong>Cryptographic Download Integrity:</strong> Every Minecraft client JAR, Adoptium Java runtime, and Modrinth artifact is verified with SHA-1 / SHA-256 / SHA-512 before execution.</li>
          <li><strong>Zero Invasive Telemetry:</strong> All diagnostics, crash analysis, and benchmarks stay 100% local on your machine.</li>
          <li><strong>Strict Fair-Play Policy:</strong> Zero cheats, combat automation, reach modification, cave radar, or anticheat bypasses.</li>
        </ul>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Third-Party Components & Open-Source License Manifest</div>
      <div style="overflow-x:auto;margin-top:12px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--border-strong);text-align:left;color:var(--text-muted);font-family:var(--font-mono)">
              <th style="padding:7px">COMPONENT</th>
              <th style="padding:7px">ROLE</th>
              <th style="padding:7px">LICENSE (SPDX)</th>
              <th style="padding:7px">DISTRIBUTION STATUS</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid var(--border-subtle)">
              <td style="padding:8px;font-weight:700">webview/webview + MS WebView2 SDK Headers</td>
              <td style="padding:8px">Native Win32 Edge WebView2 GUI Host</td>
              <td style="padding:8px;font-family:var(--font-mono)">MIT / BSD-3-Clause</td>
              <td style="padding:8px">Included in <code>native/third_party/</code> with LICENSE</td>
            </tr>
            <tr style="border-bottom:1px solid var(--border-subtle)">
              <td style="padding:8px;font-weight:700">Fabric Loader & Fabric API</td>
              <td style="padding:8px">Modloader & Client Hooks</td>
              <td style="padding:8px;font-family:var(--font-mono)">Apache-2.0</td>
              <td style="padding:8px">Fetched dynamically from official <code>meta.fabricmc.net</code></td>
            </tr>
            <tr style="border-bottom:1px solid var(--border-subtle)">
              <td style="padding:8px;font-weight:700">Sodium, Lithium, Iris, Continuity, ImmediatelyFast, ModernFix</td>
              <td style="padding:8px">Curated Performance & Shader Pipeline</td>
              <td style="padding:8px;font-family:var(--font-mono)">LGPL-3.0 / PolyForm-Shield-1.0.0</td>
              <td style="padding:8px">Fetched from official Modrinth CDN with SHA-512 verification</td>
            </tr>
            <tr style="border-bottom:1px solid var(--border-subtle)">
              <td style="padding:8px;font-weight:700">FerriteCore, Dynamic FPS, Mod Menu, Entity Texture Features</td>
              <td style="padding:8px">Memory Deduplication & Visual Polish</td>
              <td style="padding:8px;font-family:var(--font-mono)">MIT</td>
              <td style="padding:8px">Fetched from official Modrinth CDN with SHA-512 verification</td>
            </tr>
            <tr>
              <td style="padding:8px;font-weight:700">Eclipse Temurin OpenJDK (8 / 17 / 21 LTS)</td>
              <td style="padding:8px">Managed Java Virtual Machine Runtime</td>
              <td style="padding:8px;font-family:var(--font-mono)">GPL-2.0-with-Classpath-exception</td>
              <td style="padding:8px">Provisioned automatically via official Adoptium v3 API</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function bindAccountsSettingsDiagEvents(
  stage: HTMLElement,
  callbacks: {
    onStartMsaAuth: (clientId: string) => void;
    onPollMsaAuth: () => void;
    onSwitchAccount: (id: string) => void;
    onRemoveAccount: (id: string) => void;
    onUpdateSettings: (patch: Partial<LauncherSettings>) => void;
    onUpdateGraphics: (patch: Partial<GraphicsSettings>) => void;
    onRunBenchmarks: () => void;
    onApplyAutoFix: (actionId: string) => void;
  }
): void {
  stage.querySelector('#btn-start-msa-auth')?.addEventListener('click', () => {
    const cid = (stage.querySelector('#msa-client-id-input') as HTMLInputElement)?.value || '';
    callbacks.onUpdateSettings({ microsoftAzureClientId: cid.trim() });
    callbacks.onStartMsaAuth(cid.trim());
  });

  stage.querySelector('#btn-poll-msa-auth')?.addEventListener('click', callbacks.onPollMsaAuth);

  stage.querySelectorAll<HTMLElement>('[data-switch-account]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.switchAccount;
      if (id) callbacks.onSwitchAccount(id);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-remove-account]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.removeAccount;
      if (id) callbacks.onRemoveAccount(id);
    });
  });

  // Settings controls
  stage.querySelector('#set-extra-jvm')?.addEventListener('change', (ev) => {
    callbacks.onUpdateSettings({ customJvmExtraArgs: (ev.target as HTMLInputElement).value });
  });
  stage.querySelector('#set-gamedir')?.addEventListener('change', (ev) => {
    callbacks.onUpdateSettings({ gameDataDir: (ev.target as HTMLInputElement).value });
  });
  stage.querySelector('#set-winmode')?.addEventListener('change', (ev) => {
    callbacks.onUpdateGraphics({
      fullscreenMode: (ev.target as HTMLSelectElement).value as GraphicsSettings['fullscreenMode'],
    });
  });
  stage.querySelector('#set-res-w')?.addEventListener('change', (ev) => {
    callbacks.onUpdateGraphics({
      resolutionWidth: Math.max(640, Number((ev.target as HTMLInputElement).value) || 1920),
    });
  });
  stage.querySelector('#set-res-h')?.addEventListener('change', (ev) => {
    callbacks.onUpdateGraphics({
      resolutionHeight: Math.max(480, Number((ev.target as HTMLInputElement).value) || 1080),
    });
  });
  stage.querySelector('#set-dl-workers')?.addEventListener('change', (ev) => {
    callbacks.onUpdateSettings({
      concurrentDownloads: Number((ev.target as HTMLInputElement).value) || 8,
    });
  });
  stage.querySelector('#set-auto-backup')?.addEventListener('change', (ev) => {
    callbacks.onUpdateSettings({
      autoBackupBeforeProfileUpdate: (ev.target as HTMLInputElement).checked,
    });
  });
  stage.querySelector('#set-update-channel')?.addEventListener('change', (ev) => {
    callbacks.onUpdateSettings({
      updateChannel: (ev.target as HTMLSelectElement).value as LauncherSettings['updateChannel'],
    });
  });
  stage.querySelector('#set-language')?.addEventListener('change', (ev) => {
    callbacks.onUpdateSettings({
      language: (ev.target as HTMLSelectElement).value as LauncherSettings['language'],
    });
  });

  // Diagnostics & Benchmarks
  stage.querySelector('#btn-run-benchmarks')?.addEventListener('click', callbacks.onRunBenchmarks);
  stage.querySelectorAll<HTMLElement>('[data-autofix-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.autofixId;
      if (id) callbacks.onApplyAutoFix(id);
    });
  });
}
