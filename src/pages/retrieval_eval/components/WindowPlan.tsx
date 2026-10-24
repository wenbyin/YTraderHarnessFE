// src/pages/retrieval_eval/components/WindowPlan.tsx
// 生成侧核心组件：把「N 个 chunk × M 个问题 ÷ L 个窗口」的切分方案可视化。
//
// 为什么单独做这个组件：
//   需求里最容易出问题的是「拆分请求」这一层 —— chunks_per_window (L) 与
//   max_input_tokens 是**两个独立约束**，谁先命中谁生效。用户需要一眼看出
//   每个窗口塞了几个 chunk、token 估算是否逼近上限、哪些窗口失败可重试。
import { Alert, App, Card, Space, Tag, Tooltip, Typography } from 'antd';
import React from 'react';

import type { GenerationRunDetail } from '../data';
import { useStyles } from '../style';

const { Text } = Typography;

/** 单个窗口的 token 估算阈值（与后端 max_input_tokens 对照，此处仅做视觉预警）。 */
const TOKEN_WARN_RATIO = 0.85;

interface Props {
  run: GenerationRunDetail;
  /** 单窗口 token 预算，用于画占用条 */
  maxInputTokens?: number;
  onRetry?: () => void;
}

const WindowPlan: React.FC<Props> = ({
  run,
  maxInputTokens = 12000,
  onRetry,
}) => {
  const { styles } = useStyles();
  const { message } = App.useApp();

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <span>窗口切分方案</span>
          <Tag color="blue">
            L ={' '}
            {run.total_chunks && run.total_windows
              ? Math.ceil(run.total_chunks / run.total_windows)
              : '-'}{' '}
            chunk / 窗
          </Tag>
          <Tag>共 {run.total_windows} 窗</Tag>
          <Tag color="success">完成 {run.completed_windows}</Tag>
          {run.failed_windows > 0 && (
            <Tag color="error">失败 {run.failed_windows}</Tag>
          )}
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      {run.failed_windows > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`${run.failed_windows} 个窗口生成失败`}
          description={run.error_message}
          action={
            <a
              onClick={() => {
                if (onRetry) {
                  onRetry();
                  return;
                }
                message.info('将重试失败窗口（幂等，不重复生成已验证用例）');
              }}
            >
              重试失败窗口
            </a>
          }
        />
      )}

      <Space wrap size={[6, 6]}>
        {run.windows.map((w) => {
          const ratio = w.input_token_estimate
            ? w.input_token_estimate / maxInputTokens
            : 0;
          const color =
            w.status === 'failed'
              ? '#ff4d4f'
              : w.status === 'completed'
                ? ratio > TOKEN_WARN_RATIO
                  ? '#faad14'
                  : '#52c41a'
                : '#1677ff';
          return (
            <Tooltip
              key={w.window_index}
              title={
                <div style={{ fontSize: 12 }}>
                  <div>窗口 #{w.window_index}</div>
                  <div>输入 chunk：{w.input_chunk_count}</div>
                  <div>
                    token 估算：{w.input_token_estimate ?? '-'} /{' '}
                    {maxInputTokens}（{Math.round(ratio * 100)}%）
                  </div>
                  <div>产出有效用例：{w.valid_case_count}</div>
                  <div>尝试次数：{w.attempt_count}</div>
                  {w.error_message && (
                    <div style={{ color: '#ff7875' }}>{w.error_message}</div>
                  )}
                </div>
              }
            >
              <div
                className={styles.windowBox}
                style={{
                  background: `${color}22`,
                  border: `1px solid ${color}`,
                  color,
                  width: 46,
                }}
              >
                {w.status === 'completed'
                  ? `${w.valid_case_count}`
                  : w.status === 'failed'
                    ? '✕'
                    : '…'}
              </div>
            </Tooltip>
          );
        })}
      </Space>

      <div style={{ marginTop: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          方块内数字 = 该窗口产出的有效用例数；✕ = 失败（可重试）；… = 进行中。
          黄色边框 = token 估算逼近上限（&gt;
          {Math.round(TOKEN_WARN_RATIO * 100)}%）， 后端会按 L 与 token
          预算**双重约束**切分，单个超预算 chunk 需显式跳过而非静默截断。
        </Text>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 24 }}>
        <Stat label="总 chunk" value={run.total_chunks} />
        <Stat label="总窗口" value={run.total_windows} />
        <Stat label="已完成" value={run.completed_windows} />
        <Stat label="产出用例" value={run.generated_cases} />
        <Stat label="采样 seed" value={run.sample_seed} />
      </div>
    </Card>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({
  label,
  value,
}) => (
  <div>
    <div
      style={{
        fontSize: 20,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value}
    </div>
    <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{label}</div>
  </div>
);

export default WindowPlan;
