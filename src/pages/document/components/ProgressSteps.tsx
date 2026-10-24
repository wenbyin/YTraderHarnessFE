// src/pages/document/components/ProgressSteps.tsx
// 横向处理进度 Steps（数据来自 pipeline.ts 聚合出的 TimelineModel）：
//  - 节点列表与顺序来自该次运行的 topology_snapshot（历史运行不失真），名称兜底用行上冻结的 node_label；
//  - 扇出阶段按 node_id 聚合：圆点显示聚合态（如 2/3），分支明细在抽屉里按执行单元逐路查看；
//  - 首尾节点必须显示，中间按当前进度只显示前后各一位，其余**折叠**（宽度归零 + 淡出），
//    由面板右上角的按钮展开 / 收起；
//  - 所有节点常驻 DOM，只切 class —— 重建 DOM 会让 CSS transition 直接跳终态、看不到动画；
//  - 连线颜色只由左侧那一步是否「已通过」（completed 或 skipped）决定；
//  - 进度百分比 = completed / (planned - skipped)，分母在扇出展开时会跳变，用提示条解释；
//  - 点击任意节点 → NodeDetailDrawer：概览常驻，执行明细用 Tab 逐路切换，内容为三段 JSON。
import { RightOutlined } from '@ant-design/icons';
import { Button, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import React, { useEffect, useMemo, useState } from 'react';

import type { NodeRunStatus, TimelineModel, TimelineNode } from '../pipeline';
import { NODE_STATUS_TEXT, RUN_STATUS_TEXT } from '../pipeline';
import { useStyles } from '../style';
import NodeDetailDrawer from './NodeDetailDrawer';

const NODE_TAG_COLOR: Record<NodeRunStatus, string> = {
  completed: 'green',
  running: 'blue',
  pending: 'default',
  failed: 'red',
  skipped: 'default',
};

const RUN_TAG_COLOR: Record<string, string> = {
  completed: 'green',
  running: 'blue',
  failed: 'red',
  partial: 'orange',
  pending: 'default',
  cancelled: 'default',
};

const GROUP_TEXT: Record<TimelineNode['group'], string> = {
  linear: 'linear',
  fanout: 'fan-out',
  control: 'control',
};

/** 毫秒 → 可读耗时。 */
export function formatDuration(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** 「已通过」= 真的跑过，或按图被条件边跳过；两者都算连线已通过。 */
const isPassed = (state: NodeRunStatus) =>
  state === 'completed' || state === 'skipped';

/** 展开时按「离缺口的距离」错开出现，上限 180ms，避免整排一起闪。 */
const STAGGER_MS = 28;
const STAGGER_MAX_MS = 180;

interface ProgressStepsProps {
  model: TimelineModel;
  versionNumber?: number;
  loading?: boolean;
  /** 标题右侧的额外内容（如轮询提示）。 */
  extra?: React.ReactNode;
}

const ProgressSteps: React.FC<ProgressStepsProps> = ({
  model,
  versionNumber,
  loading,
  extra,
}) => {
  const { styles, cx } = useStyles();
  const nodes = model.nodes;
  const total = nodes.length;

  const [expanded, setExpanded] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** hover 中的节点：下方的执行信息卡跟随它切换，移开后回到当前节点。 */
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // 当前节点：第一个「执行中 / 失败 / 等待中」；全部通过则落在最后一个节点
  const current = useMemo(() => {
    const index = nodes.findIndex(
      (node) =>
        node.state === 'running' ||
        node.state === 'failed' ||
        node.state === 'pending',
    );
    return index === -1 ? Math.max(total - 1, 0) : index;
  }, [nodes, total]);

  // 收起态可见集合：首 + 尾 + 当前 ±1
  const visible = useMemo(() => {
    const set = new Set<number>([0, total - 1]);
    for (let i = current - 1; i <= current + 1; i += 1) {
      if (i >= 0 && i < total) set.add(i);
    }
    return set;
  }, [current, total]);

  /** 第一个被隐藏的下标：展开动画以它为起点向两侧扩散。 */
  const gapIndex = useMemo(() => {
    for (let i = 0; i < total; i += 1) if (!visible.has(i)) return i;
    return null;
  }, [visible, total]);

  const hiddenCount = total - visible.size;

  const selectedNode = useMemo(
    () =>
      selectedNodeId
        ? (nodes.find((node) => node.nodeId === selectedNodeId) ?? null)
        : null,
    [nodes, selectedNodeId],
  );

  // 节点从拓扑里消失（换版本 / 换运行）时自动收起抽屉，避免停在空内容
  useEffect(() => {
    if (selectedNodeId && !selectedNode) setSelectedNodeId(null);
  }, [selectedNodeId, selectedNode]);

  useEffect(() => {
    if (hoveredNodeId && !nodes.some((node) => node.nodeId === hoveredNodeId)) {
      setHoveredNodeId(null);
    }
  }, [nodes, hoveredNodeId]);

  if (loading) {
    return (
      <div className={styles.stepsPanel}>
        <Skeleton active paragraph={{ rows: 4 }} />
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className={styles.stepsPanel}>
        <Empty description="尚无运行记录，节点列表暂不可用" />
      </div>
    );
  }

  const fillClass =
    model.runStatus === 'completed'
      ? styles.fillSuccess
      : model.runStatus === 'running' || model.runStatus === 'pending'
        ? styles.fillProcessing
        : model.runStatus === 'partial'
          ? styles.fillWarning
          : model.runStatus === 'failed'
            ? styles.fillError
            : styles.fillNeutral;

  const segClass = (passed: boolean) =>
    cx(styles.seg, passed && styles.segPassed);

  /** 圆点内容：扇出显示 "2/3" 计数，其余用 ✓ / ✕ / 序号。 */
  const dotContent = (node: TimelineNode, index: number) => {
    if (node.state === 'completed' || node.state === 'skipped') return '✓';
    if (node.state === 'failed') return '✕';
    if (node.group === 'fanout' && node.branches.length > 0) {
      const done = node.branches.filter((branch) =>
        isPassed(branch.status),
      ).length;
      return `${done}/${node.branches.length}`;
    }
    return String(index + 1);
  };

  const renderNode = (node: TimelineNode, index: number) => {
    const hidden = !expanded && !visible.has(index);
    const delay =
      expanded && gapIndex != null
        ? Math.min(Math.abs(index - gapIndex) * STAGGER_MS, STAGGER_MAX_MS)
        : 0;

    const dotClass = cx(
      styles.stepDot,
      node.state === 'completed' && styles.dotCompleted,
      node.state === 'running' && styles.dotProcessing,
      node.state === 'failed' && styles.dotFailed,
      node.state === 'skipped' && styles.dotSkipped,
      node.group === 'fanout' && styles.dotFanout,
    );

    const nameClass = cx(
      styles.stepName,
      node.state === 'pending' && styles.stepNameMuted,
      node.state === 'running' && styles.stepNameProcessing,
      node.state === 'failed' && styles.stepNameFailed,
    );

    return (
      <div
        key={node.nodeId}
        className={cx(
          styles.step,
          styles.stepClickable,
          hidden && styles.stepHidden,
          selectedNodeId === node.nodeId && styles.stepSelected,
        )}
        style={{
          transitionDelay: `${delay}ms`,
          textAlign:
            index === 0 ? 'left' : index === total - 1 ? 'right' : 'center',
        }}
        onMouseEnter={() => setHoveredNodeId(node.nodeId)}
        onMouseLeave={() => setHoveredNodeId(null)}
        onClick={() => setSelectedNodeId(node.nodeId)}
      >
        <div className={styles.stepTrack}>
          <span
            className={cx(
              segClass(index > 0 && isPassed(nodes[index - 1].state)),
              index === 0 && styles.segHidden,
            )}
          />
          <span className={dotClass} data-role="dot">
            {dotContent(node, index)}
          </span>
          <span
            className={cx(
              segClass(isPassed(node.state)),
              index === total - 1 && styles.segHidden,
            )}
          />
        </div>
        <div className={styles.stepBody}>
          <div className={nameClass}>{node.label}</div>
          <div className={styles.stepActor}>{node.nodeId}</div>
          <div className={styles.stepTime}>
            {node.state === 'pending'
              ? NODE_STATUS_TEXT.pending
              : node.durationMs != null
                ? formatDuration(node.durationMs)
                : NODE_STATUS_TEXT[node.state]}
          </div>
        </div>
      </div>
    );
  };

  /** 执行信息卡只在 hover 某个节点时出现，移开即隐藏（不再回落到当前节点）。 */
  const infoNode =
    hoveredNodeId != null
      ? (nodes.find((node) => node.nodeId === hoveredNodeId) ?? null)
      : null;
  const infoIndex = infoNode
    ? nodes.findIndex((node) => node.nodeId === infoNode.nodeId)
    : -1;

  return (
    <div className={styles.stepsPanel}>
      <div className={styles.stepsHead}>
        <Space size={8} wrap>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            处理进度
            {versionNumber != null ? ` · v${versionNumber}` : ''}
          </span>
          {model.runStatus && (
            <Tag color={RUN_TAG_COLOR[model.runStatus]}>
              {RUN_STATUS_TEXT[model.runStatus]}
            </Tag>
          )}
          {model.triggerSource && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {model.triggerSource}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {model.completedSteps}/{model.plannedSteps} 步
            {model.skippedSteps > 0 ? ` · 跳过 ${model.skippedSteps}` : ''}
            {model.failedSteps > 0 ? ` · 失败 ${model.failedSteps}` : ''}
          </Typography.Text>
        </Space>
        <Space size={8} wrap>
          {extra}
          {/* 展开 / 收起：箭头旋转 180°，文案带隐藏数量。
              type="text" —— 无边框无底色，不抢进度条的视觉重心 */}
          <Button
            type="text"
            size="small"
            icon={
              <RightOutlined
                className={cx(
                  styles.toggleIcon,
                  expanded && styles.toggleIconExpanded,
                )}
              />
            }
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : `展开 ${hiddenCount} 步`}
          </Button>
        </Space>
      </div>

      <div className={styles.progressBar}>
        <i
          className={cx(styles.progressFill, fillClass)}
          style={{ width: `${model.percent}%` }}
        />
      </div>

      <div className={styles.steps}>{nodes.map(renderNode)}</div>

      {model.unknownNodes && (
        <div className={styles.noticeBox}>
          此次运行使用了不在当前流水线目录中的节点，已按运行时冻结的名称展示（旧版流水线）。
        </div>
      )}

      {model.jumpHint && (
        <div className={styles.noticeBox}>{model.jumpHint}</div>
      )}

      {/* 执行信息卡：仅在 hover 某个节点时出现（key=nodeId 触发入场动画），移开即隐藏 */}
      {infoNode && (
        <div key={infoNode.nodeId} className={styles.currentStepCard}>
          <div className={styles.currentTitle}>
            {infoIndex + 1}. {infoNode.label}
            <Tag
              color={NODE_TAG_COLOR[infoNode.state]}
              style={{ marginLeft: 8 }}
            >
              {NODE_STATUS_TEXT[infoNode.state]}
            </Tag>
            <Tag style={{ marginLeft: 4 }}>{GROUP_TEXT[infoNode.group]}</Tag>
            {infoNode.deprecated && <Tag color="warning">已退役节点</Tag>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              点击查看执行明细
            </Typography.Text>
          </div>

          <div className={styles.currentSub}>
            <span style={{ fontFamily: 'monospace' }}>{infoNode.nodeId}</span>
            {' · 耗时 '}
            {formatDuration(infoNode.durationMs)}
            {infoNode.chunkCount != null
              ? ` · ${infoNode.chunkCount} chunks`
              : ''}
            {infoNode.tokenCount != null
              ? ` · ${infoNode.tokenCount} tokens`
              : ''}
          </div>

          {infoNode.description && (
            <div className={styles.currentSub}>{infoNode.description}</div>
          )}

          {infoNode.branches.length > 0 && (
            <div className={styles.branchList}>
              {infoNode.branches.map((branch) => (
                <div key={branch.key} className={styles.branchRow}>
                  <span className={styles.branchName}>{branch.label}</span>
                  <Tag color={NODE_TAG_COLOR[branch.status]}>
                    {NODE_STATUS_TEXT[branch.status]}
                  </Tag>
                  <span>耗时 {formatDuration(branch.durationMs)}</span>
                  {branch.chunkCount != null && (
                    <span>{branch.chunkCount} chunks</span>
                  )}
                  {branch.errorMessage && (
                    <span style={{ color: 'var(--ant-color-error)' }}>
                      {branch.errorMessage}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {infoNode.state === 'failed' && infoNode.errorMessage && (
            <div className={styles.errorBox}>{infoNode.errorMessage}</div>
          )}

          {infoNode.preview && (
            <div className={styles.previewBox}>{infoNode.preview}</div>
          )}
        </div>
      )}

      <NodeDetailDrawer
        nodeId={selectedNodeId}
        node={selectedNode}
        onClose={() => setSelectedNodeId(null)}
      />
    </div>
  );
};

export default ProgressSteps;
