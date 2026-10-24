// src/components/CopilotDock/usePlanFeed.test.tsx
//
// 计划快照的订阅层。它比归约本身多管两件事，而这两件都会**错得很安静**：
//
//   ① 换了一轮后端运行（runId 变了）→ 旧计划必须扔掉。
//      不扔的话，上一轮的任务栏会一直挂在输入框上面 —— 用户没有任何入口
//      能关掉它，只能刷新页面。
//   ② `plan.cleared` 丢了（后端重启 / 流被掐断 / 用户点停止）→ 同样得靠 ① 兜。
//      而"最先到的新一轮事件"往往是工具事件，不是计划事件 —— 所以这一层
//      要对**所有**带 runId 的 CUSTOM 事件做一次检查，不能只认计划事件。
//
// ⚠️ 归约本身的规则（标题、状态、整体替换…）在 planTasks.test.ts，这里不重复。

import type { AbstractAgent } from '@ag-ui/client';
import { act, render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  PLAN_EVENT,
  PLAN_RETIRE_MS,
  type PlanView,
  SUBAGENT_EVENT,
} from './planTasks';
import {
  PLAN_CUSTOM_EVENT,
  TOOL_ACTIVITY_CUSTOM_EVENT,
} from './runEventStream';
import { usePlanFeed } from './usePlanFeed';

type Emit = (name: string, value: unknown) => void;

const RUN = 'run-7c9e6679';
const PLAN = '7f3c2d1e-4a8b-4c6d-9e0f-1a2b3c4d5e6f';

/** 假 agent：只留 onCustomEvent 一个口（这条通道的契约就这一个）。 */
function stubAgent(): AbstractAgent & { emit: Emit } {
  let handler:
    | ((params: { event: { name: string; value: unknown } }) => void)
    | null = null;

  const emit: Emit = (name, value) => {
    act(() => {
      handler?.({ event: { name, value } });
    });
  };

  const agent = {
    subscribe: (params: {
      onCustomEvent?: (p: { event: { name: string; value: unknown } }) => void;
    }) => {
      handler = params.onCustomEvent ?? null;
      return {
        unsubscribe: () => {
          handler = null;
        },
      };
    },
  };

  return Object.assign(agent, { emit }) as unknown as AbstractAgent & {
    emit: Emit;
  };
}

function harness(): { emit: Emit; current: () => PlanView | null } {
  const agent = stubAgent();
  let latest: PlanView | null = null;

  const Probe: React.FC = () => {
    latest = usePlanFeed(agent);
    return null;
  };
  render(<Probe />);

  return { emit: agent.emit, current: () => latest };
}

const published = (runId = RUN) => ({
  runId,
  event: PLAN_EVENT.PUBLISHED,
  data: {
    plan_id: PLAN,
    revision: 1,
    goal: '对比本季度两家公司的财报',
    tasks: [
      {
        id: `${PLAN}:t1`,
        status: { state: 'TASK_STATE_WORKING' },
        history: [
          { role: 'ROLE_USER', parts: [{ data: { description: '取数' } }] },
        ],
        metadata: { claim: { owner: `${RUN}:main` } },
      },
    ],
    current_task_id: `${PLAN}:t1`,
  },
});

describe('usePlanFeed', () => {
  it('一开始没有计划', () => {
    expect(harness().current()).toBeNull();
  });

  it('plan.published 之后就有一份快照', () => {
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());

    expect(h.current()?.goal).toBe('对比本季度两家公司的财报');
    expect(h.current()?.tasks).toHaveLength(1);
  });

  it('⭐ 子代理四条走同一条通道，名册和任务都落在同一份快照上', () => {
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());

    const workerId = `${RUN}:worker:0`;
    const taskId = `${PLAN}:t2`;

    // 派出：这一帧没有 task，只有名册信息
    h.emit(PLAN_CUSTOM_EVENT, {
      runId: RUN,
      event: SUBAGENT_EVENT.CREATED,
      data: {
        plan_id: PLAN,
        revision: 1,
        worker_id: workerId,
        worker_index: 0,
        task_id: taskId,
        task_count: 2,
        pending_count: 2,
        context_id: 'ctx-1',
      },
    });

    // 认领：带 task 快照和 claim.owner
    h.emit(PLAN_CUSTOM_EVENT, {
      runId: RUN,
      event: SUBAGENT_EVENT.CLAIMED,
      data: {
        plan_id: PLAN,
        revision: 1,
        worker_id: workerId,
        task_id: taskId,
        current_task_id: taskId,
        task: {
          id: taskId,
          status: { state: 'TASK_STATE_WORKING' },
          history: [
            {
              role: 'ROLE_USER',
              parts: [{ data: { description: '对比另一家' } }],
            },
          ],
          metadata: { claim: { owner: workerId, attempt: 1 } },
        },
      },
    });

    const plan = h.current();
    expect(plan?.workers).toHaveLength(1);
    expect(plan?.workers[0]).toMatchObject({
      id: workerId,
      index: 0,
      phase: 'running',
      taskId,
      taskCount: 2,
    });
    // 任务面板与子代理面板是**同一份** tasks —— 这里查的就是那条。
    expect(plan?.tasks.find((task) => task.id === taskId)?.title).toBe(
      '对比另一家',
    );
    expect(plan?.currentTaskId).toBe(taskId);
    // 同一轮里的子代理事件不该触发退场动画
    expect(plan?.retiring).toBeFalsy();
  });

  it('⭐ plan.cleared 之后**留住**快照，只标 finished（dock 不消失）', () => {
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());
    h.emit(PLAN_CUSTOM_EVENT, {
      runId: RUN,
      event: PLAN_EVENT.CLEARED,
      data: { plan_id: PLAN, revision: 1, reason: 'completed' },
    });

    expect(h.current()).not.toBeNull();
    expect(h.current()?.finished).toBe(true);
    expect(h.current()?.tasks).toHaveLength(1);
  });

  it('⭐ 收摊之后的下一条计划才替换掉它', () => {
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());
    h.emit(PLAN_CUSTOM_EVENT, {
      runId: RUN,
      event: PLAN_EVENT.CLEARED,
      data: { plan_id: PLAN, revision: 1, reason: 'completed' },
    });
    h.emit(PLAN_CUSTOM_EVENT, {
      ...published(),
      data: { ...published().data, revision: 2, goal: '第二件事' },
    });

    expect(h.current()?.finished).toBe(false);
    expect(h.current()?.goal).toBe('第二件事');
  });

  it('⭐ 已收摊的计划遇到新一轮 → 同样走退场动画（不是立刻消失）', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());
    h.emit(PLAN_CUSTOM_EVENT, {
      runId: RUN,
      event: PLAN_EVENT.CLEARED,
      data: { plan_id: PLAN, revision: 1, reason: 'completed' },
    });
    expect(h.current()?.finished).toBe(true);

    // 下一轮运行的工具事件（runId 变了）—— 完成态的任务板该沉下去了
    h.emit(TOOL_ACTIVITY_CUSTOM_EVENT, {
      phase: 'start',
      callId: 'c-2',
      name: 'agent.search',
      messageId: 'm-2',
      runId: 'run-another',
    });

    expect(h.current()?.retiring).toBe(true);
    expect(h.current()?.finished).toBe(true);
    act(() => {
      vi.advanceTimersByTime(PLAN_RETIRE_MS + 10);
    });
    expect(h.current()).toBeNull();

    vi.useRealTimers();
  });

  it('⭐ 新一轮运行的第**一个工具事件**就让旧计划退场（先动画，后移除）', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());

    h.emit(TOOL_ACTIVITY_CUSTOM_EVENT, {
      phase: 'start',
      callId: 'c-1',
      name: 'agent.search',
      messageId: 'm-1',
      runId: 'run-another',
    });

    // ① 还在，但已经标成 retiring —— CSS 靠它播折叠 + 淡出
    expect(h.current()).not.toBeNull();
    expect(h.current()?.retiring).toBe(true);

    // ② 动画时长走完才真的从 state 里消失
    act(() => {
      vi.advanceTimersByTime(PLAN_RETIRE_MS + 10);
    });
    expect(h.current()).toBeNull();

    vi.useRealTimers();
  });

  it('⭐ 退场途中来了新计划 → 取消移除，dock 原地换成新内容', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());
    h.emit(TOOL_ACTIVITY_CUSTOM_EVENT, {
      phase: 'start',
      callId: 'c-1',
      name: 'agent.search',
      messageId: 'm-1',
      runId: 'run-another',
    });
    expect(h.current()?.retiring).toBe(true);

    // 新计划在路上，比 260ms 的定时器更早到
    h.emit(PLAN_CUSTOM_EVENT, {
      ...published('run-another'),
      data: { ...published().data, goal: '第二件事' },
    });
    expect(h.current()?.retiring).toBe(false);
    expect(h.current()?.goal).toBe('第二件事');

    // 定时器到点也不能把新计划抹掉
    act(() => {
      vi.advanceTimersByTime(PLAN_RETIRE_MS + 10);
    });
    expect(h.current()?.goal).toBe('第二件事');

    vi.useRealTimers();
  });

  it('同一轮里的工具事件**不会**误清计划', () => {
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());

    h.emit(TOOL_ACTIVITY_CUSTOM_EVENT, {
      phase: 'start',
      callId: 'c-1',
      name: 'agent.search',
      messageId: 'm-1',
      runId: RUN,
    });

    expect(h.current()).not.toBeNull();
  });

  it('载荷读不出来时保持原样（这条通道崩不起）', () => {
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());

    h.emit(PLAN_CUSTOM_EVENT, null);
    h.emit(PLAN_CUSTOM_EVENT, { event: 123 });
    h.emit(PLAN_CUSTOM_EVENT, { event: PLAN_EVENT.TASK_UPDATED, data: null });

    expect(h.current()).not.toBeNull();
  });

  it('⭐ 计划事件里的 runId 与当前不同 → 直接换掉，不继承旧的 goal', () => {
    const h = harness();
    h.emit(PLAN_CUSTOM_EVENT, published());
    h.emit(PLAN_CUSTOM_EVENT, {
      runId: 'run-another',
      event: PLAN_EVENT.TASK_UPDATED,
      data: {
        plan_id: 'other-plan',
        revision: 1,
        task: {
          id: 'other-plan:t1',
          status: { state: 'TASK_STATE_WORKING' },
          history: [],
          metadata: {},
        },
        current_task_id: 'other-plan:t1',
      },
    });

    expect(h.current()?.runId).toBe('run-another');
    expect(h.current()?.goal).toBe('');
  });
});
