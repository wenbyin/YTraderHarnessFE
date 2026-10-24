// src/pages/agent_stress/index.tsx
//
// Agent 压测 · 跑测列表。
//
// 契约要点（design_agent_eval/openapi.yaml v2.0.0）：
//   · 一次 Run 是**一组虚拟会话**，列表里的「负载」指的是会话（并发会话数 /
//     每秒新建会话数），不是请求数 —— 文案里必须带「会话」，否则会被读成 v1 的 RPS。
//   · 列表是 **cursor 分页**：只能拿 `next_cursor` 往后走，不能传 page。
//     所以这里关掉 ProTable 的分页器，自己维护「游标栈」做上一页/下一页 ——
//     硬套 page/page_size 会得到一个后端根本不认的参数。
//   · 取消是 POST /cancel，返回 202；已经终态的跑测返回 409，页面要能接住。
//   · 列表里没有指标，只有配置 + 状态；指标在详情页按需拉。
import { PlusOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, Link } from '@umijs/max';
import {
  App,
  Badge,
  Button,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useRef, useState } from 'react';

import CreateStressRunDrawer from './components/CreateStressRunDrawer';
import { StressStatusTag } from './components/StatusTag';
import type { StressRun, StressRunCreate, StressRunStatus } from './data';
import {
  cancelStressRun,
  createStressRun,
  listStressRuns,
  stressErrorMessage,
  stressErrorStatus,
  USE_MOCK_STRESS,
} from './service';
import {
  expectedTurns,
  formatInt,
  formatSeconds,
  isTerminal,
  loadDetail,
  loadSummary,
  STRESS_STATUS_OPTIONS,
  turnCountLabel,
} from './stressMeta';
import { useStyles } from './style';

const { Text } = Typography;

const PAGE_SIZE = 20;

/**
 * 各列定值宽之和 —— 传给 `scroll.x`。
 *
 * v2 多了「会话 × 轮次」一列（v1 的「请求数」列被换掉了），列数没变但内容更长；
 * 「重新发起」进操作列之后，那一列要放下三个动作（详情 / 重新发起 / 取消）。
 *
 * ⚠️ 预算从 1094 抬到 1140 是有意的
 * --------------------------------
 *   三个动作按 13~14px 中文量：28 + 56 + 28 + 两道 16 的间距 + 24 的内边距
 *   ≈ 168px，原来 96 只够放两个（详情 + 取消）。想让表格不变宽只能把「重新发起」
 *   塞进「⋯」下拉 —— 那正是需求要避免的（要一眼看得见）。
 *   代价：1366 窗口下（内容区约 1062px）会横向滚动约 78px，而操作列是
 *   fixed:right，始终可见，滚动只影响左侧几列的可见量。
 *
 * index.test.tsx 有一条「列宽之和 == scroll.x 且 ≤ 1140」钉着这个预算。
 */
const TABLE_MIN_W = 88 + 170 + 120 + 80 + 124 + 110 + 132 + 148 + 168;

/** 「会话 × 轮次」那一格的短文案；null = 不限。 */
function sessionScaleLabel(run: StressRun): string {
  const sessions = run.config.total_sessions;
  const mean = run.config.session.turns.mean;
  const left = typeof sessions === 'number' ? `${sessions} 会话` : '不限会话数';
  return `${left} × ${trimOne(mean)} 轮`;
}

const trimOne = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

const AgentStressListPage: React.FC = () => {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const actionRef = useRef<ActionType | undefined>(undefined);

  const [drawerOpen, setDrawerOpen] = useState(false);
  /**
   * 「重新发起」的来源运行 —— 非空时抽屉按它的 config 回填。
   *
   * ⚠️ 不能只用一个 `open` 布尔：新建立刻接着重发时，抽屉拿到的必须是
   *    **这一次**的来源，而不是上一次残留的那条（否则就是拿 A 的参数发了 B）。
   *    所以两条入口都显式设置：新建 → undefined，重发 → 那条 run。
   */
  const [preset, setPreset] = useState<StressRun | undefined>(undefined);
  /** 当前页的游标；第 1 页是 undefined */
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [trail, setTrail] = useState<(string | undefined)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  /** 轮询每 5s 打一次，同样的错只提示一次（否则断网时满屏 toast） */
  const lastErrorRef = useRef('');

  const handleCreate = async (body: StressRunCreate) => {
    const run = await createStressRun(body);
    message.success(`已入队：${run.run_id.slice(0, 8)}…`);
    // 202 受理后直接进详情：那里能看到 queued → running 与指标爬升
    history.push(`/agent-stress/${run.run_id}`);
  };

  const handleCancel = async (runId: string) => {
    try {
      await cancelStressRun(runId);
      message.success('已请求取消');
      actionRef.current?.reload();
    } catch (error) {
      message.error(stressErrorMessage(error));
    }
  };

  const resetPaging = () => {
    setCursor(undefined);
    setTrail([]);
    setNextCursor(null);
  };

  const columns: ProColumns<StressRun>[] = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 88,
      valueType: 'select',
      fieldProps: { options: STRESS_STATUS_OPTIONS },
      render: (_, run) => <StressStatusTag status={run.status} />,
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 170,
      ellipsis: true,
      search: false,
      render: (_, run) => {
        const label = run.name?.trim() || `未命名 · ${run.run_id.slice(0, 8)}`;
        return (
          <Tooltip title={run.name ?? run.run_id}>
            <Typography.Link
              strong
              onClick={() => history.push(`/agent-stress/${run.run_id}`)}
            >
              {label}
            </Typography.Link>
          </Tooltip>
        );
      },
    },
    {
      title: '负载',
      dataIndex: 'load',
      width: 120,
      search: false,
      render: (_, run) => (
        <Tooltip title={loadDetail(run.config.load)}>
          <Tag
            color={run.config.load.mode === 'concurrency' ? 'blue' : 'purple'}
          >
            {loadSummary(run.config.load)}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '时长',
      dataIndex: 'duration_seconds',
      width: 80,
      align: 'right',
      search: false,
      render: (_, run) => formatSeconds(run.config.duration_seconds),
    },
    {
      title: '被测入口',
      dataIndex: 'base_url',
      width: 124,
      ellipsis: true,
      search: false,
      render: (_, run) => (
        <Tooltip title={run.config.target.base_url}>
          <Text className={styles.mono} type="secondary">
            {run.config.target.base_url}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'Agent',
      dataIndex: 'agent_id',
      width: 110,
      ellipsis: true,
      search: false,
      render: (_, run) => (
        <Text className={styles.mono}>{run.config.session.agent_id}</Text>
      ),
    },
    {
      title: '会话 × 轮次',
      dataIndex: 'session_scale',
      width: 132,
      search: false,
      render: (_, run) => {
        const planned = expectedTurns(run.config);
        return (
          <Tooltip
            title={
              <span>
                {`N：${turnCountLabel(run.config.session.turns)}`}
                <br />
                {planned !== null
                  ? `预计总轮次 ≈ ${formatInt(planned)}`
                  : '会话数不限，总轮次由时长与负载决定'}
                {run.config.max_turns != null
                  ? ` · 上限 ${formatInt(run.config.max_turns)} 轮`
                  : ''}
              </span>
            }
          >
            <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
              {sessionScaleLabel(run)}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      // 19 个字符的 'YYYY-MM-DD HH:mm:ss' 在 140 里会折行
      width: 148,
      valueType: 'dateTime',
      search: false,
    },
    {
      title: '操作',
      valueType: 'option',
      fixed: 'right',
      // 三个动作并排：详情 / 重新发起 / 取消（终态那一栏是占位「—」）
      width: 168,
      render: (_, run) => {
        const done = isTerminal(run.status);
        return [
          <Link key="detail" to={`/agent-stress/${run.run_id}`}>
            详情
          </Link>,
          /*
           * 「重新发起」：把这一次运行的全部参数带回新建抽屉。
           *
           * ⚠️ 是**回填 + 确认**，不是一键重发：库里有一条 162 会话的配置，
           *    误点一次就是 162 个真会话打到被测服务上。抽屉里一眼能看见
           *    参数来自哪次运行，改完再发也就多一次点击。
           * ⚠️ 终态也允许 —— 压测的常态就是"跑完一轮，按同样参数再来一次"。
           */
          <Button
            key="rerun"
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={() => {
              setPreset(run);
              setDrawerOpen(true);
            }}
          >
            重新发起
          </Button>,
          done ? (
            <Text key="cancel" type="secondary"></Text>
          ) : (
            <Popconfirm
              key="cancel"
              title="取消这次压测？"
              description="停止接纳新会话与新轮次，在飞轮次尽力取消；已采集的指标保留（会标记为 incomplete）。"
              okText="取消跑测"
              cancelText="继续跑"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleCancel(run.run_id)}
            >
              <Button
                type="link"
                size="small"
                danger
                style={{ paddingInline: 0 }}
              >
                取消
              </Button>
            </Popconfirm>
          ),
        ];
      },
    },
  ];

  return (
    <PageContainer
      title="Agent 压测"
      subTitle="Mock Model Stress Eval · 一组虚拟会话 × 多轮对话，压 Agent 全链路"
      extra={[
        USE_MOCK_STRESS ? (
          <Tooltip
            key="mock"
            title="当前走本地内存推演，没有请求后端。切回真接口：localStorage.removeItem('agent-stress:mock') 后刷新。"
          >
            <Tag color="gold">本地模拟</Tag>
          </Tooltip>
        ) : null,
        <Button
          key="create"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            // 新建必须把「上一次重发的来源」清掉，否则抽屉会带着别人的参数打开
            setPreset(undefined);
            setDrawerOpen(true);
          }}
        >
          新建压测
        </Button>,
      ]}
    >
      <ProTable<StressRun>
        rowKey="run_id"
        actionRef={actionRef}
        columns={columns}
        params={{ cursor }}
        request={async (params) => {
          try {
            const res = await listStressRuns({
              status: (params.status as StressRunStatus) || undefined,
              limit: PAGE_SIZE,
              cursor,
            });
            setNextCursor(res.next_cursor ?? null);
            setPageCount(res.items.length);
            setActiveCount(
              res.items.filter(
                (run) => run.status === 'queued' || run.status === 'running',
              ).length,
            );
            lastErrorRef.current = '';
            return { data: res.items, success: true };
          } catch (error) {
            // 后端对「不认识的 cursor」明确回 400（不从头上开始，免得悄悄换页）。
            // 前端唯一可能撞上的是跨环境/过期游标 —— 回到第一页比停在一个空列表上强。
            if (cursor && stressErrorStatus(error) === 400) {
              resetPaging();
              message.warning('分页游标已失效，已回到第一页');
            } else {
              const text = stressErrorMessage(error);
              if (text !== lastErrorRef.current) {
                message.error(text);
                lastErrorRef.current = text;
              }
            }
            setPageCount(0);
            setActiveCount(0);
            return { data: [], success: false };
          }
        }}
        // 有跑测在跑就 5s 轮询；全部终态后自动停（返回 0 = 关闭）
        polling={(data) =>
          data.some(
            (run) => run.status === 'queued' || run.status === 'running',
          )
            ? 5000
            : 0
        }
        onSubmit={resetPaging}
        onReset={resetPaging}
        pagination={false}
        search={{ labelWidth: 'auto' }}
        options={{ density: false, setting: false }}
        scroll={{ x: TABLE_MIN_W }}
        locale={{
          emptyText: (
            <div style={{ padding: '32px 0' }}>
              <Text type="secondary">
                还没有跑测记录 —— 点右上角「新建压测」发起第一次
              </Text>
            </div>
          ),
        }}
      />

      <div className={styles.listFooter}>
        <Space size={12} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>
            本页 {formatInt(pageCount)} 条 · 每页 {PAGE_SIZE} 条 · 游标分页
          </Text>
          {activeCount > 0 ? (
            <Badge
              status="processing"
              text={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {activeCount} 条在跑，5 秒自动刷新
                </Text>
              }
            />
          ) : null}
        </Space>
        <Space size={8}>
          <Button
            size="small"
            disabled={trail.length === 0}
            onClick={() => {
              const prev = trail[trail.length - 1];
              setTrail(trail.slice(0, -1));
              setCursor(prev);
            }}
          >
            上一页
          </Button>
          <Button
            size="small"
            disabled={!nextCursor}
            onClick={() => {
              setTrail([...trail, cursor]);
              setCursor(nextCursor ?? undefined);
            }}
          >
            下一页
          </Button>
        </Space>
      </div>

      <CreateStressRunDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSubmit={handleCreate}
        preset={preset}
      />
    </PageContainer>
  );
};

export default AgentStressListPage;
