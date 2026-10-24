// src/components/CopilotDock/runEventStream.test.ts
//
// runEventStream.ts 这一层原来只有**间接**覆盖（agent.test.ts 从 run() 那一端喂帧，
// 顺路走到这里）。本文件补的是它自己那几条**契约**，都是"错了也不会报错、
// 只会在界面上悄悄不对"的那种：
//
//   ① `hitlInterrupt` 把后端的 `hitl.requested` 翻成中断时，**带进去什么、不带什么**。
//      本轮新增的两样（`waitSeconds` / `requestedAt`）是倒计时的全部原料 ——
//      而**必须缺席**的那样（`expiresAt`）才是关键，见下面那段长注释。
//   ② 一组并行审批里，**每一条**中断的锚点是**它自己那一帧**的 `occurred_at`，
//      不是整组第一帧的。共用第一帧的时刻会让后面几条的倒计时凭空多出一截。
//
// ⚠️ 为什么 `expiresAt` 值得一条专门的用例
// ----------------------------------------
//   它是 AG-UI 协议里真实存在的字段，看起来正是为倒计时准备的 —— 下一个人
//   很容易"顺手填上"。但 `useInterrupt` 会真拿它执法，而且方式很糟（详见
//   runEventStream.ts 里那段注释与 HitlInterrupt.tsx 的文件头）。
//   所以这里用一条断言把它钉死：谁填了，谁在这里红。

import { type BaseEvent, EventType } from '@ag-ui/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunEventFrame } from './agentRuntime';
import { liveTaskOf, resetLiveTasks } from './liveTaskFeed';
import type { PlanEventPayload } from './planTasks';
import {
  applyReasoning,
  REASONING_CUSTOM_EVENT,
  type ReasoningPayload,
  reasoningEntryOf,
  resetReasoning,
} from './reasoningStream';
import {
  hitlInterrupt,
  PLAN_CUSTOM_EVENT,
  PROGRESS_CUSTOM_EVENT,
  progressLabel,
  RunEventTranslator,
  TOOL_ACTIVITY_CUSTOM_EVENT,
} from './runEventStream';

/** 一帧后端事件。带 `occurred_at` —— 真实信封里它恒在（见 RunEventFrame）。 */
const frame = (
  data: Record<string, unknown>,
  options: { id?: string; occurredAt?: unknown } = {},
): RunEventFrame => ({
  id: options.id,
  event: 'hitl.requested',
  payload: {
    event: 'hitl.requested',
    topic: 'agent_run',
    topic_id: 'r-1',
    node: 'tools',
    occurred_at: options.occurredAt,
    data,
  },
  data,
});

const APPROVAL_DATA: Record<string, unknown> = {
  ask: '是否允许执行该工具调用？',
  tool_key: 'agent.platform.describe_platform',
  arguments: { tool_limit: 20 },
  approver_role: null,
  options: ['approve', 'reject', 'always'],
  run_id: 'run-1',
  wait_seconds: 300,
  interrupt_id: 'int-1',
};

const OCCURRED_AT = '2026-10-06T10:00:00Z';

/**
 * 从一帧里翻出一个中断（结果一定是非空，否则用例本就该红）。
 *
 * ⚠️ `occurredAt` **不给默认值**，要传就显式传 —— 写成默认参数的话，
 *   专门用来验"缺 occurred_at"的那些用例传 `undefined` 会被默认值吃掉，
 *   于是它们变成在测"有 occurred_at"的情况：一条本意是"缺了就不画"的断言
 *   会永远通过。假绿比红更危险（本轮真踩了一次）。
 */
const translate = (data: Record<string, unknown>, occurredAt?: unknown) => {
  const interrupt = hitlInterrupt(data, occurredAt);
  if (!interrupt) throw new Error('这一帧本该翻得出中断');
  return interrupt;
};

describe('hitlInterrupt：倒计时的两样原料', () => {
  it('带 wait_seconds + occurred_at → 两样都进 metadata（卡片据此画倒计时）', () => {
    const interrupt = translate(APPROVAL_DATA, OCCURRED_AT);

    expect(interrupt.metadata?.waitSeconds).toBe(300);
    expect(interrupt.metadata?.requestedAt).toBe(OCCURRED_AT);
  });

  it('⭐ 绝不设 expiresAt —— 填了它 `useInterrupt` 会静默丢弃整组答案（防回归）', () => {
    const interrupt = translate(APPROVAL_DATA, OCCURRED_AT);

    // 顶层字段（AG-UI 协议里 `isInterruptExpired` 读的就是它）
    expect('expiresAt' in interrupt).toBe(false);
    // metadata 里也不能有 —— 那是同一件事的另一个名字，一样会误导下一个人
    expect(
      Object.keys(interrupt.metadata ?? {}).some(
        (key) => key.toLowerCase() === 'expiresat',
      ),
    ).toBe(false);
  });

  it('后端没给 wait_seconds（老版本）→ 只少了倒计时，别的照旧', () => {
    const { wait_seconds: _ignored, ...withoutWait } = APPROVAL_DATA;
    const interrupt = translate(withoutWait, OCCURRED_AT);

    expect(interrupt.metadata?.waitSeconds).toBeUndefined();
    expect(interrupt.metadata?.requestedAt).toBe(OCCURRED_AT);
    // 卡片该有的东西一个都不能少 —— 缺的只是倒计时
    expect(interrupt.metadata?.toolKey).toBe(
      'agent.platform.describe_platform',
    );
    expect(interrupt.message).toBe('是否允许执行该工具调用？');
  });

  it('wait_seconds 形状不对（0 / 负数 / 字符串 / NaN）一律不收 —— 宁可不画，也不画假的', () => {
    for (const bad of [0, -1, '300', Number.NaN, null, {}]) {
      const interrupt = translate(
        { ...APPROVAL_DATA, wait_seconds: bad },
        OCCURRED_AT,
      );
      expect(interrupt.metadata?.waitSeconds).toBeUndefined();
    }
  });

  it('occurred_at 读不出（缺 / 空串 / 不是时刻）→ 没有锚点，倒计时整个不画', () => {
    for (const bad of [undefined, '', '刚才', 12345, null]) {
      const interrupt = translate(APPROVAL_DATA, bad);
      expect(interrupt.metadata?.requestedAt).toBeUndefined();
    }
  });

  it('两样都缺（老后端）→ 一个 requestedAt / waitSeconds 都不写', () => {
    const { wait_seconds: _ignored, ...withoutWait } = APPROVAL_DATA;
    const interrupt = translate(withoutWait, undefined);

    expect(interrupt.metadata?.waitSeconds).toBeUndefined();
    expect(interrupt.metadata?.requestedAt).toBeUndefined();
  });

  it('缺 interrupt_id 仍然是 null（这条老契约不受本轮改动影响）', () => {
    expect(hitlInterrupt({ ...APPROVAL_DATA, interrupt_id: '' })).toBeNull();
  });
});

describe('RunEventTranslator：一组中断各自的锚点', () => {
  interface InterruptOutcome {
    type: string;
    interrupts: { id: string; metadata?: Record<string, unknown> }[];
  }

  it('⭐ 并行两条各有各的 occurred_at —— 不能拿第一帧的时刻套给后面几条', () => {
    const translator = new RunEventTranslator({
      threadId: 't-1',
      runId: 'r-1',
      streamId: 's-1',
    });

    const frames = [
      frame(
        { ...APPROVAL_DATA, interrupt_id: 'int-1' },
        { id: '101-0', occurredAt: '2026-10-06T10:00:00Z' },
      ),
      // 后到的这条晚了 90 秒：它的倒计时该比第一条少 90 秒，
      // 也就是说它的截止时刻也晚 90 秒 —— 共用第一帧就会凭空多给 90 秒。
      frame(
        { ...APPROVAL_DATA, interrupt_id: 'int-2' },
        { id: '102-0', occurredAt: '2026-10-06T10:01:30Z' },
      ),
    ];

    const events = translator.pushChunk(frames);
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED);
    expect(finished).toBeTruthy();

    const outcome = (finished as { outcome?: InterruptOutcome }).outcome;
    expect(outcome?.type).toBe('interrupt');

    const byId = new Map(
      (outcome?.interrupts ?? []).map((item) => [item.id, item]),
    );
    expect(byId.get('int-1')?.metadata?.requestedAt).toBe(
      '2026-10-06T10:00:00Z',
    );
    expect(byId.get('int-2')?.metadata?.requestedAt).toBe(
      '2026-10-06T10:01:30Z',
    );
  });

  it('信封里没有 occurred_at 时，整组照样出得来（只是没有倒计时）', () => {
    const translator = new RunEventTranslator({
      threadId: 't-1',
      runId: 'r-1',
      streamId: 's-1',
    });

    const events = translator.pushChunk([
      frame({ ...APPROVAL_DATA }, { id: '101-0' }),
    ]);
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED);
    const outcome = (finished as { outcome?: InterruptOutcome }).outcome;

    expect(outcome?.interrupts).toHaveLength(1);
    expect(outcome?.interrupts[0].metadata?.requestedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 模型段：`message.started` 的 `visible` 与"看不见的那件活儿"
//
// 这一批用例的形状来自后端真实 SSE（`even_log`，2026-10-13）—— 那里面扎扎实实
// 有三段：summarization(visible=false) 一段、reasoning(visible=true) 两段，
// 而**不可见那一段一条 delta 都没有**、completed 的 content 是空串。
// 下面每个 data 的形状都是从那份日志里抄的，不是照想象出来的契约编的。
// ---------------------------------------------------------------------------

/** 任意 event 的一帧（上面那个 `frame` 是 hitl 专用的，别混用）。 */
const msgFrame = (
  event: string,
  data: Record<string, unknown>,
): RunEventFrame => ({
  id: '101-0',
  event,
  payload: { event, topic_id: 'r-1', node: 'agent', occurred_at: OCCURRED_AT },
  data,
});

const newTranslator = () =>
  new RunEventTranslator({ threadId: 't-1', runId: 'r-1', streamId: 's-1' });

const RUN_EVENT_MESSAGE = {
  STARTED: 'message.started',
  DELTA: 'message.delta',
  COMPLETED: 'message.completed',
} as const;

/** 只取自定义事件 —— 断言"通知了几下、说的什么"。 */
const progressOf = (events: ReturnType<RunEventTranslator['push']>) =>
  events
    .filter(
      (e) => (e as unknown as { name?: string }).name === PROGRESS_CUSTOM_EVENT,
    )
    .map((e) => (e as unknown as { value: unknown }).value);

const textOf = (events: ReturnType<RunEventTranslator['push']>) =>
  events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as unknown as { delta: string }).delta)
    .join('');

/** 只取推理那条通道 —— 断言"挂在哪条消息上、说了什么"。 */
const reasoningOf = (events: ReturnType<RunEventTranslator['push']>) =>
  events
    .filter(
      (e) =>
        (e as unknown as { name?: string }).name === REASONING_CUSTOM_EVENT,
    )
    .map((e) => (e as unknown as { value: unknown }).value);

describe('模型段：看不见正文的那一段', () => {
  it('`visible: false` 的 started 通知一下 UI，之后它的 delta 一字不发', () => {
    const translator = newTranslator();

    const opened = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, {
        role: 'summarization',
        visible: false,
      }),
    );
    expect(progressOf(opened)).toEqual([
      { phase: 'start', node: null, role: 'summarization', visible: false },
    ]);

    // 后端本来就一个字都不发；这里是第二道，防止将来那一侧改口径。
    expect(
      textOf(
        translator.push(
          msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: ' leaked ' }),
        ),
      ),
    ).toBe('');
    expect(
      translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '摘要正文' })),
    ).toEqual([]);
  });

  it('不可见那段收尾时通知"结束了"（UI 靠它停住转圈）', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, {
        role: 'summarization',
        visible: false,
      }),
    );

    const closed = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, {
        content: '',
        tool_calls: [],
        finish_reason: 'stop',
        role: 'summarization',
        visible: false,
      }),
    );

    expect(progressOf(closed)).toEqual([
      { phase: 'end', node: null, role: 'summarization', visible: false },
    ]);
  });

  it('⚠️ completed 里就算塞了 content，不可见那段的正文也不补进气泡', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, {
        role: 'summarization',
        visible: false,
      }),
    );

    // ⚠️ 只看 **push 那一帧自己**的产出：再调 finish() 会补"流断了"那句，
    //    把"有没有漏正文"这个信号整个盖掉（这条用例的第一版判据就这么歪过）。
    const closed = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, {
        content: '这段不该出现',
        role: 'summarization',
        visible: false,
      }),
    );

    expect(textOf(closed)).toBe('');
    expect(progressOf(closed)).toEqual([
      { phase: 'end', node: null, role: 'summarization', visible: false },
    ]);
  });

  it('`visible: true` 的段：不发通知，正文照常走', () => {
    const translator = newTranslator();

    expect(
      progressOf(
        translator.push(
          msgFrame(RUN_EVENT_MESSAGE.STARTED, {
            role: 'reasoning',
            visible: true,
          }),
        ),
      ),
    ).toEqual([]);

    expect(
      textOf(
        translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '你好' })),
      ),
    ).toBe('你好');
  });

  it('⚠️ 没见过 started 时**照旧放行**（这里刻意不做"缺证即不可见"）', () => {
    // 反方向的取舍写在 openSegment 的注释里：前端这一帧可能压根没收到
    // （丢帧 / 断点续传从中间开始），按不可见处理会让整轮一个字都不显示。
    const translator = newTranslator();
    expect(
      textOf(
        translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '照常' })),
      ),
    ).toBe('照常');
  });

  it('⚠️ visible 字段缺失 / 不是布尔时按**可见**处理（不猜 truthy）', () => {
    const translator = newTranslator();
    translator.push(msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning' }));
    expect(
      textOf(
        translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: 'A' })),
      ),
    ).toBe('A');

    // "false" 是个非空字符串 —— 按 truthy 判就会把这段拦掉
    const other = newTranslator();
    other.push(msgFrame(RUN_EVENT_MESSAGE.STARTED, { visible: 'false' }));
    expect(
      textOf(other.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: 'B' }))),
    ).toBe('B');
  });

  it('⚠️ 收尾时段还开着（流被掐断）→ 兜底通知一次 end', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, {
        role: 'summarization',
        visible: false,
      }),
    );

    expect(progressOf(translator.finish())).toEqual([
      { phase: 'end', node: null, role: 'summarization', visible: false },
    ]);
  });

  it('一段接着一段时，各段按各自的判据来（压缩完紧接着正常回答）', () => {
    const translator = newTranslator();

    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, {
        role: 'summarization',
        visible: false,
      }),
    );
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, {
        content: '',
        role: 'summarization',
        visible: false,
      }),
    );
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );

    expect(
      textOf(
        translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '答案' })),
      ),
    ).toBe('答案');
  });
});

describe('progressLabel：只挑文案，不参与"给不给看"', () => {
  it('节点优先 —— 它说明"这一大步在干什么"', () => {
    expect(progressLabel({ node: 'builder', role: null })).toBe(
      '正在理解你的问题',
    );
    expect(progressLabel({ node: 'tools', role: null })).toBe('正在调用工具');
    expect(progressLabel({ node: 'agent', role: 'reasoning' })).toBe(
      '正在组织回答',
    );
  });

  it('模型段按角色挑', () => {
    expect(progressLabel({ node: null, role: 'summarization' })).toBe(
      '正在整理上下文',
    );
    expect(progressLabel({ node: null, role: 'classification' })).toBe(
      '正在判断意图',
    );
    expect(progressLabel({ node: null, role: 'vision' })).toBe('正在看图');
  });

  it('⚠️ 认不出来的节点 / 角色**不炸**（词汇表会长大），落到通用那句', () => {
    expect(progressLabel({ node: '将来才有的节点', role: null })).toBe(
      '正在处理',
    );
    expect(progressLabel({ node: null, role: '明天才有的新角色' })).toBe(
      '正在处理',
    );
    expect(progressLabel({ node: null, role: null })).toBe('正在处理');
  });

  it('memory.* 那几个后台任务归到"正在更新记忆"', () => {
    expect(
      progressLabel({ node: null, role: 'memory.scene.consolidate' }),
    ).toBe('正在更新记忆');
  });
});

describe('node.started / node.completed：覆盖"一个字都没有"的那段', () => {
  // 真日志里 builder 节点占了 31 秒、期间一条 message 都没有 ——
  // 只接 message 段的话，这段是彻底静默的。
  it('开节点通知一次、关节点通知一次', () => {
    const translator = newTranslator();

    expect(
      progressOf(
        translator.push(msgFrame('node.started', { node_id: 'builder' })),
      ),
    ).toEqual([
      { phase: 'start', node: 'builder', role: null, visible: false },
    ]);

    expect(
      progressOf(
        translator.push(
          msgFrame('node.completed', {
            node_id: 'builder',
            message_count: 10,
            latency_ms: 31392,
          }),
        ),
      ),
    ).toEqual([{ phase: 'end', node: 'builder', role: null, visible: false }]);
  });

  it('agent 节点带上 model_role', () => {
    const translator = newTranslator();
    expect(
      progressOf(
        translator.push(
          msgFrame('node.started', {
            node_id: 'agent',
            agent_type: 'react',
            model_role: 'reasoning',
          }),
        ),
      ),
    ).toEqual([
      { phase: 'start', node: 'agent', role: 'reasoning', visible: false },
    ]);
  });
});

/**
 * 思维链（`message.reasoning.*`）。
 *
 * ⚠️ 最关键的一条是最后那条：**不可见的段连推理都不许发**。
 *   后端原话：摘要（summarization）在同一个 agent 节点里调模型，没有角色门
 *   的话它的**思维链**会直接漏进聊天窗 —— 那比正文泄漏更糟，因为推理里
 *   往往有内部判据与原始输入。所以两条通道共用同一道闸。
 */
describe('思维链：走自己的通道，但共用同一道可见性闸', () => {
  const REASONING_DELTA = 'message.reasoning.delta';
  const REASONING_COMPLETED = 'message.reasoning.completed';

  it('⭐ 推理 delta 先把消息开出来（推理先于正文到，没开就没有 messageId 可挂）', () => {
    const translator = newTranslator();
    const events = translator.push(
      msgFrame(REASONING_DELTA, { delta: '先想一下' }),
    );

    expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(reasoningOf(events)).toEqual([
      { messageId: 'r-1:s-1:reply', delta: '先想一下' },
    ]);
  });

  it('⭐ 推理与正文共用同一个 messageId（同一条消息的两个容器）', () => {
    const translator = newTranslator();
    translator.push(msgFrame(REASONING_DELTA, { delta: '想' }));
    const events = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '答' }),
    );

    const id = (
      events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT) as
        | { messageId?: string }
        | undefined
    )?.messageId;
    expect(id).toBe('r-1:s-1:reply');
  });

  it('reasoning.completed 带全文（对账点），并且顺手收尾', () => {
    const translator = newTranslator();
    translator.push(msgFrame(REASONING_DELTA, { delta: '想' }));
    const events = translator.push(
      msgFrame(REASONING_COMPLETED, {
        content: '想完了',
        role: 'reasoning',
        visible: true,
      }),
    );

    expect(reasoningOf(events)).toEqual([
      { messageId: 'r-1:s-1:reply', content: '想完了', done: true },
    ]);
  });

  it('⭐ message.completed 补一条 done —— 后端对"没有思维链"是不发 completed 的', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );
    const events = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, {
        content: '答',
        role: 'reasoning',
        visible: true,
      }),
    );

    // 没有这一条，最后一个推理 token 之后那行"思考中…"会一直转下去。
    expect(reasoningOf(events)).toEqual([
      { messageId: 'r-1:s-1:reply', done: true },
    ]);
  });

  it('⭐ done 挂的是**这条**消息的 id（closeMessage 会把 seq 加一，取晚了就是下一条的）', () => {
    const translator = newTranslator();
    translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '第一段' }));
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, { content: '第一段' }),
    );

    const events = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '第二段' }),
    );
    expect(
      (
        events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT) as
          | { messageId?: string }
          | undefined
      )?.messageId,
    ).toBe('r-1:s-1:reply:1');
  });

  it('⭐⭐ 不可见的段：推理一个字都不发（推理泄漏比正文泄漏更糟）', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, {
        role: 'summarization',
        visible: false,
      }),
    );

    expect(
      reasoningOf(
        translator.push(msgFrame(REASONING_DELTA, { delta: '摘要的草稿纸' })),
      ),
    ).toEqual([]);
    expect(
      reasoningOf(
        translator.push(
          msgFrame(REASONING_COMPLETED, {
            content: '摘要的草稿纸',
            role: 'summarization',
            visible: false,
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('没开段（没收到 started）时照旧放行 —— 与正文同一条口径', () => {
    const translator = newTranslator();
    expect(
      reasoningOf(translator.push(msgFrame(REASONING_DELTA, { delta: '想' }))),
    ).toEqual([{ messageId: 'r-1:s-1:reply', delta: '想' }]);
  });

  it('空 delta 不产出事件（后端自己也不发空壳）', () => {
    const translator = newTranslator();
    expect(translator.push(msgFrame(REASONING_DELTA, { delta: '' }))).toEqual(
      [],
    );
  });

  it('⚠️ 推理不进正文：正文对账时不把推理算进去', () => {
    const translator = newTranslator();
    translator.push(msgFrame(REASONING_DELTA, { delta: '草稿纸' }));
    translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '正文' }));

    // 推理先到只开消息、不写 content；正文才是 content。
    const events = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, { content: '正文' }),
    );
    expect(textOf(events)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 工具事件（2026-10-18 后端补发）
//
// `tool.called` / `tool.completed` 的 data 形状抄自
// app/agent/graph/react/tools.py 的 _publish_tool_event：
//     { tool_call_id, tool_name, input } / { tool_call_id, tool_name, output | error }
// 它们**不翻成消息**（翻了也会被 apply 的克隆覆盖，见 runEventStream.ts 文件头），
// 只翻成 CUSTOM 过程信号。
// ---------------------------------------------------------------------------

const toolOf = (events: ReturnType<RunEventTranslator['push']>) =>
  events
    .filter(
      (e) =>
        (e as unknown as { name?: string }).name === TOOL_ACTIVITY_CUSTOM_EVENT,
    )
    .map((e) => (e as unknown as { value: unknown }).value);

describe('工具事件：只发过程信号，不进 messages', () => {
  it('tool.called → CUSTOM，带 callId 与工具名', () => {
    const translator = newTranslator();

    expect(
      toolOf(
        translator.push(
          msgFrame('tool.called', {
            tool_call_id: 'call-1',
            tool_name: 'agent.platform.describe_platform',
            input: { limit: 20 },
          }),
        ),
      ),
    ).toEqual([
      {
        phase: 'start',
        callId: 'call-1',
        name: 'agent.platform.describe_platform',
        // 这一帧之前没有开过消息 → 翻译器先替这一步开一条（见 toolActivity），
        // 工具行挂在这条空正文的消息下面 —— 不再是孤儿、不再堆到末尾。
        messageId: 'r-1:s-1:reply',
        runId: '',
      },
    ]);
  });

  it('⭐ 工具事件带着**这一步**的消息 id（实时据此把工具行放回对应 section）', () => {
    const translator = newTranslator();

    // 一步 = 一条助手消息：开出来、说一句话、收尾（真实顺序：模型先说完，
    // 工具才开始跑 —— 所以 tool.called 到达时这条消息已经关闭了）。
    translator.push(msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'agent' }));
    translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '我查一下。' }));
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, { content: '我查一下。' }),
    );

    const [payload] = toolOf(
      translator.push(
        msgFrame('tool.called', { tool_call_id: 'call-1', tool_name: 'x' }),
      ),
    ) as { messageId: string }[];

    // 第 0 条消息的 id（首条不带序号），**不是**下一条还没出现的
    expect(payload.messageId).toBe('r-1:s-1:reply');
  });

  it('tool.completed（成功）→ CUSTOM end，output 不进 payload', () => {
    const translator = newTranslator();

    expect(
      toolOf(
        translator.push(
          msgFrame('tool.completed', {
            tool_call_id: 'call-1',
            tool_name: 'agent.platform.describe_platform',
            output: '{"ok":true}',
          }),
        ),
      ),
    ).toEqual([
      {
        phase: 'end',
        callId: 'call-1',
        name: 'agent.platform.describe_platform',
        messageId: 'r-1:s-1:reply',
        runId: '',
      },
    ]);
  });

  it('⭐ tool.completed 带 error → payload 带 error（成败只靠这一个字段区分）', () => {
    const translator = newTranslator();

    expect(
      toolOf(
        translator.push(
          msgFrame('tool.completed', {
            tool_call_id: 'call-1',
            tool_name: 'web.search',
            error: 'TimeoutError: 30s',
          }),
        ),
      ),
    ).toEqual([
      {
        phase: 'end',
        callId: 'call-1',
        name: 'web.search',
        messageId: 'r-1:s-1:reply',
        runId: '',
        error: 'TimeoutError: 30s',
      },
    ]);
  });

  it('⚠️ 契约里没有 tool.error，但真来了要认（否则那一行永远转圈）', () => {
    const translator = newTranslator();

    expect(
      toolOf(
        translator.push(
          msgFrame('tool.error', {
            tool_call_id: 'call-1',
            tool_name: 'web.search',
            error: 'TimeoutError: 30s',
          }),
        ),
      ),
    ).toEqual([
      {
        phase: 'end',
        callId: 'call-1',
        name: 'web.search',
        messageId: 'r-1:s-1:reply',
        runId: '',
        error: 'TimeoutError: 30s',
      },
    ]);
  });

  it('⚠️ 正文一个字都不写（工具不是模型说的话；但 START 要发 —— 工具卡得有个落脚点）', () => {
    const translator = newTranslator();
    const events = [
      ...translator.push(
        msgFrame('tool.called', { tool_call_id: 'c', tool_name: 'x' }),
      ),
      ...translator.push(
        msgFrame('tool.completed', { tool_call_id: 'c', tool_name: 'x' }),
      ),
    ];

    // 工具的产出 / 名字不许变成"模型说的话" —— content 一条都不发
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toEqual([]);
    // 但要替这一步开出消息本体（空的），工具卡片才有 messageId 可挂
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_START')).toHaveLength(
      1,
    );
  });

  it('⚠️ tool_call_id 是数字时转成字符串（后端那个字段是 Any）', () => {
    const translator = newTranslator();

    expect(
      toolOf(
        translator.push(
          msgFrame('tool.called', { tool_call_id: 42, tool_name: 'x' }),
        ),
      ),
    ).toEqual([
      {
        phase: 'start',
        callId: '42',
        name: 'x',
        messageId: 'r-1:s-1:reply',
        runId: '',
      },
    ]);
  });

  it('⚠️ 没有 tool_call_id 就给空串 —— 不许自己造一个配不上的 id', () => {
    const translator = newTranslator();

    expect(
      toolOf(translator.push(msgFrame('tool.called', { tool_name: 'x' }))),
    ).toEqual([
      {
        phase: 'start',
        callId: '',
        name: 'x',
        messageId: 'r-1:s-1:reply',
        runId: '',
      },
    ]);
  });

  it('工具事件不碰「空回答兜底」：只调工具、不说话的运行不该被补一句', () => {
    const translator = newTranslator();
    translator.push(msgFrame('tool.called', { tool_call_id: 'c' }));
    translator.push(msgFrame('tool.completed', { tool_call_id: 'c' }));

    // 兜底只在 finish 时补；这里只确认工具事件本身没伪造正文
    expect(
      translator
        .push(msgFrame(RUN_EVENT_MESSAGE.COMPLETED, { content: '' }))
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toEqual([]);
  });
});

// ⚠️ 提问（`agent.ask_user_question`）与审批走**同一条**中断通道
// --------------------------------------------------------
//   后端那个工具在自己的函数体里 `interrupt(payload)`，而
//   `_publish_hitl_requested` 把整个字典原样透传 + 补 `interrupt_id`。所以
//   "这是提问"这件事只能从载荷自述的 `type` 看出来 —— 这里钉的就是"搬运"
//   这一步：type / questions 有没有一起搬进 metadata、会不会串到别的帧上。

/** 一组中断里的 `interrupts`（结果一定是非空数组，否则用例本就该红）。 */
const groupOf = (events: ReturnType<RunEventTranslator['pushChunk']>) => {
  const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as
    | {
        outcome?: {
          type?: string;
          interrupts?: { id: string; metadata?: Record<string, unknown> }[];
        };
      }
    | undefined;
  const interrupts = finished?.outcome?.interrupts ?? [];
  if (interrupts.length === 0) throw new Error('这一批本该翻出中断');
  return interrupts;
};

describe('ask_user_question：题目的来源', () => {
  const QUESTION = {
    question: '用哪个数据源？',
    header: '数据源',
    options: [
      { label: '实时行情', description: 'T+0 的报价', preview: null },
      { label: '历史库', description: '含复权因子' },
    ],
    multiSelect: false,
  };

  const ASK_DATA: Record<string, unknown> = {
    type: 'ask_user_question',
    questions: [QUESTION],
    metadata: { source: 'planner' },
    tool_call_id: 'call-1',
    interrupt_id: 'int-ask',
  };

  it('type / questions / tool_call_id 一起搬进 metadata', () => {
    const interrupt = translate(ASK_DATA, OCCURRED_AT);

    expect(interrupt.metadata?.hitlType).toBe('ask_user_question');
    expect(interrupt.metadata?.questions).toEqual([QUESTION]);
    expect(interrupt.metadata?.toolCallId).toBe('call-1');
  });

  it('载荷自己的 metadata 换个键名（hitlMetadata）—— 不能顶掉 AG-UI 那个口袋', () => {
    const interrupt = translate(ASK_DATA, OCCURRED_AT);

    expect(interrupt.metadata?.hitlMetadata).toEqual({ source: 'planner' });
    // 审批那套字段一个都不该冒充进来：提问帧里没有 options
    expect(interrupt.metadata?.options).toBeUndefined();
    expect(interrupt.metadata?.toolKey).toBeUndefined();
  });

  it('审批帧不带这两个键 —— 卡片的判据不该被顺手写上', () => {
    const interrupt = translate(APPROVAL_DATA, OCCURRED_AT);

    expect(interrupt.metadata?.hitlType).toBeUndefined();
    expect(interrupt.metadata?.questions).toBeUndefined();
  });

  it('⭐ 载荷缺 questions → 退到 tool.called 记下的同一份入参，并补上 type', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame('tool.called', {
        tool_call_id: 'call-1',
        // 模型给的原名（langgraph tools 通道报的就是函数名，不带 agent. 前缀）
        tool_name: 'ask_user_question',
        input: { questions: [QUESTION] },
      }),
    );

    const {
      questions: _dropped,
      type: _alsoDropped,
      ...withoutQuestions
    } = ASK_DATA;
    const [interrupt] = groupOf(
      translator.pushChunk([frame(withoutQuestions)]),
    );

    expect(interrupt.metadata?.questions).toEqual([QUESTION]);
    // 兜底那份一定是提问（账本只认这个工具），所以 type 也补上了 ——
    // 不补的话卡片会把它判成 unknown（读不出值域）
    expect(interrupt.metadata?.hitlType).toBe('ask_user_question');
  });

  it('载荷给了空数组不算"读到" —— 空题组交给界面就是一张点不动的卡', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame('tool.called', {
        tool_call_id: 'call-1',
        tool_name: 'agent.ask_user_question',
        input: { questions: [QUESTION] },
      }),
    );

    const [interrupt] = groupOf(
      translator.pushChunk([
        frame({ ...ASK_DATA, questions: [] }, { occurredAt: OCCURRED_AT }),
      ]),
    );

    expect(interrupt.metadata?.questions).toEqual([QUESTION]);
  });

  it('tool.completed 之后账本清掉 —— 下一次中断不会串到上一轮的题上', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame('tool.called', {
        tool_call_id: 'call-1',
        tool_name: 'agent.ask_user_question',
        input: { questions: [QUESTION] },
      }),
    );
    translator.push(
      msgFrame('tool.completed', { tool_call_id: 'call-1', output: {} }),
    );

    const {
      questions: _dropped,
      type: _alsoDropped,
      ...withoutQuestions
    } = ASK_DATA;
    const [interrupt] = groupOf(
      translator.pushChunk([frame(withoutQuestions)]),
    );

    expect(interrupt.metadata?.questions).toBeUndefined();
    expect(interrupt.metadata?.hitlType).toBeUndefined();
  });

  it('别的工具不收账 —— 参数里正好有个 questions 也不能认', () => {
    const translator = newTranslator();
    translator.push(
      msgFrame('tool.called', {
        tool_call_id: 'call-9',
        tool_name: 'agent.document.search',
        input: { questions: [QUESTION] },
      }),
    );

    const {
      questions: _dropped,
      type: _alsoDropped,
      ...withoutQuestions
    } = ASK_DATA;
    const [interrupt] = groupOf(
      translator.pushChunk([
        frame({ ...withoutQuestions, tool_call_id: 'call-9' }),
      ]),
    );

    expect(interrupt.metadata?.questions).toBeUndefined();
  });
});

// ============================================================
// 任务计划：三条事件只转发，不进消息流
// ============================================================
//
// 它们说的是"这一轮在编排哪几件事"，不是"模型说了什么" —— 所以必须原样
// 走 CUSTOM（见 PLAN_CUSTOM_EVENT 那段）。这里钉两件最容易搞错的事：
//   ① `runId` 取**信封**的 `topic_id`（后端 run_id），不是 data 里的 plan_id；
//   ② 一条计划事件**不能**顺手开出一条助手消息（开出来就是一条空气泡，
//      刷新后还会留在历史里）。

describe('计划事件走 CUSTOM', () => {
  const planFrame = (
    event: string,
    data: Record<string, unknown>,
  ): RunEventFrame => ({
    id: '101-0',
    event,
    payload: {
      event,
      topic: 'agent_run',
      topic_id: 'run-7c9e6679',
      node: 'planner',
      occurred_at: OCCURRED_AT,
      data,
    },
    data,
  });

  const planOf = (events: BaseEvent[]) =>
    events
      .filter(
        (event) =>
          event.type === EventType.CUSTOM &&
          (event as { name?: string }).name === PLAN_CUSTOM_EVENT,
      )
      // CUSTOM 的载荷在 BaseEvent 上是 `unknown`（协议故意留空），
      // 这里按我们自己发的形状断言一次 —— 与 usePlanFeed 里那段是同一个口径。
      .map((event) => event as unknown as { value: PlanEventPayload });

  it('三条事件都转发，且 runId 是信封的 topic_id', () => {
    const translator = newTranslator();

    for (const event of ['plan.published', 'task.updated', 'plan.cleared']) {
      const [custom] = planOf(
        translator.push(planFrame(event, { plan_id: 'p-1' })),
      );
      expect(custom).toBeDefined();
      expect(custom.value).toMatchObject({ runId: 'run-7c9e6679', event });
    }
  });

  it('⭐ data 原样透传（解析交给 planTasks，这一层不裁剪）', () => {
    const translator = newTranslator();
    const data = {
      plan_id: 'p-1',
      revision: 2,
      goal: 'g',
      tasks: [{ id: 'p-1:t1' }],
    };

    const [custom] = planOf(translator.push(planFrame('plan.published', data)));
    expect(custom.value.data).toEqual(data);
  });

  it('⭐ 不额外开消息 —— 计划事件不该在对话里留下任何气泡', () => {
    const translator = newTranslator();
    const events = translator.push(
      planFrame('plan.published', { plan_id: 'p-1' }),
    );

    expect(
      events.filter((event) => event.type === EventType.TEXT_MESSAGE_START),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 子代理四条：`created` / `claimed` / `task.updated` / `completed`（2026-10-23）
//
// 它们和计划三条走**同一个** CUSTOM 出口，所以这一层本来"什么都不用改"就会
// 转发 —— 正因为如此，真正值得钉的是**它不该做什么**：
//
//   · 不许在对话里留下气泡（子代理派出/交差不是"模型说了什么"）；
//   · 不许按 `current_task_id` 无脑改 liveTask —— 这四个事件里有两个的
//     `current_task_id` 恒为 null（后端把它当"没有 current"发），并行波次
//     里照抄就会让先交差的那个把别人正在跑的任务从时间线上抹掉。
//
// 事件形状取自后端 2026-10-23 的契约：按 worker 一条 created、紧接一条
// claimed（带 claim.owner / claim.attempt），波次 join 之后每个收尾的任务
// 各一条 task.updated + completed。**四条都是"一个 worker / 一个任务"粒度**，
// 不是整波一条。
// ---------------------------------------------------------------------------
describe('子代理事件：同一条 CUSTOM，但不动别人的归属', () => {
  const RUN = 'run-7c9e6679';
  const PLAN = 'p-4f1c';
  const T1 = `${PLAN}:t1`;
  const T2 = `${PLAN}:t2`;
  const MESSAGE_ID = 'r-1:s-1:reply';

  const subFrame = (
    event: string,
    data: Record<string, unknown>,
  ): RunEventFrame => ({
    id: '101-0',
    event,
    payload: {
      event,
      topic: 'agent_run',
      topic_id: RUN,
      node: 'dispatcher',
      occurred_at: OCCURRED_AT,
      data,
    },
    data,
  });

  const planOf = (events: BaseEvent[]) =>
    events
      .filter(
        (event) =>
          event.type === EventType.CUSTOM &&
          (event as { name?: string }).name === PLAN_CUSTOM_EVENT,
      )
      .map((event) => event as unknown as { value: PlanEventPayload });

  /** 主代理的 `plan.published` —— 只有它带整组 tasks。 */
  const published = (currentTaskId: string) =>
    subFrame('plan.published', {
      plan_id: PLAN,
      revision: 1,
      goal: '并行查两家公司',
      current_task_id: currentTaskId,
      tasks: [taskOf(T1, '查 A 公司财报'), taskOf(T2, '对比 B 公司财报')],
    });

  const taskOf = (id: string, title: string) => ({
    id,
    status: { state: 'TASK_STATE_SUBMITTED' },
    metadata: { skill_key: 'financial_research' },
    history: [{ role: 'ROLE_USER', parts: [{ data: { description: title } }] }],
  });

  /** 开一条消息并返回它落在 feed 里的 id（`reply` / `reply:1` …）。 */
  let opened = 0;
  const openMessage = (translator: RunEventTranslator, text: string) => {
    // 上一条不收掉的话，这一条会被并进去（`ensureMessageOpen`），不会新开 id。
    if (opened > 0) {
      translator.push(
        msgFrame(RUN_EVENT_MESSAGE.COMPLETED, { content: '（上一段）' }),
      );
    }
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );
    translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: text }));
    const id = opened === 0 ? MESSAGE_ID : `${MESSAGE_ID}:${opened}`;
    opened += 1;
    return id;
  };

  beforeEach(() => {
    resetLiveTasks();
    opened = 0;
  });

  it('四条都转发，runId 取信封的 topic_id', () => {
    const translator = newTranslator();

    for (const event of [
      'subagent.created',
      'subagent.claimed',
      'subagent.task.updated',
      'subagent.completed',
    ]) {
      const [custom] = planOf(
        translator.push(subFrame(event, { plan_id: PLAN, worker_id: 'w-0' })),
      );
      expect(custom).toBeDefined();
      expect(custom.value).toMatchObject({ runId: RUN, event });
    }
  });

  it('⭐ `created` 没有 task 也原样透传（"还没认领"这件事由上层判断）', () => {
    const translator = newTranslator();
    const data = {
      plan_id: PLAN,
      revision: 1,
      worker_id: `${RUN}:worker:0`,
      worker_index: 0,
      task_id: T1,
      task_count: 2,
      pending_count: 1,
      context_id: 'ctx-8a2',
    };

    const [custom] = planOf(
      translator.push(subFrame('subagent.created', data)),
    );
    // 一个字段都不许丢：名册那几个计数全靠它。
    expect(custom.value.data).toEqual(data);
  });

  it('不额外开消息、也不往推理通道里塞东西', () => {
    const translator = newTranslator();
    const events = translator.push(
      subFrame('subagent.created', { plan_id: PLAN, worker_id: 'w-0' }),
    );

    expect(
      events.filter(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_START ||
          event.type === EventType.TEXT_MESSAGE_CONTENT,
      ),
    ).toHaveLength(0);
  });

  it('⚠️ `created` 不清空正在跑的任务（worker1 派出 ≠ worker0 交差）', () => {
    const translator = newTranslator();

    translator.push(published(T1));
    const first = openMessage(translator, 'A 这边在查了');

    // worker1 被派出：这一帧里**根本没有 task**，current_task_id 也缺席。
    translator.push(
      subFrame('subagent.created', {
        plan_id: PLAN,
        worker_id: `${RUN}:worker:1`,
        worker_index: 1,
        task_id: T2,
        task_count: 2,
        pending_count: 1,
        context_id: 'ctx-8a3',
      }),
    );

    const second = openMessage(translator, 'B 也开始查了');

    // 两条消息都还挂在 t1 上 —— 这不是"归属正确"，是"没有更坏"：
    // 抹掉的话第二条会掉进无主轨道，界面上直接少一个节点。
    expect(liveTaskOf(first)?.taskId).toBe(T1);
    expect(liveTaskOf(second)?.taskId).toBe(T1);
  });

  it('⭐ `claimed` 比 `task.updated` 更早把任务认下来', () => {
    const translator = newTranslator();

    translator.push(
      subFrame('subagent.claimed', {
        plan_id: PLAN,
        revision: 1,
        worker_id: `${RUN}:worker:0`,
        task_id: T1,
        current_task_id: T1,
        task: {
          id: T1,
          status: { state: 'TASK_STATE_WORKING' },
          history: [
            {
              role: 'ROLE_USER',
              parts: [{ data: { description: '查 A 公司财报' } }],
            },
          ],
          metadata: { claim: { owner: `${RUN}:worker:0`, attempt: 1 } },
        },
      }),
    );

    const id = openMessage(translator, '开始查了');

    expect(liveTaskOf(id)).toEqual({
      taskId: T1,
      title: '查 A 公司财报',
      planId: PLAN,
    });
  });

  it('⚠️ 并行波次：A 交差不把 B 正在跑的任务从时间线上抹掉', () => {
    const translator = newTranslator();

    translator.push(published(T1));
    openMessage(translator, 'A 在查');

    // B 接上（主代理把 current 指过去）
    translator.push(
      subFrame('subagent.claimed', {
        plan_id: PLAN,
        worker_id: `${RUN}:worker:1`,
        task_id: T2,
        current_task_id: T2,
        task: {
          id: T2,
          status: { state: 'TASK_STATE_WORKING' },
          history: [
            {
              role: 'ROLE_USER',
              parts: [{ data: { description: '对比 B 公司财报' } }],
            },
          ],
          metadata: { claim: { owner: `${RUN}:worker:1`, attempt: 1 } },
        },
      }),
    );
    openMessage(translator, 'B 在查');

    // A 交差：后端补发的这一帧 `current_task_id` 是 null
    translator.push(
      subFrame('subagent.task.updated', {
        plan_id: PLAN,
        worker_id: `${RUN}:worker:0`,
        task_id: T1,
        previous_state: 'TASK_STATE_WORKING',
        current_task_id: null,
        task: {
          id: T1,
          status: { state: 'TASK_STATE_COMPLETED' },
          metadata: { claim: { owner: `${RUN}:worker:0`, attempt: 1 } },
        },
      }),
    );

    const afterA = openMessage(translator, 'A 查完了，B 还在跑');

    // B 交差：同一形状，这次 id 对上了，才该收
    translator.push(
      subFrame('subagent.completed', {
        plan_id: PLAN,
        worker_id: `${RUN}:worker:1`,
        task_id: T2,
        status: 'TASK_STATE_COMPLETED',
        task: {
          id: T2,
          status: { state: 'TASK_STATE_COMPLETED' },
          metadata: { claim: { owner: `${RUN}:worker:1`, attempt: 1 } },
        },
      }),
    );

    const afterB = openMessage(translator, '都查完了');

    expect(liveTaskOf(afterA)?.taskId).toBe(T2);
    expect(liveTaskOf(afterB)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 任务时间线：消息**开出来的那一刻**它在哪个任务里
//
// 实时通道的载荷里没有 kind / task_id（后端只在落库时打标，见
// run_event_projector.py 的 MESSAGE_COMPLETED）。所以分组只能靠翻译器
// 边跑边记：计划事件说"此刻在跑哪个任务"，开消息时把它记到 messageId 上。
//
// ⚠️ 为什么钉"开消息那一刻"而不是"渲染那一刻"
// ----------------------------------------
//   渲染时去问 plan feed 拿到的是**现在**在跑哪个任务。任务切换的那一帧，
//   这两者差着一整个任务 —— 症状是"某个任务的最后一段回答挂到了下一个任务
//   的节点下面"，而界面上只是看起来"归错组了"，不会报任何错。
// ---------------------------------------------------------------------------
describe('任务时间线：实时消息的任务归属', () => {
  const published = (taskId: string, state = 'TASK_STATE_WORKING') =>
    msgFrame('plan.published', {
      plan_id: 'p-1',
      revision: 1,
      goal: '查财报',
      current_task_id: taskId,
      tasks: [
        {
          id: taskId,
          status: { state },
          metadata: { skill_key: 'financial_research' },
          history: [
            {
              role: 'ROLE_USER',
              parts: [{ data: { description: '查 A 公司财报' } }],
            },
          ],
        },
      ],
    });

  const taskUpdated = (taskId: string, state: string) =>
    msgFrame('task.updated', {
      plan_id: 'p-1',
      current_task_id: taskId,
      task: { id: taskId, status: { state } },
    });

  const MESSAGE_ID = 'r-1:s-1:reply';

  beforeEach(() => {
    resetLiveTasks();
  });

  it('⭐ 任务运行期间开出来的消息带任务标记（标题来自计划事件）', () => {
    const translator = newTranslator();

    translator.push(published('t1'));
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );
    translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '在查了' }));

    expect(liveTaskOf(MESSAGE_ID)).toEqual({
      taskId: 't1',
      title: '查 A 公司财报',
      planId: 'p-1',
    });
  });

  it('★ 任务完成之后的回答**不挂**这个任务（否则主对话的总结会被吸进轨道）', () => {
    const translator = newTranslator();

    translator.push(published('t1'));
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.COMPLETED, { content: '查完了' }),
    );

    // 这一轮任务的收尾帧
    translator.push(taskUpdated('t1', 'TASK_STATE_COMPLETED'));

    // 接下来是主代理的总结（第二条消息）
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '刚才那个任务完成了' }),
    );

    expect(liveTaskOf(MESSAGE_ID)).not.toBeNull();
    expect(liveTaskOf(`${MESSAGE_ID}:1`)).toBeNull();
  });

  it('从没有过计划事件 -> 消息不带标记（普通对话不该长出轨道）', () => {
    const translator = newTranslator();

    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );

    expect(liveTaskOf(MESSAGE_ID)).toBeNull();
  });

  it('第二个任务开始 -> 新消息挂到新任务（旧任务的原样保留）', () => {
    const translator = newTranslator();

    translator.push(published('t1'));
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );
    translator.push(msgFrame(RUN_EVENT_MESSAGE.COMPLETED, { content: 'a' }));

    translator.push(taskUpdated('t1', 'TASK_STATE_COMPLETED'));
    translator.push(published('t2'));
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.STARTED, { role: 'reasoning', visible: true }),
    );
    // 消息是**第一个 delta 到达时**才真的开出来的（见 ensureMessageOpen）
    translator.push(
      msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '开始查 B 公司' }),
    );

    expect(liveTaskOf(MESSAGE_ID)?.taskId).toBe('t1');
    expect(liveTaskOf(`${MESSAGE_ID}:1`)?.taskId).toBe('t2');
  });
});

// ---------------------------------------------------------------------------
// 「纯工具步骤」把下一个任务的正文吞进同一条消息 —— 2026-10-22 第六轮
//
// 用户报了两个症状，看着是两件事，其实是**同一个根因**：
//   · 「step_1 timeline 直接没了」—— 时间线上第一个节点直接是"任务 2"；
//   · 「工具调用 agent.enter_plan_mode 还是跑到 step1 正文下方了」。
//
// `agent.enter_plan_mode` 是模型这一步**唯一**的输出（一个字都没说），
// `toolActivity` 会替它开一条消息。后端对"纯工具调用"这一步往往**不发**
// `message.completed`，于是这条消息一直开着 —— 接下来任务的正文
// (`message.delta`) 就追加进了**同一条**消息。于是：
//   · 渲染层固定"正文在上、工具卡在下"（DockRenderMessage 的 section / tail），
//     工具卡被挤到正文下面 —— 尽管它发生在正文之前；
//   · 这条消息的任务归属是**开消息那一刻**记的（那时候还没有任何任务，记的是
//     null，见 liveTaskFeed），之后再没人补 —— 于是那个任务的整段产出在时间线
//     上没有轨道也没有节点。
//
// 修法：纯工具步骤占着的那条消息，遇到下一条正文先收掉（见 toolOnlyStep）。
// 收掉之后 `ensureMessageOpen` 会重新问一次"现在在跑哪个任务"，归属自然就对，
// 不需要另写一套"补记"逻辑。
// ---------------------------------------------------------------------------
describe('任务时间线：纯工具步骤不能把下一个任务的正文吞进去', () => {
  const MESSAGE_ID = 'r-1:s-1:reply';

  const published = (taskId: string) =>
    msgFrame('plan.published', {
      plan_id: 'p-1',
      revision: 1,
      goal: '写一封会议通知邮件',
      current_task_id: taskId,
      tasks: [
        {
          id: taskId,
          status: { state: 'TASK_STATE_SUBMITTED' },
          metadata: { skill_key: 'general' },
          history: [
            {
              role: 'ROLE_USER',
              parts: [{ data: { description: '明确目的与语气' } }],
            },
          ],
        },
      ],
    });

  beforeEach(() => {
    resetLiveTasks();
  });

  it('⭐ 正文必须落在**新的一条**消息上，并带上任务归属', () => {
    const translator = newTranslator();

    // 1) 进入计划模式：这一步只有工具调用，一个字都没有
    translator.push(
      msgFrame('tool.called', { tool_name: 'agent.enter_plan_mode' }),
    );

    // 2) 计划下发，t1 开始跑
    translator.push(published('p-1:t1'));

    // 3) t1 的产出
    const events = translator.push(
      msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: 'STEP-1 结论' }),
    );

    // 顺序就是用户要的：工具卡那条**先收尾**，正文另起一条 ->
    // 渲染出来是「工具卡在上、正文在下」，工具卡不再坠到正文下方。
    expect(events.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect((events[0] as unknown as { messageId: string }).messageId).toBe(
      MESSAGE_ID,
    );
    expect((events[1] as unknown as { messageId: string }).messageId).toBe(
      `${MESSAGE_ID}:1`,
    );

    // 归属问的是"收掉之后"那一刻 -> t1（从前这里是 null，整段没轨道）
    expect(liveTaskOf(`${MESSAGE_ID}:1`)?.taskId).toBe('p-1:t1');
    // 工具那一步仍然不属于任何任务：它发生在计划建出来之前
    expect(liveTaskOf(MESSAGE_ID)).toBeNull();
  });

  it('★ 同一步里"先说话、再调工具"不拆分（工具卡就该在那段正文下方）', () => {
    const translator = newTranslator();

    translator.push(msgFrame(RUN_EVENT_MESSAGE.DELTA, { delta: '我先查一下' }));
    const events = translator.push(
      msgFrame('tool.called', {
        tool_name: 'agent.platform.describe_platform',
      }),
    );

    // 正文已经在这条消息里了 -> 不新开一条：工具卡跟着这段正文走。
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(
      false,
    );
  });

  it('同一纯工具步骤里的多个调用仍然共用一条消息（不能被拆成两张卡）', () => {
    const translator = newTranslator();

    translator.push(
      msgFrame('tool.called', { tool_name: 'agent.enter_plan_mode' }),
    );
    const second = translator.push(
      msgFrame('tool.completed', {
        tool_name: 'agent.enter_plan_mode',
        tool_call_id: 'c-1',
      }),
    );

    expect(second.some((e) => e.type === EventType.TEXT_MESSAGE_START)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 推理的收尾信号必须送到**写 delta 的那条消息**上 —— 2026-10-22 第八轮
//
// 用户实报：「消息已经结束，前端依旧显示正在思考」「刷新之后没有了」。
//
// 收尾有两条路：后端的 `message.reasoning.completed`，和 `message.completed`
// 时补发的 `done`。两条从前都拿 `currentMessageId()` 当目标 —— 那是"**现在**
// 开着哪条"，不一定是"**刚才那些 delta 写进了哪条**"。中间只要换过一次消息
// （典型：纯工具步骤，见上一条 describe），收尾就落到下一条上；下一条没有
// 推理，`applyReasoning` 直接 return，真正在流的那条永远停在"正在思考"。
// 刷新之后走历史通道（`metadata.reasoning` 天然是收尾态），所以看着正常。
// ---------------------------------------------------------------------------
describe('推理收尾：目标是"写 delta 的那条消息"，不是"现在开着的那条"', () => {
  /** 把一帧推下去，并把里面的推理 CUSTOM 事件真的喂进 store。 */
  const push = (translator: RunEventTranslator, f: RunEventFrame) => {
    const events = translator.push(f);
    for (const value of reasoningOf(events)) {
      applyReasoning(value as ReasoningPayload);
    }
    return events;
  };

  beforeEach(() => {
    resetReasoning();
  });

  it('⭐ 中间因纯工具步骤换过消息，收尾仍然落在原来那条上', () => {
    const translator = newTranslator();

    // 1) 推理开了第一条消息，正在流
    push(
      translator,
      msgFrame('message.reasoning.delta', { delta: '先想一下怎么切分' }),
    );
    expect(reasoningEntryOf('r-1:s-1:reply')?.streaming).toBe(true);

    // 2) 这一步只调了工具（纯工具步骤）
    push(
      translator,
      msgFrame('tool.called', { tool_name: 'agent.enter_plan_mode' }),
    );

    // 3) 任务 1 的正文 -> 收掉第一条、开第二条
    push(translator, msgFrame('message.delta', { delta: 'STEP-1 结论' }));

    // 4) 这一步的 completed（纯工具步骤没有正文，content 是空串）
    push(translator, msgFrame('message.completed', { content: '' }));

    // 从前这里是 true —— 界面上那行「正在思考」一直转，刷新才消失。
    expect(reasoningEntryOf('r-1:s-1:reply')?.streaming).toBe(false);
  });

  it('reasoning.completed 晚于换消息到达时，也落在原来那条上', () => {
    const translator = newTranslator();

    push(translator, msgFrame('message.reasoning.delta', { delta: '想' }));
    push(
      translator,
      msgFrame('tool.called', { tool_name: 'agent.enter_plan_mode' }),
    );
    push(translator, msgFrame('message.delta', { delta: '正文' }));

    // 这一帧本该属于第一条，但它到得比换消息更晚
    push(
      translator,
      msgFrame('message.reasoning.completed', { content: '想完了' }),
    );

    expect(reasoningEntryOf('r-1:s-1:reply')).toEqual({
      text: '想完了',
      streaming: false,
    });
  });

  it('没有推理的那些消息不会因此多出空块', () => {
    const translator = newTranslator();

    push(translator, msgFrame('message.delta', { delta: '直接说正文' }));
    push(translator, msgFrame('message.completed', { content: '直接说正文' }));

    expect(reasoningEntryOf('r-1:s-1:reply')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 下一步的**思考**也不能留在上一步的纯工具卡消息里 —— 2026-10-22 第九轮
//
// 用户实报：「确实是 step_1 的思考过程，跑到最开始的工具调用 agent.enter_plan_mode
// 上方去了」。
//
// 上一条 describe 只堵了正文那一半（`openMessage` 会先收掉纯工具步骤）。
// 但下一个任务**先到的是推理**，它顺着 `ensureMessageOpen` 落进了工具步骤那条
// 消息 —— 而渲染层在一条消息里固定「思考在上、工具卡在下」（DockRenderMessage
// 的 section / tail），于是任务 1 的思考被摆到了计划之前那颗工具卡的上方。
// 现在推理路径也会先收掉（见 splitToolOnlyStep）。
// ---------------------------------------------------------------------------
describe('纯工具步骤之后，下一个任务的"思考"也要另起一条消息', () => {
  const published = () =>
    msgFrame('plan.published', {
      plan_id: 'p-1',
      revision: 1,
      goal: '写邮件',
      current_task_id: 'p-1:t1',
      tasks: [
        {
          id: 'p-1:t1',
          status: { state: 'TASK_STATE_WORKING' },
          metadata: { skill_key: 'general' },
          history: [
            { role: 'ROLE_USER', parts: [{ data: { description: '定目的' } }] },
          ],
        },
      ],
    });

  beforeEach(() => {
    resetReasoning();
  });

  it('⭐ 任务 1 的推理落在**新的**那条消息上，并带上任务归属', () => {
    const translator = newTranslator();

    // 1) 纯工具步骤：只有 enter_plan_mode
    translator.push(
      msgFrame('tool.called', { tool_name: 'agent.enter_plan_mode' }),
    );
    // 2) 计划下发，t1 开始
    translator.push(published());

    // 3) t1 的思考到了（正文还没来）
    const events = translator.push(
      msgFrame('message.reasoning.delta', { delta: '先定邮件目的' }),
    );

    // 先收掉纯工具那条，再把思考写进新的一条
    expect(events.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.CUSTOM,
    ]);
    expect((events[0] as unknown as { messageId: string }).messageId).toBe(
      'r-1:s-1:reply',
    );
    expect((events[1] as unknown as { messageId: string }).messageId).toBe(
      'r-1:s-1:reply:1',
    );

    // 工具卡那条消息仍然是"计划之前"（无归属），
    // 思考那条归到 t1 —— 界面上节点跟着思考走，不再挂在工具卡上方。
    expect(liveTaskOf('r-1:s-1:reply')).toBeNull();
    expect(liveTaskOf('r-1:s-1:reply:1')?.taskId).toBe('p-1:t1');
  });

  it('紧接着的正文**不会**再劈一条：思考和正文同属任务 1 的那条消息', () => {
    const translator = newTranslator();

    translator.push(
      msgFrame('tool.called', { tool_name: 'agent.enter_plan_mode' }),
    );
    translator.push(published());
    translator.push(msgFrame('message.reasoning.delta', { delta: '先定目的' }));
    const text = translator.push(
      msgFrame('message.delta', { delta: 'STEP-1 成果' }),
    );

    // 正文这次不该再出现 END/START（上一条已经不是纯工具步骤了）
    expect(text.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(false);
    expect(text[0].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
  });

  it('同一步"先思考、再调工具"不拆 —— 思考和工具卡留在同一条里', () => {
    const translator = newTranslator();

    translator.push(msgFrame('message.reasoning.delta', { delta: '想想再调' }));
    const events = translator.push(
      msgFrame('tool.called', {
        tool_name: 'agent.platform.describe_platform',
      }),
    );

    // 工具调用到达时不该冒出 END：它属于刚才那段思考的同一步。
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(
      false,
    );
  });
});
