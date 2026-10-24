// src/pages/document_retrieve/index.tsx
// 文档召回查询页 —— 直接对应 POST /api/v1/documents/retrieve（document_retrieve.yaml）。
//
// 设计前提（来自契约，别在前端替后端做）：
//   - 一次调用 = 一轮召回。服务端不会自动扩召回 / 改写查询 / 重试 / 进入 agent 循环。
//   - Recaller 是内部实现，页面上只做说明，不提供任何配置入口。
//   - 运行时只能覆盖 Fusioner / Filter / Reranker / Cutter，且「不传」= 继承所选处理器。
//
// Agentic（多轮 trace）部分按约定先空置，见页面底部占位卡片。
import { CopyOutlined, SearchOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Segmented,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  DocumentTypeDefinitionDetail,
  DocumentTypeDefinitionResponse,
} from '../document_type_definition/data';
import { getDocumentTypeDefinition } from '../document_type_definition/service';
import ProcessorPanel from './components/ProcessorPanel';
import RecallConfigPanel from './components/RecallConfigPanel';
import ResultCard from './components/ResultCard';
import RouteFilter from './components/RouteFilter';
import ScopeSelect from './components/ScopeSelect';
import {
  buildRetrieveRequest,
  type CutterConfig,
  type DocumentRetrieveResponse,
  type DocumentRetrieveResult,
  defaultPanel,
  type FilterConfig,
  type FusionerConfig,
  PIPELINE_KEY_COLOR,
  pathLabel,
  RETRIEVE_SOURCE_META,
  type RerankerConfig,
  type RetrievePanelState,
  resultPathKeys,
  retrievalTypeOwners,
  STAGE_META,
  UNLABELED_PATH,
  unionRetrievalTypes,
} from './data';
import { retrieveDocuments } from './service';
import { OVERRIDE_TIP_FADE_MS, useStyles } from './style';

/** 生效配置的展示摘要：只回显有值的字段，null 视为未设置。 */
function fusionerText(cfg?: FusionerConfig | null): string {
  if (!cfg) return '未回显';
  const parts: string[] = [];
  if (typeof cfg.enabled === 'boolean') parts.push(`enabled=${cfg.enabled}`);
  if (cfg.type) parts.push(cfg.type);
  if (cfg.top_k !== undefined && cfg.top_k !== null)
    parts.push(`top_k=${cfg.top_k}`);
  if (cfg.rrf_k !== undefined && cfg.rrf_k !== null)
    parts.push(`rrf_k=${cfg.rrf_k}`);
  if (cfg.weights) parts.push(`weights=${Object.keys(cfg.weights).length} 项`);
  return parts.length ? parts.join(' · ') : '未回显';
}

function filterText(cfg?: FilterConfig | null): string {
  if (!cfg) return '未回显';
  const parts: string[] = [];
  if (typeof cfg.enabled === 'boolean') parts.push(`enabled=${cfg.enabled}`);
  if (cfg.score_threshold !== undefined && cfg.score_threshold !== null) {
    parts.push(`阈值 ${cfg.score_threshold}`);
  }
  if (cfg.document_ids?.length) parts.push(`${cfg.document_ids.length} 个 doc`);
  if (cfg.document_version_ids?.length) {
    parts.push(`${cfg.document_version_ids.length} 个 version`);
  }
  if (cfg.metadata && Object.keys(cfg.metadata).length) {
    parts.push(`${Object.keys(cfg.metadata).length} 个 metadata 条件`);
  }
  return parts.length ? parts.join(' · ') : '未回显';
}

function rerankerText(cfg?: RerankerConfig | null): string {
  if (!cfg) return '未回显';
  const parts: string[] = [];
  if (typeof cfg.enabled === 'boolean') parts.push(`enabled=${cfg.enabled}`);
  if (cfg.type) parts.push(cfg.type);
  if (cfg.top_n !== undefined && cfg.top_n !== null)
    parts.push(`top_n=${cfg.top_n}`);
  if (cfg.model) parts.push(cfg.model);
  return parts.length ? parts.join(' · ') : '未回显';
}

function cutterText(cfg?: CutterConfig | null): string {
  if (!cfg) return '未回显';
  const parts: string[] = [];
  if (cfg.top_k !== undefined && cfg.top_k !== null)
    parts.push(`top_k=${cfg.top_k}`);
  if (cfg.max_content_chars) parts.push(`${cfg.max_content_chars} 字符`);
  return parts.length ? parts.join(' · ') : '未回显';
}

/** 覆盖提示淡出前的停留时长。 */
const OVERRIDE_TIP_AUTO_HIDE_MS = 5000;

const DocumentRetrievePage: React.FC = () => {
  const { styles } = useStyles();
  const [panel, setPanel] = useState<RetrievePanelState>(defaultPanel());
  const [cache, setCache] = useState<
    Record<string, DocumentTypeDefinitionResponse>
  >({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DocumentRetrieveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [view, setView] = useState<'rank' | 'path'>('rank');
  /**
   * 覆盖规则提示：默认显示，停留 5 秒后自动淡出；收掉后留「重新显示」的入口，
   * 免得关了就找不回来。
   *
   * 用三态而不是布尔量：leaving 是「正在播淡出动画」的中间态 ——
   * 直接把节点摘掉是没有动画的，必须先播完再卸载。
   */
  const [overrideTipPhase, setOverrideTipPhase] = useState<
    'visible' | 'leaving' | 'hidden'
  >('visible');

  /** 展示满 5 秒后进入淡出。点「重新显示提示」会重新计时。 */
  useEffect(() => {
    if (overrideTipPhase !== 'visible') return undefined;
    const timer = window.setTimeout(
      () => setOverrideTipPhase('leaving'),
      OVERRIDE_TIP_AUTO_HIDE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [overrideTipPhase]);

  /** 淡出动画播完再卸载节点，时长与 CSS keyframes 共用同一个常量。 */
  useEffect(() => {
    if (overrideTipPhase !== 'leaving') return undefined;
    const timer = window.setTimeout(
      () => setOverrideTipPhase('hidden'),
      OVERRIDE_TIP_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [overrideTipPhase]);
  /**
   * 降级提示记的是「哪一个 retrieve_id 被关掉了」，不是简单的布尔量 ——
   * 这样换一轮召回会自动重新提示，不需要在 run() 里记得手动重置。
   */
  const [dismissedDegradedId, setDismissedDegradedId] = useState<string | null>(
    null,
  );

  const patch = useCallback(
    (p: Partial<RetrievePanelState>) => setPanel((prev) => ({ ...prev, ...p })),
    [],
  );
  /**
   * 已选定义的**详情**（含 retrievals）—— 列表接口不返回子项，选中后按需拉取。
   *
   * 上提到页面而不是留在 ScopeSelect 里：定向召回的可选项要用同一份数据。
   * 各拉一遍会变成两次详情请求，而且两份并集可能因到达时序不同而短暂不一致
   * —— 一边显示「已配置 稠密向量」，另一边勾选项里还没有，就是鬼影。
   */
  const [details, setDetails] = useState<
    Record<string, DocumentTypeDefinitionDetail>
  >({});
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const inflight = useRef<Set<string>>(new Set());

  useEffect(() => {
    panel.dtdIds.forEach((id) => {
      if (details[id] || inflight.current.has(id)) return;
      inflight.current.add(id);
      setPendingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      getDocumentTypeDefinition(id)
        .then((detail) => {
          if (detail) setDetails((prev) => ({ ...prev, [id]: detail }));
        })
        .catch(() => {
          /* 拉取失败就只显示名称，不阻塞选择 */
        })
        .finally(() => {
          inflight.current.delete(id);
          setPendingIds((prev) => prev.filter((x) => x !== id));
        });
    });
  }, [panel.dtdIds, details]);

  const onCache = useCallback((items: DocumentTypeDefinitionResponse[]) => {
    setCache((prev) => {
      const next = { ...prev };
      items.forEach((it) => {
        next[it.document_type_definition_id] = it;
      });
      return next;
    });
  }, []);

  /**
   * 定向召回的可选项 = 已选定义里 retrieval_type 的并集。
   *
   * 详情是异步回来的，所以它在最初几帧是空数组 —— 那正是「还无法筛选」，
   * buildRetrieveRequest 遇到空并集会**不传** retrieval_types（= 全部路），
   * 与「还没得选」的现实一致，不会先发一个错的再修正。
   */
  const availableTypes = useMemo(
    () => unionRetrievalTypes(panel.dtdIds, details),
    [panel.dtdIds, details],
  );

  /** 每一路来自哪几个定义 —— 交集语义下，结果变少要能归因到路径上。 */
  const typeOwners = useMemo(
    () =>
      retrievalTypeOwners(
        panel.dtdIds,
        details,
        (id) => cache[id]?.name ?? id.slice(0, 8),
      ),
    [panel.dtdIds, details, cache],
  );

  /** 真正会发出去的那几路 = 并集 − 被排除的。 */
  const wantedTypes = useMemo(
    () => availableTypes.filter((t) => !panel.excludedTypes.includes(t)),
    [availableTypes, panel.excludedTypes],
  );

  const requestBody = useMemo(
    () => buildRetrieveRequest(panel, availableTypes),
    [panel, availableTypes],
  );
  const requestText = useMemo(
    () => JSON.stringify(requestBody, null, 2),
    [requestBody],
  );

  const run = async () => {
    if (!panel.dtdIds.length) {
      setError('请至少选择 1 个文档类型定义');
      return;
    }
    if (!panel.inputText.trim()) {
      setError('请输入查询文本');
      return;
    }
    /**
     * 「一路都没勾」必须在发起前拦住，不能靠构造请求时兜底：
     * 空数组会被 422 拒绝，而**不传**等于「全部路」—— 那是与用户意图
     * 完全相反的事。这里既不能发 []，也不能退化成不传，只能不发这次请求。
     */
    if (availableTypes.length && !wantedTypes.length) {
      setError('定向召回路径一条都没勾 —— 请至少勾 1 路，或全选');
      return;
    }
    setLoading(true);
    setError(null);
    const started = performance.now();
    try {
      const res = await retrieveDocuments(requestBody);
      setResult(res ?? null);
      setElapsed(Math.round(performance.now() - started));
    } catch (e: unknown) {
      const res = (e as { response?: { data?: { message?: string } } })
        ?.response;
      setError(res?.data?.message ?? (e as Error)?.message ?? '召回失败');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const results = result?.results ?? [];
  const maxScore = results.reduce((m, r) => Math.max(m, r.score), 0);

  /** 每条结果的召回方向（数组，已去重）。多路命中是融合信号，下面两个视图都依赖它。 */
  const keysOf = useCallback((r: DocumentRetrieveResult) => {
    const keys = resultPathKeys(r);
    // 契约默认 [] ——不是「没命中任何路」，只是没标注，单独归一组
    return keys.length ? keys : [UNLABELED_PATH];
  }, []);

  /** 路径 → 命中条数。同一条结果的多路都要计数（分母是「命中次数」不是「结果数」）。 */
  const pathCount = useMemo(() => {
    const map = new Map<string, number>();
    results.forEach((r) => {
      keysOf(r).forEach((key) => {
        map.set(key, (map.get(key) ?? 0) + 1);
      });
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [results, keysOf]);

  /** 被 ≥2 路同时命中的结果数 —— 融合真正多召回出来的那部分。 */
  const multiHitCount = useMemo(
    () => results.filter((r) => resultPathKeys(r).length > 1).length,
    [results],
  );

  /** 按路径分组。一条结果属于多路时会**同时出现在多组**里，这是刻意的。 */
  const grouped = useMemo(() => {
    const map = new Map<string, DocumentRetrieveResult[]>();
    results.forEach((r) => {
      keysOf(r).forEach((key) => {
        const list = map.get(key) ?? [];
        list.push(r);
        map.set(key, list);
      });
    });
    return Array.from(map.entries());
  }, [results, keysOf]);

  const degraded = result?.degraded_routes ?? [];

  const effective = result?.retrieve_processor ?? null;
  // 只回显「可覆盖的四段」。Recaller 不在这里 —— 契约说它是内部实现，
  // 没有任何生效配置可回显，挂个空节点只会让人以为它能配。
  const stageSummary: Record<string, string> = {
    fusioner: effective ? fusionerText(effective.fusioner) : '未执行',
    filter: effective ? filterText(effective.filter) : '未执行',
    reranker: effective ? rerankerText(effective.reranker) : '未执行',
    cutter: effective ? cutterText(effective.cutter) : '未执行',
  };

  return (
    <PageContainer
      title="文档召回查询"
      content="一次调用 = 一轮召回：服务端不会自动扩召回、改写查询或进入 agent 循环。运行时只能覆盖 Fusioner / Filter / Reranker / Cutter，Recaller 为内部实现。结果是否完整要看 degraded_routes —— 非空说明有路由没上场。"
      tabList={[{ tab: '召回查询', key: 'retrieve' }]}
      tabActiveKey="retrieve"
    >
      <div className={styles.layout}>
        {/* ==================== 左：查询配置 ==================== */}
        <div className={styles.column}>
          <Card size="small" title="查询输入" extra={<Tag>input_text</Tag>}>
            <Input.TextArea
              rows={3}
              maxLength={10000}
              value={panel.inputText}
              placeholder="输入自然语言查询，例如：比亚迪 2025 年第一大股东是谁？"
              onChange={(e) => patch({ inputText: e.target.value })}
            />
            {/* 计数留在左边（它是输入的附注），按钮整组贴右 —— 主操作在行尾 */}
            <div className={styles.inputActions}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {panel.inputText.length} / 10000
              </Typography.Text>
              <Space size={8}>
                <Button
                  onClick={() => {
                    setPanel(defaultPanel());
                    setResult(null);
                    setError(null);
                    setElapsed(null);
                  }}
                >
                  重置
                </Button>
                <Button
                  type="primary"
                  icon={<SearchOutlined />}
                  loading={loading}
                  onClick={run}
                >
                  执行召回
                </Button>
              </Space>
            </div>
          </Card>

          <Card
            size="small"
            title="召回范围"
            extra={<Tag>document_type_definition_ids</Tag>}
          >
            <ScopeSelect
              value={panel.dtdIds}
              onChange={(ids) => patch({ dtdIds: ids })}
              cache={cache}
              onCache={onCache}
              details={details}
              pendingIds={pendingIds}
              disabled={loading}
            />

            {/* 定向召回：勾哪几路就只走哪几路。没有选中定义时整块不出现 ——
                并集为空时的「0 路」是假状态（详情还没回来），摆出来只会吓人。 */}
            {panel.dtdIds.length ? (
              <RouteFilter
                types={availableTypes}
                owners={typeOwners}
                excluded={panel.excludedTypes}
                onChange={(excludedTypes) => patch({ excludedTypes })}
                pending={pendingIds.length > 0}
              />
            ) : null}

            {/* 每路召回参数：紧挨着「定向召回路径」—— 那里决定跑哪几路，
                这里决定每路跑多宽。两块必须相邻，否则这个分工就看不出来。 */}
            {panel.dtdIds.length ? (
              <RecallConfigPanel
                types={availableTypes}
                excluded={panel.excludedTypes}
                value={panel.retrievalConfig}
                onChange={(retrievalConfig) => patch({ retrievalConfig })}
                pending={pendingIds.length > 0}
              />
            ) : null}

            <div className={styles.hint} style={{ marginTop: 8 }}>
              选择 1 个 → <b>retrieve_scope = single</b>
              <br />
              选择多个 → <b>retrieve_scope = multi</b> 各自定义先各自处理
            </div>

            <div className={styles.switchRow}>
              <Switch
                size="small"
                checked={panel.onlyActive}
                onChange={(onlyActive) => patch({ onlyActive })}
                disabled={loading}
              />
              <div className={styles.switchBody}>
                <Typography.Text>仅当前生效版本（only_active）</Typography.Text>
              </div>
            </div>
          </Card>

          <Card
            size="small"
            title="RetrieveProcessor 运行时覆盖"
            extra={<Tag>retrieve_processor</Tag>}
          >
            {overrideTipPhase === 'hidden' ? (
              <div className={styles.overrideTipHint}>
                Recaller 不对外暴露；不覆盖 = 不传，继承所选 RetrieveProcessor。
                <Typography.Link
                  style={{ fontSize: 12, marginLeft: 8 }}
                  onClick={() => setOverrideTipPhase('visible')}
                >
                  重新显示提示
                </Typography.Link>
              </div>
            ) : (
              <Alert
                type="warning"
                showIcon
                className={`${styles.overrideTip} ${
                  overrideTipPhase === 'leaving'
                    ? styles.overrideTipLeaving
                    : ''
                }`}
                // 手动关闭也走同一条淡出路径，观感和自动收起保持一致
                closable={{ onClose: () => setOverrideTipPhase('leaving') }}
                title="只能覆盖 Fusioner / Filter / Reranker / Cutter"
                description="关闭 = 不传 = 继承处理器；Recaller 不可覆盖"
              />
            )}
            <ProcessorPanel
              fusioner={panel.fusioner}
              filter={panel.filter}
              reranker={panel.reranker}
              cutter={panel.cutter}
              onChange={patch}
            />
          </Card>

          <Card
            size="small"
            title="请求体预览"
            extra={
              <Button
                type="link"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => navigator.clipboard?.writeText(requestText)}
              >
                复制
              </Button>
            }
          >
            <pre className={styles.requestPreview}>{requestText}</pre>
          </Card>
        </div>

        {/* ==================== 右：结果 ==================== */}
        <div className={styles.column}>
          <Card size="small" title="执行链路">
            <div className={styles.flow}>
              {STAGE_META.map((stage, index) => (
                <React.Fragment key={stage.key}>
                  {index ? <div className={styles.flowArrow}>→</div> : null}
                  <div className={styles.flowNode}>
                    <Typography.Text strong>{stage.label}</Typography.Text>
                    <div className={styles.hint}>{stageSummary[stage.key]}</div>
                  </div>
                </React.Fragment>
              ))}
            </div>
            <div className={styles.hint} style={{ marginTop: 8 }}>
              回显来自响应的
              retrieve_processor（生效配置），不是前端猜测；执行前显示为「未执行」。
              <br />
              这四段是契约允许运行时覆盖的全部范围，其余环节（含
              Recaller）不在公开 API 内。
            </div>
          </Card>

          {error ? (
            <Alert
              type="error"
              showIcon
              closable={{ onClose: () => setError(null) }}
              title="召回失败"
              description={error}
            />
          ) : null}

          <Card
            size="small"
            title="返回摘要"
            extra={
              elapsed !== null ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {elapsed} ms · {results.length} 条
                </Typography.Text>
              ) : null
            }
          >
            {result ? (
              <Space vertical size={8} style={{ width: '100%' }}>
                <Space size={6} wrap>
                  <Tag>{`scope · ${result.retrieve_scope}`}</Tag>
                  <Tag>{`mode · ${result.retrieve_processor_mode}`}</Tag>
                  {effective ? (
                    <Tag color={RETRIEVE_SOURCE_META[effective.source]?.color}>
                      {`source · ${RETRIEVE_SOURCE_META[effective.source]?.label ?? effective.source}`}
                    </Tag>
                  ) : null}
                  {/* 告警可以手动关掉，但「本轮有路由降级」这个事实得留下 ——
                      契约说降级never silent，关掉不等于没发生。 */}
                  {degraded.length ? (
                    <Tag
                      color="warning"
                      title={degraded
                        .map(
                          (route) =>
                            `${pathLabel(route.retrieval_type)}：${route.reason}`,
                        )
                        .join('\n')}
                    >
                      {`${degraded.length} 条路由降级`}
                    </Tag>
                  ) : null}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  retrieve_id {result.retrieve_id}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  dtd {result.document_type_definition_ids.join(', ')}
                </Typography.Text>
                {pathCount.length ? (
                  <Space size={4} wrap>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      召回路径分布：
                    </Typography.Text>
                    {pathCount.map(([key, count]) => (
                      <Tag
                        key={key}
                        color={PIPELINE_KEY_COLOR[key] ?? 'default'}
                      >{`${pathLabel(key)} ${count}`}</Tag>
                    ))}
                    {multiHitCount ? (
                      <Tag color="gold">{`${multiHitCount} 条被多路同时命中`}</Tag>
                    ) : null}
                  </Space>
                ) : null}
                {/* 只有后端真的回了空数组才敢说「全部参与」——
                    字段缺失（老版本后端）时不下断言 */}
                {Array.isArray(result.degraded_routes) &&
                result.degraded_routes.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    全部路由均参与本轮召回（degraded_routes 为空）。
                  </Typography.Text>
                ) : null}
              </Space>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="尚未执行召回"
              />
            )}
          </Card>

          {/* 降级路由：单独一张卡挡在结果前面。
              契约明确要求调用方检查这个字段 —— 它不表示「库里就这些」，
              而是「有些路压根没上场」，结果可能不完整。
              可以手动关掉（同一轮里不再打扰），下一轮召回会重新提示。 */}
          {degraded.length && dismissedDegradedId !== result?.retrieve_id ? (
            <Alert
              type="warning"
              showIcon
              closable={{
                onClose: () =>
                  setDismissedDegradedId(result?.retrieve_id ?? null),
              }}
              title={`${degraded.length} 条路由未参与本轮召回 —— 结果可能不完整`}
              description={
                <div className={styles.degradedList}>
                  {degraded.map((route) => (
                    <div
                      key={route.document_retrieval_definition_id}
                      className={styles.degradedItem}
                    >
                      <Space size={6} wrap>
                        <Tag
                          color={
                            PIPELINE_KEY_COLOR[route.retrieval_type] ??
                            'default'
                          }
                        >
                          {pathLabel(route.retrieval_type)}
                        </Tag>
                        <Typography.Text
                          type="secondary"
                          className={styles.mono}
                        >
                          {route.document_retrieval_definition_id}
                        </Typography.Text>
                      </Space>
                      <div className={styles.hint}>{route.reason}</div>
                    </div>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    单个后端故障（Milvus 恢复中、ES 超时）刻意不让整个请求失败
                    ——
                    其他路的命中确实可召回；但降级不静默，所以在这里如实报出。
                  </Typography.Text>
                </div>
              }
            />
          ) : null}

          <Card
            size="small"
            title="召回结果"
            // 视图切换是这张卡片的**显示方式**，不是内容 —— 放卡头右上角。
            // 没有结果时不渲染：一个切不出东西的控件没必要占位。
            extra={
              results.length ? (
                <Segmented
                  size="small"
                  value={view}
                  onChange={(v) => setView(v as 'rank' | 'path')}
                  options={[
                    { label: '按 rank', value: 'rank' },
                    { label: '按路径分组', value: 'path' },
                  ]}
                />
              ) : null
            }
          >
            {results.length ? (
              view === 'rank' ? (
                results.map((r) => (
                  <ResultCard
                    key={r.document_chunk_id + String(r.rank)}
                    result={r}
                    dtdName={cache[r.document_type_definition_id]?.name}
                    maxScore={maxScore}
                  />
                ))
              ) : (
                <>
                  <div className={styles.hint} style={{ marginBottom: 10 }}>
                    一条结果若被多路命中，会<b>同时出现在多个分组</b>里 ——
                    这正是 pipeline_keys 用数组表达的东西，不是重复渲染。
                    每组可单独折叠。
                  </div>
                  <Collapse
                    size="small"
                    // 默认全展开：折叠是「按需收起」，不该先把内容藏起来
                    defaultActiveKey={grouped.map(([key]) => key)}
                    items={grouped.map(([key, list]) => ({
                      key,
                      label: (
                        <Space size={6}>
                          <Tag color={PIPELINE_KEY_COLOR[key] ?? 'default'}>
                            {pathLabel(key)}
                          </Tag>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12 }}
                          >
                            {list.length} 条
                          </Typography.Text>
                        </Space>
                      ),
                      children: list.map((r) => (
                        <ResultCard
                          key={r.document_chunk_id + String(r.rank)}
                          result={r}
                          dtdName={cache[r.document_type_definition_id]?.name}
                          maxScore={maxScore}
                        />
                      )),
                    }))}
                  />
                </>
              )
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无结果"
              />
            )}
          </Card>

          {/*/!* Agentic 占位：按约定先空置 *!/*/}
          {/*<Card size="small" title="Agentic 会话（空置）">*/}
          {/*  <div className={styles.placeholder}>*/}
          {/*    <Empty*/}
          {/*      image={Empty.PRESENTED_IMAGE_SIMPLE}*/}
          {/*      description={*/}
          {/*        <Space vertical size={4}>*/}
          {/*          <Typography.Text>*/}
          {/*            多轮 trace / 证据池 — 暂不实现*/}
          {/*          </Typography.Text>*/}
          {/*          <Typography.Text type="secondary" style={{ fontSize: 12 }}>*/}
          {/*            契约明确：单次调用即一轮召回，服务端不会进入 agent 循环。*/}
          {/*            若后续接入，由调用方（agent runtime）用 retrieve_id*/}
          {/*            串联多轮查询， 此处展示会话轨迹与跨轮去重的证据池。*/}
          {/*          </Typography.Text>*/}
          {/*        </Space>*/}
          {/*      }*/}
          {/*    />*/}
          {/*  </div>*/}
          {/*</Card>*/}
        </div>
      </div>
    </PageContainer>
  );
};

export default DocumentRetrievePage;
