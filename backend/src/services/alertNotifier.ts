import crypto from 'crypto';
import { getDb } from './database';
import { monitorConfigStore, MonitorTarget } from './monitorConfigStore';
import { HealthStatus } from './monitorStore';

type AlertType = 'down' | 'reminder' | 'recovery';

interface AlertMetrics {
  latencyMs: number;
  ttftMs: number;
  outputTokens: number;
  errorMessage?: string;
}

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

  const wasDown = previousStatus === 'down';
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
}
