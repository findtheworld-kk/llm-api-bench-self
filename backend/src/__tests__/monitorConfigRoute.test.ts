import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Replicates the field-mapping logic from routes/monitor.ts PUT /api/monitor/config.
 * This is a regression test for two bugs:
 *   1. alertConfirmCount and alertConfirmDelayMinutes were silently dropped because
 *      the handler explicitly constructed `updated` without them.
 *   2. setTargets used DELETE+INSERT and didn't preserve last_alert_at, causing
 *      the column to reset to null every time the user saved monitor settings.
 */

interface HealthThresholds {
  tpsSlowThreshold: number;
  tpsVerySlowThreshold: number;
  ttftSlowMs: number;
  minOutputTokens: number;
}

interface MonitorGlobalConfig {
  defaultIntervalMinutes: number;
  healthThresholds: HealthThresholds;
  alertWebhookUrl?: string;
  alertReminderMinutes?: number;
  alertWebhookSecret?: string;
  alertLanguage?: 'en' | 'zh';
  alertConfirmCount?: number;
  alertConfirmDelayMinutes?: number;
  alertConfirmFailThreshold?: number;
}

/** Mirror of the PUT /api/monitor/config field-mapping logic in routes/monitor.ts */
function mergeConfig(current: MonitorGlobalConfig, body: any): MonitorGlobalConfig {
  const interval =
    typeof body.defaultIntervalMinutes === 'number'
      ? Math.max(5, Math.min(360, body.defaultIntervalMinutes))
      : current.defaultIntervalMinutes;

  const ht = { ...current.healthThresholds };
  if (body.healthThresholds && typeof body.healthThresholds === 'object') {
    const bht = body.healthThresholds;
    if (typeof bht.tpsSlowThreshold === 'number' && bht.tpsSlowThreshold > 0)
      ht.tpsSlowThreshold = Math.round(bht.tpsSlowThreshold);
    if (typeof bht.tpsVerySlowThreshold === 'number' && bht.tpsVerySlowThreshold > 0)
      ht.tpsVerySlowThreshold = Math.round(bht.tpsVerySlowThreshold);
    if (typeof bht.ttftSlowMs === 'number' && bht.ttftSlowMs > 0) ht.ttftSlowMs = Math.round(bht.ttftSlowMs);
    if (typeof bht.minOutputTokens === 'number' && bht.minOutputTokens >= 0)
      ht.minOutputTokens = Math.round(bht.minOutputTokens);
  }

  return {
    defaultIntervalMinutes: interval,
    healthThresholds: ht,
    alertWebhookUrl: typeof body.alertWebhookUrl === 'string' ? body.alertWebhookUrl : current.alertWebhookUrl || '',
    alertReminderMinutes:
      typeof body.alertReminderMinutes === 'number'
        ? Math.max(5, Math.min(1440, body.alertReminderMinutes))
        : current.alertReminderMinutes,
    alertWebhookSecret:
      typeof body.alertWebhookSecret === 'string' ? body.alertWebhookSecret : current.alertWebhookSecret || '',
    alertLanguage:
      body.alertLanguage === 'zh' || body.alertLanguage === 'en' ? body.alertLanguage : current.alertLanguage || 'en',
    alertConfirmCount:
      typeof body.alertConfirmCount === 'number'
        ? Math.max(1, Math.min(20, Math.round(body.alertConfirmCount)))
        : current.alertConfirmCount,
    alertConfirmDelayMinutes:
      typeof body.alertConfirmDelayMinutes === 'number'
        ? Math.max(1, Math.min(60, Math.round(body.alertConfirmDelayMinutes)))
        : current.alertConfirmDelayMinutes,
    alertConfirmFailThreshold:
      typeof body.alertConfirmFailThreshold === 'number'
        ? Math.max(1, Math.min(20, Math.round(body.alertConfirmFailThreshold)))
        : current.alertConfirmFailThreshold,
  };
}

const CURRENT: MonitorGlobalConfig = {
  defaultIntervalMinutes: 10,
  healthThresholds: { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 },
  alertWebhookUrl: '',
  alertReminderMinutes: 360,
  alertWebhookSecret: '',
  alertLanguage: 'en',
  alertConfirmCount: 5,
  alertConfirmDelayMinutes: 1,
  alertConfirmFailThreshold: 4,
};

describe('PUT /api/monitor/config field mapping', () => {
  it('persists alertConfirmCount from request body (regression: was silently dropped)', () => {
    const result = mergeConfig(CURRENT, { alertConfirmCount: 3 });
    expect(result.alertConfirmCount).toBe(3);
  });

  it('persists alertConfirmDelayMinutes from request body (regression: was silently dropped)', () => {
    const result = mergeConfig(CURRENT, { alertConfirmDelayMinutes: 2 });
    expect(result.alertConfirmDelayMinutes).toBe(2);
  });

  it('clamps alertConfirmCount to [1, 20]', () => {
    expect(mergeConfig(CURRENT, { alertConfirmCount: 0 }).alertConfirmCount).toBe(1);
    expect(mergeConfig(CURRENT, { alertConfirmCount: 100 }).alertConfirmCount).toBe(20);
    expect(mergeConfig(CURRENT, { alertConfirmCount: 7 }).alertConfirmCount).toBe(7);
  });

  it('clamps alertConfirmDelayMinutes to [1, 60]', () => {
    expect(mergeConfig(CURRENT, { alertConfirmDelayMinutes: 0 }).alertConfirmDelayMinutes).toBe(1);
    expect(mergeConfig(CURRENT, { alertConfirmDelayMinutes: 999 }).alertConfirmDelayMinutes).toBe(60);
    expect(mergeConfig(CURRENT, { alertConfirmDelayMinutes: 10 }).alertConfirmDelayMinutes).toBe(10);
  });

  it('keeps current value when fields are absent from body', () => {
    const result = mergeConfig(CURRENT, { defaultIntervalMinutes: 15 });
    expect(result.alertConfirmCount).toBe(CURRENT.alertConfirmCount);
    expect(result.alertConfirmDelayMinutes).toBe(CURRENT.alertConfirmDelayMinutes);
  });

  it('rounds non-integer values for confirmation fields', () => {
    expect(mergeConfig(CURRENT, { alertConfirmCount: 3.7 }).alertConfirmCount).toBe(4);
    expect(mergeConfig(CURRENT, { alertConfirmDelayMinutes: 2.4 }).alertConfirmDelayMinutes).toBe(2);
  });

  it('persists alertConfirmFailThreshold from request body', () => {
    expect(mergeConfig(CURRENT, { alertConfirmFailThreshold: 3 }).alertConfirmFailThreshold).toBe(3);
  });

  it('clamps alertConfirmFailThreshold to [1, 20] (further clamping to confirmCount happens in store)', () => {
    expect(mergeConfig(CURRENT, { alertConfirmFailThreshold: 0 }).alertConfirmFailThreshold).toBe(1);
    expect(mergeConfig(CURRENT, { alertConfirmFailThreshold: 99 }).alertConfirmFailThreshold).toBe(20);
  });

  it('keeps current alertConfirmFailThreshold when absent', () => {
    expect(mergeConfig(CURRENT, { defaultIntervalMinutes: 15 }).alertConfirmFailThreshold).toBe(
      CURRENT.alertConfirmFailThreshold,
    );
  });
});

/**
 * Mirror of monitorConfigStore.setTargets — exercises the DELETE+INSERT pattern with
 * last_alert_at preservation. Regression test for the bug where every config save
 * cleared last_alert_at and caused reminder alerts to fire ~every probe interval
 * instead of every alertReminderMinutes.
 */
function makeTargetsTable() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE monitor_targets (
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      alert_enabled INTEGER NOT NULL DEFAULT 1,
      last_alert_at TEXT DEFAULT NULL,
      PRIMARY KEY (provider_id, model_name)
    )
  `);
  return db;
}

function setTargets(
  db: Database.Database,
  targets: Array<{ providerId: string; modelName: string; providerName: string; alertEnabled?: boolean }>,
) {
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT provider_id, model_name, last_alert_at FROM monitor_targets').all() as Array<{
      provider_id: string;
      model_name: string;
      last_alert_at: string | null;
    }>;
    const lastAlertMap = new Map<string, string | null>();
    for (const row of existing) {
      lastAlertMap.set(`${row.provider_id}::${row.model_name}`, row.last_alert_at);
    }
    db.prepare('DELETE FROM monitor_targets').run();
    const stmt = db.prepare(
      'INSERT INTO monitor_targets (provider_id, model_name, provider_name, interval_minutes, enabled, alert_enabled, last_alert_at) VALUES (?, ?, ?, 0, 1, ?, ?)',
    );
    for (const t of targets) {
      const preserved = lastAlertMap.get(`${t.providerId}::${t.modelName}`) ?? null;
      stmt.run(t.providerId, t.modelName, t.providerName, t.alertEnabled !== false ? 1 : 0, preserved);
    }
  });
  tx();
}

describe('monitorConfigStore.setTargets preserves last_alert_at (regression)', () => {
  it('does NOT clobber last_alert_at when re-saving the same target', () => {
    const db = makeTargetsTable();
    // Seed: target with last_alert_at populated by a prior alert
    db.prepare(
      'INSERT INTO monitor_targets (provider_id, model_name, provider_name, interval_minutes, enabled, alert_enabled, last_alert_at) VALUES (?, ?, ?, 0, 1, 1, ?)',
    ).run('p1', 'gpt-4', 'OpenAI', '2026-05-13T14:31:00.000Z');

    // User saves monitor settings — same target list re-submitted
    setTargets(db, [{ providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI' }]);

    const row = db
      .prepare('SELECT last_alert_at FROM monitor_targets WHERE provider_id = ? AND model_name = ?')
      .get('p1', 'gpt-4') as { last_alert_at: string };
    expect(row.last_alert_at).toBe('2026-05-13T14:31:00.000Z');
  });

  it('returns null for newly-added targets (no prior alert)', () => {
    const db = makeTargetsTable();
    setTargets(db, [{ providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI' }]);
    const row = db
      .prepare('SELECT last_alert_at FROM monitor_targets WHERE provider_id = ? AND model_name = ?')
      .get('p1', 'gpt-4') as { last_alert_at: string | null };
    expect(row.last_alert_at).toBeNull();
  });

  it('drops last_alert_at only for targets removed from the new list', () => {
    const db = makeTargetsTable();
    db.prepare(
      'INSERT INTO monitor_targets (provider_id, model_name, provider_name, interval_minutes, enabled, alert_enabled, last_alert_at) VALUES (?, ?, ?, 0, 1, 1, ?)',
    ).run('p1', 'gpt-4', 'OpenAI', '2026-05-13T14:31:00.000Z');
    db.prepare(
      'INSERT INTO monitor_targets (provider_id, model_name, provider_name, interval_minutes, enabled, alert_enabled, last_alert_at) VALUES (?, ?, ?, 0, 1, 1, ?)',
    ).run('p1', 'gpt-3', 'OpenAI', '2026-05-13T10:00:00.000Z');

    // User removes gpt-3, keeps gpt-4
    setTargets(db, [{ providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI' }]);

    const remaining = db.prepare('SELECT model_name, last_alert_at FROM monitor_targets').all() as Array<{
      model_name: string;
      last_alert_at: string | null;
    }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].model_name).toBe('gpt-4');
    expect(remaining[0].last_alert_at).toBe('2026-05-13T14:31:00.000Z');
  });
});
