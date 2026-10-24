// src/pages/retrieval_eval/components/StageFunnel.tsx
// 宏观统计可视化：gold chunk 在流水线各阶段的数量留存（漏斗）+ 丢弃原因堆叠条。
//
// 为什么用「漏斗 + 原因条」而不是普通柱状图：
//   gold_present_before → gold_present_after 是单调递减的留存过程，
//   用户真正关心的是「哪一级掉了多少、因为什么」——所以留存画成漏斗宽度，
//   原因画成横向堆叠条，两图共用同一 stage 顺序，垂直对齐便于对照。
//
// ⚠️ 布局铁律：**每一行都必须一样高、每一行都不许折行**。
// 这张图是靠「等距的行」来读的 —— 只要有一行因为文字放不下而折成两行，
// 行距就出现断口（看着像折痕），而且那一行的条会被挤到旁边去，
// 与上下行的条对不上。历史上就踩过两次：
//   ① 标签列 150px 装不下 `召回 · 稠密向量` + `dense_vector` 标签 → 折成两行；
//   ② `recall` 行条宽 2%（约 25px），条内 `0 / 5` 折成两行并溢出条外。
// 所以这里：标签列定宽 + nowrap、条给最小宽度、行给固定高度。
import { Card, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import React from 'react';
import type { StageStatItem } from '../data';
import { DROP_REASON_META } from '../mockData';
import { sortStagesByExecution } from '../stageOrder';

const { Text } = Typography;

interface Props {
  stages: StageStatItem[];
}

/** 标签列总宽。两张卡片共用，保证上下两张卡的条目起点对齐（差几像素就会像错位）。 */
const LABEL_W = 200;
/**
 * 标签文字自身占的定宽。
 * 文字与 `source_key` 标签**各自一列**：如果让它们自由流动，
 * `dense_vector` 与 `keyword` 两个标签会跟在长短不同的文字后面，横坐标对不齐。
 */
const LABEL_TEXT_W = 110;
const BAR_H = 22;
/**
 * 条的最小宽度。条里要放 `34 / 39` 这种文字，条太窄会让它折行并溢出 ——
 * 宁可让极小的值显示成一小段（并在 tooltip 里给准确数字），也不能让文字炸出去。
 */
const BAR_MIN_W = 60;

const STAGE_LABEL: Record<string, string> = {
  'recall.dense_vector': '召回 · 稠密向量',
  'recall.keyword': '召回 · 关键词',
  fusioner: '融合 Fusioner',
  filter: '过滤 Filter',
  reranker: '重排 Reranker',
  cutter: '截断 Cutter',
};

/** 标签列：定宽 + 单行。两张卡片共用同一个组件，避免各写各的宽度。 */
const StageLabel: React.FC<{ stageKey: string; sourceKey?: string }> = ({
  stageKey,
  sourceKey,
}) => (
  <div
    style={{
      width: LABEL_W,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
    }}
  >
    <Text
      style={{
        fontSize: 12,
        width: LABEL_TEXT_W,
        flexShrink: 0,
        // 不换行是硬要求；万一将来出现更长的 stage_key，省略号兜底，
        // 也好过让它把整行的行高顶起来。
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      title={STAGE_LABEL[stageKey] ?? stageKey}
    >
      {STAGE_LABEL[stageKey] ?? stageKey}
    </Text>
    {sourceKey ? (
      <Tag
        color="purple"
        style={{ marginInlineEnd: 0, fontSize: 10, whiteSpace: 'nowrap' }}
      >
        {sourceKey}
      </Tag>
    ) : null}
  </div>
);

const StageFunnel: React.FC<Props> = ({ stages: rawStages }) => {
  if (!rawStages?.length) return <Empty description="暂无阶段统计" />;

  // ⚠️ 后端是**按 stage_key 字母序**返回的（repository 里 order_by stage_key），
  // 直接渲染会得到 cutter → filter → fusioner → recall → … → reranker，
  // 看着像"流水线顺序"，实际是排序产物。这里换成真实执行顺序。
  const stages = sortStagesByExecution(rawStages);

  // 以「最早阶段的最大 gold 数」作为漏斗宽度基准
  const baseline = Math.max(
    ...stages.map(
      (s) => s.gold_present_before_count || s.gold_present_after_count,
    ),
    1,
  );
  // 各阶段所有 drop_reason 的并集
  const reasons = Array.from(
    new Set(stages.flatMap((s) => Object.keys(s.drop_reason_counts ?? {}))),
  );

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small" title="gold chunk 阶段留存漏斗">
        <Space orientation="vertical" size={6} style={{ width: '100%' }}>
          {stages.map((s) => {
            const after = s.gold_present_after_count;
            const before = s.gold_present_before_count;
            const widthPct = (after / baseline) * 100;
            const isBranch = s.source_key !== '';
            return (
              <div
                key={`${s.stage_key}-${s.source_key}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  // 固定行高：等距是本图可读性的前提，不能由内容决定
                  height: BAR_H,
                }}
              >
                <StageLabel stageKey={s.stage_key} sourceKey={s.source_key} />
                <div
                  style={{
                    flex: 1,
                    background: 'rgba(0,0,0,0.03)',
                    borderRadius: 4,
                    height: BAR_H,
                  }}
                >
                  <Tooltip
                    title={`进入前 ${before} → 离开后 ${after}；本阶段丢弃 ${s.gold_drop_count}`}
                  >
                    <div
                      style={{
                        width: `${Math.max(widthPct, 2)}%`,
                        minWidth: BAR_MIN_W,
                        height: BAR_H,
                        background: isBranch ? '#9254de' : '#1677ff',
                        opacity: 0.85,
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        paddingLeft: 8,
                        color: '#fff',
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                        transition: 'width .4s',
                      }}
                    >
                      {after} / {s.observed_cases}
                    </div>
                  </Tooltip>
                </div>
                <div
                  style={{
                    width: 78,
                    textAlign: 'right',
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.gold_drop_count > 0 ? (
                    <Text type="danger" style={{ fontSize: 12 }}>
                      −{s.gold_drop_count}
                    </Text>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      0
                    </Text>
                  )}
                </div>
              </div>
            );
          })}
        </Space>
        <Text
          type="secondary"
          style={{ fontSize: 12, display: 'block', marginTop: 10 }}
        >
          条形长度 = 该阶段结束后仍存在的 gold 数 / 观测用例数。
          <Text code>recall.*</Text> 为并行召回分支： 某分支未召回 gold
          只是「分支 miss」，只要另一分支召回到就不算最终丢失。
          极小的值会显示成一小段（条有最小宽度以容纳数字），准确数值见 tooltip。
        </Text>
      </Card>

      <Card size="small" title="各阶段丢弃原因分布">
        {reasons.length === 0 ? (
          <Text type="secondary">该跑测未发生 gold 丢弃。</Text>
        ) : (
          <Space orientation="vertical" size={8} style={{ width: '100%' }}>
            {stages
              .filter((s) => Object.keys(s.drop_reason_counts ?? {}).length > 0)
              .map((s) => (
                <div
                  key={`r-${s.stage_key}-${s.source_key}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: BAR_H,
                  }}
                >
                  <StageLabel stageKey={s.stage_key} sourceKey={s.source_key} />
                  <Space size={4} wrap>
                    {Object.entries(s.drop_reason_counts).map(
                      ([reason, count]) => {
                        const m = DROP_REASON_META[reason] ?? {
                          text: reason,
                          color: 'default',
                        };
                        return (
                          <Tag key={reason} color={m.color}>
                            {m.text} × {count}
                          </Tag>
                        );
                      },
                    )}
                  </Space>
                </div>
              ))}
          </Space>
        )}
        <Text
          type="secondary"
          style={{ fontSize: 12, display: 'block', marginTop: 10 }}
        >
          归因规则：只有当 gold 在该阶段
          <Text strong>进入前存在、离开后消失</Text>时，才把丢弃算到该阶段；
          进入前就不存在则标记为「不适用」，不重复归因。
        </Text>
      </Card>
    </Space>
  );
};

export default StageFunnel;
