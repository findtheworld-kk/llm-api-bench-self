import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ProviderConfigResponse, DiscoveredModel } from '../types';
import { useProviders } from '../hooks/useProviders';
import { Button, Input, InputNumber, Select, Checkbox, Popconfirm, Alert, Tag, Modal } from '../antdImports';
import { PlusOutlined, ApiOutlined, CloudDownloadOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';
import { apiFetch } from '../services/api';
import { APP_VERSION } from '../constants';
import { validateProviderName, validateModelId, validateDisplayName } from '../utils/validation';

interface ModelFormData {
  name: string;
  displayName: string;
  contextSize: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  isActive: boolean;
}

interface ProviderFormData {
  name: string;
  endpoint: string;
  apiKey: string;
  format: string;
  models: ModelFormData[];
}

/** One line in the model list: either a configured model, an upstream-only one, or both. */
interface ModelRow {
  key: string;
  index: number;
  name: string;
  model: ModelFormData | null;
  upstream?: DiscoveredModel;
  selected: boolean;
}

/** 1048576 -> "1M", 200000 -> "200K" — context sizes are read, not compared digit by digit. */
function formatContext(size?: number): string | null {
  if (!size || size <= 0) return null;
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(size % 1_000_000 ? 1 : 0)}M`;
  if (size >= 1000) return `${Math.round(size / 1000)}K`;
  return String(size);
}

const EMPTY_MODEL: ModelFormData = {
  name: '',
  displayName: '',
  contextSize: 4096,
  supportsVision: false,
  supportsTools: false,
  supportsStreaming: true,
  isActive: true,
};

const EMPTY_FORM: ProviderFormData = {
  name: '',
  endpoint: '',
  apiKey: '',
  format: 'openai',
  models: [],
};

export function SettingsPage() {
  const { t } = useTranslation();
  const {
    providers,
    loading,
    error: providerError,
    fetchProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testConnection,
    testRawConnection: _testRawConnection,
    discoverModels,
  } = useProviders();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormData>({ ...EMPTY_FORM });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    success: boolean;
    latencyMs: number;
    error?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [monitoredModels, setMonitoredModels] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const resetModelBrowser = () => {
    setDiscovered(null);
    setDiscovering(false);
    setDiscoverError(null);
    setModelFilter('');
    setOnlySelected(false);
    setExpandedRow(null);
    setMonitoredModels(new Set());
  };

  /** Which of this provider's models the monitor is already checking — shown as a row tag. */
  const loadMonitoredModels = async (providerId: string) => {
    try {
      const res = await apiFetch('/api/monitor/targets');
      if (!res.ok) return;
      const targets = (await res.json()) as Array<{ providerId: string; modelName: string }>;
      setMonitoredModels(new Set(targets.filter((x) => x.providerId === providerId).map((x) => x.modelName)));
    } catch {
      // The tag is a nicety — never block the form on it.
    }
  };

  const openCreateForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    resetModelBrowser();
    setShowForm(true);
  };

  const openEditForm = (provider: ProviderConfigResponse) => {
    setForm({
      name: provider.name,
      endpoint: provider.endpoint,
      apiKey: '',
      format: provider.format,
      models: provider.models.map((m) => ({
        name: m.name,
        displayName: m.displayName || '',
        contextSize: m.contextSize,
        supportsVision: m.supportsVision,
        supportsTools: m.supportsTools,
        supportsStreaming: m.supportsStreaming ?? true,
        isActive: m.isActive ?? true,
      })),
    });
    setEditingId(provider.id);
    resetModelBrowser();
    void loadMonitoredModels(provider.id);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    resetModelBrowser();
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      if (editingId) {
        const input: any = {
          name: form.name,
          endpoint: form.endpoint,
          format: form.format,
          models: form.models,
        };
        if (form.apiKey.trim()) input.apiKey = form.apiKey;
        await updateProvider(editingId, input);
      } else {
        await createProvider({
          name: form.name,
          endpoint: form.endpoint,
          apiKey: form.apiKey,
          format: form.format,
          models: form.models as any,
        });
      }
      closeForm();
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    const result = await testConnection(id);
    if (result) {
      setTestResult({ id, ...result });
    }
    setTestingId(null);
  };

  const handleDiscover = async () => {
    if (!form.endpoint.trim() || (!editingId && !form.apiKey.trim())) {
      setDiscoverError(t('settings.discoverNeedsKey'));
      return;
    }
    setDiscovering(true);
    setDiscoverError(null);
    const result = await discoverModels({
      id: editingId,
      endpoint: form.endpoint,
      apiKey: form.apiKey,
      format: form.format,
    });
    if (result.error) {
      setDiscoverError(t('settings.discoverFailed', { error: result.error }));
    } else {
      setDiscovered(result.models);
      if (result.models.length === 0) setDiscoverError(t('settings.discoverEmpty'));
    }
    setDiscovering(false);
  };

  /** Upstream metadata is best-effort: fall back to the same defaults a hand-typed model gets. */
  const modelFromUpstream = (upstream: DiscoveredModel): ModelFormData => ({
    name: upstream.name,
    displayName: upstream.displayName && !validateDisplayName(upstream.displayName) ? upstream.displayName : '',
    contextSize: upstream.contextSize || 4096,
    supportsVision: upstream.supportsVision ?? false,
    supportsTools: upstream.supportsTools ?? false,
    supportsStreaming: true,
    isActive: true,
  });

  const selectUpstreamModel = (upstream: DiscoveredModel) => {
    setForm((prev) =>
      prev.models.some((m) => m.name === upstream.name)
        ? prev
        : { ...prev, models: [...prev.models, modelFromUpstream(upstream)] },
    );
  };

  const selectAllMatching = () => {
    const query = modelFilter.trim().toLowerCase();
    const configured = new Set(form.models.map((m) => m.name));
    const additions = (discovered ?? [])
      .filter((m) => !configured.has(m.name))
      .filter(
        (m) =>
          !query || m.name.toLowerCase().includes(query) || (m.displayName || '').toLowerCase().includes(query),
      )
      .map(modelFromUpstream);
    if (additions.length > 0) setForm((prev) => ({ ...prev, models: [...prev.models, ...additions] }));
  };

  const addModel = () => {
    setForm((prev) => ({ ...prev, models: [...prev.models, { ...EMPTY_MODEL }] }));
  };

  const removeModel = (index: number) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.filter((_, i) => i !== index),
    }));
  };

  const updateModel = (index: number, field: keyof ModelFormData, value: any) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((m, i) => (i === index ? { ...m, [field]: value } : m)),
    }));
  };

  const upstreamByName = useMemo(
    () => new Map((discovered ?? []).map((m) => [m.name, m])),
    [discovered],
  );

  /** Configured models first (they are the answer), then whatever else the upstream offers. */
  const modelRows = useMemo<ModelRow[]>(() => {
    const query = modelFilter.trim().toLowerCase();
    const matches = (name: string, displayName?: string) =>
      !query || name.toLowerCase().includes(query) || (displayName || '').toLowerCase().includes(query);

    const rows: ModelRow[] = form.models.map((model, index) => ({
      key: `sel-${index}`,
      index,
      name: model.name,
      model,
      upstream: upstreamByName.get(model.name),
      selected: true,
    }));

    if (!onlySelected) {
      const configured = new Set(form.models.map((m) => m.name));
      for (const upstream of discovered ?? []) {
        if (configured.has(upstream.name)) continue;
        rows.push({ key: `up-${upstream.name}`, index: -1, name: upstream.name, model: null, upstream, selected: false });
      }
    }

    // A freshly added manual row has no id yet — it must stay visible so it can be typed into.
    return rows.filter((row) => (row.selected && !row.name) || matches(row.name, row.model?.displayName || row.upstream?.displayName));
  }, [form.models, discovered, upstreamByName, modelFilter, onlySelected]);

  const monitoredSelected = form.models.filter((m) => monitoredModels.has(m.name)).length;

  const providerNameError = validateProviderName(form.name.trim());
  const modelErrors = form.models.map((m) => ({
    name: validateModelId(m.name.trim()),
    displayName: validateDisplayName(m.displayName.trim()),
  }));

  const isFormValid =
    !providerNameError &&
    form.endpoint.trim() &&
    (editingId || form.apiKey.trim()) &&
    form.models.length > 0 &&
    modelErrors.every((e) => !e.name && !e.displayName);

  const isNameDuplicate =
    form.name.trim() &&
    providers.some((p) => p.name.trim().toLowerCase() === form.name.trim().toLowerCase() && p.id !== editingId);

  return (
    <div className="w-full space-y-6">
      {/* Provider Configurations */}
      <div className="glass-card p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="section-title !mb-0">{t('settings.title')}</div>
            <p className="text-[12px] text-text-secondary mt-1">{t('settings.description')}</p>
          </div>
          <Button type="primary" ghost icon={<PlusOutlined />} onClick={openCreateForm}>
            {t('settings.addProvider')}
          </Button>
        </div>

        {providerError && <Alert type="error" title={providerError} showIcon closable />}

        {loading && providers.length === 0 && (
          <div className="text-center py-8 text-text-tertiary text-[13px]">{t('settings.loadingProviders')}</div>
        )}

        {!loading && providers.length === 0 && !showForm && (
          <div className="text-center py-10 border border-dashed border-border rounded-md">
            <div className="text-text-tertiary text-[13px] mb-2">{t('settings.noProviders')}</div>
            <Button type="link" size="small" onClick={openCreateForm}>
              {t('settings.addFirstProvider')}
            </Button>
          </div>
        )}

        {/* Provider Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 !mt-6">
          {providers.map((provider) => {
            const activeModels = provider.models.filter((m) => m.isActive !== false);
            const inactiveModels = provider.models.filter((m) => m.isActive === false);
            return (
              <motion.div
                key={provider.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="rounded-lg border border-border bg-bg-surface overflow-hidden hover:border-border-hover transition-colors flex flex-col"
              >
                {/* Card Header */}
                <div className="p-5 pb-4">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="text-[14px] font-semibold text-text-primary truncate">{provider.name}</div>
                      <Tag>{provider.format}</Tag>
                    </div>
                    <Button onClick={() => openEditForm(provider)}>{t('common.action.edit')}</Button>
                  </div>

                  {/* Info rows */}
                  <div className="space-y-1.5 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="text-text-tertiary w-[52px] flex-shrink-0">{t('settings.endpoint')}</span>
                      <span className="text-text-secondary truncate font-mono">{provider.endpoint}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-text-tertiary w-[52px] flex-shrink-0">{t('settings.apiKey')}</span>
                      <span className="text-text-secondary font-mono">{provider.apiKeyMasked}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-text-tertiary w-[52px] flex-shrink-0">{t('settings.models')}</span>
                      <span className="text-text-secondary">
                        {activeModels.length} {t('settings.active')}
                        {inactiveModels.length > 0 && (
                          <span className="text-text-tertiary">
                            {' '}
                            · {inactiveModels.length} {t('settings.inactive')}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Test result */}
                {testResult && testResult.id === provider.id && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                    <Alert
                      type={testResult.success ? 'success' : 'error'}
                      title={
                        testResult.success
                          ? t('settings.connectionSuccess', { latency: testResult.latencyMs })
                          : t('settings.connectionFailed', { error: testResult.error })
                      }
                      showIcon
                      closable
                      onClose={() => setTestResult(null)}
                      className="font-mono"
                      style={{ margin: '0 20px 12px', fontSize: 11 }}
                    />
                  </motion.div>
                )}

                {/* Models Grid */}
                <div className="px-5 pb-4 pt-0 flex-1">
                  <div className="border-t border-border/50 pt-3">
                    <div className="flex flex-wrap gap-1.5">
                      {provider.models.map((model) => (
                        <div
                          key={model.id}
                          className={`px-2.5 py-1.5 rounded-md bg-bg-card border border-border/50 text-[11px] ${
                            model.isActive === false ? 'opacity-35' : ''
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <div
                              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                model.isActive === false ? 'bg-text-tertiary' : 'bg-accent-teal'
                              }`}
                            />
                            <span className="text-text-primary font-medium font-mono">{model.name}</span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1 ml-3">
                            <span className="text-text-tertiary text-[10px] font-mono">
                              {model.contextSize >= 1000
                                ? `${Math.round(model.contextSize / 1000)}K`
                                : model.contextSize}
                            </span>
                            {model.supportsVision && (
                              <Tag color="blue" style={{ fontSize: 10, padding: '0 6px', lineHeight: '20px' }}>
                                V
                              </Tag>
                            )}
                            {model.supportsTools && (
                              <Tag color="purple" style={{ fontSize: 10, padding: '0 6px', lineHeight: '20px' }}>
                                T
                              </Tag>
                            )}
                            {model.supportsStreaming && (
                              <Tag color="green" style={{ fontSize: 10, padding: '0 6px', lineHeight: '20px' }}>
                                S
                              </Tag>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Card Footer - Actions */}
                <div className="px-5 py-3 border-t border-border/50 flex items-center justify-between">
                  <Button
                    type="primary"
                    ghost
                    icon={<ApiOutlined />}
                    onClick={() => handleTest(provider.id)}
                    loading={testingId === provider.id}
                  >
                    {testingId === provider.id ? t('settings.testing') : t('settings.testConnection')}
                  </Button>
                  <Popconfirm
                    title={t('settings.deleteConfirmTitle')}
                    description={t('settings.deleteConfirmDesc')}
                    onConfirm={() => deleteProvider(provider.id)}
                    okText={t('common.action.delete')}
                    cancelText={t('common.action.cancel')}
                    okButtonProps={{ danger: true }}
                  >
                    <Button danger ghost>
                      {t('common.action.delete')}
                    </Button>
                  </Popconfirm>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Provider Form Modal */}
        <Modal
          open={showForm}
          title={editingId ? t('settings.editProvider') : t('settings.addProvider')}
          onCancel={closeForm}
          onOk={handleSubmit}
          okText={editingId ? t('common.action.update') : t('common.action.save')}
          okButtonProps={{ disabled: !!(!isFormValid || isNameDuplicate), loading: saving }}
          width={860}
          destroyOnHidden
        >
          <div className="space-y-4 py-2">
            {/* Name & Format */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-text-secondary mb-1 block">{t('settings.providerName')}</label>
                <Input
                  placeholder={t('settings.providerNamePlaceholder')}
                  value={form.name}
                  status={isNameDuplicate || (form.name && providerNameError) ? 'error' : undefined}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                />
                {isNameDuplicate && (
                  <span className="text-[10px] text-accent-rose mt-0.5 block">{t('settings.providerNameExists')}</span>
                )}
                {!isNameDuplicate && form.name && providerNameError && (
                  <span className="text-[10px] text-accent-rose mt-0.5 block">{providerNameError}</span>
                )}
              </div>
              <div>
                <label className="text-[11px] text-text-secondary mb-1 block">{t('settings.format')}</label>
                <Select
                  value={form.format}
                  onChange={(val) => setForm((prev) => ({ ...prev, format: val }))}
                  options={[
                    { value: 'openai', label: t('settings.formatOpenAI') },
                    { value: 'anthropic', label: t('settings.formatAnthropic') },
                    { value: 'gemini', label: t('settings.formatGemini') },
                    { value: 'custom', label: t('settings.formatCustom') },
                  ]}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            {/* Endpoint */}
            <div>
              <label className="text-[11px] text-text-secondary mb-1 block">{t('settings.endpointUrl')}</label>
              <div className="flex gap-2">
                <Input
                  placeholder={
                    form.format === 'openai'
                      ? 'https://api.openai.com/v1'
                      : form.format === 'anthropic'
                        ? 'https://api.anthropic.com/v1'
                        : form.format === 'gemini'
                          ? 'https://generativelanguage.googleapis.com/v1beta'
                          : 'https://your-api-endpoint.com/v1'
                  }
                  value={form.endpoint}
                  onChange={(e) => setForm((prev) => ({ ...prev, endpoint: e.target.value }))}
                />
                <Button
                  type="primary"
                  ghost
                  icon={<CloudDownloadOutlined />}
                  loading={discovering}
                  disabled={!form.endpoint.trim() || (!editingId && !form.apiKey.trim())}
                  onClick={handleDiscover}
                >
                  {discovering ? t('settings.discovering') : t('settings.discoverModels')}
                </Button>
              </div>
            </div>

            {/* API Key */}
            <div>
              <label className="text-[11px] text-text-secondary mb-1 block">
                {t('settings.apiKey')}
                {editingId && <span className="text-text-tertiary ml-1">{t('settings.leaveEmptyToKeep')}</span>}
              </label>
              <Input.Password
                placeholder={editingId ? t('settings.leaveEmptyToKeepKey') : t('settings.enterApiKey')}
                value={form.apiKey}
                onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
            </div>

            {/* Models */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-[11px] text-text-secondary">{t('settings.models')}</label>
                <div className="flex items-center gap-3 text-[11px] text-text-tertiary">
                  {discovered !== null && <span>{t('settings.discoveredCount', { count: discovered.length })}</span>}
                  <span className="text-accent-blue">{t('settings.selectedCount', { count: form.models.length })}</span>
                  {monitoredSelected > 0 && <span>{t('settings.monitoredCount', { count: monitoredSelected })}</span>}
                  <Button type="link" size="small" icon={<PlusOutlined />} onClick={addModel}>
                    {t('settings.addManualModel')}
                  </Button>
                </div>
              </div>

              {discoverError && (
                <div className="mb-2">
                  <Alert type="warning" message={discoverError} showIcon closable onClose={() => setDiscoverError(null)} />
                </div>
              )}

              {discovered !== null && discovered.length > 0 && (
                <div className="flex items-center gap-2 mb-2">
                  <Input
                    size="small"
                    allowClear
                    placeholder={t('settings.searchModels')}
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Button size="small" onClick={selectAllMatching}>
                    {t('settings.selectAllMatching')}
                  </Button>
                  <Button size="small" type={onlySelected ? 'primary' : 'default'} onClick={() => setOnlySelected((v) => !v)}>
                    {t('settings.onlySelected')}
                  </Button>
                </div>
              )}

              <div className="rounded border border-border bg-bg-card max-h-[400px] overflow-y-auto">
                {modelRows.length === 0 && (
                  <div className="text-center py-8 text-text-tertiary text-[12px]">
                    {discovered === null ? t('settings.noModelsYet') : t('settings.noModelsMatch')}
                  </div>
                )}

                {modelRows.map((row) => {
                  const rowError = row.model && row.model.name ? validateModelId(row.model.name) : null;
                  const displayNameError = row.model?.displayName ? validateDisplayName(row.model.displayName) : null;
                  const context = formatContext(row.model?.contextSize ?? row.upstream?.contextSize);
                  const hasVision = row.model ? row.model.supportsVision : row.upstream?.supportsVision;
                  const hasTools = row.model ? row.model.supportsTools : row.upstream?.supportsTools;
                  const expanded = expandedRow === row.key;

                  return (
                    <div
                      key={row.key}
                      className={`border-b border-border last:border-b-0 ${row.selected ? 'bg-[rgba(64,150,255,0.06)]' : ''} ${
                        row.model && row.model.isActive === false ? 'opacity-50' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2 px-3 py-1.5">
                        <Checkbox
                          checked={row.selected}
                          onChange={() => {
                            if (row.selected) {
                              removeModel(row.index);
                              setExpandedRow(null);
                            } else if (row.upstream) {
                              selectUpstreamModel(row.upstream);
                            }
                          }}
                        />

                        {row.selected && !row.upstream ? (
                          <Input
                            size="small"
                            style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
                            placeholder={t('settings.modelIdPlaceholder')}
                            value={row.model?.name || ''}
                            status={row.model?.name && rowError ? 'error' : undefined}
                            onChange={(e) => updateModel(row.index, 'name', e.target.value)}
                          />
                        ) : (
                          <span className="flex-1 font-mono text-[12px] text-text-primary truncate" title={row.name}>
                            {row.name}
                          </span>
                        )}

                        {row.selected && (
                          <Input
                            size="small"
                            style={{ width: 150 }}
                            placeholder={t('settings.displayNamePlaceholder')}
                            value={row.model?.displayName || ''}
                            status={displayNameError ? 'error' : undefined}
                            onChange={(e) => updateModel(row.index, 'displayName', e.target.value)}
                          />
                        )}

                        <div className="flex items-center gap-1 flex-none">
                          {context && row.name && (
                            <Tag style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}>{context}</Tag>
                          )}
                          {hasVision && (
                            <Tag color="purple" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}>
                              {t('settings.vision')}
                            </Tag>
                          )}
                          {hasTools && (
                            <Tag color="green" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}>
                              {t('settings.toolCalling')}
                            </Tag>
                          )}
                          {monitoredModels.has(row.name) && (
                            <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}>
                              {t('settings.monitored')}
                            </Tag>
                          )}
                        </div>

                        {row.selected && (
                          <Button
                            type="link"
                            size="small"
                            icon={expanded ? <DownOutlined /> : <RightOutlined />}
                            aria-label={t('settings.modelDetails')}
                            onClick={() => setExpandedRow(expanded ? null : row.key)}
                          />
                        )}
                      </div>

                      {row.selected && rowError && row.model?.name && (
                        <div className="px-3 pb-1.5 pl-9 text-[10px] text-accent-rose">{rowError}</div>
                      )}

                      {expanded && row.model && (
                        <div className="px-3 pb-2 pl-9 flex items-center gap-4 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-text-tertiary">{t('settings.contextSize')}</span>
                            <InputNumber
                              changeOnBlur
                              size="small"
                              min={1}
                              style={{ width: 110 }}
                              value={row.model.contextSize}
                              onChange={(v) => updateModel(row.index, 'contextSize', v ?? 4096)}
                            />
                          </div>
                          <Checkbox
                            checked={row.model.supportsVision}
                            onChange={(e) => updateModel(row.index, 'supportsVision', e.target.checked)}
                          >
                            <span className="text-[11px] text-text-secondary">{t('settings.vision')}</span>
                          </Checkbox>
                          <Checkbox
                            checked={row.model.supportsTools}
                            onChange={(e) => updateModel(row.index, 'supportsTools', e.target.checked)}
                          >
                            <span className="text-[11px] text-text-secondary">{t('settings.toolCalling')}</span>
                          </Checkbox>
                          <Checkbox
                            checked={row.model.supportsStreaming}
                            onChange={(e) => updateModel(row.index, 'supportsStreaming', e.target.checked)}
                          >
                            <span className="text-[11px] text-text-secondary">{t('settings.streaming')}</span>
                          </Checkbox>
                          <Checkbox
                            checked={row.model.isActive}
                            onChange={(e) => updateModel(row.index, 'isActive', e.target.checked)}
                          >
                            <span className="text-[11px] text-text-secondary">{t('settings.activeLabel')}</span>
                          </Checkbox>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Modal>
      </div>

      {/* About */}
      <div className="glass-card p-6 space-y-3">
        <div className="section-title !mb-0">{t('settings.about')}</div>
        <div className="space-y-1.5 text-[13px] text-text-secondary">
          <p>
            <span className="text-text-primary font-medium">LLM API Bench</span>
            <span className="text-text-tertiary ml-1.5 font-mono">{APP_VERSION}</span>
          </p>
          <p>{t('settings.aboutDescription')}</p>
        </div>
      </div>
    </div>
  );
}
