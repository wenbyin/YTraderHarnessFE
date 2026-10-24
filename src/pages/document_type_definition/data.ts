// src/pages/document_type_definition/data.ts
// 类型定义严格对齐 YTraderHarness 后端 OpenAPI（document.yaml）最新版。
import { retrievalTypeText } from '@/utils/retrievalType';
//
// 领域模型（document.yaml 最新）：
//  - 一个 DocumentTypeDefinition 只有一种 modality_type（创建后不可修改）。
//  - analysis_mode 决定解析方式：
//      default = 系统预制后缀名 Reader（.*），不建 ProcessorDefinition，该类型下全部 retrieval 自动参与；
//      config  = 使用自定义 ProcessorDefinition（每个 file_extension 一条），缺匹配后缀名不允许上传；
//      none    = 不解析文件。
//  - 两阶段 + N:N 绑定：
//      阶段1 [loader → processor] = ProcessorDefinition，按 file_extension 自然键唯一；
//      阶段2 [chunker → retriever] = RetrievalDefinition，按 retrieval_type 自然键唯一；
//      bindings = N:N 关系表。
//
// 绑定的链接方式（2026-09-15 变更）：
//  更新页面上，用户新建的 analyzer / retrieval 尚未落库、没有 uuid，无法用 uuid 建边；
//  因此前端一律用「同一次 payload 内各自数组的下标」(processor_index, retrieval_index) 建边，
//  由后端先插入子项拿到 uuid、再按下标完成 uuid 链接。
//  读取时后端若直接返回下标则用下标，否则用 (file_extension, retrieval_type) 反查下标。

/** 模态类型。对应后端 ModalityType 枚举（前端仅用 4 值）。创建后不可修改。 */
export type ModalityType = 'text' | 'image' | 'audio' | 'video';

/** 解析模式。对应后端 AnalysisMode 枚举。 */
export type AnalysisMode = 'default' | 'config' | 'none';

/** 检索类型。对应后端 RetrievalType 枚举。 */
export type RetrievalType =
  | 'document'
  | 'keyword'
  | 'sparse_vector'
  | 'dense_vector'
  | 'graph';

/** 存储后端。对应后端 StorageBackend 枚举；'' 表示由 retrieval_type 默认映射。 */
export type StorageBackend =
  | ''
  | 'postgresql'
  | 'elasticsearch'
  | 'milvus'
  | 'neo4j';

/** 文档类型版本策略。对应后端 VersionMode 枚举。 */
export type VersionMode = 'versioned' | 'immutable';

/** 生命周期状态。对应后端 DefinitionStatus 枚举。 */
export type DefinitionStatus = 'active' | 'deleted';

// ============================================================
// 子项：前处理定义（阶段1，绑定 file_extension）
// ============================================================

/** 前处理定义（阶段1）。一个 document_type_definition + 一个 file_extension 唯一对应一条。 */
export interface DocumentProcessorDefinitionResponse {
  processor_definition_id: string;
  document_type_definition_id: string;
  /** 文件扩展名，如 .pdf。同一种后缀只对应一条前处理。 */
  file_extension: string;
  /** 该扩展名允许的 MIME 集合。 */
  mime_types: string[];
  loader_name: string;
  loader_config: Record<string, any>;
  processor_name: string | null;
  processor_config: Record<string, any>;
  /** 只读。该前处理当前绑定到的 retrieval_type，由 bindings 推导。 */
  retrieval_types?: RetrievalType[];
  status: DefinitionStatus;
  created_at: string;
  updated_at: string;
}

/** 新建/更新时级联的前处理条目（按 file_extension 自然键识别，不传 id）。 */
export interface DocumentProcessorDefinitionItem {
  file_extension: string;
  mime_types?: string[];
  loader_name: string;
  loader_config: Record<string, any>;
  processor_name: string | null;
  processor_config: Record<string, any>;
}

// ============================================================
// 子项：检索定义（阶段2，绑定 retrieval_type）
// ============================================================

/** 检索定义（阶段2）。一个 document_type_definition + 一个 retrieval_type 唯一对应一条。 */
export interface DocumentRetrievalDefinitionResponse {
  retrieval_definition_id: string;
  document_type_definition_id: string;
  retrieval_type: RetrievalType;
  chunker_name: string | null;
  chunker_config: Record<string, any>;
  retriever_name: string | null;
  retriever_config: Record<string, any>;
  storage_backend: StorageBackend;
  storage_config: Record<string, any>;
  /** 只读。绑定到该 retrieval 的文件后缀名，由 bindings 推导。 */
  file_extensions?: string[];
  status: DefinitionStatus;
  created_at: string;
  updated_at: string;
}

/** 新建/更新时级联的检索条目（按 retrieval_type 自然键识别，不传 id）。 */
export interface DocumentRetrievalDefinitionItem {
  retrieval_type: RetrievalType;
  chunker_name: string | null;
  chunker_config: Record<string, any>;
  retriever_name: string | null;
  retriever_config: Record<string, any>;
  storage_backend?: StorageBackend;
  storage_config?: Record<string, any>;
}

// ============================================================
// 子项：N:N 绑定（file_extension × retrieval_type）
// ============================================================

/**
 * N:N 绑定（响应）。后端若已支持下标会直接给出 processor_index / retrieval_index；
 * 否则仍返回 (file_extension, retrieval_type)，由前端反查成下标。
 */
export interface ProcessorRetrievalBindingResponse {
  /** 可选：processors[] 中的下标（后端已支持下标时给出）。 */
  processor_index?: number;
  /** 可选：retrievals[] 中的下标（后端已支持下标时给出）。 */
  retrieval_index?: number;
  file_extension?: string;
  retrieval_type?: RetrievalType;
}

/** 新建/更新时级联的绑定条目：用同一次 payload 内各自数组的下标链接。 */
export interface ProcessorRetrievalBindingItem {
  /** processors[] 中的下标（0-based）。 */
  processor_index: number;
  /** retrievals[] 中的下标（0-based）。 */
  retrieval_index: number;
}

// ============================================================
// 父级：文档类型定义
// ============================================================

/** 文档类型基础响应（列表项与详情共用，详情再叠加 processors/retrievals/bindings）。 */
export interface DocumentTypeDefinitionResponse {
  document_type_definition_id: string;
  /** 乐观锁版本号，每次成功更新 +1。 */
  revision: number;
  tenant_id: string;
  /** 文档类型唯一编码，创建后不可修改。 */
  type_key: string;
  name: string;
  description: string | null;
  /** 模态类型，创建后不可修改。 */
  modality_type: ModalityType;
  /** 解析模式：default / config / none。 */
  analysis_mode: AnalysisMode;
  /** 是否允许更新（文档级）。 */
  allow_update: boolean;
  version_mode: VersionMode;
  fusion_strategy: string | null;
  fusion_config: Record<string, any>;
  rerank_strategy: string | null;
  rerank_config: Record<string, any>;
  metadata?: Record<string, any>;
  status: DefinitionStatus;
  created_at: string;
  updated_at: string;
}

/** 列表项：document.yaml 的 DocumentTypeDefinitionResponse（不含子项）。 */
export type DocumentTypeDefinitionListItem = DocumentTypeDefinitionResponse;

/** 详情：DocumentTypeDefinitionDetailResponse = Response + processors/retrievals/bindings。 */
export interface DocumentTypeDefinitionDetail
  extends DocumentTypeDefinitionResponse {
  processors: DocumentProcessorDefinitionResponse[];
  retrievals: DocumentRetrievalDefinitionResponse[];
  bindings: ProcessorRetrievalBindingResponse[];
}

/** 分页列表响应。 */
export interface DocumentTypeDefinitionListResponse {
  items: DocumentTypeDefinitionResponse[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** 列表查询参数（对齐 GET /document-type-definitions）。 */
export interface ListDocumentTypeDefinitionsParams {
  keyword?: string;
  status?: DefinitionStatus;
  tenant_id?: string;
  modality_type?: ModalityType;
  analysis_mode?: AnalysisMode;
  page?: number;
  page_size?: number;
}

/** 新建请求体（对齐后端 DocumentTypeDefinitionCreateRequest）。 */
export interface DocumentTypeDefinitionCreateRequest {
  type_key: string;
  name: string;
  modality_type: ModalityType;
  analysis_mode: AnalysisMode;
  allow_update: boolean;
  version_mode: VersionMode;
  fusion_strategy: string | null;
  fusion_config: Record<string, any>;
  rerank_strategy: string | null;
  rerank_config: Record<string, any>;
  description?: string | null;
  metadata?: Record<string, any>;
  /** 随类型级联创建的前处理（config 模式使用）。 */
  processors?: DocumentProcessorDefinitionItem[];
  /** 随类型级联创建的检索。 */
  retrievals?: DocumentRetrievalDefinitionItem[];
  /** 随类型级联创建的 N:N 绑定（config 模式使用）。 */
  bindings?: ProcessorRetrievalBindingItem[];
}

/** 更新请求体（对齐 DocumentTypeDefinitionUpdateRequest）。revision 必填（乐观锁）。 */
export interface DocumentTypeDefinitionUpdateRequest {
  /** 乐观锁。必须回传 GET 得到的 revision，不匹配返回 409。 */
  revision: number;
  name?: string;
  description?: string | null;
  analysis_mode?: AnalysisMode;
  allow_update?: boolean;
  version_mode?: VersionMode;
  fusion_strategy?: string | null;
  fusion_config?: Record<string, any>;
  rerank_strategy?: string | null;
  rerank_config?: Record<string, any>;
  metadata?: Record<string, any>;
  /** null=不触碰；数组=全量替换，未出现的既有 processor 会被软删除。 */
  processors?: DocumentProcessorDefinitionItem[] | null;
  retrievals?: DocumentRetrievalDefinitionItem[] | null;
  bindings?: ProcessorRetrievalBindingItem[] | null;
}

// ============================================================
// 下拉选项（后端为枚举/自由字符串，这里给出候选值）
// ============================================================

export const MODALITY_OPTIONS: { label: string; value: ModalityType }[] = [
  { label: '文本（text）', value: 'text' },
  { label: '图片（image）', value: 'image' },
  { label: '音频（audio）', value: 'audio' },
  { label: '视频（video）', value: 'video' },
];

export const MODALITY_META: Record<
  ModalityType,
  { color: string; icon: string; label: string; suffix: string[] }
> = {
  text: {
    color: '#1677ff',
    icon: '📝',
    label: 'Text',
    suffix: ['.txt', '.md', '.pdf', '.doc', '.docx', '.html', '.json', '.csv'],
  },
  image: {
    color: '#52c41a',
    icon: '🖼️',
    label: 'Image',
    suffix: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'],
  },
  audio: {
    color: '#722ed1',
    icon: '🎵',
    label: 'Audio',
    suffix: ['.mp3', '.wav', '.ogg', '.flac'],
  },
  video: {
    color: '#fa8c16',
    icon: '🎬',
    label: 'Video',
    suffix: ['.mp4', '.mov', '.webm', '.avi'],
  },
};

export const ANALYSIS_MODE_OPTIONS: { label: string; value: AnalysisMode }[] = [
  { label: 'default（.* 系统默认）', value: 'default' },
  { label: 'config（自定义）', value: 'config' },
  { label: 'none（不解析）', value: 'none' },
];

export const ANALYSIS_MODE_HINT: Record<AnalysisMode, string> = {
  default:
    '使用系统预制后缀名 Reader（.*），不建解析器定义，该类型下全部检索自动参与。',
  config:
    '使用自定义解析器定义（每个文件后缀一条），可手绘 N:N 绑定；缺少匹配后缀名时不允许上传。',
  none: '不解析文件，不建立解析器与检索。',
};

export const VERSION_MODE_OPTIONS = [
  { label: '可版本化（versioned）', value: 'versioned' },
  { label: '不可变（immutable）', value: 'immutable' },
];

export const FUSION_STRATEGY_OPTIONS = [
  { label: '不融合', value: '' },
  { label: 'RRF 倒数排名融合', value: 'rrf' },
  { label: '加权分数融合', value: 'weighted_score' },
];

export const RERANK_STRATEGY_OPTIONS = [
  { label: '不重排', value: '' },
  { label: 'BGE Reranker', value: 'bge_reranker' },
  { label: 'Cohere Rerank', value: 'cohere_rerank' },
];

export const LOADER_OPTIONS = [
  { label: 'PDF Loader', value: 'pdf_loader' },
  { label: 'Markdown Loader', value: 'markdown_loader' },
  { label: 'HTML Loader', value: 'html_loader' },
  { label: '纯文本 Loader', value: 'text_loader' },
  { label: 'CSV Loader', value: 'csv_loader' },
  { label: 'Word Loader', value: 'docx_loader' },
  { label: 'JSON Loader', value: 'json_loader' },
  { label: '图片 Loader', value: 'image_loader' },
];

/** processor 允许为空（不处理）。 */
export const PROCESSOR_OPTIONS = [
  { label: '不处理', value: '' },
  { label: 'Markdown 处理器', value: 'markdown_processor' },
  { label: 'HTML 处理器', value: 'html_processor' },
  { label: '文本清洗', value: 'text_cleaner' },
  { label: '表格提取', value: 'table_extractor' },
  { label: 'OCR 处理', value: 'ocr_processor' },
];

/** chunker 允许为空（不切分）。 */
export const CHUNKER_OPTIONS = [
  { label: '不切分', value: '' },
  { label: '固定长度切分', value: 'fixed_chunker' },
  { label: '递归切分', value: 'recursive_chunker' },
  { label: '语义切分', value: 'semantic_chunker' },
  { label: 'Token 切分', value: 'token_chunker' },
];

/** retriever 允许为空（使用默认检索器）。 */
export const RETRIEVER_OPTIONS = [
  { label: '默认检索器', value: '' },
  { label: 'BM25 检索器', value: 'bm25_retriever' },
  { label: '向量检索器', value: 'vector_retriever' },
  { label: '图检索器', value: 'graph_retriever' },
];

/** 后缀名固定下拉候选（含 .* 与常见扩展名）。 */
export const SUFFIX_OPTIONS = [
  { label: '.*（全部）', value: '.*' },
  { label: '.txt', value: '.txt' },
  { label: '.md', value: '.md' },
  { label: '.pdf', value: '.pdf' },
  { label: '.doc', value: '.doc' },
  { label: '.docx', value: '.docx' },
  { label: '.html', value: '.html' },
  { label: '.json', value: '.json' },
  { label: '.csv', value: '.csv' },
  { label: '.png', value: '.png' },
  { label: '.jpg', value: '.jpg' },
  { label: '.mp3', value: '.mp3' },
  { label: '.wav', value: '.wav' },
  { label: '.mp4', value: '.mp4' },
];

/**
 * 下拉里保留 key 同时给中文（见 utils/retrievalType.ts）：
 * 配置页要能对照后端里的原始取值，只显示中文反而不利于排查。
 */
export const RETRIEVAL_TYPE_OPTIONS: { label: string; value: RetrievalType }[] =
  (
    ['document', 'keyword', 'sparse_vector', 'dense_vector', 'graph'] as const
  ).map((value) => ({
    value,
    label:
      value === 'keyword'
        ? // BM25 是这一路默认归类的检索器，属于既有约定，继续带出来
          'keyword（关键词 · BM25）'
        : retrievalTypeText(value),
  }));

export const STORAGE_BACKEND_OPTIONS: {
  label: string;
  value: StorageBackend;
}[] = [
  { label: '自动映射', value: '' },
  { label: 'PostgreSQL', value: 'postgresql' },
  { label: 'Elasticsearch', value: 'elasticsearch' },
  { label: 'Milvus', value: 'milvus' },
  { label: 'Neo4j', value: 'neo4j' },
];

/** retrieval_type → 默认数据源展示（仅用于卡片说明）。 */
export const RETRIEVAL_DS_META: Record<
  RetrievalType,
  { ds: string; color: string }
> = {
  document: { ds: 'PostgreSQL', color: '#1677ff' },
  keyword: { ds: 'Elasticsearch', color: '#13c2c2' },
  sparse_vector: { ds: 'Elasticsearch', color: '#13c2c2' },
  dense_vector: { ds: 'PostgreSQL·pgvector', color: '#2f54eb' },
  graph: { ds: 'Neo4j', color: '#eb2f96' },
};

// ============================================================
// Retrieval 卡片的强绑定关系（retrieval_type 决定，不可修改）
// ============================================================

/**
 * retrieval_type → 检索器（强绑定，自动归类）。
 * dense_vector / sparse_vector 属于向量检索器，其余按数据源归类。
 */
export const RETRIEVER_BY_TYPE: Record<
  RetrievalType,
  { label: string; value: string }
> = {
  document: { label: 'Document 检索器', value: 'document_retriever' },
  keyword: { label: 'BM25 检索器', value: 'bm25_retriever' },
  sparse_vector: { label: '稀疏向量检索器', value: 'sparse_vector_retriever' },
  dense_vector: { label: '稠密向量检索器', value: 'dense_vector_retriever' },
  graph: { label: '图检索器', value: 'graph_retriever' },
};

/**
 * retrieval_type → 候选数据源。
 * 这一版默认取第一条且不可修改；候选多于一条是为后续放开预留。
 */
export const RETRIEVAL_DATASOURCE_OPTIONS: Record<
  RetrievalType,
  { label: string; backend: StorageBackend }[]
> = {
  document: [{ label: 'PostgreSQL', backend: 'postgresql' }],
  keyword: [{ label: 'Elasticsearch', backend: 'elasticsearch' }],
  sparse_vector: [{ label: 'Elasticsearch', backend: 'elasticsearch' }],
  dense_vector: [
    { label: 'PostgreSQL · pgvector', backend: 'postgresql' },
    { label: 'Milvus', backend: 'milvus' },
  ],
  graph: [{ label: 'Neo4j', backend: 'neo4j' }],
};

/** 该 retrieval_type 当前锁定的数据源（这一版恒取第一条）。 */
export const defaultDatasource = (rt: RetrievalType): StorageBackend =>
  RETRIEVAL_DATASOURCE_OPTIONS[rt]?.[0]?.backend ?? '';

// ============================================================
// 编辑器内部条目类型（详情页本地状态用，JSON 以字符串存储便于节点内编辑）
// ============================================================

/** 前处理编辑器条目（config 模式）。loader/processor 的 config 以 JSON 字符串存储。 */
export interface ProcessorEditorItem {
  file_extension: string;
  loader_name: string;
  loader_config: string;
  processor_name: string;
  processor_config: string;
}

/** 检索编辑器条目（config 模式）。chunker/retriever 的 config 以 JSON 字符串存储。 */
export interface RetrievalEditorItem {
  retrieval_type: RetrievalType;
  chunker_name: string;
  chunker_config: string;
  retriever_name: string;
  retriever_config: string;
  storage_backend: StorageBackend;
  storage_config: string;
}

/**
 * 绑定编辑器条目：用 processors[] / retrievals[] 的下标链接。
 * 新增的子项还没有 uuid，所以只能按下标建边（后端落库后再换成 uuid 链接）。
 */
export interface BindingEditorItem {
  processor_index: number;
  retrieval_index: number;
}
