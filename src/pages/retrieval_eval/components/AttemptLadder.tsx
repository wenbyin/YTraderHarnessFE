// src/pages/retrieval_eval/components/AttemptLadder.tsx
// 多轮召回阶梯（逐轮放宽）的读法：
//   ① 每轮的分母不同 —— 第 N 轮只跑第 N-1 轮没命中的那些；
//   ② 所以「第 2 轮命中率」必须连分母一起报，否则会被读成「全体命中率」；
//   ③ 用户真正要的「二次 / 三次召回率」= **各轮新增命中累加 / 全体 case**。
//
// 为什么要把这两件事分开画：
//   `hit_rate_at_k`（本轮口径）回答「这批漏网的里又救回几成」；
//   累计召回率回答「三轮下来一共找到多少」。
//   两者分母不同，混在一起看会得出「扩两轮几乎没用」的错误结论 ——
//   实际口径是「1 轮找到 37% / 3 轮找到 60%」。
import { Card, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React from 'react';
import {
  computeLadderSummary,
  curvePoints,
  type LadderRow,
  type RewriteKind,
  rewriteByAttempt,
  rewriteLabel,
} from '../attemptLadder';
import type { EvalAttemptSpec, EvalMetrics } from '../data';

const { Text } = Typography;

interface Props {
  metrics: EvalMetrics;
  /**
   * 这一轮跑测用的阶梯快照（`effective_config_snapshot.attempts`）。
   *
   * 为什么要从外面传进来：`metrics.by_attempt` 只有**结果**，没有参数 ——
   * "这一轮查的是什么"只能在快照里。少了它这张表就只能读数字，读不出
   * 「为什么第 2 轮比第 1 轮多找回 8 条」（第 2 轮换了 llm 改写）。
   *
   * 旧结果 / 单轮跑测可能没有它（快照里没写 attempts），那就整列退化成
   * 「未记录」而不是猜一个 —— 猜错了比空着更糟。
   */
  attempts?: EvalAttemptSpec[] | null;
}

const BAR_H = 22;
/** 条内要放 `70.0%` 这种文字，太窄会折行并溢出（见 StageFunnel 的同款教训）。 */
const BAR_MIN_W = 64;

function fmtPct(v?: number | null, digits = 1): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/** 比率着色：越高越好（绿 ≥90 / 橙 ≥75 / 红 <75）。 */
function rateColor(v?: number | null): string | undefined {
  if (v == null) return undefined;
  const pct = v * 100;
  return pct >= 90 ? '#3f8600' : pct >= 75 ? '#d48806' : '#cf1322';
}

/**
 * 改写档位的着色。
 *
 * 刻意**不**用「绿=好」那套：改写不是越多越好 —— `common` 免费，`llm`
 * 要花钱和一次往返，而"不改写"在有些轮次是**故意的**（内置阶梯第 3 轮
 * 就是要读精排的增量）。用颜色暗示好坏会把用户推向错误的调参方向。
 */
const REWRITE_TAG_COLOR: Record<RewriteKind, string> = {
  none: 'default',
  common: 'blue',
  llm: 'purple',
};

const AttemptLadder: React.FC<Props> = ({ metrics, attempts }) => {
  const rows = computeLadderSummary(metrics);
  const points = curvePoints(metrics);
  const total = metrics.total_cases ?? 0;
  const rewriteMap = rewriteByAttempt(attempts);
  // 快照里到底有没有 attempts —— 决定这一列是给「不改写」还是「未记录」。
  // 两者不是同一件事：前者是"跑了但没要求改写"，后者是"这份结果里没这个信息"。
  const hasSnapshot = (attempts?.length ?? 0) > 0;

  const columns: ColumnsType<LadderRow> = [
    {
      title: '轮次',
      dataIndex: 'attempt',
      width: 72,
      render: (n: number) => <Tag color="blue">第 {n} 轮</Tag>,
    },
    {
      // 「这一轮查的是什么」—— 排在指标前面，因为它是**因**，后面的数是果。
      // 逐轮放宽里「第 2 轮多救回 8 条」有一半功劳是换了改写器，不写出来
      // 这张表就只能读出"轮次越多越好"。
      title: '查询改写',
      dataIndex: 'attempt',
      key: 'rewrite',
      width: 104,
      render: (n: number) => {
        if (!hasSnapshot) {
          return <Text type="secondary">未记录</Text>;
        }
        const kind = rewriteMap[n] ?? 'none';
        return (
          <Tooltip
            title={
              kind === 'none'
                ? '这一轮不改写：query 原样发给检索（快照里没有 query_rewriter 就是「没要求改写」，**不是**继承 DTD —— 这一层没有回落）'
                : kind === 'common'
                  ? 'common：把日期展开成中文 / 短横线两种写法，正文与小标题的写法在 BM25 里是不同的词项 —— 不调模型，免费'
                  : 'llm：调一次模型按提示词改写（日期展开 + 去掉公司名这个错锚 + 加别名）。失败或超时自动退回原文并标 degraded，不算检索失败'
            }
          >
            <Tag color={REWRITE_TAG_COLOR[kind]} style={{ marginInlineEnd: 0 }}>
              {rewriteLabel(kind)}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '输入 case（分母）',
      dataIndex: 'cases',
      width: 132,
      render: (_, r) => (
        <Tooltip title="这一轮只跑上一轮未命中的 case，所以分母逐轮缩小 —— 读比率必须连它一起看">
          <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
            {r.cases}
            <Text type="secondary"> / {total}</Text>
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '占全部',
      dataIndex: 'inputShare',
      width: 88,
      render: (v: number | null) => (
        <Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtPct(v)}
        </Text>
      ),
    },
    {
      title: '本轮 Hit@1',
      dataIndex: 'hitRateAt1',
      width: 100,
      render: (v: number | null) => (
        <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(v)}</Text>
      ),
    },
    {
      title: '本轮 Hit@5',
      dataIndex: 'hitRateAt5',
      width: 100,
      render: (v: number | null) => (
        <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(v)}</Text>
      ),
    },
    {
      title: '本轮 Hit@K',
      dataIndex: 'hitRateAtK',
      width: 104,
      render: (v: number | null) => (
        <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtPct(v)}
        </Text>
      ),
    },
    {
      title: '本轮新增命中',
      dataIndex: 'hitCount',
      width: 112,
      render: (v: number, r) => (
        <Tooltip title={`第 ${r.attempt} 轮在 ${r.cases} 条里救回 ${v} 条`}>
          <Text type={v > 0 ? undefined : 'secondary'}>+{v}</Text>
        </Tooltip>
      ),
    },
    {
      title: '累计召回率',
      dataIndex: 'cumulativeRate',
      width: 112,
      render: (v: number | null, r) => (
        <Tooltip
          title={`${r.attempt} 轮内共找到 ${r.cumulativeHitCount} / ${total} 条（分母始终是全体 case）`}
        >
          <Text
            strong
            style={{ color: rateColor(v), fontVariantNumeric: 'tabular-nums' }}
          >
            {fmtPct(v)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'P95 延迟',
      dataIndex: 'p95LatencyMs',
      width: 96,
      align: 'right',
      render: (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`),
    },
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small" title="逐轮召回阶梯（逐轮放宽）">
        {rows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="本次跑测没有逐轮指标（旧结果或单轮跑测未记录 by_attempt）"
          />
        ) : (
          <>
            <Table<LadderRow>
              rowKey="key"
              size="small"
              columns={columns}
              dataSource={rows}
              pagination={false}
              // = 各列定宽之和（1020）。小于列宽之和时 antd 会**按比例放大**
              // 列（见 skill §14e），大于时右侧留一条空带 —— 两个都不好看。
              scroll={{ x: 1020 }}
            />
            <Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', marginTop: 10 }}
            >
              <Tag>口径</Tag>第 N 轮
              <Text strong>只跑第 N-1 轮没命中的 case</Text>
              ，所以「本轮
              Hit@K」的分母逐轮缩小、只回答「这批漏网的又救回几成」；
              「累计召回率」的分母<Text strong>始终是全体 {total} 条</Text>
              ，回答「N 轮下来一共找到多少」——
              两个口径不能相加，也不能互相替代。
              {hasSnapshot && (
                <>
                  <br />
                  「查询改写」列取自这次跑测的
                  <Text strong>阶梯快照</Text>
                  （指标里只有结果、没有参数）。逐轮换了改写器时，相邻两轮的
                  差里混着「改写器换了」这个变量 —— 要读某一项的净收益，
                  得给相邻两轮配同一个改写器。
                </>
              )}
            </Text>
          </>
        )}
      </Card>

      <Card size="small" title="召回率曲线（最终口径）">
        {points.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="无召回率曲线数据"
          />
        ) : (
          <>
            <Space orientation="vertical" size={6} style={{ width: '100%' }}>
              {points.map((p) => {
                const widthPct = (p.rate ?? 0) * 100;
                return (
                  <div
                    key={p.k}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      height: BAR_H,
                    }}
                  >
                    <Text
                      style={{
                        width: 56,
                        flexShrink: 0,
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      k = {p.k}
                    </Text>
                    <div
                      style={{
                        flex: 1,
                        background: 'rgba(0,0,0,0.03)',
                        borderRadius: 4,
                        height: BAR_H,
                      }}
                    >
                      <Tooltip
                        title={
                          p.meaningless
                            ? `本跑测单条最多只取回 ${metrics.retrieved_max} 条，k=${p.k} 这个点的 0 只说明「没取回来」，不说明「召回差」`
                            : `前 ${p.k} 条内命中的比例`
                        }
                      >
                        <div
                          style={{
                            width: `${Math.max(widthPct, 2)}%`,
                            minWidth: BAR_MIN_W,
                            height: BAR_H,
                            background: p.meaningless ? '#d9d9d9' : '#1677ff',
                            opacity: p.meaningless ? 1 : 0.85,
                            borderRadius: 4,
                            display: 'flex',
                            alignItems: 'center',
                            paddingLeft: 8,
                            color: p.meaningless ? 'rgba(0,0,0,0.45)' : '#fff',
                            fontSize: 12,
                            whiteSpace: 'nowrap',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {fmtPct(p.rate)}
                        </div>
                      </Tooltip>
                    </div>
                    <div
                      style={{ width: 78, textAlign: 'right', flexShrink: 0 }}
                    >
                      {p.meaningless ? (
                        <Tag
                          style={{ marginInlineEnd: 0, fontSize: 10 }}
                          color="default"
                        >
                          无意义
                        </Tag>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </Space>
            <Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', marginTop: 10 }}
            >
              曲线取自<Text strong>最终结果</Text>
              （每条 case 取命中最优的那一轮），所以与表头 Hit@K 同口径。
              线上到底喂几条给模型是部署事实，口径一变只需读另一个点、不必重跑。
              {metrics.retrieved_max != null && (
                <>
                  {' '}
                  本次单条最多取回 <Text code>{metrics.retrieved_max}</Text>{' '}
                  条； 超过它的 k 会灰显 —— 那是「根本没取回来」，不是召回差。
                </>
              )}
            </Text>
          </>
        )}
      </Card>
    </Space>
  );
};

export default AttemptLadder;
