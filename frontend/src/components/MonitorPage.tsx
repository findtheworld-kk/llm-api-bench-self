import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { Button, Tooltip, Checkbox, Select, Tag, InputNumber, Modal, Input } from '../antdImports';
import message from 'antd/es/message';
import {
  ReloadOutlined,
  ClockCircleOutlined,
  SettingOutlined,
  WarningOutlined,
  LineChartOutlined,
  BellOutlined,
  BellFilled,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useMonitor, PingResult, MonitorTarget, HealthThresholds } from '../hooks/useMonitor';
import { useProviders } from '../hooks/useProviders';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
  ReferenceLine,
} from 'recharts';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type HealthStatus = 'healthy' | 'slow' | 'very_slow' | 'down';

function getStatusDotColor(cls: HealthStatus): string {
  if (cls === 'down') return 'bg-red-500';
  if (cls === 'very_slow') return 'bg-orange-500';
  if (cls === 'slow') return 'bg-amber-500';
  return 'bg-emerald-500';
}

function getStatusLabel(cls: HealthStatus, t: any): string {
  if (cls === 'down') return t('monitor.down');
  if (cls === 'very_slow') return t('monitor.verySlow');
  if (cls === 'slow') return t('monitor.slow');
  return t('monitor.healthy');
}

function getStatusTextColor(cls: HealthStatus): string {
  if (cls === 'down') return 'text-red-400';
  if (cls === 'very_slow') return 'text-orange-400';
  if (cls === 'slow') return 'text-amber-400';
  return 'text-emerald-400';
}

const STATUS_ICON_COLORS: Record<HealthStatus, string> = {
  down: '#f87171',
  very_slow: '#fb923c',
  slow: '#fbbf24',
  healthy: '#34d399',
};

const TIME_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
] as const;

const CHART_COLORS = { ttft: '#f59e0b', tps: '#10b981', latency: '#3b82f6' };

const CHART_TOOLTIP_STYLE = {
  background: 'var(--color-bg-card)',
  border: '1px solid var(--color-border)',
  borderRadius: '6px',
  padding: '6px 10px',
  fontSize: '11px',
};

function formatChartTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface TrendChartsProps {
  history: PingResult[];
  providerId: string;
  modelName: string;
  thresholds: HealthThresholds;
  t: any;
}

function TrendCharts({ history, providerId, modelName, thresholds, t }: TrendChartsProps) {
  const [range, setRange] = useState<number>(24);

  const data = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const cutoff = Date.now() - range * 60 * 60 * 1000;
    return history
      .filter(
        (p) => p.providerId === providerId && p.modelName === modelName && new Date(p.checkedAt).getTime() >= cutoff,
      )
      .sort((a, b) => new Date(a.checkedAt).getTime() - new Date(b.checkedAt).getTime())
      .map((p) => ({
        time: formatChartTime(p.checkedAt),
        ttft: p.status === 'ok' ? +(p.ttftMs / 1000).toFixed(2) : undefined,
        tps: p.status === 'ok' && p.latencyMs > 0 ? Math.round((p.outputTokens / p.latencyMs) * 1000) : undefined,
        latency: p.status === 'ok' ? +(p.latencyMs / 1000).toFixed(2) : undefined,
        isError: p.status === 'error',
      }));
  }, [history, providerId, modelName, range]);

  if (data.length === 0) {
    return <div className="text-[11px] text-text-tertiary py-2">{t('common.noData')}</div>;
  }

  const charts: { key: string; label: string; dataKey: string; color: string; unit: string; refLine?: number }[] = [
    {
      key: 'ttft',
      label: 'TTFT',
      dataKey: 'ttft',
      color: CHART_COLORS.ttft,
      unit: 's',
      refLine: +(thresholds.ttftSlowMs / 1000).toFixed(2),
    },
    {
      key: 'tps',
      label: 'TPS',
      dataKey: 'tps',
      color: CHART_COLORS.tps,
      unit: 'tok/s',
      refLine: thresholds.tpsSlowThreshold,
    },
    { key: 'latency', label: t('monitor.latency'), dataKey: 'latency', color: CHART_COLORS.latency, unit: 's' },
  ];

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-1">
        {TIME_RANGES.map((r) => (
          <button
            key={r.hours}
            onClick={() => setRange(r.hours)}
            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
              range === r.hours ? 'bg-white/10 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {charts.map((c) => (
          <div key={c.key} className="rounded border border-border bg-bg-primary p-2">
            <div className="text-[10px] text-text-tertiary mb-1">
              {c.label} <span className="text-text-tertiary/50">({c.unit})</span>
            </div>
            <div className="h-[100px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={`grad-${c.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={c.color} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={c.color} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis
                    dataKey="time"
                    stroke="#585a6e"
                    tick={{ fontSize: 9, fill: '#8e8fa2' }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#585a6e"
                    tick={{ fontSize: 9, fill: '#8e8fa2' }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    width={40}
                  />
                  <RTooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    labelStyle={{ color: '#d8d9da' }}
                    formatter={(value) => [`${value ?? ''} ${c.unit}`, c.label]}
                  />
                  {c.refLine != null && (
                    <ReferenceLine
                      y={c.refLine}
                      stroke="#f59e0b"
                      strokeDasharray="4 3"
                      strokeOpacity={0.5}
                      label={{ value: `${c.refLine}`, position: 'right', fontSize: 9, fill: '#f59e0b80' }}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey={c.dataKey}
                    stroke={c.color}
                    strokeWidth={1.5}
                    fill={`url(#grad-${c.key})`}
                    dot={false}
                    activeDot={{ r: 3, strokeWidth: 1, stroke: '#000' }}
                    connectNulls={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryBar({
  history,
  providerId,
  modelName,
  t,
}: {
  history: PingResult[];
  providerId: string;
  modelName: string;
  t: any;
}) {
  const pings = history.filter((p) => p.providerId === providerId && p.modelName === modelName).slice(-144);

  if (pings.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-0.5">
        {Array.from({ length: 24 }, (_, i) => (
          <div key={i} className="w-1.5 h-3 rounded-sm bg-white/5" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {pings.map((p, i) => {
        const cls = p.healthStatus;
        return (
          <Tooltip
            key={i}
            title={
              <div className="text-[11px] leading-relaxed space-y-0.5 py-0.5">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${getStatusDotColor(cls)}`} />
                  <span className="font-medium">{getStatusLabel(cls, t)}</span>
                  <span className="text-white/50">·</span>
                  <span className="text-white/60">{formatTime(p.checkedAt)}</span>
                </div>
                <div className="flex gap-3 text-white/70 pl-3">
                  <span>
                    TPS{' '}
                    <span className="text-white font-mono">
                      {p.latencyMs > 0 ? Math.round((p.outputTokens / p.latencyMs) * 1000) : 0}
                    </span>
                  </span>
                  <span>
                    TTFT <span className="text-white font-mono">{formatLatency(p.ttftMs)}</span>
                  </span>
                  <span>
                    {t('monitor.latency')} <span className="text-white font-mono">{formatLatency(p.latencyMs)}</span>
                  </span>
                </div>
                {p.errorMessage && <div className="text-red-300 pl-3 truncate max-w-[240px]">{p.errorMessage}</div>}
              </div>
            }
          >
            <div className={`w-1.5 h-3 rounded-sm ${getStatusDotColor(cls)}`} />
          </Tooltip>
        );
      })}
    </div>
  );
}

export function MonitorPage() {
  const { t } = useTranslation();
  const { statuses, history, targets, globalConfig, running, fetchAll, saveTargets, saveConfig, triggerRun } =
    useMonitor();
  const { providers, fetchProviders } = useProviders();

  const INTERVAL_OPTIONS = [
    { value: 0, label: t('monitor.default') },
    { value: 5, label: t('monitor.intervalMin', { count: 5 }) },
    { value: 10, label: t('monitor.intervalMin', { count: 10 }) },
    { value: 15, label: t('monitor.intervalMin', { count: 15 }) },
    { value: 30, label: t('monitor.intervalMin', { count: 30 }) },
    { value: 60, label: t('monitor.intervalHour') },
    { value: 120, label: t('monitor.intervalHours', { count: 2 }) },
    { value: 360, label: t('monitor.intervalHours', { count: 6 }) },
  ];

  const DEFAULT_INTERVAL_OPTIONS = [
    { value: 5, label: t('monitor.intervalMin', { count: 5 }) },
    { value: 10, label: t('monitor.intervalMin', { count: 10 }) },
    { value: 15, label: t('monitor.intervalMin', { count: 15 }) },
    { value: 30, label: t('monitor.intervalMin', { count: 30 }) },
    { value: 60, label: t('monitor.intervalHour') },
    { value: 120, label: t('monitor.intervalHours', { count: 2 }) },
    { value: 360, label: t('monitor.intervalHours', { count: 6 }) },
  ];
  const [lastChecked, setLastChecked] = useState<string>('');
  const [showConfig, setShowConfig] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [draftInterval, setDraftInterval] = useState(globalConfig.defaultIntervalMinutes);
  const [thresholdTexts, setThresholdTexts] = useState<Record<keyof HealthThresholds, string>>({
    tpsSlowThreshold: String(globalConfig.healthThresholds.tpsSlowThreshold),
    tpsVerySlowThreshold: String(globalConfig.healthThresholds.tpsVerySlowThreshold),
    ttftSlowMs: String(globalConfig.healthThresholds.ttftSlowMs),
    minOutputTokens: String(globalConfig.healthThresholds.minOutputTokens),
  });
  const [draftTargets, setDraftTargets] = useState<MonitorTarget[]>(targets);
  const [draftWebhookUrl, setDraftWebhookUrl] = useState(globalConfig.alertWebhookUrl || '');
  const [draftWebhookSecret, setDraftWebhookSecret] = useState(globalConfig.alertWebhookSecret || '');
  const [draftAlertLanguage, setDraftAlertLanguage] = useState(globalConfig.alertLanguage || 'en');
  const [draftReminderMinutes, setDraftReminderMinutes] = useState(globalConfig.alertReminderMinutes ?? 360);
  const [configDirty, setConfigDirty] = useState(false);
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((key: string) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Sync draft when backend data changes
  useEffect(() => {
    setDraftInterval(globalConfig.defaultIntervalMinutes);
    setThresholdTexts({
      tpsSlowThreshold: String(globalConfig.healthThresholds.tpsSlowThreshold),
      tpsVerySlowThreshold: String(globalConfig.healthThresholds.tpsVerySlowThreshold),
      ttftSlowMs: String(globalConfig.healthThresholds.ttftSlowMs),
      minOutputTokens: String(globalConfig.healthThresholds.minOutputTokens),
    });
    setDraftWebhookUrl(globalConfig.alertWebhookUrl || '');
    setDraftWebhookSecret(globalConfig.alertWebhookSecret || '');
    setDraftAlertLanguage(globalConfig.alertLanguage || 'en');
    setDraftReminderMinutes(globalConfig.alertReminderMinutes ?? 360);
  }, [globalConfig]);

  useEffect(() => {
    setDraftTargets(targets);
  }, [targets]);

  // Reset dirty when all drafts match saved state
  useEffect(() => {
    const intervalChanged = draftInterval !== globalConfig.defaultIntervalMinutes;
    const thresholdsChanged = Object.keys(thresholdTexts).some(
      (k) =>
        thresholdTexts[k as keyof HealthThresholds] !==
        String(globalConfig.healthThresholds[k as keyof HealthThresholds]),
    );
    const targetsChanged = JSON.stringify(draftTargets) !== JSON.stringify(targets);
    const webhookChanged = draftWebhookUrl !== (globalConfig.alertWebhookUrl || '');
    const secretChanged = draftWebhookSecret !== (globalConfig.alertWebhookSecret || '');
    const langChanged = draftAlertLanguage !== (globalConfig.alertLanguage || 'en');
    const reminderChanged = draftReminderMinutes !== (globalConfig.alertReminderMinutes ?? 360);
    setConfigDirty(
      intervalChanged ||
        thresholdsChanged ||
        targetsChanged ||
        webhookChanged ||
        secretChanged ||
        langChanged ||
        reminderChanged,
    );
  }, [
    draftInterval,
    thresholdTexts,
    draftTargets,
    draftWebhookUrl,
    draftWebhookSecret,
    draftAlertLanguage,
    draftReminderMinutes,
    globalConfig,
    targets,
  ]);

  const handleSaveAll = async () => {
    const parsedThresholds: HealthThresholds = {
      tpsSlowThreshold: parseInt(thresholdTexts.tpsSlowThreshold) || 20,
      tpsVerySlowThreshold: parseInt(thresholdTexts.tpsVerySlowThreshold) || 5,
      ttftSlowMs: parseInt(thresholdTexts.ttftSlowMs) || 1000,
      minOutputTokens: parseInt(thresholdTexts.minOutputTokens) || 1,
    };
    saveConfig({
      defaultIntervalMinutes: draftInterval,
      healthThresholds: parsedThresholds,
      alertWebhookUrl: draftWebhookUrl,
      alertReminderMinutes: draftReminderMinutes,
      alertWebhookSecret: draftWebhookSecret,
      alertLanguage: draftAlertLanguage,
    });
    try {
      await saveTargets(draftTargets);
      setShowConfig(false);
      setConfigDirty(false);
    } catch (err: any) {
      message.error(err.message || 'Save failed');
    }
  };
  const refreshRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    Promise.all([fetchProviders(), fetchAll()]).then(() => setInitialLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 60 seconds
  useEffect(() => {
    refreshRef.current = setInterval(() => {
      fetchAll();
    }, 60000);
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
    };
  }, [fetchAll]);

  useEffect(() => {
    if (statuses.length > 0) {
      const latestTime = statuses.reduce(
        (latest, s) => (s.checkedAt > latest ? s.checkedAt : latest),
        statuses[0].checkedAt,
      );
      setLastChecked(latestTime);
    }
  }, [statuses]);

  const thresholds = globalConfig.healthThresholds;

  // Summary stats — only count statuses that match current targets
  const summary = useMemo(() => {
    const totalModels = targets.length;
    const providerCount = new Set(targets.map((t) => t.providerId)).size;
    const targetKeys = new Set(targets.map((t) => `${t.providerId}::${t.modelName}`));
    const targetStatuses = statuses.filter((s) => targetKeys.has(`${s.providerId}::${s.modelName}`));
    let healthyCount = 0;
    let slowCount = 0;
    let verySlowCount = 0;
    let downCount = 0;
    for (const s of targetStatuses) {
      const cls = s.healthStatus;
      if (cls === 'healthy') healthyCount++;
      else if (cls === 'slow') slowCount++;
      else if (cls === 'very_slow') verySlowCount++;
      else downCount++;
    }
    return { totalModels, providerCount, healthyCount, slowCount, verySlowCount, downCount };
  }, [targets, statuses]);

  // Build draft target key set for quick lookup
  const draftTargetKeys = new Set(draftTargets.map((t) => `${t.providerId}::${t.modelName}`));

  const toggleDraftTarget = (providerId: string, modelName: string, providerName: string) => {
    const key = `${providerId}::${modelName}`;
    const next: MonitorTarget[] = draftTargetKeys.has(key)
      ? draftTargets.filter((t) => `${t.providerId}::${t.modelName}` !== key)
      : [...draftTargets, { providerId, modelName, providerName, intervalMinutes: 0, alertEnabled: true }];
    setDraftTargets(next);
  };

  const updateDraftTargetInterval = (providerId: string, modelName: string, intervalMinutes: number) => {
    setDraftTargets(
      draftTargets.map((t) =>
        t.providerId === providerId && t.modelName === modelName ? { ...t, intervalMinutes } : t,
      ),
    );
  };

  const updateDraftTargetAlert = (providerId: string, modelName: string, alertEnabled: boolean) => {
    setDraftTargets(
      draftTargets.map((t) => (t.providerId === providerId && t.modelName === modelName ? { ...t, alertEnabled } : t)),
    );
  };

  const selectAllForProvider = (provider: any) => {
    const activeModels = provider.models.filter((m: any) => m.isActive !== false);
    const next = [...draftTargets];
    for (const m of activeModels) {
      const key = `${provider.id}::${m.name}`;
      if (!draftTargetKeys.has(key)) {
        next.push({
          providerId: provider.id,
          modelName: m.name,
          providerName: provider.name,
          intervalMinutes: 0,
          alertEnabled: true,
        });
      }
    }
    setDraftTargets(next);
  };

  const removeAllForProvider = (provider: any) => {
    setDraftTargets(draftTargets.filter((t) => t.providerId !== provider.id));
  };

  // Group targets by provider
  const grouped = new Map<string, MonitorTarget[]>();
  for (const t of targets) {
    if (!grouped.has(t.providerId)) grouped.set(t.providerId, []);
    grouped.get(t.providerId)!.push(t);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="glass-card p-4 flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-text-primary">{t('monitor.apiMonitor')}</h2>
          {lastChecked && (
            <div className="flex items-center gap-1.5 mt-1">
              <ClockCircleOutlined className="text-[11px] text-text-tertiary" />
              <span className="text-[11px] text-text-tertiary">
                {t('monitor.lastChecked')} {formatTime(lastChecked)}
              </span>
              <span className="text-[10px] text-text-tertiary ml-2">
                {t('monitor.autoRefresh', { interval: globalConfig.defaultIntervalMinutes })}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Tooltip title={t('monitor.settings')}>
            <Button
              icon={<SettingOutlined />}
              onClick={() => setShowConfig(!showConfig)}
              size="small"
              type={showConfig ? 'primary' : 'default'}
            />
          </Tooltip>
          <Button
            type="primary"
            icon={<ReloadOutlined spin={running} />}
            onClick={triggerRun}
            loading={running}
            size="small"
          >
            {t('monitor.runCheck')}
          </Button>
        </div>
      </div>

      {/* Summary Bar */}
      {targets.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
          <div className="stat-card flex items-center gap-2 col-span-2">
            <div className="w-2 h-2 rounded-full bg-accent-blue" />
            <div>
              <div className="stat-label">{t('monitor.monitoring')}</div>
              <div className="stat-value text-[13px] text-accent-blue">
                {t('monitor.monitoringStats', { models: summary.totalModels, providers: summary.providerCount })}
              </div>
            </div>
          </div>
          <div className="stat-card flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <div>
              <div className="stat-label">{t('monitor.healthy')}</div>
              <div className="stat-value text-[13px] text-emerald-400">{summary.healthyCount}</div>
            </div>
          </div>
          <div className="stat-card flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <div>
              <div className="stat-label">{t('monitor.slow')}</div>
              <div className="stat-value text-[13px] text-amber-400">{summary.slowCount}</div>
            </div>
          </div>
          <div className="stat-card flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-orange-500" />
            <div>
              <div className="stat-label">{t('monitor.verySlow')}</div>
              <div className="stat-value text-[13px] text-orange-400">{summary.verySlowCount}</div>
            </div>
          </div>
          <div className="stat-card flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <div>
              <div className="stat-label">{t('monitor.down')}</div>
              <div className="stat-value text-[13px] text-red-400">{summary.downCount}</div>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      <Modal
        open={showConfig}
        title={t('monitor.monitorSettings')}
        onCancel={() => setShowConfig(false)}
        onOk={handleSaveAll}
        okText={t('common.action.save')}
        okButtonProps={{ disabled: !configDirty }}
        width={780}
        destroyOnHidden
      >
        <div className="space-y-4 py-2">
          {/* Global Config */}
          <div className="space-y-2">
            <div className="section-header">{t('monitor.globalSettings')}</div>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-secondary">{t('monitor.defaultInterval')}</span>
                <Select
                  size="small"
                  value={draftInterval}
                  onChange={(v) => {
                    setDraftInterval(v);
                    setConfigDirty(true);
                  }}
                  options={DEFAULT_INTERVAL_OPTIONS}
                  style={{ width: 100 }}
                />
              </div>
            </div>
          </div>

          {/* Health Thresholds */}
          <div className="space-y-2">
            <div className="section-header" data-color="amber">
              {t('monitor.healthThresholds')}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-secondary">{t('monitor.slowTps')}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono">&lt;</span>
                <InputNumber
                  size="small"
                  style={{ width: 56 }}
                  value={Number(thresholdTexts.tpsSlowThreshold) || undefined}
                  onChange={(v) => {
                    setThresholdTexts({ ...thresholdTexts, tpsSlowThreshold: String(v ?? '') });
                    setConfigDirty(true);
                  }}
                  min={0}
                />
                <span className="text-[10px] text-text-tertiary">tok/s</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-secondary">{t('monitor.verySlowTps')}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-mono">&lt;</span>
                <InputNumber
                  size="small"
                  style={{ width: 56 }}
                  value={Number(thresholdTexts.tpsVerySlowThreshold) || undefined}
                  onChange={(v) => {
                    setThresholdTexts({ ...thresholdTexts, tpsVerySlowThreshold: String(v ?? '') });
                    setConfigDirty(true);
                  }}
                  min={0}
                />
                <span className="text-[10px] text-text-tertiary">tok/s</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-secondary">{t('monitor.slowTtft')}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono">≥</span>
                <InputNumber
                  size="small"
                  style={{ width: 56 }}
                  value={Number(thresholdTexts.ttftSlowMs) || undefined}
                  onChange={(v) => {
                    setThresholdTexts({ ...thresholdTexts, ttftSlowMs: String(v ?? '') });
                    setConfigDirty(true);
                  }}
                  min={0}
                />
                <span className="text-[10px] text-text-tertiary">ms</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-secondary">{t('monitor.minTokens')}</span>
                <InputNumber
                  size="small"
                  style={{ width: 48 }}
                  value={Number(thresholdTexts.minOutputTokens) || undefined}
                  onChange={(v) => {
                    setThresholdTexts({ ...thresholdTexts, minOutputTokens: String(v ?? '') });
                    setConfigDirty(true);
                  }}
                  min={0}
                />
              </div>
            </div>
          </div>

          {/* Alert Notification */}
          <div className="space-y-2">
            <div className="section-header" data-color="green">
              {t('monitor.alertSection')}
            </div>
            <div className="space-y-3 pl-1">
              <div>
                <label className="text-[11px] text-text-secondary mb-1 block">{t('monitor.alertWebhook')}</label>
                <Input
                  placeholder={t('monitor.alertWebhookPlaceholder')}
                  value={draftWebhookUrl}
                  onChange={(e) => {
                    setDraftWebhookUrl(e.target.value);
                    setConfigDirty(true);
                  }}
                />
              </div>
              <div>
                <label className="text-[11px] text-text-secondary mb-1 block">{t('monitor.alertWebhookSecret')}</label>
                <Input.Password
                  placeholder={t('monitor.alertWebhookSecretPlaceholder')}
                  value={draftWebhookSecret}
                  onChange={(e) => {
                    setDraftWebhookSecret(e.target.value);
                    setConfigDirty(true);
                  }}
                />
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-text-secondary">{t('monitor.alertLanguage')}</label>
                  <Select
                    size="small"
                    value={draftAlertLanguage}
                    onChange={(v) => {
                      setDraftAlertLanguage(v);
                      setConfigDirty(true);
                    }}
                    style={{ width: 100 }}
                    options={[
                      { label: 'English', value: 'en' },
                      { label: '中文', value: 'zh' },
                    ]}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-text-secondary">{t('monitor.reminderInterval')}</label>
                  <Select
                    size="small"
                    value={draftReminderMinutes}
                    onChange={(v) => {
                      setDraftReminderMinutes(v);
                      setConfigDirty(true);
                    }}
                    style={{ width: 120 }}
                    options={[
                      { label: '1h', value: 60 },
                      { label: '3h', value: 180 },
                      { label: '6h', value: 360 },
                      { label: '12h', value: 720 },
                      { label: '24h', value: 1440 },
                    ]}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Provider/Model Selection */}
          <div className="space-y-2">
            <div className="section-header" data-color="violet">
              {t('monitor.targets')}
            </div>
            <div className="max-h-[400px] overflow-y-auto space-y-2">
              {providers.map((provider) => {
                const activeModels = provider.models.filter((m: any) => m.isActive !== false);
                const providerDraftTargets = draftTargets.filter((t) => t.providerId === provider.id);
                const allSelected = activeModels.length > 0 && providerDraftTargets.length === activeModels.length;

                return (
                  <div key={provider.id} className="border border-border rounded p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          checked={allSelected}
                          indeterminate={providerDraftTargets.length > 0 && !allSelected}
                          onChange={() =>
                            allSelected ? removeAllForProvider(provider) : selectAllForProvider(provider)
                          }
                        />
                        <span className="text-[12px] font-medium text-text-primary">{provider.name}</span>
                        <Tag style={{ fontSize: 10, margin: 0 }}>{provider.format}</Tag>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2 ml-6">
                      {activeModels.map((m: any) => {
                        const key = `${provider.id}::${m.name}`;
                        const checked = draftTargetKeys.has(key);
                        const targetData = draftTargets.find(
                          (t) => t.providerId === provider.id && t.modelName === m.name,
                        );
                        return (
                          <div key={m.name} className="flex items-center gap-1.5">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                              <Checkbox
                                checked={checked}
                                onChange={() => toggleDraftTarget(provider.id, m.name, provider.name)}
                              />
                              <span className="text-[11px] text-text-secondary font-mono">
                                {m.displayName || m.name}
                              </span>
                              {m.supportsVision && (
                                <span className="text-[8px] px-1 rounded bg-accent-teal/15 text-accent-teal">V</span>
                              )}
                            </label>
                            {checked && (
                              <>
                                <Select
                                  size="small"
                                  value={targetData?.intervalMinutes || 0}
                                  onChange={(v) => updateDraftTargetInterval(provider.id, m.name, v)}
                                  options={INTERVAL_OPTIONS}
                                  style={{ width: 95 }}
                                  popupMatchSelectWidth={false}
                                />
                                <Tooltip
                                  title={
                                    targetData?.alertEnabled !== false ? t('monitor.alertOn') : t('monitor.alertOff')
                                  }
                                >
                                  <button
                                    onClick={() =>
                                      updateDraftTargetAlert(provider.id, m.name, targetData?.alertEnabled === false)
                                    }
                                    className={`text-[12px] transition-colors ${
                                      targetData?.alertEnabled !== false ? 'text-accent-teal' : 'text-text-tertiary'
                                    }`}
                                  >
                                    {targetData?.alertEnabled !== false ? <BellFilled /> : <BellOutlined />}
                                  </button>
                                </Tooltip>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Modal>

      {/* Status Cards Grid */}
      {!initialLoaded ? (
        <div className="glass-card p-8 text-center">
          <span className="text-text-tertiary text-[13px] animate-pulse">{t('common.status.loading')}</span>
        </div>
      ) : targets.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-text-tertiary text-[13px]">
            {providers.length === 0 ? t('monitor.noProviders') : t('monitor.noTargets')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {Array.from(grouped.entries()).map(([providerId, providerTargets]) => {
            const provider = providers.find((p) => p.id === providerId);
            if (!provider) return null;

            const pings = statuses.filter((s) => s.providerId === providerId);

            return (
              <div key={providerId} className="glass-card p-4 space-y-3">
                {/* Provider Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[13px] font-medium text-text-primary">{provider.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Tag style={{ fontSize: 10, margin: 0 }}>{provider.format}</Tag>
                      <span className="text-[10px] text-text-tertiary">
                        {t('monitor.modelsCount', { count: providerTargets.length })}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Model Cards */}
                <div className="space-y-2">
                  {providerTargets.map((target) => {
                    const ping = pings.find((p) => p.modelName === target.modelName);
                    const cls = ping ? ping.healthStatus : null;
                    const modelInfo = provider.models.find((m: any) => m.name === target.modelName);
                    const modelLabel = modelInfo?.displayName || target.modelName;
                    return (
                      <div key={target.modelName} className="rounded border border-border bg-bg-primary p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {cls && <div className={`w-2 h-2 rounded-full ${getStatusDotColor(cls)}`} />}
                            <span className="font-mono text-[12px] text-text-primary">{modelLabel}</span>
                            {cls && (
                              <span
                                className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                                  cls === 'healthy'
                                    ? 'bg-emerald-500/10 text-emerald-400'
                                    : cls === 'slow'
                                      ? 'bg-amber-500/10 text-amber-400'
                                      : cls === 'very_slow'
                                        ? 'bg-orange-500/10 text-orange-400'
                                        : 'bg-red-500/10 text-red-400'
                                }`}
                              >
                                {getStatusLabel(cls, t)}
                              </span>
                            )}
                            <Tooltip
                              title={target.alertEnabled !== false ? t('monitor.alertOn') : t('monitor.alertOff')}
                            >
                              {target.alertEnabled !== false ? (
                                <BellFilled
                                  style={{
                                    fontSize: 11,
                                    color: cls ? STATUS_ICON_COLORS[cls] : '#34d399',
                                  }}
                                />
                              ) : (
                                <BellOutlined style={{ fontSize: 11, color: '#555' }} />
                              )}
                            </Tooltip>
                          </div>
                          {ping ? (
                            <div className="flex items-center gap-1.5 text-[11px] font-mono text-text-tertiary">
                              <Tooltip title={t('monitor.ttftFirstToken')}>
                                <span className={cls ? getStatusTextColor(cls) : ''}>{formatLatency(ping.ttftMs)}</span>
                              </Tooltip>
                              <span>·</span>
                              <Tooltip title={t('monitor.tokensPerSecond')}>
                                <span className={`font-medium ${cls ? getStatusTextColor(cls) : ''}`}>
                                  {ping.status === 'error'
                                    ? t('common.status.fail')
                                    : `${ping.latencyMs > 0 ? Math.round((ping.outputTokens / ping.latencyMs) * 1000) : 0} tok/s`}
                                </span>
                              </Tooltip>
                            </div>
                          ) : (
                            <span className="text-[10px] text-text-tertiary">{t('common.status.pending')}</span>
                          )}
                        </div>
                        {ping?.outputTokens === 0 && ping.status === 'ok' && (
                          <div className="flex items-center gap-1 text-[10px] text-amber-400">
                            <WarningOutlined className="text-[10px]" />
                            <span>{t('monitor.emptyResponse')}</span>
                          </div>
                        )}
                        {ping?.errorMessage && (
                          <div className="text-[10px] text-red-400/80 truncate">{ping.errorMessage}</div>
                        )}
                        <div className="flex items-center justify-between">
                          <HistoryBar history={history} providerId={providerId} modelName={target.modelName} t={t} />
                          <Tooltip
                            title={
                              expandedModels.has(`${providerId}::${target.modelName}`)
                                ? t('monitor.hideTrends')
                                : t('monitor.showTrends')
                            }
                          >
                            <button
                              onClick={() => toggleExpanded(`${providerId}::${target.modelName}`)}
                              className={`ml-2 shrink-0 text-[11px] p-1 rounded transition-colors ${
                                expandedModels.has(`${providerId}::${target.modelName}`)
                                  ? 'text-accent-blue bg-accent-blue/10'
                                  : 'text-text-tertiary hover:text-text-secondary'
                              }`}
                            >
                              <LineChartOutlined />
                            </button>
                          </Tooltip>
                        </div>
                        {expandedModels.has(`${providerId}::${target.modelName}`) && (
                          <TrendCharts
                            history={history}
                            providerId={providerId}
                            modelName={target.modelName}
                            thresholds={thresholds}
                            t={t}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
