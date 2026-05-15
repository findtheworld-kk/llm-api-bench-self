import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMonitor } from './useMonitor';
import * as apiMod from '../services/api';

const apiFetchSpy = vi.spyOn(apiMod, 'apiFetch');

beforeEach(() => {
  vi.clearAllMocks();
  import.meta.env.VITE_DEMO_MODE = 'false';
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const pingOK = {
  id: 1,
  providerId: 'p1',
  providerName: 'OpenAI',
  modelName: 'gpt-4',
  status: 'ok' as const,
  healthStatus: 'healthy' as const,
  latencyMs: 200,
  ttftMs: 50,
  outputTokens: 10,
  checkedAt: '2026-05-15T00:00:00Z',
};

describe('useMonitor.fetchStatus', () => {
  it('populates statuses on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([pingOK]));
    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.fetchStatus();
    });
    expect(result.current.statuses).toHaveLength(1);
    expect(result.current.statuses[0].providerName).toBe('OpenAI');
  });

  it('silently no-ops on error (does not throw)', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useMonitor());
    await expect(
      act(async () => {
        await result.current.fetchStatus();
      }),
    ).resolves.toBeUndefined();
    expect(result.current.statuses).toEqual([]);
  });
});

describe('useMonitor.fetchHistory', () => {
  it('uses default hours=24', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([pingOK]));
    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.fetchHistory();
    });
    expect(apiFetchSpy.mock.calls[0][0]).toBe('/api/monitor/history?hours=24');
  });

  it('passes custom hours value', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([]));
    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.fetchHistory(48);
    });
    expect(apiFetchSpy.mock.calls[0][0]).toBe('/api/monitor/history?hours=48');
  });
});

describe('useMonitor.fetchTargets', () => {
  it('populates targets', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      jsonResp([{ providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI', alertEnabled: true }]),
    );
    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.fetchTargets();
    });
    expect(result.current.targets).toHaveLength(1);
  });
});

describe('useMonitor.fetchConfig', () => {
  it('populates globalConfig', async () => {
    apiFetchSpy.mockResolvedValueOnce(
      jsonResp({
        defaultIntervalMinutes: 5,
        healthThresholds: { tpsSlowThreshold: 30, tpsVerySlowThreshold: 10, ttftSlowMs: 500, minOutputTokens: 1 },
      }),
    );
    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.fetchConfig();
    });
    expect(result.current.globalConfig.defaultIntervalMinutes).toBe(5);
  });
});

describe('useMonitor.saveConfig', () => {
  it('PUTs the config and updates local state on 200', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true }));
    const { result } = renderHook(() => useMonitor());
    const newCfg = {
      defaultIntervalMinutes: 15,
      healthThresholds: { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 },
    };
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.saveConfig(newCfg);
    });
    expect(ok).toBe(true);
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/monitor/config', expect.objectContaining({ method: 'PUT' }));
    expect(result.current.globalConfig.defaultIntervalMinutes).toBe(15);
  });

  // Bug #8 regression: phantom save — non-2xx response must NOT update local state
  it('regression #8: 4xx response does NOT update globalConfig (no phantom save)', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'invalid threshold' }, 400));
    const { result } = renderHook(() => useMonitor());
    const before = result.current.globalConfig.defaultIntervalMinutes;
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.saveConfig({
        defaultIntervalMinutes: 999,
        healthThresholds: { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 },
      });
    });
    expect(ok).toBe(false);
    expect(result.current.globalConfig.defaultIntervalMinutes).toBe(before);
  });

  it('regression #8: 5xx response does NOT update globalConfig', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({}, 500));
    const { result } = renderHook(() => useMonitor());
    const before = result.current.globalConfig.defaultIntervalMinutes;
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.saveConfig({
        defaultIntervalMinutes: 30,
        healthThresholds: { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 },
      });
    });
    expect(ok).toBe(false);
    expect(result.current.globalConfig.defaultIntervalMinutes).toBe(before);
  });

  it('regression #8: thrown error returns false', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useMonitor());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.saveConfig({
        defaultIntervalMinutes: 30,
        healthThresholds: { tpsSlowThreshold: 20, tpsVerySlowThreshold: 5, ttftSlowMs: 1000, minOutputTokens: 1 },
      });
    });
    expect(ok).toBe(false);
  });
});

describe('useMonitor.saveTargets', () => {
  it('PUTs the targets array and updates state', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true }));
    const { result } = renderHook(() => useMonitor());
    const targets = [{ providerId: 'p1', modelName: 'gpt-4', providerName: 'OpenAI' }];
    await act(async () => {
      await result.current.saveTargets(targets);
    });
    expect(result.current.targets).toEqual(targets);
  });

  it('throws on non-2xx with server error message', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'duplicate target' }, 400));
    const { result } = renderHook(() => useMonitor());
    await expect(
      act(async () => {
        await result.current.saveTargets([]);
      }),
    ).rejects.toThrow(/duplicate target/);
  });

  it('falls back to generic message when body has no error field', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp('plain text', 500));
    const { result } = renderHook(() => useMonitor());
    await expect(
      act(async () => {
        await result.current.saveTargets([]);
      }),
    ).rejects.toThrow(/Save failed/);
  });
});

describe('useMonitor.triggerRun', () => {
  it('sets running=true during the call then false after', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true, results: [pingOK] }));
    apiFetchSpy.mockResolvedValueOnce(jsonResp([])); // fetchHistory
    const { result } = renderHook(() => useMonitor());
    expect(result.current.running).toBe(false);
    await act(async () => {
      await result.current.triggerRun();
    });
    expect(result.current.running).toBe(false);
    expect(result.current.statuses).toHaveLength(1);
  });

  it('still resets running on thrown error', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.triggerRun();
    });
    expect(result.current.running).toBe(false);
  });

  it('does NOT update statuses when data.success=false', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false }));
    apiFetchSpy.mockResolvedValueOnce(jsonResp([]));
    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.triggerRun();
    });
    expect(result.current.statuses).toEqual([]);
  });
});

describe('useMonitor.fetchAll', () => {
  it('fans out to all four fetches in parallel and toggles loading', async () => {
    apiFetchSpy
      .mockResolvedValueOnce(jsonResp([pingOK]))
      .mockResolvedValueOnce(jsonResp([]))
      .mockResolvedValueOnce(jsonResp([]))
      .mockResolvedValueOnce(jsonResp({ defaultIntervalMinutes: 10, healthThresholds: {} }));

    const { result } = renderHook(() => useMonitor());
    await act(async () => {
      await result.current.fetchAll();
    });
    expect(apiFetchSpy).toHaveBeenCalledTimes(4);
    expect(result.current.loading).toBe(false);
  });
});
