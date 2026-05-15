import { describe, it, expect } from 'vitest';
import { classifyHealthWithThresholds } from './monitorScheduler';

/**
 * Health classification is the foundation of every alert decision: every probe
 * outcome flows through this function and the resulting status drives down/recovery/reminder
 * logic in alertNotifier. Tests focus on threshold boundaries (exact equality, just-below,
 * just-above), zero/edge inputs, and precedence between rules.
 */

const THRESHOLDS = {
  tpsSlowThreshold: 20, // tps < 20 → slow (if tps > 0)
  tpsVerySlowThreshold: 5, // tps < 5 → very_slow (if tps > 0); takes priority over slow
  ttftSlowMs: 1000, // ttft >= 1000 → slow (only checked after tps rules)
  minOutputTokens: 1, // outputTokens > 0 but < this → down
};

const call = (status: string, latencyMs: number, ttftMs: number, outputTokens: number) =>
  classifyHealthWithThresholds(status, latencyMs, ttftMs, outputTokens, THRESHOLDS);

describe('classifyHealth — error/timeout always down', () => {
  it("status='error' returns down regardless of other fields", () => {
    expect(call('error', 100, 100, 100)).toBe('down');
    expect(call('error', 0, 0, 0)).toBe('down');
  });

  it("status='timeout' returns down regardless of other fields", () => {
    expect(call('timeout', 100, 100, 100)).toBe('down');
  });

  it('unknown status falls through to the metric-based rules (not auto-down)', () => {
    // 'unknown' is not 'error' or 'timeout' — treated as success-shaped path
    expect(call('unknown', 1000, 100, 50)).toBe('healthy');
  });
});

describe('classifyHealth — minOutputTokens guard', () => {
  it('outputTokens=0 does NOT trigger down (non-streaming path may report 0)', () => {
    // outputTokens > 0 is the gate; 0 means "we have no token count, assume ok"
    expect(call('ok', 1000, 100, 0)).toBe('healthy');
  });

  it('outputTokens exactly at minOutputTokens (=1) is not below → continues to tps/ttft', () => {
    // tps = 1/1000*1000 = 1, which is < tpsVerySlowThreshold(5) → very_slow
    expect(call('ok', 1000, 100, 1)).toBe('very_slow');
  });

  it('outputTokens just below higher minOutputTokens returns down', () => {
    const t = { ...THRESHOLDS, minOutputTokens: 10 };
    expect(classifyHealthWithThresholds('ok', 1000, 100, 9, t)).toBe('down');
  });

  it('outputTokens exactly at higher minOutputTokens passes guard', () => {
    const t = { ...THRESHOLDS, minOutputTokens: 10 };
    // outputTokens=10, latency=10 → tps=1000, fast. ttft=100 < 1000 → healthy
    expect(classifyHealthWithThresholds('ok', 10, 100, 10, t)).toBe('healthy');
  });
});

describe('classifyHealth — tps boundaries', () => {
  it('tps just below very_slow threshold (4.99) returns very_slow', () => {
    // outputTokens / latencyMs * 1000 = 499/100000*1000 = 4.99
    expect(call('ok', 100000, 100, 499)).toBe('very_slow');
  });

  it('tps exactly equal to very_slow threshold (5.0) is NOT very_slow → falls into slow band', () => {
    // tps = 500/100000*1000 = 5 → not < 5; check next: 5 < 20 → slow
    expect(call('ok', 100000, 100, 500)).toBe('slow');
  });

  it('tps just above very_slow threshold (5.01) → slow', () => {
    // outputTokens=501, latency=100000 → tps=5.01
    expect(call('ok', 100000, 100, 501)).toBe('slow');
  });

  it('tps just below slow threshold (19.99) → slow', () => {
    expect(call('ok', 100000, 100, 1999)).toBe('slow');
  });

  it('tps exactly equal to slow threshold (20.0) is NOT slow by tps rule → check ttft', () => {
    // tps=20, NOT < 20. ttft=100 < 1000 → healthy
    expect(call('ok', 100000, 100, 2000)).toBe('healthy');
  });

  it('tps just above slow threshold (20.01) → healthy (ignores ttft if fast)', () => {
    expect(call('ok', 100000, 100, 2001)).toBe('healthy');
  });

  it('tps=0 (latencyMs=0 special case) skips tps rules and checks ttft only', () => {
    // latencyMs=0 → tps=0 → skip tps gates. ttft=100 < 1000 → healthy
    expect(call('ok', 0, 100, 50)).toBe('healthy');
  });

  it('tps=0 (latencyMs=0) with slow ttft → slow (ttft rule kicks in)', () => {
    expect(call('ok', 0, 1500, 50)).toBe('slow');
  });
});

describe('classifyHealth — ttft boundary (only when tps rules do not classify)', () => {
  it('ttft just below ttftSlowMs (999) returns healthy', () => {
    // outputTokens=0 to bypass tps rules; ttft<1000 → healthy
    expect(call('ok', 1000, 999, 0)).toBe('healthy');
  });

  it('ttft exactly equal to ttftSlowMs (1000) returns slow', () => {
    expect(call('ok', 1000, 1000, 0)).toBe('slow');
  });

  it('ttft just above ttftSlowMs (1001) returns slow', () => {
    expect(call('ok', 1000, 1001, 0)).toBe('slow');
  });

  it('very high ttft still only escalates to slow (not down/very_slow)', () => {
    expect(call('ok', 1000, 999999, 0)).toBe('slow');
  });
});

describe('classifyHealth — precedence rules', () => {
  it('error overrides everything (even with healthy-shaped metrics)', () => {
    expect(call('error', 1, 1, 100)).toBe('down');
  });

  it('low tps wins over slow ttft (tps checked first → very_slow, not slow)', () => {
    // tps = 100/100000*1000 = 1 → very_slow. ttft slow too, but very_slow wins.
    expect(call('ok', 100000, 5000, 100)).toBe('very_slow');
  });

  it('mid tps (slow band) wins over slow ttft (still classifies as slow either way, but via tps rule)', () => {
    expect(call('ok', 1000, 5000, 10)).toBe('slow'); // tps=10 → slow band
  });

  it('healthy tps + fast ttft → healthy', () => {
    expect(call('ok', 1000, 100, 100)).toBe('healthy'); // tps=100, well above 20
  });

  it('outputTokens guard (=down) wins over fast metrics', () => {
    const t = { ...THRESHOLDS, minOutputTokens: 100 };
    expect(classifyHealthWithThresholds('ok', 1, 1, 50, t)).toBe('down');
  });
});

describe('classifyHealth — pathological inputs', () => {
  it('negative latency does not crash (tps would be negative; skipped by tps>0 guard)', () => {
    // tps = 100/-100*1000 = -1000, NOT > 0 → tps gates skipped. ttft=100 → healthy
    expect(call('ok', -100, 100, 100)).toBe('healthy');
  });

  it('extremely large outputTokens / tiny latency → very high tps → healthy', () => {
    expect(call('ok', 1, 100, 1_000_000)).toBe('healthy');
  });

  it('all zeros → healthy (no triggers)', () => {
    expect(call('ok', 0, 0, 0)).toBe('healthy');
  });

  it('threshold object with all-zero values: nothing trips (degenerate but well-defined)', () => {
    const t = { tpsSlowThreshold: 0, tpsVerySlowThreshold: 0, ttftSlowMs: 0, minOutputTokens: 0 };
    // ttftSlowMs=0 means ttft >= 0 → always slow (unless tps rules already classified)
    // outputTokens=0 skips tps rules. ttft=0 >= 0 → slow
    expect(classifyHealthWithThresholds('ok', 0, 0, 0, t)).toBe('slow');
  });
});
