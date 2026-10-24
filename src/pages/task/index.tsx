// src/pages/task/index.tsx
// 异步任务列表页 —— 对接 YTraderHarness 后端 /api/v1/tasks
//
// 这个页面只做四件事（对应 task.yaml 的职责划分）：**看**（列表）、
// **追**（按 root_task_id 过滤出整条执行链）、**干预**（取消 / 重试）、
// **提前触发**（invoke：把延迟任务的 execute_at 提前到现在）。
//
// ⚠️ 没有"新建任务"按钮，而且**不许加**：
//   后端刻意不提供 POST /tasks（理由见 task.yaml 的 info.description 与
//   service.ts 的注释）—— 任务由服务端业务代码提交。在 UI 上加一个提交入口
//   等于发明一条后端明确拒绝的通路。
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, useSearchParams } from '@umijs/max';
import { Button, Tooltip, Typography } from 'antd';
import React, { useRef } from 'react';

import TaskActions from './components/TaskActions';
import TaskStatusTag from './components/TaskStatusTag';
import type { TaskSummary } from './data';
import { TASK_STATUS_META, TASK_STATUS_OPTIONS } from './data';
import { listTasks } from './service';
import { useStyles } from './style';
import { attemptText, formatTime, shortId } from './utils';

/** 状态筛选项：ProTable 会据此在查询表单里渲染一个下拉。 */
const STATUS_VALUE_ENUM = Object.fromEntries(
  TASK_STATUS_OPTIONS.map((status) => [
    status,
    { text: TASK_STATUS_META[status].label },
  ]),
);

const TaskListPage: React.FC = () => {
  const { styles } = useStyles();
  const actionRef = useRef<ActionType | undefined>(undefined);

  // 「追」的入口：让别的页面能用 /tasks?root_task_id=xxx 直接跳到一条执行链上。
  // 这两个维度是契约里唯二的"结构性"过滤器（按链 / 按父任务），值得做成可分享的 URL。
  const [searchParams, setSearchParams] = useSearchParams();
  const rootTaskId = searchParams.get('root_task_id') ?? undefined;
  const parentTaskId = searchParams.get('parent_task_id') ?? undefined;
  const chainFilter = rootTaskId ?? parentTaskId;
  const chainFilterLabel = rootTaskId ? '执行链根任务' : '直接父任务';

  const reload = () => actionRef.current?.reload();

  const clearChainFilter = () => {
    setSearchParams({}, { replace: true });
  };

  const columns: ProColumns<TaskSummary>[] = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 118,
      valueType: 'select',
      valueEnum: STATUS_VALUE_ENUM,
      // ⚠️ 这里**只能**画状态本身：列表接口不下发租约字段（`lease_expires_at`
      //    只存在于 TaskDetail），所以"执行它的 Worker 失联了"在列表上判不出来，
      //    也不能靠猜 —— 那个警示只出现在详情页。
      //    （同类纪律：列表也没有 error / params，别在这里显示失败原因。）
      render: (_, record) => <TaskStatusTag status={record.status} />,
    },
    {
      title: 'Handler',
      dataIndex: 'handler',
      width: 180,
      ellipsis: true,
      tooltip: '逻辑处理器名，如 run.execute / hitl.timeout / memory.extract',
      fieldProps: { placeholder: '精确匹配，如 run.execute' },
      render: (_, record) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {record.handler}
        </Typography.Text>
      ),
    },
    {
      title: '任务 ID',
      dataIndex: 'task_id',
      width: 160,
      search: false,
      render: (_, record) => (
        <Typography.Text
          copyable={{ text: record.task_id }}
          className={styles.monoId}
        >
          {shortId(record.task_id)}
        </Typography.Text>
      ),
    },
    {
      title: '本轮次数',
      dataIndex: 'attempt',
      width: 100,
      search: false,
      tooltip: '本轮已执行次数 / 上限。手动重试会把已执行次数清零。',
      render: (_, record) => {
        const tried = record.attempt > 0;
        return (
          <Typography.Text type={tried ? 'warning' : undefined}>
            {attemptText(record)}
          </Typography.Text>
        );
      },
    },
    {
      title: '可执行时刻',
      dataIndex: 'execute_at',
      width: 170,
      search: false,
      tooltip:
        '为空表示立即执行；在未来表示这是一条延迟任务（正常），行尾的「立即执行」可以提前触发它。',
      render: (_, record) =>
        record.execute_at ? (
          formatTime(record.execute_at)
        ) : (
          <span style={{ opacity: 0.4 }}>立即</span>
        ),
    },
    {
      title: '执行链根',
      dataIndex: 'root_task_id',
      width: 150,
      search: false,
      render: (_, record) =>
        record.root_task_id ? (
          <Typography.Link
            className={styles.monoId}
            onClick={() =>
              setSearchParams({ root_task_id: record.root_task_id as string })
            }
          >
            {shortId(record.root_task_id)}
          </Typography.Link>
        ) : (
          <Tooltip title="它自己就是链条的起点">
            <span style={{ opacity: 0.4 }}>—</span>
          </Tooltip>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 170,
      search: false,
      render: (_, record) => formatTime(record.created_at),
    },
    {
      title: '操作',
      key: 'option',
      // 最宽的一种组合是「详情 + 立即执行 + 取消 + 重试」（延迟中的任务），
      // 200 会让最后那颗折行。
      width: 220,
      valueType: 'option',
      fixed: 'right',
      render: (_, record) => [
        <Typography.Link
          key="detail"
          onClick={() => history.push(`/tasks/${record.task_id}`)}
        >
          详情
        </Typography.Link>,
        <TaskActions
          key="actions"
          taskId={record.task_id}
          status={record.status}
          executeAt={record.execute_at}
          onDone={reload}
        />,
      ],
    },
  ];

  return (
    <PageContainer
      title="异步任务"
      content="统一的异步任务基础设施：查看有哪些后台任务、它们在什么状态，按执行链追溯一次动作引发的全部后果，把延迟中的任务提前触发，或取消 / 重跑。任务由服务端业务代码提交，这里不提供提交入口。"
    >
      {chainFilter ? (
        <div className={styles.filterBar}>
          <span>
            正在按{chainFilterLabel}过滤：
            <Typography.Text code style={{ fontSize: 12 }}>
              {chainFilter}
            </Typography.Text>
          </span>
          <Button type="link" size="small" onClick={clearChainFilter}>
            清除
          </Button>
        </div>
      ) : null}

      <ProTable<TaskSummary>
        actionRef={actionRef}
        rowKey="task_id"
        headerTitle="任务列表"
        columns={columns}
        // root_task_id / parent_task_id 从 URL 读，作为固定参数透传给后端。
        // ⚠️ 契约里这两个字段是**列表过滤**用的，不是搜索框 —— 所以它们不进查询表单。
        params={{ root_task_id: rootTaskId, parent_task_id: parentTaskId }}
        request={async (params) => {
          const { current, pageSize, status, handler } = params as Record<
            string,
            any
          >;
          const size = pageSize ?? 20;
          const page = current ?? 1;

          const response = await listTasks({
            status: status || undefined,
            // 契约写明 handler 是**精确匹配**（不是模糊搜索），空串要去掉
            handler: handler?.trim() || undefined,
            root_task_id: rootTaskId,
            parent_task_id: parentTaskId,
            // ⚠️ 契约的分页是 limit / offset，不是 page / page_size（与 files 页不同）
            limit: size,
            offset: (page - 1) * size,
          });

          return {
            data: response?.items ?? [],
            success: true,
            total: response?.total ?? 0,
          };
        }}
        search={{ labelWidth: 'auto', defaultCollapsed: true }}
        options={{ reload: true, density: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        scroll={{ x: 1400 }}
      />
    </PageContainer>
  );
};

export default TaskListPage;
