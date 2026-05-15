import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Direct sqlite tests for monitorConfigStore. Boundary focus:
 *   - defaultIntervalMinutes clamping (below min, at min, in range, at max, above max)
 *   - alertConfirmFailThreshold clamping against alertConfirmCount
 *   - healthThresholds default merge
 *   - getConfig fallback when row missing / JSON corrupted
 *   - target add/remove/setTargets preservation of last_alert_at
 *   - schema migrations (PRAGMA-driven ALTER TABLE)
 *
 * The module-level singleton `monitorConfigStore = new MonitorConfigStore()` calls `getDb()`
 * at import time, so each test creates a fresh in-memory DB, points the mock at it,
 * and re-imports the module to get a clean store.
 */

const h = vi.hoisted(() => ({ db: null as Database.Database | null }));

vi.mock('./database', () => ({
  getDb: () => h.db!,
}));

let mod: typeof import('./monitorConfigStore');

async function freshStore() {
  h.db = new Database(':memory:');
  vi.resetModules();
  mod = await import('./monitorConfigStore');
  return mod.monitorConfigStore;
}

beforeEach(async () => {
  await freshStore();
});

describe('monitorConfigStore.getConfig — defaults & fallbacks', () => {
  it('returns DEFAULT_CONFIG when no global row exists', () => {
    const cfg = mod.monitorConfigStore.getConfig();
    expect(cfg.defaultIntervalMinutes).toBe(10);
    expect(cfg.alertConfirmCount).toBe(5);
    expect(cfg.alertConfirmFailThreshold).toBe(4); // N-1 default
    expect(cfg.alertReminderMinutes).toBe(360);
    expect(cfg.alertLanguage).toBe('en');
    expect(cfg.healthThresholds.tpsSlowThreshold).toBe(20);
  });

  it('falls back to DEFAULT_CONFIG when stored JSON is corrupted', () => {
    h.db!.prepare("INSERT INTO monitor_config (key, value) VALUES ('global', ?)").run('{not valid json');
    const cfg = mod.monitorConfigStore.getConfig();
    expect(cfg.defaultIntervalMinutes).toBe(10);
    expect(cfg.alertConfirmCount).toBe(5);
  });

  it('merges partial stored healthThresholds with defaults (preserves unspecified fields)', () => {
    mod.monitorConfigStore.setConfig({
      defaultIntervalMinutes: 10,
      healthThresholds: { tpsSlowThreshold: 99, tpsVerySlowThreshold: 3, ttftSlowMs: 500, minOutputTokens: 1 },
    });
    // Manually corrupt to only have one threshold field
    h.db!.prepare("UPDATE monitor_config SET value = ? WHERE key='global'").run(
      JSON.stringify({ defaultIntervalMinutes: 10, healthThresholds: { tpsSlowThreshold: 99 } }),
    );
    const cfg = mod.monitorConfigStore.getConfig();
    expect(cfg.healthThresholds.tpsSlowThreshold).toBe(99);
    // Missing fields fall back to defaults
    expect(cfg.healthThresholds.tpsVerySlowThreshold).toBe(5);
    expect(cfg.healthThresholds.ttftSlowMs).toBe(1000);
    expect(cfg.healthThresholds.minOutputTokens).toBe(1);
  });
});

describe('monitorConfigStore.setConfig — defaultIntervalMinutes clamping', () => {
  const baseHt = { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 };

  it('clamps below-min interval (1) up to 5', () => {
    mod.monitorConfigStore.setConfig({ defaultIntervalMinutes: 1, healthThresholds: baseHt });
    expect(mod.monitorConfigStore.getConfig().defaultIntervalMinutes).toBe(5);
  });

  it('exactly at min (5) is preserved', () => {
    mod.monitorConfigStore.setConfig({ defaultIntervalMinutes: 5, healthThresholds: baseHt });
    expect(mod.monitorConfigStore.getConfig().defaultIntervalMinutes).toBe(5);
  });

  it('mid-range (30) is preserved', () => {
    mod.monitorConfigStore.setConfig({ defaultIntervalMinutes: 30, healthThresholds: baseHt });
    expect(mod.monitorConfigStore.getConfig().defaultIntervalMinutes).toBe(30);
  });

  it('exactly at max (360) is preserved', () => {
    mod.monitorConfigStore.setConfig({ defaultIntervalMinutes: 360, healthThresholds: baseHt });
    expect(mod.monitorConfigStore.getConfig().defaultIntervalMinutes).toBe(360);
  });

  it('clamps above-max interval (1000) down to 360', () => {
    mod.monitorConfigStore.setConfig({ defaultIntervalMinutes: 1000, healthThresholds: baseHt });
    expect(mod.monitorConfigStore.getConfig().defaultIntervalMinutes).toBe(360);
  });

  it('zero/negative is clamped up to 5', () => {
    mod.monitorConfigStore.setConfig({ defaultIntervalMinutes: 0, healthThresholds: baseHt });
    expect(mod.monitorConfigStore.getConfig().defaultIntervalMinutes).toBe(5);
    mod.monitorConfigStore.setConfig({ defaultIntervalMinutes: -100, healthThresholds: baseHt });
    expect(mod.monitorConfigStore.getConfig().defaultIntervalMinutes).toBe(5);
  });
});

describe('monitorConfigStore.setConfig — failThreshold clamping against confirmCount', () => {
  const base = {
    defaultIntervalMinutes: 10,
    healthThresholds: { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 },
  };

  it('failThreshold > confirmCount is clamped down to confirmCount', () => {
    mod.monitorConfigStore.setConfig({ ...base, alertConfirmCount: 3, alertConfirmFailThreshold: 99 });
    expect(mod.monitorConfigStore.getConfig().alertConfirmFailThreshold).toBe(3);
  });

  it('failThreshold = 0 is clamped up to 1', () => {
    mod.monitorConfigStore.setConfig({ ...base, alertConfirmCount: 5, alertConfirmFailThreshold: 0 });
    expect(mod.monitorConfigStore.getConfig().alertConfirmFailThreshold).toBe(1);
  });

  it('failThreshold within [1, confirmCount] is preserved', () => {
    mod.monitorConfigStore.setConfig({ ...base, alertConfirmCount: 5, alertConfirmFailThreshold: 3 });
    expect(mod.monitorConfigStore.getConfig().alertConfirmFailThreshold).toBe(3);
  });

  it('failThreshold omitted defaults to N-1 (4 for N=5)', () => {
    mod.monitorConfigStore.setConfig({ ...base, alertConfirmCount: 5 });
    expect(mod.monitorConfigStore.getConfig().alertConfirmFailThreshold).toBe(4);
  });

  it('failThreshold omitted with N=1 defaults to 1 (cannot go below)', () => {
    mod.monitorConfigStore.setConfig({ ...base, alertConfirmCount: 1 });
    expect(mod.monitorConfigStore.getConfig().alertConfirmFailThreshold).toBe(1);
  });

  it('failThreshold = confirmCount (strict 5-of-5) is allowed', () => {
    mod.monitorConfigStore.setConfig({ ...base, alertConfirmCount: 5, alertConfirmFailThreshold: 5 });
    expect(mod.monitorConfigStore.getConfig().alertConfirmFailThreshold).toBe(5);
  });

  it('failThreshold = 1 (lenient 1-of-N) is allowed', () => {
    mod.monitorConfigStore.setConfig({ ...base, alertConfirmCount: 5, alertConfirmFailThreshold: 1 });
    expect(mod.monitorConfigStore.getConfig().alertConfirmFailThreshold).toBe(1);
  });
});

describe('monitorConfigStore — targets CRUD', () => {
  const baseTarget = {
    providerId: 'p1',
    modelName: 'gpt-4',
    providerName: 'OpenAI',
    intervalMinutes: 0,
    alertEnabled: true,
  };

  it('getTargets returns empty array on fresh DB', () => {
    expect(mod.monitorConfigStore.getTargets()).toEqual([]);
  });

  it('addTarget then getTargets returns the target', () => {
    mod.monitorConfigStore.addTarget(baseTarget);
    const targets = mod.monitorConfigStore.getTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].providerId).toBe('p1');
    expect(targets[0].modelName).toBe('gpt-4');
    expect(targets[0].alertEnabled).toBe(true);
    expect(targets[0].lastAlertAt).toBeNull();
  });

  it('addTarget with alertEnabled=false persists the flag', () => {
    mod.monitorConfigStore.addTarget({ ...baseTarget, alertEnabled: false });
    expect(mod.monitorConfigStore.getTargets()[0].alertEnabled).toBe(false);
  });

  it('addTarget twice on same key replaces (INSERT OR REPLACE)', () => {
    mod.monitorConfigStore.addTarget({ ...baseTarget, intervalMinutes: 5 });
    mod.monitorConfigStore.addTarget({ ...baseTarget, intervalMinutes: 30 });
    const targets = mod.monitorConfigStore.getTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].intervalMinutes).toBe(30);
  });

  it('addTarget preserves last_alert_at across replacement', () => {
    mod.monitorConfigStore.addTarget(baseTarget);
    mod.monitorConfigStore.updateLastAlertAt('p1', 'gpt-4', '2026-05-15T01:00:00.000Z');
    mod.monitorConfigStore.addTarget({ ...baseTarget, intervalMinutes: 30 }); // re-add with new interval
    expect(mod.monitorConfigStore.getTargets()[0].lastAlertAt).toBe('2026-05-15T01:00:00.000Z');
  });

  it('removeTarget deletes the row', () => {
    mod.monitorConfigStore.addTarget(baseTarget);
    mod.monitorConfigStore.removeTarget('p1', 'gpt-4');
    expect(mod.monitorConfigStore.getTargets()).toEqual([]);
  });

  it('removeTarget on non-existent key is a no-op', () => {
    expect(() => mod.monitorConfigStore.removeTarget('ghost', 'ghost')).not.toThrow();
  });

  it('removeTargetsByProvider deletes only that provider', () => {
    mod.monitorConfigStore.addTarget({ ...baseTarget, providerId: 'p1', modelName: 'm1' });
    mod.monitorConfigStore.addTarget({ ...baseTarget, providerId: 'p1', modelName: 'm2' });
    mod.monitorConfigStore.addTarget({ ...baseTarget, providerId: 'p2', modelName: 'm1' });
    mod.monitorConfigStore.removeTargetsByProvider('p1');
    const remaining = mod.monitorConfigStore.getTargets();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].providerId).toBe('p2');
  });

  it('renameTarget changes model_name while preserving other columns', () => {
    mod.monitorConfigStore.addTarget({ ...baseTarget, intervalMinutes: 30 });
    mod.monitorConfigStore.updateLastAlertAt('p1', 'gpt-4', '2026-05-15T01:00:00Z');
    mod.monitorConfigStore.renameTarget('p1', 'gpt-4', 'gpt-4o');
    const targets = mod.monitorConfigStore.getTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].modelName).toBe('gpt-4o');
    expect(targets[0].intervalMinutes).toBe(30);
    expect(targets[0].lastAlertAt).toBe('2026-05-15T01:00:00Z');
  });
});

describe('monitorConfigStore.setTargets — bulk replacement preserves last_alert_at', () => {
  it('preserves last_alert_at for re-saved targets', () => {
    mod.monitorConfigStore.addTarget({
      providerId: 'p1',
      modelName: 'gpt-4',
      providerName: 'OpenAI',
      intervalMinutes: 0,
    });
    mod.monitorConfigStore.updateLastAlertAt('p1', 'gpt-4', '2026-05-15T01:00:00Z');

    // User saves with same target list
    mod.monitorConfigStore.setTargets([
      { providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI', intervalMinutes: 0 },
    ]);
    expect(mod.monitorConfigStore.getTargets()[0].lastAlertAt).toBe('2026-05-15T01:00:00Z');
  });

  it('new targets in the bulk save have null last_alert_at', () => {
    mod.monitorConfigStore.setTargets([
      { providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI', intervalMinutes: 0 },
    ]);
    expect(mod.monitorConfigStore.getTargets()[0].lastAlertAt).toBeNull();
  });

  it('targets removed in the bulk save lose their last_alert_at (gone for good)', () => {
    mod.monitorConfigStore.addTarget({
      providerId: 'p1',
      modelName: 'gpt-4',
      providerName: 'OpenAI',
      intervalMinutes: 0,
    });
    mod.monitorConfigStore.updateLastAlertAt('p1', 'gpt-4', '2026-05-15T01:00:00Z');

    // Save WITHOUT p1/gpt-4 → it's deleted
    mod.monitorConfigStore.setTargets([{ providerId: 'p2', modelName: 'm1', providerName: 'P2', intervalMinutes: 0 }]);

    // Re-adding later starts fresh (last_alert_at not magically resurrected)
    mod.monitorConfigStore.setTargets([
      { providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI', intervalMinutes: 0 },
      { providerId: 'p2', modelName: 'm1', providerName: 'P2', intervalMinutes: 0 },
    ]);
    const gpt4 = mod.monitorConfigStore.getTargets().find((t) => t.modelName === 'gpt-4');
    expect(gpt4?.lastAlertAt).toBeNull();
  });

  it('empty targets array clears the table', () => {
    mod.monitorConfigStore.addTarget({
      providerId: 'p1',
      modelName: 'gpt-4',
      providerName: 'OpenAI',
      intervalMinutes: 0,
    });
    mod.monitorConfigStore.setTargets([]);
    expect(mod.monitorConfigStore.getTargets()).toEqual([]);
  });
});

describe('monitorConfigStore — schema migrations (PRAGMA-driven)', () => {
  it('initializes a fresh DB with all columns present', () => {
    const cols = (h.db!.pragma('table_info(monitor_targets)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('interval_minutes');
    expect(cols).toContain('alert_enabled');
    expect(cols).toContain('last_alert_at');
  });

  it('migrates from a pre-existing minimal schema (adds missing columns)', async () => {
    // Build a "v0" schema first (no interval_minutes / alert_enabled / last_alert_at)
    h.db = new Database(':memory:');
    h.db.exec(`
      CREATE TABLE monitor_targets (
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (provider_id, model_name)
      )
    `);
    h.db
      .prepare('INSERT INTO monitor_targets (provider_id, model_name, provider_name) VALUES (?, ?, ?)')
      .run('p1', 'gpt-4', 'OpenAI');
    vi.resetModules();
    mod = await import('./monitorConfigStore');
    // After import, migrations should have run
    const cols = (h.db.pragma('table_info(monitor_targets)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('interval_minutes');
    expect(cols).toContain('alert_enabled');
    expect(cols).toContain('last_alert_at');
    // And the existing row should still be readable
    const targets = mod.monitorConfigStore.getTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].modelName).toBe('gpt-4');
    expect(targets[0].intervalMinutes).toBe(0); // default
    expect(targets[0].alertEnabled).toBe(true); // default = 1
    expect(targets[0].lastAlertAt).toBeNull();
  });
});

describe('monitorConfigStore.updateLastAlertAt', () => {
  it('uses provided ISO timestamp when given', () => {
    mod.monitorConfigStore.addTarget({
      providerId: 'p1',
      modelName: 'gpt-4',
      providerName: 'OpenAI',
      intervalMinutes: 0,
    });
    mod.monitorConfigStore.updateLastAlertAt('p1', 'gpt-4', '2026-01-01T00:00:00Z');
    expect(mod.monitorConfigStore.getTargets()[0].lastAlertAt).toBe('2026-01-01T00:00:00Z');
  });

  it('defaults to now() when timestamp omitted', () => {
    mod.monitorConfigStore.addTarget({
      providerId: 'p1',
      modelName: 'gpt-4',
      providerName: 'OpenAI',
      intervalMinutes: 0,
    });
    const before = Date.now();
    mod.monitorConfigStore.updateLastAlertAt('p1', 'gpt-4');
    const stored = new Date(mod.monitorConfigStore.getTargets()[0].lastAlertAt!).getTime();
    const after = Date.now();
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(after);
  });

  it('on non-existent target is a no-op (UPDATE matches no rows)', () => {
    expect(() => mod.monitorConfigStore.updateLastAlertAt('ghost', 'ghost')).not.toThrow();
    expect(mod.monitorConfigStore.getTargets()).toEqual([]);
  });
});
