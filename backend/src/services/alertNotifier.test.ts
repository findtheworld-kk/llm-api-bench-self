import { describe, it, expect } from 'vitest';
import { evaluateConfirmation, decideAlertType } from './alertNotifier';
import { clampFailThreshold } from './monitorConfigStore';

/**
 * Decision-table tests for the K-of-N confirmation rule.
 * Locks in the fix for the regression where a single transient ok response
 * abandoned the entire confirmation chain ("Confirmation check passed at attempt N/M, skipping alert").
 */
describe('evaluateConfirmation — K-of-N voting', () => {
  const base = { maxAttempts: 5, failThreshold: 4, prevFailCount: 0, prevOkCount: 0 };

  it('fires immediately when this attempt completes the threshold (4/5 fails)', () => {
    const d = evaluateConfirmation({ ...base, attempt: 4, prevFailCount: 3, prevOkCount: 0, isDownThisAttempt: true });
    expect(d.kind).toBe('fire');
  });

  it('fires on the 5th attempt when first 4 included one ok (4 fails total)', () => {
    // attempts 1-4: 3 fails, 1 ok. Attempt 5 fails -> 4 fails, fires.
    const d = evaluateConfirmation({ ...base, attempt: 5, prevFailCount: 3, prevOkCount: 1, isDownThisAttempt: true });
    expect(d.kind).toBe('fire');
  });

  it('does NOT fire on a single ok mid-chain (regression: was passed→abandon)', () => {
    // attempt 2 of 5: previous was 1 fail. This attempt is ok (transient flicker).
    const d = evaluateConfirmation({ ...base, attempt: 2, prevFailCount: 1, prevOkCount: 0, isDownThisAttempt: false });
    expect(d.kind).toBe('continue');
    if (d.kind === 'continue') {
      expect(d.failCount).toBe(1);
      expect(d.okCount).toBe(1);
      expect(d.nextAttempt).toBe(3);
    }
  });

  it('abandons early when threshold becomes mathematically unreachable', () => {
    // 5-attempt cycle, threshold 4. After 2 attempts with 0 fails, max possible fails = 0 + 3 = 3 < 4.
    const d = evaluateConfirmation({ ...base, attempt: 2, prevFailCount: 0, prevOkCount: 1, isDownThisAttempt: false });
    expect(d.kind).toBe('abandon');
  });

  it('continues when threshold is still reachable', () => {
    // attempt 3 of 5: 2 fails, 0 ok so far, this fails. failCount=3, remaining=2, can still hit 4.
    const d = evaluateConfirmation({ ...base, attempt: 3, prevFailCount: 2, prevOkCount: 0, isDownThisAttempt: true });
    expect(d.kind).toBe('continue');
    if (d.kind === 'continue') expect(d.failCount).toBe(3);
  });

  it('abandons on final attempt without reaching threshold', () => {
    // attempt 5 of 5: 3 fails, 1 ok before. This is ok. failCount=3 < 4, remaining=0.
    const d = evaluateConfirmation({ ...base, attempt: 5, prevFailCount: 3, prevOkCount: 1, isDownThisAttempt: false });
    expect(d.kind).toBe('abandon');
  });

  it('strict 5-of-5 mode: a single ok abandons (back-compat for users who set threshold=N)', () => {
    const d = evaluateConfirmation({
      ...base,
      failThreshold: 5,
      attempt: 2,
      prevFailCount: 1,
      prevOkCount: 0,
      isDownThisAttempt: false,
    });
    expect(d.kind).toBe('abandon');
  });

  it('lenient 1-of-5 mode: first failed attempt fires immediately', () => {
    const d = evaluateConfirmation({
      ...base,
      failThreshold: 1,
      attempt: 1,
      prevFailCount: 0,
      prevOkCount: 0,
      isDownThisAttempt: true,
    });
    expect(d.kind).toBe('fire');
  });

  it('lenient 1-of-5 mode: first ok attempt abandons (1 + 4 remaining = 5 >= 1, but ok... wait)', () => {
    // failThreshold=1, attempt=1, this is ok. failCount=0, remaining=4. 0+4=4 >= 1, so continue.
    const d = evaluateConfirmation({
      ...base,
      failThreshold: 1,
      attempt: 1,
      prevFailCount: 0,
      prevOkCount: 0,
      isDownThisAttempt: false,
    });
    expect(d.kind).toBe('continue');
  });

  it('handles the "alternating" anti-flap case (fail-ok-fail-ok-fail = 3 fails, no alert at threshold 4)', () => {
    // Simulate: f, o, f, o, f. After attempt 5: failCount=3, okCount=2. 3 < 4 -> abandon.
    const d = evaluateConfirmation({ ...base, attempt: 5, prevFailCount: 2, prevOkCount: 2, isDownThisAttempt: true });
    expect(d.kind).toBe('abandon');
  });
});

describe('clampFailThreshold', () => {
  it('clamps undefined to N-1 (default behavior)', () => {
    expect(clampFailThreshold(undefined, 5)).toBe(4);
    expect(clampFailThreshold(undefined, 1)).toBe(1);
  });

  it('clamps NaN/Infinity to N-1', () => {
    expect(clampFailThreshold(NaN, 5)).toBe(4);
    expect(clampFailThreshold(Infinity, 5)).toBe(4);
  });

  it('clamps below 1 to 1', () => {
    expect(clampFailThreshold(0, 5)).toBe(1);
    expect(clampFailThreshold(-3, 5)).toBe(1);
  });

  it('clamps above N to N', () => {
    expect(clampFailThreshold(99, 5)).toBe(5);
    expect(clampFailThreshold(6, 5)).toBe(5);
  });

  it('rounds non-integers', () => {
    expect(clampFailThreshold(3.4, 5)).toBe(3);
    expect(clampFailThreshold(3.6, 5)).toBe(4);
  });

  it('preserves valid threshold within [1, N]', () => {
    expect(clampFailThreshold(3, 5)).toBe(3);
    expect(clampFailThreshold(1, 5)).toBe(1);
    expect(clampFailThreshold(5, 5)).toBe(5);
  });
});

/**
 * Decision-table tests for the down/recovery/reminder state machine.
 * Boundary focus: exact transitions, the very_slow-as-down treatment, and the
 * reminder cooldown boundary (just below / just above the reminder window).
 */
describe('decideAlertType — state transitions', () => {
  const REM = 360; // minutes
  const FIXED_NOW = Date.parse('2026-05-15T01:00:00Z');

  it('returns null when previousStatus is null (no history yet — never alert on first ping)', () => {
    expect(
      decideAlertType({ previousStatus: null, currentStatus: 'down', lastAlertAt: null, reminderMinutes: REM }),
    ).toBeNull();
  });

  it('healthy → healthy: no alert', () => {
    expect(
      decideAlertType({ previousStatus: 'healthy', currentStatus: 'healthy', lastAlertAt: null, reminderMinutes: REM }),
    ).toBeNull();
  });

  it('healthy → slow: no alert (slow is not down)', () => {
    expect(
      decideAlertType({ previousStatus: 'healthy', currentStatus: 'slow', lastAlertAt: null, reminderMinutes: REM }),
    ).toBeNull();
  });

  it('slow → healthy: no alert (slow was never down)', () => {
    expect(
      decideAlertType({ previousStatus: 'slow', currentStatus: 'healthy', lastAlertAt: null, reminderMinutes: REM }),
    ).toBeNull();
  });

  it('healthy → down: fires down alert', () => {
    const d = decideAlertType({
      previousStatus: 'healthy',
      currentStatus: 'down',
      lastAlertAt: null,
      reminderMinutes: REM,
    });
    expect(d).toEqual({ send: true, type: 'down' });
  });

  it('healthy → very_slow: fires down alert (very_slow counts as down)', () => {
    const d = decideAlertType({
      previousStatus: 'healthy',
      currentStatus: 'very_slow',
      lastAlertAt: null,
      reminderMinutes: REM,
    });
    expect(d).toEqual({ send: true, type: 'down' });
  });

  it('slow → down: fires down alert (slow→down is a transition)', () => {
    const d = decideAlertType({
      previousStatus: 'slow',
      currentStatus: 'down',
      lastAlertAt: null,
      reminderMinutes: REM,
    });
    expect(d).toEqual({ send: true, type: 'down' });
  });

  it('down → healthy: fires recovery', () => {
    const d = decideAlertType({
      previousStatus: 'down',
      currentStatus: 'healthy',
      lastAlertAt: '2026-05-15T00:00:00Z',
      reminderMinutes: REM,
    });
    expect(d).toEqual({ send: true, type: 'recovery' });
  });

  it('down → slow: fires recovery (slow is not down)', () => {
    const d = decideAlertType({
      previousStatus: 'down',
      currentStatus: 'slow',
      lastAlertAt: null,
      reminderMinutes: REM,
    });
    expect(d).toEqual({ send: true, type: 'recovery' });
  });

  it('very_slow → slow: fires recovery (very_slow→slow is climbing out of down)', () => {
    const d = decideAlertType({
      previousStatus: 'very_slow',
      currentStatus: 'slow',
      lastAlertAt: null,
      reminderMinutes: REM,
    });
    expect(d).toEqual({ send: true, type: 'recovery' });
  });

  it('down → very_slow: no recovery (both still in down family)', () => {
    // wasDown=true, isDown=true → fall through to reminder logic
    expect(
      decideAlertType({
        previousStatus: 'down',
        currentStatus: 'very_slow',
        lastAlertAt: new Date(FIXED_NOW).toISOString(),
        reminderMinutes: REM,
        now: FIXED_NOW,
      }),
    ).toBeNull();
  });
});

describe('decideAlertType — reminder cooldown boundary', () => {
  const REM = 360; // minutes
  const NOW = Date.parse('2026-05-15T06:00:00Z');

  it('down → down with no lastAlertAt fires reminder immediately', () => {
    const d = decideAlertType({
      previousStatus: 'down',
      currentStatus: 'down',
      lastAlertAt: null,
      reminderMinutes: REM,
      now: NOW,
    });
    expect(d).toEqual({ send: true, type: 'reminder' });
  });

  it('down → down with lastAlertAt just below window (359 min ago) returns null', () => {
    const lastAlert = new Date(NOW - 359 * 60 * 1000).toISOString();
    expect(
      decideAlertType({
        previousStatus: 'down',
        currentStatus: 'down',
        lastAlertAt: lastAlert,
        reminderMinutes: REM,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('down → down with lastAlertAt EXACTLY at the window boundary (360 min ago) fires reminder', () => {
    const lastAlert = new Date(NOW - 360 * 60 * 1000).toISOString();
    const d = decideAlertType({
      previousStatus: 'down',
      currentStatus: 'down',
      lastAlertAt: lastAlert,
      reminderMinutes: REM,
      now: NOW,
    });
    expect(d).toEqual({ send: true, type: 'reminder' });
  });

  it('down → down with lastAlertAt past the window (361 min ago) fires reminder', () => {
    const lastAlert = new Date(NOW - 361 * 60 * 1000).toISOString();
    const d = decideAlertType({
      previousStatus: 'down',
      currentStatus: 'down',
      lastAlertAt: lastAlert,
      reminderMinutes: REM,
      now: NOW,
    });
    expect(d).toEqual({ send: true, type: 'reminder' });
  });

  it('very_slow → very_slow (both down-family) with stale lastAlertAt fires reminder', () => {
    const lastAlert = new Date(NOW - 500 * 60 * 1000).toISOString();
    const d = decideAlertType({
      previousStatus: 'very_slow',
      currentStatus: 'very_slow',
      lastAlertAt: lastAlert,
      reminderMinutes: REM,
      now: NOW,
    });
    expect(d).toEqual({ send: true, type: 'reminder' });
  });

  it('undefined lastAlertAt is treated the same as null (no prior alert → reminder fires)', () => {
    const d = decideAlertType({
      previousStatus: 'down',
      currentStatus: 'down',
      lastAlertAt: undefined,
      reminderMinutes: REM,
      now: NOW,
    });
    expect(d).toEqual({ send: true, type: 'reminder' });
  });

  it('reminderMinutes=0 always fires reminder (corner config)', () => {
    const lastAlert = new Date(NOW - 1000).toISOString();
    const d = decideAlertType({
      previousStatus: 'down',
      currentStatus: 'down',
      lastAlertAt: lastAlert,
      reminderMinutes: 0,
      now: NOW,
    });
    expect(d).toEqual({ send: true, type: 'reminder' });
  });
});
