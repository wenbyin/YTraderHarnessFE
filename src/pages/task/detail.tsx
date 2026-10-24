// src/pages/task/detail.tsx
// 单条任务详情 —— 对接 /api/v1/tasks/{task_id} 与 /tasks/{task_id}/lineage
//
// 这里是**唯一**能看到 params 与 error 正文的地方：列表接口刻意不下发它们
// （task.yaml 的 TaskSummary 说明）。排查"它为什么失败"能看的也就这两样 ——
// 日志里没有（任务可能在任何实例上执行）、DB 也不该直连。
import { PageContainer } from '@ant-design/pro-components';
import { history, useParams } from '@umijs/max';
import {
  Alert,
  Card,
  Descriptions,
  Result,
  Space,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';

import TaskActions from './components/TaskActions';
import TaskLineage from './components/TaskLineage';
import TaskStatusTag from './components/TaskStatusTag';
import type { TaskDetail as TaskDetailModel } from './data';
import { getTask } from './service';
import { useStyles } from './style';
import {
  attemptText,
  delayHint,
  elapsedText,
  formatTime,
  isEmptyParams,
  shortId,
  stringifyParams,
} from './utils';

const TaskDetailPage: React.FC = () => {
  const { styles } = useStyles();
  const { taskId } = useParams<{ taskId: string }>();

  const [detail, setDetail] = useState<TaskDetailModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const result = await getTask(taskId);
      setDetail(result);
      setMissing(false);
    } catch {
      // 404 的 detail 文案由全局 errorHandler 弹出；这里把页面收敛成一个明确的
      // "找不到"，而不是留一个空壳 —— 空壳看起来像页面坏了。
      setDetail(null);
      setMissing(true);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) {
    return (
      <PageContainer title="任务详情" onBack={() => history.push('/tasks')}>
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      </PageContainer>
    );
  }

  if (missing || !detail) {
    return (
      <PageContainer title="任务详情" onBack={() => history.push('/tasks')}>
        <Result
          status="404"
          title="任务不存在"
          subTitle="它可能已经被清理，或者 ID 不属于当前用户。"
          extra={
            <Typography.Link onClick={() => history.push('/tasks')}>
              返回任务列表
            </Typography.Link>
          }
        />
      </PageContainer>
    );
  }

  // "它现在为什么停着" —— 口径照抄后端 get_task 的 docstring（pending 延迟 /
  // 租约过期 / 待重试）。读不出特殊情形时返回 null，这里就不画那一块。
  const hint = delayHint(detail);

  return (
    <PageContainer
      title={detail.handler}
      subTitle={<TaskStatusTag status={detail.status} />}
      onBack={() => history.push('/tasks')}
      extra={
        <TaskActions
          taskId={detail.task_id}
          status={detail.status}
          executeAt={detail.execute_at}
          onDone={load}
          mode="button"
        />
      }
    >
      <Space vertical size={16} style={{ width: '100%' }}>
        {hint ? (
          <Alert
            type="warning"
            showIcon
            title="它现在为什么停着"
            description={hint}
          />
        ) : null}

        {detail.error ? (
          <Alert
            type="error"
            showIcon
            title="最近一次失败的原因"
            description={
              <Typography.Text
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {detail.error}
              </Typography.Text>
            }
          />
        ) : null}

        <Card size="small" title="基本信息">
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              {
                key: 'task_id',
                label: '任务 ID',
                children: (
                  <Typography.Text
                    copyable={{ text: detail.task_id }}
                    className={styles.monoId}
                  >
                    {detail.task_id}
                  </Typography.Text>
                ),
              },
              {
                key: 'handler',
                label: 'Handler',
                children: (
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {detail.handler}
                  </Typography.Text>
                ),
              },
              {
                key: 'attempt',
                label: '本轮次数',
                children: attemptText(detail),
              },
              {
                key: 'root_task_id',
                label: '执行链根',
                children: detail.root_task_id ? (
                  <Typography.Link
                    className={styles.monoId}
                    onClick={() =>
                      history.push(`/tasks/${detail.root_task_id}`)
                    }
                  >
                    {shortId(detail.root_task_id)}
                  </Typography.Link>
                ) : (
                  <Typography.Text type="secondary">
                    它自己就是根
                  </Typography.Text>
                ),
              },
              {
                key: 'parent_task_id',
                label: '直接父任务',
                children: detail.parent_task_id ? (
                  <Typography.Link
                    className={styles.monoId}
                    onClick={() =>
                      history.push(`/tasks/${detail.parent_task_id}`)
                    }
                  >
                    {shortId(detail.parent_task_id)}
                  </Typography.Link>
                ) : (
                  <Typography.Text type="secondary">无</Typography.Text>
                ),
              },
              {
                key: 'causation_id',
                label: (
                  // ⚠️ Descriptions 的 item **没有** tooltip 字段（v6 的
                  //    DescriptionsItemType 里不存在；写了 tsc 会报 TS2353）。
                  //    要解释一个字段就把 label 包起来。
                  <Tooltip title="可能是父任务 ID，也可能是业务事件 ID —— 后者用来回答「这次动作最终引发了哪些任务」。">
                    <span>触发源</span>
                  </Tooltip>
                ),
                children: detail.causation_id ? (
                  <Typography.Text className={styles.monoId}>
                    {shortId(detail.causation_id)}
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                ),
              },
              {
                key: 'idempotency_key',
                label: '幂等键',
                children: detail.idempotency_key ? (
                  <Typography.Text className={styles.monoId}>
                    {detail.idempotency_key}
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary">无</Typography.Text>
                ),
              },
              {
                key: 'execute_at',
                label: '可执行时刻',
                children: detail.execute_at
                  ? formatTime(detail.execute_at)
                  : '立即执行',
              },
              {
                key: 'elapsed',
                label: '已运行',
                children: elapsedText(detail.started_at, detail.finished_at),
              },
              {
                key: 'leased_by',
                label: '租约持有者',
                children: detail.leased_by ? (
                  <Typography.Text className={styles.monoId}>
                    {detail.leased_by}
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary">无</Typography.Text>
                ),
              },
              {
                key: 'lease_expires_at',
                label: '租约到期',
                children: detail.lease_expires_at ? (
                  formatTime(detail.lease_expires_at)
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                ),
              },
              {
                key: 'created_at',
                label: '创建时间',
                children: formatTime(detail.created_at),
              },
              {
                key: 'updated_at',
                label: '更新时间',
                children: formatTime(detail.updated_at),
              },
              {
                key: 'started_at',
                label: '最近开始',
                children: formatTime(detail.started_at),
              },
              {
                key: 'finished_at',
                label: '进入终态',
                children: formatTime(detail.finished_at),
              },
            ]}
          />
        </Card>

        <Card size="small" title="业务参数">
          {isEmptyParams(detail.params) ? (
            <Typography.Text type="secondary">
              这条任务没有携带业务参数。
            </Typography.Text>
          ) : (
            <pre className={styles.paramsBlock}>
              {stringifyParams(detail.params)}
            </pre>
          )}
        </Card>

        <TaskLineage taskId={detail.task_id} currentTaskId={detail.task_id} />
      </Space>
    </PageContainer>
  );
};

export default TaskDetailPage;
