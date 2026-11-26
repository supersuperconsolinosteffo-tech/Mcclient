import type {
  AppStateSnapshot,
  DeviceCodeAuthChallenge,
  GraphicsSettings,
  LauncherSettings,
} from '@shared/types';
import { escapeHtml } from '../icons';

function formatTimestampShort(ts: number | null | undefined): string {
  if (!ts || ts <= 0) return 'Never';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function renderAccountsPage(
  snap: AppStateSnapshot,
  authChallenge: DeviceCodeAuthChallenge | null
): string {
  const oauthCfg = snap.oauthConfig;
  const oauthConfigured = Boolean(oauthCfg?.configured);
  const flow = snap.authFlow;
  const activeChallenge = authChallenge || flow?.deviceChallenge || null;
  const offline = snap.offlineAvailability;
  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Microsoft Accounts &amp; Session Management</h2>
        <p class="page-subtitle">
          Sign in effortlessly with your Microsoft account via your default system browser (OAuth 2.0 Authorization Code + PKCE). Verified Minecraft: Java Edition entitlements are stored in an encrypted DPAPI / AES-256-GCM local vault with zero plaintext tokens.
        </p>
      </div>
      <span class="badge badge-supported">DPAPI / AES-256-GCM Encrypted Vault</span>
    </div>

    <div class="grid-2" style="margin-bottom:18px">
      <!-- LEFT CARD: COMMERCIAL MICROSOFT SIGN-IN -->
      <div class="card elevated">
        <div class="card-title">
          <span>Sign in with Microsoft</span>
          <span class="badge ${oauthConfigured ? 'badge-healthy' : 'badge-warning'}">
            ${oauthConfigured ? 'PKCE + System Browser Ready' : 'Developer Config Required'}
          </span>
        </div>
        <div class="card-desc">
          Authenticates through Microsoft OAuth 2.0 → Xbox Live → XSTS → Minecraft Services and verifies genuine Minecraft: Java Edition ownership automatically.
        </div>

        ${
          !oauthConfigured
            ? `
          <div id="oauth-dev-config-notice" style="margin-top:14px;padding:14px 16px;border-radius:8px;background:rgba(245,158,11,0.09);border:1px solid rgba(245,158,11,0.4)">
            <div style="font-weight:700;font-size:13px;color:var(--accent-amber-bright)">
              Maintainer / Developer Build Configuration Notice
            </div>
            <div style="font-size:12.5px;color:var(--text-secondary);margin-top:6px;line-height:1.55">
              This local/CI build was compiled without a build-time Microsoft Entra public Client ID.
              End users never enter or register a Client ID in Vespera Client.<br/><br/>
              <strong>For Maintainers:</strong> Set <code>VESPERA_MSA_CLIENT_ID</code> or configure <code>config/oauth.local.json</code> (or <code>config/oauth.release.json</code> for official distribution) as documented in <code>${escapeHtml(
                oauthCfg?.developerSetupDocPath || 'docs/OAUTH_DEVELOPER_SETUP.md'
              )}</code>.
            </div>
          </div>
        `
            : `
          <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:10px">
            <button class="btn btn-primary btn-launch" id="btn-start-pkce-auth" style="padding:11px 20px">
              Sign in with Microsoft
            </button>
            <button class="btn" id="btn-start-device-auth">
              Use Device Code Instead
            </button>
            ${
              flow && (flow.mode === 'pkce_browser' || flow.mode === 'device_code')
                ? `<button class="btn btn-danger" id="btn-cancel-auth-flow">✕ Cancel Sign-In</button>`
                : ''
            }
          </div>
        `
        }

        ${
          flow?.mode === 'pkce_browser'
            ? `
          <div style="margin-top:14px;padding:13px 15px;border-radius:8px;background:var(--bg-canvas);border:1px solid var(--accent-cyan)">
            <div style="font-weight:700;font-size:13px;color:var(--accent-cyan)">
              ⏳ Waiting for Microsoft Sign-In in System Browser…
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:5px">
              ${escapeHtml(flow.message)}
            </div>
            ${
              flow.authorizeUrl
                ? `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
                    <a class="btn btn-sm btn-cyan" href="${escapeHtml(flow.authorizeUrl)}" target="_blank" rel="noreferrer">Open Browser Window</a>
                    <button class="btn btn-sm" id="btn-refresh-pkce-state">Check Completion</button>
                  </div>`
                : ''
            }
          </div>
        `
            : ''
        }

        ${
          activeChallenge
            ? `
          <div style="margin-top:14px;padding:14px 16px;border-radius:8px;background:var(--bg-canvas);border:1px solid var(--accent-amber)">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <span style="font-size:12px;font-weight:700;color:var(--accent-amber-bright)">Device Code Fallback Sign-In</span>
              <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">Expires in ${Math.round(
                (activeChallenge.expiresInSeconds || 900) / 60
              )}m</span>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">
              1. Open <a href="${escapeHtml(activeChallenge.verificationUri)}" target="_blank" rel="noreferrer" style="color:var(--accent-cyan)">${escapeHtml(activeChallenge.verificationUri)}</a> in any browser.<br/>
              2. Enter this verification code:
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin:10px 0">
              <div style="font-size:24px;font-weight:800;font-family:var(--font-mono);letter-spacing:3px;color:var(--accent-amber-bright);padding:6px 12px;border-radius:6px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3)">
                ${escapeHtml(activeChallenge.userCode)}
              </div>
              <button class="btn btn-sm" id="btn-copy-device-code" data-device-code-val="${escapeHtml(activeChallenge.userCode)}">Copy Code</button>
              <a class="btn btn-sm" href="${escapeHtml(activeChallenge.verificationUri)}" target="_blank" rel="noreferrer">Open Browser</a>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
              <button class="btn btn-sm btn-cyan" id="btn-poll-msa-auth">Check Authorization Progress</button>
              <button class="btn btn-sm btn-danger" id="btn-cancel-device-auth">Cancel</button>
            </div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:8px">${escapeHtml(activeChallenge.statusMessage)}</div>
          </div>
        `
            : ''
        }

        ${
          flow && (flow.mode === 'error' || flow.mode === 'completed' || flow.mode === 'cancelled')
            ? `
          <div style="margin-top:12px;padding:10px 12px;border-radius:6px;font-size:12px;background:var(--bg-canvas);border:1px solid ${
            flow.mode === 'completed'
              ? 'rgba(16,185,129,0.4)'
              : flow.mode === 'error'
                ? 'rgba(239,68,68,0.4)'
                : 'var(--border-subtle)'
          };color:${flow.mode === 'completed' ? '#34d399' : flow.mode === 'error' ? '#fca5a5' : 'var(--text-secondary)'}">
            ${escapeHtml(flow.message)}
          </div>
        `
            : ''
        }
      </div>

      <!-- RIGHT CARD: AUTHENTICATED ACCOUNTS -->
      <div class="card">
        <div class="card-title">
          <span>Verified Minecraft Accounts (${snap.accounts.length})</span>
          <span style="font-size:11.5px;color:var(--text-muted)">Multi-Account Vault</span>
        </div>
        <div class="card-desc">Switch active profile account, silently refresh tokens, sign out, or permanently remove an account from this PC.</div>

        <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px">
          ${
            snap.accounts.length === 0
              ? `<div style="padding:18px;background:var(--bg-canvas);border:1px dashed var(--border-strong);border-radius:8px;color:var(--text-secondary);font-size:12.5px;line-height:1.55">
                  No Microsoft / Minecraft account signed in on this device yet.<br/><br/>
                  Click <strong>Sign in with Microsoft</strong> on the left to authenticate your Minecraft: Java Edition account in your system browser.
                </div>`
              : snap.accounts
                  .map((acc) => {
                    const cleanUuid = acc.uuid.replace(/-/g, '');
                    const avatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanUuid)}/44`;
                    const statusBadge =
                      acc.sessionStatus === 'valid'
                        ? `<span class="badge badge-supported">Active Session</span>`
                        : acc.sessionStatus === 'refresh_required'
                          ? `<span class="badge badge-experimental">Refresh Ready</span>`
                          : acc.sessionStatus === 'signed_out'
                            ? `<span class="badge badge-legacy">Signed Out</span>`
                            : `<span class="badge badge-warning">Expired</span>`;
                    return `
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;background:var(--bg-canvas);border:1px solid ${
                    acc.active ? 'var(--accent-amber)' : 'var(--border-subtle)'
                  };border-radius:8px">
                    <div style="display:flex;align-items:center;gap:12px">
                      <img
                        src="${avatarUrl}"
                        alt="${escapeHtml(acc.username)}"
                        width="42"
                        height="42"
                        style="border-radius:6px;image-rendering:pixelated;border:1px solid var(--border-strong);background:#1e293b"
                        onerror="this.style.display='none'"
                      />
                      <div>
                        <div style="font-weight:700;font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                          <span>${escapeHtml(acc.username)}</span>
                          ${statusBadge}
                          ${acc.ownsMinecraftJava ? `<span class="badge badge-healthy">Java Edition Verified</span>` : ''}
                        </div>
                        <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-top:2px">
                          UUID: ${escapeHtml(acc.uuid)} · Last Verified: ${escapeHtml(formatTimestampShort(acc.lastValidatedAt))}
                        </div>
                      </div>
                    </div>

                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                      ${
                        !acc.active
                          ? `<button class="btn btn-sm btn-primary" data-switch-account="${escapeHtml(acc.id)}">Switch Active</button>`
                          : `<span class="badge badge-supported">SELECTED</span>`
                      }
                      ${
                        acc.sessionStatus !== 'signed_out'
                          ? `<button class="btn btn-sm" data-refresh-account="${escapeHtml(acc.id)}">Refresh</button>
                             <button class="btn btn-sm" data-signout-account="${escapeHtml(acc.id)}">Sign Out</button>`
                          : ''
                      }
                      <button class="btn btn-sm btn-danger" data-remove-account="${escapeHtml(acc.id)}">Remove</button>
                    </div>
                  </div>
                `;
                  })
                  .join('')
          }
        </div>
      </div>
    </div>

    <!-- DEDICATED PART 2 SECTION: LEGITIMATE OFFLINE AVAILABILITY -->
    <div class="card" id="offline-availability-section">
      <div class="card-title">
        <span>Offline Availability (Legitimate Local Singleplayer)</span>
        <span class="badge ${offline?.eligible ? 'badge-supported' : 'badge-legacy'}">
          ${
            offline?.activeSessionMode === 'offline_singleplayer'
              ? 'Offline Singleplayer Active'
              : offline?.eligible
                ? 'Offline Singleplayer Ready'
                : 'Online Verification Required First'
          }
        </span>
      </div>
      <div class="card-desc">
        Allows launching local singleplayer worlds when your internet connection is unavailable — strictly for an account that previously completed official Microsoft authentication and Minecraft: Java Edition entitlement verification on this device.
      </div>

      <div class="grid-2" style="margin-top:14px">
        <div style="padding:12px 14px;border-radius:8px;background:var(--bg-canvas);border:1px solid var(--border-subtle);font-size:12.5px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Verified Local Account:</span>
            <strong>${
              offline?.verifiedUsername
                ? `${escapeHtml(offline.verifiedUsername)} (${escapeHtml((offline.verifiedUuid || '').slice(0, 8))}…)`
                : 'None Verified Yet'
            }</strong>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Last Successful Online Auth:</span>
            <span style="font-family:var(--font-mono)">${escapeHtml(formatTimestampShort(offline?.lastOnlineAuthAt))}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-secondary)">Local Game Files (${escapeHtml(activeProfile.mcVersion)}):</span>
            <span style="color:${offline?.localGameReady ? '#34d399' : '#fbbf24'};font-weight:700">
              ${offline?.localGameReady ? '✓ Installed & Hash-Verified' : '○ Install While Online First'}
            </span>
          </div>
          <div style="margin-top:4px;font-size:12px;color:var(--text-muted)">
            ${escapeHtml(offline?.statusReason || '')}
          </div>
        </div>

        <div style="padding:12px 14px;border-radius:8px;background:var(--bg-canvas);border:1px solid var(--border-subtle);font-size:12px;display:flex;flex-direction:column;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:700;color:var(--text-primary);margin-bottom:6px">Enforced Offline Mode Restrictions</div>
            ${(
              offline?.restrictions || [
                'Singleplayer and local worlds only (--disableMultiplayer enforced).',
                'Multiplayer server connections are disabled while offline.',
                'Identity locked to your previously Microsoft-verified account.',
              ]
            )
              .map((r) => `<div style="color:var(--text-secondary);margin-bottom:3px">• ${escapeHtml(r)}</div>`)
              .join('')}
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button
              class="btn btn-primary"
              id="btn-launch-offline-sp"
              ${offline?.eligible ? '' : 'disabled'}
            >
              ▶ Launch Offline Singleplayer (${escapeHtml(activeProfile.mcVersion)})
            </button>
            ${
              offline?.activeSessionMode === 'offline_singleplayer'
                ? `<button class="btn btn-cyan" id="btn-restore-online-session">↻ Restore Online Session</button>`
                : ''
            }
          </div>
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
            <div class="form-label">Custom Global Java Executable Path (Advanced Override)</div>
            <div class="form-hint">Optional path to a custom <code>java</code> / <code>javaw.exe</code> binary. Leave blank to let Vespera automatically match Java 8, 17, or 21 per Minecraft version.</div>
            <input
              type="text"
              class="input"
              id="set-custom-java-exe"
              value="${escapeHtml(s.customJavaExecutablePath || '')}"
              placeholder="Auto-managed per version (Java 8 / 17 / 21)"
              style="width:100%;margin-top:6px;font-family:var(--font-mono)"
            />
          </div>
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
          Vespera separates its lightweight native Windows desktop launcher (<code>VesperaClient.exe</code>, Win32 + Edge WebView2 + WinHTTP + WinSock2 PKCE + DPAPI + CNG BCrypt) from its decoupled client-side Fabric integration mod (<code>vespera-client-1.1.0+mc1.21.4.jar</code>), keeping launcher RAM overhead minimal and background CPU utilization at 0.0% during gameplay.
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
    onStartPkceAuth: () => void;
    onStartDeviceAuth: () => void;
    onPollMsaAuth: () => void;
    onCancelAuthFlow: () => void;
    onRefreshPkceState: () => void;
    onCopyDeviceCode: (code: string) => void;
    onRefreshAccount: (id: string) => void;
    onSwitchAccount: (id: string) => void;
    onSignOutAccount: (id: string) => void;
    onRemoveAccount: (id: string) => void;
    onLaunchOfflineSingleplayer: () => void;
    onRestoreOnlineSession: () => void;
    onUpdateSettings: (patch: Partial<LauncherSettings>) => void;
    onUpdateGraphics: (patch: Partial<GraphicsSettings>) => void;
    onRunBenchmarks: () => void;
    onApplyAutoFix: (actionId: string) => void;
  }
): void {
  stage.querySelector('#btn-start-pkce-auth')?.addEventListener('click', callbacks.onStartPkceAuth);
  stage.querySelector('#btn-start-device-auth')?.addEventListener('click', callbacks.onStartDeviceAuth);
  stage.querySelector('#btn-poll-msa-auth')?.addEventListener('click', callbacks.onPollMsaAuth);
  stage.querySelector('#btn-cancel-auth-flow')?.addEventListener('click', callbacks.onCancelAuthFlow);
  stage.querySelector('#btn-cancel-device-auth')?.addEventListener('click', callbacks.onCancelAuthFlow);
  stage.querySelector('#btn-refresh-pkce-state')?.addEventListener('click', callbacks.onRefreshPkceState);

  stage.querySelector('#btn-copy-device-code')?.addEventListener('click', (ev) => {
    const code = (ev.currentTarget as HTMLElement).getAttribute('data-device-code-val') || '';
    if (code) callbacks.onCopyDeviceCode(code);
  });

  stage.querySelectorAll<HTMLElement>('[data-switch-account]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.switchAccount;
      if (id) callbacks.onSwitchAccount(id);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-refresh-account]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.refreshAccount;
      if (id) callbacks.onRefreshAccount(id);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-signout-account]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.signoutAccount;
      if (id) callbacks.onSignOutAccount(id);
    });
  });

  stage.querySelectorAll<HTMLElement>('[data-remove-account]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.removeAccount;
      if (id) callbacks.onRemoveAccount(id);
    });
  });

  stage
    .querySelector('#btn-launch-offline-sp')
    ?.addEventListener('click', callbacks.onLaunchOfflineSingleplayer);
  stage
    .querySelector('#btn-restore-online-session')
    ?.addEventListener('click', callbacks.onRestoreOnlineSession);

  // Settings controls
  stage.querySelector('#set-custom-java-exe')?.addEventListener('change', (ev) => {
    callbacks.onUpdateSettings({
      customJavaExecutablePath: (ev.target as HTMLInputElement).value.trim(),
    });
  });
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
