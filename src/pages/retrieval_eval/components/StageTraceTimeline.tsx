// src/pages/retrieval_eval/components/StageTraceTimeline.tsx
// 分析侧核心组件：单 case 的分阶段 trace 时间线。
//
// 设计要点（严格对齐 schema.sql 与 codegen prompt 的口径）：
//   1. 每个阶段展示 top5 候选 + 各自 score，但**分数只在同阶段内可比**
//      （score_name / score_direction 必须随分数一起展示，禁止跨阶段比大小）。
//   2. gold chunk 在「进入前存在 → 离开后消失」时，才把丢弃归因给该阶段；
//      进入前就不存在 → 该阶段对该 gold 标记 not_applicable，不背锅。
//   3. 并行召回分支（dense / keyword）互相独立：dense 未召回只是分支 miss。
//   4. 被 score_threshold 丢掉的 gold 即使不在 top5 也必须保留展示（红色行）。
import { Card, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React from 'react';
import type { CaseTraceStage, ScoredChunkCandidate } from '../data';
import { DROP_REASON_META } from '../mockData';
import { sortStagesByExecution } from '../stageOrder';
import { useStyles } from '../style';

const { Text } = Typography;

interface Props {
  stages: CaseTraceStage[];
  goldChunkIds: string[];
}

const shortId = (id: string) => `${id.slice(0, 8)}…`;

/** 判断该阶段是否把 gold 弄丢了（存在→消失）。 */
function dropAttribution(stage: CaseTraceStage): 'dropped' | 'kept' | 'na' {
  // gold_present_before/after 是**阶段级**布尔标记，不是逐 gold 的 map，
  // 因此不需要拿 goldIds 再 some 一遍（那样还会让 biome 报未使用参数）。
  const before = !!stage.gold_present_before;
  const after = !!stage.gold_present_after;
  if (!before) return 'na'; // 进来前就没有 → 不归此阶段
  return after ? 'kept' : 'dropped';
}

const StageTraceTimeline: React.FC<Props> = ({ stages, goldChunkIds }) => {
  const { styles } = useStyles();

  // ⚠️ 后端 trace 是按 stage_key **字母序**返回的（repository 里 order_by stage_key），
  // 直接渲染会把流水线读成 cutter → filter → fusioner → … → reranker。
  // 这是一条"时间线"，顺序错了比数字错了更误导，所以按真实执行顺序重排。
  const orderedStages = sortStagesByExecution(stages);

  if (!orderedStages.length)
    return (
      <Empty description="无 trace 数据（include_stage_trace 为 false）" />
    );

  return (
    <div className={styles.traceRail}>
      {orderedStages.map((stage, idx) => {
        const verdict = dropAttribution(stage);
        const goldInCandidates = stage.top_candidates.some((c) =>
          goldChunkIds.includes(c.chunk_id),
        );

        const columns: ColumnsType<ScoredChunkCandidate> = [
          {
            title: 'Rank',
            dataIndex: 'rank',
            width: 62,
            render: (v: number) => <Text strong>{v}</Text>,
          },
          {
            title: 'chunk_id',
            dataIndex: 'chunk_id',
            width: 130,
            render: (id: string) => {
              const isGold = goldChunkIds.includes(id);
              return (
                <Tooltip title={id}>
                  <Text
                    className={styles.mono}
                    style={
                      isGold ? { color: '#d48806', fontWeight: 600 } : undefined
                    }
                  >
                    {isGold && '★ '}
                    {shortId(id)}
                  </Text>
                </Tooltip>
              );
            },
          },
          {
            title: '分数',
            dataIndex: 'score',
            width: 92,
            align: 'right',
            render: (v: number | null) =>
              v == null ? (
                <Text type="secondary">-</Text>
              ) : (
                <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {v.toFixed(4)}
                </Text>
              ),
          },
          {
            title: 'score_name / 方向',
            dataIndex: 'score_name',
            width: 178,
            render: (_, r) => (
              <Space
                size={4}
                orientation="vertical"
                style={{ lineHeight: 1.3 }}
              >
                <Tag color="blue" style={{ margin: 0 }}>
                  {r.score_name ?? '-'}
                </Tag>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {r.score_direction === 'higher_is_better'
                    ? '越大越好'
                    : r.score_direction === 'lower_is_better'
                      ? '越小越好'
                      : '不可比'}
                </Text>
              </Space>
            ),
          },
          {
            title: '状态',
            dataIndex: 'selected',
            width: 110,
            render: (_, r) => {
              if (r.drop_reason) {
                const m = DROP_REASON_META[r.drop_reason] ?? {
                  text: r.drop_reason,
                  color: 'default',
                };
                return <Tag color={m.color}>{m.text}</Tag>;
              }
              return <Tag color="success">保留</Tag>;
            },
          },
        ];

        const verdictTag =
          verdict === 'dropped' ? (
            <Tag color="error">gold 在此阶段被丢弃</Tag>
          ) : verdict === 'kept' ? (
            <Tag color="success">gold 通过</Tag>
          ) : (
            <Tag>gold 未进入 / 不适用</Tag>
          );

        return (
          <div key={`${stage.stage_key}-${stage.source_key}`}>
            <Card
              size="small"
              title={
                <Space size={8} wrap>
                  <Text strong>{stage.stage_key}</Text>
                  {stage.source_key && (
                    <Tag color="purple">分支: {stage.source_key}</Tag>
                  )}
                  {verdictTag}
                </Space>
              }
              extra={
                <Space size={12} style={{ fontSize: 12 }}>
                  <Text type="secondary">
                    输入 {stage.input_count ?? '-'} → 输出{' '}
                    {stage.output_count ?? '-'}
                  </Text>
                  {stage.drop_reason && (
                    <Tag
                      color={
                        DROP_REASON_META[stage.drop_reason]?.color ?? 'default'
                      }
                    >
                      丢弃原因：
                      {DROP_REASON_META[stage.drop_reason]?.text ??
                        stage.drop_reason}
                    </Tag>
                  )}
                </Space>
              }
            >
              {/* gold 在进入/离开本阶段的 rank 与分数 */}
              {Object.keys(stage.gold_ranks_before ?? {}).length > 0 ||
              Object.keys(stage.gold_ranks_after ?? {}).length > 0 ? (
                <div style={{ marginBottom: 8, fontSize: 12 }}>
                  {goldChunkIds.map((g) => {
                    const rb = stage.gold_ranks_before?.[g];
                    const ra = stage.gold_ranks_after?.[g];
                    const sb = stage.gold_scores_before?.[g];
                    const sa = stage.gold_scores_after?.[g];
                    if (
                      rb === undefined &&
                      ra === undefined &&
                      sb === undefined &&
                      sa === undefined
                    )
                      return null;
                    return (
                      <div key={g} style={{ marginBottom: 2 }}>
                        <Text
                          className={styles.mono}
                          style={{ color: '#d48806' }}
                        >
                          ★ {shortId(g)}
                        </Text>
                        <Text type="secondary">
                          {' '}
                          进入 rank {rb ?? '-'}（score {sb ?? '-'}）→ 离开 rank{' '}
                          {ra ?? '-'}（score {sa ?? '-'}）
                        </Text>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <Table<ScoredChunkCandidate>
                size="small"
                rowKey={(r) => `${r.chunk_id}-${r.rank}`}
                columns={columns}
                dataSource={stage.top_candidates}
                pagination={false}
                tableLayout="fixed"
                rowClassName={(r) => {
                  if (goldChunkIds.includes(r.chunk_id)) {
                    return r.drop_reason ? styles.droppedRow : styles.goldRow;
                  }
                  return '';
                }}
              />
              {!goldInCandidates && verdict === 'dropped' && (
                <Text
                  type="danger"
                  style={{ fontSize: 12, display: 'block', marginTop: 6 }}
                >
                  注意：gold 不在本阶段 top5
                  内，但因其被分数阈值丢弃而额外保留（仅 score_threshold
                  场景会追加）。
                </Text>
              )}
            </Card>

            {idx < orderedStages.length - 1 && (
              <div className={styles.stageArrow}>↓</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default StageTraceTimeline;
