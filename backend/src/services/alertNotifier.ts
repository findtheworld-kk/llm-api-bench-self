import crypto from 'crypto';
import { getDb } from './database';
import { monitorConfigStore, MonitorTarget } from './monitorConfigStore';
import { HealthStatus, monitorStore } from './monitorStore';
import { providerStore } from './providerStore';
import { testProviderConnection } from '../providers/adapter';

type AlertType = 'down' | 'reminder' | 'recovery';

interface AlertMetrics {
  latencyMs: number;
  ttftMs: number;
  outputTokens: number;
  errorMessage?: string;
}

/** Pending confirmation: target detected down, awaiting re-check */
interface PendingConfirmation {
  target: MonitorTarget;
  metrics: AlertMetrics;
  type: AlertType;
  scheduledAt: number; // when to re-check (ms timestamp)
  attempt: number; // current attempt number (1-based)
  maxAttempts: number; // total confirmation attempts required
  delayMs: number; // delay between attempts in ms
}

const DEFAULT_CONFIRM_DELAY_MS = 60 * 1000; // 1 minute (fallback)
const DEFAULT_CONFIRM_COUNT = 5; // fallback

// In-memory queue of targets awaiting confirmation
const pendingConfirmations = new Map<string, PendingConfirmation>(); // key: "providerId::modelName"

/** Get the previous health status for a target (skip the just-inserted ping) */
function getPreviousStatus(providerId: string, modelName: string): HealthStatus | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT health_status FROM monitor_pings
       WHERE provider_id = ? AND model_name = ?
       ORDER BY checked_at DESC LIMIT 1 OFFSET 1`,
    )
    .get(providerId, modelName) as { health_status: HealthStatus } | undefined;
  return row?.health_status ?? null;
}

/** Determine if an alert should be sent */
function shouldSendAlert(
  target: MonitorTarget,
  currentStatus: HealthStatus,
  reminderMinutes: number,
): { send: boolean; type: AlertType } | null {
  const previousStatus = getPreviousStatus(target.providerId, target.modelName);

  if (!previousStatus) return null;

  const wasDown = previousStatus === 'down' || previousStatus === 'very_slow';
  const isDown = currentStatus === 'down' || currentStatus === 'very_slow';

  if (wasDown && !isDown) {
    return { send: true, type: 'recovery' };
  }

  if (!wasDown && isDown) {
    return { send: true, type: 'down' };
  }

  if (isDown) {
    const lastAlertAt = target.lastAlertAt;
    if (!lastAlertAt) {
      return { send: true, type: 'reminder' };
    }
    const elapsed = Date.now() - new Date(lastAlertAt).getTime();
    if (elapsed >= reminderMinutes * 60 * 1000) {
      return { send: true, type: 'reminder' };
    }
  }

  return null;
}

/** Generate Feishu webhook signature — appends timestamp & sign as URL params */
function buildSignedUrl(webhookUrl: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', stringToSign);
  hmac.update('');
  const sign = hmac.digest('base64');
  const sep = webhookUrl.includes('?') ? '&' : '?';
  return `${webhookUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

/** Localized alert content */
function getAlertContent(lang: 'en' | 'zh', type: AlertType, target: MonitorTarget, metrics: AlertMetrics) {
  const isZh = lang === 'zh';
  const tps = metrics.latencyMs > 0 ? ((metrics.outputTokens / metrics.latencyMs) * 1000).toFixed(1) : '0';

  const colors: Record<AlertType, string> = { down: 'red', reminder: 'orange', recovery: 'green' };

  const titles: Record<AlertType, string> = isZh
    ? { down: '🚨 监控告警：服务异常', reminder: '⚠️ 监控提醒：服务仍异常', recovery: '✅ 监控恢复：服务已恢复' }
    : {
        down: '🚨 Monitor Alert: Service Down',
        reminder: '⚠️ Monitor Reminder: Still Down',
        recovery: '✅ Monitor Recovery: Service Restored',
      };

  const providerLabel = isZh ? '服务商' : 'Provider';
  const modelLabel = isZh ? '模型' : 'Model';
  const latencyLabel = isZh ? '延迟' : 'Latency';
  const errorLabel = isZh ? '错误' : 'Error';
  const timeLabel = isZh ? '时间' : 'Time';

  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${providerLabel}:** ${target.providerName}\n**${modelLabel}:** ${target.modelName}`,
      },
    },
  ];

  if (type === 'recovery') {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${latencyLabel}:** ${metrics.latencyMs}ms | **TPS:** ${tps} | **TTFT:** ${metrics.ttftMs}ms`,
      },
    });
  } else {
    const details = [
      `**${latencyLabel}:** ${metrics.latencyMs}ms`,
      `**TTFT:** ${metrics.ttftMs}ms`,
      `**Tokens:** ${metrics.outputTokens}`,
    ];
    if (metrics.errorMessage) details.push(`**${errorLabel}:** ${metrics.errorMessage}`);
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: details.join('\n') } });
  }

  elements.push({
    tag: 'div',
    text: { tag: 'plain_text', content: `${timeLabel}: ${new Date().toISOString()}` },
  });

  return { color: colors[type], title: titles[type], elements };
}

/** Send alert to Feishu webhook */
async function sendFeishuAlert(
  webhookUrl: string,
  secret: string | undefined,
  lang: 'en' | 'zh',
  type: AlertType,
  target: MonitorTarget,
  metrics: AlertMetrics,
): Promise<void> {
  const { color, title, elements } = getAlertContent(lang, type, target, metrics);

  const bodyStr = JSON.stringify({
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title }, template: color },
      elements,
    },
  });

  const targetUrl = secret ? buildSignedUrl(webhookUrl, secret) : webhookUrl;
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyStr,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[Alert] Feishu webhook failed (${res.status}): ${text}`);
  }
}

/** Re-probe a single target to confirm its status */
async function confirmProbe(target: MonitorTarget): Promise<{ status: HealthStatus; metrics: AlertMetrics } | null> {
  const provider = providerStore.get(target.providerId);
  if (!provider) {
    console.warn(`[Alert] confirmProbe: provider not found for ${target.providerId}`);
    return null;
  }

  const apiKey = providerStore.getDecryptedApiKey(target.providerId);
  if (!apiKey) {
    console.warn(`[Alert] confirmProbe: API key not found for ${target.providerId}`);
    return null;
  }

  try {
    const result = await testProviderConnection({
      endpoint: provider.endpoint,
      apiKey,
      format: provider.format,
      modelName: target.modelName,
    });

    const pingStatus = result.success ? 'ok' : 'error';
    const thresholds = monitorConfigStore.getConfig().healthThresholds;
    let healthStatus: HealthStatus = 'down';
    if (pingStatus === 'ok') {
      const tps = result.latencyMs > 0 ? (result.outputTokens / result.latencyMs) * 1000 : 0;
      if (result.outputTokens > 0 && result.outputTokens < thresholds.minOutputTokens) healthStatus = 'down';
      else if (tps > 0 && tps < thresholds.tpsVerySlowThreshold) healthStatus = 'very_slow';
      else if (tps > 0 && tps < thresholds.tpsSlowThreshold) healthStatus = 'slow';
      else if (result.ttftMs >= thresholds.ttftSlowMs) healthStatus = 'slow';
      else healthStatus = 'healthy';
    }

    const metrics: AlertMetrics = {
      latencyMs: result.latencyMs,
      ttftMs: result.ttftMs,
      outputTokens: result.outputTokens,
      errorMessage: result.error || undefined,
    };

    // Record the confirmation ping
    const isoNow = new Date().toISOString();
    monitorStore.insertPing({
      providerId: target.providerId,
      providerName: target.providerName,
      modelName: target.modelName,
      status: pingStatus,
      healthStatus,
      latencyMs: metrics.latencyMs,
      ttftMs: metrics.ttftMs,
      outputTokens: metrics.outputTokens,
      responseText: result.responseText,
      errorMessage: metrics.errorMessage,
      checkedAt: isoNow,
    });

    return { status: healthStatus, metrics };
  } catch (err: any) {
    const metrics: AlertMetrics = { latencyMs: 0, ttftMs: 0, outputTokens: 0, errorMessage: err.message };
    // Record the error ping (same as probeTarget does)
    monitorStore.insertPing({
      providerId: target.providerId,
      providerName: target.providerName,
      modelName: target.modelName,
      status: 'error',
      healthStatus: 'down',
      latencyMs: 0,
      ttftMs: 0,
      outputTokens: 0,
      responseText: undefined,
      errorMessage: err.message,
      checkedAt: new Date().toISOString(),
    });
    return { status: 'down' as HealthStatus, metrics };
  }
}

/** Process pending confirmations — called every minute by scheduler */
export async function processPendingConfirmations(): Promise<void> {
  if (pendingConfirmations.size === 0) return;
  const now = Date.now();

  const ready: PendingConfirmation[] = [];
  for (const [key, pending] of pendingConfirmations) {
    if (now >= pending.scheduledAt) {
      ready.push(pending);
      pendingConfirmations.delete(key);
    }
  }

  for (const pending of ready) {
    const confirmed = await confirmProbe(pending.target);
    if (!confirmed) {
      // Probe failed entirely — re-queue for retry
      const key = `${pending.target.providerId}::${pending.target.modelName}`;
      pendingConfirmations.set(key, {
        ...pending,
        scheduledAt: Date.now() + pending.delayMs,
      });
      continue;
    }

    const isStillDown = confirmed.status === 'down' || confirmed.status === 'very_slow';
    if (isStillDown) {
      if (pending.attempt < pending.maxAttempts) {
        // Not yet reached required count — schedule next confirmation
        const key = `${pending.target.providerId}::${pending.target.modelName}`;
        pendingConfirmations.set(key, {
          ...pending,
          metrics: confirmed.metrics,
          attempt: pending.attempt + 1,
          scheduledAt: Date.now() + pending.delayMs,
        });
        console.log(
          `[Alert] Confirmation ${pending.attempt}/${pending.maxAttempts} failed for ${pending.target.providerId}/${pending.target.modelName}, scheduling next check`,
        );
      } else {
        // All confirmation attempts failed — send the alert
        const config = monitorConfigStore.getConfig();
        try {
          await sendFeishuAlert(
            config.alertWebhookUrl!,
            config.alertWebhookSecret || undefined,
            (config.alertLanguage as 'en' | 'zh') || 'en',
            pending.type,
            pending.target,
            confirmed.metrics,
          );
          monitorConfigStore.updateLastAlertAt(pending.target.providerId, pending.target.modelName);
        } catch (err) {
          console.error('[Alert] Failed to send confirmed notification:', err);
        }
      }
    } else {
      console.log(
        `[Alert] Confirmation check passed for ${pending.target.providerId}/${pending.target.modelName} at attempt ${pending.attempt}/${pending.maxAttempts}, skipping alert`,
      );
    }
  }
}

/** Main entry: check and send alert if needed */
export async function processAlert(
  target: MonitorTarget,
  currentStatus: HealthStatus,
  metrics: AlertMetrics,
): Promise<void> {
  if (target.alertEnabled === false) return;

  const config = monitorConfigStore.getConfig();
  const webhookUrl = config.alertWebhookUrl;
  if (!webhookUrl) return;

  const reminderMinutes = config.alertReminderMinutes ?? 360;
  const decision = shouldSendAlert(target, currentStatus, reminderMinutes);
  if (!decision) return;

  // Recovery alerts are sent immediately (no confirmation needed)
  if (decision.type === 'recovery') {
    try {
      await sendFeishuAlert(
        webhookUrl,
        config.alertWebhookSecret || undefined,
        config.alertLanguage || 'en',
        decision.type,
        target,
        metrics,
      );
      monitorConfigStore.updateLastAlertAt(target.providerId, target.modelName);
    } catch (err) {
      console.error('[Alert] Failed to send notification:', err);
    }
    return;
  }

  // Down/reminder: queue for confirmation
  const confirmCount = config.alertConfirmCount ?? DEFAULT_CONFIRM_COUNT;
  const confirmDelayMs = (config.alertConfirmDelayMinutes ?? 1) * 60 * 1000;
  const key = `${target.providerId}::${target.modelName}`;
  if (pendingConfirmations.has(key)) return; // already pending

  pendingConfirmations.set(key, {
    target,
    metrics,
    type: decision.type,
    scheduledAt: Date.now() + confirmDelayMs,
    attempt: 1,
    maxAttempts: confirmCount,
    delayMs: confirmDelayMs,
  });
  console.log(
    `[Alert] Queued confirmation check for ${target.providerId}/${target.modelName} (${confirmCount}x, interval ${confirmDelayMs / 1000}s)`,
  );
}
