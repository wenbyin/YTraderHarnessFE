// src/pages/retrieval_eval/stageOrder.ts
// 阶段展示顺序的**唯一真源**。
//
// 为什么需要它
// ------------
// 后端把阶段读出来时是按 `stage_key` **字母序**排的，不是按执行顺序：
//   repository/retrieval_eval_run_impl.py:535  .order_by(stage_key, source_key)   ← 宏观统计
//   repository/retrieval_eval_run_impl.py:422  .order_by(stage_key, source_key)   ← 单 case trace
// 于是页面上的阶段顺序是「cutter, filter, fusioner, recall, recall.dense_vector,
// recall.keyword, reranker」—— 这**是排序产物，不是流水线**。
//
// 真实执行顺序（`app/services/document/retrieve/processor.py` 的 `RetrieveProcessor.run`）：
//   recall.<route> (多路并行，见 trace.py:observe_recall)   ← 先召回，产出 result_sets
//   → fusioner   (processor.py:276  _stage_log("fusioner"))
//   → filter     (processor.py:295  _stage_log("filter"))
//   → reranker   (processor.py:325  _stage_log("reranker"))
//   → cutter     (processor.py:346  _stage_log("cutter"))
// 后端注释也是这么写的：那四段「全部发生在召回**之后**」
// （domain/schemas/retrieve.py:222）。
//
// ⚠️ 曾经踩过：有人看着分析页的字母序，以为真实执行顺序是
// 「cutter → filter → fusioner」，据此去改「发起跑测」抽屉里四张覆盖卡片的顺序 ——
// 那会把**本来正确的**顺序改错。抽屉里是 fusioner/filter/reranker/cutter，是对的。
// 所以顺序一律从这里取，别再凭某一页的观感去重排。

/** 阶段分组：数字越小越靠前。同组内保持后端给的相对顺序（sort 是稳定的）。 */
const RANK: Record<string, number> = {
  fusioner: 20,
  filter: 30,
  reranker: 40,
  cutter: 50,
};

/** 并行召回分支（`recall.dense_vector` 这类）统一排在最前。 */
const RECALL_BRANCH_RANK = 10;
/**
 * 裸 `recall`（source_key 为空）是**合成记录**，只装「所有路都没召回到的 gold」
 * （见 trace.py:observe_recall 末尾）—— 它必须等所有路都跑完才能判，
 * 所以排在分支**之后**。字母序恰好把它排在分支前面，这里纠正过来。
 */
const RECALL_SYNTHETIC_RANK = 11;

/** 认不出来的 stage_key 排到最后，不猜位置（保持后端相对顺序）。 */
const UNKNOWN_RANK = 1000;

export function stageRank(stageKey: string): number {
  if (stageKey === 'recall') return RECALL_SYNTHETIC_RANK;
  if (stageKey.startsWith('recall.')) return RECALL_BRANCH_RANK;
  return RANK[stageKey] ?? UNKNOWN_RANK;
}

/**
 * 按真实执行顺序排列阶段。
 *
 * 用 `Array.prototype.sort`（ES2019 起稳定）→ 同 rank 的元素保持入参顺序，
 * 所以同组内部仍然尊重后端返回的相对次序，只纠正**组间**顺序。
 */
export function sortStagesByExecution<T extends { stage_key: string }>(
  stages: T[] | undefined | null,
): T[] {
  if (!stages?.length) return [];
  return [...stages].sort(
    (a, b) => stageRank(a.stage_key) - stageRank(b.stage_key),
  );
}

/**
 * 四段「查询处理器覆盖」的执行顺序 —— 「发起跑测」抽屉里那四张卡片按它排。
 * 抽屉是**手写 JSX**（四张卡字段各不相同），没法从数组生成，
 * 所以这里只导出顺序常量供注释/校验引用，避免有人按字母重排。
 */
export const QUERY_PROCESSOR_ORDER = [
  'fusioner',
  'filter',
  'reranker',
  'cutter',
] as const;

// ============================================================
// ⚠️ 查询改写（`query_rewriter`，2026-10-16 新增）不在这张表里
// ============================================================
//
// 它**发生在召回之前**（改后的文本同时喂给 dense 的向量化与 keyword 的
// BM25，以及之后那四段），所以它在流水线上的位置是：
//
//     query_rewriter  →  recall.<route>  →  fusioner → filter → reranker → cutter
//     （不改写就没有这一步）
//
// 但它**不是**一个 trace 阶段，所以这里没有、也不该有它的 rank：
// 后端的改写发生在 `RetrieveProcessor.run` 之前
// （`document_retrieve_service_impl.py` 的 `_rewrite_query`），
// 它不产出"进多少 / 出多少条候选"，只产出**一句话**。因此它由响应上的
// `query_text` / `query_rewrite` 承载，而不是 `stages[]` 里的一项。
//
// 界面上对应两处，别去 stages 里找它：
//   · 逐题结果 / trace 抽屉的「实际查询」= 改后的那句话（`query_text`）；
//   · 阶梯表的「查询改写」列 = 这一轮用的是哪个改写器（快照里的参数）。
//
// 顺带：`QUERY_PROCESSOR_ORDER` 也刻意**不**把改写算作"第五段"——
// 契约里它是与 `retrieve_processor` **并列**的字段，不是塞在里面的段。
