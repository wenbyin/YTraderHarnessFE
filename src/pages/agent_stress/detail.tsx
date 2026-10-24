// src/pages/agent_stress/detail.tsx
//
// 压测详情：配置（不可变）+ 指标（会变）。
//
// 三条来自契约的行为：
//   · `metrics` 是**快照**：running 时 `aggregation_status=collecting`，数字会涨；
//     进入终态后才可能转 `final`（失败 / 取消会是 `incomplete`）。
//   · 状态是 `queued → running → completed|failed|cancelled`，终态之后不再变，
//     所以轮询只在「未终态」或「指标还在 collecting」时继续。
//   · 取消返回 202（受理，不是已取消），且是**协作式**的：接口返回不代表在飞
//     轮次已停，要继续轮询 /metrics 直到 `finalized_at` 有值。
//
// v2 的展示重点从「请求」换成了「会话 × 轮次」：
//   · 一次 Run 里有 N 个会话，每个会话串行跑 N_i 轮（截断正态抽样）；
//   · 所以「计划多少」和「实际发起多少」是两个数（抽到的 N vs turns_per_session）。
import { ReloadOutlined, StopOutlined, SyncOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { history, useParams } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Divider,
  Popconfirm,
  Progress,
  Result,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useEffect, useMemo, useState } from 'react';

import { RunMetrics } from './components/RunMetrics';
import { AggregationTag, StressStatusTag } from './components/StatusTag';
import type { StressRun, StressRunMetrics } from './data';
import {
  cancelStressRun,
  getStressRun,
  getStressRunMetrics,
  stressErrorMessage,
  stressErrorStatus,
  USE_MOCK_STRESS,
} from './service';
import {
  CLEANUP_OPTIONS,
  elapsedSeconds,
  expectedTurns,
  formatInt,
  formatMs,
  formatPercent,
  formatRate,
  formatSeconds,
  isTerminal,
  loadDetail,
  ON_HITL_OPTIONS,
  ON_TURN_FAILURE_OPTIONS,
  runProgress,
  SIMULATED_ALGORITHM,
  turnCountLabel,
} from './stressMeta';
import { useStyles } from './style';

const { Text } = Typography;

const fmtTime = (value?: string | null) =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—';

/** 把 stressMeta 里的 options 取成中文标签（详情页不显示 abort / keep 这种原值）。 */
function labelOf(
  options: readonly { value: string; label: string }[],
  value: string | undefined,
): string {
  if (!value) return '—';
  return options.find((item) => item.value === value)?.label ?? value;
}

const Step: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <Text type="secondary" style={{ fontSize: 12 }}>
      {label}
    </Text>
    <div>{children}</div>
  </div>
);

const AgentStressDetailPage: React.FC = () => {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const { runId } = useParams<{ runId: string }>();

  const [run, setRun] = useState<StressRun | null>(null);
  const [metrics, setMetrics] = useState<StressRunMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const [nextRun, nextMetrics] = await Promise.all([
          getStressRun(runId),
          // 指标 404 不该把整页打成错误页：配置还在，先让用户看到配置
          getStressRunMetrics(runId).catch(() => null),
        ]);
        if (!alive) return;
        setRun(nextRun);
        setMetrics(nextMetrics);
        setError(null);
        setNow(Date.now());
        const stillCollecting =
          nextMetrics?.aggregation_status === 'collecting';
        if (autoRefresh && (!isTerminal(nextRun.status) || stillCollecting)) {
          timer = setTimeout(load, 3000);
        }
      } catch (err) {
        if (!alive) return;
        if (stressErrorStatus(err) === 404) setNotFound(true);
        else setError(stressErrorMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, autoRefresh, tick]);

  // 进度条按秒走：只在未终态时需要，终态就停掉这个定时器
  useEffect(() => {
    if (!run || isTerminal(run.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.status, run?.started_at]);

  const progress = useMemo(() => (run ? runProgress(run, now) : 0), [run, now]);

  const handleCancel = async () => {
    if (!runId) return;
    setCancelling(true);
    try {
      await cancelStressRun(runId);
      message.success('已请求取消（202）；Runner 会把在飞轮次停掉并定稿指标');
      setTick((v) => v + 1);
    } catch (err) {
      if (stressErrorStatus(err) === 409) {
        message.warning('这次跑测已经结束，无需取消');
        setTick((v) => v + 1);
      } else {
        message.error(stressErrorMessage(err));
      }
    } finally {
      setCancelling(false);
    }
  };

  if (notFound) {
    return (
      <Result
        status="404"
        title="跑测不存在"
        subTitle={runId ? `run_id = ${runId}` : undefined}
        extra={
          <Button type="primary" onClick={() => history.push('/agent-stress')}>
            返回压测列表
          </Button>
        }
      />
    );
  }

  const title = run?.name?.trim()
    ? run.name
    : run
      ? `未命名 · ${run.run_id.slice(0, 8)}`
      : '压测详情';

  const terminal = run ? isTerminal(run.status) : false;
  const remaining = run
    ? Math.max(0, run.config.duration_seconds - elapsedSeconds(run, now))
    : 0;

  const sessions = metrics?.sessions;
  const turns = metrics?.turns;

  return (
    <PageContainer
      title={title}
      subTitle={
        run
          ? `${run.config.session.agent_id} · ${loadDetail(run.config.load)}`
          : undefined
      }
      onBack={() => history.push('/agent-stress')}
      tags={
        run ? (
          <Space size={6} wrap>
            <StressStatusTag status={run.status} />
            {metrics ? (
              <AggregationTag status={metrics.aggregation_status} />
            ) : null}
            {/* 后端 simulated-v1：状态是真的，指标是推导出来的 —— 必须显式标出 */}
            {metrics?.aggregation_algorithm === SIMULATED_ALGORITHM ? (
              <Tooltip title="后端 aggregation_algorithm = simulated-v1：指标由压测参数推导，不是真实请求的统计结果，不能当容量结论用。">
                <Tag color="gold">模拟指标</Tag>
              </Tooltip>
            ) : null}
            {USE_MOCK_STRESS ? <Tag color="gold">本地模拟</Tag> : null}
          </Space>
        ) : undefined
      }
      extra={[
        <Space key="actions" size={8} wrap>
          <Space size={6}>
            <Switch
              size="small"
              checked={autoRefresh}
              onChange={setAutoRefresh}
              disabled={
                terminal && metrics?.aggregation_status !== 'collecting'
              }
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              自动刷新
            </Text>
          </Space>
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={() => setTick((v) => v + 1)}
          >
            刷新
          </Button>
          {/* ⚠️ 必须包 {}：写在 JSX children 里的裸三目会被当成**文本**，
              里面的 <Popconfirm> 则变成无条件渲染 —— 终态也会冒出「取消跑测」 */}
          {run && !terminal ? (
            <Popconfirm
              title="取消这次压测？"
              description="停止接纳新会话与新轮次，在飞轮次尽力取消；指标会定稿为 incomplete（保留已采集部分）。"
              okText="取消跑测"
              cancelText="继续跑"
              okButtonProps={{ danger: true }}
              onConfirm={handleCancel}
            >
              <Button
                danger
                size="small"
                icon={<StopOutlined />}
                loading={cancelling}
              >
                取消跑测
              </Button>
            </Popconfirm>
          ) : null}
        </Space>,
      ]}
    >
      {loading && !run ? <Skeleton active paragraph={{ rows: 8 }} /> : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          className={styles.section}
          title="拉取失败"
          description={error}
          action={
            <Button size="small" onClick={() => setTick((v) => v + 1)}>
              重试
            </Button>
          }
        />
      ) : null}

      {run?.status === 'failed' ? (
        <Alert
          type="error"
          showIcon
          className={styles.section}
          title={
            <Space size={8}>
              <span>跑测失败</span>
              {run.error_code ? (
                <Tag color="error" className={styles.mono}>
                  {run.error_code}
                </Tag>
              ) : null}
            </Space>
          }
          description={run.error_message ?? '后端没有给出 error_message'}
        />
      ) : null}

      {run ? (
        <>
          <Card size="small" className={styles.section}>
            <div className={styles.hero}>
              <Text strong>
                {run.status === 'queued' ? '排队中，等待调度' : null}
                {run.status === 'running' ? '运行中' : null}
                {terminal ? '已结束' : null}
              </Text>
              <span className={styles.heroMeta}>
                {/* 终态用 finished_at - started_at，别拿 now 去减（见 elapsedSeconds） */}
                {run.status === 'queued'
                  ? '已等待'
                  : terminal
                    ? '运行时长'
                    : '已运行'}{' '}
                {formatSeconds(elapsedSeconds(run, now))}
                {run.status === 'running'
                  ? ` / 计划 ${formatSeconds(run.config.duration_seconds)}，剩余约 ${formatSeconds(remaining)}`
                  : null}
              </span>
              {run.status === 'running' && sessions?.started != null ? (
                <span className={styles.heroMeta}>
                  会话 {formatInt(sessions.completed)}/
                  {formatInt(sessions.started)}
                  {sessions.achieved_sessions_per_second != null
                    ? ` · ${formatRate(sessions.achieved_sessions_per_second)} 个/s`
                    : ''}
                  {' · '}轮次 {formatInt(turns?.completed)}/
                  {formatInt(turns?.started)}
                  {turns?.achieved_turns_per_second != null
                    ? ` · ${formatRate(turns.achieved_turns_per_second)} 轮/s`
                    : ''}
                  {' · '}错误率 {formatPercent(turns?.error_rate)}
                </span>
              ) : null}
            </div>
            <Progress
              percent={Math.round(progress)}
              status={
                run.status === 'running'
                  ? 'active'
                  : run.status === 'failed'
                    ? 'exception'
                    : 'normal'
              }
              style={{ marginTop: 8, marginBottom: 0 }}
            />
            {metrics?.aggregation_status === 'collecting' && !terminal ? (
              <Text className={styles.aggHint}>
                <SyncOutlined spin style={{ marginRight: 6 }} />
                指标持续聚合中 —— 这里的分位数会随事件流入变化，结束后才定型。
              </Text>
            ) : null}
            {metrics?.aggregation_status === 'incomplete' ? (
              <Text className={styles.aggHint}>
                跑测没有正常跑满全程（失败或提前取消），指标只代表已采集部分。
              </Text>
            ) : null}
          </Card>

          <div className={styles.section}>
            <RunMetrics metrics={metrics} status={run.status} />
          </div>

          <Card size="small" title="运行配置">
            <Descriptions
              size="small"
              column={2}
              items={[
                {
                  key: 'run_id',
                  label: 'run_id',
                  children: (
                    <Text
                      className={styles.mono}
                      copyable={{ text: run.run_id }}
                    >
                      {run.run_id}
                    </Text>
                  ),
                },
                {
                  key: 'agent_id',
                  label: 'Agent',
                  children: (
                    <Text className={styles.mono}>
                      {run.config.session.agent_id}
                    </Text>
                  ),
                },
                {
                  key: 'base_url',
                  label: '被测服务',
                  span: 2,
                  children: (
                    <Text
                      className={styles.mono}
                      copyable={{ text: run.config.target.base_url }}
                    >
                      {run.config.target.base_url}
                    </Text>
                  ),
                },
                {
                  key: 'auth',
                  label: '鉴权',
                  children: run.config.auth?.token_env ? (
                    <Space size={6}>
                      <Tag>{run.config.auth.type}</Tag>
                      <Text className={styles.mono}>
                        ${run.config.auth.token_env}
                      </Text>
                    </Space>
                  ) : (
                    <Text type="secondary">由服务端配置提供</Text>
                  ),
                },
                {
                  key: 'load',
                  label: '负载',
                  children: loadDetail(run.config.load),
                },
                {
                  key: 'duration',
                  label: '持续时长',
                  children: formatSeconds(run.config.duration_seconds),
                },
                {
                  key: 'warmup',
                  label: '预热 / 爬坡',
                  children: `${formatSeconds(run.config.warmup_seconds ?? 0)} / ${formatSeconds(
                    run.config.ramp_up_seconds ?? 0,
                  )}`,
                },
                {
                  key: 'timeout',
                  label: '单轮超时',
                  children: formatMs(run.config.request_timeout_ms),
                },
                {
                  key: 'think',
                  label: '轮间停顿',
                  children: formatMs(run.config.session.think_time_ms ?? 0),
                },
                {
                  key: 'total_sessions',
                  label: '会话总数',
                  children:
                    run.config.total_sessions != null ? (
                      <Space size={6}>
                        <span>{formatInt(run.config.total_sessions)}</span>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          计划总轮次 ≈{formatInt(expectedTurns(run.config))}
                        </Text>
                      </Space>
                    ) : (
                      '不限（由时长与负载决定）'
                    ),
                },
                {
                  key: 'max_turns',
                  label: '轮次上限',
                  children:
                    run.config.max_turns != null
                      ? `${formatInt(run.config.max_turns)} 轮`
                      : '不限制',
                },
                {
                  key: 'seed',
                  label: '随机种子',
                  children:
                    run.config.seed != null
                      ? String(run.config.seed)
                      : '未指定',
                },
                {
                  key: 'created',
                  label: '创建时间',
                  children: fmtTime(run.created_at),
                },
                {
                  key: 'started',
                  label: '开始时间',
                  children: fmtTime(run.started_at),
                },
                {
                  key: 'finished',
                  label: '结束时间',
                  children: fmtTime(run.finished_at),
                },
              ]}
            />

            <Divider titlePlacement="start">会话策略</Divider>
            <Descriptions
              size="small"
              column={3}
              items={[
                {
                  key: 'turns',
                  label: '每会话轮数 N',
                  children: turnCountLabel(run.config.session.turns),
                },
                {
                  key: 'rounding',
                  label: '取整',
                  children: run.config.session.turns.rounding ?? 'round',
                },
                {
                  key: 'on_turn_failure',
                  label: '某轮失败后',
                  children: labelOf(
                    ON_TURN_FAILURE_OPTIONS,
                    run.config.session.on_turn_failure,
                  ),
                },
                {
                  key: 'on_hitl',
                  label: '遇到审批',
                  children: labelOf(
                    ON_HITL_OPTIONS,
                    run.config.session.on_hitl,
                  ),
                },
                {
                  key: 'cleanup',
                  label: '会话清理',
                  children: labelOf(
                    CLEANUP_OPTIONS,
                    run.config.session.cleanup,
                  ),
                },
                {
                  key: 'input_size',
                  label: '合成输入长度',
                  children:
                    run.config.turn?.input_size_chars != null
                      ? `${formatInt(run.config.turn.input_size_chars)} 字符`
                      : '—',
                },
                {
                  key: 'streaming',
                  label: '流式消费',
                  children:
                    run.config.turn?.streaming === false ? '关闭' : '开启',
                },
                {
                  key: 'metadata',
                  label: '会话 metadata',
                  children: Object.keys(run.config.session.metadata ?? {})
                    .length
                    ? Object.keys(run.config.session.metadata ?? {}).join('、')
                    : '—',
                },
              ]}
            />

            <Divider titlePlacement="start">模拟模型</Divider>
            <Descriptions
              size="small"
              column={3}
              items={[
                {
                  key: 'profile',
                  label: '档位',
                  children: run.config.mock_model.profile ?? '—',
                },
                {
                  key: 'base',
                  label: '基础时延',
                  children: formatMs(run.config.mock_model.base_latency_ms),
                },
                {
                  key: 'jitter',
                  label: '抖动',
                  children: formatMs(
                    run.config.mock_model.latency_jitter_ms ?? 0,
                  ),
                },
                {
                  key: 'ttft',
                  label: '首 token',
                  children: formatMs(run.config.mock_model.ttft_ms),
                },
                {
                  key: 'tokens',
                  label: '输出 token',
                  children: `${formatInt(
                    run.config.mock_model.output_tokens_min,
                  )} ~ ${formatInt(run.config.mock_model.output_tokens_max)}`,
                },
                {
                  key: 'tps',
                  label: '生成速度',
                  children: `${run.config.mock_model.tokens_per_second} token/s`,
                },
                {
                  key: 'error',
                  label: '错误率',
                  children: formatPercent(
                    run.config.mock_model.error_rate ?? 0,
                  ),
                },
                {
                  key: 'timeout_rate',
                  label: '超时率',
                  children: formatPercent(
                    run.config.mock_model.timeout_rate ?? 0,
                  ),
                },
                {
                  key: 'chunk',
                  label: '流式分片',
                  children: `${formatInt(
                    run.config.mock_model.stream_chunk_tokens ?? 1,
                  )} token/片`,
                },
                {
                  key: 'inflight',
                  label: '替身并发上限',
                  children:
                    run.config.mock_model.max_inflight_requests != null
                      ? formatInt(run.config.mock_model.max_inflight_requests)
                      : '不限制',
                },
                {
                  key: 'algorithm',
                  label: '聚合算法',
                  children: metrics?.aggregation_algorithm ?? '—',
                },
                {
                  key: 'finalized',
                  label: '指标定型时间',
                  children: fmtTime(metrics?.finalized_at),
                },
              ]}
            />

            <Divider titlePlacement="start">input_template</Divider>
            {run.config.turn?.input_template ? (
              <pre className={styles.codeBlock}>
                {JSON.stringify(run.config.turn.input_template, null, 2)}
              </pre>
            ) : (
              <Text type="secondary">
                未提供，Runner 按「合成输入长度」生成每轮文本。
              </Text>
            )}

            <Divider titlePlacement="start">端点路径</Divider>
            <Descriptions
              size="small"
              column={2}
              items={(
                [
                  ['create_session_path', '建会话'],
                  ['create_run_path', '提交单轮 Run'],
                  ['run_events_path', 'SSE 事件流'],
                  ['cancel_run_path', '取消单轮'],
                  ['resume_run_path', 'HITL 恢复'],
                  ['delete_session_path', '删除会话'],
                ] as const
              ).map(([key, label]) => ({
                key,
                label,
                children: (
                  <Text className={styles.mono}>
                    {run.config.target[key] ?? '—'}
                  </Text>
                ),
              }))}
            />
          </Card>

          <div style={{ marginTop: 12 }}>
            <Space size={16} wrap>
              <Step label="状态迁移">
                <Text type="secondary">
                  queued → running →{' '}
                  {run.status === 'failed' ? 'failed' : 'completed / cancelled'}
                </Text>
              </Step>
              <Step label="trace 明细">
                <Text type="secondary">
                  留在 Redis（TTL），本页只能看到聚合计数 ——
                  这是设计边界，不是缺功能。
                </Text>
              </Step>
            </Space>
          </div>
        </>
      ) : null}
    </PageContainer>
  );
};

export default AgentStressDetailPage;
