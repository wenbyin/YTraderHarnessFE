// src/pages/agent_stress/index.test.tsx
//
// 列表页的**契约行为**回归：
//   1. 分页是 cursor（契约只给 next_cursor）——「下一页」必须把上一页返回的游标传回去，
//      而不是传 page=2 这种后端不认的参数；
//   2. 终态（completed/failed/cancelled）不再显示「取消」，避免用户点出一个 409；
//   3. 列宽之和 == scroll.x，且操作列 fixed:right（横向滚动时也得能点）。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { history } from '@umijs/max';
import { App, Table } from 'antd';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StressRun } from './data';

const listStressRuns = vi.fn();

const seen = vi.hoisted(() => ({
  tableProps: [] as any[],
  drawerProps: [] as any[],
}));

vi.mock('@umijs/max', () => ({
  history: { push: vi.fn() },
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('@ant-design/pro-components', () => ({
  // ⚠️ extra 也要渲染：页面右上角的「新建压测」就在那里，
  //    漏掉它会让"点新建 → 清掉重发来源"这类用例无从点击。
  PageContainer: ({
    children,
    extra,
  }: {
    children?: React.ReactNode;
    extra?: React.ReactNode;
  }) => (
    <div>
      <div>{extra}</div>
      {children}
    </div>
  ),
  ProTable: (props: any) => {
    seen.tableProps.push(props);
    const [data, setData] = React.useState<any[]>([]);
    const paramsKey = JSON.stringify(props.params ?? {});
    // params（游标）变了就重新请求 —— 真 ProTable 也是这个语义
    React.useEffect(() => {
      let alive = true;
      props
        .request({ current: 1, pageSize: 20, ...(props.params ?? {}) })
        .then((res: any) => {
          if (alive) setData(res.data ?? []);
        });
      return () => {
        alive = false;
      };
    }, [paramsKey]);
    return (
      <Table
        rowKey={props.rowKey}
        columns={props.columns}
        dataSource={data}
        scroll={props.scroll}
        pagination={false}
      />
    );
  },
}));

vi.mock('./service', () => ({
  listStressRuns: (...args: unknown[]) => listStressRuns(...args),
  createStressRun: vi.fn(),
  cancelStressRun: vi.fn(),
  stressErrorMessage: (error: unknown) =>
    (error as Error)?.message ?? String(error),
  stressErrorStatus: (error: unknown) =>
    (error as { response?: { status?: number } })?.response?.status,
  USE_MOCK_STRESS: false,
}));

vi.mock('./style', () => ({
  useStyles: () => ({ styles: { mono: 'mono', listFooter: 'footer' } }),
}));

// 抽屉只留一个记录 props 的壳：本文件关心的是"点了重发，参数有没有带过去"，
// 而不是抽屉内部怎么渲染（那是 CreateStressRunDrawer.test.tsx 的事）。
vi.mock('./components/CreateStressRunDrawer', () => ({
  default: (props: any) => {
    seen.drawerProps.push(props);
    return <div>create-drawer</div>;
  },
}));

import AgentStressListPage from './index';

function run(over: Partial<StressRun> = {}): StressRun {
  return {
    run_id: '3f2a9c41-0b7e-4a52-9c1d-5e6f7a8b9c01',
    name: 'baseline · 100 并发 / 60s',
    status: 'running',
    created_at: '2026-10-18T00:00:00.000Z',
    started_at: '2026-10-18T00:00:01.000Z',
    finished_at: null,
    error_code: null,
    error_message: null,
    config: {
      target: { base_url: 'http://127.0.0.1:8080' },
      session: {
        agent_id: 'react_agent',
        turns: { mean: 4.5, stddev: 1.5, min: 1, max: 8 },
      },
      turn: { streaming: true, input_size_chars: 480 },
      load: { mode: 'concurrency', concurrency: 100 },
      duration_seconds: 60,
      total_sessions: 12,
      request_timeout_ms: 120000,
      mock_model: {
        base_latency_ms: 180,
        ttft_ms: 240,
        output_tokens_min: 200,
        output_tokens_max: 600,
        tokens_per_second: 90,
      },
    },
    ...over,
  };
}

function setup(items: StressRun[], nextCursor: string | null = null) {
  seen.tableProps.length = 0;
  seen.drawerProps.length = 0;
  listStressRuns.mockResolvedValue({ items, next_cursor: nextCursor });
  render(
    <App>
      <AgentStressListPage />
    </App>,
  );
}

beforeEach(() => {
  // 没开 vitest globals → RTL 不会自动 cleanup；不清会串 DOM（`getAllByText` 数错）
  cleanup();
  vi.clearAllMocks();
});

describe('Agent 压测列表', () => {
  it('列宽之和等于 scroll.x，且不超过 1140（含操作列三个动作）', async () => {
    setup([run()]);
    await screen.findByText('baseline · 100 并发 / 60s');

    const props = seen.tableProps[seen.tableProps.length - 1];
    const total = props.columns.reduce(
      (sum: number, c: any) => sum + (c.width ?? 0),
      0,
    );
    expect(props.scroll?.x).toBe(total);
    // 1140 = v2 九列预算；「重新发起」进操作列后从 1094 抬上来（见 index.tsx
    // TABLE_MIN_W 的注释：三个中文动作 ≈ 168px，96 只够两个）
    expect(total).toBeLessThanOrEqual(1140);
  });

  it('操作列 fixed:right；运行中显示取消，终态显示占位', async () => {
    setup([
      run({ run_id: 'a', name: '在跑的' }),
      run({
        run_id: 'b',
        name: '跑完的',
        status: 'completed',
        finished_at: '2026-10-18T00:01:01.000Z',
      }),
    ]);
    await screen.findByText('在跑的');

    const props = seen.tableProps[seen.tableProps.length - 1];
    const op = props.columns.find((c: any) => c.title === '操作');
    expect(op?.fixed).toBe('right');

    // 只有 running 那一行有「取消」按钮
    expect(screen.getAllByText('取消')).toHaveLength(1);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
  });

  it('「重新发起」把这一条 run 的完整配置交给抽屉（终态也要能重发）', async () => {
    setup([
      run({ run_id: 'a', name: '别的一条' }),
      run({
        run_id: 'c',
        name: '要重发的',
        status: 'completed',
        finished_at: '2026-10-18T00:01:01.000Z',
        config: {
          ...run().config,
          duration_seconds: 300,
          total_sessions: 40,
        },
      }),
    ]);
    await screen.findByText('要重发的');

    // 每条都有这个动作 —— 压测的常态就是"跑完了按同样参数再来一次"
    const buttons = screen.getAllByText('重新发起');
    expect(buttons).toHaveLength(2);
    // 还没点之前抽屉是关的（不能一进页面就带参弹出来）
    expect(seen.drawerProps[seen.drawerProps.length - 1].open).toBe(false);

    fireEvent.click(buttons[1]);

    const props = seen.drawerProps[seen.drawerProps.length - 1];
    expect(props.open).toBe(true);
    // 传的是**整条 run**（抽屉还要显示"参数来自哪次运行"）
    expect(props.preset?.run_id).toBe('c');
    expect(props.preset?.config.duration_seconds).toBe(300);
    expect(props.preset?.config.total_sessions).toBe(40);
  });

  it('「新建压测」会清掉上一次重发的来源，不会带着别人的参数打开', async () => {
    setup([run({ run_id: 'a', name: 'A 条' })]);
    await screen.findByText('A 条');

    fireEvent.click(screen.getByText('重新发起'));
    expect(seen.drawerProps[seen.drawerProps.length - 1].preset?.run_id).toBe(
      'a',
    );

    fireEvent.click(screen.getByText('新建压测'));
    const props = seen.drawerProps[seen.drawerProps.length - 1];
    expect(props.open).toBe(true);
    expect(props.preset).toBeUndefined();
  });

  it('点名称进详情页', async () => {
    setup([run()]);
    const name = await screen.findByText('baseline · 100 并发 / 60s');
    // 名称是 Typography.Link + onClick（不是 <a href>）：点了才跳，避免整页刷新
    fireEvent.click(name);
    expect(history.push).toHaveBeenCalledWith(
      '/agent-stress/3f2a9c41-0b7e-4a52-9c1d-5e6f7a8b9c01',
    );
  });

  it('第一页没有 next_cursor 时「下一页」不可点', async () => {
    setup([run()], null);
    await screen.findByText('baseline · 100 并发 / 60s');
    const next = screen.getByRole('button', { name: '下一页' });
    expect(next).toBeDisabled();
  });

  it('「下一页」把上一页返回的 cursor 原样传回后端（不是 page=2）', async () => {
    setup([run()], '20');
    await screen.findByText('baseline · 100 并发 / 60s');

    // 首次请求不带 cursor
    expect(listStressRuns).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: undefined, limit: 20 }),
    );

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => {
      expect(listStressRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: '20' }),
      );
    });
    const lastCall = listStressRuns.mock.calls.at(-1)?.[0];
    expect(lastCall).not.toHaveProperty('page');
  });

  it('分页游标失效（后端 400）→ 回到第一页并提示，而不是停在空列表', async () => {
    seen.tableProps.length = 0;
    listStressRuns
      .mockResolvedValueOnce({ items: [run()], next_cursor: '20' })
      .mockRejectedValueOnce(
        Object.assign(new Error('游标无效'), {
          response: { status: 400 },
        }),
      )
      .mockResolvedValue({ items: [run()], next_cursor: null });

    render(
      <App>
        <AgentStressListPage />
      </App>,
    );
    await screen.findByText('baseline · 100 并发 / 60s');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(await screen.findByText(/分页游标已失效/)).toBeTruthy();
    await waitFor(() => {
      expect(listStressRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: undefined }),
      );
    });
  });
});
