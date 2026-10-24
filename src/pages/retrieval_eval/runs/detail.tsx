// src/pages/retrieval_eval/runs/detail.tsx
// 跑测分析页：指标总览 → gold 丢弃宏观统计 → 逐题结果 → 单 case trace 下钻。
//
// 信息架构（自上而下回答三个问题）：
//   1. 整体召回好不好？—— 指标卡 + 命中/未命中分布
//   2. gold 在哪一层丢的？—— StageFunnel（宏观）
//   3. 具体某题为什么丢？—— 点开抽屉看 StageTraceTimeline（微观）
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, useParams } from '@umijs/max';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Result,
  Row,
  Segmented,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  attemptsFromSnapshot,
  rewriteKindOf,
  rewriteLabel,
} from '../attemptLadder';
import AttemptLadder from '../components/AttemptLadder';
import { DtdTag } from '../components/DtdTagList';
import StageFunnel from '../components/StageFunnel';
import StageTraceTimeline from '../components/StageTraceTimeline';
import { JobStatusTag } from '../components/StatusTag';
import TargetChunkText from '../components/TargetChunkText';
import type {
  EvalCaseTraceResponse,
  EvalRunCase,
  EvalRunDetail,
  JobStatus,
  StageStatItem,
} from '../data';
import { useDtdOptions } from '../dtdOptions';
import { dedupeByCase } from '../runCases';
import {
  getRetrievalEvalCaseTrace,
  getRetrievalEvalRun,
  getRetrievalEvalStageStats,
  listRetrievalEvalRunCases,
} from '../service';
import { useStyles } from '../style';

const { Text } = Typography;

type HitFilter = 'all' | 'hit' | 'miss';

/** 跑测是后台任务（POST /runs 返回 202），页面自己轮询到终态。 */
const POLL_INTERVAL_MS = 3000;

/** 终态：到了就不用再轮询。 */
const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'partial_failed',
  'failed',
  'cancelled',
];

/**
 * 「逐题结果」表的横向最小宽度。
 *
 * ⚠️ 必须传给 `scroll.x`，否则宽度之和超过卡片时，`valueType:'option'`
 * 那一列（ProTable 默认 `fixed:'right'`）会**盖在**左边几列上 —— 表现就是
 * DTD 的标签和「阶段 trace」叠在同一片像素里，两行字互相穿模。
 * 定值列改宽度时记得同步 `PER_CASE_FIXED_W`。
 */
const PER_CASE_FIXED_W = 92 + 104 + 100 + 100 + 88 + 150 + 96 + 110;
/**
 * 「问题」列的最小可读宽度。
 *
 * 它是这张表上**唯一的弹性列**（没有 `width`，吃掉剩下的空间），所以这里
 * 给的不是"它的宽度"而是"横向滚动时它至少留多宽"。245 是按容器 ≈1085 反推
 * 的：1085 − 840（定值列之和）= 245，正好不触发横向滚动。
 */
const PER_CASE_QUESTION_MIN_W = 245;
const PER_CASE_TABLE_MIN_W = PER_CASE_FIXED_W + PER_CASE_QUESTION_MIN_W;

/**
 * @param evalRunIdOverride 仅独立预览构建使用：脱离路由时直接指定跑测 id。
 */
const RetrievalEvalRunDetailPage: React.FC<{ evalRunIdOverride?: string }> = ({
  evalRunIdOverride,
}) => {
  const { styles } = useStyles();
  const params = useParams<{ evalRunId: string }>();
  // 订阅 DTD 选项：拉到之后本页重渲染，DTD 列才有名字可用
  useDtdOptions();
  const evalRunId = evalRunIdOverride ?? params.evalRunId ?? '';
  const { message } = App.useApp();
  const actionRef = useRef<ActionType | undefined>(undefined);

  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [stages, setStages] = useState<StageStatItem[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [hitFilter, setHitFilter] = useState<HitFilter>('all');
  const [traceOpen, setTraceOpen] = useState(false);
  const [trace, setTrace] = useState<EvalCaseTraceResponse | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [activeCase, setActiveCase] = useState<EvalRunCase | null>(null);
  /**
   * 后端返回了同一条 case 的多行（一轮一行）时折叠掉的行数。
   *
   * 后端契约是「一条 case 一行」，折叠在服务端做；这里只为**旧版后端**兜底，
   * 顺带把「你这边跑的是旧进程」这件事告诉用户 —— 页面显示对了但分页总数
   * 仍是行数，不说清楚的话下一个疑问就是「怎么翻到第 2 页就空了」。
   */
  const [collapsedRows, setCollapsedRows] = useState(0);

  // 轮询失败会每 3s 复现一次（后端不可达时），只提示第一遍，别刷屏。
  const errorNotified = useRef(false);

  const refresh = useCallback(async () => {
    if (!evalRunId) return;
    try {
      const r = await getRetrievalEvalRun(evalRunId);
      setRun(r);
      setLoadError(false);
      errorNotified.current = false;
      const s = await getRetrievalEvalStageStats(evalRunId);
      setStages(s.stages);
    } catch {
      setLoadError(true);
      if (!errorNotified.current) {
        errorNotified.current = true;
        message.error('加载跑测详情失败');
      }
    }
  }, [evalRunId, message]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 跑测是后台任务（POST /runs 返回 202）：不轮询的话，从「发起跑测」跳进来
  // 会一直停在 queued 的空指标上，看着像这次跑测没生效。到终态就停。
  const runStatus = run?.status;
  useEffect(() => {
    if (!runStatus || TERMINAL_STATUSES.includes(runStatus)) return;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [runStatus, refresh]);

  /**
   * 上一次观察到的跑测状态。用来识别「非终态 → 终态」跨越的那一帧。
   *
   * 轮询（上面的 `refresh`）只重取顶部指标与阶段统计 —— 它**不碰**下面的
   * 「逐题结果」表。那张表是 ProTable 自己在 mount 时发一次请求，之后只有
   * 切筛选才重发（`actionRef`）。于是「跑测进行中进来 → 跑完」这条路径上，
   * 表格永远停在**刚进页面那一瞬间**的快照（那时 case 多半还没跑完，直接是
   * 空的），看起来就像逐题明细丢了 —— 明明跑测已经 completed。
   *
   * 所以要在跨过终态的那一帧补拉一次。`prev === undefined`（首次拿到状态）
   * 时不动：那一刻 ProTable 刚 mount，自己会发第一轮请求，再来一次纯属多余。
   *
   * 只补一次的前提是后端**先落库结果、再置终态**：逐轮评测在循环里逐轮写
   * `case_results`，收尾时才重算指标并 `update_run(status=completed)`
   * （见 `retrieval_eval_service_impl.py` 的 `_finalize`）。所以看到终态时
   * 结果一定已经提交，不需要"隔一会儿再补一次"。哪天后端改成先置终态再补
   * 结果，这里就得改成带重试的补拉。
   */
  const prevStatusRef = useRef<JobStatus | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = runStatus;
    if (!runStatus || prev === undefined || prev === runStatus) return;
    if (!TERMINAL_STATUSES.includes(runStatus)) return;
    // 到终态：补取一次最终结果。这里不调 `refresh()` —— 状态能变终态，正是
    // 因为上一轮 `refresh()` 刚把它读回来了，指标已经是最新的。
    actionRef.current?.reload();
    message.success('跑测已完成，已自动拉取最新逐题结果');
  }, [runStatus, message]);

  /**
   * 取某一轮的分段痕迹。
   *
   * 逐轮放宽下第 1 轮与第 3 轮**参数不同**（第 3 轮才挂精排，召回与裁剪都
   * 更宽），所以这里必须点名轮次；不点名后端给的是代表行那一轮，与列表、
   * 表头同一条 —— 默认就按代表行走，用户想换轮次再点。
   */
  const loadTrace = useCallback(
    async (record: EvalRunCase, attemptNo: number) => {
      setTraceLoading(true);
      try {
        const t = await getRetrievalEvalCaseTrace(
          evalRunId,
          record.eval_case_id,
          attemptNo,
        );
        setTrace(t);
      } finally {
        setTraceLoading(false);
      }
    },
    [evalRunId],
  );

  const openTrace = (record: EvalRunCase) => {
    setActiveCase(record);
    setTraceOpen(true);
    setTrace(null);
    // 列表里那一行的 `attempt_no` 就是代表行那一轮 —— 先看它，保持与列表、
    // 表头三处一致；`available_attempts` 回来了再让用户逐轮切。
    loadTrace(record, record.attempt_no ?? 1);
  };

  const columns: ProColumns<EvalRunCase>[] = [
    {
      title: '问题',
      dataIndex: 'question',
      ellipsis: true,
      search: false,
      render: (_, r) => (
        <Tooltip title={r.question}>
          <Text>{r.question}</Text>
        </Tooltip>
      ),
    },
    {
      title: '结果',
      dataIndex: 'gold_hit',
      width: 92,
      search: false,
      render: (_, r) =>
        r.status !== 'completed' ? (
          <Badge status="default" text="未执行" />
        ) : r.gold_hit ? (
          <Badge status="success" text="命中" />
        ) : (
          <Badge status="error" text="未命中" />
        ),
    },
    {
      // 「逐轮放宽」下这一列是必须的：表头的 Hit@K 是**最终口径**（这条 case
      // 到底找到没有），这一列回答「花了几轮才找到」。少了它，缩小的分母和
      // 扩轮的效果都看不见 —— 那条 case 在第 3 轮才命中的事实就被抹掉了。
      title: '命中轮次',
      dataIndex: 'attempt_no',
      width: 104,
      search: false,
      render: (_, r) => {
        if (r.status !== 'completed') {
          return <Text type="secondary">—</Text>;
        }
        const hit = r.gold_hit === true;
        return (
          <Tooltip
            title={
              hit
                ? `第 ${r.attempt_no} 轮救回来的：前 ${
                    r.attempt_no - 1
                  } 轮都没命中，这一轮参数更宽才召回`
                : `第 ${r.attempt_no} 轮是最后跑的一轮（逐轮放宽，第 N 轮只跑第 N-1 轮没命中的）`
            }
          >
            <Tag
              color={hit ? 'green' : 'default'}
              style={{ margin: 0 }}
            >{`第 ${r.attempt_no} 轮`}</Tag>
          </Tooltip>
        );
      },
    },
    {
      // 「这一行用的是原句还是改写句」。
      //
      // 为什么必须有：逐轮阶梯里每轮的改写器不同，而**大模型改写不可复现** ——
      // 「这条命中的是哪句话」事后只能靠这个字段回答。少了它，看到一条第 2 轮
      // 救回来的 case 就无从判断"是改写起作用了，还是召回条数放宽起作用了"。
      //
      // 值不铺全文（96px 放不下），只说状态 + tooltip 看全文；全文在 trace
      // 抽屉里有独立一项，且会**随轮次切换**（每一轮的实际查询不同）。
      title: '实际查询',
      dataIndex: 'query_text',
      width: 100,
      search: false,
      render: (v, r) => {
        const q = typeof v === 'string' ? v : null;
        // 没回带 或 与问题相同 → 都是「原文」。改写器可以把 query 原样返回
        // （changed=false），那是"改了没改动"，与"没开改写"在**读数上**
        // 没有区别 —— 所以不硬分，界面上都说「原文」。
        if (!q || q === r.question) {
          return (
            <Tooltip title="这一行代表的那一轮没有改动 query：发给检索的就是题干原句">
              <Text type="secondary">原文</Text>
            </Tooltip>
          );
        }
        return (
          <Tooltip title={q}>
            <Tag color="purple" style={{ margin: 0 }}>
              已改写
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'gold rank',
      dataIndex: 'gold_rank',
      width: 100,
      search: false,
      render: (v) => {
        // 未命中时后端给的是 `null`。这里**不能**直接 `<Tag>#{v}</Tag>`：
        // 那样会渲染出一个内容为 "#-"（或 "#"、甚至 "无标签"）的空标签，
        // 看起来像"名次是横杠"这个真实取值。非数字一律退化成纯文本。
        const rank = typeof v === 'number' ? v : Number(v);
        if (v == null || !Number.isFinite(rank) || rank <= 0) {
          return <Text type="secondary">—</Text>;
        }
        return <Tag color={rank <= 5 ? 'green' : 'orange'}>{`#${rank}`}</Tag>;
      },
    },
    {
      title: 'gold 数',
      dataIndex: 'gold_chunk_ids',
      width: 88,
      search: false,
      render: (_, r) => (
        <Tag color="gold" style={{ margin: 0 }}>
          ★ {r.gold_chunk_ids.length}
        </Tag>
      ),
    },
    {
      title: 'DTD',
      dataIndex: 'document_type_definition_id',
      width: 150,
      search: false,
      // 复用同一个标签实现（截断 + tooltip 看全称），别在这里再抄一份样式
      render: (v) => <DtdTag id={v as string} maxWidth={120} />,
    },
    {
      title: '延迟',
      dataIndex: 'latency_ms',
      width: 96,
      search: false,
      align: 'right',
      render: (v) => (v == null ? '—' : `${v} ms`),
    },
    {
      title: '操作',
      valueType: 'option',
      width: 110,
      render: (_, r) => [
        <Typography.Link key="t" onClick={() => openTrace(r)}>
          阶段 trace
        </Typography.Link>,
      ],
    },
  ];

  if (!run) {
    return (
      <PageContainer>
        {loadError ? (
          <Result
            status="warning"
            title="跑测拉不到详情"
            subTitle={`跑测 ${evalRunId.slice(0, 8)}… 不存在或后端不可达 —— 它可能已被删除。`}
            extra={
              <Space>
                <Button onClick={refresh}>重试</Button>
                <Button
                  type="primary"
                  onClick={() => history.push('/retrieval-eval/runs')}
                >
                  返回跑测列表
                </Button>
              </Space>
            }
          />
        ) : (
          <Card loading />
        )}
      </PageContainer>
    );
  }

  const m = run.metrics;
  // 阶梯快照（每轮的参数）—— 阶梯表与 trace 抽屉两处都要用，取一次。
  const ladderAttempts = attemptsFromSnapshot(run.effective_config_snapshot);
  // 当前这一轮用的是哪个改写器。抽屉里标出来："这份痕迹是哪句话跑出来的"
  // 与"读的是哪一轮"一样重要 —— 第 1 轮只做日期展开、第 2 轮调了模型。
  const traceRewriteKind = ladderAttempts.length
    ? rewriteKindOf(
        ladderAttempts[(trace?.attempt_no ?? 1) - 1]?.query_rewriter,
      )
    : null;

  return (
    <PageContainer
      title={
        <Space>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/retrieval-eval/runs')}
          />
          <span>跑测分析</span>
          <JobStatusTag status={run.status} />
          {!TERMINAL_STATUSES.includes(run.status) && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              每 {POLL_INTERVAL_MS / 1000}s 自动刷新
            </Text>
          )}
        </Space>
      }
      extra={[
        <Button
          key="r"
          icon={<ReloadOutlined />}
          // 「刷新」是整页语义：指标、阶段统计、逐题结果一起刷。
          // 只 refresh() 不 reload 的话，用户手动刷新后表里还是旧数据。
          onClick={() => {
            refresh();
            actionRef.current?.reload();
          }}
        >
          刷新
        </Button>,
      ]}
      breadcrumb={{
        items: [
          { title: '评测' },
          { title: '召回跑测', href: '/retrieval-eval/runs' },
          { title: `跑测 ${evalRunId.slice(0, 8)}…` },
        ],
      }}
    >
      {/* ---------- 指标总览 ---------- */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="Hit@1"
              value={
                m.hit_rate_at_1 == null
                  ? '-'
                  : +(m.hit_rate_at_1 * 100).toFixed(1)
              }
              suffix="%"
              styles={{ content: { fontSize: 22 } }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="Hit@5"
              value={
                m.hit_rate_at_5 == null
                  ? '-'
                  : +(m.hit_rate_at_5 * 100).toFixed(1)
              }
              suffix="%"
              styles={{ content: { fontSize: 22 } }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" style={{ borderColor: '#1677ff' }}>
            <Statistic
              title="Hit@K（最终口径）"
              value={
                m.hit_rate_at_k == null
                  ? '-'
                  : +(m.hit_rate_at_k * 100).toFixed(1)
              }
              suffix="%"
              styles={{ content: { fontSize: 22, color: '#1677ff' } }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="MRR@K"
              value={m.mrr_at_k == null ? '-' : +m.mrr_at_k.toFixed(4)}
              styles={{ content: { fontSize: 22 } }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="命中 / 未命中"
              value={m.hit_count}
              suffix={`/ ${m.miss_count}`}
              styles={{ content: { fontSize: 22 } }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="P50 / P95 延迟"
              value={m.p50_latency_ms ?? '-'}
              suffix={`/ ${m.p95_latency_ms ?? '-'} ms`}
              styles={{ content: { fontSize: 20 } }}
            />
          </Card>
        </Col>
      </Row>

      {/* ---------- 逐轮召回阶梯 + 召回率曲线 ---------- */}
      {/*
        表头那几个数回答的是「最终找到没」（每条 case 取最好的一轮，
        后端 `collapse_by_case`）；这里回答「哪一轮救回来的」。
        两个口径必须都看得到 —— 只看表头会以为扩轮没用，只看逐轮又会
        把缩小的分母当全体。
      */}
      <div style={{ marginBottom: 16 }}>
        <h3 className={styles.sectionTitle}>多轮召回（逐轮放宽）</h3>
        {/* 阶梯快照里的 attempts 决定「这一轮查的是什么」—— 指标里没有参数，
            所以必须从快照取（旧结果可能没有，那一列会显示「未记录」）。 */}
        <AttemptLadder metrics={m} attempts={ladderAttempts} />
      </div>

      {/* ---------- 配置快照 ---------- */}
      {/*<Card size="small" title="生效配置快照" style={{ marginBottom: 16 }}>*/}
      {/*  <Descriptions column={4} size="small">*/}
      {/*    <Descriptions.Item label="bundle">*/}
      {/*      <Text className={styles.mono}>{run.bundle_id.slice(0, 8)}…</Text>*/}
      {/*    </Descriptions.Item>*/}
      {/*    <Descriptions.Item label="max_k">{run.max_k}</Descriptions.Item>*/}
      {/*    <Descriptions.Item label="阶段 trace">*/}
      {/*      {run.include_stage_trace ? (*/}
      {/*        <Tag color="success">已开启</Tag>*/}
      {/*      ) : (*/}
      {/*        <Tag>关闭</Tag>*/}
      {/*      )}*/}
      {/*    </Descriptions.Item>*/}
      {/*    <Descriptions.Item label="用例总数">*/}
      {/*      {run.total_cases}*/}
      {/*    </Descriptions.Item>*/}
      {/*    /!* 失败数与未命中必须分开看：前者是检索挂了（故障），后者是召回不行*/}
      {/*        （质量问题）。混成一个数会让「后端超时」读起来像「召回变差」。 *!/*/}
      {/*    <Descriptions.Item label="完成 / 执行失败">*/}
      {/*      {run.completed_cases} /{' '}*/}
      {/*      {run.failed_cases > 0 ? (*/}
      {/*        <Text type="danger">{run.failed_cases}</Text>*/}
      {/*      ) : (*/}
      {/*        run.failed_cases*/}
      {/*      )}*/}
      {/*    </Descriptions.Item>*/}
      {/*    <Descriptions.Item label="整体配置" span={4}>*/}
      {/*      <Space size={4} wrap>*/}
      {/*        {Object.entries(run.effective_config_snapshot).map(([k, v]) => (*/}
      {/*          <Tag key={k}>*/}
      {/*            {k}: {String(v)}*/}
      {/*          </Tag>*/}
      {/*        ))}*/}
      {/*      </Space>*/}
      {/*    </Descriptions.Item>*/}
      {/*  </Descriptions>*/}
      {/*  <Text type="secondary" style={{ fontSize: 12 }}>*/}
      {/*    结果口径：gold_hit = 该题任一 validated gold chunk_id 出现在最终 max_k*/}
      {/*    结果内； gold_rank*/}
      {/*    取其最优名次。未命中与「执行失败」分开统计，不混为一谈。*/}
      {/*  </Text>*/}
      {/*</Card>*/}

      {/* ---------- 宏观丢弃统计 ---------- */}
      <div style={{ marginBottom: 16 }}>
        <h3 className={styles.sectionTitle}>gold chunk 丢弃宏观统计</h3>
        <StageFunnel stages={stages} />
      </div>

      {/* ---------- 逐题结果 ---------- */}
      <h3 className={styles.sectionTitle}>
        逐题结果
        {/* 跑测没结束时表格是空的（case 还没跑完），必须说明「不是没数据，
            是还没跑完，跑完会自动拉」—— 否则用户会把它当成 bug。 */}
        {!TERMINAL_STATUSES.includes(run.status) && (
          <Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}
          >
            跑测进行中，完成后自动拉取
          </Text>
        )}
      </h3>
      <div style={{ marginBottom: 12 }}>
        <Segmented
          value={hitFilter}
          onChange={(v) => {
            setHitFilter(v as HitFilter);
            actionRef.current?.reload();
          }}
          options={[
            { label: '全部', value: 'all' },
            { label: '仅命中', value: 'hit' },
            { label: '仅未命中', value: 'miss' },
          ]}
        />
      </div>
      {/* 旧版后端（按「结果行」分页）才会触发：提示，但不掩盖。 */}
      {collapsedRows > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`同一条 case 收到多行，已折叠 ${collapsedRows} 行展示`}
        />
      )}
      <ProTable<EvalRunCase>
        rowKey="eval_case_id"
        actionRef={actionRef}
        columns={columns}
        request={async (params) => {
          const res = await listRetrievalEvalRunCases(evalRunId, {
            page: params.current,
            page_size: params.pageSize,
            hit: hitFilter === 'all' ? undefined : hitFilter === 'hit',
          });
          // 契约上后端已经折叠成「一条 case 一行」，这里再折一次只是兜底：
          // 新后端下它是恒等变换，旧后端下页面至少是可读的。
          const { rows, collapsed } = dedupeByCase(res.items);
          setCollapsedRows((prev) => (prev === collapsed ? prev : collapsed));
          return { data: rows, total: res.total, success: true };
        }}
        search={false}
        options={false}
        pagination={{ defaultPageSize: 20 }}
        // 见 PER_CASE_TABLE_MIN_W：没有它，右侧固定的操作列会盖住 DTD 列。
        scroll={{ x: PER_CASE_TABLE_MIN_W }}
      />

      {/* ---------- 单 case trace 抽屉 ---------- */}
      <Drawer
        title="阶段 trace · 逐层追踪 gold chunk"
        size={880}
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
        destroyOnHidden
      >
        {activeCase && (
          <Card size="small" style={{ marginBottom: 16 }}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="问题" span={2}>
                <Text strong>{activeCase.question}</Text>
              </Descriptions.Item>
              {/*
                「实际发给检索的那句话」放在问题**正下方**：这两行的差异
                就是改写做的事，挨着放才读得出「改写把哪部分动了」。
                取 `trace` 而不是 `activeCase` 的 —— 抽屉里能逐轮切换，而
                **每一轮的实际查询不同**（第 1 轮日期展开、第 2 轮大模型改写）。
                `??` 兜底是为了 trace 还在加载时先用列表那一行的值顶一下。
              */}
              <Descriptions.Item label="实际查询" span={2}>
                {(() => {
                  const q = trace?.query_text ?? activeCase.query_text ?? null;
                  if (!q || q === activeCase.question) {
                    return (
                      <Text type="secondary">原文（这一轮没有改动 query）</Text>
                    );
                  }
                  return (
                    <Space size={8} align="start">
                      <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                        已改写
                      </Tag>
                      <Text code style={{ wordBreak: 'break-all' }}>
                        {q}
                      </Text>
                    </Space>
                  );
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="gold chunk_ids" span={2}>
                <Space size={4} wrap>
                  {activeCase.gold_chunk_ids.map((g) => (
                    <Tag key={g} color="gold" className={styles.mono}>
                      ★ {g.slice(0, 8)}…
                    </Tag>
                  ))}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="结果">
                {activeCase.gold_hit ? (
                  <Badge
                    status="success"
                    text={`命中，gold rank ${
                      activeCase.gold_rank == null
                        ? '—'
                        : `#${activeCase.gold_rank}`
                    }`}
                  />
                ) : (
                  <Badge status="error" text="未命中" />
                )}
              </Descriptions.Item>
              <Descriptions.Item label="命中轮次">
                <Text>
                  {activeCase.gold_hit
                    ? `第 ${activeCase.attempt_no} 轮救回`
                    : `第 ${activeCase.attempt_no} 轮（最后跑的一轮）`}
                </Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        )}

        {/*
          「这颗金标到底写了什么」放在 case 信息卡**正下方**：上面那张卡的
          最后一行就是 gold chunk_ids（一串 UUID），紧接着给正文，
          「为什么没召回」当场就能对上 —— 是语义不匹配，还是正文里压根
          没有这种说法。放到 trace 时间线下面就被 7 张阶段卡隔开了。

          取 `trace` 的 gold ids 而不是 `activeCase` 的：两者本该相同，
          但 trace 才是这份痕迹自己认定的金标；trace 还没回来时先用列表
          那一行顶一下（id 相同，不会因此重取正文）。
        */}
        {activeCase && (
          <TargetChunkText
            chunkIds={trace?.gold_chunk_ids ?? activeCase.gold_chunk_ids}
          />
        )}

        {traceLoading ? (
          <Card loading />
        ) : trace ? (
          <>
            {/*
              逐轮放宽下第 1 轮和第 3 轮**参数不同**（第 3 轮才挂精排、召回与
              裁剪都更宽）。不标轮次的话下面这份痕迹会被读成「这条 case 的
              检索过程」，而它只是「这一轮的检索过程」。
            */}
            <div style={{ marginBottom: 12 }}>
              <Space wrap>
                <Text type="secondary">这份痕迹来自：</Text>
                {trace.available_attempts.length > 1 ? (
                  <Segmented
                    size="small"
                    value={trace.attempt_no}
                    onChange={(v) =>
                      loadTrace(activeCase as EvalRunCase, v as number)
                    }
                    options={trace.available_attempts.map((n) => ({
                      label: `第 ${n} 轮`,
                      value: n,
                    }))}
                  />
                ) : (
                  <Tag color="blue" style={{ margin: 0 }}>
                    第 {trace.attempt_no} 轮
                  </Tag>
                )}
                {/* 这一轮用的是哪个改写器 —— 不标出来会把"第 1 轮只展开日期"
                    与"第 2 轮调了模型"读成同一件事。快照里没记录时（旧结果）
                    整块不显示，而不是猜一个。 */}
                {traceRewriteKind && (
                  <Tooltip
                    title={
                      traceRewriteKind === 'none'
                        ? '这一轮的阶梯快照里没有 query_rewriter = 这一轮没要求改写'
                        : `这一轮的阶梯快照里 ${traceRewriteKind} 改写：下面这份痕迹就是拿改后的文本跑的`
                    }
                  >
                    <Tag
                      color={traceRewriteKind === 'none' ? 'default' : 'purple'}
                      style={{ margin: 0 }}
                    >
                      改写：{rewriteLabel(traceRewriteKind)}
                    </Tag>
                  </Tooltip>
                )}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  每轮只跑上一轮未命中的 case
                </Text>
              </Space>
            </div>
            <StageTraceTimeline
              stages={trace.stages}
              goldChunkIds={trace.gold_chunk_ids}
            />
          </>
        ) : (
          <Empty description="无 trace 数据" />
        )}
      </Drawer>
    </PageContainer>
  );
};

// Alert 已在上方 import
export default RetrievalEvalRunDetailPage;
