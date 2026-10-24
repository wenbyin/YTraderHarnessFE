// src/pages/agent_stress/data.d.ts
//
// 类型镜像：YTraderHarness/design_agent_eval/openapi.yaml（v2.0.0, 多轮会话版）
// 对照实现：app/services/stress/domain/schemas/stress.py
//
// 命名与契约**逐字对齐**，不用「前端更好听」的名字 —— 后端 codegen 出来的
// 就是这些字段，改名前先改 yaml，否则联调时要在两层之间翻译一遍。
//
// 四条容易踩的语义：
//   1. `StressRunCreate.additionalProperties: false`：**多传一个字段就是 422**。
//      所以表单永远走 `toStressRunCreate()` 收敛成白名单对象，不要把 antd 的
//      表单值（含 load_mode / turns_mean 这种纯前端字段）直接 POST 出去。
//   2. v2 是**多轮会话**：`agent_type` 搬进了 `session.agent_id`，
//      `payload_template` / `input_size_chars` / `streaming` 搬进 `turn`，
//      `think_time_ms` 搬进 `session`，`request_rate` 改名 `session_rate`，
//      `max_requests` 换成 `max_turns` + `total_sessions`。
//      整个 `target` 也从字符串变成了对象（base_url + 6 条路径模板）。
//   3. `metrics` 是**运行期快照**，按会话 / 轮次两组给：
//      `sessions.*` 是 Runner 侧的会话结果，`turns.*` 是轮次结果。
//      running 时 `aggregation_status = collecting`，数字会一直涨。
//   4. `turn.streaming` 后端强制 true（Agent 没有 GET /runs/{id}，非流式
//      无法判断单轮终态）；传 false 直接 422。前端把它做成只读。
//
// ⚠️ `Distribution` 里**没有** `minimum` 了：v2 的响应只有 `min`。
//    旧版 yaml 那个 `minimum: 0` 是笔误，后端 DTO 从来没回过。

export type StressRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AggregationStatus = 'collecting' | 'final' | 'incomplete';

/** N 的取整方式；`-1.5` 这类半值按 round 的一半进位（后端不用银行家舍入）。 */
export type RoundingMode = 'round' | 'floor' | 'ceil';

/** 某轮失败后：终止整个会话，还是跳过这轮继续。 */
export type OnTurnFailure = 'abort' | 'continue';

/** 遇到 waiting_input（人工审批）时怎么办。 */
export type OnHitl = 'abort' | 'auto_approve' | 'reject';

/** 会话结束后是否 DELETE 掉后端会话。 */
export type SessionCleanup = 'keep' | 'delete';

// ============================================================
// 请求：目标与认证
// ============================================================

/**
 * 被测 Agent 的地址与端点模板。
 *
 * 六条路径都有后端默认值，前端只在「高级」里暴露 —— 联调换了前缀才需要改。
 * `{session_id}` / `{run_id}` 由 Runner 自己替换，前端不碰。
 */
export interface TargetConfig {
  base_url: string;
  create_session_path?: string;
  create_run_path?: string;
  run_events_path?: string;
  cancel_run_path?: string;
  resume_run_path?: string;
  delete_session_path?: string;
}

/**
 * Runner 访问被测服务的凭据。
 *
 * ⚠️ 只有**环境变量名**，没有明文 token —— config 会落库并原样回显。
 * 前端连 token 输入框都不该有。
 */
export interface AuthConfig {
  type: 'bearer';
  token_env: string;
}

// ============================================================
// 请求：会话与轮次
// ============================================================

/**
 * 会话轮数 N 的截断正态参数。
 *
 * `mean` / `stddev` 描述的是**截断前**的正态；截断后实际均值会偏移，
 * 所以指标里另外给了 `sampled_turns_per_session` 供核对。
 * 后端校验：`min <= mean <= max`，且截断区间至少覆盖 5% 的正态概率。
 */
export interface TurnCountConfig {
  mean: number;
  stddev: number;
  min?: number;
  max?: number;
  rounding?: RoundingMode;
}

export interface SessionConfig {
  /** 建会话时传给 `POST /sessions` 的 agent_id */
  agent_id: string;
  turns: TurnCountConfig;
  /** 同一会话两轮之间的等待；不作用于「建会话 → 第 1 轮」 */
  think_time_ms?: number;
  on_turn_failure?: OnTurnFailure;
  on_hitl?: OnHitl;
  /** `delete` 会在会话结束后删掉后端会话，长压测必须用它 */
  cleanup?: SessionCleanup;
  metadata?: Record<string, unknown>;
}

export interface TurnConfig {
  /** 每轮 CreateRunRequest.input 的模板，例如 {"text": "..."} */
  input_template?: Record<string, unknown> | null;
  /** 没给 input_template 时，合成该长度的文本 */
  input_size_chars?: number;
  /** v2 必须为 true（见文件头第 4 条） */
  streaming?: boolean;
}

// ============================================================
// 请求：负载与模拟模型
// ============================================================

/** 固定并发：**同时在途的会话数**，不是请求数。 */
export interface ConcurrencyLoad {
  mode: 'concurrency';
  concurrency: number;
}

/** 固定到达率：每秒**新建会话数**；轮次速率约为 `session_rate × E[N]`。 */
export interface SessionRateLoad {
  mode: 'session_rate';
  session_rate: number;
}

export type StressLoad = ConcurrencyLoad | SessionRateLoad;

/** 被压测的目标模型替身。required 五项是契约硬要求。 */
export interface MockModelConfig {
  profile?: string | null;
  base_latency_ms: number;
  latency_jitter_ms?: number;
  ttft_ms: number;
  output_tokens_min: number;
  output_tokens_max: number;
  tokens_per_second: number;
  /** 0~1，非百分数 */
  error_rate?: number;
  /** 0~1，非百分数 */
  timeout_rate?: number;
  stream_chunk_tokens?: number;
  max_inflight_requests?: number | null;
}

export interface StressRunCreate {
  name?: string | null;
  target: TargetConfig;
  /** 不传则由服务端配置提供 token */
  auth?: AuthConfig | null;
  session: SessionConfig;
  turn?: TurnConfig;
  load: StressLoad;
  duration_seconds: number;
  warmup_seconds?: number;
  ramp_up_seconds?: number;
  /** 有限工作负载：接纳满这么多会话就不再建；不传则由时长与负载决定 */
  total_sessions?: number | null;
  /** 整个 Run 的轮次硬上限 */
  max_turns?: number | null;
  request_timeout_ms: number;
  seed?: number | null;
  mock_model: MockModelConfig;
}

export interface StressRun {
  run_id: string;
  name?: string | null;
  status: StressRunStatus;
  config: StressRunCreate;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface StressRunListResponse {
  items: StressRun[];
  next_cursor?: string | null;
}

export interface StressRunListParams {
  status?: StressRunStatus;
  limit?: number;
  cursor?: string;
}

// ============================================================
// 响应：聚合指标
// ============================================================

/** 聚合分布。样本为 0 时除 count 以外全是 null。 */
export interface Distribution {
  count?: number;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  p50?: number | null;
  p90?: number | null;
  p95?: number | null;
  p99?: number | null;
}

/** 会话级（Runner 计算）。 */
export interface SessionMetrics {
  /** 尝试建会话的次数（含失败） */
  started?: number;
  /** 跑满计划 N 轮的会话数 */
  completed?: number;
  failed?: number;
  /** 因时长 / 取消 / max_turns 被截断 */
  abandoned?: number;
  completion_rate?: number | null;
  achieved_sessions_per_second?: number | null;
  /** 会话从建立到结束的端到端时延 */
  duration_ms?: Distribution;
  /** 每个会话创建时抽到的 N */
  sampled_turns_per_session?: Distribution;
  /** 每个会话实际**发起**的轮数（abort / 截断时小于 N） */
  turns_per_session?: Distribution;
}

/** 轮次级（Runner + Aggregator）。 */
export interface TurnMetrics {
  started?: number;
  /** 收到终态的轮次 = succeeded + failed（不含 timed_out / cancelled） */
  completed?: number;
  succeeded?: number;
  failed?: number;
  timed_out?: number;
  cancelled?: number;
  achieved_turns_per_second?: number | null;
  /** (failed + timed_out) / started，不含取消 */
  error_rate?: number | null;
  latency_ms?: Distribution;
  time_to_first_output_ms?: Distribution;
  /** 每个会话第 1 轮 */
  first_turn_latency_ms?: Distribution;
  /** 第 2 轮及以后 */
  later_turn_latency_ms?: Distribution;
  /** key = "1" ~ "30"，只包含实际出现过的轮次 */
  by_index?: Record<string, Distribution>;
}

export interface StressModelMetrics {
  call_count?: number;
  retry_count?: number;
  error_count?: number;
  input_tokens_sum?: number;
  output_tokens_sum?: number;
  duration_ms?: Distribution;
  /** 多轮会话里后续轮输入会涨，所以按轮统计而不是假设恒定 */
  input_tokens_per_turn?: Distribution;
  output_tokens_per_turn?: Distribution;
}

export interface StressFanoutMetrics {
  count?: number;
  branch_count?: number;
  failed_branch_count?: number;
}

export interface StressIngestionMetrics {
  events_seen?: number;
  events_deduplicated?: number;
  events_unmatched?: number;
  events_late?: number;
}

export interface StressRunMetrics {
  run_id: string;
  aggregation_status: AggregationStatus;
  /**
   * 分位算法标识。后端模拟执行器写 `simulated-v1` —— 看到它说明
   * 指标是按压测参数**推导**的，不是真实请求的统计（详情页据此打「模拟指标」标）。
   */
  aggregation_algorithm?: string | null;
  finalized_at?: string | null;
  sessions: SessionMetrics;
  turns: TurnMetrics;
  /** 例如 { run_span_count: 54, model_call_count: 108 } —— key 是有限枚举 */
  trace_counts?: Record<string, number>;
  model?: StressModelMetrics;
  /** key = 节点名 */
  nodes?: Record<string, Distribution>;
  /** key = 工具名 */
  tools?: Record<string, Distribution>;
  fanout?: StressFanoutMetrics;
  ingestion?: StressIngestionMetrics;
}

// ============================================================
// 表单值（只在前端存在，POST 前用 toStressRunCreate 收敛）
// ============================================================

export type LoadMode = StressLoad['mode'];

/** 「高级」里的六条路径覆盖；留空就用后端默认值。 */
export type TargetPathValues = Omit<TargetConfig, 'base_url'>;

export interface StressRunFormValues {
  name?: string;
  // ---- 目标与认证 ----
  base_url: string;
  token_env?: string;
  paths?: TargetPathValues;
  // ---- 会话 ----
  agent_id: string;
  /** 表单把 `session.turns` 摊平，避免嵌套四层 */
  turns_mean: number;
  turns_stddev: number;
  turns_min?: number;
  turns_max?: number;
  turns_rounding: RoundingMode;
  think_time_ms?: number;
  on_turn_failure: OnTurnFailure;
  on_hitl: OnHitl;
  cleanup: SessionCleanup;
  // ---- 每轮输入 ----
  input_template?: string;
  input_size_chars?: number;
  streaming: boolean;
  // ---- 负载与终止 ----
  load_mode: LoadMode;
  concurrency?: number;
  session_rate?: number;
  duration_seconds: number;
  warmup_seconds?: number;
  ramp_up_seconds?: number;
  total_sessions?: number;
  max_turns?: number;
  request_timeout_ms: number;
  seed?: number;
  // ---- 模拟模型 ----
  mock_model: MockModelConfig;
}
