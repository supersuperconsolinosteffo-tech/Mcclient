import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeDiagnosticsPayload,
  SnapshotValidationError,
  validateAndNormalizeSnapshot,
} from '../shared/snapshotValidator';
import type { AppStateSnapshot, DiagnosticFinding } from '../shared/types';
import { VesperaStateCoordinator } from '../server/stateStore';
import { bridge } from '../ui/src/bridge';
import {
  renderAboutPage,
  renderAccountsPage,
  renderDiagnosticsPage,
  renderSettingsPage,
} from '../ui/src/pages/accountsSettingsDiagAbout';
import { renderHomePage, renderPlayPage } from '../ui/src/pages/homeAndPlay';
import { renderModsPage, renderProfilesPage } from '../ui/src/pages/modsAndProfiles';
import {
  renderGraphicsPage,
  renderPerformancePage,
  renderResourcePacksPage,
  renderShaderPacksPage,
} from '../ui/src/pages/perfAndGraphics';

const tempDirs: string[] = [];
function createBaseSnapshot(): AppStateSnapshot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vespera-diag-reg-'));
  tempDirs.push(dir);
  const coord = new VesperaStateCoordinator(dir);
  const snap = coord.getSnapshot();
  coord.shutdownCleanly();
  return snap;
}

function renderAllTwelvePages(snap: AppStateSnapshot): string[] {
  return [
    renderHomePage(snap),
    renderPlayPage(snap, null),
    renderModsPage(snap, 'discover', '', 'all', null, 'fps'),
    renderModsPage(snap, 'installed', '', 'all', null, 'fps'),
    renderModsPage(snap, 'hud_editor', '', 'all', null, 'fps'),
    renderProfilesPage(snap, ''),
    renderPerformancePage(snap),
    renderGraphicsPage(snap),
    renderShaderPacksPage(snap),
    renderResourcePacksPage(snap),
    renderAccountsPage(snap, null),
    renderSettingsPage(snap),
    renderDiagnosticsPage(snap, false),
    renderAboutPage(snap),
  ];
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Diagnostics Contract & Startup Failure Regression Suite', () => {
  it('1. preserves a valid DiagnosticFinding[] array and renders Home + Diagnostics cleanly', () => {
    const base = createBaseSnapshot();
    const validFindings: DiagnosticFinding[] = [
      {
        id: 'diag-ram-warn',
        severity: 'warning',
        category: 'memory',
        title: 'Heap Allocation High',
        explanation: 'Allocated 7168 MB on an 8192 MB host.',
        recommendation: 'Reduce heap to 3584 MB.',
        autoFixActionId: 'fix_ram_allocation',
      },
      {
        id: 'diag-java-ok',
        severity: 'healthy',
        category: 'java_runtime',
        title: 'Java 21 Verified',
        explanation: 'Temurin 21 LTS installed.',
        recommendation: 'None required.',
      },
    ];

    const normalized = validateAndNormalizeSnapshot({ ...base, diagnostics: validFindings });
    expect(normalized.diagnostics).toEqual(validFindings);

    const homeHtml = renderHomePage(normalized);
    expect(homeHtml).toContain('1 Advisory');

    const diagHtml = renderDiagnosticsPage(normalized, false);
    expect(diagHtml).toContain('Heap Allocation High');
    expect(diagHtml).toContain('data-autofix-id="fix_ram_allocation"');
  });

  it('2. handles an empty diagnostics array ([]) without crashing any of the 12 pages', () => {
    const base = createBaseSnapshot();
    const normalized = validateAndNormalizeSnapshot({ ...base, diagnostics: [] });
    expect(normalized.diagnostics).toEqual([]);

    const homeHtml = renderHomePage(normalized);
    expect(homeHtml).toContain('Verified Clean');

    const diagHtml = renderDiagnosticsPage(normalized, false);
    expect(diagHtml).toContain('Diagnostic findings are currently empty');

    expect(() => renderAllTwelvePages(normalized)).not.toThrow();
  });

  it('3. handles null diagnostics safely without blocking startup or crashing UI pages', () => {
    const base = createBaseSnapshot();
    const normalized = validateAndNormalizeSnapshot({ ...base, diagnostics: null });
    expect(Array.isArray(normalized.diagnostics)).toBe(true);
    expect(normalized.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(normalized.diagnostics[0].id).toBe('diag-subsystem-degraded');
    expect(() => renderAllTwelvePages(normalized)).not.toThrow();
  });

  it('4. handles undefined diagnostics safely without blocking startup or crashing UI pages', () => {
    const base = createBaseSnapshot() as unknown as Record<string, unknown>;
    delete base.diagnostics;

    const normalized = validateAndNormalizeSnapshot(base);
    expect(Array.isArray(normalized.diagnostics)).toBe(true);
    expect(normalized.diagnostics[0].id).toBe('diag-subsystem-degraded');
    expect(() => renderAllTwelvePages(normalized)).not.toThrow();
  });

  it('5. reproduces & fixes the exact C++ object-wrapped diagnostics payload ({ generatedAt, overallHealth, findings }) that caused "e.diagnostics.filter is not a function"', async () => {
    const base = createBaseSnapshot();

    // Exact payload shape previously produced by VesperaNativeEngine::refreshTelemetry()
    const legacyCppPayload = {
      ...base,
      platformMode: 'windows_native_webview2',
      diagnostics: {
        generatedAt: '2026-11-25T23:20:00Z',
        overallHealth: 'attention_needed',
        findings: [
          {
            id: 'diag-ram-high',
            severity: 'warning',
            category: 'memory',
            title: 'Allocated JVM Heap Leaves Low OS Headroom',
            explanation: 'Allocating 7168 MB on a 8192 MB Windows system can starve GPU driver shader caches.',
            recommendation: 'Click Auto-Fix to apply hardware-optimal 3584 MB heap.',
            autoFixable: true,
            autoFixActionId: 'fix_ram_allocation',
          },
          {
            id: 'diag-java-ondemand',
            severity: 'info',
            category: 'java_runtime',
            title: 'Adoptium Temurin Java 21 LTS Ready for Auto-Provisioning',
            explanation: 'Vespera will automatically download and SHA-256 verify Eclipse Temurin OpenJDK 21 LTS.',
            recommendation: 'Zero manual Java installation required.',
            autoFixable: false,
            autoFixActionId: null,
          },
        ],
        analyzedLogLines: 12,
      },
    };

    // Confirm raw un-normalized object indeed lacks .filter (reproducing the original bug condition)
    expect(typeof (legacyCppPayload.diagnostics as unknown as { filter?: unknown }).filter).toBe(
      'undefined'
    );

    // Confirm bridge.getSnapshot() normalizes the payload cleanly without losing any valid findings
    (globalThis as Record<string, unknown>).window = {
      vesperaNativeInvoke: async () => ({ ok: true, data: legacyCppPayload }),
    };

    const snap = await bridge.getSnapshot();
    expect(Array.isArray(snap.diagnostics)).toBe(true);
    expect(snap.diagnostics).toHaveLength(2);
    expect(snap.diagnostics[0].id).toBe('diag-ram-high');
    expect(snap.diagnostics[0].autoFixActionId).toBe('fix_ram_allocation');
    expect(snap.diagnostics[1].id).toBe('diag-java-ondemand');
    expect(snap.diagnostics[1].autoFixActionId).toBeUndefined();

    // Verify all 12 launcher pages render cleanly with zero exceptions
    const pages = renderAllTwelvePages(snap);
    expect(pages[0]).toContain('1 Advisory');
    expect(pages[12]).toContain('Allocated JVM Heap Leaves Low OS Headroom');
  });

  it('6. safely handles malformed diagnostics (primitives, empty objects, mixed invalid array items) while preserving valid entries', () => {
    const strRes = normalizeDiagnosticsPayload('corrupted-diagnostics-string');
    expect(strRes.findings).toEqual([]);
    expect(strRes.degradedReason).toContain('string');

    const objNoFindings = normalizeDiagnosticsPayload({ unexpected: 123 });
    expect(objNoFindings.findings).toEqual([]);
    expect(objNoFindings.degradedReason).toContain('unrecognized object');

    const mixed = normalizeDiagnosticsPayload([
      null,
      42,
      {},
      {
        id: 'valid-1',
        severity: 'critical',
        category: 'mod_conflict',
        title: 'OptiFabric Conflict',
        explanation: 'Incompatible with Sodium.',
        recommendation: 'Remove OptiFabric.',
      },
    ]);
    expect(mixed.findings).toHaveLength(1);
    expect(mixed.findings[0].id).toBe('valid-1');
    expect(mixed.degradedReason).toContain('Ignored 3 malformed');

    expect(() => validateAndNormalizeSnapshot(null)).toThrow(SnapshotValidationError);
  });

  it('7. transitions out of "Initializing Vespera Client Engine…" to a structured recovery view on backend failure, then reaches the main dashboard on retry', async () => {
    // Minimal DOM environment for ui/src/main.ts bootstrap()
    const clickHandlers = new Map<string, () => void>();
    const appDiv = {
      innerHTML: '',
      querySelector: (sel: string) => {
        if (sel === '#btn-retry-bootstrap') {
          return {
            addEventListener: (_ev: string, fn: () => void) => clickHandlers.set(sel, fn),
          };
        }
        return null;
      },
      querySelectorAll: () => [],
    };
    const toastStack = {
      id: 'toast-stack',
      className: '',
      appendChild: () => {},
    };
    (globalThis as Record<string, unknown>).document = {
      getElementById: (id: string) => {
        if (id === 'app') return appDiv;
        if (id === 'toast-stack') return toastStack;
        return null;
      },
      createElement: () => ({ className: '', textContent: '', remove: () => {} }),
      body: { appendChild: () => {} },
    };

    // Attempt 1: Backend fails during initialization
    (globalThis as Record<string, unknown>).window = {
      location: { protocol: 'https:' },
      vesperaNativeInvoke: async () => ({
        ok: false,
        error: 'Simulated DPAPI storage locked',
      }),
    };

    const { bootstrap } = await import('../ui/src/main');
    await bootstrap();

    // Must NOT remain stuck on "Initializing Vespera Client Engine…"
    expect(appDiv.innerHTML).not.toContain('Initializing Vespera Client Engine');
    expect(appDiv.innerHTML).toContain('Vespera Client Engine Initialization Error');
    expect(appDiv.innerHTML).toContain('Simulated DPAPI storage locked');
    expect(appDiv.innerHTML).toContain('btn-retry-bootstrap');

    // Attempt 2: Backend recovers (even with degraded/null optional subsystems) -> main dashboard renders!
    const validSnap = createBaseSnapshot();
    (globalThis as Record<string, unknown>).window = {
      location: { protocol: 'https:' },
      vesperaNativeInvoke: async () => ({
        ok: true,
        data: { ...validSnap, diagnostics: null, latestBenchmark: 'malformed' },
      }),
    };

    await bootstrap();
    expect(appDiv.innerHTML).toContain('VESPERA');
    expect(appDiv.innerHTML).toContain('Zero Visual Compromise');
    expect(appDiv.innerHTML).toContain('PLAY 1.21.4');
  });
});
