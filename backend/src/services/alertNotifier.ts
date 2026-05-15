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

/** Pending confirmation: target detected down, awaiting re-check.
 *
 * Decision model: K-of-N voting.
 *   - Run up to maxAttempts (N) probes spaced by delayMs.
 *   - failCount tracks down/very_slow outcomes; okCount tracks healthy/slow.
 *   - Alert fires as soon as failCount >= failThreshold (K) — early termination on confirmed outage.
 *   - Cycle abandons as soon as failCount + remainingAttempts < failThreshold — early termination
 *     when threshold is mathematically unreachable (likely flapping or genuine recovery).
 *   - A single transient ok no longer drops the cycle, fixing the prior
 *     "passed at attempt N/M, skipping alert" misclassification.
 */
interface PendingConfirmation {
  target: MonitorTarget;
  metrics: AlertMetrics;
  type: AlertType;
  scheduledAt: number; // when to re-check (ms timestamp)
  attempt: number; // 1-based: the attempt number about to run / just completed
  maxAttempts: number; // total confirmation attempts in this cycle (N)
  failThreshold: number; // K: alert fires when failCount >= this
  failCount: number; // attempts so far that returned down/very_slow
  okCount: number; // attempts so far that returned healthy/slow
  delayMs: number; // delay between attempts in ms
}

const DEFAULT_CONFIRM_DELAY_MS = 60 * 1000; // 1 minute (fallback)
const DEFAULT_CONFIRM_COUNT = 5; // fallback

// In-memory queue of targets awaiting confirmation
const pendingConfirmations = new Map<string, PendingConfirmation>(); // key: "providerId::modelName"

// Generation counter for in-flight confirmations. A worker that started with token T
// must verify `inFlight.get(key) === T` after `await confirmProbe`; mismatch means the
// cycle was cancelled (e.g. by a recovery alert) or replaced and must abort.
const inFlight = new Map<string, number>();
let nextInFlightToken = 1;

/** Test-only: clear all in-memory state. Not exported through index. */
export function _resetAlertStateForTests(): void {
  pendingConfirmations.clear();
  inFlight.clear();
  nextInFlightToken = 1;
}

/** Test-only: snapshot current state for assertions. */
export function _peekAlertStateForTests() {
  return {
    pending: new Map(pendingConfirmations),
    inFlight: new Map(inFlight),
  };
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

/** Pure decision: given previous + current status and lastAlertAt, what kind of alert (if any)?
 *  Exported for unit tests. Production callers go through `shouldSendAlert` which fetches
 *  previousStatus from the DB. */
export function decideAlertType(input: {
  previousStatus: HealthStatus | null;
  currentStatus: HealthStatus;
  lastAlertAt: string | null | undefined;
  reminderMinutes: number;
  now?: number; // injectable for tests
}): { send: boolean; type: AlertType } | null {
  if (!input.previousStatus) return null;

  const wasDown = input.previousStatus === 'down' || input.previousStatus === 'very_slow';
  const isDown = input.currentStatus === 'down' || input.currentStatus === 'very_slow';

  if (wasDown && !isDown) return { send: true, type: 'recovery' };
  if (!wasDown && isDown) return { send: true, type: 'down' };
  if (!isDown) return null;

  // wasDown && isDown -> reminder gated by lastAlertAt + reminderMinutes window
  const now = input.now ?? Date.now();
  if (!input.lastAlertAt) return { send: true, type: 'reminder' };
  const elapsedMs = now - new Date(input.lastAlertAt).getTime();
  if (elapsedMs >= input.reminderMinutes * 60 * 1000) return { send: true, type: 'reminder' };
  return null;
}

/** Determine if an alert should be sent (DB-aware wrapper around `decideAlertType`). */
function shouldSendAlert(
  target: MonitorTarget,
  currentStatus: HealthStatus,
  reminderMinutes: number,
): { send: boolean; type: AlertType } | null {
  return decideAlertType({
    previousStatus: getPreviousStatus(target.providerId, target.modelName),
    currentStatus,
    lastAlertAt: target.lastAlertAt,
    reminderMinutes,
  });
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
    // CRITICAL: webhook delivery failure must NOT be silently swallowed.
    // Throwing here ensures `processPendingConfirmations` / recovery branch see the failure
    // and skip `updateLastAlertAt`, allowing the next probe cycle to retry instead of
    // entering 6h reminder cooldown for an alert nobody received.
    const text = await res.text().catch(() => '');
    throw new Error(`Feishu webhook failed (${res.status}): ${text.slice(0, 200)}`);
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

/** Pure decision function for one confirmation result. Exported for unit tests. */
export type ConfirmationDecision =
  | { kind: 'fire' }
  | { kind: 'abandon'; reason: string }
  | { kind: 'continue'; nextAttempt: number; failCount: number; okCount: number };

export function evaluateConfirmation(input: {
  attempt: number; // attempt number that just completed (1-based)
  maxAttempts: number;
  failThreshold: number;
  prevFailCount: number;
  prevOkCount: number;
  isDownThisAttempt: boolean;
}): ConfirmationDecision {
  const failCount = input.prevFailCount + (input.isDownThisAttempt ? 1 : 0);
  const okCount = input.prevOkCount + (input.isDownThisAttempt ? 0 : 1);
  const completed = input.attempt;
  const remaining = Math.max(0, input.maxAttempts - completed);

  if (failCount >= input.failThreshold) {
    return { kind: 'fire' };
  }
  if (failCount + remaining < input.failThreshold) {
    return {
      kind: 'abandon',
      reason: `${failCount}/${input.maxAttempts} fails, threshold ${input.failThreshold} unreachable`,
    };
  }
  return { kind: 'continue', nextAttempt: completed + 1, failCount, okCount };
}

/**
 * Run one ready confirmation through its probe + decision. Designed to be invoked in parallel
 * for independent targets. Reads `pending` from the queue, runs `confirmProbe`, then commits
 * the decision (fire / abandon / continue) only if the in-flight token still matches —
 * if a recovery alert (or any other event) cancelled this cycle mid-await, we drop the result.
 */
async function runOneConfirmation(pending: PendingConfirmation): Promise<void> {
  const key = `${pending.target.providerId}::${pending.target.modelName}`;
  const targetLabel = `${pending.target.providerId}/${pending.target.modelName}`;
  const myToken = nextInFlightToken++;
  inFlight.set(key, myToken);

  const confirmed = await confirmProbe(pending.target);

  // Cancellation check: if our token was overwritten or removed, this cycle was invalidated
  // (e.g. recovery alert cleared it, or a fresh cycle replaced it after we launched).
  if (inFlight.get(key) !== myToken) {
    console.log(`[Alert] In-flight cycle for ${targetLabel} (token ${myToken}) cancelled, dropping result`);
    return;
  }
  inFlight.delete(key);

  if (!confirmed) {
    // Probe machinery failed (provider/key missing). Re-queue without counting an attempt.
    pendingConfirmations.set(key, {
      ...pending,
      scheduledAt: Date.now() + pending.delayMs,
    });
    return;
  }

  const isDownThisAttempt = confirmed.status === 'down' || confirmed.status === 'very_slow';
  const decision = evaluateConfirmation({
    attempt: pending.attempt,
    maxAttempts: pending.maxAttempts,
    failThreshold: pending.failThreshold,
    prevFailCount: pending.failCount,
    prevOkCount: pending.okCount,
    isDownThisAttempt,
  });

  const newFail = pending.failCount + (isDownThisAttempt ? 1 : 0);
  const newOk = pending.okCount + (isDownThisAttempt ? 0 : 1);
  const outcome = isDownThisAttempt ? 'fail' : 'ok';
  console.log(
    `[Alert] Confirmation ${pending.attempt}/${pending.maxAttempts} ${outcome} for ${targetLabel} ` +
      `(${newFail} fail / ${newOk} ok, threshold ${pending.failThreshold})`,
  );

  if (decision.kind === 'fire') {
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
      console.log(`[Alert] Fired ${pending.type} alert for ${targetLabel} (${newFail}/${pending.maxAttempts} fails)`);
    } catch (err) {
      // CRITICAL: webhook delivery failed. Do NOT record lastAlertAt (would suppress
      // future probes for 6h). Re-queue the cycle so the next scheduler tick retries.
      // Reset attempt to 1 so the K-of-N counter starts fresh — the alerting decision
      // already passed once, but the operational signal (notification) failed.
      console.error(
        `[Alert] Webhook delivery FAILED for ${targetLabel}, requeueing for retry:`,
        err instanceof Error ? err.message : err,
      );
      pendingConfirmations.set(key, {
        ...pending,
        metrics: confirmed.metrics,
        attempt: 1,
        failCount: 0,
        okCount: 0,
        scheduledAt: Date.now() + pending.delayMs,
      });
    }
    return;
  }

  if (decision.kind === 'abandon') {
    console.log(`[Alert] Cycle abandoned for ${targetLabel}: ${decision.reason}`);
    return;
  }

  // continue: schedule next attempt
  pendingConfirmations.set(key, {
    ...pending,
    metrics: confirmed.metrics,
    attempt: decision.nextAttempt,
    failCount: decision.failCount,
    okCount: decision.okCount,
    scheduledAt: Date.now() + pending.delayMs,
  });
}

/** Process pending confirmations — called every minute by scheduler.
 *  Targets are grouped by provider; providers run in parallel, models within a provider run
 *  in parallel as well (independent API calls, independent state). */
export async function processPendingConfirmations(): Promise<void> {
  if (pendingConfirmations.size === 0) return;
  const now = Date.now();

  // Drain ready entries from the queue. Removing now means processAlert's `has(key)` gate
  // would otherwise see no entry — the inFlight set covers that window.
  const ready: PendingConfirmation[] = [];
  for (const [key, pending] of pendingConfirmations) {
    if (now >= pending.scheduledAt) {
      ready.push(pending);
      pendingConfirmations.delete(key);
    }
  }

  if (ready.length === 0) return;

  // Group by provider for parallelism. Each (provider, model) pair runs as an independent task;
  // we use Promise.all across the whole ready set since confirm probes are independent.
  // The in-flight token guards against cancellation races.
  const byProvider = new Map<string, PendingConfirmation[]>();
  for (const p of ready) {
    if (!byProvider.has(p.target.providerId)) byProvider.set(p.target.providerId, []);
    byProvider.get(p.target.providerId)!.push(p);
  }

  await Promise.all(
    Array.from(byProvider.values()).map((group) => Promise.all(group.map((p) => runOneConfirmation(p)))),
  );
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

  const key = `${target.providerId}::${target.modelName}`;

  // Recovery alerts are sent immediately (no confirmation needed). They also CANCEL any
  // in-flight down-confirmation cycle for this target: the model is observably back, so a
  // pending confirm chain would just produce a misleading delayed down alert.
  if (decision.type === 'recovery') {
    const wasPending = pendingConfirmations.delete(key);
    const wasInFlight = inFlight.delete(key);
    if (wasPending || wasInFlight) {
      console.log(`[Alert] Recovery for ${target.providerId}/${target.modelName} cancelled in-flight confirmation`);
    }
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
      // Webhook delivery failed. Do NOT record lastAlertAt — the next time this target
      // transitions back to down/recovery, the decision logic should run again rather
      // than treating this attempt as if it succeeded.
      console.error(
        `[Alert] Recovery webhook delivery FAILED for ${target.providerId}/${target.modelName}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return;
  }

  // Down/reminder: queue for confirmation. Gate covers BOTH the queued state AND the
  // in-flight (await confirmProbe) window — without the inFlight check, a scheduled probe
  // landing during the await could spawn a duplicate parallel cycle with its own counters.
  if (pendingConfirmations.has(key) || inFlight.has(key)) return;

  const confirmCount = config.alertConfirmCount ?? DEFAULT_CONFIRM_COUNT;
  const confirmDelayMs = (config.alertConfirmDelayMinutes ?? 1) * 60 * 1000;
  // Default fail threshold = N - 1 (4-of-5), tolerates one transient ok during real outages.
  const rawThreshold = config.alertConfirmFailThreshold ?? Math.max(1, confirmCount - 1);
  const failThreshold = Math.max(1, Math.min(confirmCount, rawThreshold));

  pendingConfirmations.set(key, {
    target,
    metrics,
    type: decision.type,
    scheduledAt: Date.now() + confirmDelayMs,
    attempt: 1,
    maxAttempts: confirmCount,
    failThreshold,
    failCount: 0,
    okCount: 0,
    delayMs: confirmDelayMs,
  });
  console.log(
    `[Alert] Queued confirmation for ${target.providerId}/${target.modelName} ` +
      `(${failThreshold}-of-${confirmCount} fails to alert, interval ${confirmDelayMs / 1000}s)`,
  );
}
