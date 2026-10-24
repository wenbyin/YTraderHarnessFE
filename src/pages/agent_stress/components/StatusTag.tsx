// src/pages/agent_stress/components/StatusTag.tsx
// 状态标签集中在一处：列表、详情页头、指标区都要画同一套颜色，避免三处各写一遍。
import { Tag } from 'antd';
import React from 'react';

import type { AggregationStatus, StressRunStatus } from '../data';
import { AGGREGATION_META, STRESS_STATUS_META } from '../stressMeta';

export const StressStatusTag: React.FC<{ status: StressRunStatus }> = ({
  status,
}) => {
  const meta = STRESS_STATUS_META[status] ?? { text: status, color: 'default' };
  return <Tag color={meta.color}>{meta.text}</Tag>;
};

/**
 * 指标聚合状态。`collecting` 只会在 running / queued 出现，
 * 这时候看到的 p99 **会变**，所以文案要明确写成"聚合中"而不是"实时"。
 */
export const AggregationTag: React.FC<{ status: AggregationStatus }> = ({
  status,
}) => {
  const meta = AGGREGATION_META[status] ?? { text: status, color: 'default' };
  return <Tag color={meta.color}>{meta.text}</Tag>;
};
