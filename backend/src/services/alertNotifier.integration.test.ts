import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MonitorTarget } from './monitorConfigStore';

/**
 * Integration tests for state coordination in alertNotifier:
 *   1. recovery cancels an in-flight down confirmation cycle
 *   2. inFlight gate blocks duplicate enqueue during the await window
 *   3. token mismatch drops stale write when a cycle is replaced mid-await
 *
 * The K-of-N decision math itself is covered by the pure-function tests in
 * `alertNotifier.test.ts`. This file covers the concurrent state machine that
 * those tests cannot reach (the await window, inFlight Map, token check).
 */

// ---- Mock side-effecting dependencies BEFORE importing alertNotifier ----
//
// vi.mock factories are hoisted; the spy fns must be defined inside the
// factory or via vi.hoisted to be referenceable from both the mock and tests.

const h = vi.hoisted(() => ({
  testProviderConnection: vi.fn(),
  getConfig: vi.fn(),
  updateLastAlertAt: vi.fn(),
  insertPing: vi.fn(),
  providerGet: vi.fn(),
  providerGetKey: vi.fn(),
  // dbGetPreviousStatus returns the row that `getPreviousStatus` would read.
  // Set it via mockReturnValueOnce to control wasDown/isDown transitions.
  dbGet: vi.fn(),
}));

vi.mock('../providers/adapter', () => ({
  testProviderConnection: h.testProviderConnection,
  PROBE_TIMEOUT_MS: 90_000,
}));

vi.mock('./monitorConfigStore', () => ({
  monitorConfigStore: {
    getConfig: h.getConfig,
    updateLastAlertAt: h.updateLastAlertAt,
  },
}));

vi.mock('./monitorStore', () => ({
  monitorStore: {
    insertPing: h.insertPing,
  },
}));

vi.mock('./providerStore', () => ({
  providerStore: {
    get: h.providerGet,
    getDecryptedApiKey: h.providerGetKey,
  },
}));

vi.mock('./database', () => ({
  getDb: () => ({ prepare: () => ({ get: h.dbGet }) }),
}));

// Now import the unit under test
import {
  processAlert,
  processPendingConfirmations,
  _resetAlertStateForTests,
  _peekAlertStateForTests,
} from './alertNotifier';

const TARGET: MonitorTarget = {
  providerId: 'p1',
  modelName: 'm1',
  providerName: 'TestProvider',
  intervalMinutes: 0,
  alertEnabled: true,
  lastAlertAt: null,
};
const KEY = 'p1::m1';

const DOWN_METRICS = { latencyMs: 1000, ttftMs: 0, outputTokens: 0 };
const OK_METRICS = { latencyMs: 1000, ttftMs: 500, outputTokens: 50 };

const STANDARD_CONFIG = {
  defaultIntervalMinutes: 10,
  healthThresholds: { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 },
  alertWebhookUrl: 'https://example.com/webhook',
  alertReminderMinutes: 360,
  alertWebhookSecret: '',
  alertLanguage: 'en' as const,
  alertConfirmCount: 5,
  alertConfirmDelayMinutes: 1,
  alertConfirmFailThreshold: 4,
};

/** Build a `testProviderConnection` result shaped like the real adapter. */
const probeResult = (kind: 'down' | 'ok') =>
  kind === 'down'
    ? { success: false, latencyMs: 1000, ttftMs: 0, outputTokens: 0, responseText: '', error: 'simulated' }
    : { success: true, latencyMs: 1000, ttftMs: 500, outputTokens: 50, responseText: 'hi' };

/** Force the next-due pending entry into "ready now" so processPendingConfirmations picks it up. */
function fastForward(key: string): void {
  const state = _peekAlertStateForTests();
  const p = state.pending.get(key);
  if (!p) throw new Error(`fastForward: no pending entry for ${key}`);
  p.scheduledAt = Date.now() - 1; // mutating the value object also mutates the real Map entry
}

/** Yield to the event loop so an awaited promise can advance one step. */
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  _resetAlertStateForTests();
  vi.clearAllMocks();

  h.getConfig.mockReturnValue(STANDARD_CONFIG);
  h.providerGet.mockReturnValue({ id: 'p1', name: 'TestProvider', endpoint: 'http://fake', format: 'openai' });
  h.providerGetKey.mockReturnValue('fake-key');
  h.insertPing.mockReturnValue(undefined);
  h.updateLastAlertAt.mockReturnValue(undefined);

  // Stub fetch globally so sendFeishuAlert doesn't make real HTTP calls
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ok', { status: 200 })),
  );
});

afterEach(() => {
  _resetAlertStateForTests();
  vi.unstubAllGlobals();
});

describe('alertNotifier — state coordination', () => {
  it('1) recovery cancels an in-flight down confirmation cycle', async () => {
    // Previous status = healthy → first down detection becomes a fresh "down" decision
    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    expect(_peekAlertStateForTests().pending.has(KEY)).toBe(true);

    // Hang the confirm probe so the cycle is stuck in the await window
    let resolveProbe: (v: any) => void;
    const hung = new Promise<any>((r) => {
      resolveProbe = r;
    });
    h.testProviderConnection.mockReturnValueOnce(hung);

    fastForward(KEY);
    const cycleP = processPendingConfirmations();
    await tick(); // let processPendingConfirmations move the entry into inFlight

    let state = _peekAlertStateForTests();
    expect(state.pending.size).toBe(0);
    expect(state.inFlight.has(KEY)).toBe(true);
    const tokenBeforeRecovery = state.inFlight.get(KEY);

    // Recovery fires while the down cycle's probe is still awaiting.
    // For recovery to be detected, previousStatus must be down.
    h.dbGet.mockReturnValue({ health_status: 'down' });
    await processAlert(TARGET, 'healthy', OK_METRICS);

    state = _peekAlertStateForTests();
    expect(state.inFlight.has(KEY)).toBe(false); // recovery cleared inFlight
    expect(state.pending.has(KEY)).toBe(false);

    // Recovery sent exactly one Feishu webhook call
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Now let the stale in-flight probe return — it should be DROPPED, not fire a down alert
    resolveProbe!(probeResult('down'));
    await cycleP;

    // No additional fetch calls (the stale result was discarded by the token check)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // updateLastAlertAt called exactly once (for recovery)
    expect(h.updateLastAlertAt).toHaveBeenCalledTimes(1);
    // Token was never reused — final state stays clean
    expect(_peekAlertStateForTests().inFlight.size).toBe(0);
    expect(_peekAlertStateForTests().pending.size).toBe(0);
    // Sanity: the recovery did clear what was there
    expect(tokenBeforeRecovery).toBeDefined();
  });

  it('2) inFlight gate blocks duplicate enqueue during the await window', async () => {
    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    let resolveProbe: (v: any) => void;
    h.testProviderConnection.mockReturnValueOnce(
      new Promise((r) => {
        resolveProbe = r;
      }),
    );

    fastForward(KEY);
    const cycleP = processPendingConfirmations();
    await tick();

    // Now: pending is empty (drained), inFlight holds the key
    let state = _peekAlertStateForTests();
    expect(state.pending.size).toBe(0);
    expect(state.inFlight.size).toBe(1);

    // A second scheduled probe lands during the await window with another `down`.
    // shouldSendAlert with wasDown=true (previous=down), isDown=true → reminder branch
    h.dbGet.mockReturnValue({ health_status: 'down' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    // Without inFlight gate this would have re-enqueued a fresh cycle.
    // With the gate, pending must STILL be empty (no duplicate cycle spawned).
    state = _peekAlertStateForTests();
    expect(state.pending.size).toBe(0);
    expect(state.inFlight.size).toBe(1); // still the original token

    // Cleanup
    resolveProbe!(probeResult('down'));
    await cycleP;
  });

  it('3) token mismatch drops stale write when a cycle is replaced mid-await', async () => {
    // Cycle 1 starts
    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    let resolveProbe1: (v: any) => void;
    h.testProviderConnection.mockReturnValueOnce(
      new Promise((r) => {
        resolveProbe1 = r;
      }),
    );
    fastForward(KEY);
    const cycle1P = processPendingConfirmations();
    await tick();

    const token1 = _peekAlertStateForTests().inFlight.get(KEY);
    expect(token1).toBeDefined();

    // Recovery clears inFlight (cancels cycle 1's token)
    h.dbGet.mockReturnValue({ health_status: 'down' });
    await processAlert(TARGET, 'healthy', OK_METRICS);
    expect(_peekAlertStateForTests().inFlight.has(KEY)).toBe(false);

    // New down detection enqueues cycle 2
    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);
    expect(_peekAlertStateForTests().pending.has(KEY)).toBe(true);

    // Cycle 2 picks up
    let resolveProbe2: (v: any) => void;
    h.testProviderConnection.mockReturnValueOnce(
      new Promise((r) => {
        resolveProbe2 = r;
      }),
    );
    fastForward(KEY);
    const cycle2P = processPendingConfirmations();
    await tick();

    const token2 = _peekAlertStateForTests().inFlight.get(KEY);
    expect(token2).toBeDefined();
    expect(token2).not.toBe(token1); // distinct token from cycle 1

    // Stale cycle 1's probe returns AFTER cycle 2 took over — must be dropped
    resolveProbe1!(probeResult('down'));
    await cycle1P;

    // Cycle 2's inFlight slot must still hold token 2 (cycle 1 didn't overwrite anything)
    expect(_peekAlertStateForTests().inFlight.get(KEY)).toBe(token2);
    // pending must NOT have been written by stale cycle 1
    expect(_peekAlertStateForTests().pending.has(KEY)).toBe(false);

    // Cycle 2's probe returns down — normal continue path (failCount=1 < threshold=4)
    resolveProbe2!(probeResult('down'));
    await cycle2P;

    // After cycle 2 completes one attempt, it should have rescheduled itself
    const final = _peekAlertStateForTests();
    expect(final.inFlight.has(KEY)).toBe(false); // inFlight cleared after probe
    expect(final.pending.has(KEY)).toBe(true); // re-queued for attempt 2
    const cycle2State = final.pending.get(KEY)!;
    expect(cycle2State.attempt).toBe(2);
    expect(cycle2State.failCount).toBe(1);
    expect(cycle2State.okCount).toBe(0);
  });

  it('bonus: K-of-N fires after threshold reached even with one mid-cycle ok', async () => {
    // End-to-end sanity check that confirms the K-of-N behavior end-to-end (not just unit math).
    // Sequence: down → confirm-fail → confirm-fail → confirm-ok → confirm-fail → confirm-fail = 4 fails, fires.
    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    const sequence: Array<'down' | 'ok'> = ['down', 'down', 'ok', 'down', 'down'];
    for (let i = 0; i < sequence.length; i++) {
      h.testProviderConnection.mockReturnValueOnce(Promise.resolve(probeResult(sequence[i])));
      fastForward(KEY);
      await processPendingConfirmations();
      await tick();
    }

    // After 4 fails (attempts 1, 2, 4, 5) and 1 ok (attempt 3), threshold 4 reached → alert sent
    expect(h.updateLastAlertAt).toHaveBeenCalledTimes(1);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // Cycle is fully drained after firing
    expect(_peekAlertStateForTests().pending.size).toBe(0);
    expect(_peekAlertStateForTests().inFlight.size).toBe(0);
  });

  // ── Bug #4 regression: webhook delivery failure must NOT silently record lastAlertAt ──

  it('regression #4: webhook 5xx does NOT call updateLastAlertAt and re-queues the cycle', async () => {
    // Fail the webhook with 500
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream error', { status: 500 })),
    );

    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    // Drive confirm probes until fire is triggered (threshold = 4 → fires on attempt 4)
    // Run 4 down probes, fire path executes, webhook fails, cycle is re-queued.
    for (let i = 0; i < 4; i++) {
      h.testProviderConnection.mockReturnValueOnce(Promise.resolve(probeResult('down')));
      fastForward(KEY);
      await processPendingConfirmations();
      await tick();
    }

    // Webhook delivery FAILED → must NOT record lastAlertAt
    expect(h.updateLastAlertAt).not.toHaveBeenCalled();
    // Cycle must be re-queued (attempt reset to 1) so it retries next tick
    const state = _peekAlertStateForTests();
    expect(state.pending.has(KEY)).toBe(true);
    expect(state.pending.get(KEY)!.attempt).toBe(1);
    expect(state.pending.get(KEY)!.failCount).toBe(0);
  });

  it('regression #4: webhook 4xx (bad config) also re-queues and does NOT record lastAlertAt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad Request', { status: 400 })),
    );
    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    for (let i = 0; i < 4; i++) {
      h.testProviderConnection.mockReturnValueOnce(Promise.resolve(probeResult('down')));
      fastForward(KEY);
      await processPendingConfirmations();
      await tick();
    }

    expect(h.updateLastAlertAt).not.toHaveBeenCalled();
    expect(_peekAlertStateForTests().pending.has(KEY)).toBe(true);
  });

  it('regression #4: recovery webhook failure does NOT record lastAlertAt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    // previous=down, current=healthy → recovery path
    h.dbGet.mockReturnValue({ health_status: 'down' });
    await processAlert(TARGET, 'healthy', OK_METRICS);

    expect(h.updateLastAlertAt).not.toHaveBeenCalled();
  });

  it('regression #4: successful webhook DOES record lastAlertAt (sanity)', async () => {
    // Default fetch stub in beforeEach already returns 200
    h.dbGet.mockReturnValue({ health_status: 'healthy' });
    await processAlert(TARGET, 'down', DOWN_METRICS);

    // Threshold reached at attempt 4 → fire path → webhook 200 → updateLastAlertAt
    for (let i = 0; i < 4; i++) {
      h.testProviderConnection.mockReturnValueOnce(Promise.resolve(probeResult('down')));
      fastForward(KEY);
      await processPendingConfirmations();
      await tick();
    }

    expect(h.updateLastAlertAt).toHaveBeenCalledTimes(1);
  });
});
