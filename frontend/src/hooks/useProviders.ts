import { useState, useCallback } from 'react';
import { ProviderConfigResponse, ProviderConfigInput, TestConnectionResult, DiscoveredModel } from '../types';
import { apiFetch } from '../services/api';
import { maskProviderConfig } from '../utils/demo';

const API_BASE = '/api';

export function useProviders() {
  const [providers, setProviders] = useState<ProviderConfigResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/providers`);
      if (!res.ok) throw new Error('Failed to fetch providers');
      const data = (await res.json()) as ProviderConfigResponse[];
      const masked = data.map(maskProviderConfig);
      setProviders(masked);
      return masked;
    } catch (err: any) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const createProvider = useCallback(async (input: ProviderConfigInput): Promise<ProviderConfigResponse | null> => {
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create provider');
      }
      const provider = maskProviderConfig((await res.json()) as ProviderConfigResponse);
      setProviders((prev) => [provider, ...prev]);
      return provider;
    } catch (err: any) {
      setError(err.message);
      return null;
    }
  }, []);

  const updateProvider = useCallback(
    async (id: string, input: Partial<ProviderConfigInput>): Promise<ProviderConfigResponse | null> => {
      setError(null);
      try {
        const res = await apiFetch(`${API_BASE}/providers/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to update provider');
        }
        const updated = maskProviderConfig((await res.json()) as ProviderConfigResponse);
        setProviders((prev) => prev.map((p) => (p.id === id ? updated : p)));
        return updated;
      } catch (err: any) {
        setError(err.message);
        return null;
      }
    },
    [],
  );

  const deleteProvider = useCallback(async (id: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/providers/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete provider');
      setProviders((prev) => prev.filter((p) => p.id !== id));
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }, []);

  const testConnection = useCallback(async (id: string, modelName?: string): Promise<TestConnectionResult | null> => {
    try {
      const res = await apiFetch(`${API_BASE}/providers/${id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName }),
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, latencyMs: 0, error: err.message };
    }
  }, []);

  const testRawConnection = useCallback(
    async (config: {
      endpoint: string;
      apiKey: string;
      format: string;
      modelName: string;
    }): Promise<TestConnectionResult | null> => {
      try {
        const res = await apiFetch(`${API_BASE}/providers/test-connection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        return await res.json();
      } catch (err: any) {
        return { success: false, latencyMs: 0, error: err.message };
      }
    },
    [],
  );

  /**
   * Ask the upstream which models it serves. For a saved provider the stored key
   * is used unless the form carries a freshly typed one.
   */
  const discoverModels = useCallback(
    async (input: {
      id?: string | null;
      endpoint: string;
      apiKey: string;
      format: string;
    }): Promise<{ models: DiscoveredModel[]; error?: string }> => {
      const url = input.id ? `${API_BASE}/providers/${input.id}/discover-models` : `${API_BASE}/providers/discover-models`;
      try {
        const res = await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: input.endpoint, apiKey: input.apiKey, format: input.format }),
        });
        const data = await res.json();
        if (!res.ok) return { models: [], error: data.error || 'Model discovery failed' };
        return { models: (data.models || []) as DiscoveredModel[] };
      } catch (err: any) {
        return { models: [], error: err.message };
      }
    },
    [],
  );

  return {
    providers,
    loading,
    error,
    fetchProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testConnection,
    testRawConnection,
    discoverModels,
  };
}
