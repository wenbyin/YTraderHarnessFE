// src/pages/agent_stress/components/DistributionTable.tsx
//
// 一条 Distribution 就是「一组样本的分位数」。压测里要比的是**同一指标在不同
// series 上**的尾巴（端到端 vs 首 token；planner vs llm_call），所以固定成
// 「series 做行、分位数做列」，多行摆在一起一眼能看出谁重。

import { Empty, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React from 'react';

import type { Distribution } from '../data';
import { formatInt, formatMs } from '../stressMeta';

export interface DistributionSeries {
  key: string;
  label: string;
  dist?: Distribution | null;
}

export interface DistributionTableProps {
  series: DistributionSeries[];
  /** ms：按毫秒格式化；raw：只做千分位（计数类分布） */
  unit?: 'ms' | 'raw';
  /** 半宽卡片里只留 样本 / p50 / p95 / p99，否则 8 列会挤成一坨 */
  compact?: boolean;
  emptyText?: string;
}

const STAT_KEYS = ['p50', 'p90', 'p95', 'p99'] as const;

export const DistributionTable: React.FC<DistributionTableProps> = ({
  series,
  unit = 'ms',
  compact = false,
  emptyText = '暂无样本',
}) => {
  const fmt = (value: number | null | undefined) =>
    unit === 'ms' ? formatMs(value) : formatInt(value);

  const statColumn = (
    key: (typeof STAT_KEYS)[number] | 'mean' | 'min' | 'max',
  ) => ({
    title:
      key === 'mean'
        ? '均值'
        : key === 'min'
          ? '最小'
          : key === 'max'
            ? '最大'
            : key,
    key,
    // 84 是给「1.50 min」这种最长值留的；半宽卡片里 8 列会撑破卡片，收到 72
    width: 72,
    align: 'right' as const,
    render: (_: unknown, row: DistributionSeries) => (
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {fmt(row.dist?.[key])}
      </span>
    ),
  });

  const columns: ColumnsType<DistributionSeries> = [
    {
      title: '指标',
      dataIndex: 'label',
      key: 'label',
      width: 120,
      ellipsis: true,
    },
    {
      title: '样本',
      key: 'count',
      width: 64,
      align: 'right',
      render: (_, row) => formatInt(row.dist?.count),
    },
    ...(compact
      ? ([
          statColumn('p50'),
          statColumn('p95'),
          statColumn('p99'),
        ] as ColumnsType<DistributionSeries>)
      : ([
          ...STAT_KEYS.map((key) => statColumn(key)),
          statColumn('mean'),
          statColumn('min'),
          statColumn('max'),
        ] as ColumnsType<DistributionSeries>)),
  ];

  return (
    <Table<DistributionSeries>
      size="small"
      rowKey="key"
      columns={columns}
      dataSource={series}
      pagination={false}
      // 兜底：容器比表还窄时横向滚动，别让最后一列被卡片裁掉
      scroll={{ x: 'max-content' }}
      locale={{
        emptyText: (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
        ),
      }}
    />
  );
};
