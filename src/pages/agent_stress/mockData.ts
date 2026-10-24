// src/pages/agent_stress/mockData.ts
//
// 内存 mock —— **默认不启用**（后端 app/api/v1/stress_runs.py 已落地）。
// 它服务两个场景：前端离线预览（后端没启动），以及不依赖网络的组件测试。
// 启用方式：localStorage.setItem('agent-stress:mock', '1') 后刷新。
//
// 它不是一堆写死的假 JSON：给定一份 `StressRunCreate`，它会按真实时间轴推演
// queued → running → completed，并按 v2 的**会话 × 轮次**语义推演指标：
//   · 先算计划会话数（并发波次 / 到达率 × 时长，再被 total_sessions 夹住）；
//   · 每个会话按截断正态抽一个 N（同 seed + 同 session_index 必得同一串 N）；
//   · 会话内逐轮跑，失败按 on_turn_failure 决定是否提前结束；
//   · 取消 / max_turns / 时长到点 → 未跑完的会话计 abandoned。
// 所以详情页的轮询、聚合中（collecting）→ 已定型（final）的迁移都能看到。
//
// ⚠️ 所有随机量都用 run_id 做种子的确定性伪随机（不是 Math.random），
//    否则同一页刷新两次数字会跳，看起来像后端在抽风。
import type {
  Distribution,
  MockModelConfig,
  StressRun,
  StressRunCreate,
  StressRunListParams,
  StressRunListResponse,
  StressRunMetrics,
  StressRunStatus,
  TurnCountConfig,
} from './data';
import { isTerminal } from './stressMeta';

/** 排队停留时长：让「排队中」这个状态在演示里真的能被看到 */
const QUEUE_MS = 1500;

/** 模拟上限：跟后端 MAX_PLANNED_SESSIONS 对齐，别推出百万级会话 */
const MAX_PLANNED_SESSIONS = 10_000;

interface MockEntry {
  run: StressRun;
  /** 出队开始跑的时刻（ms） */
  startAt: number;
  /** 提前终止：取消 / 失败。null 表示交给时间推到 completed */
  terminal?: {
    status: Extract<StressRunStatus, 'failed' | 'cancelled'>;
    at: number;
    error_code?: string;
    error_message?: string;
  };
}

const store = new Map<string, MockEntry>();

const iso = (ms: number) => new Date(ms).toISOString();

function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 兜底：只服务老浏览器，格式仍是 uuid v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** FNV-1a：把 run_id 变成稳定的种子 */
function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 0~1 的确定性伪随机；同一个 (seed, index) 永远同一个值 */
function noise(seed: number, index: number): number {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Box-Muller 的标准正态（确定性）。 */
function gauss(seed: number, index: number): number {
  const u1 = Math.max(1e-9, noise(seed, index * 2));
  const u2 = noise(seed, index * 2 + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function materialize(entry: MockEntry, nowMs: number): StressRun {
  const { run, startAt, terminal } = entry;
  const durationMs = run.config.duration_seconds * 1000;

  if (terminal) {
    return {
      ...run,
      status: terminal.status,
      started_at: iso(startAt),
      finished_at: iso(terminal.at),
      error_code: terminal.error_code ?? null,
      error_message: terminal.error_message ?? null,
    };
  }

  if (nowMs < startAt) {
    return {
      ...run,
      status: 'queued',
      started_at: null,
      finished_at: null,
      error_code: null,
      error_message: null,
    };
  }

  const finishAt = startAt + durationMs;
  if (nowMs < finishAt) {
    return {
      ...run,
      status: 'running',
      started_at: iso(startAt),
      finished_at: null,
      error_code: null,
      error_message: null,
    };
  }

  return {
    ...run,
    status: 'completed',
    started_at: iso(startAt),
    finished_at: iso(finishAt),
    error_code: null,
    error_message: null,
  };
}

function findEntry(runId: string): MockEntry {
  const entry = store.get(runId);
  if (!entry) throw notFound(runId);
  return entry;
}

function notFound(runId: string): Error {
  const err = new Error(`跑测 ${runId} 不存在`);
  // umi request 的错误形状：页面只读 status 做 404 分支
  (err as Error & { response?: { status: number } }).response = { status: 404 };
  return err;
}

// ============================================================
// 单轮耗时与轮数抽样
// ============================================================

const EMPTY_DIST: Distribution = {
  count: 0,
  mean: null,
  min: null,
  max: null,
  p50: null,
  p90: null,
  p95: null,
  p99: null,
};

function averageTokens(cfg: MockModelConfig): number {
  return (cfg.output_tokens_min + cfg.output_tokens_max) / 2;
}

/** 单轮 Agent Run 的模拟耗时（ms）：基础时延 + 抖动均值 + 首 token + 生成全部 token */
export function mockMeanLatencyMs(cfg: MockModelConfig): number {
  const gen =
    (averageTokens(cfg) / Math.max(0.1, cfg.tokens_per_second)) * 1000;
  return (
    cfg.base_latency_ms + (cfg.latency_jitter_ms ?? 0) / 2 + cfg.ttft_ms + gen
  );
}

/** 一个会话平均跑多久（秒）= 平均轮数 × (单轮耗时 + 轮间停顿) */
function avgSessionSeconds(cfg: StressRunCreate): number {
  const turnSeconds =
    mockMeanLatencyMs(cfg.mock_model) / 1000 +
    (cfg.session.think_time_ms ?? 0) / 1000;
  return Math.max(1, cfg.session.turns.mean * turnSeconds);
}

/** 计划会话数：负载模式 × 时长，再被 total_sessions 夹住（与后端同口径）。 */
function plannedSessions(cfg: StressRunCreate): number {
  let planned: number;
  if (cfg.load.mode === 'concurrency') {
    planned =
      (cfg.duration_seconds / avgSessionSeconds(cfg)) * cfg.load.concurrency;
  } else {
    planned = cfg.load.session_rate * cfg.duration_seconds;
  }
  if (cfg.total_sessions != null)
    planned = Math.min(planned, cfg.total_sessions);
  return clamp(Math.round(planned), 1, MAX_PLANNED_SESSIONS);
}

function applyRounding(value: number, rounding: TurnCountConfig['rounding']) {
  if (rounding === 'floor') return Math.floor(value);
  if (rounding === 'ceil') return Math.ceil(value);
  // 与后端一致：floor(x + 0.5)，不用银行家舍入
  return Math.floor(value + 0.5);
}

/**
 * 从截断正态抽一个 N。
 *
 * `sessionIndex` 进种子，保证「并发顺序不影响抽样」—— 这是后端 §4.3 的硬要求，
 * mock 也照做，否则同一个 seed 刷新两次就不是同一串 N 了。
 */
export function sampleTurns(
  turns: TurnCountConfig,
  seed: number,
  sessionIndex: number,
): number {
  const min = turns.min ?? 1;
  const max = turns.max ?? 30;
  const sd = turns.stddev ?? 0;

  if (sd <= 0) {
    return clamp(applyRounding(turns.mean, turns.rounding), min, max);
  }

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = turns.mean + sd * gauss(seed, sessionIndex * 1000 + attempt);
    if (value >= min && value <= max) {
      return clamp(applyRounding(value, turns.rounding), min, max);
    }
  }
  return clamp(applyRounding(turns.mean, turns.rounding), min, max);
}

/** 从一组样本算分布（真实分位，不是拍一个倍数）。 */
function distOf(values: number[]): Distribution {
  if (values.length === 0) return { ...EMPTY_DIST };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[
      clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1)
    ];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean: round1(sum / sorted.length),
    min: round1(sorted[0]),
    max: round1(sorted[sorted.length - 1]),
    p50: round1(at(50)),
    p90: round1(at(90)),
    p95: round1(at(95)),
    p99: round1(at(99)),
  };
}

// ============================================================
// 指标推演（会话 × 轮次）
// ============================================================

function emptyMetrics(run: StressRun): StressRunMetrics {
  return {
    run_id: run.run_id,
    aggregation_status: 'collecting',
    aggregation_algorithm: null,
    finalized_at: null,
    sessions: {
      started: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      completion_rate: null,
      achieved_sessions_per_second: null,
      duration_ms: { ...EMPTY_DIST },
      sampled_turns_per_session: { ...EMPTY_DIST },
      turns_per_session: { ...EMPTY_DIST },
    },
    turns: {
      started: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      achieved_turns_per_second: null,
      error_rate: null,
      latency_ms: { ...EMPTY_DIST },
      time_to_first_output_ms: { ...EMPTY_DIST },
      first_turn_latency_ms: { ...EMPTY_DIST },
      later_turn_latency_ms: { ...EMPTY_DIST },
      by_index: {},
    },
    trace_counts: {},
    model: {
      call_count: 0,
      retry_count: 0,
      error_count: 0,
      input_tokens_sum: 0,
      output_tokens_sum: 0,
      duration_ms: { ...EMPTY_DIST },
      input_tokens_per_turn: { ...EMPTY_DIST },
      output_tokens_per_turn: { ...EMPTY_DIST },
    },
    nodes: {},
    tools: {},
    fanout: { count: 0, branch_count: 0, failed_branch_count: 0 },
    ingestion: {
      events_seen: 0,
      events_deduplicated: 0,
      events_unmatched: 0,
      events_late: 0,
    },
  };
}

function buildMetrics(entry: MockEntry, nowMs: number): StressRunMetrics {
  const run = materialize(entry, nowMs);
  const cfg = run.config;
  const seed = hashSeed(run.run_id);

  if (run.status === 'queued') return emptyMetrics(run);

  const startedMs = Date.parse(run.started_at ?? iso(entry.startAt));
  const finishedMs = run.finished_at ? Date.parse(run.finished_at) : nowMs;
  const observed = Math.max(
    0,
    (Math.min(finishedMs, nowMs) - startedMs) / 1000,
  );
  const warmup = Math.min(cfg.warmup_seconds ?? 0, observed);
  const effective = Math.max(0.001, observed - warmup);
  const progress =
    run.status === 'running'
      ? clamp(
          (observed - warmup) / Math.max(1, cfg.duration_seconds - warmup),
          0,
          1,
        )
      : 1;

  const planned = plannedSessions(cfg);
  const sessionsStarted =
    run.status === 'running'
      ? clamp(Math.round(planned * progress), 0, planned)
      : planned;

  const errorRate = cfg.mock_model.error_rate ?? 0;
  const timeoutRate = cfg.mock_model.timeout_rate ?? 0;
  const abortOnFailure = (cfg.session.on_turn_failure ?? 'abort') === 'abort';
  const thinkMs = cfg.session.think_time_ms ?? 0;
  const ttftMs = cfg.mock_model.base_latency_ms + cfg.mock_model.ttft_ms;
  const baseLatency = mockMeanLatencyMs(cfg.mock_model);

  let sessionsCompleted = 0;
  let sessionsFailed = 0;
  let sessionsAbandoned = 0;

  let turnsStarted = 0;
  let turnsSucceeded = 0;
  let turnsFailed = 0;
  let turnsTimedOut = 0;
  let turnsCancelled = 0;

  const sampledTurns: number[] = [];
  const actualTurns: number[] = [];
  const sessionDurations: number[] = [];
  const turnLatencies: number[] = [];
  const ttfts: number[] = [];
  const firstTurnLatencies: number[] = [];
  const laterTurnLatencies: number[] = [];
  const byIndexRaw: Record<string, number[]> = {};
  const inputTokensPerTurn: number[] = [];
  const outputTokensPerTurn: number[] = [];

  for (let i = 0; i < sessionsStarted; i += 1) {
    const n = sampleTurns(cfg.session.turns, seed, i);
    sampledTurns.push(n);

    // 会话内的轮次进度：running 时只跑到 progress 那一截
    let plannedTurnsForSession = n;
    if (run.status === 'running') {
      plannedTurnsForSession = clamp(
        Math.round(n * progress),
        progress > 0 ? 1 : 0,
        n,
      );
    }

    let executed = 0;
    let aborted: 'failed' | null = null;
    let truncated = false;
    let sessionMs = 0;

    for (let t = 1; t <= plannedTurnsForSession; t += 1) {
      // max_turns 是整轮 Run 的硬上限
      if (cfg.max_turns != null && turnsStarted >= cfg.max_turns) {
        truncated = true;
        break;
      }

      turnsStarted += 1;
      const latency =
        baseLatency *
        (1 +
          Math.min(0.45, 0.014 * (t - 1)) *
            (0.9 + noise(seed, i * 31 + t) * 0.2));
      const roll = noise(seed, i * 97 + t * 13);

      let outcome: 'succeeded' | 'failed' | 'timed_out' = 'succeeded';
      if (roll < timeoutRate) outcome = 'timed_out';
      else if (roll < timeoutRate + errorRate) outcome = 'failed';

      if (outcome === 'succeeded') {
        turnsSucceeded += 1;
        turnLatencies.push(latency);
        ttfts.push(ttftMs * (0.85 + noise(seed, i * 7 + t) * 0.3));
        // 按轮次序号分桶（key 是 "1".."30" 的字符串，与后端 by_index 一致）
        const indexKey = String(t);
        if (!byIndexRaw[indexKey]) byIndexRaw[indexKey] = [];
        byIndexRaw[indexKey].push(latency);
        if (t === 1) firstTurnLatencies.push(latency);
        else laterTurnLatencies.push(latency);

        const inTokens =
          Math.max(80, (cfg.turn?.input_size_chars ?? 512) / 3) + 60 * (t - 1);
        const outTokens =
          averageTokens(cfg.mock_model) * (0.9 + noise(seed, i * 11 + t) * 0.2);
        inputTokensPerTurn.push(Math.round(inTokens));
        outputTokensPerTurn.push(Math.round(outTokens));
      } else if (outcome === 'failed') {
        turnsFailed += 1;
      } else {
        turnsTimedOut += 1;
      }

      sessionMs += latency + (t > 1 ? thinkMs : 0);
      executed = t;

      if (outcome !== 'succeeded' && abortOnFailure) {
        aborted = 'failed';
        break;
      }
    }

    actualTurns.push(executed);

    if (run.status === 'cancelled') {
      // 取消时每个会话最多有一个在飞轮次被波及
      if (executed < n) turnsCancelled += 1;
      sessionsAbandoned += 1;
      sessionDurations.push(sessionMs);
      continue;
    }

    if (aborted) {
      sessionsFailed += 1;
    } else if (truncated || executed < n) {
      if (run.status === 'running') {
        // 还在跑，既不算完成也不算放弃
      } else {
        sessionsAbandoned += 1;
      }
    } else {
      sessionsCompleted += 1;
    }
    sessionDurations.push(sessionMs);
  }

  const finalized =
    run.status === 'cancelled'
      ? 'incomplete'
      : run.status === 'failed'
        ? 'incomplete'
        : isTerminal(run.status)
          ? 'final'
          : 'collecting';

  const turnsCompleted = turnsSucceeded + turnsFailed;
  const modelCalls = Math.round(turnsStarted * 2);
  const toolCalls = Math.round(turnsStarted * noise(seed, 3) * 0.7);
  const nodeSpans = Math.round(turnsStarted * 2.2);
  const fanoutCount = Math.round(turnsStarted * 0.1);
  const eventsSeen = Math.round(turnsStarted * 8 + modelCalls * 2 + nodeSpans);

  const byIndex: Record<string, Distribution> = {};
  for (const [key, values] of Object.entries(byIndexRaw)) {
    byIndex[key] = distOf(values);
  }

  return {
    run_id: run.run_id,
    aggregation_status: finalized,
    aggregation_algorithm: finalized === 'collecting' ? null : 'tdigest-v1',
    finalized_at:
      finalized === 'collecting' ? null : (run.finished_at ?? iso(nowMs)),
    sessions: {
      started: sessionsStarted,
      completed: sessionsCompleted,
      failed: sessionsFailed,
      abandoned: sessionsAbandoned,
      completion_rate:
        sessionsStarted > 0 ? sessionsCompleted / sessionsStarted : null,
      achieved_sessions_per_second:
        sessionsCompleted > 0 ? round3(sessionsCompleted / effective) : null,
      duration_ms: distOf(sessionDurations),
      sampled_turns_per_session: distOf(sampledTurns),
      turns_per_session: distOf(actualTurns),
    },
    turns: {
      started: turnsStarted,
      completed: turnsCompleted,
      succeeded: turnsSucceeded,
      failed: turnsFailed,
      timed_out: turnsTimedOut,
      cancelled: turnsCancelled,
      achieved_turns_per_second:
        turnsCompleted > 0 ? round3(turnsCompleted / effective) : null,
      error_rate:
        turnsStarted > 0 ? (turnsFailed + turnsTimedOut) / turnsStarted : null,
      latency_ms: distOf(turnLatencies),
      time_to_first_output_ms: distOf(ttfts),
      first_turn_latency_ms: distOf(firstTurnLatencies),
      later_turn_latency_ms: distOf(laterTurnLatencies),
      by_index: byIndex,
    },
    trace_counts: {
      run_span_count: turnsStarted,
      node_span_count: nodeSpans,
      model_call_count: modelCalls,
      tool_call_count: toolCalls,
      context_build_count: turnsStarted,
      fanout_count: fanoutCount,
    },
    model: {
      call_count: modelCalls,
      retry_count: Math.round(modelCalls * (0.01 + noise(seed, 7) * 0.02)),
      error_count: Math.round(modelCalls * errorRate),
      input_tokens_sum: inputTokensPerTurn.reduce((a, b) => a + b, 0),
      output_tokens_sum: outputTokensPerTurn.reduce((a, b) => a + b, 0),
      duration_ms: distOf(
        inputTokensPerTurn.length > 0 ? turnLatencies.map((v) => v * 0.72) : [],
      ),
      input_tokens_per_turn: distOf(inputTokensPerTurn),
      output_tokens_per_turn: distOf(outputTokensPerTurn),
    },
    nodes: {
      main_agent: distOf(turnLatencies),
      classification: distOf(turnLatencies.map((v) => v * 0.35)),
    },
    tools:
      toolCalls > 0
        ? {
            web_search: distOf(
              turnLatencies
                .slice(0, Math.max(1, Math.round(toolCalls * 0.6)))
                .map((v) => v * 0.55),
            ),
            doc_retriever: distOf(
              turnLatencies
                .slice(0, Math.max(1, Math.round(toolCalls * 0.3)))
                .map((v) => v * 0.22),
            ),
          }
        : {},
    fanout: {
      count: fanoutCount,
      branch_count: fanoutCount * 2,
      failed_branch_count: Math.round(fanoutCount * 2 * (errorRate + 0.005)),
    },
    ingestion: {
      events_seen: eventsSeen,
      events_deduplicated: Math.round(eventsSeen * 0.028),
      events_unmatched: Math.round(eventsSeen * 0.004),
      events_late: Math.round(eventsSeen * 0.007),
    },
  };
}

// ============================================================
// 种子数据：覆盖 queued / running / completed / failed / cancelled
// ============================================================

const SEED_NOW = Date.now();

function baseTarget(baseUrl = 'http://127.0.0.1:8080') {
  return {
    base_url: baseUrl,
    create_session_path: '/api/v1/sessions',
    create_run_path: '/api/v1/sessions/{session_id}/runs',
    run_events_path: '/api/v1/runs/{run_id}/events',
    cancel_run_path: '/api/v1/runs/{run_id}/cancel',
    resume_run_path: '/api/v1/runs/{run_id}/resume',
    delete_session_path: '/api/v1/sessions/{session_id}',
  };
}

function seedRun(input: {
  id: string;
  name: string;
  createdOffsetMs: number;
  durationSeconds: number;
  load: StressRunCreate['load'];
  totalSessions?: number | null;
  maxTurns?: number | null;
  agentId?: string;
  turns?: Partial<TurnCountConfig>;
  thinkTimeMs?: number;
  cleanup?: StressRunCreate['session']['cleanup'];
  mock?: Partial<MockModelConfig>;
  terminal?: MockEntry['terminal'];
}): MockEntry {
  const created = SEED_NOW - input.createdOffsetMs;
  const config: StressRunCreate = {
    name: input.name,
    target: baseTarget(),
    auth: { type: 'bearer', token_env: 'STRESS_RUNNER_TOKEN' },
    session: {
      agent_id: input.agentId ?? 'general',
      turns: {
        mean: 4.5,
        stddev: 1.5,
        min: 1,
        max: 8,
        rounding: 'round',
        ...input.turns,
      },
      think_time_ms: input.thinkTimeMs ?? 0,
      on_turn_failure: 'abort',
      on_hitl: 'abort',
      cleanup: input.cleanup ?? 'keep',
      metadata: {},
    },
    turn: {
      input_template: { text: '压测用合成请求，不包含真实用户数据' },
      input_size_chars: 480,
      streaming: true,
    },
    load: input.load,
    duration_seconds: input.durationSeconds,
    warmup_seconds: 0,
    ramp_up_seconds: 10,
    total_sessions: input.totalSessions ?? 12,
    max_turns: input.maxTurns ?? null,
    request_timeout_ms: 120_000,
    seed: 42,
    mock_model: {
      profile: 'balanced',
      base_latency_ms: 180,
      latency_jitter_ms: 60,
      ttft_ms: 240,
      output_tokens_min: 180,
      output_tokens_max: 520,
      tokens_per_second: 90,
      error_rate: 0.008,
      timeout_rate: 0.002,
      stream_chunk_tokens: 8,
      ...input.mock,
    },
  };
  const run: StressRun = {
    run_id: input.id,
    name: input.name,
    status: 'queued',
    config,
    created_at: iso(created),
    started_at: null,
    finished_at: null,
    error_code: null,
    error_message: null,
  };
  return {
    run,
    // 种子任务「创建即出队」，不然每一条都会先显示排队中
    startAt: created + 800,
    terminal: input.terminal,
  };
}

store.set(
  '3f2a9c41-0b7e-4a52-9c1d-5e6f7a8b9c01',
  seedRun({
    id: '3f2a9c41-0b7e-4a52-9c1d-5e6f7a8b9c01',
    name: 'baseline · 12 会话 / 平均 4.5 轮',
    createdOffsetMs: 2 * 60 * 60 * 1000,
    durationSeconds: 60,
    load: { mode: 'concurrency', concurrency: 10 },
    totalSessions: 12,
  }),
);

store.set(
  '8c51d7b2-3a94-4f60-b1e8-2d7c9a4e5f32',
  seedRun({
    id: '8c51d7b2-3a94-4f60-b1e8-2d7c9a4e5f32',
    name: 'steady · 2 会话/s',
    createdOffsetMs: 90 * 60 * 1000,
    durationSeconds: 120,
    load: { mode: 'session_rate', session_rate: 2 },
    totalSessions: 240,
    turns: { mean: 6, stddev: 2 },
    mock: { tokens_per_second: 140, ttft_ms: 180 },
  }),
);

// 故意留一条「正在跑」的：详情页能直接看到 aggregation=collecting 与数字持续上涨
store.set(
  'd4e6b8a0-1f3c-4d7e-9a2b-6c5d4e3f2a10',
  seedRun({
    id: 'd4e6b8a0-1f3c-4d7e-9a2b-6c5d4e3f2a10',
    name: 'ramp-up · 10→100 会话并发',
    createdOffsetMs: 45 * 1000,
    durationSeconds: 180,
    load: { mode: 'concurrency', concurrency: 100 },
    totalSessions: 60,
    agentId: 'stock_research',
    turns: { mean: 8, stddev: 3, max: 16 },
    thinkTimeMs: 800,
    mock: {
      base_latency_ms: 320,
      output_tokens_max: 900,
      tokens_per_second: 60,
    },
  }),
);

store.set(
  '6b0f2e58-7c41-4a3d-8e9f-1a2b3c4d5e60',
  seedRun({
    id: '6b0f2e58-7c41-4a3d-8e9f-1a2b3c4d5e60',
    name: '工具重试风暴（模拟失败）',
    createdOffsetMs: 30 * 60 * 1000,
    durationSeconds: 60,
    load: { mode: 'concurrency', concurrency: 200 },
    totalSessions: 120,
    turns: { mean: 10, stddev: 4 },
    mock: { error_rate: 0.18, timeout_rate: 0.06 },
    terminal: {
      status: 'failed',
      at: SEED_NOW - 29 * 60 * 1000,
      error_code: 'MOCK_MODEL_UNAVAILABLE',
      error_message:
        '模拟模型连接被重置：error_rate 设为 0.18 时网关连续 5 次 5xx，跑测提前终止',
    },
  }),
);

store.set(
  'a17c9e34-5b62-4d80-9f1e-0c3b7a6d2e41',
  seedRun({
    id: 'a17c9e34-5b62-4d80-9f1e-0c3b7a6d2e41',
    name: '突发 500 会话（手动取消）',
    createdOffsetMs: 20 * 60 * 1000,
    durationSeconds: 300,
    load: { mode: 'concurrency', concurrency: 500 },
    totalSessions: 500,
    turns: { mean: 12, stddev: 5 },
    mock: { base_latency_ms: 400, output_tokens_max: 800 },
    terminal: {
      status: 'cancelled',
      at: SEED_NOW - 19 * 60 * 1000,
    },
  }),
);

// ============================================================
// 对外 API（签名与 service.ts 一一对应）
// ============================================================

export async function createStressRun(
  body: StressRunCreate,
): Promise<StressRun> {
  const runId = uuid();
  const createdAt = Date.now();
  const run: StressRun = {
    run_id: runId,
    name: body.name ?? null,
    status: 'queued',
    config: body,
    created_at: iso(createdAt),
    started_at: null,
    finished_at: null,
    error_code: null,
    error_message: null,
  };
  store.set(runId, { run, startAt: createdAt + QUEUE_MS });
  return { ...run };
}

export async function listStressRuns(
  params: StressRunListParams = {},
): Promise<StressRunListResponse> {
  const nowMs = Date.now();
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const offset = Number.parseInt(params.cursor ?? '0', 10) || 0;

  const all = [...store.values()]
    .map((entry) => materialize(entry, nowMs))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .filter((run) => (params.status ? run.status === params.status : true));

  const page = all.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    items: page,
    next_cursor: next < all.length ? String(next) : null,
  };
}

export async function getStressRun(runId: string): Promise<StressRun> {
  return materialize(findEntry(runId), Date.now());
}

export async function getStressRunMetrics(
  runId: string,
): Promise<StressRunMetrics> {
  return buildMetrics(findEntry(runId), Date.now());
}

export async function cancelStressRun(runId: string): Promise<StressRun> {
  const entry = findEntry(runId);
  const current = materialize(entry, Date.now());
  if (isTerminal(current.status)) {
    const err = new Error(`跑测已结束（${current.status}），无法取消`);
    (err as Error & { response?: { status: number } }).response = {
      status: 409,
    };
    throw err;
  }
  entry.terminal = { status: 'cancelled', at: Date.now() };
  return materialize(entry, Date.now());
}
