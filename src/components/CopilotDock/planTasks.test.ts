// src/components/CopilotDock/planTasks.test.ts
//
// 任务计划的归约。喂的是后端**真实形状**的载荷（用户 2026-10-22 给的那四条
// 事件，字段名一个没改），钉的是几件"错了也不会报错、只会显示得不对"的事：
//
//   ① 标题从 `history[0]` 的 ROLE_USER 指令里取（不是 task_id / skill_key）；
//   ② 中途的 `task.updated` **不带 history**，不能把标题抹成空；
//   ③ 认不出的状态**不能**算成完成（进度条提前走满是最坏的撒谎）；
//   ④ `plan.published` 是**整体替换** —— 计划里删掉的任务要真的消失；
//   ⑤ 换了后端 run_id，上一份计划必须作废（cleared 丢帧时的兜底）；
//   ⑥ 子代理只认 `claim.owner` 不是 `:main` 的那些；
//   ⑦ 子代理那四条事件（2026-10-23 上线）：
//      · created 只进名册（还没有 task，任务板上也没 owner）；
//      · claimed / task.updated / completed 带的 task 快照要并进 tasks；
//      · 名册按 `worker_id` **原地更新**（新一波复用同一批 id）；
//      · 并行时"某个 worker 交差"不能把别人的 currentTaskId 清掉。
//
// ⚠️ 第 ⑥ 条是**兜底**了：并行 sub_agent 事件已经上线，名册是主判据；
//   但老后端 / 名册丢帧时仍然只能从 claim.owner 反推，所以两条路都要留着。

import { describe, expect, it } from 'vitest';
import {
  agentName,
  currentPlanTask,
  currentTask,
  isPlanEvent,
  isSubAgent,
  isSubAgentEvent,
  isSubAgentTerminalEvent,
  PLAN_EVENT,
  type PlanEventPayload,
  type PlanView,
  parseWorker,
  planAgents,
  planCounts,
  reducePlan,
  SUBAGENT_EVENT,
  subAgentBarSummary,
  subAgentPhase,
  subAgents,
  taskPhase,
  taskTitle,
} from './planTasks';

const RUN = 'run-7c9e6679';
const PLAN = '7f3c2d1e-4a8b-4c6d-9e0f-1a2b3c4d5e6f';
const T1 = `${PLAN}:t1`;

const frame = (
  event: string,
  data: Record<string, unknown>,
  runId = RUN,
): PlanEventPayload => ({ runId, event, data });

/** 一帧 plan.published（用户给的原样）。 */
const published = () =>
  frame(PLAN_EVENT.PUBLISHED, {
    plan_id: PLAN,
    revision: 1,
    goal: '对比本季度两家公司的财报',
    tasks: [
      {
        id: T1,
        contextId: 'session-550e8400',
        status: {
          state: 'TASK_STATE_SUBMITTED',
          timestamp: '2026-10-22T09:00:00Z',
        },
        history: [
          {
            messageId: `${T1}:message:1`,
            contextId: 'session-550e8400',
            taskId: T1,
            role: 'ROLE_USER',
            parts: [
              {
                data: {
                  description: '获取并整理 A 公司本季度财报',
                  params: { symbol: 'AAPL', period: '2026Q3' },
                },
                mediaType: 'application/json',
              },
            ],
          },
        ],
        metadata: {
          skill_key: 'financial_research',
          plan_id: PLAN,
          plan_task_id: 't1',
          plan_revision: 1.0,
          blocked_by: [],
          blocked: [`${PLAN}:t2`],
          block_policy: 'all_succeeded',
          capabilities: ['web.search'],
          claim: {},
        },
      },
    ],
    current_task_id: T1,
    task_count: 1,
  });

/**
 * 一帧 task.updated。
 *
 * ⚠️ 用户给的样例里 `metadata` 有**两个** `claim` 键（一个填了 owner、一个空），
 *   JSON 只能保留最后一个 —— 真按字面解析出来 owner 就是空的。这里按"意图"
 *   只写填了 owner 的那个，并在最后一条用例里把这个坑记下来。
 */
const updated = (
  state: string,
  extra: Record<string, unknown> = {},
  metadataExtra: Record<string, unknown> = {},
) =>
  frame(PLAN_EVENT.TASK_UPDATED, {
    plan_id: PLAN,
    revision: 1,
    task: {
      id: T1,
      contextId: 'session-550e8400',
      status: { state, timestamp: '2026-10-22T09:00:01Z' },
      // 中途帧的 history 里没有 ROLE_USER 了（样例里是占位 "..."）
      history: ['...'],
      metadata: {
        ...metadataExtra,
        blocked_by: [],
        blocked: [`${PLAN}:t2`],
        skill_key: 'financial_research',
        capabilities: ['web.search'],
        claim: {
          owner: `${RUN}:main`,
          token: '16d0eba9-65be-4375-84e1-aeb3f4d965da',
          claimed_at: '2026-10-22T09:00:01Z',
          lease_expires_at: '2026-10-22T09:05:01Z',
          attempt: 1,
        },
        ...extra,
      },
    },
    current_task_id: T1,
  });

const cleared = () =>
  frame(PLAN_EVENT.CLEARED, {
    plan_id: PLAN,
    revision: 1,
    reason: 'completed',
  });

/** 依次归约，返回最后一份快照。 */
const run = (frames: PlanEventPayload[]) =>
  frames.reduce<PlanView | null>(reducePlan, null);

describe('事件名', () => {
  it('计划三条 + 子代理四条都认得，别的事件不接管', () => {
    for (const name of [
      'plan.published',
      'task.updated',
      'plan.cleared',
      'subagent.created',
      'subagent.claimed',
      'subagent.task.updated',
      'subagent.completed',
    ]) {
      expect(isPlanEvent(name)).toBe(true);
    }
    // run 事件不属于这张词表 —— 抢过来会把"运行生命周期"和"任务编排"混成一套
    expect(isPlanEvent('run.completed')).toBe(false);
    expect(isPlanEvent('task.something')).toBe(false);
    // `subagent.` 开头的别的东西也不接管（词表是白名单，不是前缀匹配）
    expect(isPlanEvent('subagent.unknown')).toBe(false);
  });

  it('子代理那四条单独认得出，计划三条不算', () => {
    for (const name of [
      'subagent.created',
      'subagent.claimed',
      'subagent.task.updated',
      'subagent.completed',
    ]) {
      expect(isSubAgentEvent(name)).toBe(true);
    }
    expect(isSubAgentEvent('plan.published')).toBe(false);
    expect(isSubAgentEvent('task.updated')).toBe(false);
  });

  it('只有 task.updated / completed 算"收尾"（claimed 是开跑）', () => {
    expect(isSubAgentTerminalEvent('subagent.task.updated')).toBe(true);
    expect(isSubAgentTerminalEvent('subagent.completed')).toBe(true);
    expect(isSubAgentTerminalEvent('subagent.claimed')).toBe(false);
    expect(isSubAgentTerminalEvent('subagent.created')).toBe(false);
    expect(isSubAgentTerminalEvent('task.updated')).toBe(false);
  });
});

describe('状态词表', () => {
  it('剥掉 TASK_STATE_ 前缀再比，常见别名也认', () => {
    expect(taskPhase('TASK_STATE_SUBMITTED')).toBe('pending');
    expect(taskPhase('TASK_STATE_WORKING')).toBe('running');
    expect(taskPhase('TASK_STATE_COMPLETED')).toBe('done');
    expect(taskPhase('TASK_STATE_FAILED')).toBe('failed');
    expect(taskPhase('TASK_STATE_CANCELED')).toBe('canceled');
    expect(taskPhase('in_progress')).toBe('running');
  });

  it('⭐ 认不出的值归 unknown —— **不能**当成完成', () => {
    // 后端将来会加 auth-required 之类。当成完成会让进度条提前走满。
    expect(taskPhase('TASK_STATE_AUTH_REQUIRED')).toBe('unknown');
    expect(taskPhase('')).toBe('unknown');

    const plan = run([published(), updated('TASK_STATE_AUTH_REQUIRED')]);
    expect(planCounts(plan as PlanView)).toMatchObject({ done: 0, total: 1 });
  });
});

describe('标题', () => {
  it('取 ROLE_USER 指令里的 description，不是 task_id / skill_key', () => {
    const plan = run([published()]) as PlanView;
    expect(plan.tasks[0].title).toBe('获取并整理 A 公司本季度财报');
  });

  it('没有 data.description 时退到 parts[].text', () => {
    expect(
      taskTitle({
        history: [{ role: 'ROLE_USER', parts: [{ text: '看下这只票的量' }] }],
      }),
    ).toBe('看下这只票的量');
  });

  it('⭐ 只认 ROLE_USER：ROLE_AGENT 的结果不拿来当标题', () => {
    expect(
      taskTitle({
        history: [
          {
            role: 'ROLE_AGENT',
            parts: [{ text: 'A 公司本季度营收 100 亿美元' }],
          },
        ],
      }),
    ).toBe('');
  });
});

describe('归约：一条任务的一生', () => {
  it('published → 一条排队中的任务，认领者还空着', () => {
    const plan = run([published()]) as PlanView;

    expect(plan.planId).toBe(PLAN);
    expect(plan.goal).toBe('对比本季度两家公司的财报');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      id: T1,
      phase: 'pending',
      owner: '',
      skillKey: 'financial_research',
      blockedBy: [],
    });
    expect(plan.currentTaskId).toBe(T1);
  });

  it('⭐ WORKING 那一帧换了状态与认领者，但**标题还在**（它这帧没带 history）', () => {
    const plan = run([published(), updated('TASK_STATE_WORKING')]) as PlanView;

    expect(plan.tasks[0]).toMatchObject({
      phase: 'running',
      owner: `${RUN}:main`,
      title: '获取并整理 A 公司本季度财报',
    });
    // 正在跑的就是它 —— 状态栏折叠态那句人话靠这个
    expect(currentTask(plan)?.id).toBe(T1);
  });

  it('COMPLETED 那一帧：完成 + 拿到 result_summary，且不再有"正在跑"的', () => {
    const plan = run([
      published(),
      updated('TASK_STATE_WORKING'),
      frame(PLAN_EVENT.TASK_UPDATED, {
        plan_id: PLAN,
        revision: 1,
        task: {
          id: T1,
          status: {
            state: 'TASK_STATE_COMPLETED',
            timestamp: '2026-10-22T09:05:00Z',
          },
          history: ['...'],
          metadata: {
            claim: {},
            result_summary: 'A 公司本季度营收 100 亿美元，同比增长 12%。',
          },
        },
        current_task_id: null,
      }),
    ]) as PlanView;

    expect(plan.tasks[0].phase).toBe('done');
    expect(plan.tasks[0].resultSummary).toBe(
      'A 公司本季度营收 100 亿美元，同比增长 12%。',
    );
    // ⚠️ 这一帧的 claim 是空的 —— 不清理历史值的话 owner 会一直挂着，
    //    "谁干的"在完成之后就不该还自称在跑。
    expect(plan.tasks[0].owner).toBe(`${RUN}:main`);
    // 后端说现在没有在跑的任务
    expect(currentTask(plan)).toBeNull();
    expect(planCounts(plan)).toMatchObject({ total: 1, done: 1, running: 0 });
  });

  it('⭐ plan.cleared → 快照**留着**并标 finished（dock 不消失，等下一次任务）', () => {
    const plan = run([published(), cleared()]) as PlanView;

    expect(plan).not.toBeNull();
    expect(plan.finished).toBe(true);
    expect(plan.finishReason).toBe('completed');
    // 任务本身还在（用户要能回看跑完了哪几条）
    expect(plan.tasks).toHaveLength(1);
    // 收摊之后没有"当前任务"
    expect(plan.currentTaskId).toBeNull();
  });

  it('重复的 cleared 返回同一个引用（后端可能连发两帧）', () => {
    const once = run([published(), cleared()]);
    expect(reducePlan(once, cleared())).toBe(once);
  });

  it('⭐ 下一份 plan.published 才把 finished 清掉（新一轮任务重新开始跑）', () => {
    const plan = run([
      published(),
      cleared(),
      frame(PLAN_EVENT.PUBLISHED, { ...published().data, revision: 2 }),
    ]) as PlanView;

    expect(plan.finished).toBe(false);
    expect(plan.finishReason).toBe('');
    expect(plan.revision).toBe(2);
    expect(plan.retiring).toBe(false);
  });

  it('收摊之后迟到的 task.updated 不会把 finished 翻回去', () => {
    const plan = run([
      published(),
      cleared(),
      updated('TASK_STATE_COMPLETED'),
    ]) as PlanView;

    expect(plan.finished).toBe(true);
    expect(plan.tasks[0].phase).toBe('done');
  });
});

describe('归约：几种结构性边界', () => {
  it('⭐ published 是**整体替换**：计划里删掉的任务要真的消失', () => {
    const two = {
      ...published().data,
      tasks: [
        ...(published().data.tasks as unknown[]),
        {
          id: `${PLAN}:t2`,
          status: { state: 'TASK_STATE_SUBMITTED' },
          history: [
            {
              role: 'ROLE_USER',
              parts: [{ data: { description: '对比 B 公司' } }],
            },
          ],
          metadata: {},
        },
      ],
    };

    const before = run([frame(PLAN_EVENT.PUBLISHED, two)]) as PlanView;
    expect(before.tasks).toHaveLength(2);

    // revision 2 只剩 t1 —— 按 id 合并的话 t2 会变成幽灵留在列表里
    const after = run([
      frame(PLAN_EVENT.PUBLISHED, two),
      frame(PLAN_EVENT.PUBLISHED, { ...published().data, revision: 2 }),
    ]) as PlanView;

    expect(after.tasks.map((task) => task.id)).toEqual([T1]);
    expect(after.revision).toBe(2);
  });

  it('⭐ 换了后端 run_id → 上一份计划作废（cleared 丢帧时的兜底）', () => {
    const plan = run([
      published(),
      // 新一轮运行的第一个任务事件 —— 它不是计划事件本可以不管，
      // 但计划事件先到时也必须认得出"这是另一轮"
      frame(
        PLAN_EVENT.TASK_UPDATED,
        updated('TASK_STATE_WORKING').data,
        'run-other',
      ),
    ]) as PlanView;

    // 新 run 的这条 task 会重新建一份快照：老计划（含 goal）不该被继承
    expect(plan.runId).toBe('run-other');
    expect(plan.goal).toBe('');
    expect(plan.tasks).toHaveLength(1);
  });

  it('task.updated 早于 published 也接得住（不抛，先立一份）', () => {
    const plan = run([updated('TASK_STATE_WORKING')]) as PlanView;
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].phase).toBe('running');
    // 标题这时读不到（这帧没 history）—— 由组件降级显示，不在这里编
    expect(plan.tasks[0].title).toBe('');
  });

  it('同一帧内容没变时返回**同一个引用**（不让 React 白重渲染）', () => {
    const first = run([published(), updated('TASK_STATE_WORKING')]);
    const again = reducePlan(first, updated('TASK_STATE_WORKING'));
    expect(again).toBe(first);
  });

  it('读不出来的载荷不影响已有快照', () => {
    const plan = run([published()]);
    expect(
      reducePlan(plan, frame(PLAN_EVENT.TASK_UPDATED, { task: null })),
    ).toBe(plan);
    expect(
      reducePlan(plan, { runId: RUN, event: 'plan.unknown', data: {} }),
    ).toBe(plan);
  });
});

describe('执行者分组（子代理的过渡期判据）', () => {
  it('owner 取名册后半段；只有非 main 算子代理', () => {
    expect(agentName(`${RUN}:main`)).toBe('main');
    expect(agentName(`${RUN}:agent-3`)).toBe('agent-3');
    expect(isSubAgent(`${RUN}:main`)).toBe(false);
    expect(isSubAgent(`${RUN}:agent-3`)).toBe(true);
    expect(isSubAgent('')).toBe(false);
  });

  it('⭐ 主代理一个人干完 → 子代理列表是空的（状态栏据此说"暂无并行子代理"）', () => {
    const plan = run([published(), updated('TASK_STATE_WORKING')]) as PlanView;
    expect(subAgents(plan)).toEqual([]);
    expect(planAgents(plan)).toHaveLength(1);
  });

  it('并行时按 owner 分组，执行中的排前面', () => {
    const plan = run([
      published(),
      frame(PLAN_EVENT.TASK_UPDATED, {
        plan_id: PLAN,
        revision: 1,
        task: {
          id: `${PLAN}:t2`,
          status: { state: 'TASK_STATE_WORKING' },
          history: [
            {
              role: 'ROLE_USER',
              parts: [{ data: { description: '对比 B 公司' } }],
            },
          ],
          metadata: { claim: { owner: `${RUN}:agent-3` } },
        },
        current_task_id: `${PLAN}:t2`,
      }),
    ]) as PlanView;

    const agents = planAgents(plan);
    // 主代理的 t1 还停在 SUBMITTED（没被认领）→ 不在分组里
    expect(agents.map((agent) => agent.name)).toEqual(['agent-3']);
    expect(subAgents(plan)[0].tasks[0].title).toBe('对比 B 公司');
    expect(subAgents(plan)[0].running).toBe(true);
  });

  it('⚠️ 样例里的重复 claim 键：JSON 只留最后一个（空对象），owner 就是空的', () => {
    // 这条不是"期望行为"，是把已知的坑写在测试里：用户给的 task.updated 样例
    // 有两个 claim 键，按 JSON 语义解析后是 {}，于是子代理名册会是空的。
    const dup = JSON.parse(
      '{"plan_id":"p","revision":1,"task":{"id":"p:t1","status":{"state":"TASK_STATE_WORKING"},"metadata":{"claim":{"owner":"run-1:main"},"claim":{}}}}',
    ) as Record<string, unknown>;

    const plan = run([frame(PLAN_EVENT.TASK_UPDATED, dup)]) as PlanView;
    expect(plan.tasks[0].owner).toBe('');
  });
});

// ---------------------------------------------------------------------------
// currentPlanTask：**此刻在跑的是哪个任务**（给实时时间线用）
//
// 时间线要回答的是"这条消息开出来的那一刻属于哪个任务"。判据必须能区分
// 「这一帧说明某个任务开跑了」与「这一帧说明某个任务收尾了」—— 后者如果
// 还被当成"当前任务"，主代理收尾时的总结就会被吸进最后一个任务的轨道。
// ---------------------------------------------------------------------------
describe('currentPlanTask：此刻在跑哪个任务', () => {
  const taskOf = (id: string, state: string) => ({
    id,
    status: { state },
    metadata: { skill_key: 'financial_research' },
    history: [
      { role: 'ROLE_USER', parts: [{ data: { description: `${id} 的说明` } }] },
    ],
  });

  it('plan.published + current_task_id -> 就是它，标题读 history 里那句说明', () => {
    expect(
      currentPlanTask(PLAN_EVENT.PUBLISHED, {
        plan_id: PLAN,
        current_task_id: T1,
        tasks: [taskOf(T1, 'TASK_STATE_WORKING')],
      }),
    ).toEqual({ taskId: T1, title: `${T1} 的说明`, planId: PLAN });
  });

  it('★ 任务收尾那一帧（state=completed）-> null（不许把总结吸进轨道）', () => {
    expect(
      currentPlanTask(PLAN_EVENT.TASK_UPDATED, {
        plan_id: PLAN,
        current_task_id: T1,
        task: taskOf(T1, 'TASK_STATE_COMPLETED'),
      }),
    ).toBeNull();
  });

  it('task.updated 换成另一个任务 -> 认新那个', () => {
    const t2 = `${PLAN}:t2`;

    expect(
      currentPlanTask(PLAN_EVENT.TASK_UPDATED, {
        plan_id: PLAN,
        current_task_id: t2,
        task: taskOf(t2, 'TASK_STATE_WORKING'),
      }),
    ).toMatchObject({ taskId: t2 });
  });

  it('plan.cleared -> null（这次计划收摊了）', () => {
    expect(
      currentPlanTask(PLAN_EVENT.CLEARED, {
        plan_id: PLAN,
        reason: 'completed',
      }),
    ).toBeNull();
  });

  it('只给了 current_task_id、任务本体读不到 -> 只留 id（标题空）', () => {
    expect(
      currentPlanTask(PLAN_EVENT.TASK_UPDATED, {
        plan_id: PLAN,
        current_task_id: T1,
        task: { id: `${PLAN}:t9`, status: { state: 'TASK_STATE_WORKING' } },
      }),
    ).toEqual({ taskId: T1, title: '', planId: PLAN });
  });

  it('没有 current_task_id 时退回"第一条 working"；一条 working 都没有 -> null', () => {
    expect(
      currentPlanTask(PLAN_EVENT.PUBLISHED, {
        plan_id: PLAN,
        tasks: [
          taskOf(`${PLAN}:t1`, 'TASK_STATE_SUBMITTED'),
          taskOf(`${PLAN}:t2`, 'TASK_STATE_WORKING'),
        ],
      }),
    ).toMatchObject({ taskId: `${PLAN}:t2` });

    expect(
      currentPlanTask(PLAN_EVENT.PUBLISHED, {
        plan_id: PLAN,
        tasks: [taskOf(T1, 'TASK_STATE_SUBMITTED')],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 子代理族：subagent.created / claimed / task.updated / completed
// （2026-10-23 后端上线，载荷照用户给的样例写，字段名一个没改）
//
// 钉的是并行波次里最容易错的三件事：
//   · created 那一刻**还没有 task** —— 只有名册，任务板上也没 owner；
//   · 名册按 `worker_id` **原地更新**，不是一条一条追加（否则一波答完就成了
//     "15 个子代理"）；
//   · 某个 worker 交差**不许**把别人的 currentTaskId 清掉（它的
//     `current_task_id` 恒为 null，无条件照抄就会清空）。
// ---------------------------------------------------------------------------
describe('子代理：四个事件与名册', () => {
  const WORKER0 = `${RUN}:worker:0`;
  const WORKER1 = `${RUN}:worker:1`;
  const T2 = `${PLAN}:t2`;

  /** 两条任务的计划 —— 并行波次至少要有两条才说得上"并行"。 */
  const publishedTwo = () =>
    frame(PLAN_EVENT.PUBLISHED, {
      plan_id: PLAN,
      revision: 1,
      goal: '对比本季度两家公司的财报',
      tasks: [T1, T2].map((id) => ({
        id,
        status: { state: 'TASK_STATE_SUBMITTED' },
        history: [
          {
            role: 'ROLE_USER',
            parts: [{ data: { description: `${id} 的说明` } }],
          },
        ],
        metadata: { skill_key: 'financial_research' },
      })),
      current_task_id: null,
    });

  /** A2A canonical task 快照（claim 之后那一份）。 */
  const snapshot = (
    id: string,
    state: string,
    owner: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    status: { state, timestamp: '2026-10-23T09:00:01Z' },
    metadata: {
      plan_id: PLAN,
      skill_key: 'financial_research',
      blocked_by: [],
      claim: owner ? { owner, token: 'tok', attempt: 1 } : {},
      ...extra,
    },
  });

  const created = (
    worker: string,
    index: number,
    taskId: string,
    pending = 4,
  ) =>
    frame(SUBAGENT_EVENT.CREATED, {
      plan_id: PLAN,
      revision: 1,
      worker_id: worker,
      worker_index: index,
      task_id: taskId,
      task_count: 5,
      pending_count: pending,
      context_id: 'session-550e8400',
    });

  const claimed = (worker: string, taskId: string) =>
    frame(SUBAGENT_EVENT.CLAIMED, {
      plan_id: PLAN,
      revision: 1,
      worker_id: worker,
      task_id: taskId,
      current_task_id: taskId,
      task: snapshot(taskId, 'TASK_STATE_WORKING', worker),
    });

  const taskUpdated = (worker: string, taskId: string, state: string) =>
    frame(SUBAGENT_EVENT.TASK_UPDATED, {
      plan_id: PLAN,
      revision: 1,
      worker_id: worker,
      task_id: taskId,
      previous_state: 'TASK_STATE_WORKING',
      current_task_id: null,
      task: snapshot(taskId, state, worker, {
        result_summary: 'A 公司本季度营收 ...',
      }),
    });

  const completed = (
    worker: string,
    taskId: string,
    state = 'TASK_STATE_COMPLETED',
  ) =>
    frame(SUBAGENT_EVENT.COMPLETED, {
      plan_id: PLAN,
      revision: 1,
      worker_id: worker,
      task_id: taskId,
      status: state,
      task: {
        ...snapshot(taskId, state, worker),
        artifacts: [
          {
            artifactId: `${taskId}:result:1`,
            name: 'task_result',
            parts: [{ text: 'A 公司本季度营收 ...' }],
            metadata: { task_id: taskId, kind: 'task_result' },
          },
        ],
      },
    });

  it('⭐ created 只进名册：那一刻还没有 task，任务板上也没有 owner', () => {
    const plan = run([publishedTwo(), created(WORKER0, 0, T1)]) as PlanView;

    expect(plan.workers).toHaveLength(1);
    expect(plan.workers[0]).toMatchObject({
      id: WORKER0,
      index: 0,
      // created 的载荷里没有 status —— 归"已派出"，不是"执行中"
      phase: 'pending',
      taskId: T1,
      taskCount: 5,
      pendingCount: 4,
      // 没认领就没有 attempt（0 = 没给）
      attempt: 0,
    });

    // 任务板上这条还没被认领
    expect(plan.tasks.find((task) => task.id === T1)?.owner).toBe('');
    // 但子代理那一栏已经有这一行了，而且没在跑
    expect(subAgents(plan).map((agent) => agent.name)).toEqual(['worker:0']);
    expect(subAgents(plan)[0].running).toBe(false);
    // 任务总数不会因为它凭空多一条
    expect(planCounts(plan).total).toBe(2);
    // created 不说"谁在跑"，所以不许把 currentTaskId 提前设上
    expect(plan.currentTaskId).toBeNull();
  });

  it('⭐ claimed：名册**原地更新**（不是追加），task 快照并进任务表', () => {
    const plan = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
    ]) as PlanView;

    // 仍然是 1 条 —— 同一个 worker 从"已派出"变成了"执行中"
    expect(plan.workers).toHaveLength(1);
    expect(plan.workers[0]).toMatchObject({
      id: WORKER0,
      phase: 'running',
      attempt: 1,
      // created 带的计数不能被后续帧（没带）抹掉
      taskCount: 5,
      pendingCount: 4,
    });

    // claim 的快照落进任务表：状态 + 认领者都跟着变
    const task = plan.tasks.find((item) => item.id === T1);
    expect(task?.phase).toBe('running');
    expect(task?.owner).toBe(WORKER0);
    expect(plan.currentTaskId).toBe(T1);
    expect(subAgents(plan)[0].running).toBe(true);
  });

  it('⭐ 收尾：worker 变 done、任务拿到 result_summary、currentTaskId 撤回', () => {
    const plan = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
      taskUpdated(WORKER0, T1, 'TASK_STATE_COMPLETED'),
      completed(WORKER0, T1),
    ]) as PlanView;

    expect(plan.workers).toHaveLength(1);
    expect(plan.workers[0].phase).toBe('done');

    const task = plan.tasks.find((item) => item.id === T1);
    expect(task?.phase).toBe('done');
    expect(task?.resultSummary).toBe('A 公司本季度营收 ...');

    // 它正好是 current → 撤回（否则主对话的收尾回答会被吸进这个任务的轨道）
    expect(plan.currentTaskId).toBeNull();
    expect(subAgentPhase(plan)).toBe('done');
    expect(subAgentBarSummary(plan)).toBe('1 个子代理 · 已全部完成');
  });

  it('⭐ 并行：一个 worker 交差**不许**清掉另一个的 currentTaskId', () => {
    const plan = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
      created(WORKER1, 1, T2),
      claimed(WORKER1, T2),
      // worker0 先交差（它的 current_task_id 是 null）
      taskUpdated(WORKER0, T1, 'TASK_STATE_COMPLETED'),
      completed(WORKER0, T1),
    ]) as PlanView;

    expect(plan.workers.map((worker) => worker.phase)).toEqual([
      'done',
      'running',
    ]);
    // 关键：currentTaskId 还是 worker1 那条
    expect(plan.currentTaskId).toBe(T2);
    expect(subAgents(plan).map((agent) => agent.name)).toEqual([
      'worker:0',
      'worker:1',
    ]);
    expect(subAgentPhase(plan)).toBe('running');
    expect(subAgentBarSummary(plan)).toBe('1 个运行中');
  });

  it('⭐ 新一波复用同一批 worker_id → 名册**重置**，不会越滚越长', () => {
    const plan = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
      taskUpdated(WORKER0, T1, 'TASK_STATE_COMPLETED'),
      completed(WORKER0, T1),
      // 还有 ready task → 后端再派一波，worker_id 不变
      created(WORKER0, 0, T2, 0),
    ]) as PlanView;

    expect(plan.workers).toHaveLength(1);
    expect(plan.workers[0]).toMatchObject({
      id: WORKER0,
      phase: 'pending',
      taskId: T2,
      taskCount: 5,
      // 这一波只剩 0 个待认领 —— 0 是**真值**，不是"没给"
      pendingCount: 0,
    });
  });

  it('plan.cleared 之后名册留着（dock 还要显示最终状态）', () => {
    const plan = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
      taskUpdated(WORKER0, T1, 'TASK_STATE_COMPLETED'),
      completed(WORKER0, T1),
      cleared(),
    ]) as PlanView;

    expect(plan.finished).toBe(true);
    expect(plan.workers).toHaveLength(1);
    expect(plan.workers[0].phase).toBe('done');
  });

  it('同一份 plan_id 的 published 保留名册；换了 plan_id 就清空', () => {
    const base = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
    ]) as PlanView;
    expect(base.workers).toHaveLength(1);

    // 同一份计划（revision 涨了）—— 名册是这份计划的，不能丢
    const samePlan = reducePlan(
      base,
      frame(PLAN_EVENT.PUBLISHED, {
        plan_id: PLAN,
        revision: 2,
        tasks: [{ id: T1, status: { state: 'TASK_STATE_WORKING' } }],
        current_task_id: T1,
      }),
    ) as PlanView;
    expect(samePlan.workers).toHaveLength(1);

    // 另一份计划 —— 上一份的 worker 一个都不算
    const otherPlan = reducePlan(
      base,
      frame(PLAN_EVENT.PUBLISHED, {
        plan_id: 'another-plan',
        revision: 1,
        tasks: [],
        current_task_id: null,
      }),
    ) as PlanView;
    expect(otherPlan.workers).toEqual([]);
  });

  it('同一帧重复到达 → 返回同一个引用（不让 React 白渲染）', () => {
    const plan = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
    ]) as PlanView;

    // 名册没变、任务快照也没变 → 不造新快照
    expect(reducePlan(plan, claimed(WORKER0, T1))).toBe(plan);

    // task.updated 与 completed 带的常常是同一份终态快照：第二帧不该再造一份
    const once = reducePlan(plan, completed(WORKER0, T1)) as PlanView;
    expect(reducePlan(once, completed(WORKER0, T1))).toBe(once);
  });

  it('重放一条 created 会把已有的 worker 打回"已派出"（下一秒 claimed 就纠正）', () => {
    // ⚠️ 这条写的是**已知代价**，不是期望的常态：created 与"新一波复用同一批
    //    worker_id"在载荷上完全一样（只有 task_id 能区分），所以没法既让新一波
    //    正确重置、又让重放的旧帧被忽略。重放本身是协议异常（SSE 续传不会重发
    //    已处理过的帧），代价只是"闪一下已派出"，下一条 claimed 立刻改回来。
    const plan = run([
      publishedTwo(),
      created(WORKER0, 0, T1),
      claimed(WORKER0, T1),
    ]) as PlanView;

    const replayed = reducePlan(plan, created(WORKER0, 0, T1)) as PlanView;
    expect(replayed.workers[0].phase).toBe('pending');
  });

  it('parseWorker：没有 worker_id 就丢；缺的数字是 null 而不是 0', () => {
    expect(parseWorker(SUBAGENT_EVENT.CREATED, { task_id: T1 })).toBeNull();

    const worker = parseWorker(SUBAGENT_EVENT.CLAIMED, {
      worker_id: WORKER0,
      task_id: T1,
    });
    expect(worker).toMatchObject({
      id: WORKER0,
      // 没有 status 的 claimed → 按"认领了就是在跑"处理
      phase: 'running',
      taskCount: null,
      pendingCount: null,
      attempt: 0,
    });
  });
});

describe('子代理：owner 名字与群体相位', () => {
  const WORKER0 = `${RUN}:worker:0`;

  it('⭐ `run-x:worker:0` 要留两段 —— 只取最后一段会变成 "0"', () => {
    expect(agentName(WORKER0)).toBe('worker:0');
    expect(agentName(`${RUN}:main`)).toBe('main');
    expect(isSubAgent(WORKER0)).toBe(true);
    // 不做"取最后两段"那种通配：run_id 里出现 ':' 时会被切错
    expect(agentName('run:a:b:main')).toBe('main');
    expect(agentName('')).toBe('');
  });

  it('没有子代理 → canceled（灰）；这一批的相位顺序：在跑 > 失败 > 全完成', () => {
    const withWorkers = (phases: string[]) =>
      run([
        frame(PLAN_EVENT.PUBLISHED, { plan_id: PLAN, tasks: [] }),
        ...phases.map((phase, index) =>
          frame(SUBAGENT_EVENT.COMPLETED, {
            plan_id: PLAN,
            worker_id: `${RUN}:worker:${index}`,
            worker_index: index,
            task_id: `${PLAN}:t${index}`,
            status: phase,
          }),
        ),
      ]) as PlanView;

    // 一个 worker 都没有 —— 灰，而不是"失败"
    expect(subAgentPhase(withWorkers([]))).toBe('canceled');
    expect(
      subAgentPhase(withWorkers(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'])),
    ).toBe('failed');
    expect(subAgentPhase(withWorkers(['TASK_STATE_COMPLETED']))).toBe('done');
  });
});
