// src/pages/agent_stress/stressMeta.ts
//
// 压测页的**纯函数层**：枚举 → 文案/颜色、负载描述、数值格式化、表单 → 契约对象。
//
// 单独抽出来的唯一理由是 `toStressRunCreate`：契约是
// `additionalProperties: false`，多一个字段后端就 422。表单里有一堆纯前端字段
// （load_mode / concurrency / session_rate、摊平的 turns_mean/turns_stddev、
// input_template 是字符串），必须在这里收敛成 yaml 里那几个白名单字段 ——
// 这件事值得有单元测试钉住。
//
// v2 的两处**前端必须替后端先挡一次**的校验：
//   · `session.turns`：`min <= mean <= max`，且截断区间要覆盖 >=5% 的正态概率。
//     后端 422 的 detail 是数组，提示会退化成 "Response status:422"。
//   · `warmup_seconds < duration_seconds`：否则整个运行都在预热窗口里，
//     没有任何可聚合样本，后端同样 422。
import type {
  Distribution,
  LoadMode,
  MockModelConfig,
  RoundingMode,
  SessionConfig,
  StressLoad,
  StressRun,
  StressRunCreate,
  StressRunFormValues,
  StressRunStatus,
  TargetConfig,
  TurnConfig,
  TurnCountConfig,
} from './data';

export interface StressStatusMeta {
  text: string;
  /** antd Tag / Badge 的颜色 token 名，不是 hex */
  color: string;
}

export const STRESS_STATUS_META: Record<StressRunStatus, StressStatusMeta> = {
  queued: { text: '排队中', color: 'default' },
  running: { text: '运行中', color: 'processing' },
  completed: { text: '已完成', color: 'success' },
  failed: { text: '失败', color: 'error' },
  cancelled: { text: '已取消', color: 'warning' },
};

export const AGGREGATION_META: Record<
  'collecting' | 'final' | 'incomplete',
  StressStatusMeta
> = {
  collecting: { text: '聚合中', color: 'processing' },
  final: { text: '已定型', color: 'success' },
  incomplete: { text: '数据不全', color: 'warning' },
};

export const STRESS_STATUS_OPTIONS = (
  Object.keys(STRESS_STATUS_META) as StressRunStatus[]
).map((value) => ({ value, label: STRESS_STATUS_META[value].text }));

/** 会话策略的文案。表单下拉与详情页共用，避免两边写得不一样。 */
export const ON_TURN_FAILURE_OPTIONS = [
  {
    value: 'abort',
    label: '终止会话',
    hint: '该轮失败/超时即放弃后面所有轮次',
  },
  {
    value: 'continue',
    label: '跳过继续',
    hint: '失败那轮跳过，会话仍跑满 N 轮',
  },
] as const;

export const ON_HITL_OPTIONS = [
  { value: 'abort', label: '视为失败', hint: '第一版工具关闭，正常不会遇到' },
  {
    value: 'auto_approve',
    label: '自动通过',
    hint: 'Runner 调 resume 统一同意',
  },
  { value: 'reject', label: '自动拒绝', hint: 'Runner 调 resume 统一拒绝' },
] as const;

export const CLEANUP_OPTIONS = [
  { value: 'keep', label: '保留会话', hint: '适合短跑与复现问题' },
  {
    value: 'delete',
    label: '结束后删除',
    hint: '长压测必须选它，否则会话表会一直涨',
  },
] as const;

export const ROUNDING_OPTIONS = [
  { value: 'round', label: '四舍五入' },
  { value: 'floor', label: '向下取整' },
  { value: 'ceil', label: '向上取整' },
] as const;

/**
 * 后端模拟执行器写的分位算法标识（app/services/stress/application/simulated_runner.py）。
 *
 * 看到它意味着：状态机是真的走了，但指标是**按配置推导**出来的，不是压测结果。
 * 后端文档明确要求前端据此打标，别让用户把它当成容量结论。
 */
export const SIMULATED_ALGORITHM = 'simulated-v1';

/** 终态之后后端不会再改状态，前端也就不该再轮询。 */
export function isTerminal(status: StressRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

/**
 * 负载标签。
 *
 * ⚠️ `concurrency` 在 v2 里是**在途会话数**，不是请求数 —— 文案里必须出现
 * 「会话」，否则会和 v1 的「100 并发」读成同一件事。
 */
export function loadSummary(load: StressLoad): string {
  return load.mode === 'concurrency'
    ? `${load.concurrency} 会话并发`
    : `${load.session_rate} 会话/s`;
}

export function loadDetail(load: StressLoad): string {
  return load.mode === 'concurrency'
    ? `固定并发 · 同时最多 ${load.concurrency} 个在途会话`
    : `固定到达率 · 每秒新建 ${load.session_rate} 个会话`;
}

/** N 的配置描述：`4.5 ± 1.5 轮（1~8）`。 */
export function turnCountLabel(turns: TurnCountConfig | undefined): string {
  if (!turns) return '—';
  const min = turns.min ?? 1;
  const max = turns.max ?? 30;
  const spread = turns.stddev > 0 ? ` ± ${trimNum(turns.stddev)}` : '（固定）';
  return `${trimNum(turns.mean)}${spread} 轮 · 范围 ${min}~${max}`;
}

/**
 * 计划轮次总量：`total_sessions × E[N]`。
 *
 * 只是给用户的量级预估 —— N 是抽样出来的，真值要看
 * `metrics.sessions.turns_per_session`。任一参数缺失就返回 null（不瞎估）。
 */
export function expectedTurns(create: {
  total_sessions?: number | null;
  session?: { turns?: TurnCountConfig };
}): number | null {
  const sessions = create.total_sessions;
  const mean = create.session?.turns?.mean;
  if (typeof sessions !== 'number' || typeof mean !== 'number') return null;
  return Math.round(sessions * mean);
}

/**
 * 到达率 → 轮次速率（轮/s）。
 *
 * 契约只给「每秒**新建会话**数」，而用户口中的 TPS 通常指「每秒跑完多少轮」，
 * 两者差一个 E[N]：`turns/s ≈ session_rate × mean`。
 * 想压 10 轮/s、E[N]=4.5 → 填 `10 / 4.5 ≈ 2.2` 会话/s。
 * 真值看指标里的 `turns.achieved_turns_per_second`（N 是抽样出来的）。
 */
export function turnRateFromSessionRate(
  sessionRate: number | null | undefined,
  mean: number | null | undefined,
): number | null {
  if (typeof sessionRate !== 'number' || typeof mean !== 'number') return null;
  if (!Number.isFinite(sessionRate) || !Number.isFinite(mean)) return null;
  return sessionRate * mean;
}

function trimNum(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 10) / 10);
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('zh-CN');
}

/** 毫秒 → 人读。压测里同一张表既有 3ms 也有 90s，统一按量级切单位。 */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1) return `${(value * 1000).toFixed(0)} µs`;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)} s`;
  return `${(value / 60_000).toFixed(2)} min`;
}

/** 秒 → 人读（用于 duration_seconds） */
export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  // 不足 1 秒不要四舍五入成 "0 秒"（模拟执行器会把 60s 压到几百毫秒）
  if (value > 0 && value < 1) return '< 1 秒';
  const total = Math.max(0, Math.round(value));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    // 整分钟写成「3 分钟」而不是「3 分」—— 后者在表格里像"3 分（得分）"
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 0~1 的比率 → 百分数。1% 以下保留两位，否则一位 —— 压测里 0.05% 和 5% 要分得清。 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const pct = value * 100;
  return `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
}

/** 速率（会话/s、轮次/s）。小于 1 时多给一位，别把 0.42 显示成 0.4。 */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value < 1 ? value.toFixed(3) : value.toFixed(2);
}

/** token 量级差很大，4.2 万比 42,317 更好读 */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export interface DistributionCell {
  key: string;
  label: string;
  value: number | null;
}

/** 把一条 Distribution 摊成表格行。 */
export function distributionRows(
  dist?: Distribution | null,
): DistributionCell[] {
  const pick = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return [
    { key: 'p50', label: 'p50', value: pick(dist?.p50) },
    { key: 'p90', label: 'p90', value: pick(dist?.p90) },
    { key: 'p95', label: 'p95', value: pick(dist?.p95) },
    { key: 'p99', label: 'p99', value: pick(dist?.p99) },
    { key: 'mean', label: '均值', value: pick(dist?.mean) },
    { key: 'min', label: '最小', value: pick(dist?.min) },
    { key: 'max', label: '最大', value: pick(dist?.max) },
  ];
}

/** `turns.by_index` 的 key 是字符串（"1"~"30"），这里按数值排序后再渲染。 */
export function turnIndexRows(
  byIndex: Record<string, Distribution> | undefined,
): { index: number; dist: Distribution }[] {
  if (!byIndex) return [];
  return Object.entries(byIndex)
    .map(([key, dist]) => ({ index: Number.parseInt(key, 10), dist }))
    .filter((row) => Number.isFinite(row.index))
    .sort((a, b) => a.index - b.index);
}

/** 运行进度（0~100）。排队中恒为 0，终态恒为 100。 */
export function runProgress(run: StressRun, now: number = Date.now()): number {
  if (run.status === 'queued') return 0;
  if (isTerminal(run.status)) return 100;
  const startedAt = run.started_at ? Date.parse(run.started_at) : NaN;
  if (Number.isNaN(startedAt)) return 0;
  const elapsed = (now - startedAt) / 1000;
  const duration = Math.max(1, run.config.duration_seconds);
  return Math.min(100, Math.max(0, (elapsed / duration) * 100));
}

/**
 * 已运行秒数。
 *
 * ⚠️ 终态**必须**用 `finished_at - started_at`，不能拿 `now` 去减 ——
 * 否则一个 1 秒就跑完的压测，在页面停留 5 分钟后会显示"已运行 5 分钟"。
 * 未终态才从 started_at 算到此刻（排队中则从 created_at 算"已等待"）。
 */
export function elapsedSeconds(
  run: StressRun,
  now: number = Date.now(),
): number {
  const startedAt = run.started_at ? Date.parse(run.started_at) : NaN;

  if (isTerminal(run.status) && run.finished_at && !Number.isNaN(startedAt)) {
    const finishedAt = Date.parse(run.finished_at);
    if (!Number.isNaN(finishedAt)) {
      return Math.max(0, (finishedAt - startedAt) / 1000);
    }
  }

  const base = run.started_at ?? run.created_at;
  const t = Date.parse(base);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / 1000);
}

const toNum = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toStr = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// ============================================================
// 截断正态：与后端同一套判据
// ============================================================

/** Abramowitz & Stegun 7.1.26 的 erf 近似（误差 < 1.5e-7，够判 5% 门槛）。 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

function normalCdf(x: number, mean: number, stddev: number): number {
  return 0.5 * (1 + erf((x - mean) / (stddev * Math.SQRT2)));
}

/**
 * 截断区间 `[min, max]` 覆盖的正态概率质量。
 *
 * 后端 `TurnCountConfig` 的校验就是这一条：小于 5% 直接 422
 * （拒绝采样会几乎全部失败）。stddev = 0 时没有概率可谈，返回 1。
 */
export function truncatedNormalMass(
  mean: number,
  stddev: number,
  min: number,
  max: number,
): number {
  if (stddev <= 0) return 1;
  return normalCdf(max, mean, stddev) - normalCdf(min, mean, stddev);
}

/** 前端先挡一次的门槛，与后端一致。 */
export const MIN_TRUNCATION_MASS = 0.05;

// ============================================================
// 表单 → 契约
// ============================================================

/**
 * 表单值 → `StressRunCreate`。
 *
 * 规则（都有测试）：
 *   · **空值一律不写 key**，而不是写 null —— `max_turns: null` 在契约里合法，
 *     但 `name: ''` 之外的空串语义含糊；统一省略最省事。
 *   · `load` 由 `load_mode` 决定，只保留被选中的那个字段。
 *   · `turn.streaming` **强制 true**：契约要求（见 data.d.ts 文件头）。
 *   · `session.turns` 在这里做后端同款校验，抛错信息直接给用户看。
 */
export function toStressRunCreate(
  values: StressRunFormValues,
): StressRunCreate {
  const mock = values.mock_model ?? ({} as MockModelConfig);
  const tokensMin = toNum(mock.output_tokens_min);
  const tokensMax = toNum(mock.output_tokens_max);
  if (tokensMin === undefined || tokensMax === undefined) {
    throw new Error('mock_model.output_tokens_min / max 必填');
  }
  if (tokensMax < tokensMin) {
    throw new Error('output_tokens_max 不能小于 output_tokens_min');
  }

  const duration = toNum(values.duration_seconds);
  if (duration === undefined || duration < 1) {
    throw new Error('duration_seconds 必须 ≥ 1');
  }
  const warmup = toNum(values.warmup_seconds);
  if (warmup !== undefined && warmup >= duration) {
    throw new Error(
      `warmup_seconds 必须小于 duration_seconds（当前 ${warmup} ≥ ${duration}）：` +
        '否则整个运行都落在预热窗口里，没有任何可聚合样本',
    );
  }

  const target = buildTarget(values);
  const session = buildSession(values);
  const turn: TurnConfig = {
    streaming: true,
    ...compact({
      input_template: parseInputTemplate(values.input_template),
      input_size_chars: toNum(values.input_size_chars),
    }),
  };

  const body: StressRunCreate = {
    target,
    session,
    turn,
    load: buildLoad(values.load_mode, values.concurrency, values.session_rate),
    duration_seconds: duration,
    request_timeout_ms: toNum(values.request_timeout_ms) ?? 0,
    mock_model: {
      base_latency_ms: toNum(mock.base_latency_ms) ?? 0,
      ttft_ms: toNum(mock.ttft_ms) ?? 0,
      output_tokens_min: tokensMin,
      output_tokens_max: tokensMax,
      tokens_per_second: toNum(mock.tokens_per_second) ?? 0,
      ...compact({
        profile: toStr(mock.profile),
        latency_jitter_ms: toNum(mock.latency_jitter_ms),
        error_rate: toNum(mock.error_rate),
        timeout_rate: toNum(mock.timeout_rate),
        stream_chunk_tokens: toNum(mock.stream_chunk_tokens),
        max_inflight_requests: toNum(mock.max_inflight_requests),
      }),
    },
  };

  return {
    ...body,
    ...compact({
      name: toStr(values.name),
      // token 只传环境变量名；空则整条省略（由服务端配置提供）
      auth: toStr(values.token_env)
        ? { type: 'bearer' as const, token_env: values.token_env?.trim() ?? '' }
        : undefined,
      warmup_seconds: warmup,
      ramp_up_seconds: toNum(values.ramp_up_seconds),
      total_sessions: toNum(values.total_sessions),
      max_turns: toNum(values.max_turns),
      seed: toNum(values.seed),
    }),
  };
}

/**
 * `StressRunCreate` → 表单值 —— `toStressRunCreate` 的**逆向**，给「重新发起」用。
 *
 * ⚠️ 为什么必须有这个函数（而不是把 run.config 直接塞进 initialValues）
 * ----------------------------------------------------------------
 *   两者形状不同，而且是**故意**不同的（见文件头第一条取舍）：
 *     · 契约里 `session.turns` 是嵌套对象，表单里摊平成 `turns_mean` / `turns_stddev`…；
 *     · 契约里 `load` 是三选一（concurrency | session_rate），表单是
 *       `load_mode` + 两个并列数字；
 *     · 契约里 `turn.input_template` 是对象，表单里是 JSON **文本框**；
 *     · 契约里 `auth` 是 `{type, token_env}`，表单里只有一个 `token_env`。
 *   直接塞进去的结果是"表单看起来填了、其实一个字段都对不上"（antd 只认 name）。
 *
 * ⚠️ 与 toStressRunCreate 的对应关系要对得上，但**不要**指望双向完全可逆
 * ---------------------------------------------------------------
 *   源配置里缺省的字段（例如没传 `paths`、`error_rate`）在表单里会落到
 *   `INITIAL_VALUES` 的默认值上 —— 再次发起时这些默认值会被显式写进请求体。
 *   语义上等价（后端本来就用这些默认值），但**字节级**不等于原配置。
 *   所以单测钉的是"关键参数一致"，不是"深比较相等"。
 */
export function fromStressRunCreate(
  config: StressRunCreate,
): Partial<StressRunFormValues> {
  const target = config.target;
  const session = config.session;
  const turns = session.turns;
  const turn = config.turn ?? {};
  const mock = config.mock_model;
  const load = config.load;

  return {
    name: config.name ?? undefined,
    // ---- 目标与认证 ----
    base_url: target.base_url,
    token_env: config.auth?.token_env,
    // 原样回填：源配置没写的保持 undefined，抽屉里的 placeholder 就是后端默认值
    paths: {
      create_session_path: target.create_session_path,
      create_run_path: target.create_run_path,
      run_events_path: target.run_events_path,
      cancel_run_path: target.cancel_run_path,
      resume_run_path: target.resume_run_path,
      delete_session_path: target.delete_session_path,
    },
    // ---- 会话 ----
    agent_id: session.agent_id,
    turns_mean: turns.mean,
    turns_stddev: turns.stddev,
    turns_min: turns.min ?? 1,
    turns_max: turns.max ?? 30,
    turns_rounding: turns.rounding ?? 'round',
    think_time_ms: session.think_time_ms ?? 0,
    on_turn_failure: session.on_turn_failure ?? 'abort',
    on_hitl: session.on_hitl ?? 'abort',
    cleanup: session.cleanup ?? 'keep',
    // ---- 每轮输入 ----
    // 对象 → 缩进 JSON 文本，否则 TextArea 里显示 [object Object]
    input_template: turn.input_template
      ? JSON.stringify(turn.input_template, null, 2)
      : undefined,
    input_size_chars: turn.input_size_chars,
    // 契约强制 true（见 buildTurn 的说明），表单里也是只读的
    streaming: true,
    // ---- 负载与终止 ----
    load_mode: load.mode,
    concurrency: load.mode === 'concurrency' ? load.concurrency : undefined,
    session_rate: load.mode === 'session_rate' ? load.session_rate : undefined,
    duration_seconds: config.duration_seconds,
    warmup_seconds: config.warmup_seconds ?? 0,
    ramp_up_seconds: config.ramp_up_seconds ?? 0,
    total_sessions: config.total_sessions ?? undefined,
    max_turns: config.max_turns ?? undefined,
    request_timeout_ms: config.request_timeout_ms,
    seed: config.seed ?? undefined,
    // ---- 模拟模型 ----
    mock_model: {
      profile: mock.profile ?? undefined,
      base_latency_ms: mock.base_latency_ms,
      latency_jitter_ms: mock.latency_jitter_ms ?? 0,
      ttft_ms: mock.ttft_ms,
      output_tokens_min: mock.output_tokens_min,
      output_tokens_max: mock.output_tokens_max,
      tokens_per_second: mock.tokens_per_second,
      error_rate: mock.error_rate ?? 0,
      timeout_rate: mock.timeout_rate ?? 0,
      stream_chunk_tokens: mock.stream_chunk_tokens ?? 8,
      max_inflight_requests: mock.max_inflight_requests ?? undefined,
    },
  };
}

function buildTarget(values: StressRunFormValues): TargetConfig {
  const baseUrl = values.base_url?.trim();
  if (!baseUrl) throw new Error('target.base_url 必填');
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    throw new Error('target.base_url 必须是 http/https 绝对地址');
  }

  const paths = values.paths ?? {};
  return {
    base_url: baseUrl,
    ...compact({
      create_session_path: toStr(paths.create_session_path),
      create_run_path: toStr(paths.create_run_path),
      run_events_path: toStr(paths.run_events_path),
      cancel_run_path: toStr(paths.cancel_run_path),
      resume_run_path: toStr(paths.resume_run_path),
      delete_session_path: toStr(paths.delete_session_path),
    }),
  };
}

/**
 * `session`：agent_id + N 的分布 + 三种失败/HITL/清理策略。
 *
 * 校验顺序与后端一致（min<=max → mean 落在区间内 → 截断质量 >= 5%），
 * 这样报错文案和 422 的 detail 说的是同一件事。
 */
function buildSession(values: StressRunFormValues): SessionConfig {
  const agentId = values.agent_id?.trim();
  if (!agentId) throw new Error('session.agent_id 必填');

  const mean = toNum(values.turns_mean) ?? 0;
  const stddev = toNum(values.turns_stddev) ?? 0;
  const min = toNum(values.turns_min) ?? 1;
  const max = toNum(values.turns_max) ?? 30;

  if (mean < 1 || mean > 30) throw new Error('session.turns.mean 必须在 1~30');
  if (stddev < 0 || stddev > 30) {
    throw new Error('session.turns.stddev 必须在 0~30');
  }
  if (min < 1 || max > 30 || min > max) {
    throw new Error('session.turns 的 min / max 必须满足 1 ≤ min ≤ max ≤ 30');
  }
  if (mean < min || mean > max) {
    throw new Error(
      `session.turns.mean 必须落在 [min, max] 内（当前 mean=${mean}，区间 ${min}~${max}）`,
    );
  }

  const mass = truncatedNormalMass(mean, stddev, min, max);
  if (mass < MIN_TRUNCATION_MASS) {
    throw new Error(
      `截断区间只覆盖 ${(mass * 100).toFixed(1)}% 的正态概率（< 5%）：` +
        '拒绝采样几乎必然失败，请调小 stddev 或让均值更靠近区间中心',
    );
  }

  return {
    agent_id: agentId,
    turns: {
      mean,
      stddev,
      min,
      max,
      rounding: (values.turns_rounding ?? 'round') as RoundingMode,
    },
    ...compact({
      think_time_ms: toNum(values.think_time_ms),
      on_turn_failure: values.on_turn_failure,
      on_hitl: values.on_hitl,
      cleanup: values.cleanup,
    }),
  };
}

function buildLoad(
  mode: LoadMode,
  concurrency: number | undefined,
  sessionRate: number | undefined,
): StressLoad {
  if (mode === 'session_rate') {
    const rate = toNum(sessionRate);
    if (rate === undefined || rate <= 0) {
      throw new Error('session_rate 必须大于 0');
    }
    return { mode: 'session_rate', session_rate: rate };
  }
  const c = toNum(concurrency);
  if (c === undefined || c < 1) throw new Error('concurrency 必须 ≥ 1');
  return { mode: 'concurrency', concurrency: c };
}

/** input_template 在表单里是一个 JSON 文本框；空串表示沿用后端合成文本。 */
export function parseInputTemplate(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('input_template 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('input_template 必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** 丢掉 undefined 的 key（不动 0 / false 这类合法值）。 */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(input) as (keyof T)[]) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}
