import type {
  AppStateSnapshot,
  AuthProgressStep,
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

const MICROSOFT_EMBLEM_SVG = `<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true" style="flex-shrink:0"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>`;

const AUTH_PROGRESS_STEPS: Array<{ id: AuthProgressStep; label: string }> = [
  { id: 'opening_browser', label: 'Opening Microsoft login...' },
  { id: 'waiting_for_login', label: 'Waiting for authentication...' },
  { id: 'verifying_microsoft', label: 'Verifying Microsoft account...' },
  { id: 'connecting_xbox', label: 'Connecting to Xbox services...' },
  { id: 'checking_ownership', label: 'Checking Minecraft ownership...' },
  { id: 'retrieving_profile', label: 'Retrieving Minecraft profile...' },
];

export function renderAccountsPage(
  snap: AppStateSnapshot,
  authChallenge: DeviceCodeAuthChallenge | null
): string {
  const flow = snap.authFlow;
  const activeChallenge = authChallenge || flow?.deviceChallenge || null;
  const offline = snap.offlineAvailability;
  const activeProfile =
    snap.profiles.find((p) => p.id === snap.activeProfileId) ?? snap.profiles[0];

  const isAuthenticating = flow?.mode === 'pkce_browser';
  const currentStepIdx = isAuthenticating
    ? Math.max(
        0,
        AUTH_PROGRESS_STEPS.findIndex((s) => s.id === (flow?.step || 'waiting_for_login'))
      )
    : -1;

  const errorBannerHtml =
    flow?.mode === 'error'
      ? `
      <div id="auth-error-banner" style="margin-bottom:18px;padding:15px 18px;border-radius:10px;background:rgba(239,68,68,0.09);border:1px solid rgba(239,68,68,0.38);display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <div style="font-weight:700;font-size:13.5px;color:#fca5a5">
              ${escapeHtml(flow.userTitle || 'Could not complete Microsoft sign-in')}
            </div>
            <div style="font-size:12.5px;color:var(--text-secondary);margin-top:4px;line-height:1.55">
              ${escapeHtml(flow.message)}
            </div>
          </div>
          <button class="btn btn-sm" id="btn-dismiss-auth-error">Dismiss</button>
        </div>
        ${
          flow.technicalDetail
            ? `<details style="font-size:11.5px;color:var(--text-muted);margin-top:2px">
                <summary style="cursor:pointer;user-select:none">View developer diagnostics</summary>
                <div style="margin-top:6px;padding:8px 10px;border-radius:6px;background:var(--bg-canvas);font-family:var(--font-mono);color:var(--text-secondary)">
                  ${escapeHtml(flow.technicalDetail)}
                </div>
              </details>`
            : ''
        }
      </div>
    `
      : '';

  const progressCardHtml = isAuthenticating
    ? `
      <div class="card elevated" id="auth-progress-panel" style="margin-bottom:18px;padding:24px 26px;border:1px solid rgba(245,158,11,0.4)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:12px">
            ${MICROSOFT_EMBLEM_SVG}
            <div>
              <div style="font-size:16px;font-weight:700;color:var(--text-primary)">Signing in with Microsoft</div>
              <div style="font-size:12.5px;color:var(--text-secondary);margin-top:2px">
                Complete login in your default web browser. Vespera will finish setup automatically.
              </div>
            </div>
          </div>
          <button class="btn btn-danger" id="btn-cancel-auth-flow">Cancel</button>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin-top:18px">
          ${AUTH_PROGRESS_STEPS.map((s, idx) => {
            const done = idx < currentStepIdx;
            const active = idx === currentStepIdx;
            const borderCol = active
              ? 'var(--accent-amber)'
              : done
                ? 'rgba(16,185,129,0.4)'
                : 'var(--border-subtle)';
            const textCol = active
              ? 'var(--accent-amber-bright)'
              : done
                ? '#34d399'
                : 'var(--text-muted)';
            const marker = done ? '✓' : active ? '●' : '○';
            return `
              <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;background:var(--bg-canvas);border:1px solid ${borderCol}">
                <span style="font-weight:800;font-size:13px;color:${textCol}">${marker}</span>
                <span style="font-size:12.5px;font-weight:${active ? '700' : '500'};color:${
                  active ? 'var(--text-primary)' : done ? 'var(--text-secondary)' : 'var(--text-muted)'
                }">${escapeHtml(s.label)}</span>
              </div>
            `;
          }).join('')}
        </div>

        ${
          flow?.authorizeUrl
            ? `<div style="margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--text-muted)">
                <span>Didn't see the Microsoft sign-in tab?</span>
                <div style="display:flex;gap:8px">
                  <a class="btn btn-sm" href="${escapeHtml(flow.authorizeUrl)}" target="_blank" rel="noreferrer">Open Microsoft Login</a>
                  <button class="btn btn-sm" id="btn-refresh-pkce-state">Refresh Status</button>
                </div>
              </div>`
            : ''
        }
      </div>
    `
    : '';

  const deviceFallbackHtml = activeChallenge
    ? `
      <div class="card" style="margin-bottom:18px;border:1px solid var(--accent-amber)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span style="font-size:13px;font-weight:700;color:var(--accent-amber-bright)">Browser Verification Code Sign-In</span>
          <button class="btn btn-sm btn-danger" id="btn-cancel-device-auth">Cancel</button>
        </div>
        <div style="font-size:12.5px;color:var(--text-secondary);margin-top:8px">
          Open <a href="${escapeHtml(activeChallenge.verificationUri)}" target="_blank" rel="noreferrer" style="color:var(--accent-cyan)">${escapeHtml(activeChallenge.verificationUri)}</a> and enter:
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin:12px 0">
          <div style="font-size:22px;font-weight:800;font-family:var(--font-mono);letter-spacing:3px;color:var(--accent-amber-bright);padding:6px 14px;border-radius:6px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3)">
            ${escapeHtml(activeChallenge.userCode)}
          </div>
          <button class="btn btn-sm" id="btn-copy-device-code" data-device-code-val="${escapeHtml(activeChallenge.userCode)}">Copy Code</button>
          <button class="btn btn-sm btn-cyan" id="btn-poll-msa-auth">Check Status</button>
        </div>
      </div>
    `
    : '';

  const emptyStateConnectHero =
    snap.accounts.length === 0 && !isAuthenticating && !activeChallenge
      ? `
      <div class="card elevated" id="connect-account-hero" style="margin-bottom:18px;padding:38px 28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px">
        <div style="width:52px;height:52px;border-radius:14px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.32);display:grid;place-items:center">
          ${MICROSOFT_EMBLEM_SVG}
        </div>
        <div style="max-width:480px">
          <h3 style="font-size:21px;font-weight:800;margin:0;color:var(--text-primary)">
            Connect your Minecraft account
          </h3>
          <p style="font-size:13.5px;color:var(--text-secondary);margin:8px 0 0;line-height:1.55">
            Sign in using your official Microsoft account to access Minecraft Java Edition.
          </p>
        </div>

        <button
          class="btn btn-primary btn-launch"
          id="btn-start-pkce-auth"
          style="margin-top:6px;padding:13px 28px;font-size:14.5px;display:inline-flex;align-items:center;gap:11px;border-radius:9px"
        >
          ${MICROSOFT_EMBLEM_SVG}
          <span>Sign in with Microsoft</span>
        </button>

        <p style="max-width:460px;font-size:12px;color:var(--text-muted);margin:2px 0 0;line-height:1.5">
          Your credentials are handled directly by Microsoft. Vespera never asks for or stores your Microsoft password.
        </p>
      </div>
    `
      : '';

  const connectedAccountsSection =
    snap.accounts.length > 0
      ? `
      <div class="card elevated" style="margin-bottom:18px">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <span>Minecraft Accounts (${snap.accounts.length})</span>
            <div style="font-size:12px;font-weight:400;color:var(--text-secondary);margin-top:3px">
              Switch between verified accounts, refresh sessions, sign out, or remove an account from this PC.
            </div>
          </div>
          ${
            !isAuthenticating
              ? `<button class="btn btn-primary" id="btn-start-pkce-auth" style="display:inline-flex;align-items:center;gap:8px">
                  ${MICROSOFT_EMBLEM_SVG}
                  <span>Sign in with Microsoft</span>
                </button>`
              : ''
          }
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
          ${snap.accounts
            .map((acc) => {
              const cleanUuid = acc.uuid.replace(/-/g, '');
              const avatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanUuid)}/48`;
              const statusBadge =
                acc.sessionStatus === 'valid'
                  ? `<span class="badge badge-supported">Active Session</span>`
                  : acc.sessionStatus === 'refresh_required'
                    ? `<span class="badge badge-experimental">Refresh Ready</span>`
                    : acc.sessionStatus === 'signed_out'
                      ? `<span class="badge badge-legacy">Signed Out</span>`
                      : `<span class="badge badge-warning">Session Expired</span>`;
              return `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 16px;background:var(--bg-canvas);border:1px solid ${
                  acc.active ? 'var(--accent-amber)' : 'var(--border-subtle)'
                };border-radius:10px">
                  <div style="display:flex;align-items:center;gap:13px">
                    <img
                      src="${avatarUrl}"
                      alt="${escapeHtml(acc.username)}"
                      width="46"
                      height="46"
                      style="border-radius:8px;image-rendering:pixelated;border:1px solid var(--border-strong);background:#1e293b"
                      onerror="this.style.display='none'"
                    />
                    <div>
                      <div style="font-weight:700;font-size:15px;display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                        <span>${escapeHtml(acc.username)}</span>
                        ${statusBadge}
                        ${acc.ownsMinecraftJava ? `<span class="badge badge-healthy">Java Edition</span>` : ''}
                      </div>
                      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-top:3px">
                        UUID: ${escapeHtml(acc.uuid)} · Verified: ${escapeHtml(formatTimestampShort(acc.lastValidatedAt))}
                      </div>
                    </div>
                  </div>

                  <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
                    ${
                      !acc.active
                        ? `<button class="btn btn-sm btn-primary" data-switch-account="${escapeHtml(acc.id)}">Switch Active</button>`
                        : `<span class="badge badge-supported">ACTIVE</span>`
                    }
                    ${
                      acc.sessionStatus !== 'signed_out'
                        ? `<button class="btn btn-sm" data-refresh-account="${escapeHtml(acc.id)}">Refresh</button>
                           <button class="btn btn-sm" data-signout-account="${escapeHtml(acc.id)}">Sign Out</button>`
                        : `<button class="btn btn-sm btn-primary" data-reconnect-account="${escapeHtml(acc.id)}">Sign In Again</button>`
                    }
                    <button class="btn btn-sm btn-danger" data-remove-account="${escapeHtml(acc.id)}">Remove</button>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `
      : '';

  return `
    <div class="page-header">
      <div>
        <h2 class="page-title">Accounts</h2>
        <p class="page-subtitle">
          Sign in with your Microsoft account to play Minecraft: Java Edition online and manage your connected player profiles.
        </p>
      </div>
      <span class="badge badge-supported">Encrypted Account Vault</span>
    </div>

    ${errorBannerHtml}
    ${progressCardHtml}
    ${deviceFallbackHtml}
    ${emptyStateConnectHero}
    ${connectedAccountsSection}

    <!-- LEGITIMATE OFFLINE SINGLEPLAYER SECTION -->
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
          Vespera separates its lightweight native Windows desktop launcher (<code>VesperaClient.exe</code>, Win32 + Edge WebView2 + WinHTTP + WinSock2 PKCE + DPAPI + CNG BCrypt) from its decoupled client-side Fabric integration mod (<code>vespera-client-1.1.1+mc1.21.4.jar</code>), keeping launcher RAM overhead minimal and background CPU utilization at 0.0% during gameplay.
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
  stage.querySelectorAll<HTMLElement>('[data-reconnect-account]').forEach((btn) => {
    btn.addEventListener('click', () => callbacks.onStartPkceAuth());
  });
  stage.querySelector('#btn-start-device-auth')?.addEventListener('click', callbacks.onStartDeviceAuth);
  stage.querySelector('#btn-poll-msa-auth')?.addEventListener('click', callbacks.onPollMsaAuth);
  stage.querySelector('#btn-cancel-auth-flow')?.addEventListener('click', callbacks.onCancelAuthFlow);
  stage.querySelector('#btn-cancel-device-auth')?.addEventListener('click', callbacks.onCancelAuthFlow);
  stage.querySelector('#btn-dismiss-auth-error')?.addEventListener('click', callbacks.onCancelAuthFlow);
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
