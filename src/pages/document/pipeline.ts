// src/pages/document/pipeline.ts
// 对接 YTraderHarness 后端 pipeline.yaml（Document Pipeline API，前缀 /api/v1）。
//
// 三层维度：
//   Document → DocumentVersion → PipelineRun（一次处理一条）→ PipelineNodeRun（节点行）
//
// 关键约定（来自 pipeline.yaml）：
//  - 渲染必须依据「该次运行自己的 topology_snapshot」，不能用前端写死的节点列表，
//    这是历史运行在图演进后仍能正确展示的唯一机制。
//  - node_id 是稳定契约键，node_label 在写入时冻结；目录查不到时用 node_label 兜底。
//  - 扇出阶段（chunking / chunk_enrichment / embedding / indexing）每个 retrieval
//    各产生一行，用 branch_key（= retrieval id）区分。
//  - NodeRunStatus 的 skipped 表示被条件边跳过，不计入进度分母。
//  - progress_percent = completed / (total - skipped) × 100，分母在扇出展开时会变。
//
// 取数分工（别用错接口）：
//   getPipelineRun          全量详情（含全部节点行），只在「进入页面 / 切版本 / 终态收敛」时调
//   getPipelineRunProgress  轻量进度，**轮询专用**，2 秒一次
//   getDocumentVersionProgress  业务状态（version_status / processing_status），终态时调
import { request } from '@umijs/max';

import type { ProcessingStatus, VersionStatus } from './data';

const API_BASE = '/api/v1';

/** 执行状态（观测层）。partial 表示多路 retrieval 部分成功。 */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'cancelled';

/** 单个节点单次尝试的执行状态。skipped 不计入分母。 */
export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export type NodeGroup = 'linear' | 'fanout' | 'control';

export interface PipelineNodeCatalogEntry {
  node_id: string;
  label: string;
  group: NodeGroup;
  /** 拓扑序号，冻结的历史值，不要假设连续。 */
  sequence: number;
  description?: string;
  deprecated?: boolean;
  replaced_by?: string | null;
}

export interface PipelineNodeCatalogResponse {
  graph_name: string;
  graph_version: string;
  topology_fingerprint: string;
  nodes: PipelineNodeCatalogEntry[];
}

/** 运行拓扑快照里的节点（冻结于运行开始时）。 */
export interface TopologyNode {
  node_id: string;
  label: string;
  group: NodeGroup;
  sequence: number;
}

export interface PipelineNodeRunResponse {
  pipeline_node_run_id: string;
  pipeline_run_id: string;
  node_id: string;
  node_label: string;
  node_group: NodeGroup;
  sequence: number;
  document_retrieval_definition_id: string | null;
  /** 线性 / 控制节点为空串，扇出为 retrieval id。 */
  branch_key: string;
  /** 重试计数，1 起。取该 (node_id, branch_key) 下最大的那一行。 */
  attempt: number;
  status: NodeRunStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  input_summary: Record<string, any> | null;
  output_summary: Record<string, any> | null;
  metrics: Record<string, any> | null;
  error_type: string | null;
  error_message: string | null;
}

export interface PipelineRunResponse {
  pipeline_run_id: string;
  document_id: string;
  document_version_id: string;
  document_type_definition_id: string;
  trigger_source: string;
  triggered_by: string | null;
  parent_pipeline_run_id: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  resumed_from_checkpoint_id: string | null;
  error_type: string | null;
  error_node_id: string | null;
  error_message: string | null;
  node_count: number;
  failed_node_count: number;
  created_at: string;
}

export interface PipelineRunDetailResponse extends PipelineRunResponse {
  graph_name: string;
  graph_version: string;
  topology_fingerprint: string;
  topology_snapshot: {
    nodes?: TopologyNode[];
    edges?: [string, string][];
    [key: string]: any;
  };
  run_config: Record<string, any>;
  nodes: PipelineNodeRunResponse[];
  /** 该次运行的拓扑里有节点不在当前目录中 → 应提示「此运行使用旧版流水线」。 */
  unknown_nodes: boolean;
}

export interface PipelineRunListResponse {
  items: PipelineRunResponse[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface PipelineNodeRunListResponse {
  items: PipelineNodeRunResponse[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

// ============================================================
// 进度（业务视角，专供轮询）
// ============================================================

/**
 * 运行的轻量进度摘要。对应 PipelineRunProgressResponse，约 100 字节量级。
 *
 * 这是 pipeline.yaml 明确指定的**轮询专用**接口：只给计数、百分比与当前节点，
 * 不含节点行。秒级轮询不会把网络和序列化打满。
 */
export interface PipelineRunProgressResponse {
  pipeline_run_id: string;
  document_version_id: string;
  status: RunStatus;
  /** completed / (total - skipped) × 100，0~100。 */
  progress_percent: number;
  /** 计划步骤数（含扇出展开后的分支）。 */
  total_steps: number;
  completed_steps: number;
  failed_steps: number;
  /** 被条件边跳过、**不计入分母**的步骤数。 */
  skipped_steps: number;
  /** 仅在 status=running 时有值，前端据此显示「正在做什么」。 */
  running_node_id: string | null;
  running_node_label: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_node_id: string | null;
  error_message: string | null;
}

/** 本次处理的文件前处理定义。**只有一个** —— 一个文件按后缀只绑一个。 */
export interface ProcessorProgress {
  document_processor_definition_id: string | null;
  loader_name: string | null;
  processor_name: string | null;
  file_extension: string | null;
  processing_status: ProcessingStatus;
}

/** 一路 retrieval 的处理结果，一个版本有 N 个（扇出）。 */
export interface RetrievalProgressItem {
  document_retrieval_definition_id: string;
  retrieval_type?: string;
  chunker_name: string | null;
  retriever_name: string | null;
  storage_backend?: string;
  document_index_binding_id: string | null;
  /** 实际写入的索引实例标识；PostgreSQL 这类无独立索引的为空。 */
  index_identifier: string | null;
  processing_status: ProcessingStatus;
  error_message: string | null;
  /** 取自最近一次运行的节点指标。 */
  chunk_count: number | null;
  token_count: number | null;
  duration_ms: number | null;
  updated_at: string | null;
}

/**
 * 版本级处理进度。对应 DocumentVersionProgressResponse，进度页的核心响应。
 *
 * 三层信息：业务层 version_status / processing_status、执行层 latest_run、
 * 拆解层 processor（1 个）+ retrievals（N 个）。
 *
 * 终态时用它拿权威业务状态 —— 因为 /pipeline-runs/{id}/progress 只有执行层数据。
 */
export interface DocumentVersionProgressResponse {
  document_version_id: string;
  document_id: string;
  version_number: number;
  /** 生命周期状态。注意后端当前只在建版本时写 active，流水线不改它。 */
  version_status: VersionStatus;
  /** 由该版本全部 retrieval 的绑定状态聚合而来，这才是会随流水线变化的状态。 */
  processing_status: ProcessingStatus;
  /** 与最近一次运行的 progress_percent 一致；尚无运行时为 0。 */
  progress_percent: number;
  processor: ProcessorProgress | null;
  retrievals: RetrievalProgressItem[];
  /** 最近一次运行；尚无运行时为 null。与 PipelineRunProgressResponse 同构。 */
  latest_run: PipelineRunProgressResponse | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
}

// ============================================================
// Service
// ============================================================

/**
 * 节点目录。node_id → label/group/sequence 的契约表。
 * 目录几乎不变，页面级缓存一次即可。
 */
export async function getPipelineNodeCatalog() {
  return request<PipelineNodeCatalogResponse>(
    `${API_BASE}/document-pipeline-nodes`,
    { method: 'GET' },
  );
}

/** 按 node_id 查单个节点（解析"不认识的 node_id"用）。 */
export async function getPipelineNode(nodeId: string) {
  return request<PipelineNodeCatalogEntry>(
    `${API_BASE}/document-pipeline-nodes/${nodeId}`,
    { method: 'GET' },
  );
}

/** 某个版本的运行历史，按开始时间倒序（items[0] 即最近一次）。 */
export async function listVersionPipelineRuns(
  documentId: string,
  documentVersionId: string,
  params: { status?: RunStatus; page?: number; page_size?: number } = {},
) {
  return request<PipelineRunListResponse>(
    `${API_BASE}/documents/${documentId}/versions/${documentVersionId}/pipeline-runs`,
    { method: 'GET', params },
  );
}

/**
 * 运行详情：run 行 + 全部节点行 + 该次运行的拓扑快照。
 *
 * 只有它带节点行，所以「哪些节点已经完成」以它为准；
 * 但也因此响应可能很大 —— **不要用它做秒级轮询**，轮询走 getPipelineRunProgress。
 */
export async function getPipelineRun(pipelineRunId: string) {
  return request<PipelineRunDetailResponse>(
    `${API_BASE}/pipeline-runs/${pipelineRunId}`,
    { method: 'GET' },
  );
}

/** 节点行分页（详情接口已一次返回全部，扇出很多时可改用本接口）。 */
export async function listPipelineNodeRuns(
  pipelineRunId: string,
  params: { page?: number; page_size?: number } = {},
) {
  return request<PipelineNodeRunListResponse>(
    `${API_BASE}/pipeline-runs/${pipelineRunId}/nodes`,
    { method: 'GET', params },
  );
}

/**
 * 运行的轻量进度摘要 —— **轮询就用它**，不要用 getPipelineRun。
 * 后者返回全部节点行（扇出后可能几十行），做秒级轮询过重。
 *
 * skipErrorHandler：轮询请求失败（含接口未就绪的 404）不能弹全局错误提示，
 * 否则 2 秒一条会刷屏。失败由调用方自己静默降级。
 */
export async function getPipelineRunProgress(pipelineRunId: string) {
  return request<PipelineRunProgressResponse>(
    `${API_BASE}/pipeline-runs/${pipelineRunId}/progress`,
    { method: 'GET', skipErrorHandler: true },
  );
}

/**
 * 版本级处理进度：一次拿到 version_status + processing_status + 最近一次运行。
 * 终态时用它同步「版本状态」列（run progress 不含业务状态）。
 */
export async function getDocumentVersionProgress(documentVersionId: string) {
  return request<DocumentVersionProgressResponse>(
    `${API_BASE}/document-versions/${documentVersionId}/progress`,
    { method: 'GET', skipErrorHandler: true },
  );
}

/**
 * 重新处理某个版本。202 + job_id（job_id 就是本次运行的 pipeline_run_id）。
 * 仅登记调度，实际触发在事务提交后。
 *
 * 注：UI 入口（「重跑」按钮）本轮未接，先把契约封好。
 */
export async function reprocessDocumentVersion(
  documentVersionId: string,
  body: {
    document_processor_definition_ids?: string[];
    force?: boolean;
  } = {},
) {
  return request<{
    document_version_id: string;
    status: string;
    job_id: string | null;
    message?: string;
  }>(`${API_BASE}/document-versions/${documentVersionId}/reprocess`, {
    method: 'POST',
    data: body,
  });
}

// ============================================================
// 目录缓存
// ============================================================

let catalogPromise: Promise<PipelineNodeCatalogResponse> | null = null;

/** 拉取并缓存节点目录（进程内只请求一次）。 */
export function fetchNodeCatalog() {
  if (!catalogPromise) {
    catalogPromise = getPipelineNodeCatalog().catch((error) => {
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

// ============================================================
// 视图模型：按 node_id 聚合出横向 Steps 需要的结构
// ============================================================

export interface TimelineBranch {
  key: string;
  /** retrieval_type（能从 pipeline_config 映射到时）或 retrieval id 短码。 */
  label: string;
  status: NodeRunStatus;
  durationMs: number | null;
  chunkCount: number | null;
  tokenCount: number | null;
  errorMessage: string | null;
  /** 以下四项直接取自原始节点行，接口未返回时为 null（UI 显示空态，不编造）。 */
  inputSummary: Record<string, any> | null;
  outputSummary: Record<string, any> | null;
  metrics: Record<string, any> | null;
  errorType: string | null;
  attempt: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TimelineNode {
  nodeId: string;
  /** 优先取该行冻结的 node_label，其次目录 label，最后 node_id。 */
  label: string;
  group: NodeGroup;
  sequence: number;
  /** 该 node_id 下所有分支的聚合状态。 */
  state: NodeRunStatus;
  /** 扇出分支明细（线性 / 控制节点为空数组）。 */
  branches: TimelineBranch[];
  durationMs: number | null;
  errorMessage: string | null;
  /** 节点已不在当前图中（历史运行可能仍有它的行）。 */
  deprecated: boolean;
  /** 目录里查不到该 node_id。 */
  unknown: boolean;
  description?: string;
  /** output_summary.preview（≤512 字符），用于快速确认这一步的产出。 */
  preview: string | null;
  /** 该节点所有分支的 chunk_count / token_count 汇总。 */
  chunkCount: number | null;
  tokenCount: number | null;
  /**
   * 原始节点行：linear / control 一行，fanout 一路一行。
   * 详情抽屉的「执行明细」靠它回溯 input_summary / output_summary / metrics ——
   * getPipelineRun 已经把这些行带回来了，聚合时保留即可，不需要新接口。
   */
  rows: PipelineNodeRunResponse[];
  /** 该节点下最大的 attempt（>1 即发生过重试）。 */
  attempt: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorType: string | null;
}

export interface TimelineModel {
  nodes: TimelineNode[];
  /** completed / (planned - skipped) × 100。 */
  percent: number;
  /** 计划步骤数（含扇出展开后的分支）。 */
  plannedSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  /** 扇出的 retrieval 路数 N。 */
  branchCount: number;
  /** 扇出是否已展开（展开后分母由 7 变为 7 + 4N）。 */
  expanded: boolean;
  /** 分母跳变的提示文案，无跳变时为 null。 */
  jumpHint: string | null;
  run: PipelineRunResponse | null;
  runStatus: RunStatus | null;
  unknownNodes: boolean;
  graphVersion: string | null;
  triggerSource: string | null;
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const shortId = (id?: string | null) => (id ? `${id.slice(0, 8)}…` : '—');

/** 同一 (node_id, branch_key) 只保留 attempt 最大的那一行。 */
function dedupeAttempts(rows: PipelineNodeRunResponse[]) {
  const latest = new Map<string, PipelineNodeRunResponse>();
  for (const row of rows) {
    const key = `${row.node_id}|${row.branch_key}`;
    const previous = latest.get(key);
    if (!previous || row.attempt > previous.attempt) latest.set(key, row);
  }
  return [...latest.values()];
}

/** 节点顺序：优先该次运行的拓扑快照，其次节点行，最后目录。 */
function resolveNodeOrder(
  runDetail: PipelineRunDetailResponse | null,
  catalog: PipelineNodeCatalogResponse | null,
) {
  const bySequence = (a: { sequence: number }, b: { sequence: number }) =>
    a.sequence - b.sequence;

  const snapshot = runDetail?.topology_snapshot?.nodes;
  if (Array.isArray(snapshot) && snapshot.length > 0) {
    return [...snapshot].sort(bySequence).map((node) => ({
      node_id: node.node_id,
      label: node.label,
      group: node.group,
      sequence: node.sequence,
    }));
  }

  const rows = dedupeAttempts(runDetail?.nodes ?? []);
  if (rows.length > 0) {
    const seen = new Map<
      string,
      { node_id: string; label: string; group: NodeGroup; sequence: number }
    >();
    for (const row of rows) {
      if (seen.has(row.node_id)) continue;
      seen.set(row.node_id, {
        node_id: row.node_id,
        label: row.node_label,
        group: row.node_group,
        sequence: row.sequence,
      });
    }
    return [...seen.values()].sort(bySequence);
  }

  return (catalog?.nodes ?? [])
    .filter((node) => !node.deprecated)
    .sort(bySequence)
    .map((node) => ({
      node_id: node.node_id,
      label: node.label,
      group: node.group,
      sequence: node.sequence,
    }));
}

/** 扇出分支的聚合：任一 failed 即 failed，任一 running 即 running；
 *  全部 completed/skipped 时，只要有一个 completed 就算 completed（skipped 视作已通过）。 */
function aggregateState(states: NodeRunStatus[]): NodeRunStatus {
  if (states.length === 0) return 'pending';
  if (states.some((state) => state === 'failed')) return 'failed';
  if (states.some((state) => state === 'running')) return 'running';
  if (states.every((state) => state === 'completed' || state === 'skipped')) {
    return states.some((state) => state === 'completed')
      ? 'completed'
      : 'skipped';
  }
  return 'pending';
}

/**
 * 把「运行详情 + 节点目录」聚合成横向 Steps 需要的模型。
 *
 * @param runDetail 该版本最近一次运行的详情；无运行时传 null
 * @param catalog   节点目录（用于 label 兜底与 deprecated 标记）
 * @param retrievalLabels retrieval id → retrieval_type，用于扇出分支的可读命名
 */
export function buildTimeline(
  runDetail: PipelineRunDetailResponse | null,
  catalog: PipelineNodeCatalogResponse | null,
  retrievalLabels: Record<string, string> = {},
): TimelineModel {
  const catalogMap = new Map<string, PipelineNodeCatalogEntry>();
  for (const entry of catalog?.nodes ?? [])
    catalogMap.set(entry.node_id, entry);

  const rows = dedupeAttempts(runDetail?.nodes ?? []);
  const rowsByNode = new Map<string, PipelineNodeRunResponse[]>();
  for (const row of rows) {
    const list = rowsByNode.get(row.node_id);
    if (list) list.push(row);
    else rowsByNode.set(row.node_id, [row]);
  }

  const nodes: TimelineNode[] = resolveNodeOrder(runDetail, catalog).map(
    (spec) => {
      const nodeRows = rowsByNode.get(spec.node_id) ?? [];
      const entry = catalogMap.get(spec.node_id);

      const branches: TimelineBranch[] = nodeRows.map((row) => ({
        key: row.branch_key || row.pipeline_node_run_id,
        label:
          retrievalLabels[row.document_retrieval_definition_id ?? ''] ??
          shortId(row.document_retrieval_definition_id || row.branch_key),
        status: row.status,
        durationMs: row.duration_ms,
        chunkCount: asNumber(row.metrics?.chunk_count),
        tokenCount: asNumber(row.metrics?.token_count),
        errorMessage: row.error_message,
        inputSummary: row.input_summary ?? null,
        outputSummary: row.output_summary ?? null,
        metrics: row.metrics ?? null,
        errorType: row.error_type ?? null,
        attempt: row.attempt ?? null,
        startedAt: row.started_at ?? null,
        finishedAt: row.finished_at ?? null,
      }));

      const durationSum = nodeRows.reduce(
        (sum, row) => sum + (row.duration_ms ?? 0),
        0,
      );
      const chunkSum = nodeRows.reduce(
        (sum, row) => sum + (asNumber(row.metrics?.chunk_count) ?? 0),
        0,
      );
      const tokenSum = nodeRows.reduce(
        (sum, row) => sum + (asNumber(row.metrics?.token_count) ?? 0),
        0,
      );
      const preview = nodeRows
        .map((row) => row.output_summary?.preview)
        .find((value): value is string => typeof value === 'string' && !!value);

      // 起止时间取该节点所有行的极值：整个节点从最早一行开始、到最后一行结束
      const startedList = nodeRows
        .map((row) => row.started_at)
        .filter(
          (value): value is string => typeof value === 'string' && !!value,
        )
        .sort();
      const finishedList = nodeRows
        .map((row) => row.finished_at)
        .filter(
          (value): value is string => typeof value === 'string' && !!value,
        )
        .sort();
      const maxAttempt = nodeRows.reduce(
        (max, row) => Math.max(max, row.attempt ?? 1),
        1,
      );

      return {
        nodeId: spec.node_id,
        label:
          nodeRows[0]?.node_label || spec.label || entry?.label || spec.node_id,
        group: spec.group,
        sequence: spec.sequence,
        state: aggregateState(nodeRows.map((row) => row.status)),
        branches: spec.group === 'fanout' ? branches : [],
        durationMs: durationSum > 0 ? durationSum : null,
        errorMessage:
          nodeRows.find((row) => row.error_message)?.error_message ?? null,
        deprecated: Boolean(entry?.deprecated),
        unknown: !entry,
        description: entry?.description,
        preview: preview ?? null,
        chunkCount: chunkSum > 0 ? chunkSum : null,
        tokenCount: tokenSum > 0 ? tokenSum : null,
        rows: nodeRows,
        attempt: nodeRows.length > 0 ? maxAttempt : null,
        startedAt: startedList[0] ?? null,
        finishedAt: finishedList[finishedList.length - 1] ?? null,
        errorType: nodeRows.find((row) => row.error_type)?.error_type ?? null,
      };
    },
  );

  // 进度分母：线性 + 控制节点恒在计划内；扇出分支只有在展开后才计入
  const plannedLinearControl = nodes.filter(
    (node) => node.group !== 'fanout',
  ).length;
  const fanoutRows = rows.filter((row) => row.node_group === 'fanout');
  const plannedSteps = plannedLinearControl + fanoutRows.length;
  const completedSteps = rows.filter(
    (row) => row.status === 'completed',
  ).length;
  const failedSteps = rows.filter((row) => row.status === 'failed').length;
  const skippedSteps = rows.filter((row) => row.status === 'skipped').length;
  const denominator = plannedSteps - skippedSteps;
  const percent =
    denominator > 0 ? Math.round((completedSteps / denominator) * 100) : 0;

  const branchKeys = new Set(
    fanoutRows.map((row) => row.branch_key).filter(Boolean),
  );
  const branchCount = branchKeys.size;
  const expanded = branchCount > 0;

  return {
    nodes,
    percent,
    plannedSteps,
    completedSteps,
    failedSteps,
    skippedSteps,
    branchCount,
    expanded,
    jumpHint:
      expanded && runDetail?.status === 'running'
        ? `已展开 ${branchCount} 路检索分支，计划步骤由 ${plannedLinearControl} 变为 ${plannedSteps}，百分比回落属正常`
        : null,
    run: runDetail ?? null,
    runStatus: runDetail?.status ?? null,
    unknownNodes: Boolean(runDetail?.unknown_nodes),
    graphVersion: runDetail?.graph_version ?? catalog?.graph_version ?? null,
    triggerSource: runDetail?.trigger_source ?? null,
  };
}

/** 终态：这些状态下运行不会再变化，可以停止轮询。 */
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'failed',
  'partial',
  'cancelled',
]);

/** 运行是否已进入终态。null（尚无运行）不算终态，但要区分处理。 */
export function isTerminalRunStatus(
  status: RunStatus | null | undefined,
): boolean {
  return status != null && TERMINAL_RUN_STATUSES.has(status);
}

/**
 * 由运行状态推导处理状态（processing_status）。
 *
 * 这是后端 `PipelineRunRepository.map_to_business_status` 的**同款映射**
 * （RUNNING→processing，COMPLETED→completed，
 *  FAILED/PARTIAL/CANCELLED→failed，其余 pending）。
 *
 * **只作兜底**：version progress 接口不可用时，前端用它让「处理状态」标签
 * 先动起来；接口可用后一律以它返回的 processing_status 为准（权威值）。
 * 没有运行记录时返回 null，UI 不显示标签。
 */
export function deriveProcessingStatus(
  status: RunStatus | null | undefined,
): ProcessingStatus | null {
  if (status == null) return null;
  if (status === 'running') return 'processing';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'partial' || status === 'cancelled') {
    return 'failed';
  }
  return 'pending';
}

/**
 * 把轻量 progress 叠加到「由全量详情算出的 TimelineModel」上。
 *
 * 为什么需要它：轮询期间手上只有 progress（没有节点行），
 * 但进度条、计数、「正在做什么」都必须实时。职责这样切：
 *
 *  - **计数 / 百分比 / 运行态** 一律采用 progress —— 它本身就是权威口径，
 *    且已经做了 skipped 分母修正，比前端再算一遍更可靠；
 *  - **节点状态** 沿用详情快照，只把 running_node_id 指向的节点置为 running；
 *    其余节点由「详情重取」负责推进（见 detail.tsx 的轮询逻辑）。
 *    刻意不在前端按序号推「前面的都完成了」——那是猜，不是事实。
 *
 * 纯函数：同样的 (base, progress) 永远得到同样结果，可安全放进 useMemo。
 */
export function applyRunProgress(
  base: TimelineModel,
  progress: PipelineRunProgressResponse | null,
): TimelineModel {
  if (!progress) return base;

  const runningId = progress.running_node_id;
  const nodes = base.nodes.map((node) => {
    if (runningId && node.nodeId === runningId) {
      return { ...node, state: 'running' as NodeRunStatus };
    }
    // progress 说没有节点在跑，但快照里还挂着 running：该节点已经不在执行，
    // 交回 pending 等详情重取给准确值，免得圆点永远转圈。
    if (!runningId && node.state === 'running') {
      return { ...node, state: 'pending' as NodeRunStatus };
    }
    return node;
  });

  // 线性 + 控制节点数即「扇出展开前」的分母（当前图 = 7）。
  const baselineSteps = nodes.filter((node) => node.group !== 'fanout').length;
  const expanded = baselineSteps > 0 && progress.total_steps > baselineSteps;

  return {
    ...base,
    nodes,
    percent: Math.round(progress.progress_percent),
    plannedSteps: progress.total_steps,
    completedSteps: progress.completed_steps,
    failedSteps: progress.failed_steps,
    skippedSteps: progress.skipped_steps,
    expanded,
    jumpHint:
      expanded && progress.status === 'running'
        ? `扇出分支任务已展开，计划步骤由 ${baselineSteps} 变为 ${progress.total_steps}，百分比回落属正常`
        : null,
    run: base.run ? { ...base.run, status: progress.status } : null,
    runStatus: progress.status,
  };
}

/** 运行状态 → 展示文案。 */
export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  pending: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  partial: '部分成功',
  cancelled: '已取消',
};

/** 节点状态 → 展示文案。 */
export const NODE_STATUS_TEXT: Record<NodeRunStatus, string> = {
  pending: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

/** 触发来源 → 展示文案。 */
export const TRIGGER_SOURCE_TEXT: Record<string, string> = {
  create_document: '创建文档',
  update_document: '上传新版本',
  reprocess: '重新处理',
  resume: '续跑',
  retry: '重试',
  manual: '手动触发',
};
