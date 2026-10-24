// src/pages/retrieval_eval/service.ts
// 对接后端 /api/v1/retrieval-eval/**。
//
// 契约权威两份，按区域分管：
//   rag_eval_design/retrieval_eval_openapi.yaml   ← 设计契约（两端实现都对齐它）
//   app/api/v1/retrieval_eval.py                  ← 后端落地的 11 条路由
//
// 数据来源
// --------
//   数据集侧  bundles / generation-runs / cases / export   真接口
//   执行侧    runs / stage-stats / run cases / case trace   真接口
//
// 两侧都已接真：两个 `USE_MOCK_*` 开关现在都是 false，mock 只服务独立预览 demo
// （见 mockData.ts 头注释）。
//
// ⚠️ 唯一一条**没有**服务端来源的是「列出跑测」—— 契约与后端都只有
// `POST /runs` 与按 id 取详情。见 `listEvalRunHistory`。

import { request } from '@umijs/max';
import type {
  CreateEvalBundleAcceptedResponse,
  CreateEvalBundleRequest,
  CreateEvalRunAcceptedResponse,
  CreateEvalRunRequest,
  DocumentChunkText,
  DtdListSourceItem,
  DtdOption,
  EvalBundleDetail,
  EvalBundleExport,
  EvalBundleListResponse,
  EvalCaseListResponse,
  EvalCaseTraceResponse,
  EvalRunCaseListResponse,
  EvalRunDetail,
  GenerationRetryAcceptedResponse,
  GenerationRunDetail,
  ListBundleCasesParams,
  ListBundlesParams,
  ListRunCasesParams,
  StageStatsResponse,
} from './data';
import * as mock from './mockData';
import { USE_MOCK_BUNDLES, USE_MOCK_RUNS } from './mockData';
import { forgetEvalRun, getRememberedEvalRunIds } from './runRegistry';

const API_BASE = '/api/v1/retrieval-eval';

// ============================================================
// Retrieval Eval Bundles
// ============================================================

/** 创建 QA bundle 并启动生成运行。POST /retrieval-eval/bundles → 202 */
export async function createRetrievalEvalBundle(
  body: CreateEvalBundleRequest,
): Promise<CreateEvalBundleAcceptedResponse> {
  if (USE_MOCK_BUNDLES) return mock.createRetrievalEvalBundle(body);
  return request<CreateEvalBundleAcceptedResponse>(`${API_BASE}/bundles`, {
    method: 'POST',
    data: body,
  });
}

/** 列出 bundle（供评测选择器使用）。GET /retrieval-eval/bundles */
export async function listRetrievalEvalBundles(
  params: ListBundlesParams = {},
): Promise<EvalBundleListResponse> {
  if (USE_MOCK_BUNDLES) return mock.listRetrievalEvalBundles(params);
  return request<EvalBundleListResponse>(`${API_BASE}/bundles`, {
    method: 'GET',
    params,
  });
}

/** 获取 bundle 详情与生成配置快照。GET /retrieval-eval/bundles/{bundle_id} */
export async function getRetrievalEvalBundle(
  bundleId: string,
): Promise<EvalBundleDetail> {
  if (USE_MOCK_BUNDLES) return mock.getRetrievalEvalBundle(bundleId);
  return request<EvalBundleDetail>(`${API_BASE}/bundles/${bundleId}`, {
    method: 'GET',
  });
}

/** 预览 bundle 内的 QA 用例。GET /retrieval-eval/bundles/{bundle_id}/cases */
export async function listRetrievalEvalCases(
  bundleId: string,
  params: ListBundleCasesParams = {},
): Promise<EvalCaseListResponse> {
  if (USE_MOCK_BUNDLES) return mock.listRetrievalEvalCases(bundleId, params);
  return request<EvalCaseListResponse>(
    `${API_BASE}/bundles/${bundleId}/cases`,
    { method: 'GET', params },
  );
}

/**
 * 导出确定性 JSON 数据集。GET /retrieval-eval/bundles/{bundle_id}/export
 * 仅包含 validated 用例；bundle 未就绪时后端返回 **409**。
 */
export async function exportRetrievalEvalBundle(
  bundleId: string,
): Promise<EvalBundleExport> {
  if (USE_MOCK_BUNDLES) return mock.exportRetrievalEvalBundle(bundleId);
  return request<EvalBundleExport>(`${API_BASE}/bundles/${bundleId}/export`, {
    method: 'GET',
  });
}

// ============================================================
// Retrieval Eval Generation
// ============================================================

/** 获取生成进度与窗口错误。GET /retrieval-eval/generation-runs/{id} */
export async function getRetrievalEvalGenerationRun(
  generationRunId: string,
): Promise<GenerationRunDetail> {
  if (USE_MOCK_BUNDLES)
    return mock.getRetrievalEvalGenerationRun(generationRunId);
  return request<GenerationRunDetail>(
    `${API_BASE}/generation-runs/${generationRunId}`,
    { method: 'GET' },
  );
}

/**
 * 重试失败/未完成的生成窗口（幂等，不重复生成已验证用例）。
 * POST /retrieval-eval/generation-runs/{id}/retry-failed-windows → 202
 *
 * ⚠️ 实际覆盖范围比名字宽：`queued` 窗口也算（造题一次执行有窗口数上限，
 * 跑不完的留在 queued，再调一次是继续跑它们的唯一途径）。**没有可重试窗口时
 * 后端返回 409**，不是 200 + 0。
 */
export async function retryRetrievalEvalGenerationWindows(
  generationRunId: string,
): Promise<GenerationRetryAcceptedResponse> {
  if (USE_MOCK_BUNDLES)
    return mock.retryRetrievalEvalGenerationWindows(generationRunId);
  return request<GenerationRetryAcceptedResponse>(
    `${API_BASE}/generation-runs/${generationRunId}/retry-failed-windows`,
    { method: 'POST' },
  );
}

// ============================================================
// Retrieval Eval Runs（评测执行）
// ============================================================

/** 启动一次针对 bundle 的确定性检索跑测。POST /retrieval-eval/runs → 202 */
export async function createRetrievalEvalRun(
  body: CreateEvalRunRequest,
): Promise<CreateEvalRunAcceptedResponse> {
  if (USE_MOCK_RUNS) return mock.createRetrievalEvalRun(body);
  return request<CreateEvalRunAcceptedResponse>(`${API_BASE}/runs`, {
    method: 'POST',
    data: body,
  });
}

/** 获取跑测状态与基准指标。GET /retrieval-eval/runs/{eval_run_id} */
export async function getRetrievalEvalRun(
  evalRunId: string,
): Promise<EvalRunDetail> {
  if (USE_MOCK_RUNS) return mock.getRetrievalEvalRun(evalRunId);
  return request<EvalRunDetail>(`${API_BASE}/runs/${evalRunId}`, {
    method: 'GET',
  });
}

/** 获取 gold chunk 在各阶段被丢弃的宏观统计。GET /runs/{id}/stage-stats */
export async function getRetrievalEvalStageStats(
  evalRunId: string,
): Promise<StageStatsResponse> {
  if (USE_MOCK_RUNS) return mock.getRetrievalEvalStageStats(evalRunId);
  return request<StageStatsResponse>(
    `${API_BASE}/runs/${evalRunId}/stage-stats`,
    { method: 'GET' },
  );
}

/**
 * 获取单个 case 的分阶段 top 候选、分数与 gold 迁移。
 * GET /runs/{id}/cases/{cid}/trace
 *
 * ⚠️ `attemptNo` 是**可选但重要**：不传时后端给「代表行」那一轮（命中优先、
 * 再比名次）—— 与列表、表头指标同一条，所以三处显示的「这条 case 的结果」
 * 是一致的。要看某一轮的痕迹就传它，取值来自 `available_attempts`。
 * 逐轮放宽下第 1 轮与第 3 轮参数不同（第 3 轮才开精排），不指定轮次的
 * 痕迹很容易被读成「这条 case 的检索过程」。
 */
export async function getRetrievalEvalCaseTrace(
  evalRunId: string,
  evalCaseId: string,
  attemptNo?: number,
): Promise<EvalCaseTraceResponse> {
  if (USE_MOCK_RUNS)
    return mock.getRetrievalEvalCaseTrace(evalRunId, evalCaseId, attemptNo);
  return request<EvalCaseTraceResponse>(
    `${API_BASE}/runs/${evalRunId}/cases/${evalCaseId}/trace`,
    {
      method: 'GET',
      params: attemptNo ? { attempt_no: attemptNo } : undefined,
    },
  );
}

/** 获取逐题命中/未命中结果。GET /retrieval-eval/runs/{eval_run_id}/cases */
export async function listRetrievalEvalRunCases(
  evalRunId: string,
  params: ListRunCasesParams = {},
): Promise<EvalRunCaseListResponse> {
  if (USE_MOCK_RUNS) return mock.listRetrievalEvalRunCases(evalRunId, params);
  return request<EvalRunCaseListResponse>(
    `${API_BASE}/runs/${evalRunId}/cases`,
    { method: 'GET', params },
  );
}

// ============================================================
// 目标 chunk 的正文（来自既有 document-chunks 接口）
// ============================================================

const CHUNK_API = '/api/v1/document-chunks';

/**
 * 按 `document_chunk_id` 取一块 chunk 的正文。
 *
 * 用的是 `document_type_definition.yaml` 里那条通用端点
 * （`GET /document-chunks/{document_chunk_id}`），**不是** eval 自己的
 * 契约 —— trace 响应只给 `gold_chunk_ids`，正文得按 id 回查。
 *
 * 为什么不走 `/document-versions/{vid}/retrievals/{rid}/chunks`
 * ------------------------------------------------------------
 * 那个列表端点要先有 (版本, retrieval) 两个 id，而评测侧**根本没有**
 * 它们（`EvalRunCase` 里只有 `document_type_definition_id`）；而且它
 * 没有 chunk_id 过滤，找一块要翻页翻到底。单条端点则是"只要 id"。
 *
 * ⚠️ 不传 `preview_chars` = **全文**。这正是本调用需要的：抽屉里要能
 * 看完整的一块，"回查也是截断的"就没意义了（超长正文的折叠由前端做，
 * 见 `TargetChunkText`）。
 *
 * 404 = 这块取不到（id 打错，或它已随重跑被清掉）—— 调用方要把
 * 「取不到」与「正文为空」分开显示。
 */
export async function getDocumentChunk(
  documentChunkId: string,
): Promise<DocumentChunkText> {
  if (USE_MOCK_RUNS) return mock.getDocumentChunk(documentChunkId);
  return request<DocumentChunkText>(`${CHUNK_API}/${documentChunkId}`, {
    method: 'GET',
  });
}

// ============================================================
// 辅助：DTD 选项（来自既有 document-type-definitions 接口）
// ============================================================

const DTD_API = '/api/v1/document-type-definitions';

/**
 * 后端 `page_size` 硬上限（app/api/v1/document_definitions.py: `le=100`）。
 * 传 200 会**直接 422** —— 这不是"被截断"，是请求被拒。
 */
const DTD_PAGE_SIZE = 100;

/** 翻页上限：1000 个文档类型定义已经远超实际规模，防的是异常数据把页面拖死。 */
const DTD_MAX_PAGES = 10;

const toDtdOption = (d: DtdListSourceItem): DtdOption => ({
  document_type_definition_id: d.document_type_definition_id,
  type_key: d.type_key,
  name: d.name,
  modality_type: d.modality_type,
});

/**
 * DTD 下拉/标签数据源。真实模式下**逐页取全**（单页上限 100）。
 *
 * 返回的列表不含 `chunk_count`：真实 DTD 列表项没有这个字段，
 * UI 侧据此不显示计数（见 DtdOption 的注释）。
 *
 * ⚠️ 取的是 `include_deleted=false`（默认值）的活跃定义。若某个 bundle 覆盖的
 * DTD 后来被逻辑删除，它的标签会退化成短 UUID —— 这是刻意的：显示一个
 * 已删除类型的名字比显示"有个 id 我认不出来"更容易误导。
 */
export async function listDtdOptions(): Promise<{ items: DtdOption[] }> {
  if (USE_MOCK_BUNDLES) return mock.listDtdOptions();

  const items: DtdOption[] = [];
  for (let page = 1; page <= DTD_MAX_PAGES; page += 1) {
    const res = await request<{ items: DtdListSourceItem[]; total: number }>(
      DTD_API,
      { method: 'GET', params: { page, page_size: DTD_PAGE_SIZE } },
    );
    items.push(...res.items.map(toDtdOption));
    if (items.length >= res.total || res.items.length === 0) break;
  }
  return { items };
}

/**
 * 跑测列表（**本机视角**）。
 *
 * ⚠️ 契约里没有「列出跑测」这个端点 —— 后端 `retrieval_eval.py` 的 11 条路由里
 * 只有 `POST /runs` 与按 id 取详情。所以这里**没有服务端接口可调**，改为：
 * 读本机登记过的 run id（`runRegistry`），并发拉各自的详情。
 *
 * 三条约定：
 *   - 单个 id 拉不到（404：被删了、或换了库）→ **顺手忘掉它**，不留死记录；
 *   - 全失败而本来有 id → **抛错**，让页面显示"加载失败"。不能返回空数组 ——
 *     那会被读成"一条跑测都没有"，而实际是后端不可达，两者结论相反；
 *   - 按 `created_at` 倒序，最新的在最前。
 */
export async function listEvalRunHistory(): Promise<EvalRunDetail[]> {
  // 离线 demo：既没有后端，也没有「本机登记过的 id」（localStorage 是空的），
  // 所以直接给 mock 里那几条跑测，否则演示用的跑测列表永远是空的。
  if (USE_MOCK_RUNS) {
    return [...mock.listMockRuns()].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  }

  const ids = getRememberedEvalRunIds();
  if (ids.length === 0) return [];

  const settled = await Promise.allSettled(
    ids.map((id) => getRetrievalEvalRun(id)),
  );

  const runs: EvalRunDetail[] = [];
  let firstError: unknown = null;

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      runs.push(r.value);
      return;
    }
    forgetEvalRun(ids[i]);
    if (firstError === null) firstError = r.reason;
  });

  if (runs.length === 0 && firstError !== null) throw firstError;

  return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
