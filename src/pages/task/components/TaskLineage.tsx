// src/pages/task/components/TaskLineage.tsx
// 一条后台执行链：`hitl.timeout -> run.resume -> memory.extract`
//
// 契约口径（task.yaml 的 /tasks/{task_id}/lineage）：
//   · 传链上**任意一条**都可以，根由后端反推 —— 所以这里不判断"传进来的是不是根"；
//   · 顺序是**产生顺序（老的在前）** —— 拿到就画，不排序（排了就跟后端不一致了，
//     而且 created_at 是 UTC 微秒精度，同一毫秒内的两条再排会乱）；
//   · 什么都没找到时是**空的 tasks 数组**，不是 404 —— 所以"空"要画成一句正常说明，
//     不能画成报错。

import { history } from '@umijs/max';
import { Card, Empty, Spin, Tag, Timeline, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { TaskLineage as TaskLineageModel } from '../data';
import { TASK_STATUS_META } from '../data';
import { getTaskLineage } from '../service';
import { formatTime, shortId } from '../utils';

interface TaskLineageProps {
  /** 链上任意一条任务的 ID。 */
  taskId: string;
  /** 当前正在看的那条（高亮它，"我在链条的哪一环"）。 */
  currentTaskId?: string;
}

/** 状态 -> Timeline 圆点颜色。Timeline 只认颜色字符串，不认 antd 的语义 status。 */
const DOT_COLOR: Record<string, string> = {
  pending: 'gray',
  running: 'blue',
  retryable: 'orange',
  success: 'green',
  failed: 'red',
  cancelled: 'gray',
};

const TaskLineage: React.FC<TaskLineageProps> = ({ taskId, currentTaskId }) => {
  const [data, setData] = useState<TaskLineageModel | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getTaskLineage(taskId);
      setData(result);
    } catch {
      // 404（任务不存在）由全局 errorHandler 弹出；这里只要不把上一次的结果
      // 当成这一次的就行 —— 置 null 而不是留旧数据。
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tasks = data?.tasks ?? [];

  return (
    <Card
      size="small"
      title="执行链"
      extra={
        data ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            根任务 {shortId(data.root_task_id)} · 共 {tasks.length} 环
          </Typography.Text>
        ) : null
      }
    >
      {loading && !data ? (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      ) : tasks.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="这条任务没有关联的执行链（它自己没有下游）。"
        />
      ) : (
        <Timeline
          items={tasks.map((task) => {
            const isCurrent = task.task_id === currentTaskId;
            return {
              color: DOT_COLOR[task.status] ?? 'gray',
              children: (
                <div>
                  <Typography.Link
                    strong
                    onClick={() => history.push(`/tasks/${task.task_id}`)}
                  >
                    {task.handler}
                  </Typography.Link>
                  {isCurrent ? (
                    <Tag color="blue" style={{ marginInlineStart: 8 }}>
                      当前
                    </Tag>
                  ) : null}
                  <Tag
                    color={TASK_STATUS_META[task.status].color}
                    style={{ marginInlineStart: isCurrent ? 0 : 8 }}
                  >
                    {TASK_STATUS_META[task.status].label}
                  </Tag>
                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.65,
                      fontFamily: 'monospace',
                    }}
                  >
                    {shortId(task.task_id)} · 第 {task.attempt}/
                    {task.max_attempts} 次
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.65 }}>
                    创建于 {formatTime(task.created_at)}
                    {task.finished_at
                      ? ` · 结束于 ${formatTime(task.finished_at)}`
                      : ''}
                  </div>
                </div>
              ),
            };
          })}
        />
      )}

      {data && tasks.length > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          链条按 root_task_id
          收口，只含同一个根下面的任务；与这条业务无关的后台任务不在此列。
        </Typography.Text>
      ) : null}
    </Card>
  );
};

export default TaskLineage;
