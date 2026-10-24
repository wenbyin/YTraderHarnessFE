// src/pages/document/detail.test.tsx
//
// 版本列表「重新生成」按钮（POST /document-versions/{vid}/reprocess）的接线条测试。
//
// 钉住四件事 —— 都是"看起来能跑、其实静默失效"的那一类：
//
//   1. 点击 → 用**该行**的 document_version_id 调 reprocess（不是当前选中版本）；
//   2. 提交前先取「点击前的最新运行」：新运行要靠 runId **变了**才认得出来；
//   3. ⭐ **重跑一个已有运行的版本**时，新的一跑登记后必须自动接管并开始轮询
//      **新 runId**。反例（曾经的写法"只判 runId 非空"）：点击瞬间 runId 就非空
//      （指着上一跑），于是当场认定"新运行到了"，接着轮询上一跑 —— 它是终态，
//      isPolling=false，一次请求都不发，页面永远停在旧结果。
//   4. ⭐ 同一版本**第二跑**跑完仍要同步业务状态与【当前】标签。终态收敛按
//      `${vid}|${runStatus}` 去重，新一跑跑完时 key 与上一跑**字面相同**，
//      不把去重键清掉就再也不会同步（版本状态/处理状态停在旧值，刷新页面才好）。
//
// 不测的：Popconfirm 的动画、Table 的分页与横向滚动（antd 自己的行为）。

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DocumentDetailResponse,
  DocumentVersionDetailResponse,
  DocumentVersionSummary,
  ProcessingStatus,
} from './data';
import type {
  DocumentVersionProgressResponse,
  PipelineRunDetailResponse,
  PipelineRunListResponse,
  PipelineRunProgressResponse,
  PipelineRunResponse,
  RunStatus,
} from './pipeline';

const DOC_ID = 'doc-1';
const V1 = 'ver-1';
const RUN_1 = 'run-1';
const RUN_2 = 'run-2';

// ============================================================
// 桩数据
// ============================================================

const versionSummary = (
  over: Partial<DocumentVersionSummary> = {},
): DocumentVersionSummary => ({
  document_version_id: V1,
  document_id: DOC_ID,
  version_number: 1,
  file_id: 'file-1',
  document_processor_definition_id: null,
  version_status: 'active',
  is_current: true,
  created_at: '2026-10-14T04:10:52Z',
  meta_data: {},
  ...over,
});

/** 当前生效版本。可变 —— 「设为当前版本」等用例会改它。 */
let versions: DocumentVersionSummary[] = [versionSummary()];

const detailResponse = (
  list: DocumentVersionSummary[] = versions,
): DocumentDetailResponse => ({
  document_id: DOC_ID,
  document_type_definition_id: 'dtd-1',
  tenant_id: 'tenant-1',
  document_key: '000428.SZ',
  title: '上市公司事件',
  // 与后端同款口径：current 由 current_document_version_id 比对得到
  current_document_version_id:
    list.find((item) => item.is_current)?.document_version_id ?? null,
  status: 'active',
  metadata: {},
  created_by: null,
  created_at: '2026-10-14T04:10:52Z',
  updated_at: '2026-10-14T04:10:52Z',
  deleted_at: null,
  current_document_version: list.find((item) => item.is_current) ?? null,
  versions: list,
});

const versionDetail = (): DocumentVersionDetailResponse => ({
  ...versionSummary(),
  pipeline_config: { retrievals: [] },
  updated_at: null,
});

const runResponse = (
  pipelineRunId: string,
  status: RunStatus,
  triggerSource = 'create_document',
): PipelineRunResponse => ({
  pipeline_run_id: pipelineRunId,
  document_id: DOC_ID,
  document_version_id: V1,
  document_type_definition_id: 'dtd-1',
  trigger_source: triggerSource,
  triggered_by: null,
  parent_pipeline_run_id: null,
  status,
  started_at: '2026-10-14T04:11:00Z',
  finished_at: status === 'completed' ? '2026-10-14T04:11:30Z' : null,
  duration_ms: null,
  resumed_from_checkpoint_id: null,
  error_type: null,
  error_node_id: null,
  error_message: null,
  node_count: 11,
  failed_node_count: 0,
  created_at: '2026-10-14T04:11:00Z',
});

const runDetail = (run: PipelineRunResponse): PipelineRunDetailResponse => ({
  ...run,
  graph_name: 'document_ingestion_pipeline',
  graph_version: '1.0.0',
  topology_fingerprint: 'fp-1',
  topology_snapshot: { nodes: [], edges: [] },
  run_config: {},
  nodes: [],
  unknown_nodes: false,
});

const runList = (items: PipelineRunResponse[]): PipelineRunListResponse => ({
  items,
  page: 1,
  page_size: items.length,
  total: items.length,
  total_pages: 1,
});

const progressResponse = (
  pipelineRunId: string,
  status: RunStatus,
): PipelineRunProgressResponse => ({
  pipeline_run_id: pipelineRunId,
  document_version_id: V1,
  status,
  progress_percent: status === 'completed' ? 100 : 0,
  total_steps: 11,
  completed_steps: status === 'completed' ? 11 : 0,
  failed_steps: 0,
  skipped_steps: 0,
  running_node_id: null,
  running_node_label: null,
  started_at: '2026-10-14T04:11:00Z',
  finished_at: null,
  duration_ms: null,
  error_node_id: null,
  error_message: null,
});

const versionProgressResponse = (
  status: ProcessingStatus,
): DocumentVersionProgressResponse => ({
  document_version_id: V1,
  document_id: DOC_ID,
  version_number: 1,
  version_status: 'active',
  processing_status: status,
  progress_percent: status === 'completed' ? 100 : 0,
  processor: null,
  retrievals: [],
  latest_run: null,
  started_at: null,
  completed_at: null,
  updated_at: null,
});

// ============================================================
// 可变状态（测试按需改，模拟后端随时间变化）
// ============================================================

/** 该版本的最新运行列表（倒序，items[0] 即最新）—— 复现后端排序口径。 */
let runsForVersion: PipelineRunResponse[] = [];
/** run id → 当前运行状态（轮询读它）。 */
let runStatusById: Record<string, RunStatus> = {};

/**
 * 模拟后端「异步登记」：武装之后，运行历史查到第 N 次才带出新的一跑。
 *
 * ⚠️ 为什么不能让新运行"立刻出现"：那样第一次轮询就拿到了新 runId，
 * 于是**旧写法（只判 runId 非空）也能通过** —— 这条测试就成了摆设。
 * reprocess 契约是"只登记一次调度"，运行行晚一拍才落库，必须把这个"晚"
 * 复现出来，才测得到"判据是 runId 变了、不是 runId 有没有"。
 */
let armNewRun: {
  run: PipelineRunResponse;
  afterCalls: number;
  calls: number;
} | null = null;

const registerNewRunLate = (run: PipelineRunResponse, afterCalls = 2) => {
  armNewRun = { run, afterCalls, calls: 0 };
};

// ============================================================
// 桩服务
// ============================================================

// vi.fn 显式写参数类型：否则 mock.calls[0] 被推成 []，取 [0] 会报类型错。
const getDocument = vi.fn(async (_documentId?: string) =>
  detailResponse(versions),
);
const getDocumentVersion = vi.fn(async (_documentId?: string, _vId?: string) =>
  versionDetail(),
);
const updateDocument = vi.fn(async (_documentId?: string, _body?: unknown) =>
  detailResponse(versions),
);
const listVersionPipelineRuns = vi.fn(
  async (_documentId?: string, _vId?: string, _params?: unknown) => {
    // 后端"晚一拍登记新运行"的替身：数到第 afterCalls 次查询才把它带出来
    if (armNewRun) {
      armNewRun.calls += 1;
      if (armNewRun.calls >= armNewRun.afterCalls) {
        const { run } = armNewRun;
        runsForVersion = [
          run,
          ...runsForVersion.filter(
            (r) => r.pipeline_run_id !== run.pipeline_run_id,
          ),
        ];
        runStatusById[run.pipeline_run_id] = run.status;
        armNewRun = null;
      }
    }
    return runList(runsForVersion);
  },
);
const getPipelineRun = vi.fn(async (pipelineRunId?: string) => {
  const run = runsForVersion.find((r) => r.pipeline_run_id === pipelineRunId);
  if (!run) throw new Error(`桩里没有运行 ${pipelineRunId}`);
  return runDetail(run);
});
const getPipelineRunProgress = vi.fn(async (pipelineRunId?: string) => {
  const id = pipelineRunId ?? '';
  return progressResponse(id, runStatusById[id] ?? 'running');
});
const getDocumentVersionProgress = vi.fn(async (_vId?: string) =>
  versionProgressResponse('processing'),
);
const reprocessDocumentVersion = vi.fn(
  async (
    _vId?: string,
  ): Promise<{
    document_version_id: string;
    status: ProcessingStatus;
    job_id: string | null;
    message?: string;
  }> => ({
    document_version_id: V1,
    status: 'processing',
    job_id: RUN_2,
  }),
);
const fetchNodeCatalog = vi.fn(async () => ({ nodes: [] }));
const clearRunStatusCache = vi.fn();

vi.mock('@umijs/max', () => ({
  useParams: () => ({ documentId: 'doc-1' }),
  Link: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock('@ant-design/pro-components', () => ({
  PageContainer: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('./service', () => ({
  getDocument: (...a: unknown[]) => getDocument(...(a as [])),
  getDocumentVersion: (...a: unknown[]) => getDocumentVersion(...(a as [])),
  updateDocument: (...a: unknown[]) => updateDocument(...(a as [])),
}));

vi.mock('./fileInfo', () => ({
  formatBytes: (size?: number) => `${size ?? 0} B`,
  useFileInfo: (_fileId?: string) => ({
    file: {
      file_id: 'file-1',
      file_name: '000428_大事提醒.md',
      file_size: 1024,
    },
    loading: false,
  }),
}));

vi.mock('./typeMap', () => ({
  typeLabel: () => '上市公司事件',
  useTypeMap: () => ({}),
}));

/**
 * 运行状态列的数据源。照抄真实 hook 的契约（按 versionIds 建 map +
 * **稳定的** setVersionRunStatus）—— 后者尤其重要：它进了 detail.tsx 那个
 * 「等新运行」effect 的依赖，如果每次渲染都换一个函数，interval 会被反复重建。
 */
vi.mock('./runStatus', () => ({
  clearRunStatusCache: (...a: unknown[]) => clearRunStatusCache(...(a as [])),
  useVersionRunStatuses: (_documentId?: string, versionIds: string[] = []) => {
    const [map, setMap] = React.useState<Record<string, RunStatus | null>>({});
    const key = versionIds.join(',');
    React.useEffect(() => {
      const next: Record<string, RunStatus | null> = {};
      for (const id of versionIds) next[id] = runsForVersion[0]?.status ?? null;
      setMap(next);
      // key 已覆盖 versionIds 的内容变化
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const setVersionRunStatus = React.useCallback(
      (versionId: string, status: RunStatus | null) =>
        setMap((prev) =>
          prev[versionId] === status ? prev : { ...prev, [versionId]: status },
        ),
      [],
    );
    return { runStatusMap: map, setVersionRunStatus };
  },
}));

vi.mock('./pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline')>();
  return {
    // 纯函数（isTerminalRunStatus / deriveProcessingStatus / RUN_STATUS_TEXT…）留真的
    ...actual,
    fetchNodeCatalog: (...a: unknown[]) => fetchNodeCatalog(...(a as [])),
    getDocumentVersionProgress: (...a: unknown[]) =>
      getDocumentVersionProgress(...(a as [])),
    getPipelineRun: (...a: unknown[]) => getPipelineRun(...(a as [])),
    getPipelineRunProgress: (...a: unknown[]) =>
      getPipelineRunProgress(...(a as [])),
    listVersionPipelineRuns: (...a: unknown[]) =>
      listVersionPipelineRuns(...(a as [])),
    reprocessDocumentVersion: (...a: unknown[]) =>
      reprocessDocumentVersion(...(a as [])),
    // 真 buildTimeline 要吃完整的节点行，这里只需要它把"这一跑的状态"透出来
    buildTimeline: (runDetailArg: PipelineRunDetailResponse | null) => ({
      nodes: [],
      percent: 0,
      plannedSteps: 0,
      completedSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
      branchCount: 0,
      expanded: false,
      jumpHint: null,
      run: runDetailArg,
      runStatus: runDetailArg?.status ?? null,
      unknownNodes: false,
      graphVersion: runDetailArg?.graph_version ?? null,
      triggerSource: runDetailArg?.trigger_source ?? null,
    }),
    // 进度叠加不是本次被测的交互，恒等返回即可（activeRunStatus 不经过它）
    applyRunProgress: (base: unknown) => base,
  };
});

vi.mock('./components/UploadVersionModal', () => ({
  default: () => <span data-stub="upload" />,
}));
vi.mock('./components/EditDocumentModal', () => ({
  default: () => <span data-stub="edit" />,
}));
vi.mock('./components/VersionDrawer', () => ({ default: () => null }));
vi.mock('./components/ProgressSteps', () => ({
  default: () => <span data-stub="steps" />,
}));

import DocumentDetailPage from './detail';

// ============================================================
// 工具
// ============================================================

/** 版本行里的「重新生成」链接（用 data-* 钩子找，不按"第几个 td"找）。 */
const reprocessLink = (versionId = V1) =>
  document.querySelector(`[data-reprocess="${versionId}"]`) as HTMLElement;

const rowOf = (versionId = V1) =>
  reprocessLink(versionId).closest('tr') as HTMLElement;

/** 点开 Popconfirm 再点确认 —— 确认按钮在 portal 里。 */
const clickReprocess = async (versionId = V1) => {
  fireEvent.click(reprocessLink(versionId));
  await waitFor(() =>
    expect(document.querySelector('.ant-popconfirm')).toBeTruthy(),
  );
  const ok = document.querySelector(
    '.ant-popconfirm-buttons .ant-btn-primary',
  ) as HTMLElement;
  expect(ok).toBeTruthy();
  fireEvent.click(ok);
};

const renderPage = () =>
  render(
    <App>
      <DocumentDetailPage />
    </App>,
  );

/** 等表格渲染出来（详情 + 版本行都在）。 */
const waitForTable = () =>
  waitFor(() => expect(reprocessLink()).toBeTruthy(), { timeout: 5000 });

beforeEach(() => {
  versions = [versionSummary()];
  runsForVersion = [runResponse(RUN_1, 'completed')];
  runStatusById = { [RUN_1]: 'completed' };
  armNewRun = null;

  vi.clearAllMocks();
  reprocessDocumentVersion.mockResolvedValue({
    document_version_id: V1,
    status: 'processing',
    job_id: RUN_2,
  });
});

afterEach(() => {
  cleanup();
});

// ============================================================
// 用例
// ============================================================

describe('版本列表 · 重新生成（reprocess）', () => {
  it('点击 → 用该行的 document_version_id 调 reprocess，并先记下"点击前的最新运行"', async () => {
    renderPage();
    await waitForTable();

    await clickReprocess();

    await waitFor(() =>
      expect(reprocessDocumentVersion).toHaveBeenCalledTimes(1),
    );
    expect(reprocessDocumentVersion).toHaveBeenCalledWith(V1);

    // page_size:1 的那次就是提交前的"上一跑"快照（另一个调用来自 loadTimelineBase，
    // 它要 page_size 20 拿运行历史）—— 别把两者混为一谈。
    const snapshotCall = listVersionPipelineRuns.mock.calls.find(
      (call) =>
        (call[2] as { page_size?: number } | undefined)?.page_size === 1,
    );
    expect(snapshotCall).toBeTruthy();
    expect(snapshotCall?.[1]).toBe(V1);
  });

  it('⭐ 新的一跑登记后自动接管：轮询打到**新** runId，而不是上一跑', async () => {
    renderPage();
    await waitForTable();

    // 提交前：只有上一跑（已完成）
    expect(runsForVersion.map((r) => r.pipeline_run_id)).toEqual([RUN_1]);

    await clickReprocess();
    await waitFor(() =>
      expect(reprocessDocumentVersion).toHaveBeenCalledTimes(1),
    );

    // 后端晚一拍才把新运行登记进来（第一次轮询还查不到）
    registerNewRunLate(runResponse(RUN_2, 'running', 'reprocess'));

    // 等「等新运行」的循环跨过"第一次查不到"那一拍，把新 runId 认出来并开始轮询
    await waitFor(
      () => expect(getPipelineRunProgress).toHaveBeenCalledWith(RUN_2),
      { timeout: 10000 },
    );
    // 反例断言：绝不能拿上一跑去轮询（旧写法就会停在这里，一次请求都不发）
    const polledRunIds = getPipelineRunProgress.mock.calls.map((c) => c[0]);
    expect(polledRunIds).not.toContain(RUN_1);

    // 行上的「运行状态」也跟着新的一跑走
    await waitFor(() => expect(rowOf().textContent).toContain('运行中'));
  }, 25000);

  it('⭐ 同一版本第二跑跑完仍要同步业务状态（去重键必须清掉）', async () => {
    renderPage();
    await waitForTable();

    // 首屏那一跑已是终态 → 收敛同步一次
    await waitFor(
      () => expect(getDocumentVersionProgress).toHaveBeenCalledTimes(1),
      { timeout: 5000 },
    );

    await clickReprocess();
    await waitFor(() =>
      expect(reprocessDocumentVersion).toHaveBeenCalledTimes(1),
    );

    registerNewRunLate(runResponse(RUN_2, 'running', 'reprocess'));
    await waitFor(
      () => expect(getPipelineRunProgress).toHaveBeenCalledWith(RUN_2),
      { timeout: 10000 },
    );

    // 第二跑跑完 —— runStatus 字面上与首屏那次一样（completed→completed）
    runStatusById[RUN_2] = 'completed';
    await waitFor(
      () => expect(getDocumentVersionProgress).toHaveBeenCalledTimes(2),
      { timeout: 10000 },
    );
  }, 30000);

  it('已逻辑删除的版本：按钮禁用，点了也不发请求', async () => {
    versions = [
      versionSummary({ version_status: 'deleted', is_current: false }),
    ];
    renderPage();
    await waitForTable();

    const link = reprocessLink();
    expect(link.className).toContain('ant-typography-disabled');

    fireEvent.click(link);
    // Popconfirm 也是 disabled 的 → 弹层根本不出现
    expect(document.querySelector('.ant-popconfirm')).toBeNull();
    expect(reprocessDocumentVersion).not.toHaveBeenCalled();
  });

  it('提交失败（如 409）：不弹成功提示，按钮回到可点', async () => {
    reprocessDocumentVersion.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 409'), {
        response: { status: 409, data: { detail: '版本已逻辑删除' } },
      }),
    );

    renderPage();
    await waitForTable();

    await clickReprocess();

    await waitFor(() =>
      expect(reprocessDocumentVersion).toHaveBeenCalledTimes(1),
    );
    // 全局 errorHandler 负责报错（组件层不补第二条），这里只保证没有假成功
    await waitFor(() =>
      expect(document.body.textContent).not.toContain('已提交重新生成'),
    );
    await waitFor(() => expect(reprocessLink().textContent).toBe('重新生成'));
  });
});

// ============================================================
// 版本表 · 布局约束
//
// 这三条对应「表格在窗口缩小后塌掉」的三个具体成因，分开钉：
//   1. 时间用原始 ISO 串 → 一格里折成两行，整行高度翻倍；
//   2. 操作列没固定 → 横向滚动时被滚出视口，看起来像「表格被隐藏」；
//   3. 文件名是 inline 元素 → 列的 ellipsis 管不到它，长名字照样折行。
// ============================================================

describe('版本列表 · 布局约束', () => {
  it('创建时间格式化成 YYYY-MM-DD HH:mm，不再把原始 ISO 串摊在格子里', async () => {
    renderPage();
    await waitForTable();

    const cells = Array.from(rowOf().querySelectorAll('td')).map((td) =>
      (td.textContent ?? '').trim(),
    );

    expect(cells.some((t) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t))).toBe(
      true,
    );
    // 原始值只留在 Tooltip 里
    expect(cells.join(' ')).not.toContain('2026-10-14T04:10:52Z');
  });

  it('操作列钉在右侧：横向滚动时不会被滚走', async () => {
    renderPage();
    await waitForTable();

    const cells = Array.from(rowOf().querySelectorAll('td'));
    expect(cells.length).toBe(6);
    // antd v6 同时挂 `-fix-right` 与方向无关的 `-fix-end`，两者认一个即可
    expect(cells[cells.length - 1].className).toMatch(
      /ant-table-cell-fix-(right|end)/,
    );
  });

  it('文件名是块级元素 + 省略号（列上的 ellipsis 管不到 inline 子元素）', async () => {
    renderPage();
    await waitForTable();

    const nameSpan = Array.from(rowOf().querySelectorAll('span')).find(
      (el) => el.textContent === '000428_大事提醒.md',
    ) as HTMLElement | undefined;

    expect(nameSpan).toBeTruthy();
    expect(nameSpan?.style.textOverflow).toBe('ellipsis');
    expect(nameSpan?.style.whiteSpace).toBe('nowrap');
  });
});
