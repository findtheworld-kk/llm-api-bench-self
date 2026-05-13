import { getDb } from './database';

export interface MonitorTarget {
  providerId: string;
  modelName: string;
  providerName: string;
  intervalMinutes: number; // 0 = use global default
  alertEnabled?: boolean;
  lastAlertAt?: string | null;
}

export interface HealthThresholds {
  tpsSlowThreshold: number; // default 20 — below this is 'slow'
  tpsVerySlowThreshold: number; // default 5  — below this is 'very_slow'
  ttftSlowMs: number; // default 1000
  minOutputTokens: number; // default 1
}

export interface MonitorGlobalConfig {
  defaultIntervalMinutes: number; // 5–360
  healthThresholds: HealthThresholds;
  alertWebhookUrl?: string;
  alertReminderMinutes?: number; // default 360 (6 hours)
  alertWebhookSecret?: string;
  alertLanguage?: 'en' | 'zh';
  alertConfirmCount?: number; // how many consecutive failures before alerting (default 5)
  alertConfirmDelayMinutes?: number; // delay between each confirmation check (default 1)
}

const DEFAULT_CONFIG: MonitorGlobalConfig = {
  defaultIntervalMinutes: 10,
  healthThresholds: {
    tpsSlowThreshold: 20,
    tpsVerySlowThreshold: 5,
    ttftSlowMs: 1000,
    minOutputTokens: 1,
  },
  alertWebhookUrl: '',
  alertReminderMinutes: 360,
  alertWebhookSecret: '',
  alertLanguage: 'en',
  alertConfirmCount: 5,
  alertConfirmDelayMinutes: 1,
};

class MonitorConfigStore {
  private db = getDb();

  constructor() {
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_targets (
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (provider_id, model_name)
      )
    `);

    // Migrations using PRAGMA check
    const cols = (this.db.pragma('table_info(monitor_targets)') as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('interval_minutes')) {
      this.db.exec('ALTER TABLE monitor_targets ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 0');
      console.log('Migrated: added interval_minutes column to monitor_targets');
    }
    if (!cols.includes('alert_enabled')) {
      this.db.exec('ALTER TABLE monitor_targets ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 1');
      console.log('Migrated: added alert_enabled column to monitor_targets');
    }
    if (!cols.includes('last_alert_at')) {
      this.db.exec('ALTER TABLE monitor_targets ADD COLUMN last_alert_at TEXT DEFAULT NULL');
      console.log('Migrated: added last_alert_at column to monitor_targets');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    console.log('Monitor config store initialized');
  }

  // ---- Global Config ----

  getConfig(): MonitorGlobalConfig {
    const row = this.db.prepare("SELECT value FROM monitor_config WHERE key = 'global'").get() as
      | { value: string }
      | undefined;
    if (!row) return DEFAULT_CONFIG;
    try {
      const parsed = JSON.parse(row.value);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        healthThresholds: { ...DEFAULT_CONFIG.healthThresholds, ...(parsed.healthThresholds || {}) },
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  setConfig(config: MonitorGlobalConfig): void {
    const clamped = clampInterval(config.defaultIntervalMinutes);
    this.db.prepare("INSERT OR REPLACE INTO monitor_config (key, value) VALUES ('global', ?)").run(
      JSON.stringify({
        defaultIntervalMinutes: clamped,
        healthThresholds: { ...DEFAULT_CONFIG.healthThresholds, ...(config.healthThresholds || {}) },
        alertWebhookUrl: config.alertWebhookUrl ?? '',
        alertReminderMinutes: config.alertReminderMinutes ?? DEFAULT_CONFIG.alertReminderMinutes,
        alertWebhookSecret: config.alertWebhookSecret ?? '',
        alertLanguage: config.alertLanguage ?? 'en',
        alertConfirmCount: config.alertConfirmCount ?? DEFAULT_CONFIG.alertConfirmCount,
        alertConfirmDelayMinutes: config.alertConfirmDelayMinutes ?? DEFAULT_CONFIG.alertConfirmDelayMinutes,
      }),
    );
  }

  // ---- Targets ----

  getTargets(): MonitorTarget[] {
    const rows = this.db
      .prepare(
        'SELECT provider_id, model_name, provider_name, interval_minutes, alert_enabled, last_alert_at FROM monitor_targets WHERE enabled = 1 ORDER BY provider_name, model_name',
      )
      .all() as Array<{
      provider_id: string;
      model_name: string;
      provider_name: string;
      interval_minutes: number;
      alert_enabled: number;
      last_alert_at: string | null;
    }>;
    return rows.map((r) => ({
      providerId: r.provider_id,
      modelName: r.model_name,
      providerName: r.provider_name,
      intervalMinutes: r.interval_minutes || 0,
      alertEnabled: !!r.alert_enabled,
      lastAlertAt: r.last_alert_at,
    }));
  }

  setTargets(targets: MonitorTarget[]): void {
    const tx = this.db.transaction(() => {
      // Preserve last_alert_at across re-save by reading existing values first
      const existing = this.db
        .prepare('SELECT provider_id, model_name, last_alert_at FROM monitor_targets')
        .all() as Array<{ provider_id: string; model_name: string; last_alert_at: string | null }>;
      const lastAlertMap = new Map<string, string | null>();
      for (const row of existing) {
        lastAlertMap.set(`${row.provider_id}::${row.model_name}`, row.last_alert_at);
      }

      this.db.prepare('DELETE FROM monitor_targets').run();
      const stmt = this.db.prepare(
        'INSERT INTO monitor_targets (provider_id, model_name, provider_name, interval_minutes, enabled, alert_enabled, last_alert_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      );
      for (const t of targets) {
        const preserved = lastAlertMap.get(`${t.providerId}::${t.modelName}`) ?? null;
        stmt.run(
          t.providerId,
          t.modelName,
          t.providerName,
          t.intervalMinutes || 0,
          t.alertEnabled !== false ? 1 : 0,
          preserved,
        );
      }
    });
    tx();
  }

  addTarget(target: MonitorTarget): void {
    // Preserve last_alert_at if the target already exists
    const existing = this.db
      .prepare('SELECT last_alert_at FROM monitor_targets WHERE provider_id = ? AND model_name = ?')
      .get(target.providerId, target.modelName) as { last_alert_at: string | null } | undefined;
    const preserved = existing?.last_alert_at ?? null;

    this.db
      .prepare(
        'INSERT OR REPLACE INTO monitor_targets (provider_id, model_name, provider_name, interval_minutes, enabled, alert_enabled, last_alert_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      )
      .run(
        target.providerId,
        target.modelName,
        target.providerName,
        target.intervalMinutes || 0,
        target.alertEnabled !== false ? 1 : 0,
        preserved,
      );
  }

  removeTarget(providerId: string, modelName: string): void {
    this.db.prepare('DELETE FROM monitor_targets WHERE provider_id = ? AND model_name = ?').run(providerId, modelName);
  }

  /** Rename a target's model name (preserves interval and enabled state) */
  renameTarget(providerId: string, oldModelName: string, newModelName: string): void {
    this.db
      .prepare('UPDATE monitor_targets SET model_name = ? WHERE provider_id = ? AND model_name = ?')
      .run(newModelName, providerId, oldModelName);
  }

  /** Remove all targets for a given provider */
  removeTargetsByProvider(providerId: string): void {
    this.db.prepare('DELETE FROM monitor_targets WHERE provider_id = ?').run(providerId);
  }

  /** Update last alert timestamp for a target */
  updateLastAlertAt(providerId: string, modelName: string, timestamp?: string): void {
    const ts = timestamp || new Date().toISOString();
    this.db
      .prepare('UPDATE monitor_targets SET last_alert_at = ? WHERE provider_id = ? AND model_name = ?')
      .run(ts, providerId, modelName);
  }
}

function clampInterval(minutes: number): number {
  return Math.max(5, Math.min(360, minutes));
}

export { clampInterval };
export const monitorConfigStore = new MonitorConfigStore();
