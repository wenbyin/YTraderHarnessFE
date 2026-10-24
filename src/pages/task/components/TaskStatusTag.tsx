// src/pages/task/components/TaskStatusTag.tsx
// 任务状态的统一渲染出口。
//
// 为什么单独一个组件：列表、详情、执行链三处都要画状态，各自写一份 <Tag> 映射
// 迟早会出现"列表里 running 是蓝色、详情里是绿色"这种事 —— 而那种不一致
// 没有任何测试会抓到（跟后端 _assembly.py 里那句"同一个 Task 必须长得一样"同源）。
import { Tag, Tooltip } from 'antd';
import React from 'react';

import { TASK_STATUS_META, type TaskStatus } from '../data';

/** 各状态多一句解释 —— 状态名本身（如 retryable）对非后端同事并不自明。 */
const STATUS_HINT: Record<TaskStatus, string> = {
  pending: '已落库，等调度器认领。execute_at 到点才该跑。',
  running: '已被某个 Worker 认领，正在执行。',
  retryable: '上次执行失败，但还在重试上限之内，等下一次调度。',
  success: '执行成功，终态。',
  failed: '执行失败且不再重试，终态。',
  cancelled: '被主动取消，终态。',
};

interface TaskStatusTagProps {
  status: TaskStatus;
  /** 关掉 tooltip 的场景（例如表格里行已经很挤）。 */
  hint?: boolean;
}

const TaskStatusTag: React.FC<TaskStatusTagProps> = ({
  status,
  hint = true,
}) => {
  const meta = TASK_STATUS_META[status];

  const tag = (
    <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
      {meta.label}
    </Tag>
  );

  if (!hint) return tag;

  return <Tooltip title={STATUS_HINT[status]}>{tag}</Tooltip>;
};

export default TaskStatusTag;
