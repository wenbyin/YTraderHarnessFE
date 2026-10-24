// src/pages/retrieval_eval/components/StatusTag.tsx
// 统一的状态标签：bundle 状态 / job 状态。映射表来自 mock 的 META，避免多处硬编码颜色。
import { Tag } from 'antd';
import React from 'react';

import { BUNDLE_STATUS_META, JOB_STATUS_META } from '../mockData';

export const BundleStatusTag: React.FC<{ status: string }> = ({ status }) => {
  const meta = BUNDLE_STATUS_META[status] ?? { text: status, color: 'default' };
  return <Tag color={meta.color}>{meta.text}</Tag>;
};

export const JobStatusTag: React.FC<{ status: string }> = ({ status }) => {
  const meta = JOB_STATUS_META[status] ?? { text: status, color: 'default' };
  return <Tag color={meta.color}>{meta.text}</Tag>;
};
