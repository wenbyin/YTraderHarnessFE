// src/pages/retrieval_eval/data.d.ts
// 类型严格对齐 retrieval_eval_openapi.yaml (OpenAPI 3.1) 的 components.schemas。
// 命名保持与后端 JSON 字段一致（snake_case），便于直接替换 mock 为真实请求。

// ============================================================
// 枚举（对应 OpenAPI enum）
// ============================================================

/** 对应 BundleStatus */
export type BundleStatus =
  | 'draft'
  | 'generating'
  | 'ready'
  | 'partial_failed'
  | 'failed'
  | 'archived';

/** 对应 JobStatus */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial_failed'
  | 'failed'
  | 'cancelled';

/** 对应 validation_status */
export type ValidationStatus = 'pending' | 'validated' | 'rejected';

/** 对应 sampling_strategy */
export type SamplingStrategy = 'balanced_by_dtd' | 'uniform_all';

/** 对应 drop_reason（schema.sql 中 CHECK 约束的 11 值 + null） */
export type DropReason =
  | 'not_recalled'
  | 'top_k_cutoff'
  | 'score_threshold'
  | 'metadata_filter'
  | 'rerank_cutoff'
  | 'final_top_k_cutoff'
  | 'deduplicated'
  | 'permission_filter'
  | 'processor_error'
  | 'unknown'
  | 'not_applicable';

/** 分数方向：跨阶段不可比，必须按此字段解读 */
export type ScoreDirection =
  | 'higher_is_better'
  | 'lower_is_better'
  | 'not_comparable';

/**
 * 对应 RetrievalType —— 一路召回 / 存储的业务表示。
 *
 * 注意 `document` / `keyword` 不需要向量，其余三路各查一种索引。
 * 召回参数按这个键分路给（见 `RetrievalRecallConfig`）。
 */
export type RetrievalType =
  | 'document'
  | 'keyword'
  | 'sparse_vector'
  | 'dense_vector'
  | 'graph';

// ============================================================
// 生成侧（Bundles / Generation）
// ============================================================

/** CreateEvalBundleRequest */
export interface CreateEvalBundleRequest {
  name: string;
  description?: string | null;
  document_type_definition_ids: string[];
  /** 跨所选 DTD 的总抽样数（非每个 DTD） */
  sampled_chunk_count: number;
  questions_per_chunk?: number;
  /** 单次 LLM 请求最多塞入的源 chunk 数 */
  chunks_per_window?: number;
  max_input_tokens?: number;
  /**
   * 是否启用**跨块金标裁决**（每题多调一次模型，判定「同一份文档里别的块
   * 是否也答得上这道题」）。契约与后端 default = false。
   *
   * 关着时金标集合只有出题那一块（`gold_chunk_ids == {source_chunk_id}`），
   * 于是"检索返回了另一块同样答得上的内容"会被判成 miss —— 那是**假 miss**，
   * 让召回率偏低，而偏低的部分从结果里看不出来。
   *
   * 该值会写进数据集的 `generation_config` 快照：它**改变数据集内容**，
   * 所以必须能事后分辨某份数据集是从哪种模式产出的。
   */
  enable_cross_chunk_judge?: boolean;
  sampling_strategy?: SamplingStrategy;
  seed?: number;
}

/** CreateEvalBundleAcceptedResponse */
export interface CreateEvalBundleAcceptedResponse {
  bundle_id: string;
  generation_run_id: string;
  status: BundleStatus;
  message?: string;
}

/** EvalBundleSummary */
export interface EvalBundleSummary {
  bundle_id: string;
  name: string;
  description?: string | null;
  status: BundleStatus;
  document_type_definition_ids: string[];
  source_chunk_count: number;
  case_count: number;
  /** 后端可能没有造题运行（刚建出来还没排上），此时为 null */
  latest_generation_status?: JobStatus | null;
  dataset_sha256?: string | null;
  created_at: string;
  completed_at?: string | null;
}

/** EvalBundleListResponse */
export interface EvalBundleListResponse {
  items: EvalBundleSummary[];
  page: number;
  page_size: number;
  total: number;
}

/** EvalBundleDetail */
export interface EvalBundleDetail extends EvalBundleSummary {
  schema_version: string;
  selection_config: Record<string, unknown>;
  generation_config: Record<string, unknown>;
  latest_generation_run_id?: string | null;
  updated_at: string;
}

/** EvalCase */
export interface EvalCase {
  eval_case_id: string;
  document_type_definition_id: string;
  document_version_id?: string | null;
  document_retrieval_definition_id?: string | null;

  // ---- 源文档身份 ----
  // 出题时把主体（公司名/证券代码）从**文档**取来写进问题，因为正文里常写「本公司」。
  // 反过来，问题一旦写了公司名，答案正确性就依赖「这块 chunk 属于那家公司」——
  // 所以这三列是这类题**能否复核**的前提，必须能看到。
  /** 源 chunk 所属 Document */
  document_id?: string | null;
  /** 源文档标题，即主体名称（本语料里 = 公司名，如「特锐德」） */
  document_title?: string | null;
  /** 源文档业务标识（本语料里 = 证券代码，如「300001.SZ」） */
  document_key?: string | null;

  /** 出题所依据的源 chunk（不可变的金标） */
  chunk_id: string;
  /** 所有经独立验证可回答此题的 chunk（含 chunk_id）；只覆盖本次抽样池，是下界 */
  gold_chunk_ids: string[];
  question: string;
  /** 源 chunk 中的精确原文子串，非摘要 */
  answer_original: string;
  /** 原文片段在源 chunk 内的字符区间，用于把「没召回到」与「措辞对不上」分开 */
  answer_start_offset?: number | null;
  answer_end_offset?: number | null;
  question_order: number;
  validation_status: ValidationStatus;
  validation_error?: string | null;
}

/** EvalCaseListResponse */
export interface EvalCaseListResponse {
  items: EvalCase[];
  page: number;
  page_size: number;
  total: number;
}

/** GenerationWindowSummary */
export interface GenerationWindowSummary {
  generation_window_id?: string;
  window_index: number;
  status: JobStatus;
  input_chunk_count: number;
  input_token_estimate?: number | null;
  attempt_count: number;
  valid_case_count: number;
  error_code?: string | null;
  error_message?: string | null;
}

/** GenerationRunDetail */
export interface GenerationRunDetail {
  generation_run_id: string;
  bundle_id: string;
  status: JobStatus;
  model_role: string;
  model_name?: string | null;
  sample_seed: number;
  total_chunks: number;
  total_windows: number;
  completed_windows: number;
  failed_windows: number;
  generated_cases: number;
  error_message?: string | null;
  windows: GenerationWindowSummary[];
  started_at?: string | null;
  completed_at?: string | null;
}

/** GenerationRetryAcceptedResponse —— POST retry-failed-windows 的 202 响应 */
export interface GenerationRetryAcceptedResponse {
  generation_run_id: string;
  status: JobStatus;
  retried_window_count: number;
}

/** EvalBundleExport */
export interface EvalBundleExport {
  schema_version: string;
  bundle_id: string;
  bundle_name: string;
  dataset_sha256?: string | null;
  generation_config: Record<string, unknown>;
  document_type_definition_ids: string[];
  items: {
    chunk_id: string;
    gold_chunk_ids: string[];
    document_type_definition_id: string;
    document_version_id?: string | null;
    // 源文档身份随导出物一起走：正文多写「本公司」，问题里的主体只能来自文档，
    // 缺了它外部工具（ragas 等）无法复核这条 ground truth 该不该命中。
    document_id?: string | null;
    /** 源文档标题（本语料里 = 公司名） */
    document_title?: string | null;
    /** 源文档业务标识（本语料里 = 证券代码） */
    document_key?: string | null;
    question: string;
    answer_original: string;
  }[];
}

// ============================================================
// 跑测侧（Runs / Stage trace）
// ============================================================

export interface FusionerConfig {
  enabled?: boolean;
  type?: 'rrf' | 'weighted_sum';
  top_k?: number;
  rrf_k?: number;
  weights?: Record<string, number>;
}

export interface FilterConfig {
  enabled?: boolean;
  score_threshold?: number;
  document_ids?: string[];
  document_version_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface RerankerConfig {
  enabled?: boolean;
  type?: 'cross_encoder' | 'llm' | 'custom';
  model?: string;
  top_n?: number;
}

export interface CutterConfig {
  top_k?: number;
  max_content_chars?: number;
}

/** QueryProcessorOverride —— 只允许覆盖公开契约内的阶段，recaller 为内部实现 */
export interface QueryProcessorOverride {
  fusioner?: FusionerConfig;
  filter?: FilterConfig;
  reranker?: RerankerConfig;
  cutter?: CutterConfig;
}

/**
 * 查询改写策略（`QueryRewriterKind`）。
 *
 * - `common` 非模型改写：只做「日期两种写法都展开」，不调模型所以**免费**；
 * - `llm` 大模型改写：调一次模型（日期展开 + 去公司名这个错锚 + 加别名），
 *   失败/超时**退回原文**并标 `degraded`，不会让检索失败。
 */
export type QueryRewriterKind = 'common' | 'llm';

/**
 * QueryRewriterConfig —— 召回**之前**的查询改写。
 *
 * ⚠️ 这一层的语义与 `QueryProcessorOverride` 那四段**不同**，别照抄它们的写法
 * ----------------------------------------------------------------------
 *   1. 它发生在**召回之前**：改写后的文本同时喂给两路召回（dense 的向量化、
 *      keyword 的 BM25）以及之后那四段。所以它管的是「查什么」，而那四段管
 *      「拿到池子之后怎么排」；
 *   2. **没有「继承 DTD」的回落**。四段里「不传」= 用该 DTD 的生效配置；而
 *      这里「不传 / `kind` 为 null」= **不改写**。改写会改变 query 本身，
 *      不该由文档类型悄悄决定。所以它只能是调用方逐次指定。
 *
 * ⚠️ 因此它与 `retrieve_processor` 是**并列**字段，不是塞在它里面的第五段。
 */
export interface QueryRewriterConfig {
  /** 关闭后跳过改写。默认 true（保留字段是为了让调用方能**显式**停用）。 */
  enabled?: boolean;
  /**
   * 改写策略。**None = 不改写**。
   *
   * ⚠️ 别把 `kind: null` 与 `enabled: false` 当同一件事读：前者是「这一轮
   * 没要求改写」，后者是「这一轮明确要求不改写」。评测阶梯里统一用**不传**
   * （与后端内置阶梯的第 3 轮一致），不发 `enabled: false` 这种噪声。
   */
  kind?: QueryRewriterKind | null;
  /** 改写模型标识，**只对 `llm` 有意义**。null = 用 model_role 绑定里的模型。 */
  model?: string | null;
  /** 改写这一步的墙钟上限（毫秒）。1–60000。null = 用实现默认值。 */
  timeout_ms?: number | null;
}

/**
 * RetrievalRecallConfig —— **单路召回**的参数（发生在融合之前）。
 *
 * 与 `QueryProcessorOverride` 的分工：那四段决定「在已经召回的池子里怎么排」，
 * 本类型决定的恰恰是「池子本身有多大、有多干净」。recaller 在公开检索契约里
 * 是内部实现细节，所以它没被塞进那个 override，而是在轮次规格里单列。
 *
 * 未出现的字段 = 用默认；未出现的**路** = 用该路的默认。
 */
export interface RetrievalRecallConfig {
  /** 这一路召回多少条（候选池大小，不是最终返回条数）。1–500，默认 200。 */
  top_k?: number | null;
  /** 该路**原始分**下限（不做归一化，量纲随 retrieval_type 而变）。 */
  min_score?: number | null;
  /** 该路索引后端的检索参数，原样透传（当前只有 dense_vector/Milvus 消费）。 */
  search_params?: Record<string, unknown>;
}

/**
 * EvalAttemptSpec —— **一轮**扩展的参数。
 *
 * ⚠️ 三轮是**逐轮放宽**，不是三个独立实验
 * ---------------------------------------
 * 第 N 轮只跑第 N-1 轮**没命中**的 case，所以每轮样本量不同、分母也不同。
 * 报「第 2 轮命中率」时必须带上分母（`EvalAttemptMetrics.cases`），否则
 * 会被读成「全体的命中率」而错一个量级。
 *
 * 不传 `attempts` 时后端用内置三档阶梯（`DEFAULT_ATTEMPT_LADDER`，
 * 见 `attemptLadder.ts`）。
 */
export interface EvalAttemptSpec {
  /** 给这一轮起个名（报表里显示用）。null / 省略 = 用序号。≤64 字符。 */
  name?: string | null;
  /** **每一路**召回多少条。null / 省略 = 用该路默认（200）。1–500。 */
  recall_top_k?: number | null;
  /**
   * 逐路细化覆盖（键是 retrieval_type）。给了就盖过 `recall_top_k` ——
   * 后者是「所有路都设成这个数」的简写。
   */
  retrieval_config?: Partial<
    Record<RetrievalType, RetrievalRecallConfig>
  > | null;
  /**
   * 这一轮的四段覆盖（融合 / 过滤 / 精排 / 裁剪）。
   *
   * **第 3 轮加精排就是在这里给 `reranker`** —— 精排贵（实测 top_n=50 要
   * 45 秒，top_n=10 约 9 秒），所以只让前两轮都没找到的那批去付。
   * 未出现的段 = 继承该 DTD 的生效配置（不是「关闭」）。
   */
  retrieve_processor?: QueryProcessorOverride | null;
  /**
   * 这一轮的**查询改写**。**不传 = 这一轮不改写**。
   *
   * 与另外两个字段的分工：`recall_top_k` / `retrieval_config` 管**召回多少**，
   * `retrieve_processor` 管**召回之后怎么处理**，而它管**查什么**。
   *
   * ⚠️ 逐轮给不同的改写器时，轮的**增量**就不再只是那一个变量的贡献了
   * （例如第 2 轮换 llm 改写、第 3 轮又换回来）。要读「纯精排收益」就给
   * 相邻两轮配同一个改写器 —— 内置阶梯恰恰**不是**这样（第 2 轮 llm、
   * 第 3 轮不改），所以 `round3 - round2` 里混着「少了一次改写」的损失。
   */
  query_rewriter?: QueryRewriterConfig | null;
}

/** CreateEvalRunRequest */
export interface CreateEvalRunRequest {
  bundle_id: string;
  max_k?: number;
  include_stage_trace?: boolean;
  top_candidates_per_stage?: number;
  /**
   * 本次评测对四段处理器的临时覆盖（融合 / 过滤 / 精排 / 裁剪）。
   *
   * ⚠️ **传了 `attempts` 时这个字段被忽略** —— 两者都表达「本轮用什么
   * 参数」，同时给会有一个静默不生效。而内置阶梯的每一轮都自带
   * `retrieve_processor`，所以「不传 attempts」时它同样不生效。
   * 本页因此只发 `attempts`（见 runs/index.tsx 的说明）。
   */
  query_processor_override?: QueryProcessorOverride;
  /**
   * **逐轮的扩展参数**，最多 3 轮。
   *
   * 语义：第 N 轮只跑第 N-1 轮没命中的 case。整个阶梯会进
   * `effective_config_snapshot` —— 它**改变结果的含义**（「这几个数是几轮
   * 跑出来的」），所以必须事后可查。
   */
  attempts?: EvalAttemptSpec[] | null;
}

/** CreateEvalRunAcceptedResponse */
export interface CreateEvalRunAcceptedResponse {
  eval_run_id: string;
  bundle_id: string;
  status: JobStatus;
  message?: string;
}

/** EvalMetrics —— 确定性 ID 命中指标，无 LLM judge */
export interface EvalMetrics {
  total_cases: number;
  completed_cases: number;
  failed_cases: number;
  hit_count: number;
  miss_count: number;
  hit_rate_at_1?: number | null;
  hit_rate_at_5?: number | null;
  hit_rate_at_k?: number | null;
  mrr_at_k?: number | null;
  /**
   * 召回率曲线，形如 `{ "1": 0.05, "10": 0.375, "50": 0.7 }`。
   *
   * 存在的理由就是 `max_k`：线上到底喂几条给模型是个**部署事实**，它一变，
   * 单个 hit@k 的数就要重跑一轮才知道。有了曲线，「口径对齐」从重跑变成
   * 读另一个点。
   *
   * ⚠️ k 超过 `retrieved_max` 的点没有意义（分子不可能再涨）—— 读到接近
   * 0 时先确认检索到底返回了几条。
   */
  hit_rate_curve?: Record<string, number | null>;
  /**
   * 本轮单条最多返回了几条。**读曲线时必须对照它** ——
   * `hit_rate_curve` 里超过这个数的 k，其 0 值只说明「没取回来」，
   * 不说明「召回差」。
   */
  retrieved_max?: number | null;
  /**
   * 逐轮指标，键是轮次号（`"1"`/`"2"`/`"3"`）。
   *
   * ⚠️ **每轮分母不同** —— 第 N 轮只跑第 N-1 轮未命中的那些。所以每一项都
   * 带 `cases`（这一轮跑了几条）与 `input_share`（占全部 case 的比例）。
   *
   * 顶层 `EvalMetrics` 的其余字段回答的是**最终**口径（每条 case 取最好
   * 的那一轮，见后端 `collapse_by_case`）；这里回答「哪一轮救回来的」。
   * 两个问题，两个口径。
   */
  by_attempt?: Record<string, EvalAttemptMetrics>;
  p50_latency_ms?: number | null;
  p95_latency_ms?: number | null;
  max_k: number;
}

/**
 * 单轮指标 = 一份完整的 `compute_metrics` 结果 + 这一轮的**分母**。
 *
 * 刻意用 `Omit` 排除 `by_attempt`：轮内不再有「逐轮」这一层，
 * 后端也只在那里塞了 `cases` / `input_share`。
 */
export interface EvalAttemptMetrics extends Omit<EvalMetrics, 'by_attempt'> {
  /** 这一轮实际跑了几条 —— 读比率时必须连它一起看。 */
  cases: number;
  /** 这一轮占全部 case 的比例（0–1）。 */
  input_share: number;
}

/** EvalRunDetail */
export interface EvalRunDetail {
  eval_run_id: string;
  bundle_id: string;
  status: JobStatus;
  max_k: number;
  include_stage_trace: boolean;
  query_processor_override: Record<string, unknown>;
  effective_config_snapshot: Record<string, unknown>;
  total_cases: number;
  completed_cases: number;
  failed_cases: number;
  metrics: EvalMetrics;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/** StageStatsResponse 的单条 stage/source 聚合 */
export interface StageStatItem {
  stage_key: string;
  source_key: string;
  observed_cases: number;
  executed_cases?: number;
  average_input_count?: number | null;
  average_output_count?: number | null;
  gold_present_before_count: number;
  gold_present_after_count: number;
  gold_drop_count: number;
  gold_pass_rate?: number | null;
  drop_reason_counts: Record<string, number>;
}

/** StageStatsResponse */
export interface StageStatsResponse {
  eval_run_id: string;
  stages: StageStatItem[];
}

/** ScoredChunkCandidate */
export interface ScoredChunkCandidate {
  chunk_id: string;
  rank: number;
  score?: number | null;
  score_name?: string | null;
  score_direction?: ScoreDirection | null;
  source_key?: string | null;
  selected?: boolean;
  drop_reason?: string | null;
  metadata?: Record<string, unknown>;
}

/** EvalCaseTraceResponse 中的单个 stage 记录 */
export interface CaseTraceStage {
  stage_key: string;
  source_key: string;
  input_count?: number | null;
  output_count?: number | null;
  gold_present_before?: boolean | null;
  gold_present_after?: boolean | null;
  gold_ranks_before?: Record<string, number | null>;
  gold_scores_before?: Record<string, number | null>;
  gold_ranks_after?: Record<string, number | null>;
  gold_scores_after?: Record<string, number | null>;
  drop_reason?: string | null;
  top_candidates: ScoredChunkCandidate[];
}

/** EvalCaseTraceResponse */
export interface EvalCaseTraceResponse {
  eval_run_id: string;
  eval_case_id: string;
  /**
   * **这份痕迹是哪一轮的**。请求不带 `attempt_no` 时给的是**代表行**那一轮
   * （命中优先、再比名次）—— 与列表、表头指标同一条。
   *
   * ⚠️ 必须显示出来：第 1 轮与第 3 轮的参数不同（第 3 轮才开精排，召回与
   * 裁剪都更宽），不标就会被读成「这条 case 的检索过程」。
   */
  attempt_no: number;
  /**
   * 这条 case 在这轮评测里**实际跑过的轮次**，升序。
   * 逐轮放宽 = 「第 N 轮只跑第 N-1 轮没命中的」→ 第 1 轮就命中的只有
   * `[1]`，三轮都没命中的是 `[1, 2, 3]`。
   */
  available_attempts: number[];
  /**
   * 这一轮**实际发给检索**的文本（改写之后）。
   *
   * 与 case 的 `question` 可能不同：逐轮阶梯里每轮的改写器不同（第 1 轮日期
   * 归一化、第 2 轮大模型改写、第 3 轮不改），而**大模型改写不可复现** ——
   * 想复核「这段痕迹是哪句话跑出来的」只能看它。
   */
  query_text?: string | null;
  gold_chunk_ids: string[];
  stages: CaseTraceStage[];
}

// ============================================================
// 单条 chunk 的正文（GET /document-chunks/{document_chunk_id}）
// ============================================================

/**
 * 一块 chunk 的**正文**。
 *
 * 为什么评测页也要这个端点
 * ------------------------
 * trace 响应只给 `gold_chunk_ids`（一串 UUID）。看不到正文就答不出
 * 「它为什么没被召回」—— 是语义不匹配，还是正文里根本没有这个说法。
 * 列表接口那套 (版本, retrieval) 在评测侧**不存在**（`EvalRunCase` 里
 * 没有这两个 id），所以只能按 chunk id 回查。
 *
 * 只声明界面真正用到的字段
 * ------------------------
 * 与 `DtdListSourceItem` 同一个理由：完整契约在
 * `document_type_definition.yaml` 的 `/document-chunks/{id}`，抄一遍只会
 * 多一份会漂移的副本。这里用到的是「正文 + 它有多大 + 是不是被截过 +
 * 在正文里的位置」。
 */
export interface DocumentChunkText {
  document_chunk_id: string;
  /** 该 retrieval 内从 0 连续 —— 界面上显示成 `#N` */
  chunk_index: number;
  /** 正文。传了 `preview_chars` 时是截断后的 */
  content: string;
  /**
   * `content` 被 `preview_chars` 截断过。
   *
   * 前端据此**不给**「展开全文」—— 手里没有全文，展开也没得展，
   * 只能如实标注「后端只给了前 N 个字符」。
   */
  content_truncated: boolean;
  /** **截断前**的字符数 —— 用它说「共 N 字符」，不是 `content.length` */
  char_count: number;
  token_count?: number | null;
  /** 在归一化后正文中的偏移；满足 `content == 正文[start:end]`（未截断时） */
  start_index?: number | null;
  end_index?: number | null;
  locator?: Record<string, unknown> | null;
}

/** EvalRunCase */
export interface EvalRunCase {
  eval_case_id: string;
  question: string;
  chunk_id: string;
  document_type_definition_id: string;
  status: 'completed' | 'failed' | 'skipped';
  /**
   * 这一行来自**哪一轮**（逐轮放宽：一轮一行；列表给的是折叠后的代表行）。
   *
   * 命中优先 → 命中时它是「救回它的那一轮」；三轮都没命中则是最后跑的那轮。
   * 它同时是拿去查逐段痕迹的 handle（见 `getRetrievalEvalCaseTrace`）。
   */
  attempt_no: number;
  /**
   * 代表行那一轮**实际发给检索**的文本（改写之后）。
   *
   * 未改写或旧后端没回带时是 `null` / 省略 —— 此时等价于 `question`。
   * 渲染上「与 question 相同」要显示成「原文」而不是「已改写」：改写器
   * 可以把 query 原样返回（`changed=false`），那是**改了没改动**，不是
   * 「没开改写」，两件事都不该被读成第三种。
   */
  query_text?: string | null;
  gold_hit?: boolean | null;
  /**
   * 金标在返回集合里的名次。**没命中（或该行没跑到）时是 `null`** ——
   * 渲染时必须退化成纯文本，别塞进 Tag（`#{null}` 会显示成 `#`/`#-`）。
   */
  gold_rank?: number | null;
  gold_chunk_ids: string[];
  retrieved_chunk_ids: string[];
  top_candidates?: ScoredChunkCandidate[];
  latency_ms?: number | null;
  error_code?: string | null;
  error_message?: string | null;
}

/** EvalRunCaseListResponse */
export interface EvalRunCaseListResponse {
  items: EvalRunCase[];
  page: number;
  page_size: number;
  total: number;
}

/** ErrorResponse */
export interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string;
}

// ============================================================
// 查询参数
// ============================================================

export interface ListBundlesParams {
  status?: BundleStatus;
  /** 只看覆盖了这个 DTD 的 bundle（后端支持的唯一筛选维度） */
  document_type_definition_id?: string;
  page?: number;
  page_size?: number;
}

export interface ListBundleCasesParams {
  page?: number;
  page_size?: number;
  document_type_definition_id?: string;
  validation_status?: ValidationStatus;
}

export interface ListRunCasesParams {
  page?: number;
  page_size?: number;
  hit?: boolean;
  document_type_definition_id?: string;
}

// ============================================================
// 前端展示辅助（非后端契约）：DTD 下拉选项
// ============================================================

export interface DtdOption {
  document_type_definition_id: string;
  type_key: string;
  name: string;
  modality_type: string;
  /**
   * ⚠️ **只有 mock 有**：真实 `/api/v1/document-type-definitions` 的列表项里
   * 没有 chunk 数（那要另外聚合）。真实模式下为 undefined，UI 据此不显示计数。
   */
  chunk_count?: number;
}

/**
 * 真实 `/api/v1/document-type-definitions` 列表项里我们**真正读到**的字段。
 *
 * 刻意不把 DTD 契约整个抄一遍：其余字段（revision / processors / …）与评测无关，
 * 抄过来只会多一份会漂移的副本。这里只声明被 `listDtdOptions()` 映射的那几个。
 */
export interface DtdListSourceItem {
  document_type_definition_id: string;
  type_key: string;
  name: string;
  modality_type: string;
}
