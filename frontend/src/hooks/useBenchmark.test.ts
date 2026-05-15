import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchSpy = vi.hoisted(() => vi.fn());
const sseUrlSpy = vi.hoisted(() => vi.fn(async (u: string) => u));
const downloadUrlSpy = vi.hoisted(() => vi.fn(async (u: string) => u));

vi.mock('../services/api', () => ({
  apiFetch: apiFetchSpy,
  sseUrl: sseUrlSpy,
  downloadUrl: downloadUrlSpy,
  getToken: () => null,
  setToken: () => {},
  clearToken: () => {},
  isAuthenticated: () => false,
}));

import { useBenchmark } from './useBenchmark';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Minimal mock EventSource. Tests grab the instance via the constructor's mock. */
class MockEventSource {
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  static instances: MockEventSource[] = [];
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  /** Test helper — push a parsed message. */
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances = [];
  (globalThis as { EventSource: typeof EventSource }).EventSource = MockEventSource as never;
  sseUrlSpy.mockImplementation(async (u) => u);
  downloadUrlSpy.mockImplementation(async (u) => u);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useBenchmark.fetchBenchmarks', () => {
  it('populates benchmarks on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([{ id: 'r1', status: 'completed' }]));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.fetchBenchmarks();
    });
    expect(result.current.benchmarks).toHaveLength(1);
  });

  it('returns empty array and sets error on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useBenchmark());
    let returned!: Awaited<ReturnType<typeof result.current.fetchBenchmarks>>;
    await act(async () => {
      returned = await result.current.fetchBenchmarks();
    });
    expect(returned).toEqual([]);
    expect(result.current.error).toBe('Failed to fetch benchmarks');
  });

  // Bug #3 regression: state pollution from non-array responses
  it('regression #3: 500 with non-array body does NOT poison state', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'server' }, 500));
    const { result } = renderHook(() => useBenchmark());
    let returned!: Awaited<ReturnType<typeof result.current.fetchBenchmarks>>;
    await act(async () => {
      returned = await result.current.fetchBenchmarks();
    });
    expect(returned).toEqual([]);
    expect(result.current.benchmarks).toEqual([]); // NOT polluted by {error:...}
    expect(result.current.error).toContain('500');
  });

  it('regression #3: 200 with non-array body rejects + sets error', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'wrong shape' }, 200));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.fetchBenchmarks();
    });
    expect(result.current.benchmarks).toEqual([]);
    expect(result.current.error).toContain('shape');
  });
});

describe('useBenchmark.fetchBenchmark', () => {
  it('sets currentRun', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'r1' }));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.fetchBenchmark('r1');
    });
    expect(result.current.currentRun).toEqual({ id: 'r1' });
  });

  it('sets error on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.fetchBenchmark('r1');
    });
    expect(result.current.error).toBe('Failed to fetch benchmark');
  });

  // Bug #3 regression
  it('regression #3: 404 does NOT set currentRun', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'not found' }, 404));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.fetchBenchmark('absent');
    });
    expect(result.current.currentRun).toBeNull();
    expect(result.current.error).toContain('404');
  });

  it('regression #3: array body rejected (wrong shape)', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp([1, 2, 3]));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.fetchBenchmark('r1');
    });
    expect(result.current.currentRun).toBeNull();
    expect(result.current.error).toContain('shape');
  });
});

describe('useBenchmark.startBenchmark — EventSource lifecycle', () => {
  it('opens EventSource at the right URL and sets isRunning=true', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'new-run' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'new-run', status: 'pending' })); // fetchBenchmark
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['p1:gpt-4'], {} as never, {});
    });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/benchmarks/new-run/stream');
    expect(result.current.isRunning).toBe(true);
  });

  it('on "done" event: closes the source, flips isRunning=false, refreshes data', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'r1' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1' }));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['p1:gpt-4'], {} as never, {});
    });

    const es = MockEventSource.instances[0];
    await act(async () => {
      es.emit({ type: 'done', data: {} });
    });
    await waitFor(() => expect(result.current.isRunning).toBe(false));
    expect(es.closed).toBe(true);
  });

  it('on "progress" event: refreshes the current run', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'r1' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1', status: 'running' }));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['p1:gpt-4'], {} as never, {});
    });

    apiFetchSpy.mockClear();
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1', status: 'running' }));
    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'progress', data: {} });
    });
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled());
  });

  it('on "error" event with "cancelled" message: sets error="Benchmark cancelled"', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'r1' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1' }));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['p1:gpt-4'], {} as never, {});
    });

    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'error', data: { message: 'cancelled by user' } });
    });
    expect(result.current.error).toBe('Benchmark cancelled');
  });

  it('on EventSource onerror: closes source and flips isRunning=false', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'r1' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1' }));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['p1:gpt-4'], {} as never, {});
    });

    await act(async () => {
      MockEventSource.instances[0].onerror?.(new Event('error'));
    });
    await waitFor(() => expect(result.current.isRunning).toBe(false));
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it('on non-2xx start: sets error and isRunning=false (no EventSource opened)', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ error: 'invalid provider' }, 400));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['bad'], {} as never, {});
    });
    expect(result.current.error).toBe('invalid provider');
    expect(result.current.isRunning).toBe(false);
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('exposes eventSourceRef for external inspection', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'r1' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1' }));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['p1:gpt-4'], {} as never, {});
    });
    expect(result.current.eventSourceRef.current).toBe(MockEventSource.instances[0]);
  });
});

describe('useBenchmark.cancelBenchmark', () => {
  it('closes the SSE and returns true on success', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ id: 'r1' }, 201));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1' }));
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.startBenchmark(['p1:gpt-4'], {} as never, {});
    });

    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: true }));
    apiFetchSpy.mockResolvedValue(jsonResp({ id: 'r1' }));
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.cancelBenchmark('r1');
    });
    expect(ok).toBe(true);
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(result.current.isRunning).toBe(false);
  });

  it('returns false when server responds success:false', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResp({ success: false }));
    const { result } = renderHook(() => useBenchmark());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.cancelBenchmark('r1');
    });
    expect(ok).toBe(false);
  });

  it('returns false and sets error on throw', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => useBenchmark());
    let ok!: boolean;
    await act(async () => {
      ok = await result.current.cancelBenchmark('r1');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('Failed to cancel benchmark');
  });
});

describe('useBenchmark.exportBenchmark', () => {
  it('opens the download URL in a new tab', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useBenchmark());
    await act(async () => {
      await result.current.exportBenchmark('r1', 'csv');
    });
    expect(openSpy).toHaveBeenCalledWith('/api/benchmarks/r1/export?format=csv', '_blank');
  });
});
