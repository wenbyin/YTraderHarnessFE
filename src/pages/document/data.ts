// src/pages/document/data.ts
// 类型定义严格对齐 YTraderHarness 后端
// app/services/document/domain/schemas/runtime.py（document.yaml 最新版）。
//
// 与旧契约的差异（本次改版重点）：
//  - 版本只有 version_status（pending/active/superseded/failed/deleted），
//    processing_status 已明确不对外暴露，处理进度后续由 progress 接口提供。
//  - 版本摘要不再返回 file_name / content_type / file_size，
//    只给 file_id，前端按需用 GET /api/v1/files/{file_id} 补齐（带缓存）。
//  - Document 不再返回 document_type_code / current_version_number，
//    类型名通过 GET /api/v1/document-type-definitions 建 id → name 映射。
//  - 删除了 /document-chunks 与 reprocess 接口：
//    Chunk 数据在后端接口就绪前走前端示例数据（见 chunkSample.ts）。

// ============================================================
// 枚举
// ============================================================

/** Document 生命周期状态。对应后端 DocumentStatus 枚举。 */
export type DocumentStatus = 'active' | 'deleted';

/**
 * DocumentVersion 生命周期状态。对应后端 VersionStatus 枚举。
 *
 * pending    已创建，尚未成为可用版本
 * active     当前可用
 * superseded 已被更新的版本替代
 * failed     处理失败，不可用
 * deleted    逻辑删除
 */
export type VersionStatus =
  | 'pending'
  | 'active'
  | 'superseded'
  | 'failed'
  | 'deleted';

/** 单步处理状态。后端 progress 接口就绪前，节点状态见 pipeline.ts 的 NodeRunStatus。 */
export type StepState = 'completed' | 'processing' | 'pending' | 'failed';

/**
 * 处理流水线执行状态。对应后端 ProcessingStatus 枚举。
 *
 * 与 VersionStatus 是**两个维度**，别混：
 *  - VersionStatus     生命周期（pending/active/superseded/failed/deleted），建版本时即 ACTIVE；
 *  - ProcessingStatus  流水线跑得怎么样（pending/processing/completed/failed），
 *                      由 finalize_version 依据 retrieval 绑定聚合后回写。
 *
 * 注意：DocumentVersionSummary 目前**不返回**该字段，
 * 只有 GET /document-versions/{vid}/progress 会带（见 pipeline.ts）。
 */
export type ProcessingStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

// ============================================================
// Document
// ============================================================

/** Document 本体。对应后端 DocumentResponse。 */
export interface DocumentResponse {
  document_id: string;
  document_type_definition_id: string;
  tenant_id: string | null;
  document_key: string | null;
  title: string | null;
  current_document_version_id: string | null;
  status: DocumentStatus;
  metadata: Record<string, any>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Document 详情：本体 + 当前版本 + 全部版本。对应后端 DocumentDetailResponse。 */
export interface DocumentDetailResponse extends DocumentResponse {
  current_document_version: DocumentVersionSummary | null;
  versions: DocumentVersionSummary[];
}

/** 分页列表响应。对应后端 DocumentListResponse。 */
export interface DocumentListResponse {
  items: DocumentResponse[];
  page: number;
  page_size: number;
  total: number;
}

/** 列表查询参数。对应 GET /documents 的 query。 */
export interface ListDocumentsParams {
  tenant_id?: string;
  document_type_definition_id?: string;
  status?: DocumentStatus;
  /** 匹配 title 或 document_key。 */
  keyword?: string;
  page?: number;
  page_size?: number;
}

/** 创建请求体。对应后端 DocumentCreateRequest。 */
export interface CreateDocumentRequest {
  document_type_definition_id: string;
  /** 必须通过 File Service 上传完成。 */
  file_id: string;
  /** 为空时从 DocumentTypeDefinition 继承。 */
  tenant_id?: string | null;
  document_key?: string | null;
  title?: string | null;
  metadata?: Record<string, any>;
}

/**
 * 更新请求体。对应后端 DocumentUpdateRequest。
 *
 * 三种语义互斥 / 可组合，但至少提供一个字段：
 *  - file_id                     追加新版本
 *  - current_document_version_id 切换当前生效版本
 *  - title / metadata            只改 Document 本体
 *
 * file_id 与 current_document_version_id 不能同时提供（后端会返回 409）。
 */
export interface UpdateDocumentRequest {
  title?: string | null;
  metadata?: Record<string, any> | null;
  file_id?: string | null;
  current_document_version_id?: string | null;
}

// ============================================================
// DocumentVersion
// ============================================================

/** 版本摘要。对应后端 DocumentVersionSummary。 */
export interface DocumentVersionSummary {
  document_version_id: string;
  document_id: string;
  version_number: number;
  file_id: string;
  document_processor_definition_id: string | null;
  version_status: VersionStatus;
  /** 非数据库列：由 document.current_document_version_id 比较得到。 */
  is_current: boolean;
  created_at: string;
  /** 版本级 metadata，内含 pipeline_config（与顶层 pipeline_config 重复，取其一即可）。 */
  meta_data: Record<string, any>;
}

/** 版本详情。对应后端 DocumentVersionDetailResponse。 */
export interface DocumentVersionDetailResponse extends DocumentVersionSummary {
  /** 该版本实际执行时使用的 pipeline 配置快照。 */
  pipeline_config: PipelineConfigSnapshot;
  updated_at: string | null;
}

/** pipeline_config 中单个 retrieval 的快照。 */
export interface PipelineRetrievalSnapshot {
  document_retrieval_definition_id?: string;
  retrieval_type?: string;
  retrieval_config?: Record<string, any>;
  index_bindings?: Record<string, any>[];
  [key: string]: any;
}

/**
 * 对应后端 PipelineConfigSnapshot。
 *
 * ⚠️ 契约与实现目前不一致（实测 v44~v51）：
 *  - 实际只有 modality_type / analysis_mode / file_extension / loader / processor 五个 key；
 *  - `retrievals` **从不返回** —— 版本级 retrieval 要走 document_version.yaml 的接口
 *    （见 versionResult.ts）。这个字段留着只是为了兼容，别再依赖它；
 *  - `processor` 实际结构为 `{ name, config }`，契约里的 `mode` 目前取不到。
 */
export interface PipelineConfigSnapshot {
  modality_type?: string;
  analysis_mode?: string;
  file_extension?: string;
  loader?: { name?: string; config?: Record<string, any> } | null;
  processor?: {
    name?: string;
    /** 契约里有，实现目前给的是 name —— 两个都留，取到的那个为准。 */
    mode?: 'none' | 'common' | 'config';
    config?: Record<string, any> | null;
  } | null;
  /** 实测为空：retrieval tab 请改用 GET /document-versions/{vid}/retrievals。 */
  retrievals?: PipelineRetrievalSnapshot[];
  [key: string]: any;
}

/** 分页版本列表响应。对应后端 DocumentVersionListResponse。 */
export interface DocumentVersionListResponse {
  items: DocumentVersionSummary[];
  page: number;
  page_size: number;
  total: number;
}

/** 版本列表查询参数。对应 GET /documents/{id}/versions 的 query。 */
export interface ListVersionsParams {
  status?: VersionStatus;
  page?: number;
  page_size?: number;
}

// ============================================================
// Chunk 展示（降级兜底用的示例数据，见 chunkSample.ts）
// ============================================================

/** Chunk 展示项。 */
export interface ChunkItem {
  chunk_index: number;
  content: string;
  token_count: number | null;
  char_count: number | null;
  metadata: Record<string, any>;
}

export interface ChunkListResult {
  items: ChunkItem[];
  total: number;
}

// ============================================================
// 处理结果：版本 × retrieval × chunk
// 对齐 YTraderHarness
// app/services/document/document_version.yaml（Document Version API）
//
// 与旧的 pipeline_config.retrievals 的区别：
//  - tab 来自**版本级绑定记录**，只返回这个版本真正跑过的 retrieval；
//  - chunker 是**运行时冻结值**（当时用的那个），不是当前定义里的现值；
//  - 失败的 retrieval 也会出现在列表里（processing_status=failed）。
// ============================================================

/** 该路运行时实际使用的 chunker。缺失时为 null（契约要求显示「未知」，不要回退读当前定义）。 */
export interface ChunkerBinding {
  /** 能力键，如 TEXT_TXT_RECURSIVE_CHUNKER。 */
  processor_key: string;
  /** 该次运行传给 chunker 的配置原文，字段随 processor_key 而变。 */
  config?: Record<string, any>;
}

/** 某个版本下的一路 retrieval —— 也就是抽屉里的一个 tab。 */
export interface DocumentVersionRetrievalSummary {
  document_version_retrieval_binding_id: string;
  /** tab 标识。用它去取该 tab 的 chunk。 */
  document_retrieval_definition_id: string;
  retrieval_type: string;
  storage_backend: string | null;
  chunker: ChunkerBinding | null;
  /** 该路写入了多少块；0 表示这一路没有产出 chunk。 */
  chunk_count: number;
  processing_status: ProcessingStatus;
  error_message: string | null;
}

export interface DocumentVersionRetrievalListResponse {
  items: DocumentVersionRetrievalSummary[];
  /** tab 数量，不分页。 */
  total: number;
}

/** 一条 chunk。 */
export interface DocumentChunkSummary {
  document_chunk_id: string;
  /** 本 retrieval 内从 0 连续，排序依据。 */
  chunk_index: number;
  content: string;
  /** 该条被 preview_chars 截断过。 */
  content_truncated: boolean;
  /** 截断**前**的字符数，可能大于 content 的长度。 */
  char_count: number;
  token_count: number | null;
  start_index: number | null;
  end_index: number | null;
  content_hash: string | null;
  locator: Record<string, any> | null;
  metadata: Record<string, any>;
  created_at: string | null;
}

export interface DocumentChunkListResponse {
  items: DocumentChunkSummary[];
  page: number;
  page_size: number;
  /** 该 (version, retrieval) 下的 chunk 总数。 */
  total: number;
}

// ============================================================
// Chunk 投影（当时写给索引的东西）
// 对齐 document_version.yaml 的 POST /document-chunk-projections
//
// 与上面的 Chunk 列表是两个东西：
//   Chunk         原件：这一条是什么（从 PostgreSQL 读）
//   Projection    投影：它被变成了什么写进索引（从 embedding 产物读）
//
// 投影**不落库**，只有阶段 9 写出的产物留下痕迹，所以要现算现发，
// 代价是它反映"当时发出去的"，不是"索引里现在存着的"。
// ============================================================

/** 向量化能力产出的形态。三种在数学上不可互换，索引侧字段类型也不同。 */
export type EmbeddingOutput = 'dense' | 'sparse' | 'graph';

/** 稠密向量摘要：够判断"这条投影正不正常"的那几个数。 */
export interface VectorSummary {
  dimensions: number;
  nonzero_count: number;
  l2_norm: number;
  /** 前 8 个分量，用来看数值量级。 */
  head: number[];
}

/** 稀疏向量摘要。 */
export interface SparseSummary {
  nonzero_count: number;
  /** 权重最大的前 8 项，每项 {dim, weight}；dim 是 token id。 */
  top: Record<string, any>[];
}

/**
 * 一条 chunk 在**某一路 retrieval** 下的投影。
 *
 * 为什么要按 retrieval 分开：chunk 是**版本级的事实**，不归任何一路
 * retrieval —— 同一个 chunk 会被多路 retrieval 各自写进不同的索引，
 * 形态还不同（稠密 / 稀疏 / 透传）。所以「这条 chunk 的投影」本来
 * 就不是一条记录，而是一组。
 *
 * keyword / document 两路是**透传**的（不需要向量化），没有独立产物，
 * 此时 kind / fields 为 null，原因看 unavailable_reason。
 */
export interface ChunkProjectionEntry {
  document_retrieval_definition_id: string;
  /** 回显在这里，前端不必为了显示路名再去查一次定义。 */
  retrieval_type: string;
  /** 投影形态。透传那两路、以及取不到时为 null。 */
  kind: EmbeddingOutput | null;
  /** 产出它的 embedder 能力键，例如 TEXT_BGE_SMALL_ZH_EMBEDDER。 */
  embedder: string | null;
  /**
   * 产物里声明的维度。与 vector_summary.dimensions 不是一回事 ——
   * 那个是这条向量实际的长度，两者不一致本身就是问题。
   */
  dimensions: number | null;
  /** 投影里非向量的那些字段（content / content_hash / 计数 / metadata 等）。 */
  fields: Record<string, any> | null;
  vector_summary: VectorSummary | null;
  sparse_summary: SparseSummary | null;
  /** 完整稠密向量，只有 include_vector=true 时返回。 */
  vector: number[] | null;
  /** 完整稀疏向量（维度 -> 权重），只有 include_vector=true 时返回。 */
  sparse: Record<string, number> | null;
  /** 这一路取不到时的原因。有值时其余字段都是 null —— 要显示它。 */
  unavailable_reason: string | null;
}

/**
 * 一条 chunk 当时**写给索引的东西**（投影）。
 *
 * 与 DocumentChunkSummary 的区别：
 *   DocumentChunkSummary  原件：这一条是什么（从 PG 读）
 *   ChunkProjection       投影：它被变成什么样子写进索引（从产物读）
 *
 * 外层仍是「一条 chunk 一项」，与请求一一对应且同序；里面是一组
 * projections —— 每一路用到这条 chunk 的 retrieval 各占一项。
 */
export interface ChunkProjection {
  document_chunk_id: string;
  document_version_id: string | null;
  /** 产出这条 chunk 的 chunker 能力键；「哪几路用到它」正是由它推导出来的。 */
  chunker_key: string | null;
  /**
   * 这条 chunk 在各路 retrieval 下的投影。空列表表示没有任何一路用到它。
   * 某一路取不到时列表里**仍有它**，看该项的 unavailable_reason。
   */
  projections: ChunkProjectionEntry[];
  /** chunk 本身就取不到时的原因。有值时 projections 必为空。 */
  unavailable_reason: string | null;
}

export interface ChunkProjectionListResponse {
  /** 与请求的 chunk_ids 一一对应且同序，包括取不到的那些。 */
  items: ChunkProjection[];
  total: number;
  /** 回显本次是否返回了完整向量。 */
  include_vector: boolean;
}

// ============================================================
// QA 数据集生成
// 对齐 document_version.yaml 的 POST /qa-datasets:generate
//
// 它是**手动触发**的，不在任何管线步骤里：
//   取该版本 clean 正文 + 全部 chunk 区间 -> 按 2~4 级标题切窗口 -> 每个窗口
//   问一次云端 LLM（要「问题 + 答案 + 逐字摘录」）-> 摘录回正文精确匹配定位
//   -> 与 chunk 区间求交得到目标 chunk id。
//
// 两个必须让用户在 UI 上看见的事实：
//   1. **同步接口**：请求时长 ≈ 窗口数 × 单次云端 LLM 调用，所以 max_windows
//      默认只有 10 而不是全量（全量上千窗口会挂几小时）。
//   2. **产物不在响应里**：JSON 落到服务器磁盘，响应只给路径与统计。
// ============================================================

/** 生成参数。对齐 QADatasetGenerateRequest。 */
export interface QADatasetGenerateRequest {
  document_version_id: string;
  /**
   * 本次最多处理多少个窗口（按 2~4 级标题切出来的小节）。
   * 默认 10 —— 同步接口扛不住全量，先小批量试出效果再分批放大。
   */
  max_windows?: number;
  /**
   * 抽样种子。窗口是从全部小节里**随机抽** max_windows 个的，不是取前 N 个 ——
   * 取前 N 个会永远只看得到文档开头。固定种子 = 同样参数抽出同一批窗口，
   * 便于比较两次改动的差异。
   */
  sample_seed?: number;
  /** 单个窗口最多出几道题。 */
  max_questions_per_window?: number;
  /** 并发调用云端 LLM 的条数。别盲目调大 —— 打满 QPS 会触发限流，重试反而更慢。 */
  concurrency?: number;
  /** 用哪个 LLM 提供方（见 app/common/llm.yaml）。null = 用那里的 default_provider。 */
  provider?: string | null;
  /**
   * 采样温度。默认 0 —— 出题要可复现，调高后同一窗口每次会跑出不同的题，
   * 两次数据集就没法比了。
   */
  temperature?: number;
}

/** 单个失败窗口的明细。对齐 QADatasetFailure。 */
export interface QADatasetFailure {
  /** 该窗口的小节标题。 */
  section: string;
  /** 该窗口在正文中的字符区间 [start, end]。 */
  span: [number, number];
  reason: string;
}

/** 生成结果。对齐 QADatasetGenerateResponse。 */
export interface QADatasetGenerateResponse {
  /** 落盘路径。**产物在磁盘上，不在这里** —— 响应只有路径与统计。 */
  dataset_path: string;
  /** 最终保留下来的样本数。 */
  case_count: number;
  /** 本次处理的窗口总数。 */
  windows_total: number;
  /** LLM 调用成功的窗口数。 */
  windows_ok: number;
  /** LLM 调用失败（超时、限流、格式不对）的窗口数。 */
  windows_failed: number;
  /** LLM 一共出了多少道题。 */
  questions_generated: number;
  /** 保留下来的。 */
  questions_kept: number;
  /**
   * 丢弃的。**偏高不一定是坏事** —— 最常见的原因是模型没有逐字引用原文
   * （它改写了），那种题的目标位置无法确定，留着只会污染数据集。
   */
  questions_dropped: number;
  /** 丢弃原因分类计数，用来判断问题出在哪一环。 */
  drop_reasons?: Record<string, number>;
  /** 失败的窗口明细（后端最多保留前若干个）。 */
  failures?: QADatasetFailure[];
  /** 整批耗时（秒）。 */
  elapsed_seconds: number;
}
