// src/pages/document_retrieve/data.ts
// 对齐 YTraderHarness 后端 document_retrieve.yaml（Document Retrieve API v1.0.0）。
//
// 几条容易踩的契约事实，改这个文件时务必保持：
//  1. 所有 ID 都是 **UUID 字符串**（不是整数）。
//  2. 一次调用 = 一轮召回：服务端不会自动扩召回 / 改写查询 / 重试 / 进入 agent 循环。
//  3. 运行时只允许覆盖 Fusioner / Filter / Reranker / Cutter，Recaller 不对外暴露。
//  4. Cutter 没有 enabled 字段 —— 它无法被「关闭」，只能不传（继承默认）或改 top_k。
//  5. 请求体 additionalProperties: false，不能塞任何契约外的字段。
//  6. **pipeline_keys 是数组**：同一个 chunk 被多路同时命中，是融合最有价值的产物，
//     报一路等于把这个信号丢掉。（曾经是单值 pipeline_key，已废弃。）
//  7. **degraded_routes 必须看**：非空说明有些路由压根没参与本轮，
//     results 只来自剩下的路由，可能不完整 —— 不代表「库里就这些」。
//  8. only_active 默认 true，服务端在**索引查询内部**过滤，不是召回后再筛。
//  9. **highlights 是字典**，不是扁平数组：键是 retrieval_type（与 pipeline_keys
//     同域），值是该路给出的 `<em>` 片段。缺键 = 该路没参与，或该路不产生高亮
//     （sparse_vector 那类向量检索没有「哪个词命中」的概念）—— 两种情况要分清。
// 10. **retrieval_types 是「交集」**：传进去的列表只用来**筛**该 DTD 实际配了
//     的 retrieval，不会凭空多出没配过的路。所以点名一个文档里没有的类型不是
//     错误，只是那一项筛不掉任何东西。
//     - **空数组会被 422 拒绝**，不是「全部」：null / 不传才是「全部」。
//       按交集语义 [] 本来就是「一路都不要」，那是几乎不会有人想要的结果，
//       拒绝它比猜意图安全 —— 所以前端必须拦住「一路都没勾」这种状态，
//       绝不能退化成不传（那等于偷偷改成「全部」，与用户意图完全相反）。
//     - 被筛掉的路不贡献分数，也不会出现在 pipeline_keys 里。
// 11. **retrieval_config 是「每路各自」的召回参数**（key = retrieval_type），
//     与 retrieval_types 分工明确：后者决定**跑哪几路**，前者决定**每路跑多宽**。
//     它描述的是融合**之前**的那一道工序 —— 候选池有多大、有多干净；
//     而 retrieve_processor 的四段都在召回**之后**排序。两者不是一个环节。
//     - key 必须是**合法的 retrieval type**，拼错（dense_vectorr）会 422，
//       不像 retrieval_types 那样「点名一个不存在的值只是筛不掉东西」——
//       那是过滤器，这是配置，一个匹配不上任何东西的 key 就是错误。
//       所以前端只从「已选定义的并集」里取值，绝不提供手填入口。
//     - 一个合法 key 指向了 retrieval_types 没选中的路 → 只是**用不上**，不是错误。
//     - 某一路 / 某个字段不传 = 走它自己的默认。
// 12. **retrieval_config.top_k 是候选池大小，不是结果条数**（默认 200）。
//     结果条数是 cutter.top_k。池子太窄，语义相关但排位靠后的 chunk 根本进不来，
//     后面再怎么融合、重排、截断都捞不回来。
// 13. **min_score 作用在原始分上，且量纲随路而变**：keyword 是 BM25（无上界，
//     几十很常见），sparse_vector 是稀疏点积（无上界），dense_vector 是
//     cosine（[-1, 1]）。同一个数字在每一路上干的是不同的事，所以它才按路给。
//     它必须**下推到索引**而不是召回后再筛 —— 每路召回后会立刻除以最大值做
//     归一化，把本路第一名的分数钉成 1.0，拿阈值比归一化后的分数永远筛不掉东西。
// 14. **search_params 目前只有 dense_vector（Milvus）消费**（HNSW 的 ef / nprobe），
//     其它后端没有等价参数、会忽略它。它和 top_k 是两个不同的旋钮：ef 太小是
//     **真的丢邻居** —— top_k 要 200 而 ef 只有 10，拿不到真正的 top 200。
//     metric_type 不能在这里覆盖，它是建集合时定死的物理事实。
// 15. timeout_ms 是**单路独立**超时（1 – 60000）。超时只把这一路放进
//     degraded_routes，其它路照常返回 —— 与后端故障的处理一致，不让一个慢
//     路由把整个查询拖失败。

import { retrievalTypeLabel } from '@/utils/retrievalType';

export type RetrieveScope = 'single' | 'multi';
export type RetrieveProcessorMode = 'dtd' | 'common_chain';
export type RetrieveProcessorSource =
  | 'document_type_definition'
  | 'common_retrieve_processor_chain'
  | 'runtime_override';
export type FusionerType = 'rrf' | 'weighted_sum';
export type RerankerType = 'cross_encoder' | 'llm' | 'custom';

export interface FusionerConfig {
  enabled?: boolean;
  type?: FusionerType;
  /** 1 – 5000，默认 50 */
  top_k?: number;
  /** 仅 rrf 生效，1 – 1000，默认 60 */
  rrf_k?: number;
  /** 仅 weighted_sum 生效，key 是服务端定义的召回来源标识 */
  weights?: Record<string, number> | null;
}

export interface FilterConfig {
  enabled?: boolean;
  /** 0 – 1 的归一化分数下限 */
  score_threshold?: number | null;
  document_ids?: string[] | null;
  document_version_ids?: string[] | null;
  /** 服务端支持的元数据条件，语义为精确匹配（实现可扩展） */
  metadata?: Record<string, unknown> | null;
}

export interface RerankerConfig {
  enabled?: boolean;
  type?: RerankerType | null;
  model?: string | null;
  /** 1 – 5000 */
  top_n?: number | null;
}

export interface CutterConfig {
  /** 1 – 1000，默认 10：最终结果条数上限 */
  top_k?: number;
  /** 1 – 200000：单条 content 的最大字符数 */
  max_content_chars?: number;
}

export interface RetrieveProcessorOverride {
  fusioner?: FusionerConfig;
  filter?: FilterConfig;
  reranker?: RerankerConfig;
  cutter?: CutterConfig;
}

/**
 * 单路（一个 retrieval_type）的召回参数 —— 融合**之前**那一道工序。
 *
 * 四个字段都是可选的：**不传就等于走这一路自己的默认**，所以前端不该在用户
 * 没明确设置时先塞一个看起来等于默认值的数进去。
 */
export interface RetrievalRecallConfig {
  /**
   * 1 – 500，默认 200。这一路要召回多少**候选**。
   *
   * ⚠️ 这是候选池大小，不是返回条数 —— 返回条数是 cutter.top_k。
   */
  top_k?: number;
  /**
   * 原始分下限，作用在**未归一化**的分数上。
   *
   * 契约没有给它 min/max，因为量纲随路而变（见文件头第 13 条）。前端因此
   * **不做 0..1 的钳制** —— 那会把 keyword 的 BM25 阈值直接废掉。
   */
  min_score?: number;
  /**
   * 透传给后端的检索参数，后端原样消费。
   * 目前只有 dense_vector（Milvus）用得上，如 HNSW 的 ef / nprobe。
   */
  search_params?: Record<string, unknown>;
  /** 1 – 60000：这一路独有的超时（毫秒）。超时只让这一路降级。 */
  timeout_ms?: number;
}

/** key = retrieval_type。见文件头第 11 条：key 拼错会 422，不能手填。 */
export type RetrievalConfigMap = Record<string, RetrievalRecallConfig>;

export interface DocumentRetrieveRequest {
  /** 1 – 50 个，UUID。1 个 → scope=single；多个 → multi + 公共链。 */
  document_type_definition_ids: string[];
  /** 1 – 10000 字符 */
  input_text: string;
  /**
   * 是否只在**当前生效版本**（is_current）上召回，契约默认 true。
   *
   * 设成 false 只为排查历史版本里有什么 —— superseded / pending / failed
   * 的版本重处理时不会被删，不限制就会与当前内容抢同一个结果位。
   *
   * 过滤发生在**索引查询内部**而不是 hydrate 之后：晚筛会让历史版本先吃掉
   * 召回预算，结果集被悄悄缩小。
   */
  only_active?: boolean;
  /**
   * 定向召回：只走这几路。不传 / null = 该 DTD 配置的全部路。
   *
   * **交集语义**：只用来筛 DTD 实际配了的路，不会凭空多出没配过的路，
   * 所以点名一个文档里没有的类型不是错误，只是那一项筛不掉东西。
   *
   * ⚠️ **空数组会被 422 拒绝**（不是「全部」）。构造请求时必须保证：
   * 要么不传（= 全部），要么至少 1 项。前端的兜底是「一路都没勾就拦住
   * 不发起」，而不是退化成不传 —— 那等于把「什么都不要」偷偷改成「全部」。
   */
  retrieval_types?: string[] | null;
  /**
   * 每路各自的召回参数，key = retrieval_type。见文件头第 11 – 14 条。
   *
   * 与 retrieval_types 的分工：那个决定跑哪几路，这个决定每路跑多宽。
   */
  retrieval_config?: RetrievalConfigMap;
  retrieve_processor?: RetrieveProcessorOverride;
}

export interface DocumentRetrieveResult {
  rank: number;
  score: number;
  document_chunk_id: string;
  document_version_id: string;
  document_id: string;
  document_type_definition_id: string;
  /**
   * 命中这条结果的**全部**业务召回方向。
   *
   * 数组而非单值：跨路分数不可比（BM25 是几十的量级，cosine 是 0..1），
   * 但「两路都选中了它」可比 —— 这正是融合要产出的信号。
   * 取值来自 DocumentRetrievalDefinition.retrieval_type，仅信息性，
   * 不是调用方可控的 Recaller 参数。
   */
  pipeline_keys?: string[];
  content: string;
  metadata?: Record<string, unknown> | null;
  /**
   * 索引侧给的带标记片段，**按路分组** —— 键与 pipeline_keys 同一个取值域
   * （DocumentRetrievalDefinition.retrieval_type），所以可以直接拿这一路的
   * 名字去取它自己的标记，用来做「切到哪一路就只描哪一路的命中」。
   *
   * 值是该路给出的片段，标记仍是 `<em>…</em>`。
   *
   * ⚠️ **某个键不存在是正常的**，且有两种不同含义，别混为一谈：
   *   1. 该路压根没参与本轮 —— 去 degraded_routes 里找它，有原因；
   *   2. 该路参与了但不产生高亮 —— 向量相似度里没有「哪个词命中」的概念
   *      （ES 的 sparse_vector 就是这样），`pipeline_keys` 里照样有它。
   * 所以「有键」才等于「这一路标出了东西」，空数组也一样是异常信号。
   */
  highlights?: Record<string, string[]> | null;
}

/**
 * 本轮**没能参与**的路由。
 *
 * 单个后端挂掉（Milvus 恢复中、ES 超时）刻意不让整个请求失败 —— 其他路的
 * 命中确实可召回；但降级不静默，必须由调用方检查这个字段。
 */
export interface DegradedRoute {
  document_retrieval_definition_id: string;
  /**
   * 该路由本应服务的召回方向。
   * 契约刻意不在这里重复内联枚举 —— 与 pipeline_keys 同一个取值域。
   */
  retrieval_type: string;
  /** 没参与的原因：后端的错误信息，或「尚未实现」。 */
  reason: string;
}

export interface EffectiveRetrieveProcessor {
  source: RetrieveProcessorSource;
  fusioner?: FusionerConfig | null;
  filter?: FilterConfig | null;
  reranker?: RerankerConfig | null;
  cutter?: CutterConfig | null;
}

export interface DocumentRetrieveResponse {
  retrieve_id: string;
  retrieve_scope: RetrieveScope;
  retrieve_processor_mode: RetrieveProcessorMode;
  document_type_definition_ids: string[];
  results: DocumentRetrieveResult[];
  /** 空数组 = 所有路由都参与了；非空 = results 只来自剩下的路由，可能不完整。 */
  degraded_routes?: DegradedRoute[] | null;
  retrieve_processor?: EffectiveRetrieveProcessor | null;
}

// ============================================================
// 面板状态（UI 模型）与请求体构造
// ============================================================

export interface MetadataRow {
  key: string;
  value: string;
}

export interface FusionerPanel {
  on: boolean;
  enabled: boolean;
  type: FusionerType;
  topK: number;
  rrfK: number;
  /** 按 pipeline_key 分配权重，内部会归一化后写入 */
  weights: Record<string, number>;
}

export interface FilterPanel {
  on: boolean;
  enabled: boolean;
  scoreThreshold: number | null;
  documentIds: string[];
  /** 精确到版本级；与 documentIds 可同时用（契约里是两个独立条件） */
  documentVersionIds: string[];
  metadataRows: MetadataRow[];
}

export interface RerankerPanel {
  on: boolean;
  enabled: boolean;
  type: RerankerType;
  model: string;
  topN: number;
}

/** 注意：契约里 Cutter 没有 enabled，所以这里也没有。 */
export interface CutterPanel {
  on: boolean;
  topK: number;
  maxContentChars: number | null;
}

/**
 * search_params 的一行。
 *
 * 与 MetadataRow 同形但语义完全不同（原样透传 vs 精确匹配过滤），分开命名，
 * 免得看代码时把「透传给 Milvus 的 ef」当成「过滤条件」。
 */
export interface SearchParamRow {
  key: string;
  value: string;
}

/**
 * 单路召回参数的面板状态。
 *
 * 所有数值字段默认 **null = 不传**，而不是填契约默认值：不传就是「走这一路
 * 自己的默认」，填了才是「用户明确要求」。这样预览里的每个字段都对应一次
 * 明确的intent，不会出现「看着配了其实等于没配」的噪音。
 */
export interface RetrievalRecallPanel {
  /** false = 这一路的键整个不传，走该路默认。 */
  on: boolean;
  topK: number | null;
  minScore: number | null;
  searchParamRows: SearchParamRow[];
  timeoutMs: number | null;
}

export interface RetrievePanelState {
  dtdIds: string[];
  inputText: string;
  /** 只在当前生效版本上召回（契约默认 true）。面板默认也是 true。 */
  onlyActive: boolean;
  /**
   * 定向召回里**被取消勾选**的那几路 —— 存「没选的」而不是「选了的」。
   *
   * 为什么反着存：「默认全部勾选」意味着**新出现的路要自动勾上**。若存选中的
   * 集合，并集变化时必须区分「这一项是用户手动取消的」还是「这一项刚出现」，
   * 得额外记住上一轮的并集；存排除集合则天然满足 —— 没被排除的都在，
   * 并集里消失的项自动跟着消失，不会留下勾了却无效的脏值。
   *
   * 勾选结果 = 并集 − excludedTypes（见 buildRetrieveRequest）。
   */
  excludedTypes: string[];
  /**
   * 每路召回参数，key = retrieval_type。
   *
   * 只存**用户在面板上动过的路**；没动过的路不在键里（那就是不传 = 默认）。
   *
   * 键在并集里消失时**故意不清理**：换掉一个定义再换回来，之前配的 top_k
   * 应该还在。面板只渲染并集里的路，所以残留的键既不会显示也不会下发 ——
   * 而它们始终是合法的 retrieval type（键只可能来自并集），不会触发 422。
   */
  retrievalConfig: Record<string, RetrievalRecallPanel>;
  fusioner: FusionerPanel;
  filter: FilterPanel;
  reranker: RerankerPanel;
  cutter: CutterPanel;
}

export const DEFAULT_WEIGHTS: Record<string, number> = {
  dense_vector: 1,
  sparse_vector: 1,
  keyword: 1,
  graph: 1,
};

export function defaultPanel(): RetrievePanelState {
  return {
    dtdIds: [],
    inputText: '',
    // 与契约默认值保持一致：默认只在当前生效版本上召回
    onlyActive: true,
    // 默认全部勾选 —— 等价于「不传 retrieval_types」= 该 DTD 配的全部路
    excludedTypes: [],
    // 空对象 = 每一路都走自己的默认，retrieval_config 整个不传
    retrievalConfig: {},
    fusioner: {
      on: false,
      enabled: true,
      type: 'rrf',
      topK: 50,
      rrfK: 60,
      weights: { ...DEFAULT_WEIGHTS },
    },
    filter: {
      on: false,
      enabled: true,
      scoreThreshold: null,
      documentIds: [],
      documentVersionIds: [],
      metadataRows: [{ key: '', value: '' }],
    },
    reranker: {
      on: false,
      enabled: true,
      type: 'cross_encoder',
      model: 'bge-reranker-v2-m3',
      topN: 50,
    },
    cutter: { on: false, topK: 10, maxContentChars: null },
  };
}

// ============================================================
// 定向召回（retrieval_types）的可选项
// ============================================================

/**
 * 详情里我们只用到 retrievals —— 单独声明一个最小形状，免得 data.ts
 * 反向依赖 document_type_definition 页的完整类型（那会把两个页面缠在一起）。
 */
export interface RetrievalOwner {
  retrievals?: { retrieval_type?: string; status?: string }[] | null;
}

/**
 * 已选定义的 retrieval_type **并集**（去重，保持首次出现的顺序）。
 *
 * 只算 `status === 'active'` 的 retrieval：已删除的那几路根本不参与召回，
 * 摆出来让人勾选等于给一个勾了也没用的选项。
 *
 * 并集而不是「逐个定义各自一列」：retrieval_types 是**平铺的一维数组**，
 * 后端拿到后与每个 DTD 实际配的路求交集，不区分「这一路是谁的」。
 * 前端展示成并集，正是请求体能表达的东西 —— 别画出请求表达不了的分组。
 */
export function unionRetrievalTypes(
  ids: string[],
  details: Record<string, RetrievalOwner | undefined>,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    for (const r of details[id]?.retrievals ?? []) {
      if (r?.status && r.status !== 'active') continue;
      const type = r?.retrieval_type;
      if (type && !out.includes(type)) out.push(type);
    }
  }
  return out;
}

/**
 * 每一路**来自哪几个定义** —— 交集语义下这是关键信息。
 *
 * 选中「只有其中一个定义配了的那一路」时，其余定义会一路都召不到
 * （交集后为空），结果条数自然变少。不写明出处的话，用户只会觉得
 * 「召回怎么突然少了」，归因不到路径上。
 */
export function retrievalTypeOwners(
  ids: string[],
  details: Record<string, RetrievalOwner | undefined>,
  nameOf: (id: string) => string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    for (const r of details[id]?.retrievals ?? []) {
      if (r?.status && r.status !== 'active') continue;
      const type = r?.retrieval_type;
      if (!type) continue;
      const names = out[type] ?? [];
      const name = nameOf(id);
      if (!names.includes(name)) names.push(name);
      out[type] = names;
    }
  }
  return out;
}

export const RERANKER_MODEL_PRESET: Record<RerankerType, string> = {
  cross_encoder: 'bge-reranker-v2-m3',
  llm: 'gpt-4o-mini',
  custom: 'custom-reranker',
};

/** 单路召回参数的初始态：关闭，且所有值都「不传」。 */
export function defaultRecallPanel(): RetrievalRecallPanel {
  return {
    on: false,
    topK: null,
    minScore: null,
    searchParamRows: [{ key: '', value: '' }],
    timeoutMs: null,
  };
}

/**
 * min_score 在每一路上的量纲 —— 契约明确说「同一个数字在每一路上含义不同」，
 * 这正是它按路给的原因。
 *
 * 只列契约点名的三路；其余（graph / document 等）走兜底，绝不替后端编一个量纲。
 */
const MIN_SCORE_META: Record<
  string,
  { placeholder: string; note: string; step: number }
> = {
  keyword: {
    placeholder: '如 20',
    note: 'BM25 原始分，无上界（几十很常见）',
    step: 1,
  },
  sparse_vector: {
    placeholder: '如 20',
    note: '稀疏点积，无上界',
    step: 1,
  },
  dense_vector: {
    placeholder: '如 0.3',
    note: 'cosine，落在 [-1, 1]',
    step: 0.05,
  },
};

const MIN_SCORE_FALLBACK = {
  placeholder: '如 0.3',
  note: '契约未说明这一路的原始分量纲',
  step: 0.05,
};

export function minScoreMeta(type: string): {
  placeholder: string;
  note: string;
  step: number;
} {
  return MIN_SCORE_META[type] ?? MIN_SCORE_FALLBACK;
}

/** 契约点名：目前只有 dense_vector（Milvus）消费 search_params。 */
export function searchParamsNote(type: string): string {
  return type === 'dense_vector'
    ? 'Milvus 的 HNSW ef / nprobe 这类参数。它和 top_k 是两个旋钮：ef 太小会真的丢邻居。'
    : '该后端没有等价参数，填了也会被忽略。';
}

/**
 * 面板状态 → 请求体。纯函数，方便单测，也保证「面板里看到的」就是「发出去的」。
 *
 * 三态语义：
 *  - on=false            → 该段整个不传，继承所选 RetrieveProcessor（DTD 或公共链）
 *  - on=true, enabled=true  → 运行时覆盖
 *  - on=true, enabled=false → 显式关闭该段（Fusioner / Filter / Reranker 才有 enabled）
 *
 * @param availableTypes 定向召回的可选项（已选定义的 retrieval_type 并集）。
 *   详情还没拉回来时是空数组，此时**不传** retrieval_types —— 那就是契约里的
 *   「全部」，与「还没得选」的现实一致。
 */
export function buildRetrieveRequest(
  panel: RetrievePanelState,
  availableTypes: string[] = [],
): DocumentRetrieveRequest {
  const body: DocumentRetrieveRequest = {
    document_type_definition_ids: panel.dtdIds.slice(),
    input_text: panel.inputText,
    // 总是显式发出：面板上有开关，预览里就得看得见它 —— 契约默认值也是 true
    only_active: panel.onlyActive,
  };

  // 定向召回 = 并集 − 被排除的。
  //
  // ⚠️ 只有「真子集」才发：全勾时发不发出去语义完全相同（并集 ∩ 已配的路 =
  // 已配的路），但空数组会被 422 拒绝 —— 所以这里的两条边界是刻意的：
  //   · wanted === available（全勾）→ 不传，用契约的 null 表达「全部」；
  //   · wanted 为空              → 也不传，但**这不是可发起的状态**，
  //     调用方必须先拦住（见 index.tsx 的 run）；宁可少发一个字段，
  //     也不能发一个必然 422 的空数组，更不能悄悄退化成「全部」。
  const wanted = availableTypes.filter(
    (type) => !panel.excludedTypes.includes(type),
  );
  if (wanted.length && wanted.length < availableTypes.length) {
    body.retrieval_types = wanted;
  }

  // 每路召回参数：只下发「打开且至少填了一个字段」的路。
  //
  // 键只可能来自并集（面板不提供手填入口），必然是合法的 retrieval type，
  // 不会踩「拼错就 422」那条。合法的键指向 retrieval_types 没选中的路时，
  // 契约说只是「用不上」而非错误 —— 这里照样下发，不替用户猜他要不要。
  const rc: RetrievalConfigMap = {};
  Object.entries(panel.retrievalConfig).forEach(([type, cfg]) => {
    if (!cfg?.on) return;

    const out: RetrievalRecallConfig = {};
    if (cfg.topK !== null) out.top_k = cfg.topK;
    if (cfg.minScore !== null) out.min_score = cfg.minScore;
    if (cfg.timeoutMs !== null) out.timeout_ms = cfg.timeoutMs;

    const sp: Record<string, unknown> = {};
    cfg.searchParamRows.forEach((row) => {
      const key = row.key.trim();
      const raw = row.value.trim();
      if (!key || !raw) return;
      // 值是自由形态，但 Milvus 那类参数（ef / nprobe）是整数 ——
      // 全当字符串发出去，后端要么拒绝要么自己转，都不如这里按形态给准。
      const asNumber = Number(raw);
      sp[key] = Number.isFinite(asNumber) ? asNumber : raw;
    });
    if (Object.keys(sp).length) out.search_params = sp;

    if (Object.keys(out).length) rc[type] = out;
  });
  if (Object.keys(rc).length) body.retrieval_config = rc;

  const rp: RetrieveProcessorOverride = {};

  if (panel.fusioner.on) {
    if (!panel.fusioner.enabled) {
      rp.fusioner = { enabled: false };
    } else {
      const cfg: FusionerConfig = {
        enabled: true,
        type: panel.fusioner.type,
        top_k: panel.fusioner.topK,
      };
      if (panel.fusioner.type === 'rrf') {
        cfg.rrf_k = panel.fusioner.rrfK;
      } else {
        const w: Record<string, number> = {};
        Object.entries(panel.fusioner.weights).forEach(([k, v]) => {
          if (v > 0) w[k] = Number(v.toFixed(2));
        });
        if (Object.keys(w).length) cfg.weights = w;
      }
      rp.fusioner = cfg;
    }
  }

  if (panel.filter.on) {
    if (!panel.filter.enabled) {
      rp.filter = { enabled: false };
    } else {
      const cfg: FilterConfig = { enabled: true };
      if (panel.filter.scoreThreshold !== null) {
        cfg.score_threshold = Number(panel.filter.scoreThreshold.toFixed(2));
      }
      if (panel.filter.documentIds.length) {
        cfg.document_ids = panel.filter.documentIds.slice();
      }
      if (panel.filter.documentVersionIds.length) {
        cfg.document_version_ids = panel.filter.documentVersionIds.slice();
      }
      const md: Record<string, unknown> = {};
      panel.filter.metadataRows.forEach((row) => {
        if (row.key.trim() && row.value.trim())
          md[row.key.trim()] = row.value.trim();
      });
      if (Object.keys(md).length) cfg.metadata = md;
      rp.filter = cfg;
    }
  }

  if (panel.reranker.on) {
    if (!panel.reranker.enabled) {
      rp.reranker = { enabled: false };
    } else {
      const cfg: RerankerConfig = {
        enabled: true,
        type: panel.reranker.type,
      };
      if (panel.reranker.model.trim()) cfg.model = panel.reranker.model.trim();
      if (panel.reranker.topN > 0) cfg.top_n = panel.reranker.topN;
      rp.reranker = cfg;
    }
  }

  if (panel.cutter.on) {
    const cfg: CutterConfig = { top_k: panel.cutter.topK };
    if (
      panel.cutter.maxContentChars !== null &&
      panel.cutter.maxContentChars > 0
    ) {
      cfg.max_content_chars = panel.cutter.maxContentChars;
    }
    rp.cutter = cfg;
  }

  if (Object.keys(rp).length) body.retrieve_processor = rp;
  return body;
}

// ============================================================
// 从响应里派生的纯函数
// ============================================================

/** pipeline_keys 为空时的兜底分组键。契约默认 []，不代表没命中任何路，只是没标注。 */
export const UNLABELED_PATH = '__unlabeled__';

/**
 * 一条结果命中的召回方向，**去重且保持后端顺序**。
 *
 * 契约没给 pipeline_keys 声明 uniqueItems，所以前端不假设它已去重 ——
 * 同一路重复出现会让分组视图里同一条结果出现两次。
 */
export function resultPathKeys(result: DocumentRetrieveResult): string[] {
  return Array.from(new Set(result.pipeline_keys ?? []));
}

/** 分组键 → 展示名。unknown 那类兜底键不交给 retrievalTypeLabel（它会把键原样吐出）。 */
export function pathLabel(key: string): string {
  return key === UNLABELED_PATH ? '未标注路径' : retrievalTypeLabel(key);
}

// ============================================================
// 命中高亮：把 highlights 还原成正文里的描出区间
// ============================================================

/** 「全部路」在控件里的取值 —— Segmented 的 value 只收 string | number，null 当不了选项值。 */
export const ALL_ROUTES = '__all__';

/**
 * 取某一路的高亮片段；`route` 传 null 表示「全部路」。
 *
 * 为什么这里能按路取：`highlights` 是**按路分组的字典**，键与 pipeline_keys
 * 同域（见 DocumentRetrieveResult.highlights），所以「切到哪一路」这件事
 * 在数据上本来就成立，不需要前端去猜某段标记是谁标的。
 *
 * 「全部路」= 各路的片段拼起来，**刻意不去重**：contentMarks 会自己排序、
 * 合并相邻与重叠区间，重复片段被它吸收掉。去重逻辑留一处就够了 ——
 * 两处各写一遍，迟早会在「同一句话被两路都标了」时给出不同答案。
 */
export function highlightFragments(
  highlights: Record<string, string[]> | null | undefined,
  route: string | null,
): string[] {
  if (!highlights) return [];

  if (route === null) {
    const all: string[] = [];
    for (const fragments of Object.values(highlights)) {
      if (fragments?.length) all.push(...fragments);
    }
    return all;
  }

  return highlights[route] ?? [];
}

/** 正文里要描出的一段，左闭右开。 */
export interface MarkRange {
  start: number;
  end: number;
}

const EM_OPEN = '<em>';
const EM_CLOSE = '</em>';

/**
 * 一组带 `<em>` 的片段 → 正文坐标上的描出区间。
 *
 * 入参是**片段列表**（某一路的，或几路拼起来的），不是整个 highlights
 * 字典 —— 分组交给 highlightFragments，这个函数只管几何。
 *
 * 为什么不是「把 <em> 里的词抽出来去全文匹配」
 * ------------------------------------------
 * 索引给的是**片段 + 片段内的标记位置**（fvh 读的是索引里存好的偏移）。
 * 实测 ES 对中文是**逐字**打标记的：
 *
 *     <em>人</em><em>脑</em><em>的</em><em>算</em><em>力</em>…
 *
 * 抽出来的「词」就是 人 / 脑 / 的 / 算 / 力 / 冗 / 余 这种单字。拿它们回
 * 全文匹配，正文里**每一个「的」都会变黄** —— 一条结果就毁在停用字上。
 *
 * 所以做法是：逐字符解析片段得到「无标记文本 + <em> 区间」，把无标记文本
 * 在正文里定位，再把区间**平移**过去。定位不到就整个片段放弃 ——
 * 宁可不标，不能标错。
 */
export function contentMarks(
  content: string,
  fragments?: string[] | null,
): MarkRange[] {
  if (!content || !fragments?.length) return [];

  const found: MarkRange[] = [];
  /** 片段按出现顺序返回，用只前进的游标处理重复句子，避免全落在第一处 */
  let cursor = 0;

  for (const raw of fragments) {
    if (!raw) continue;

    let plain = '';
    const spans: MarkRange[] = [];
    let open = -1;
    let i = 0;
    while (i < raw.length) {
      if (raw.startsWith(EM_OPEN, i)) {
        open = plain.length;
        i += EM_OPEN.length;
        continue;
      }
      if (raw.startsWith(EM_CLOSE, i)) {
        if (open >= 0) spans.push({ start: open, end: plain.length });
        open = -1;
        i += EM_CLOSE.length;
        continue;
      }
      plain += raw[i];
      i += 1;
    }
    if (!spans.length) continue;

    // 首尾的空白与省略号是服务端截断时加的，正文里没有 —— 定位前先摘掉，
    // 摘掉多少要记下来，坐标得跟着平移。
    let head = 0;
    let tail = plain.length;
    const isPad = (ch: string) => /\s/.test(ch) || ch === '…' || ch === '.';
    while (head < tail && isPad(plain[head])) head += 1;
    while (tail > head && isPad(plain[tail - 1])) tail -= 1;

    const needle = plain.slice(head, tail);
    if (!needle) continue;

    let at = content.indexOf(needle, cursor);
    if (at < 0) at = content.indexOf(needle);
    if (at < 0) continue;
    cursor = at + needle.length;

    for (const span of spans) {
      const start = at + span.start - head;
      const end = at + span.end - head;
      // 标记落在被摘掉的首尾垫料里 → 丢掉
      if (end <= at || start >= at + needle.length) continue;
      found.push({
        start: Math.max(at, start),
        end: Math.min(at + needle.length, end),
      });
    }
  }

  return mergeMarkRanges(found);
}

/**
 * 排序 + 合并相邻与重叠区间。
 *
 * 相邻（start === last.end）**也要并**：分词器把「冗余」拆成两个字各标一次，
 * 不并的话正文上会是一串互不相连的单字高亮块。
 *
 * 单独提出来是因为「各路区间并起来」也要走同一套合并 —— 两处各写一遍，
 * 迟早会在跨路相邻区间上给出不同答案。
 */
export function mergeMarkRanges(ranges: MarkRange[]): MarkRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);

  const merged: MarkRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * 一条结果在**每一路**下的描出区间。
 *
 * 有键的路才是「标出了东西」的路 —— 没键的路在这里也就没有条目，
 * 渲染时自然落进「这一路没有给出高亮片段」那一档。
 */
export function marksByRoute(
  content: string,
  highlights: Record<string, string[]> | null | undefined,
): Record<string, MarkRange[]> {
  const out: Record<string, MarkRange[]> = {};
  if (!content || !highlights) return out;

  for (const [route, fragments] of Object.entries(highlights)) {
    out[route] = contentMarks(content, fragments);
  }
  return out;
}

/** 某一档下的描出区间；`route` 传 null 表示全部路（各路的并集）。 */
export function marksForRoute(
  byRoute: Record<string, MarkRange[]>,
  route: string | null,
): MarkRange[] {
  if (route === null) {
    return mergeMarkRanges(Object.values(byRoute).flat());
  }
  return byRoute[route] ?? [];
}

/**
 * 正文的**最小单元**：每条路自己的区间端点都是切点。
 *
 * 为什么要绕这一步：切换路径时若按「当前这一路的区间」重新切段，段边界会
 * 跟着变，React 只能把整块正文卸载重挂 —— 新元素没有旧值可比，CSS 过渡
 * 根本没机会跑。改成按「**所有路的**端点」切，边界就与选中的路无关：切换
 * 只是同一批元素换 class，于是「先渐隐、再渐亮」可以完全交给 CSS 过渡，
 * 不用定时器，也不必把正文渲染两遍做交叉淡入。
 *
 * ⚠️ 切点要**逐路各取**，不能先把各路的区间合并再切：合并会把某一路自己的
 * 端点吃进另一路的区间里（A 的 [10,25) 与 B 的 [20,30) 并成 [10,30)，25
 * 这个切点就没了），那样切出来的单元对 A 并不均匀，按 A 判命中会多标一截。
 */
export interface MarkCell {
  /** 在 content 里的起始下标 —— 与选中的路无关，可以直接当 React key。 */
  start: number;
  end: number;
  text: string;
  /** 盖住这个单元的**全部**路（按 byRoute 的键序）。空 = 没被任何路标到。 */
  routes: string[];
}

export function markCells(
  content: string,
  byRoute: Record<string, MarkRange[]>,
): MarkCell[] {
  if (!content) return [];

  const routes = Object.keys(byRoute);
  if (!routes.length) {
    return [{ start: 0, end: content.length, text: content, routes: [] }];
  }

  const cuts = new Set<number>();
  for (const marks of Object.values(byRoute)) {
    for (const mark of marks) {
      cuts.add(mark.start);
      cuts.add(mark.end);
    }
  }

  const points = [...cuts]
    .filter((point) => point > 0 && point < content.length)
    .sort((a, b) => a - b);

  const cells: MarkCell[] = [];
  let at = 0;
  for (const point of points) {
    if (point <= at) continue;
    cells.push({
      start: at,
      end: point,
      text: content.slice(at, point),
      routes: [],
    });
    at = point;
  }
  if (at < content.length) {
    cells.push({
      start: at,
      end: content.length,
      text: content.slice(at),
      routes: [],
    });
  }

  for (const cell of cells) {
    for (const route of routes) {
      const marks = byRoute[route] ?? [];
      // 单元是按所有路的端点切的，所以任一区间对任一单元只可能「整段包含」
      // 或「完全不碰」—— 直接判整段包含，不必去想跨界的情形。
      if (
        marks.some((mark) => mark.start <= cell.start && cell.end <= mark.end)
      ) {
        cell.routes.push(route);
      }
    }
  }

  // 切点来自所有路，必然切出一堆「被同一批路盖住」的相邻小段（两路交叠的那
  // 一段就会被切开）。它们上色结果完全一样，并起来省几百个 span。
  const merged: MarkCell[] = [];
  for (const cell of cells) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.end === cell.start &&
      last.routes.join() === cell.routes.join()
    ) {
      last.end = cell.end;
      last.text += cell.text;
      continue;
    }
    merged.push(cell);
  }
  return merged;
}

/** 这个单元在某一档下要不要上底色；`route` 传 null 表示全部路。 */
export function cellHit(cell: MarkCell, route: string | null): boolean {
  return route === null ? cell.routes.length > 0 : cell.routes.includes(route);
}

// ============================================================
// 展示用常量
// ============================================================

/** pipeline_key 与 retrieval_type 同为后端契约键，中文名复用全局映射。 */
export const PIPELINE_KEY_COLOR: Record<string, string> = {
  document: 'default',
  keyword: 'orange',
  sparse_vector: 'purple',
  dense_vector: 'blue',
  graph: 'cyan',
};

export const RETRIEVE_SOURCE_META: Record<
  RetrieveProcessorSource,
  { label: string; color: string }
> = {
  document_type_definition: { label: 'DTD 自带处理器', color: 'blue' },
  common_retrieve_processor_chain: { label: '公共链', color: 'purple' },
  runtime_override: { label: '运行时覆盖', color: 'orange' },
};

/**
 * 执行链路上要展示的阶段 —— **只有可覆盖的四个**。
 *
 * Recaller 刻意不在这里：契约说它是内部实现、不通过公开 API 暴露，
 * 那就没有任何「生效配置」可回显，画面上挂一个空节点只会让人误以为能配。
 */
export const STAGE_META: { key: string; label: string }[] = [
  { key: 'fusioner', label: 'Fusioner' },
  { key: 'filter', label: 'Filter' },
  { key: 'reranker', label: 'Reranker' },
  { key: 'cutter', label: 'Cutter' },
];
