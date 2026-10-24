// src/pages/document/detail.tsx
// Document 详情页：
//  - 基础信息 + 版本列表：来自 GET /documents/{id}（本体 + 当前版本 + 全部版本）；
//  - 横向处理进度 Steps：真实数据，由 pipeline.ts 的 buildTimeline 聚合；
//  - 处理中的版本按 2 秒轮询 GET /pipeline-runs/{id}/progress（轻量、专为轮询设计），
//    拿到 <status> 后同时改写该行的「运行状态」；
//  - 进入终态（completed/failed/partial/cancelled，无论正常异常）再查一次
//    GET /document-versions/{vid}/progress，同步该行的「版本状态」与处理状态；
//  - 版本文件抽屉：retrieval 来自该版本 pipeline_config 快照；
//  - 四个更新动作：上传新版本（file_id）/ 设为当前版本 / 重新生成（reprocess）/ 编辑标题与 metadata。
import { PageContainer } from '@ant-design/pro-components';
import { Link, useParams } from '@umijs/max';
import {
  App,
  Badge,
  Empty,
  Popconfirm,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { retrievalTypeLabel } from '@/utils/retrievalType';

import EditDocumentModal from './components/EditDocumentModal';
import ProgressSteps from './components/ProgressSteps';
import UploadVersionModal from './components/UploadVersionModal';
import VersionDrawer from './components/VersionDrawer';
import type {
  DocumentDetailResponse,
  DocumentVersionDetailResponse,
  DocumentVersionSummary,
  ProcessingStatus,
  VersionStatus,
} from './data';
import { formatBytes, useFileInfo } from './fileInfo';
import {
  applyRunProgress,
  buildTimeline,
  deriveProcessingStatus,
  fetchNodeCatalog,
  getDocumentVersionProgress,
  getPipelineRun,
  getPipelineRunProgress,
  isTerminalRunStatus,
  listVersionPipelineRuns,
  type PipelineRunProgressResponse,
  RUN_STATUS_TEXT,
  type RunStatus,
  reprocessDocumentVersion,
  type TimelineModel,
} from './pipeline';
import { clearRunStatusCache, useVersionRunStatuses } from './runStatus';
import { getDocument, getDocumentVersion, updateDocument } from './service';
import { useStyles } from './style';
import { typeLabel, useTypeMap } from './typeMap';

/** 轻量进度轮询间隔。pipeline.yaml 说该接口是为 1~2 秒轮询设计的。 */
const POLL_PROGRESS_MS = 2000;

/** progress 接口不可用时的兜底轮询间隔（退回全量详情）。 */
const POLL_FALLBACK_MS = 5000;

/** 上传后等运行登记的轮询间隔（建版本与建运行不是同一个事务）。 */
const POLL_AWAIT_RUN_MS = 1500;

/** 空时间线（首次加载 / 无运行记录时占位）。 */
const EMPTY_TIMELINE: TimelineModel = {
  nodes: [],
  percent: 0,
  plannedSteps: 0,
  completedSteps: 0,
  failedSteps: 0,
  skippedSteps: 0,
  branchCount: 0,
  expanded: false,
  jumpHint: null,
  run: null,
  runStatus: null,
  unknownNodes: false,
  graphVersion: null,
  triggerSource: null,
};

/** 版本状态 → 展示。 */
const VERSION_STATUS_META: Record<
  VersionStatus,
  { status: 'default' | 'processing' | 'success' | 'error'; text: string }
> = {
  pending: { status: 'default', text: '待生效' },
  active: { status: 'success', text: '生效中' },
  superseded: { status: 'default', text: '已取代' },
  failed: { status: 'error', text: '失败' },
  deleted: { status: 'default', text: '已删除' },
};

/**
 * 处理流水线状态 → 展示。
 *
 * 与 VERSION_STATUS_META 是两个维度：版本状态是生命周期，
 * 处理状态才是流水线跑出来的结果（后端由 finalize_version 回写）。
 */
const PROCESSING_META: Record<
  ProcessingStatus,
  { color: string; text: string }
> = {
  pending: { color: 'default', text: '待处理' },
  processing: { color: 'blue', text: '处理中' },
  completed: { color: 'green', text: '已就绪' },
  failed: { color: 'red', text: '处理失败' },
};

/** 运行状态 → Tag 颜色（partial 需要独立的橙色，Badge 表达不了）。 */
const RUN_TAG_COLOR: Record<RunStatus, string> = {
  pending: 'default',
  running: 'blue',
  completed: 'green',
  failed: 'red',
  partial: 'orange',
  cancelled: 'default',
};

/**
 * 版本表的「创建时间」。
 *
 * 后端给的是 `2026-10-16T14:47:32.588828Z` —— 27 个字符原样塞进表格会折成
 * 「2026-10-」+「16T14:47:32.588828Z」两行，整行高度翻倍，看起来像表格塌了。
 * 所以：正文只留到分钟（本地时区，与文件页同口径），完整原值进 Tooltip。
 */
const TIME_FORMAT = 'YYYY-MM-DD HH:mm';
const formatTime = (iso: string | null | undefined) =>
  iso ? dayjs(iso).format(TIME_FORMAT) : '—';

/** 从 Record 里摘掉一个 key（不改原对象；key 不存在时原样返回，省一次渲染）。 */
function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * 文件名单元格：按 file_id 回查 File Service（带缓存）。
 *
 * ⚠️ 单行 + 省略号，**必须**自己写：列上挂 `ellipsis` 时，antd 只把
 * `text-overflow` 加在 `td` 上，而这里的内容包在 Tooltip 的 `span`（inline）里，
 * 长文件名仍会顶成两行（版本表在窄屏下就是这么把行高撑坏的）。
 */
const FileNameCell: React.FC<{ fileId: string }> = ({ fileId }) => {
  const { file, loading } = useFileInfo(fileId);
  if (loading)
    return <Skeleton.Input size="small" active style={{ width: 160 }} />;
  if (!file) return <span style={{ opacity: 0.4 }}>—</span>;
  return (
    <Tooltip title={`${file.file_name} · ${formatBytes(file.file_size)}`}>
      <span
        style={{
          display: 'block',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {file.file_name}
      </span>
    </Tooltip>
  );
};

const DocumentDetailPage: React.FC = () => {
  const { documentId } = useParams<{ documentId: string }>();
  const { message } = App.useApp();
  const { styles, cx } = useStyles();
  const typeMap = useTypeMap();

  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );

  // 时间轴 = 「全量详情算出的基线」+「轮询到的轻量进度」叠加，
  // 用 useMemo 派生而不是再存一份 state，避免两份数据不同步。
  const [timelineBase, setTimelineBase] = useState<TimelineModel | null>(null);
  const [runProgress, setRunProgress] =
    useState<PipelineRunProgressResponse | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  /** progress 接口连续失败（多为后端尚未就绪）→ 退回全量详情轮询。 */
  const [progressUnavailable, setProgressUnavailable] = useState(false);

  // 业务状态覆盖层：终态时由 version progress 同步回来的权威值。
  const [versionStatusMap, setVersionStatusMap] = useState<
    Record<string, VersionStatus>
  >({});
  const [processingStatusMap, setProcessingStatusMap] = useState<
    Record<string, ProcessingStatus>
  >({});

  /** 上一轮已知的完成步数：变化时补一次全量详情，让节点圆点前进。 */
  const lastCompletedRef = useRef<number | null>(null);
  /** 已同步过业务状态的 `${versionId}|${runStatus}`，避免重复请求。 */
  const syncedRef = useRef<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerVersion, setDrawerVersion] =
    useState<DocumentVersionSummary | null>(null);
  const [drawerVersionDetail, setDrawerVersionDetail] =
    useState<DocumentVersionDetailResponse | null>(null);
  const [loadingDrawerDetail, setLoadingDrawerDetail] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  /** 正在提交「重新生成」的版本 id（防重复点击）。 */
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);

  /** 版本表的前端分页（后端一次返回全部版本，不再分页请求）。 */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const versionIds = useMemo(
    () => (detail?.versions ?? []).map((item) => item.document_version_id),
    [detail],
  );
  const { runStatusMap, setVersionRunStatus } = useVersionRunStatuses(
    documentId,
    versionIds,
  );

  const timeline = useMemo(
    () => (timelineBase ? applyRunProgress(timelineBase, runProgress) : null),
    [timelineBase, runProgress],
  );

  /** 加载详情；keepVersionId 缺省时取当前生效版本，否则取版本号最大的。 */
  const loadDetail = useCallback(
    async (keepVersionId?: string | null) => {
      if (!documentId) return;
      setLoading(true);
      try {
        const data = await getDocument(documentId);
        setDetail(data);
        const versions = data.versions ?? [];
        const fallback =
          data.current_document_version_id ??
          [...versions].sort((a, b) => b.version_number - a.version_number)[0]
            ?.document_version_id ??
          null;
        setSelectedVersionId(keepVersionId ?? fallback);
      } catch (error) {
        message.error(error instanceof Error ? error.message : '加载详情失败');
      } finally {
        setLoading(false);
      }
    },
    [documentId, message],
  );

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  /**
   * 拉一次全量运行详情，重建基线模型（节点状态以此为准）：
   *   版本详情（pipeline_config → retrieval 可读名）
   *   → 运行历史（items[0] 即最近一次）
   *   → 运行详情（全部节点行 + 该次运行的 topology_snapshot）
   *   → 节点目录（label 兜底 / 退役标记，进程内只拉一次）
   *   → buildTimeline 聚合成横向 Steps 需要的模型
   */
  const loadTimelineBase = useCallback(
    async (versionId: string) => {
      if (!documentId) return null;
      const [versionDetail, runs] = await Promise.all([
        getDocumentVersion(documentId, versionId),
        listVersionPipelineRuns(documentId, versionId, {
          page: 1,
          page_size: 20,
        }),
      ]);

      const retrievalLabels: Record<string, string> = {};
      for (const item of versionDetail.pipeline_config?.retrievals ?? []) {
        if (item.document_retrieval_definition_id && item.retrieval_type) {
          retrievalLabels[item.document_retrieval_definition_id] =
            retrievalTypeLabel(item.retrieval_type);
        }
      }

      const latestRun = runs.items?.[0] ?? null;
      const [runDetail, catalog] = await Promise.all([
        latestRun
          ? getPipelineRun(latestRun.pipeline_run_id)
          : Promise.resolve(null),
        fetchNodeCatalog().catch(() => null),
      ]);

      return {
        runId: latestRun?.pipeline_run_id ?? null,
        model: buildTimeline(runDetail, catalog, retrievalLabels),
      };
    },
    [documentId],
  );

  /** 切换版本时重建：清掉上一轮叠加，避免把旧进度带到新版本上。 */
  const loadVersionProgress = useCallback(
    async (versionId: string) => {
      setTimelineLoading(true);
      try {
        const result = await loadTimelineBase(versionId);
        if (!result) return;
        setRunId(result.runId);
        setTimelineBase(result.model);
        setRunProgress(null);
        setProgressUnavailable(false);
        lastCompletedRef.current = null;
      } catch (error) {
        message.error(
          error instanceof Error ? error.message : '加载处理进度失败',
        );
        setRunId(null);
        setTimelineBase(null);
        setRunProgress(null);
      } finally {
        setTimelineLoading(false);
      }
    },
    [loadTimelineBase, message],
  );

  /**
   * 轮询期间的重取：只刷基线，不动 runProgress；失败静默（下一轮会再试）。
   *
   * 全量详情是最权威的运行状态来源，所以这里必须顺带把「运行状态」列也对齐 ——
   * 否则 progress 接口不可用（走 5 秒兜底轮询）时，这一列会永远停在首屏的旧值。
   */
  const refreshBase = useCallback(
    async (versionId: string) => {
      try {
        const result = await loadTimelineBase(versionId);
        if (!result) return;
        setTimelineBase(result.model);
        setVersionRunStatus(versionId, result.model.runStatus);
      } catch {
        // 静默：轮询重取失败不该打断用户
      }
    },
    [loadTimelineBase, setVersionRunStatus],
  );

  /**
   * 刚上传完 / 刚点了「重新生成」：正在等后端把**这一跑**登记进来。
   *
   * 建版本与建运行不是同一个事务：PUT /documents/{id} 与
   * POST /document-versions/{vid}/reprocess 都只**登记调度**，返回时运行行可能
   * 还没落库 —— 那一刻查到的「最新运行」仍是上一跑，查不到就没法开始轮询，
   * 页面会一直停在旧结果上。有这个标记就短暂重试几次，直到最新运行**换了一个**。
   *
   * prevRunId = 点击前该版本的最新运行 id；null 表示此前没有运行（上传新版本的情形），
   * 此时只要出现任何 runId 就算到了。
   */
  const pendingRunRef = useRef<{
    versionId: string;
    prevRunId: string | null;
  } | null>(null);

  /**
   * 「轮次纪元」：挂在等待新运行时 +1；新运行接管时间轴时再 +1。
   *
   * 为什么要这个计数（两个 effect 都把它列进依赖）：
   *  ① 等待循环 —— 对**已经是选中版本**重跑时 setSelectedVersionId 是空操作，
   *     effect 只在依赖变化时才跑，没有计数第二次重跑会静默不生效；
   *  ② 终态收敛 —— 它按 `${versionId}|${runStatus}` 去重，而新的一跑如果**在第一次
   *     轮询前就跑完了**，runStatus 从 completed 变到 completed（字面没变）→ 依赖没动
   *     → effect 不再跑，业务状态/【当前】标签就漏更新了。计数变化强制它重判一次。
   */
  const [runEpoch, setRunEpoch] = useState(0);
  const awaitNewRun = useCallback(
    (versionId: string, prevRunId: string | null) => {
      pendingRunRef.current = { versionId, prevRunId };
      setRunEpoch((n) => n + 1);
    },
    [],
  );

  /**
   * 回查一次 Document 本体，把「当前」标记同步过来。
   *
   * is_current 不是数据库列 —— 后端用
   * `document.current_document_version_id == version.document_version_id`
   * 比对算出来的，因此**只有文档详情接口带它**，轮询的那两个 progress
   * 接口都没有。而 finalize 是在流水线跑完之后才写
   * current_document_version_id，所以跑完必须补这一次，否则新版本
   * 永远拿不到【当前】标签（刷新页面才出现）。
   *
   * 只替换 detail 本体：不重选版本、不置 loading，避免画面跳一下。
   */
  const syncCurrentVersion = useCallback(async () => {
    if (!documentId) return;
    try {
      const data = await getDocument(documentId);
      setDetail(data);
    } catch {
      // 静默：拿不到就保持原样，不打扰用户
    }
  }, [documentId]);

  /**
   * 上传新版本后的刷新 —— **不能**走 loadDetail 的默认选中逻辑。
   *
   * 那一刻新版本还不是 current（后端建版本时已经不写 current 了，只有
   * finalize 跑完才写），走 loadDetail 会选中旧版本：既看不到新版本的
   * 处理进度，也就永远不会触发上面那次【当前】同步。
   * 所以这里直接把选中项切到版本号最大的那个（刚创建的）。
   */
  const selectNewestVersion = useCallback(async () => {
    if (!documentId) return;
    try {
      const data = await getDocument(documentId);
      setDetail(data);
      const newest = [...(data.versions ?? [])].sort(
        (a, b) => b.version_number - a.version_number,
      )[0];
      if (newest) setSelectedVersionId(newest.document_version_id);
      // 新版本排在最上面，回到第一页用户才看得见它
      setPage(1);
      // 运行可能还没登记，等它出现（见下面的等待轮询）
      if (newest) awaitNewRun(newest.document_version_id, null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载详情失败');
    }
  }, [documentId, message, awaitNewRun]);

  useEffect(() => {
    if (!selectedVersionId) {
      setTimelineBase(null);
      setRunProgress(null);
      setRunId(null);
      return;
    }
    loadVersionProgress(selectedVersionId);
  }, [selectedVersionId, loadVersionProgress]);

  /** 当前生效的运行状态：progress 优先（更新更及时），否则用基线里的。 */
  const activeRunStatus =
    runProgress?.status ?? timelineBase?.runStatus ?? null;
  const isPolling =
    Boolean(runId) &&
    activeRunStatus != null &&
    !isTerminalRunStatus(activeRunStatus);

  /**
   * 等新运行登记：上传完新版本、或点了「重新生成」后，最新运行的 id 会**换一个**。
   * 每 1.5 秒重试一次基线，最多 8 次（约 12 秒），换到新运行即停并接管时间轴。
   *
   * ⚠️ 判据必须是「runId **变了**」而不是「runId 有没有」：重跑一个已有运行的版本时
   * runId 一直有值（指向上一跑），只判非空会当场认定"到了"，于是接着轮询**上一跑**
   * （它是终态）→ 一次请求都不发，页面永远停在旧结果。
   *
   * ⚠️ 这里还要把 syncedRef 清掉：终态收敛用它按 `${versionId}|${runStatus}` 去重，
   * 同一版本的**第二跑**跑完时 key 与上一跑相同，不清就永远不再同步业务状态。
   * 清完再 +1 纪元，让那个 effect 立刻重判一次（万一新的一跑已经跑完）。
   */
  useEffect(() => {
    const pending = pendingRunRef.current;
    if (!pending || pending.versionId !== selectedVersionId) return;
    let attempts = 0;
    let cancelled = false;

    const timer = window.setInterval(async () => {
      attempts += 1;
      if (attempts > 8) {
        pendingRunRef.current = null;
        window.clearInterval(timer);
        return;
      }
      const result = await loadTimelineBase(pending.versionId).catch(
        () => null,
      );
      if (cancelled) return;
      if (result?.runId && result.runId !== pending.prevRunId) {
        pendingRunRef.current = null;
        window.clearInterval(timer);
        syncedRef.current = null;
        setRunId(result.runId);
        setTimelineBase(result.model);
        setRunProgress(null);
        setProgressUnavailable(false);
        lastCompletedRef.current = null;
        setVersionRunStatus(pending.versionId, result.model.runStatus);
        // 重新生成后，原来那一跑同步回来的「处理状态」已经过期 —— 不清掉的话
        // 这一格会一直显示「已就绪」，与隔壁「运行状态：运行中」自相矛盾。
        // 摘掉之后改由 deriveProcessingStatus(新运行状态) 兜底，直到下一轮终态同步。
        setProcessingStatusMap((prev) => withoutKey(prev, pending.versionId));
        setRunEpoch((n) => n + 1);
      }
    }, POLL_AWAIT_RUN_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedVersionId, runEpoch, loadTimelineBase, setVersionRunStatus]);

  // 轮询 1：轻量进度，2 秒一次。只拿计数与当前节点，不打满网络。
  useEffect(() => {
    if (!selectedVersionId || !runId || progressUnavailable || !isPolling) {
      return;
    }
    let cancelled = false;
    let failures = 0;

    const tick = async () => {
      try {
        const progress = await getPipelineRunProgress(runId);
        if (cancelled) return;
        failures = 0;
        setRunProgress(progress);
        // 同时改写该版本的「运行状态」列，不必重拉列表
        setVersionRunStatus(selectedVersionId, progress.status);
        // 完成步数变化说明有节点跑完了 → 补一次全量详情，节点圆点才会前进。
        // 只在步数变化时拉，整场运行约 10 次，而不是每 2 秒一次。
        if (lastCompletedRef.current !== progress.completed_steps) {
          lastCompletedRef.current = progress.completed_steps;
          void refreshBase(selectedVersionId);
        }
      } catch {
        if (cancelled) return;
        failures += 1;
        // 连续两次失败（通常是接口尚未实现）→ 不再重试，退回兜底轮询
        if (failures >= 2) setProgressUnavailable(true);
      }
    };

    void tick();
    const timer = window.setInterval(tick, POLL_PROGRESS_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    selectedVersionId,
    runId,
    isPolling,
    progressUnavailable,
    refreshBase,
    setVersionRunStatus,
  ]);

  // 轮询 2：progress 接口不可用时的兜底 —— 退回全量详情，保持进度不冻住。
  useEffect(() => {
    if (!selectedVersionId || !isPolling || !progressUnavailable) return;
    const timer = window.setInterval(async () => {
      await refreshBase(selectedVersionId);
      setRunProgress(null);
    }, POLL_FALLBACK_MS);
    return () => window.clearInterval(timer);
  }, [selectedVersionId, isPolling, progressUnavailable, refreshBase]);

  // 终态收敛：无论正常（completed）还是异常（failed/partial/cancelled），
  // 都查一次 version progress —— run progress 只有执行层数据，业务状态只有它带。
  useEffect(() => {
    if (!selectedVersionId || !isTerminalRunStatus(activeRunStatus)) return;
    const key = `${selectedVersionId}|${activeRunStatus}`;
    if (syncedRef.current === key) return;
    syncedRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        const progress = await getDocumentVersionProgress(selectedVersionId);
        if (cancelled) return;
        setVersionStatusMap((prev) => ({
          ...prev,
          [selectedVersionId]: progress.version_status,
        }));
        setProcessingStatusMap((prev) => ({
          ...prev,
          [selectedVersionId]: progress.processing_status,
        }));
        setVersionRunStatus(
          selectedVersionId,
          progress.latest_run?.status ?? activeRunStatus,
        );
      } catch {
        // 业务状态接口未就绪：保留列表里已有的 version_status，不打扰用户
      } finally {
        if (!cancelled) {
          await refreshBase(selectedVersionId);
          // 跑完了：finalize 已改写 document.current_document_version_id，
          // 补一次文档详情，把【当前】标签与各版本的 version_status 一起刷到最新。
          //
          // 这里**不做**「本页是否亲历过运行」的判断 —— 流水线常常只要一两秒，
          // 前端打开时间线时它可能早就跑完了，那种情况同样需要这一次同步。
          // 重复请求由上面的 syncedRef（按 版本+运行状态 去重）挡住。
          await syncCurrentVersion();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    selectedVersionId,
    activeRunStatus,
    // runEpoch 变化 = 新的一跑接管了时间轴：即使 runStatus 字面没变（completed→completed）
    // 也要重判一次，否则这一跑的业务状态与【当前】标签会漏更新。
    runEpoch,
    refreshBase,
    syncCurrentVersion,
    setVersionRunStatus,
  ]);

  /** 切换当前生效版本：PUT { current_document_version_id }，不创建新版本。 */
  const handleSwitchVersion = async (version: DocumentVersionSummary) => {
    if (!documentId) return;
    setSwitchingId(version.document_version_id);
    try {
      await updateDocument(documentId, {
        current_document_version_id: version.document_version_id,
      });
      message.success(`已切换到 v${version.version_number}`);
      await loadDetail(version.document_version_id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '切换失败');
    } finally {
      setSwitchingId(null);
    }
  };

  /**
   * 重新生成：POST /document-versions/{vid}/reprocess（202 + job_id）。
   *
   * 这个接口只**登记一次调度**，流水线不在请求里跑 —— 所以不能拿响应当结果：
   *   ① 先取"点击前该版本的最新运行"（prevRunId）—— 新运行登记后 runId 必然不同，
   *      轮询据此判断"新的一跑到了"；
   *   ② 把选中版本切到这一行 —— 时间轴面板才会展示这一跑（点非当前版本时尤其重要）；
   *   ③ 挂上 awaitNewRun，等新运行落库后重建时间轴、自动开始 2 秒轮询。
   *
   * job_id 为空说明派发器还没接线（见 pipeline.yaml）：同样按"等新运行出现"处理，
   * 只是提示文案说清楚"等待调度"。
   *
   * ⚠️ catch 里**不再补 toast**：409（版本已逻辑删除等）已由全局 errorHandler
   * 读后端 detail 弹了中文原因，这里再弹一条就是两条英文/中文混着的提示。
   */
  const handleReprocess = async (version: DocumentVersionSummary) => {
    if (!documentId) return;
    const versionId = version.document_version_id;
    setReprocessingId(versionId);
    try {
      const before = await listVersionPipelineRuns(documentId, versionId, {
        page: 1,
        page_size: 1,
      }).catch(() => null);
      const prevRunId = before?.items?.[0]?.pipeline_run_id ?? null;

      const result = await reprocessDocumentVersion(versionId);
      clearRunStatusCache();
      message.success(
        result.job_id
          ? `已提交重新生成（v${version.version_number}）`
          : `已提交重新生成（v${version.version_number}），等待调度`,
      );
      awaitNewRun(versionId, prevRunId);
      setSelectedVersionId(versionId);
    } catch {
      // 交给全局 errorHandler（见上面的说明）
    } finally {
      setReprocessingId(null);
    }
  };

  /** 打开抽屉：单独拉该版本的 pipeline_config 快照（可能与当前选中版本不同）。 */
  const openDrawer = async (version: DocumentVersionSummary) => {
    setDrawerVersion(version);
    setDrawerVersionDetail(null);
    setDrawerOpen(true);
    if (!documentId) return;
    setLoadingDrawerDetail(true);
    try {
      const data = await getDocumentVersion(
        documentId,
        version.document_version_id,
      );
      setDrawerVersionDetail(data);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : '加载版本详情失败',
      );
    } finally {
      setLoadingDrawerDetail(false);
    }
  };

  const columns = useMemo<ColumnsType<DocumentVersionSummary>>(
    () => [
      {
        title: '版本',
        dataIndex: 'version_number',
        width: 96,
        render: (_, record) => (
          <Space size={6} wrap={false}>
            <Typography.Text strong>v{record.version_number}</Typography.Text>
            {record.is_current && <Tag color="success">当前</Tag>}
          </Space>
        ),
      },
      {
        title: '文件',
        dataIndex: 'file_id',
        ellipsis: true,
        render: (_, record) => <FileNameCell fileId={record.file_id} />,
      },
      {
        title: '版本状态',
        dataIndex: 'version_status',
        width: 150,
        render: (_, record) => {
          const versionStatus =
            versionStatusMap[record.document_version_id] ??
            record.version_status;
          const meta = VERSION_STATUS_META[versionStatus];
          // 处理状态优先用 version progress 的权威值；拿不到（接口未就绪）时
          // 退回「由运行状态按后端同款映射推导」，保证这一格能跟着跑起来动。
          const processing =
            processingStatusMap[record.document_version_id] ??
            deriveProcessingStatus(runStatusMap[record.document_version_id]);
          const processingMeta = processing
            ? PROCESSING_META[processing]
            : null;
          return (
            <Space size={4} wrap={false}>
              <Badge status={meta.status} text={meta.text} />
              {processingMeta && (
                <Tooltip title="处理流水线状态（由 retrieval 绑定聚合而来）">
                  <Tag color={processingMeta.color}>{processingMeta.text}</Tag>
                </Tooltip>
              )}
            </Space>
          );
        },
      },
      {
        title: '运行状态',
        key: 'runStatus',
        width: 104,
        render: (_, record) => {
          const status = runStatusMap[record.document_version_id];
          if (status === undefined) {
            return <Skeleton.Input size="small" active style={{ width: 56 }} />;
          }
          if (status === null) {
            return <span style={{ opacity: 0.4 }}>（无运行）</span>;
          }
          return (
            <Tooltip title="点击查看该版本的节点级处理进度">
              <span
                className={styles.statusCell}
                onClick={() => setSelectedVersionId(record.document_version_id)}
              >
                <Tag color={RUN_TAG_COLOR[status]}>
                  {RUN_STATUS_TEXT[status]}
                </Tag>
              </span>
            </Tooltip>
          );
        },
      },
      {
        title: '创建时间',
        dataIndex: 'created_at',
        width: 148,
        render: (value: string) => (
          <Tooltip title={value}>
            <span style={{ whiteSpace: 'nowrap' }}>{formatTime(value)}</span>
          </Tooltip>
        ),
      },
      {
        title: '操作',
        key: 'option',
        width: 208,
        /*
         * 钉在右边：窄屏下表格必然要横向滚动，不钉住这三个链接就被滚出视口
         * —— 用户的原话是「页面缩小后 table 被隐藏」，实际藏掉的就是这一列。
         */
        fixed: 'right',
        render: (_, record) => {
          const versionId = record.document_version_id;
          const versionStatus =
            versionStatusMap[versionId] ?? record.version_status;
          const reprocessing = reprocessingId === versionId;
          /**
           * 已逻辑删除的版本重跑必然 409（pipeline.yaml 把这个情形点名了），
           * 与其让用户点一个注定失败的按钮，不如提前禁用。
           */
          const cannotReprocess = versionStatus === 'deleted';
          return (
            <Space size={8}>
              <Typography.Link onClick={() => openDrawer(record)}>
                查看
              </Typography.Link>
              <Typography.Link
                disabled={record.is_current || switchingId === versionId}
                onClick={() => handleSwitchVersion(record)}
              >
                设为当前版本
              </Typography.Link>
              {/* 重新生成 = POST /document-versions/{vid}/reprocess：
                  只登记调度，跑完由时间轴面板上的轮询体现，所以点完要等"新的一跑"出现。 */}
              <Popconfirm
                title={`重新生成 v${record.version_number}？`}
                description="将重新执行该版本的处理流水线，已有的处理产出会被覆盖。"
                okText="重新生成"
                cancelText="取消"
                disabled={cannotReprocess || reprocessing}
                onConfirm={() => handleReprocess(record)}
              >
                <Typography.Link
                  disabled={cannotReprocess || reprocessing}
                  data-reprocess={versionId}
                >
                  {reprocessing ? '提交中…' : '重新生成'}
                </Typography.Link>
              </Popconfirm>
            </Space>
          );
        },
      },
    ],
    // 处理器闭包（openDrawer / handleSwitchVersion / handleReprocess）都只读 documentId
    // 与 message、其余走 setState —— 首次渲染的闭包即为最新，故不列入依赖。
    [
      styles,
      switchingId,
      reprocessingId,
      runStatusMap,
      versionStatusMap,
      processingStatusMap,
    ],
  );

  /**
   * 版本表的数据源：后端一次返回全部版本，这里只做**前端**排序与分页。
   * 倒序 —— 最新版本在最上面（后端固定 version_number 升序返回）。
   */
  const versions = useMemo(
    () =>
      [...(detail?.versions ?? [])].sort(
        (a, b) => b.version_number - a.version_number,
      ),
    [detail],
  );

  if (loading) {
    return (
      <PageContainer>
        <Skeleton active paragraph={{ rows: 12 }} />
      </PageContainer>
    );
  }

  if (!detail) {
    return (
      <PageContainer>
        <Empty description="未找到该文档" />
      </PageContainer>
    );
  }

  const selectedVersion = (detail.versions ?? []).find(
    (item) => item.document_version_id === selectedVersionId,
  );

  return (
    <PageContainer
      header={{
        breadcrumb: {
          items: [
            { title: <Link to="/documents">文档管理</Link> },
            { title: detail.title || detail.document_id },
          ],
        },
      }}
      title={detail.title || '（未命名）'}
      content={`文档类型：${typeLabel(typeMap, detail.document_type_definition_id)}`}
      extra={
        <Space>
          <EditDocumentModal
            documentId={detail.document_id}
            title={detail.title}
            metadata={detail.metadata}
            onSuccess={() => loadDetail(selectedVersionId)}
          />
          <UploadVersionModal
            documentId={detail.document_id}
            onSuccess={() => {
              clearRunStatusCache();
              void selectNewestVersion();
            }}
          />
        </Space>
      }
    >
      {/* 基础信息 + 处理进度：滚动时钉在顶部，只有下面的版本表滚动 */}
      <div className={styles.stickyTop}>
        <div className={styles.infoGrid}>
          <div className={styles.infoItem}>
            <div className={styles.infoLabel}>文档类型</div>
            <div className={styles.infoValue}>
              {typeLabel(typeMap, detail.document_type_definition_id)}
            </div>
          </div>
          <div className={styles.infoItem}>
            <div className={styles.infoLabel}>业务标识</div>
            <div className={styles.infoValue}>{detail.document_key ?? '—'}</div>
          </div>
          <div className={styles.infoItem}>
            <div className={styles.infoLabel}>状态</div>
            <div className={styles.infoValue}>
              <Badge
                status={detail.status === 'active' ? 'success' : 'default'}
                text={detail.status === 'active' ? '正常' : '已删除'}
              />
            </div>
          </div>
          <div className={styles.infoItem}>
            <div className={styles.infoLabel}>当前生效版本</div>
            <div className={styles.infoValue}>
              {detail.current_document_version ? (
                <Space size={6}>
                  <Tag color="blue">
                    v{detail.current_document_version.version_number}
                  </Tag>
                  <Typography.Text
                    type="secondary"
                    className={styles.monoValue}
                  >
                    {detail.current_document_version.document_version_id.slice(
                      0,
                      8,
                    )}
                    …
                  </Typography.Text>
                </Space>
              ) : (
                '—'
              )}
            </div>
          </div>
          <div className={styles.infoItem}>
            <div className={styles.infoLabel}>租户 ID</div>
            <div className={`${styles.infoValue} ${styles.monoValue}`}>
              {detail.tenant_id ?? '—'}
            </div>
          </div>
          <div className={styles.infoItem}>
            <div className={styles.infoLabel}>创建时间</div>
            <div className={styles.infoValue}>{detail.created_at}</div>
          </div>
        </div>

        {/* 处理进度（真实数据：pipeline run 节点行 + 轻量 progress 轮询叠加） */}
        <ProgressSteps
          model={timeline ?? EMPTY_TIMELINE}
          versionNumber={selectedVersion?.version_number}
          loading={timelineLoading && !timeline}
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {isPolling
                ? progressUnavailable
                  ? `进度接口未就绪，退回每 ${POLL_FALLBACK_MS / 1000} 秒刷新`
                  : `处理中，每 ${POLL_PROGRESS_MS / 1000} 秒自动刷新`
                : '点击版本行的「运行状态」可切换查看其它版本'}
            </Typography.Text>
          }
        />
      </div>

      {/* 版本列表 */}
      <h3 className={styles.statusTitle}>
        版本列表
        <Typography.Text
          type="secondary"
          style={{ fontWeight: 400, marginLeft: 8 }}
        >
          共 {versions.length} 个版本
        </Typography.Text>
      </h3>

      {/* 定宽列合计 706（96+150+104+148+208），x=920 → 文件名列保底 214。
          原先是 1080，等于在 1080 宽的窗口里就已经要横向滚了。 */}
      <Table<DocumentVersionSummary>
        rowKey="document_version_id"
        columns={columns}
        dataSource={versions}
        size="middle"
        pagination={{
          current: page,
          pageSize,
          showSizeChanger: true,
          pageSizeOptions: [5, 10, 20],
          showTotal: (total, range) =>
            `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          },
        }}
        rowClassName={(record) =>
          record.document_version_id === selectedVersionId
            ? cx(styles.selectedRow)
            : ''
        }
        scroll={{ x: 920 }}
      />

      <VersionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        documentId={detail.document_id}
        version={drawerVersion}
        versionDetail={drawerVersionDetail}
        loadingDetail={loadingDrawerDetail}
      />
    </PageContainer>
  );
};

export default DocumentDetailPage;
