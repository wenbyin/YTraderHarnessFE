// src/components/CopilotDock/PlanStatusBars.test.tsx
//
// 输入框上方那一条「任务 / 子代理」dock。钉六件事：
//
//   ① **没有计划就什么都不画** —— 每一轮普通对话都挂一条"暂无"是持续干扰；
//   ② 只有**一行**：左半边任务、右半边子代理，中间一条竖线；
//   ③ 收起态**不复述标题**，只在名字前面给一枚状态图标（在跑就是 loading）；
//   ④ 展开是**互斥**的：点一边，另一边自动收起，整条框共用一次展开；
//   ⑤ 展开的内容画在标题行**上方**（向上长），不是往下挤输入框；
//   ⑥ 「子代理」在没有并行执行者时如实说"暂无"，不假装有一个。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PlanStatusBars from './PlanStatusBars';
import { PLAN_EVENT, type PlanView, reducePlan } from './planTasks';

const RUN = 'run-7c9e6679';
const PLAN = '7f3c2d1e-4a8b-4c6d-9e0f-1a2b3c4d5e6f';
const T1 = `${PLAN}:t1`;
const T2 = `${PLAN}:t2`;

/** 造一份快照：先 published，再叠若干个 task.updated，最后可选地 cleared。 */
const buildPlan = (
  tasks: Array<{ id: string; title: string }>,
  updates: Array<{ id: string; state: string; owner?: string }> = [],
  cleared = false,
): PlanView => {
  let plan = reducePlan(null, {
    runId: RUN,
    event: PLAN_EVENT.PUBLISHED,
    data: {
      plan_id: PLAN,
      revision: 1,
      goal: '对比本季度两家公司的财报',
      tasks: tasks.map((task) => ({
        id: task.id,
        status: { state: 'TASK_STATE_SUBMITTED' },
        history: [
          { role: 'ROLE_USER', parts: [{ data: { description: task.title } }] },
        ],
        metadata: { skill_key: 'financial_research' },
      })),
      current_task_id: tasks[0]?.id ?? null,
    },
  });
  for (const update of updates) {
    plan = reducePlan(plan, {
      runId: RUN,
      event: PLAN_EVENT.TASK_UPDATED,
      data: {
        plan_id: PLAN,
        revision: 1,
        task: {
          id: update.id,
          status: { state: update.state },
          // 中途帧没有 history（真实载荷就是这样）
          history: [],
          metadata: update.owner ? { claim: { owner: update.owner } } : {},
        },
        current_task_id: update.state.endsWith('WORKING') ? update.id : null,
      },
    });
  }
  if (cleared) {
    plan = reducePlan(plan, {
      runId: RUN,
      event: PLAN_EVENT.CLEARED,
      data: { plan_id: PLAN, revision: 1, reason: 'completed' },
    });
  }
  return plan as PlanView;
};

const taskPanel = () =>
  document.querySelector('[data-plan-panel="task"]') as HTMLElement;
const agentPanel = () =>
  document.querySelector('[data-plan-panel="sub-agent"]') as HTMLElement;
const dock = () => document.querySelector('[data-plan-bars]') as HTMLElement;
/**
 * dock 的**内容格** —— 2026-10-22 起所有内容都收在它里面。
 *
 * 为什么多这一层：入场动画要"从底部长出来、把上面的胶囊顶上去"，而能平滑
 * 过渡到真实高度的只有 `grid-template-rows: 0fr → 1fr`（见 style.ts 的
 * planDock）。那个写法要求内容装在**单独一个格子**里，否则三个子节点会各
 * 占一行、0fr 只压掉第一行。
 */
const dockBody = () => dock().firstElementChild as HTMLElement;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('可见性', () => {
  it('⭐ 没有计划 → 什么都不渲染（普通对话不该被一条空栏占着）', () => {
    const { container } = render(<PlanStatusBars plan={null} />);
    expect(container.querySelector('[data-plan-bars]')).toBeNull();
  });

  it('有计划 → 一条 dock、两半边都在（任务 / 子代理）', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    expect(dock()).not.toBeNull();
    expect(document.querySelector('[data-plan-bar="task"]')).not.toBeNull();
    expect(
      document.querySelector('[data-plan-bar="sub-agent"]'),
    ).not.toBeNull();
  });

  it('两半边在同一行里，中间有分割线', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    const task = document.querySelector(
      '[data-plan-bar="task"]',
    ) as HTMLElement;
    const agent = document.querySelector(
      '[data-plan-bar="sub-agent"]',
    ) as HTMLElement;
    // 同一个父节点 + 中间夹一个 aria-hidden 的分隔元素
    expect(task.parentElement).toBe(agent.parentElement);
    const kids = [...(task.parentElement?.children ?? [])];
    expect(kids.indexOf(agent) - kids.indexOf(task)).toBe(2);
    expect(kids[1].getAttribute('aria-hidden')).toBe('true');
  });
});

describe('收起 / 展开（互斥）', () => {
  it('默认收起：两半边 aria-expanded=false，面板高度用 data-open 关着', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    expect(
      screen
        .getByRole('button', { name: /任务/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      screen
        .getByRole('button', { name: /子代理/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(dock().getAttribute('data-plan-open')).toBe('none');
    expect(taskPanel().getAttribute('data-open')).toBe('false');
    expect(agentPanel().getAttribute('data-open')).toBe('false');
  });

  it('点「任务」展开：任务面板打开，任务行出来', () => {
    render(
      <PlanStatusBars
        plan={buildPlan([{ id: T1, title: '获取并整理 A 公司财报' }])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /任务/ }));

    expect(dock().getAttribute('data-plan-open')).toBe('task');
    expect(taskPanel().getAttribute('data-open')).toBe('true');
    const rows = document.querySelectorAll('[data-task-state]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('获取并整理 A 公司财报');
    // 后端原值挂在行上（对接口时按原值说话）
    expect(rows[0].getAttribute('data-task-state')).toBe(
      'TASK_STATE_SUBMITTED',
    );
  });

  it('⭐ 互斥：展开任务后再点子代理，任务面板自动收起（整条框只有一个展开）', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    fireEvent.click(screen.getByRole('button', { name: /任务/ }));
    fireEvent.click(screen.getByRole('button', { name: /子代理/ }));

    expect(dock().getAttribute('data-plan-open')).toBe('agent');
    expect(taskPanel().getAttribute('data-open')).toBe('false');
    expect(agentPanel().getAttribute('data-open')).toBe('true');
    // 两边的 aria 也同步，不然读屏会报"都展开"
    expect(
      screen
        .getByRole('button', { name: /任务/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('再点一次同一半边 → 收起（整条框回到一行）', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    fireEvent.click(screen.getByRole('button', { name: /任务/ }));
    fireEvent.click(screen.getByRole('button', { name: /任务/ }));

    expect(dock().getAttribute('data-plan-open')).toBe('none');
    expect(taskPanel().getAttribute('data-open')).toBe('false');
  });

  it('⭐ 展开面板排在标题行**前面**（DOM 顺序 = 视觉在上方 → 向上长）', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    const row = document.querySelector('[data-plan-bar="task"]')
      ?.parentElement as HTMLElement;
    const panels = [...dockBody().children];
    // 两块面板都在标题行之前
    expect(panels.indexOf(taskPanel())).toBeLessThan(panels.indexOf(row));
    expect(panels.indexOf(agentPanel())).toBeLessThan(panels.indexOf(row));
  });

  it('★ 内容全部收在**一个**网格格里（入场时靠它把高度从 0 长起来）', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    // dock 的直接子节点只有一个 —— 多一个就是多一行网格，0fr 压不干净。
    expect(dock().children).toHaveLength(1);
    expect(dockBody().contains(taskPanel())).toBe(true);
    expect(
      dockBody().contains(document.querySelector('[data-plan-bar="task"]')),
    ).toBe(true);
  });

  it('★ 入场标记：第一帧是 enter（零高度），两帧之后变 in', async () => {
    const { rerender } = render(
      <PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />,
    );

    // 首帧必须是 enter —— 否则过渡没有起点，dock 会直接"出现"。
    expect(dock().getAttribute('data-plan-rise')).toBe('enter');

    await waitFor(() =>
      expect(dock().getAttribute('data-plan-rise')).toBe('in'),
    );

    // ⚠️ 同一份计划内的状态变化**不重播**入场（只有换一轮才会）。
    const same = buildPlan(
      [{ id: T1, title: '取数' }],
      [{ id: T1, state: 'TASK_STATE_WORKING', owner: `${RUN}:main` }],
    );
    rerender(<PlanStatusBars plan={same} />);
    expect(dock().getAttribute('data-plan-rise')).toBe('in');
  });
});

describe('语义图标与状态', () => {
  it('⭐ 两半边各有一枚**语义图标**（任务 = 三条横杠、子代理 = 分叉）', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    for (const kind of ['task', 'sub-agent']) {
      const seg = document.querySelector(
        `[data-plan-bar="${kind}"]`,
      ) as HTMLElement;
      // 图标是真实渲染出来的 anticon（不是空 span）
      expect(seg.querySelector('[data-plan-icon] .anticon')).not.toBeNull();
      expect(
        seg.querySelector('[data-plan-icon]')?.getAttribute('data-phase'),
      ).toBeTruthy();
    }
  });

  it('⭐ 有任务在跑 → 名字后面多一枚 loading，图标位仍然是任务清单', () => {
    const plan = buildPlan(
      [{ id: T1, title: '获取并整理 A 公司财报' }],
      [{ id: T1, state: 'TASK_STATE_WORKING', owner: `${RUN}:main` }],
    );
    render(<PlanStatusBars plan={plan} />);

    const head = screen.getByRole('button', { name: /任务/ });
    const icon = head.querySelector('[data-plan-icon]') as HTMLElement;
    // 图标位说"这是任务清单"，状态交给颜色
    expect(icon.getAttribute('data-plan-icon')).toBe('running');
    expect(icon.querySelector('.anticon')).not.toBeNull();
    // loading 单独一枚（不是顶掉图标）
    expect(head.querySelector('[data-plan-spin]')).not.toBeNull();
    // 收起态只给图标 + 名字 + 计数，标题退到 title 提示里
    expect(head.textContent).not.toContain('获取并整理 A 公司财报');
    expect(head.getAttribute('title')).toContain('获取并整理 A 公司财报');
  });

  it('全部完成 → 状态转 done，loading 收起来', () => {
    const plan = buildPlan(
      [{ id: T1, title: '取数' }],
      [{ id: T1, state: 'TASK_STATE_COMPLETED' }],
    );
    render(<PlanStatusBars plan={plan} />);

    const head = screen.getByRole('button', { name: /任务/ });
    expect(
      head.querySelector('[data-plan-icon]')?.getAttribute('data-plan-icon'),
    ).toBe('done');
    expect(head.querySelector('[data-plan-spin]')).toBeNull();
  });

  it('有失败 → 状态转 failed（压过"全部完成"）', () => {
    const plan = buildPlan(
      [
        { id: T1, title: '取数' },
        { id: T2, title: '对比' },
      ],
      [
        { id: T1, state: 'TASK_STATE_COMPLETED' },
        { id: T2, state: 'TASK_STATE_FAILED' },
      ],
    );
    render(<PlanStatusBars plan={plan} />);

    expect(
      screen
        .getByRole('button', { name: /任务/ })
        .querySelector('[data-plan-icon]')
        ?.getAttribute('data-plan-icon'),
    ).toBe('failed');
  });
});

describe('计划结束（不消失）', () => {
  it('⭐ cleared 之后 dock **还在**（不再整块消失）', () => {
    const plan = buildPlan(
      [{ id: T1, title: '取数' }],
      [{ id: T1, state: 'TASK_STATE_COMPLETED' }],
      true,
    );
    render(<PlanStatusBars plan={plan} />);

    expect(dock()).not.toBeNull();
    expect(document.querySelector('[data-plan-bar="task"]')).not.toBeNull();
    expect(
      document.querySelector('[data-plan-bar="sub-agent"]'),
    ).not.toBeNull();
  });

  it('⭐ 展开着的面板在结束那一刻**自动折叠**（动画就是同一条过渡）', () => {
    // 先渲染一个进行中的计划并展开
    const running = buildPlan(
      [{ id: T1, title: '取数' }],
      [{ id: T1, state: 'TASK_STATE_WORKING', owner: `${RUN}:main` }],
    );
    const { rerender } = render(<PlanStatusBars plan={running} />);
    fireEvent.click(screen.getByRole('button', { name: /任务/ }));
    expect(dock().getAttribute('data-plan-open')).toBe('task');

    // 后端收摊 → 面板自己收回去
    rerender(
      <PlanStatusBars
        plan={buildPlan(
          [{ id: T1, title: '取数' }],
          [{ id: T1, state: 'TASK_STATE_COMPLETED' }],
          true,
        )}
      />,
    );

    expect(dock().getAttribute('data-plan-open')).toBe('none');
    expect(taskPanel().getAttribute('data-open')).toBe('false');
    // dock 本身留下
    expect(dock()).not.toBeNull();
  });

  it('结束之后仍然可以手动展开回看任务明细', () => {
    const plan = buildPlan(
      [{ id: T1, title: '取数' }],
      [{ id: T1, state: 'TASK_STATE_COMPLETED' }],
      true,
    );
    render(<PlanStatusBars plan={plan} />);

    fireEvent.click(screen.getByRole('button', { name: /任务/ }));
    expect(taskPanel().getAttribute('data-open')).toBe('true');
    expect(document.querySelectorAll('[data-task-state]').length).toBe(1);
  });
});

describe('退场（下一轮 run 开始）', () => {
  it('常态：data-plan-state 是 live，不从无障碍树里摘掉', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);

    expect(dock().getAttribute('data-plan-state')).toBe('live');
    expect(dock().getAttribute('aria-hidden')).toBeNull();
  });

  it('⭐ retiring：挂上 data-plan-state，样式层据此折叠 + 淡出', () => {
    const plan = {
      ...buildPlan(
        [{ id: T1, title: '取数' }],
        [{ id: T1, state: 'TASK_STATE_COMPLETED' }],
        true,
      ),
      retiring: true,
    };
    render(<PlanStatusBars plan={plan} />);

    expect(dock().getAttribute('data-plan-state')).toBe('retiring');
    // 正在消失的框不该还留在无障碍树里（也就不会有"点了没反应"的焦点）
    expect(dock().getAttribute('aria-hidden')).toBe('true');
  });
});

describe('计数与子代理', () => {
  it('两半边各带自己的计数（任务 done/total、子代理 running/total）', () => {
    const plan = buildPlan(
      [
        { id: T1, title: '取数' },
        { id: T2, title: '对比 B 公司财报' },
      ],
      [{ id: T2, state: 'TASK_STATE_WORKING', owner: `${RUN}:agent-3` }],
    );
    render(<PlanStatusBars plan={plan} />);

    expect(screen.getByRole('button', { name: /任务/ }).textContent).toContain(
      '0/2',
    );
    expect(
      screen.getByRole('button', { name: /子代理/ }).textContent,
    ).toContain('1/1');
  });

  it('⭐ 只有主代理：子代理那边如实说"暂无并行子代理"，计数不画', () => {
    const plan = buildPlan(
      [{ id: T1, title: '取数' }],
      [{ id: T1, state: 'TASK_STATE_WORKING', owner: `${RUN}:main` }],
    );
    render(<PlanStatusBars plan={plan} />);

    const seg = screen.getByRole('button', { name: /子代理/ });
    expect(seg.textContent).not.toMatch(/\d+\/\d+/);
    expect(seg.getAttribute('title')).toContain('暂无并行子代理');

    fireEvent.click(seg);
    expect(document.body.textContent).toContain('本轮全部由主代理执行');
  });

  it('有并行子代理：展开能看到它手上那件事', () => {
    const plan = buildPlan(
      [
        { id: T1, title: '取数' },
        { id: T2, title: '对比 B 公司财报' },
      ],
      [{ id: T2, state: 'TASK_STATE_WORKING', owner: `${RUN}:agent-3` }],
    );
    render(<PlanStatusBars plan={plan} />);

    fireEvent.click(screen.getByRole('button', { name: /子代理/ }));
    expect(document.body.textContent).toContain('agent-3');
    expect(document.body.textContent).toContain('对比 B 公司财报');
  });
});

describe('展开后的细节', () => {
  it('一行里带执行者与状态词；skill 只在 goal 那行说一次（不挤标题）', () => {
    const plan = buildPlan(
      [{ id: T1, title: '取数' }],
      [{ id: T1, state: 'TASK_STATE_WORKING', owner: `${RUN}:main` }],
    );
    render(<PlanStatusBars plan={plan} />);
    fireEvent.click(screen.getByRole('button', { name: /任务/ }));

    const row = document.querySelector('[data-task-state]') as HTMLElement;
    expect(row.textContent).toContain('main');
    expect(row.textContent).toContain('执行中');
    // ⚠️ skill 不在行里：面板里它会把标题挤成省略号
    expect(row.textContent).not.toContain('financial_research');
    expect(document.body.textContent).toContain('financial_research');
  });

  it('计划目标（goal）在展开态顶部', () => {
    render(<PlanStatusBars plan={buildPlan([{ id: T1, title: '取数' }])} />);
    fireEvent.click(screen.getByRole('button', { name: /任务/ }));

    expect(document.body.textContent).toContain('对比本季度两家公司的财报');
  });

  it('当前任务行带 data-current（高亮只在"后端说在跑的那条"上）', () => {
    const plan = buildPlan(
      [
        { id: T1, title: '取数' },
        { id: T2, title: '对比' },
      ],
      [{ id: T1, state: 'TASK_STATE_WORKING', owner: `${RUN}:main` }],
    );
    render(<PlanStatusBars plan={plan} />);
    fireEvent.click(screen.getByRole('button', { name: /任务/ }));

    const rows = [...document.querySelectorAll('[data-task-state]')];
    const current = rows.filter(
      (row) => row.getAttribute('data-current') === 'true',
    );
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('取数');
  });
});

/**
 * 任务行只显示**第一句**（2026-10-22 用户："task 描述里面有简易描述或者标题吗，
 * 不要显示全文"）。
 *
 * 后端没有 per-task 标题字段，`title` 就是整段 `description`。整段塞进一行会被
 * CSS 切在半句话上（「目标：基于 STEP-1 …（Subject）。 输入：STE…」）。
 */
describe('任务行只显示第一句', () => {
  const LONG =
    '目标：基于 STEP-1 的目的与语气，确定该客户邮件的邮件主题（Subject）。 输入：STEP-1 的结论。输出：一个主标题 + 两个备选。';

  it('★ 行内是短标题，全文留在 title 属性里', () => {
    render(
      <PlanStatusBars
        plan={buildPlan(
          [{ id: T1, title: LONG }],
          [{ id: T1, state: 'TASK_STATE_WORKING', owner: `${RUN}:main` }],
        )}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /任务/ }));

    const row = document.querySelector('[data-task-state]') as HTMLElement;

    expect(row.textContent).toContain(
      '基于 STEP-1 的目的与语气，确定该客户邮件的邮件主题（Subject）',
    );
    expect(row.textContent).not.toContain('输入：');
    // 收短只影响显示：悬停仍然是全文
    expect(row.getAttribute('title')).toBe(LONG);
    // 第一句短到不需要截 -> 行内不该出现省略号
    expect(row.textContent).not.toContain('…');
  });
});

// ============================================================
// 子代理名册（subagent.created / claimed / completed，2026-10-23）
// ============================================================
//
// 这一节钉的是**界面上能看见的**那部分：
//   · 一行一个 worker，名字是 `worker:0` 而不是 `0`（`agentName` 要留两段）；
//   · 相位词用 worker 那一套（`已派出` / `执行中` / `已完成`），不是任务的"排队中"；
//   · created 之后、claimed 之前就要出现这一行（那时候任务还没有 owner）。

describe('子代理名册：一行一个 worker', () => {
  /**
   * 造一份带 worker 名册的快照：published 两条任务，然后按给的列表逐条
   * 走 created（可选继续 claimed / completed）。
   */
  const subPlan = (
    workers: Array<{
      index: number;
      taskId: string;
      phase: 'created' | 'claimed' | 'done';
      attempt?: number;
    }>,
  ): PlanView => {
    const base = (event: string, data: Record<string, unknown>) => ({
      runId: RUN,
      event,
      data,
    });
    let plan = reducePlan(
      null,
      base(PLAN_EVENT.PUBLISHED, {
        plan_id: PLAN,
        revision: 1,
        goal: '对比两家公司的财报',
        tasks: [
          {
            id: T1,
            status: { state: 'TASK_STATE_SUBMITTED' },
            history: [
              { role: 'ROLE_USER', parts: [{ data: { description: '取数' } }] },
            ],
            metadata: { skill_key: 'financial_research' },
          },
          {
            id: T2,
            status: { state: 'TASK_STATE_SUBMITTED' },
            history: [
              {
                role: 'ROLE_USER',
                parts: [{ data: { description: '对比 B 公司财报' } }],
              },
            ],
            metadata: { skill_key: 'financial_research' },
          },
        ],
        current_task_id: null,
      }),
    );

    for (const worker of workers) {
      const id = `${RUN}:worker:${worker.index}`;
      const attempt = worker.attempt ?? 1;
      plan = reducePlan(
        plan,
        base('subagent.created', {
          plan_id: PLAN,
          revision: 1,
          worker_id: id,
          worker_index: worker.index,
          task_id: worker.taskId,
          task_count: 2,
          pending_count: 1,
        }),
      );
      if (worker.phase === 'created') continue;

      plan = reducePlan(
        plan,
        base('subagent.claimed', {
          plan_id: PLAN,
          revision: 1,
          worker_id: id,
          task_id: worker.taskId,
          current_task_id: worker.taskId,
          task: {
            id: worker.taskId,
            status: { state: 'TASK_STATE_WORKING' },
            metadata: { claim: { owner: id, attempt } },
          },
        }),
      );
      if (worker.phase !== 'done') continue;

      plan = reducePlan(
        plan,
        base('subagent.completed', {
          plan_id: PLAN,
          revision: 1,
          worker_id: id,
          task_id: worker.taskId,
          status: 'TASK_STATE_COMPLETED',
          task: {
            id: worker.taskId,
            status: { state: 'TASK_STATE_COMPLETED' },
            metadata: { claim: { owner: id, attempt } },
          },
        }),
      );
    }
    return plan as PlanView;
  };

  const agentRows = () =>
    Array.from(document.querySelectorAll('[data-agent]')) as HTMLElement[];

  it('⭐ 名字是 `worker:0` 而不是 `0`，相位用 worker 那一套词', () => {
    render(
      <PlanStatusBars
        plan={subPlan([
          { index: 0, taskId: T1, phase: 'claimed' },
          { index: 1, taskId: T2, phase: 'created' },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /子代理/ }));

    const rows = agentRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-agent')).toBe('worker:0');
    expect(rows[0].getAttribute('data-worker-phase')).toBe('running');
    expect(rows[0].textContent).toContain('执行中');

    // created 的还没有任务状态，但有"已派出"
    expect(rows[1].getAttribute('data-agent')).toBe('worker:1');
    expect(rows[1].getAttribute('data-worker-phase')).toBe('pending');
    expect(rows[1].textContent).toContain('已派出');
  });

  it('⭐ created 阶段就显示这一行，且带上它那条任务的标题', () => {
    // 这一刻任务板上还没有 owner —— 全靠名册的 task_id 对上
    render(
      <PlanStatusBars
        plan={subPlan([{ index: 0, taskId: T2, phase: 'created' }])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /子代理/ }));
    expect(document.body.textContent).toContain('worker:0');
    expect(document.body.textContent).toContain('对比 B 公司财报');
  });

  it('计数说"几个在跑 / 一共几个"', () => {
    render(
      <PlanStatusBars
        plan={subPlan([
          { index: 0, taskId: T1, phase: 'claimed' },
          { index: 1, taskId: T2, phase: 'done' },
        ])}
      />,
    );

    const seg = screen.getByRole('button', { name: /子代理/ });
    expect(seg.textContent).toContain('1/2');
    expect(seg.getAttribute('title')).toContain('1 个运行中');
  });

  it('⭐ 重试过的才显示「第 N 次」（第一次是纯噪音）', () => {
    render(
      <PlanStatusBars
        plan={subPlan([
          { index: 0, taskId: T1, phase: 'claimed', attempt: 3 },
          { index: 1, taskId: T2, phase: 'claimed', attempt: 1 },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /子代理/ }));

    const rows = agentRows();
    expect(rows[0].textContent).toContain('第 3 次');
    expect(rows[1].textContent).not.toContain('第 1 次');
  });

  it('全部收工 → 栏上的相位变成"完成"、提示说"已全部完成"', () => {
    render(
      <PlanStatusBars
        plan={subPlan([
          { index: 0, taskId: T1, phase: 'done' },
          { index: 1, taskId: T2, phase: 'done' },
        ])}
      />,
    );

    const seg = screen.getByRole('button', { name: /子代理/ });
    expect(seg.getAttribute('title')).toContain('已全部完成');
    expect(seg.textContent).toContain('0/2');
  });

  it('⭐ 收工的 worker 仍显示"它干完的那件事"，不写"等待下一件任务"', () => {
    render(
      <PlanStatusBars
        plan={subPlan([{ index: 0, taskId: T1, phase: 'done' }])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /子代理/ }));

    const [row] = agentRows();
    // 右端已经是「已完成」，中间再写"等待下一件任务"就把做过什么擦掉了
    // （中间那格是 `taskShortTitle` 的缩写，这里是 T1 的「取数」）
    expect(row.textContent).toContain('取数');
    expect(row.textContent).not.toContain('等待下一件任务');
    expect(row.textContent).toContain('已完成');
  });
});
