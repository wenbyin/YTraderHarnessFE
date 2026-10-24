// src/pages/agent_stress/components/RunMetrics.tsx
//
// 指标区：全部来自 `GET /stress-runs/{id}/metrics` 的**单次快照**，
// 不在前端二次聚合 —— 分位数没法从分位数再算出来，前端只负责排版。
//
// v2 的口径是「会话 × 轮次」，所以分七块，顺序按「先看结论、再看细分」：
//   1. 会话计数（建没建成、跑没跑满、完成率）
//   2. 轮次计数（成没成、慢不慢、错多少）
//   3. 会话维度分布（会话时长、抽到的 N、实际发起的 N）
//   4. 轮次时延分布（全部 / 首轮 / 后续轮 / 首段输出）
//   5. 按轮次序号（turn_index）看上下文增长带来的劣化
//   6. 模型调用（次数、重试、token 量、每轮 token）
//   7. 节点 / 工具 / 扇出 / 摄取（谁是大头、数据可不可信）
//
// ⚠️ 两个「别搞混」：
//   · `sessions.turns_per_session` 是**实际发起**的轮数（abort / 截断会小于
//     `sampled_turns_per_session`），两个分布摆在一起才能看出"少跑了多少"；
//   · `turns.completed = succeeded + failed`，**不含** timed_out / cancelled
//     （后端刻意单列），所以「已完成」不一定等于「已发起」。
import {
  Card,
  Col,
  Descriptions,
  Empty,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React from 'react';

import type { StressRunMetrics, StressRunStatus } from '../data';
import {
  formatInt,
  formatPercent,
  formatRate,
  formatTokens,
  turnIndexRows,
} from '../stressMeta';
import { useStyles } from '../style';
import { DistributionTable } from './DistributionTable';

const { Text } = Typography;

type Tone = 'default' | 'success' | 'error' | 'warning';

interface MetricTileProps {
  label: string;
  value: React.ReactNode;
  unit?: string;
  tone?: Tone;
}

const MetricTile: React.FC<MetricTileProps> = ({
  label,
  value,
  unit,
  tone = 'default',
}) => {
  const { styles } = useStyles();
  const toneClass =
    tone === 'success'
      ? styles.metricValueSuccess
      : tone === 'error'
        ? styles.metricValueError
        : tone === 'warning'
          ? styles.metricValueWarning
          : '';
  return (
    <Card size="small" className={styles.metricCard}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={`${styles.metricValue} ${toneClass}`}>
        {value}
        {unit ? <span className={styles.metricUnit}>{unit}</span> : null}
      </div>
    </Card>
  );
};

const TileGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Row gutter={[12, 12]}>{children}</Row>
);

const Tile: React.FC<{ span?: number; children: React.ReactNode }> = ({
  span = 3,
  children,
}) => (
  <Col xs={12} sm={8} md={6} xl={span}>
    {children}
  </Col>
);

/** 按轮次序号（turn_index）看时延 —— 只列实际出现过的序号。 */
const TurnIndexTable: React.FC<{
  rows: {
    index: number;
    dist: {
      count?: number;
      mean?: number | null;
      p50?: number | null;
      p95?: number | null;
    };
  }[];
}> = ({ rows }) => {
  const columns: ColumnsType<(typeof rows)[number]> = [
    {
      title: '轮次',
      dataIndex: 'index',
      key: 'index',
      width: 88,
      render: (value: number) => <Text>第 {value} 轮</Text>,
    },
    {
      title: '样本',
      key: 'count',
      width: 88,
      align: 'right',
      render: (_, row) => formatInt(row.dist.count),
    },
    {
      title: 'p50',
      key: 'p50',
      width: 120,
      align: 'right',
      render: (_, row) => formatMsCell(row.dist.p50),
    },
    {
      title: 'p95',
      key: 'p95',
      width: 120,
      align: 'right',
      render: (_, row) => formatMsCell(row.dist.p95),
    },
    {
      title: '均值',
      key: 'mean',
      width: 120,
      align: 'right',
      render: (_, row) => formatMsCell(row.dist.mean),
    },
  ];

  return (
    <Table
      size="small"
      rowKey="index"
      columns={columns}
      dataSource={rows}
      pagination={false}
      // ⚠️ 不要加 scroll.y：antd 会把表头/表体拆成两张表，auto 布局下两份列宽
      // 各算一遍，表头（p50）与数值（1.55 s）会左右错开。轮次最多 30 行，
      // 直接铺开更好读。
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="没有按轮次分组的样本"
          />
        ),
      }}
    />
  );
};

/** 表格里的毫秒单元格：千分位会盖掉量级，统一走 formatMs。 */
function formatMsCell(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export interface RunMetricsProps {
  metrics?: StressRunMetrics | null;
  status: StressRunStatus;
}

export const RunMetrics: React.FC<RunMetricsProps> = ({ metrics, status }) => {
  const { styles } = useStyles();
  const sessions = metrics?.sessions ?? {};
  const turns = metrics?.turns ?? {};
  const model = metrics?.model ?? {};
  const rate = turns.error_rate ?? null;

  const nodes = Object.entries(metrics?.nodes ?? {}).map(([name, dist]) => ({
    key: `node-${name}`,
    label: name,
    dist,
  }));
  const tools = Object.entries(metrics?.tools ?? {}).map(([name, dist]) => ({
    key: `tool-${name}`,
    label: name,
    dist,
  }));

  const traceCounts = Object.entries(metrics?.trace_counts ?? {});
  const indexRows = turnIndexRows(turns.by_index);

  // 排队时后端还没有任何事件，全是 0；给一句人话比一排 0 好
  const waiting = status === 'queued';

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {/* ---------------- 1. 会话 ---------------- */}
      <Card
        size="small"
        title="会话"
        extra={
          waiting ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              尚未出队，暂无会话
            </Text>
          ) : null
        }
      >
        <TileGrid>
          <Tile span={4}>
            <MetricTile label="已发起" value={formatInt(sessions.started)} />
          </Tile>
          <Tile span={4}>
            <MetricTile
              label="已完成"
              value={formatInt(sessions.completed)}
              tone={(sessions.completed ?? 0) > 0 ? 'success' : 'default'}
            />
          </Tile>
          <Tile span={4}>
            <MetricTile
              label="失败"
              value={formatInt(sessions.failed)}
              tone={(sessions.failed ?? 0) > 0 ? 'error' : 'default'}
            />
          </Tile>
          <Tile span={4}>
            <MetricTile
              label="提前结束"
              value={formatInt(sessions.abandoned)}
              tone={(sessions.abandoned ?? 0) > 0 ? 'warning' : 'default'}
            />
          </Tile>
          <Tile span={4}>
            <MetricTile
              label="完成率"
              value={formatPercent(sessions.completion_rate)}
              tone={
                sessions.completion_rate != null &&
                sessions.completion_rate < 0.99
                  ? 'warning'
                  : 'default'
              }
            />
          </Tile>
          <Tile span={4}>
            <MetricTile
              label="达成会话速率"
              value={formatRate(sessions.achieved_sessions_per_second)}
              unit="个/s"
            />
          </Tile>
        </TileGrid>
        <Text type="secondary" style={{ fontSize: 12 }}>
          已发起 = 建会话尝试次数（含失败）；提前结束 = 因时长 / 取消 /
          轮次上限被截断的会话。
        </Text>
      </Card>

      {/* ---------------- 2. 轮次 ---------------- */}
      <Card size="small" title="轮次">
        <TileGrid>
          <Tile>
            <MetricTile label="已发起" value={formatInt(turns.started)} />
          </Tile>
          <Tile>
            <MetricTile label="已完成" value={formatInt(turns.completed)} />
          </Tile>
          <Tile>
            <MetricTile
              label="成功"
              value={formatInt(turns.succeeded)}
              tone={(turns.succeeded ?? 0) > 0 ? 'success' : 'default'}
            />
          </Tile>
          <Tile>
            <MetricTile
              label="失败"
              value={formatInt(turns.failed)}
              tone={(turns.failed ?? 0) > 0 ? 'error' : 'default'}
            />
          </Tile>
          <Tile>
            <MetricTile
              label="超时"
              value={formatInt(turns.timed_out)}
              tone={(turns.timed_out ?? 0) > 0 ? 'warning' : 'default'}
            />
          </Tile>
          <Tile>
            <MetricTile label="已取消" value={formatInt(turns.cancelled)} />
          </Tile>
          <Tile>
            <MetricTile
              label="达成轮次速率"
              value={formatRate(turns.achieved_turns_per_second)}
              unit="轮/s"
            />
          </Tile>
          <Tile>
            <MetricTile
              label="错误率"
              value={formatPercent(rate)}
              tone={rate !== null && rate > 0.01 ? 'error' : 'default'}
            />
          </Tile>
        </TileGrid>
        <Text type="secondary" style={{ fontSize: 12 }}>
          已完成 = 成功 + 失败；超时与取消单列，不重复计入。错误率 =（失败 +
          超时）/ 已发起，不含取消。
        </Text>
      </Card>

      {/* ---------------- 3. 会话维度分布 ---------------- */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="会话时长">
            <DistributionTable
              series={[
                {
                  key: 'session-duration',
                  label: '建立 → 结束',
                  dist: sessions.duration_ms,
                },
              ]}
              emptyText="还没有跑完的会话"
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title="每会话轮数"
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                抽样 vs 实际
              </Text>
            }
          >
            <DistributionTable
              unit="raw"
              series={[
                {
                  key: 'sampled',
                  label: '抽到的 N',
                  dist: sessions.sampled_turns_per_session,
                },
                {
                  key: 'actual',
                  label: '实际发起',
                  dist: sessions.turns_per_session,
                },
              ]}
              emptyText="还没有会话样本"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              两个分布差距大 = 有会话被 abort / 取消 / 轮次上限截断了。
            </Text>
          </Card>
        </Col>
      </Row>

      {/* ---------------- 4. 轮次时延 ---------------- */}
      <Card size="small" title="轮次时延分布">
        <DistributionTable
          series={[
            { key: 'latency', label: '全部轮次', dist: turns.latency_ms },
            {
              key: 'first-turn',
              label: '会话首轮',
              dist: turns.first_turn_latency_ms,
            },
            {
              key: 'later-turn',
              label: '第 2 轮及以后',
              dist: turns.later_turn_latency_ms,
            },
            {
              key: 'ttft',
              label: '首段输出（TTFO）',
              dist: turns.time_to_first_output_ms,
            },
          ]}
        />
      </Card>

      {/* ---------------- 5. 按轮次序号 ---------------- */}
      <Card
        size="small"
        title="按轮次序号看时延"
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            上下文随轮次增长，劣化会体现在这里
          </Text>
        }
      >
        <TurnIndexTable rows={indexRows} />
      </Card>

      {/* ---------------- 6. 模型调用 ---------------- */}
      <Card size="small" title="模型调用">
        <TileGrid>
          <Tile span={6}>
            <MetricTile label="调用次数" value={formatInt(model.call_count)} />
          </Tile>
          <Tile span={6}>
            <MetricTile label="重试" value={formatInt(model.retry_count)} />
          </Tile>
          <Tile span={6}>
            <MetricTile
              label="调用错误"
              value={formatInt(model.error_count)}
              tone={(model.error_count ?? 0) > 0 ? 'error' : 'default'}
            />
          </Tile>
          <Tile span={6}>
            <MetricTile
              label="Token（输入 / 输出）"
              value={`${formatTokens(model.input_tokens_sum)} / ${formatTokens(
                model.output_tokens_sum,
              )}`}
            />
          </Tile>
        </TileGrid>
        <div style={{ marginTop: 12 }}>
          <DistributionTable
            series={[
              {
                key: 'model-duration',
                label: '单次调用耗时',
                dist: model.duration_ms,
              },
            ]}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <DistributionTable
            unit="raw"
            series={[
              {
                key: 'input-per-turn',
                label: '每轮输入 token',
                dist: model.input_tokens_per_turn,
              },
              {
                key: 'output-per-turn',
                label: '每轮输出 token',
                dist: model.output_tokens_per_turn,
              },
            ]}
            emptyText="没有按轮统计的 token 样本"
          />
        </div>
      </Card>

      {/* ---------------- 7. 节点 / 工具 ---------------- */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="节点耗时">
            <DistributionTable
              series={nodes}
              compact
              emptyText="没有节点 span"
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="工具耗时">
            <DistributionTable
              series={tools}
              compact
              emptyText="本轮没有工具调用"
            />
          </Card>
        </Col>
      </Row>

      {/* ---------------- 8. 扇出 / 摄取 ---------------- */}
      <Card size="small" title="扇出 / 事件摄取">
        <Row gutter={[24, 16]}>
          <Col xs={24} lg={12}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              扇出
            </Text>
            <Descriptions
              size="small"
              column={3}
              style={{ marginTop: 8 }}
              items={[
                {
                  key: 'fanout-count',
                  label: '次数',
                  children: formatInt(metrics?.fanout?.count),
                },
                {
                  key: 'branch',
                  label: '分支',
                  children: formatInt(metrics?.fanout?.branch_count),
                },
                {
                  key: 'failed-branch',
                  label: '失败分支',
                  children: (
                    <Text
                      type={
                        (metrics?.fanout?.failed_branch_count ?? 0) > 0
                          ? 'danger'
                          : undefined
                      }
                    >
                      {formatInt(metrics?.fanout?.failed_branch_count)}
                    </Text>
                  ),
                },
              ]}
            />
          </Col>
          <Col xs={24} lg={12}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              事件摄取质量
            </Text>
            <Descriptions
              size="small"
              column={2}
              style={{ marginTop: 8 }}
              items={[
                {
                  key: 'seen',
                  label: '收到事件',
                  children: formatInt(metrics?.ingestion?.events_seen),
                },
                {
                  key: 'dedup',
                  label: '去重',
                  children: formatInt(metrics?.ingestion?.events_deduplicated),
                },
                {
                  key: 'unmatched',
                  label: '未匹配',
                  children: formatInt(metrics?.ingestion?.events_unmatched),
                },
                {
                  key: 'late',
                  label: '迟到',
                  children: formatInt(metrics?.ingestion?.events_late),
                },
              ]}
            />
          </Col>
        </Row>

        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            trace 计数（按类型）
          </Text>
          <div style={{ marginTop: 8 }}>
            {traceCounts.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无 trace 上报"
              />
            ) : (
              <Space size={[8, 8]} wrap>
                {traceCounts.map(([key, value]) => (
                  <Tag key={key} className={styles.mono}>
                    {key} · {formatInt(value)}
                  </Tag>
                ))}
              </Space>
            )}
          </div>
        </div>
      </Card>
    </Space>
  );
};
