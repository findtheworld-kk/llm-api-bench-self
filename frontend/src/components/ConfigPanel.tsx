import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ProviderConfigResponse, FORMAT_COLORS } from '../types';
import {
  PRESET_PROMPTS,
  QUICK_MAX_TOKENS,
  QUICK_CONCURRENCY,
  QUICK_ITERATIONS,
  QUICK_WARMUP,
  QUICK_INTERVAL,
  OUTPUT_SCOPE_OPTIONS,
  applyOutputScope,
  getStoredOutputScope,
  storeOutputScope,
  getStoredMaxTokens,
  storeMaxTokens,
} from '../constants';
import { useProviders } from '../hooks/useProviders';
import { Button, Input, InputNumber, Switch, Segmented, Select, Tooltip } from '../antdImports';
import { LoadingOutlined } from '@ant-design/icons';
import { useTokenCount } from '../utils/tokenCount';
import { loadHeavyPreset } from '../constants';

interface ConfigPanelProps {
  onStart: (
    providers: string[],
    config: {
      prompt: string;
      systemPrompt?: string;
      maxTokens: number;
      concurrency: number;
      iterations: number;
      streaming: boolean;
      warmupRuns: number;
      requestInterval: number;
      randomizeInterval: boolean;
    },
    apiKeys: Record<string, string>,
  ) => void;
  isRunning: boolean;
  currentProviders?: string[];
  onCancel?: () => void;
}

// Selected model: providerId:modelName
interface SelectedModel {
  providerId: string;
  modelName: string;
  providerName: string;
  displayLabel: string;
  color: string;
}

function QuickButtons({
  options,
  value,
  onChange,
  color = 'accent-teal',
}: {
  options: { label: string; value: number }[];
  value: number;
  onChange: (v: number) => void;
  color?: string;
}) {
  // Adaptive sizing: shrink when many options to stay on one line
  const compact = options.length > 7;
  const fontSize = compact ? '10px' : '11px';
  const padding = compact ? '3px 0.35rem' : '6px 0.625rem';
  return (
    <div className="flex flex-nowrap gap-0.5 mb-1.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded border transition-all font-medium font-mono whitespace-nowrap shrink-0 ${
            value === opt.value
              ? `border-${color}/40 bg-${color}/8 text-${color}`
              : 'border-border text-text-tertiary hover:border-border-hover'
          }`}
          style={{
            fontSize,
            padding,
            ...(value === opt.value
              ? {
                  borderColor:
                    color === 'accent-teal'
                      ? 'rgba(115,191,105,0.4)'
                      : color === 'accent-blue'
                        ? 'rgba(61,113,217,0.4)'
                        : 'rgba(255,152,48,0.4)',
                  backgroundColor:
                    color === 'accent-teal'
                      ? 'rgba(115,191,105,0.08)'
                      : color === 'accent-blue'
                        ? 'rgba(61,113,217,0.08)'
                        : 'rgba(255,152,48,0.08)',
                  color: color === 'accent-teal' ? '#73bf69' : color === 'accent-blue' ? '#4096ff' : '#ff9830',
                }
              : {}),
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function ConfigPanel({ onStart, isRunning, currentProviders: _currentProviders, onCancel }: ConfigPanelProps) {
  const { t } = useTranslation();
  const { providers: configuredProviders, loading: providersLoading, fetchProviders } = useProviders();
  const [selectedModels, setSelectedModels] = useState<SelectedModel[]>([]);
  const [isAdvancedMode, setIsAdvancedMode] = useState(false);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const [prompt, setPrompt] = useState(PRESET_PROMPTS[0].prompt);
  const promptTokenCount = useTokenCount(prompt);
  const [maxTokens, setMaxTokensRaw] = useState(getStoredMaxTokens);
  const setMaxTokens = (v: number) => {
    setMaxTokensRaw(v);
    storeMaxTokens(v);
  };
  const [concurrency, setConcurrency] = useState(3);
  const [iterations, setIterations] = useState(5);
  const [streaming, setStreaming] = useState(true);
  const [warmupRuns, setWarmupRuns] = useState(0);
  const [requestInterval, setRequestInterval] = useState(0);
  const [randomizeInterval, setRandomizeInterval] = useState(false);
  const [isLongContext, setIsLongContext] = useState(false);
  const [outputScope, setOutputScope] = useState(getStoredOutputScope);
  const [activePreset, setActivePreset] = useState<string | undefined>(PRESET_PROMPTS[0].label);

  const toggleModel = (provider: ProviderConfigResponse, modelName: string) => {
    const key = `${provider.id}:${modelName}`;
    setSelectedModels((prev) => {
      const exists = prev.find((m) => `${m.providerId}:${m.modelName}` === key);
      if (exists) {
        return prev.filter((m) => `${m.providerId}:${m.modelName}` !== key);
      }
      return [
        ...prev,
        {
          providerId: provider.id,
          modelName,
          providerName: provider.name,
          displayLabel: `${provider.name} / ${modelName}`,
          color: FORMAT_COLORS[provider.format] || '#999',
        },
      ];
    });
  };

  const isModelSelected = (providerId: string, modelName: string) =>
    selectedModels.some((m) => m.providerId === providerId && m.modelName === modelName);

  const handleStart = () => {
    if (selectedModels.length === 0) return;
    const providerKeys = selectedModels.map((m) => `${m.providerId}:${m.modelName}`);
    onStart(
      providerKeys,
      { prompt, maxTokens, concurrency, iterations, streaming, warmupRuns, requestInterval, randomizeInterval },
      {},
    );
  };

  return (
    <motion.div initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} className="glass-card p-7 space-y-7">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-text-primary">{t('config.configuration')}</h2>
        <Segmented
          size="small"
          value={isAdvancedMode ? 'ADV' : 'QUICK'}
          options={[
            { label: t('config.modeQuick'), value: 'QUICK' },
            { label: t('config.modeAdv'), value: 'ADV' },
          ]}
          onChange={(val) => setIsAdvancedMode(val === 'ADV')}
          className="font-mono"
          style={{ fontSize: 11 }}
        />
      </div>

      {/* Provider & Model Selection */}
      <div className="space-y-4">
        <label className="section-title">{t('config.providersAndModels')}</label>
        {providersLoading && configuredProviders.length === 0 ? (
          <div className="text-center py-6 text-text-tertiary text-[12px] animate-pulse">
            {t('config.loadingProviders')}
          </div>
        ) : configuredProviders.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-border rounded-md">
            <div className="text-text-tertiary text-[12px] mb-1">{t('config.noProviders')}</div>
            <div className="text-text-tertiary text-[11px]">{t('config.goToSettings')}</div>
          </div>
        ) : (
          <div className="space-y-3">
            {configuredProviders.map((provider) => {
              const activeModels = provider.models.filter((m) => m.isActive !== false);
              const color = FORMAT_COLORS[provider.format] || '#999';
              const hasSelected = activeModels.some((m) => isModelSelected(provider.id, m.name));
              return (
                <div
                  key={provider.id}
                  className="rounded-md border transition-all"
                  style={{
                    borderColor: hasSelected ? `${color}40` : undefined,
                    backgroundColor: hasSelected ? `${color}08` : undefined,
                  }}
                >
                  <div className="px-3 py-2 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-[12px] font-medium text-text-primary">{provider.name}</span>
                    <span className="text-[10px] text-text-tertiary font-mono">{provider.format}</span>
                  </div>
                  <div className="px-3 pb-2.5 flex flex-wrap gap-1.5">
                    {activeModels.map((model) => {
                      const selected = isModelSelected(provider.id, model.name);
                      return (
                        <button
                          key={model.id}
                          onClick={() => toggleModel(provider, model.name)}
                          className={`text-[11px] px-2.5 py-1.5 rounded border transition-all font-medium font-mono ${
                            selected
                              ? ''
                              : 'border-border text-text-tertiary hover:border-border-hover hover:text-text-secondary'
                          }`}
                          style={{
                            borderColor: selected ? `${color}40` : undefined,
                            backgroundColor: selected ? `${color}12` : undefined,
                            color: selected ? color : undefined,
                          }}
                        >
                          {model.displayName || model.name}
                          {selected && <span className="ml-1.5">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected summary */}
      {selectedModels.length > 0 && (
        <div className="text-[10px] text-text-tertiary px-1 font-mono">
          {t('config.selected')}
          {selectedModels.map((m) => m.displayLabel).join(', ')}
        </div>
      )}

      {/* Test Prompt */}
      <div className="space-y-4">
        <label className="section-title">{t('config.testPrompt')}</label>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_PROMPTS.map((preset) => (
            <button
              key={preset.label}
              onClick={async () => {
                const isLC = !!preset.multiDoc;
                setIsLongContext(isLC);
                setActivePreset(preset.label);
                if (preset.heavy) {
                  const bucket = preset.tokens >= 200_000 ? '256k' : preset.tokens >= 100_000 ? '150k' : '64k';
                  const raw = await loadHeavyPreset(bucket);
                  setPrompt(isLC ? applyOutputScope(raw, outputScope) : raw);
                } else {
                  setPrompt(isLC ? applyOutputScope(preset.prompt, outputScope) : preset.prompt);
                }
              }}
              className={`text-[11px] px-2.5 py-1.5 rounded-md border transition-all font-medium ${
                activePreset === preset.label
                  ? 'border-accent-teal/40 bg-accent-teal/8 text-accent-teal'
                  : 'border-border text-text-secondary hover:border-border-hover hover:text-text-primary'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {isLongContext && (
          <div className="flex items-center gap-2">
            <Tooltip title={t('config.outputScopeTooltip')}>
              <label className="text-[11px] text-text-secondary font-medium whitespace-nowrap cursor-help">
                {t('config.outputScope')}
              </label>
            </Tooltip>
            <Select
              size="small"
              value={outputScope}
              onChange={(v) => {
                setOutputScope(v);
                storeOutputScope(v);
                setPrompt((prev) => applyOutputScope(prev, v));
              }}
              options={OUTPUT_SCOPE_OPTIONS}
              style={{ width: 160, fontSize: 11 }}
            />
          </div>
        )}
        <Input.TextArea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setActivePreset(undefined);
          }}
          autoSize={{ minRows: 3, maxRows: 6 }}
          placeholder={t('config.enterTestPrompt')}
          style={{ fontSize: 13 }}
        />
        <span className="text-[10px] text-text-tertiary font-mono">
          {promptTokenCount} {t('common.unit.tokens').toLowerCase()}
        </span>
      </div>

      {/* Core Parameters */}
      <div className="space-y-4">
        <label className="section-title">{t('config.parameters')}</label>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Tooltip title={t('config.maxTokensTooltip')}>
              <label className="text-[11px] text-text-secondary font-medium cursor-help">{t('config.maxTokens')}</label>
            </Tooltip>
            <QuickButtons options={QUICK_MAX_TOKENS} value={maxTokens} onChange={setMaxTokens} color="accent-teal" />
            <InputNumber
              changeOnBlur
              value={maxTokens}
              onChange={(v) => setMaxTokens(v ?? getStoredMaxTokens())}
              min={100}
              max={32000}
              size="small"
              className="font-mono"
              style={{ width: '100%' }}
            />
          </div>
          <div className="space-y-2">
            <Tooltip title={t('config.concurrencyTooltip')}>
              <label className="text-[11px] text-text-secondary font-medium cursor-help">
                {t('config.concurrency')}
              </label>
            </Tooltip>
            <QuickButtons
              options={QUICK_CONCURRENCY}
              value={concurrency}
              onChange={setConcurrency}
              color="accent-blue"
            />
            <InputNumber
              changeOnBlur
              value={concurrency}
              onChange={(v) => setConcurrency(v ?? 3)}
              min={1}
              max={5000}
              size="small"
              className="font-mono"
              style={{ width: '100%' }}
            />
          </div>
          <div className="space-y-2">
            <Tooltip title={t('config.iterationsTooltip')}>
              <label className="text-[11px] text-text-secondary font-medium cursor-help">
                {t('config.iterations')}
              </label>
            </Tooltip>
            <QuickButtons options={QUICK_ITERATIONS} value={iterations} onChange={setIterations} color="accent-teal" />
            <InputNumber
              changeOnBlur
              value={iterations}
              onChange={(v) => setIterations(v ?? 5)}
              min={1}
              max={10000000}
              size="small"
              className="font-mono"
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </div>

      {/* Advanced Options */}
      <AnimatePresence>
        {isAdvancedMode && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-5 pt-4 border-t border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-text-secondary font-medium">{t('config.streaming')}</span>
                  <span className="text-[10px] text-text-tertiary">
                    {streaming ? t('config.realTimeOutput') : t('config.fullResponse')}
                  </span>
                </div>
                <Switch checked={streaming} onChange={setStreaming} size="small" />
              </div>

              <div className="space-y-4">
                <label className="section-title">{t('config.advanced')}</label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Tooltip title={t('config.warmupRunsTooltip')}>
                      <label className="text-[11px] text-text-secondary font-medium cursor-help">
                        {t('config.warmupRuns')}
                      </label>
                    </Tooltip>
                    <QuickButtons
                      options={QUICK_WARMUP}
                      value={warmupRuns}
                      onChange={setWarmupRuns}
                      color="accent-coral"
                    />
                    <InputNumber
                      changeOnBlur
                      value={warmupRuns}
                      onChange={(v) => setWarmupRuns(v ?? 2)}
                      min={0}
                      max={5}
                      size="small"
                      className="font-mono"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Tooltip title={t('config.intervalTooltip')}>
                      <label className="text-[11px] text-text-secondary font-medium cursor-help">
                        {t('config.intervalMs')}
                      </label>
                    </Tooltip>
                    <QuickButtons
                      options={QUICK_INTERVAL}
                      value={requestInterval}
                      onChange={setRequestInterval}
                      color="accent-coral"
                    />
                    <InputNumber
                      changeOnBlur
                      value={requestInterval}
                      onChange={(v) => setRequestInterval(v ?? 0)}
                      min={0}
                      max={10000}
                      size="small"
                      className="font-mono"
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
                {requestInterval > 0 && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-secondary font-medium">
                        {t('config.randomizeInterval')}
                      </span>
                      <span className="text-[10px] text-text-tertiary">
                        {randomizeInterval ? t('config.simulatesRealTraffic') : t('config.fixedInterval')}
                      </span>
                    </div>
                    <Switch checked={randomizeInterval} onChange={setRandomizeInterval} size="small" />
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quick mode summary */}
      {!isAdvancedMode && (
        <div className="text-[10px] text-text-tertiary flex flex-wrap gap-3 px-1 font-mono">
          <span>
            {t('config.streaming')}:{' '}
            <span className="text-accent-teal">{streaming ? t('common.status.on') : t('common.status.off')}</span>
          </span>
          <span>
            {t('config.warmupRuns')}: <span className="text-accent-coral">{warmupRuns}</span>
          </span>
          <span>
            {t('config.intervalMs')}: <span className="text-accent-coral">{requestInterval}ms</span>
          </span>
        </div>
      )}

      {/* Start/Cancel */}
      <div className="flex gap-3">
        <Button
          type="primary"
          onClick={handleStart}
          disabled={selectedModels.length === 0}
          loading={isRunning ? { icon: <LoadingOutlined /> } : false}
          block
          size="large"
        >
          {isRunning
            ? t('common.status.running')
            : selectedModels.length > 0
              ? t('config.startBenchmark', { count: selectedModels.length })
              : t('config.selectAtLeastOne')}
        </Button>

        {isRunning && onCancel && (
          <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
            <Button danger size="large" onClick={onCancel} style={{ fontWeight: 500 }}>
              ✕
            </Button>
          </motion.div>
        )}
      </div>

      {selectedModels.length === 0 && (
        <p className="text-[11px] text-accent-rose/60 text-center">{t('config.selectAtLeastOne')}</p>
      )}
    </motion.div>
  );
}
