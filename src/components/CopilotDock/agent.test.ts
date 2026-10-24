// src/components/CopilotDock/agent.test.ts
//
// 这一层是「CopilotKit 的界面」与「YTraderHarness 的 REST + 事件流」之间的翻译器，
// 所以断言三件事：
//   ① 一轮 run 输出的**事件序列**（协议对了界面才会渲染）；
//   ② 我们到底把什么提交给了后端（最后一条用户消息、懒建会话）；
//   ③ 流式过程中的各种**异常收尾**（掉帧、失败、流提前断）也要走完协议。
// 事件序列尤其重要：像 RUN_STARTED 少了 threadId/runId 这种错，
// 界面会静默不出消息，比报错难查得多。
import { EventType } from '@ag-ui/client';
import { Observable, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectHitlGroup,
  DockAgent,
  isReplayedReply,
  lastUserText,
  REPLAY_GRACE_MS,
  resumeDecision,
} from './agent';
import {
  type AgentRun,
  cancelRun,
  createRun,
  type RunEventFrame,
  resumeRun,
  runEvents,
} from './agentRuntime';

vi.mock('./agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentRuntime')>()),
  cancelRun: vi.fn(),
  createRun: vi.fn(),
  resumeRun: vi.fn(),
  runEvents: vi.fn(),
}));

const mockedCancelRun = vi.mocked(cancelRun);
const mockedCreateRun = vi.mocked(createRun);
const mockedResumeRun = vi.mocked(resumeRun);
const mockedRunEvents = vi.mocked(runEvents);

const RUN: AgentRun = {
  run_id: 'run-1',
  session_id: 'sess-1',
  status: 'queued',
};

type AnyMessage = { id: string; role: string; content?: unknown };

const userMessage = (content: unknown): AnyMessage => ({
  id: 'm-user',
  role: 'user',
  content,
});

/** 造一个最小的 RunAgentInput —— 我们只用到 messages / threadId / runId。 */
const makeInput = (messages: AnyMessage[]) =>
  ({
    threadId: 'thread-1',
    runId: 'client-run-1',
    messages,
    tools: [],
    state: {},
    context: [],
    forwardedProps: {},
  }) as never;

/**
 * 「回答一次审批」那一轮的输入。
 *
 * ⚠️ `runId` 默认与 makeInput 相同 —— 那不是巧合，是 CopilotKit 的真实行为：
 *   useInterrupt 的 resolve 会把**上一次的** runId 原样传回来
 *   （它靠 interruptRunIdsRef 记住），于是恢复那一轮和中断那一轮同 runId。
 *   我们正是靠这个 runId 找后端的 run_id。
 */
const makeResumeInput = (
  resume: { interruptId: string; status: string; payload?: unknown }[],
) =>
  ({
    ...(makeInput([userMessage('忽略：恢复轮不需要用户消息')]) as object),
    resume,
  }) as never;

/** 一次审批停下时后端会发的那些字段（取自 hitl_smoke / 真实事件形状）。 */
const HITL_DATA: Record<string, unknown> = {
  ask: '是否允许执行该工具调用？',
  tool_key: 'agent.platform.describe_platform',
  arguments: { tool_limit: 20 },
  approver_role: null,
  options: ['approve', 'reject', 'always'],
  run_id: 'run-1',
  interrupt_id: 'int-1',
};

/** 一帧后端事件。测试里只关心 event / data / id 三个字段。 */
const frame = (
  event: string,
  data: Record<string, unknown> = {},
  id?: string,
): RunEventFrame => ({ id, event, payload: { event, data }, data });

/** 订阅 run()，把事件收成一个数组。 */
const collect = async (
  agent: DockAgent,
  input: never,
): Promise<Record<string, unknown>[]> => {
  const events: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    agent.run(input).subscribe({
      next: (event) => events.push(event as Record<string, unknown>),
      error: reject,
      complete: resolve,
    });
  });
  return events;
};

/** 让 runEvents 吐出给定这些帧然后自然结束。 */
const givenFrames = (frames: RunEventFrame[]) => {
  mockedRunEvents.mockImplementation(
    () =>
      new Observable<RunEventFrame>((subscriber) => {
        for (const f of frames) subscriber.next(f);
        subscriber.complete();
      }),
  );
};

const makeAgent = (
  ensureSession: () => Promise<string>,
  renewSession?: () => Promise<string>,
) =>
  new DockAgent({
    ensureSession,
    renewSession,
    // ⚠️ 生产默认是 HITL_GROUP_WINDOW_MS(160ms)，测试里改成 0：
    //   givenFrames 是**同步**把帧推完的，窗口 0 就意味着"同一批推下来的中断
    //   必然聚成一组"，断言与时间无关。聚合算法本身（debounce、窗口推后、
    //   中断之后丢帧）另有 collectHitlGroup 那组用例专门用假定时器钉。
    hitlGroupWindowMs: 0,
  });

/** 完整的一轮：run.started → 两个 delta → message.completed → run.completed */
const HAPPY_FRAMES = [
  frame('run.started', { status: 'running' }),
  frame('message.delta', { delta: '你' }),
  frame('message.delta', { delta: '好' }),
  frame('message.completed', { content: '你好' }),
  frame('run.completed', { status: 'completed' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedCreateRun.mockResolvedValue(RUN);
  mockedCancelRun.mockResolvedValue(undefined);
  givenFrames(HAPPY_FRAMES);
});

describe('事件序列', () => {
  it('RUN_STARTED → 流式文本 → RUN_FINISHED，threadId/runId 一路带齐', async () => {
    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      // `message.completed` 顺手补的推理收尾信号（reasoning 那条平行通道）。
      // 它**不落 messages**，所以消息流的形状不受影响 —— 见 reasoningStream.ts。
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ]);

    expect(events[0]).toMatchObject({
      threadId: 'thread-1',
      runId: 'client-run-1',
    });
    expect(events.at(-1)).toMatchObject({
      threadId: 'thread-1',
      runId: 'client-run-1',
    });

    // 一条消息 = 一个 messageId，否则界面拼不出一条完整消息
    const [, start, c1, c2, end] = events;
    expect(start).toMatchObject({ role: 'assistant' });
    expect(c1.messageId).toBe(start.messageId);
    expect(c2.messageId).toBe(start.messageId);
    expect(end.messageId).toBe(start.messageId);
    expect(c1.delta).toBe('你');
    expect(c2.delta).toBe('好');
  });

  it('订阅的是 createRun 返回的 run_id', async () => {
    await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    expect(runEvents).toHaveBeenCalledTimes(1);
    expect(mockedRunEvents.mock.calls[0][0]).toBe('run-1');
  });
});

describe('提交给后端的东西', () => {
  it('先建会话再建运行，提交的是**最后一条**用户消息', async () => {
    await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([
        userMessage('第一句'),
        { id: 'm-a', role: 'assistant', content: '上一轮的回答' },
        userMessage('第二句'),
      ]),
    );

    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun).toHaveBeenCalledWith('sess-1', {
      input: { text: '第二句' },
      // 后端只收字符串、不会替我们造 id，所以每次提交都必须自带
      trace_id: expect.any(String),
    });
  });

  it('每次提交都带一个新的 v4 uuid 当 trace_id（不是会话级常量）', async () => {
    // 两次独立的运行（两个 agent = 两个会话各自的第一次发言）
    for (const text of ['第一轮', '第二轮']) {
      mockedCreateRun.mockResolvedValueOnce({
        ...RUN,
        session_id: `sess-${text}`,
      });
      await collect(
        makeAgent(() => Promise.resolve(`sess-${text}`)),
        makeInput([userMessage(text)]),
      );
    }

    const traces = mockedCreateRun.mock.calls.map((call) => call[1].trace_id);
    expect(traces).toHaveLength(2);
    for (const id of traces) {
      // v4 uuid 的形状：第 13 位是 4、第 17 位是 8/9/a/b
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // 后端 max_length=255 且空白串等于没传 —— 空/超长都要在这里就挡住
      expect(typeof id).toBe('string');
      expect((id as string).trim()).toBe(id);
    }
    // 两条运行必须分开：混成一条会让 `trace:<id>:events` 靠 run_id 二次筛
    expect(traces[0]).not.toBe(traces[1]);
  });

  it('这一轮没有用户消息时不去打扰后端', async () => {
    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([{ id: 'm-a', role: 'assistant', content: '只有助手消息' }]),
    );

    expect(createRun).not.toHaveBeenCalled();
    expect(runEvents).not.toHaveBeenCalled();
    // 失败也要是一条看得见的消息，而不是空回复
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events[2].delta).toContain('这一轮没有用户消息');
  });
});

describe('流式的各种收尾', () => {
  it('message.completed 的 content 比已流的长时，把缺的那段补上', async () => {
    givenFrames([
      frame('message.delta', { delta: '你' }),
      frame('message.completed', { content: '你好吗' }),
      frame('run.completed', { status: 'completed' }),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    const deltas = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta);
    expect(deltas).toEqual(['你', '好吗']);
  });

  it('一次运行里两条消息 → 两个 messageId', async () => {
    givenFrames([
      frame('message.delta', { delta: '第一句' }),
      frame('message.completed', { content: '第一句' }),
      frame('message.delta', { delta: '第二句' }),
      frame('message.completed', { content: '第二句' }),
      frame('run.completed', { status: 'completed' }),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    const ids = new Set(
      events
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => e.messageId),
    );
    expect(ids.size).toBe(2);
    // RUN_FINISHED 只能有一次
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED).length).toBe(
      1,
    );
  });

  it('run.failed：原因写进消息，仍然走完 RUN_FINISHED', async () => {
    givenFrames([
      frame('message.delta', { delta: '半句话' }),
      frame('run.failed', {
        status: 'failed',
        error_type: 'TimeoutError',
        error_message: 'TimeoutError: model timeout',
      }),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    const deltas = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta as string);
    expect(deltas[0]).toBe('半句话');
    // 失败原因另起一条消息（第二条气泡），不混在半句话后面
    expect(deltas[1]).toContain('TimeoutError');
    expect(deltas[1]).toContain('model timeout');
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('流在没有终态事件时就结束：补一句说明再 RUN_FINISHED', async () => {
    givenFrames([frame('message.delta', { delta: '半句话' })]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    const deltas = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta as string);
    expect(deltas.at(-1)).toContain('没有终态事件');
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('一个字都没流出来也要有一条消息，不能是空回复', async () => {
    givenFrames([
      frame('run.started', { status: 'running' }),
      frame('run.completed', { status: 'completed' }),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    const deltas = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta as string);
    expect(deltas.join('')).toContain('没有返回可显示的文本');
  });
});

describe('失败也要看得见', () => {
  it('建会话失败：不发运行请求，回复里写清原因', async () => {
    const events = await collect(
      makeAgent(() => Promise.reject({ data: { detail: '会话不存在：s-1' } })),
      makeInput([userMessage('你好')]),
    );

    expect(createRun).not.toHaveBeenCalled();
    expect(runEvents).not.toHaveBeenCalled();
    expect(events[2].delta).toContain('会话不存在：s-1');
    // 失败也走完协议，界面才不会卡在「正在运行」
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('建运行失败：原因出现在回复里', async () => {
    mockedCreateRun.mockRejectedValue(new Error('Network Error'));

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    expect(events[2].delta).toContain('Network Error');
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('事件流本身出错（404 / 503）：照样收尾', async () => {
    mockedRunEvents.mockImplementation(
      () =>
        new Observable<RunEventFrame>((subscriber) => {
          subscriber.error(new Error('事件流不可用（HTTP 503）'));
        }),
    );

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    expect(events[2].delta).toContain('HTTP 503');
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });
});

describe('失败要能定位到哪一步', () => {
  /** axios 风格的错误：状态码与响应体在 response 上。 */
  const httpError = (status: number, detail?: string) => ({
    response: { status, data: detail ? { detail } : undefined },
    message: `Request failed with status code ${status}`,
  });

  it('建会话失败：文案里写明是建会话', async () => {
    const events = await collect(
      makeAgent(() => Promise.reject(httpError(404, '后端没起'))),
      makeInput([userMessage('你好')]),
    );

    expect(events[2].delta).toContain('建会话（POST /sessions）');
    expect(events[2].delta).toContain('后端没起');
  });

  it('建运行 404 且能重建会话：用新会话重试一次，成功', async () => {
    mockedCreateRun
      .mockRejectedValueOnce(httpError(404, '会话不存在：sess-old'))
      .mockResolvedValueOnce({
        run_id: 'run-2',
        session_id: 'sess-new',
        status: 'queued',
      });

    let renewed = 0;
    const events = await collect(
      makeAgent(
        () => Promise.resolve('sess-old'),
        () => {
          renewed += 1;
          return Promise.resolve('sess-new');
        },
      ),
      makeInput([userMessage('你好')]),
    );

    expect(renewed).toBe(1);
    expect(mockedCreateRun.mock.calls.map((c) => c[0])).toEqual([
      'sess-old',
      'sess-new',
    ]);
    // 重试成功 → 订阅的是新会话下那个 run_id，界面上是一条正常回复
    expect(mockedRunEvents.mock.calls[0][0]).toBe('run-2');
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('建运行 404 但没有重建入口：文案写明是建运行，别只留一个 HTTP 404', async () => {
    mockedCreateRun.mockRejectedValue(httpError(404, '会话不存在：sess-1'));

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    const delta = events[2].delta as string;
    expect(delta).toContain('建运行（POST /sessions/{id}/runs）');
    // 后端的中文原因必须保留 —— 只显示 "HTTP 404" 是排查不了的
    expect(delta).toContain('会话不存在：sess-1');
  });

  it('重建会话后仍然失败：说清已经重试过', async () => {
    mockedCreateRun.mockRejectedValue(httpError(404, '会话不存在'));

    const events = await collect(
      makeAgent(
        () => Promise.resolve('sess-old'),
        () => Promise.resolve('sess-new'),
      ),
      makeInput([userMessage('你好')]),
    );

    expect(events[2].delta).toContain('用新会话重新建运行');
    // 只重试一次，不会无限打后端
    expect(createRun).toHaveBeenCalledTimes(2);
    // 两次尝试各自一条 trace：第一次在「会话不存在」就 404 了，运行行没落、
    // 一条 trace 事件都没写，沿用旧 id 只会得到一个"只有后半段"的键
    const traces = mockedCreateRun.mock.calls.map((call) => call[1].trace_id);
    expect(new Set(traces).size).toBe(2);
  });

  it('事件流出错：文案写明是订阅事件流', async () => {
    mockedRunEvents.mockImplementation(
      () =>
        new Observable<RunEventFrame>((subscriber) => {
          subscriber.error(httpError(503, '事件流不可用：Redis 没起来'));
        }),
    );

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('你好')]),
    );

    const delta = events[2].delta as string;
    expect(delta).toContain('订阅事件流（GET /runs/{run_id}/events）');
    expect(delta).toContain('事件流不可用：Redis 没起来');
  });
});

describe('人工审批（HITL）', () => {
  /** 第一轮：跑到审批停下。返回这一轮的事件。 */
  const runToInterrupt = async (agent: DockAgent) => {
    givenFrames([
      frame('message.delta', { delta: '我要调个工具' }, '100-0'),
      frame('hitl.requested', HITL_DATA, '101-0'),
    ]);
    return collect(agent, makeInput([userMessage('查一下平台')]));
  };

  it('hitl.requested → RUN_FINISHED 带 interrupt，且**立刻收流**（后面的帧不再处理）', async () => {
    givenFrames([
      frame('message.delta', { delta: '我要调个工具' }, '100-0'),
      frame('hitl.requested', HITL_DATA, '101-0'),
      // ⚠️ 这三帧**都不该**被处理：agent 看到 hitl.requested 就收流了。
      //   不收的话 runAgent 永远不 resolve，CopilotKit 也就不会把 interrupts
      //   交给 useInterrupt —— 卡片根本不出现（这是本用例在钉的行为）。
      frame('message.delta', { delta: '这段不该出现' }, '102-0'),
      frame('run.completed', { status: 'completed' }, '103-0'),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('查一下平台')]),
    );

    // 关掉流到一半的消息 → 带 interrupt 的 RUN_FINISHED
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    // RUN_FINISHED 只能有一次，而且必须是 interrupt 那一种
    // （不带 outcome 的会被客户端当成"跑完了"，并清掉 pendingInterrupts）
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'interrupt' } });
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED).length).toBe(
      1,
    );

    // 中断后那两帧的字一个都不能出现
    const deltas = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta);
    expect(deltas).toEqual(['我要调个工具']);
  });

  /** 第二个并行工具的中断 —— 除了 id / 工具名 / 问句，其余与第一条同形。 */
  const HITL_DATA_2: Record<string, unknown> = {
    ...HITL_DATA,
    interrupt_id: 'int-2',
    tool_key: 'agent.platform.list_documents',
    ask: '另一个工具也要审批。',
  };

  it('⭐ 并行工具各停一次：两条 hitl.requested 聚成**一个**带 2 个中断的 RUN_FINISHED', async () => {
    // 后端工具是并行跑的，每个停在审批上的工具各发一条 hitl.requested，
    // 中间没有"这一组发完了"的标记。逐条翻的话第一帧就把这一轮收尾了、
    // 第二条被丢掉 —— 界面上只看得到一个待办，用户永远答不上第二个。
    givenFrames([
      frame('message.delta', { delta: '要调两个工具' }, '100-0'),
      frame('hitl.requested', HITL_DATA, '101-0'),
      frame('hitl.requested', HITL_DATA_2, '102-0'),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('查一下平台')]),
    );

    // ⭐ 收尾只有一次，而且这一批里是**两条** —— 这就是"一张卡 + 位次"的依据
    const finished = events.filter((e) => e.type === EventType.RUN_FINISHED);
    expect(finished).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'interrupt' } });

    const outcome = (
      events.at(-1) as { outcome?: { interrupts?: { id: string }[] } }
    ).outcome;
    expect(outcome?.interrupts?.map((i) => i.id)).toEqual(['int-1', 'int-2']);
  });

  it('⭐ 整组答完 → **一次**请求带走整组（循环发单条会让第二条撞 409，那些工具永远拿不到答案）', async () => {
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    // 第一轮：并行两个工具，都停下来等审批
    givenFrames([
      frame('hitl.requested', HITL_DATA, '101-0'),
      frame('hitl.requested', HITL_DATA_2, '102-0'),
    ]);
    await collect(agent, makeInput([userMessage('查一下平台')]));
    expect(createRun).toHaveBeenCalledTimes(1);

    givenFrames([frame('run.completed', { status: 'completed' }, '104-0')]);
    await collect(
      agent,
      makeResumeInput([
        {
          interruptId: 'int-1',
          status: 'resolved',
          payload: { decision: 'approve' },
        },
        {
          interruptId: 'int-2',
          status: 'resolved',
          payload: { decision: 'reject' },
        },
      ]),
    );

    // ⭐ 只有**一个**请求，而且整组一起走 `answers`
    expect(mockedResumeRun).toHaveBeenCalledTimes(1);
    expect(mockedResumeRun).toHaveBeenCalledWith('run-1', {
      answers: [
        { interrupt_id: 'int-1', data: { decision: 'approve' } },
        { interrupt_id: 'int-2', data: { decision: 'reject' } },
      ],
    });

    // 恢复**不是**新开一次运行（会话与 run_id 都不变）
    expect(createRun).toHaveBeenCalledTimes(1);
    // 断点续传带的是整组的**最后一帧** —— 少带一条就会把第二条重发一遍
    expect(mockedRunEvents.mock.calls.at(-1)?.[1]).toEqual({
      lastEventId: '102-0',
    });
  });

  it('整组里有一条被取消（没有 payload）→ 那一条落成拒绝，其余原样', async () => {
    const agent = makeAgent(() => Promise.resolve('sess-1'));
    givenFrames([
      frame('hitl.requested', HITL_DATA, '101-0'),
      frame('hitl.requested', HITL_DATA_2, '102-0'),
    ]);
    await collect(agent, makeInput([userMessage('查一下平台')]));

    givenFrames([frame('run.completed', { status: 'completed' }, '104-0')]);
    await collect(
      agent,
      makeResumeInput([
        {
          interruptId: 'int-1',
          status: 'resolved',
          payload: { decision: 'approve' },
        },
        { interruptId: 'int-2', status: 'cancelled' },
      ]),
    );

    // ⚠️ 取消那条**也必须在 answers 里**：后端要求 answers 正好覆盖 pending 集合，
    //   少一条就是 409（那个中断会永远停着）。落成 reject 与后端 fail-closed 同向。
    expect(mockedResumeRun).toHaveBeenCalledWith('run-1', {
      answers: [
        { interrupt_id: 'int-1', data: { decision: 'approve' } },
        { interrupt_id: 'int-2', data: { decision: 'reject' } },
      ],
    });
  });

  it('流在 hitl.requested 之后一直挂着不关（后端就是这样）：我们这边仍要主动收尾完结', async () => {
    // ⚠️ 这一条是整个功能的地基，也是唯一一条"源不结束"的用例。
    //   后端在等审批期间**不关流**（等审批不算终态），而 CopilotKit 要等
    //   这个 observable **完结**才会走 onRunFinalized、把 interrupts 交给
    //   useInterrupt —— 卡片才会出现。所以"收流"必须由我们主动做（takeWhile），
    //   不能指望源自己 complete。
    //   把 takeWhile 去掉，这条用例会**挂住直到超时**（而不是给出一个错的断言）。
    mockedRunEvents.mockImplementation(
      () =>
        new Observable<RunEventFrame>((subscriber) => {
          subscriber.next(frame('hitl.requested', HITL_DATA, '101-0'));
          // 故意不 complete、不 error —— 模拟"后端把流挂着等回答"
        }),
    );

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('查一下平台')]),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'interrupt' },
    });
  });

  it('interrupt 里带齐回答所需的东西：id / reason / 问什么 / 工具 / 参数 / options', async () => {
    const events = await runToInterrupt(
      makeAgent(() => Promise.resolve('sess-1')),
    );

    const outcome = (
      events.at(-1) as {
        outcome?: { interrupts?: Record<string, unknown>[] };
      }
    ).outcome;
    const interrupt = outcome?.interrupts?.[0];

    expect(interrupt).toMatchObject({
      id: 'int-1',
      reason: 'tool_approval',
      message: '是否允许执行该工具调用？',
    });

    // 值域走 responseSchema（AG-UI 描述"该给什么回答"的标准位置）——
    // 卡片据此知道该画几个按钮，而不是前端硬编码"始终允许"
    expect(interrupt?.responseSchema).toMatchObject({
      properties: { decision: { enum: ['approve', 'reject', 'always'] } },
    });

    // 原始字段走 metadata（卡片要显示"批的是什么工具、什么参数"）
    expect(interrupt?.metadata).toMatchObject({
      toolKey: 'agent.platform.describe_platform',
      arguments: { tool_limit: 20 },
      options: ['approve', 'reject', 'always'],
      runId: 'run-1',
    });
  });

  it('模型一个字都没说就停下来：不补"没有返回可显示的文本"', async () => {
    // 用户就让它去调工具，模型直接发 tool_call —— 这是正常的一轮
    givenFrames([frame('hitl.requested', HITL_DATA, '101-0')]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('查一下平台')]),
    );

    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'interrupt' } });
  });

  it('没有 interrupt_id：不假装有中断可答，而是说清答不了', async () => {
    givenFrames([
      frame('hitl.requested', { ...HITL_DATA, interrupt_id: '' }, '101-0'),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('查一下平台')]),
    );

    // 不能带 outcome —— 没有 id 就答不了，画一个点了没反应的按钮更糟
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect((events.at(-1) as { outcome?: unknown }).outcome).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => e.delta)
        .join(''),
    ).toContain('interrupt_id');
  });

  it('⭐ 一组里**只有一条**读不出 id → 整组都不给按钮（不是"跳过那一条"）', async () => {
    // 后端要求 answers **正好覆盖** pending 集合，少一个就 409。所以丢一条
    // 之后照样把剩下几条送上去，用户会拿到一个点了必然失败的按钮 ——
    // 比明说"这一组答不了"更糟。fail-closed。
    givenFrames([
      frame('hitl.requested', HITL_DATA, '101-0'),
      frame('hitl.requested', { ...HITL_DATA_2, interrupt_id: '' }, '102-0'),
    ]);

    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('查一下平台')]),
    );

    // 没有 outcome = 没有可答的中断（一条都不能答）
    expect((events.at(-1) as { outcome?: unknown }).outcome).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => e.delta)
        .join(''),
    ).toContain('interrupt_id');
  });

  it('恢复：input.resume 非空 → POST /resume（不建第二次运行），并带 Last-Event-ID', async () => {
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    const firstEvents = await runToInterrupt(agent);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(resumeRun).not.toHaveBeenCalled();

    givenFrames([
      frame('message.delta', { delta: '已放行，这是结果' }, '104-0'),
      frame('run.completed', { status: 'completed' }, '105-0'),
    ]);
    const events = await collect(
      agent,
      makeResumeInput([
        {
          interruptId: 'int-1',
          status: 'resolved',
          payload: { decision: 'approve' },
        },
      ]),
    );

    // 恢复**不是**新开一次运行：会话与 run_id 都不变。
    // ⚠️ 只有一条也要包成 `{ answers: [ 一条 ] }` —— 后端那个 ResumeRequest
    //   没有单条形状（`answers` 是唯一字段，minItems: 1）。
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(mockedResumeRun).toHaveBeenCalledWith('run-1', {
      answers: [{ interrupt_id: 'int-1', data: { decision: 'approve' } }],
    });

    // ⚠️ 断点续传：从上一轮最后一帧之后开始
    //   后端不带头就从头补发 —— 不带上它，中断前那段话会被**重发一遍**
    expect(mockedRunEvents.mock.calls.at(-1)?.[1]).toEqual({
      lastEventId: '101-0',
    });

    expect(
      events
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => e.delta),
    ).toEqual(['已放行，这是结果']);

    // ⚠️ 恢复那一轮的消息 id 必须与中断前那段**不同**
    //   两轮共用同一个 AG-UI runId，光靠 runId 派生 id 会撞上 ——
    //   撞上之后 client 不报错，而是把新文字**并进**旧气泡里（静默、难查）。
    const firstId = firstEvents.find(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    )?.messageId;
    const secondId = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    )?.messageId;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });

  it('恢复时 resumeRun 409：文案要点出**两种**含义（答过了 / 与后端待办对不上）', async () => {
    const agent = makeAgent(() => Promise.resolve('sess-1'));
    await runToInterrupt(agent);

    mockedResumeRun.mockRejectedValue({
      response: { status: 409, data: {} },
      message: 'Request failed with status code 409',
    });

    const events = await collect(
      agent,
      makeResumeInput([
        {
          interruptId: 'int-1',
          status: 'resolved',
          payload: { decision: 'approve' },
        },
      ]),
    );

    const text = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta as string)
      .join('');
    expect(text).toContain('回答这次审批');
    // 后端 docstring 里 409 有两种：① 不在 waiting_input（答过了）；
    // ② answers 与当前 pending 集合不一致（漏读了一条 hitl.requested）。
    // 老文案只覆盖① —— 用户遇到②时会一头雾水（"我明明第一次点"）。
    expect(text).toContain('已经不在等人回答');
    expect(text).toContain('对不上');
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('恢复时查不到对应的运行（比如页面刷新过）：说清原因，不瞎建运行', async () => {
    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeResumeInput([
        {
          interruptId: 'int-unknown',
          status: 'resolved',
          payload: { decision: 'approve' },
        },
      ]),
    );

    expect(createRun).not.toHaveBeenCalled();
    expect(mockedResumeRun).not.toHaveBeenCalled();
    expect(events[2].delta).toContain('找不到这次审批对应的运行');
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('cancel（status=cancelled，没有 payload）落成拒绝 —— 不能什么都不发', async () => {
    // 什么都不发的话后端会永远停在 waiting_input，而这个会话在等人工输入期间
    // **建不了新运行**（409）—— 等于把会话锁死。所以取消也要把回答送回去。
    const agent = makeAgent(() => Promise.resolve('sess-1'));
    await runToInterrupt(agent);

    givenFrames([frame('run.completed', { status: 'completed' }, '104-0')]);
    await collect(
      agent,
      makeResumeInput([{ interruptId: 'int-1', status: 'cancelled' }]),
    );

    expect(mockedResumeRun).toHaveBeenCalledWith('run-1', {
      answers: [{ interrupt_id: 'int-1', data: { decision: 'reject' } }],
    });
  });
});

describe('collectHitlGroup（并行审批聚成一批）', () => {
  /** 订阅算子，收集批次，并记下有没有完结。 */
  const drive = (windowMs: number) => {
    const source = new Subject<RunEventFrame>();
    const batches: RunEventFrame[][] = [];
    const state = { completed: false };
    source.pipe(collectHitlGroup(windowMs)).subscribe({
      next: (batch) => batches.push(batch),
      complete: () => {
        state.completed = true;
      },
    });
    return { source, batches, state };
  };

  it('非中断帧**一帧一批**立刻下去 —— 不然就不是流式了', () => {
    const { source, batches } = drive(160);

    source.next(frame('message.delta', { delta: '你' }));
    source.next(frame('message.delta', { delta: '好' }));

    // 窗口一个都没等到，普通帧也已经出去了（两批，各 1 帧）
    expect(batches.map((b) => b.length)).toEqual([1, 1]);
    expect(batches[0][0].data.delta).toBe('你');
  });

  it('⭐ 窗口内连着来的中断聚成一批，且窗口**每来一条就往后推**', () => {
    vi.useFakeTimers();
    try {
      const { source, batches, state } = drive(160);

      source.next(frame('hitl.requested', HITL_DATA, '101-0'));
      vi.advanceTimersByTime(100);
      // 窗口还没到 —— 一条都不出去（正在等"还有没有第二个工具"）
      expect(batches).toHaveLength(0);

      source.next(
        frame(
          'hitl.requested',
          { ...HITL_DATA, interrupt_id: 'int-2' },
          '102-0',
        ),
      );
      vi.advanceTimersByTime(100); // 距第一条 200ms、距第二条 100ms
      // ⭐ 固定计时到这里早就发出去了 —— debounce 把窗口推到了第二条之后
      expect(batches).toHaveLength(0);

      vi.advanceTimersByTime(60);
      expect(batches).toHaveLength(1);
      expect(batches[0].map((f) => f.data.interrupt_id)).toEqual([
        'int-1',
        'int-2',
      ]);
      // 交出整组之后**立刻完结**：runAgent 要等这个 observable 完结才会把
      // interrupts 交给 useInterrupt —— 卡片才会出现（这条不能省）
      expect(state.completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('开始等审批之后来的帧一概丢掉（运行已经停了，后面的都不算数）', () => {
    vi.useFakeTimers();
    try {
      const { source, batches } = drive(160);

      source.next(frame('hitl.requested', HITL_DATA, '101-0'));
      source.next(frame('message.delta', { delta: '不该出现' }, '102-0'));
      source.next(frame('run.completed', { status: 'completed' }, '103-0'));
      vi.advanceTimersByTime(160);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0][0].event).toBe('hitl.requested');
    } finally {
      vi.useRealTimers();
    }
  });

  it('源在窗口到点前就关了 → 照样把攒下的这组交出去（后端提前关流也不能丢）', () => {
    const { source, batches, state } = drive(160);

    source.next(frame('hitl.requested', HITL_DATA, '101-0'));
    source.complete();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(state.completed).toBe(true);
  });
});

describe('resumeDecision', () => {
  it('dict 原样过 —— 将来别的 HITL 处理器有自己的形状，这里不替它裁剪', () => {
    expect(resumeDecision({ decision: 'approve' })).toEqual({
      decision: 'approve',
    });
    expect(resumeDecision({ answer: '42' })).toEqual({ answer: '42' });
  });

  it('bool / 裸字符串折成 decision（后端 ApprovalDecision 认这两种简写）', () => {
    expect(resumeDecision(true)).toEqual({ decision: 'approve' });
    expect(resumeDecision(false)).toEqual({ decision: 'reject' });
    expect(resumeDecision('always')).toEqual({ decision: 'always' });
  });

  it('认不出的按拒绝 —— 与后端的 fail-closed 同向', () => {
    expect(resumeDecision(undefined)).toEqual({ decision: 'reject' });
    expect(resumeDecision(null)).toEqual({ decision: 'reject' });
    expect(resumeDecision(42)).toEqual({ decision: 'reject' });
    expect(resumeDecision(['approve'])).toEqual({ decision: 'reject' });
  });
});

describe('lastUserText', () => {
  it('取最后一条 user 消息并折叠首尾空白', () => {
    expect(
      lastUserText([
        { id: 'a', role: 'user', content: ' 旧 ' },
        { id: 'b', role: 'user', content: ' 新 ' },
      ] as never),
    ).toBe('新');
  });

  it('多模态 content（数组）里只取文本部分', () => {
    expect(
      lastUserText([
        userMessage([
          { type: 'text', text: '看看' },
          { type: 'image', url: 'x.png' },
          { type: 'text', text: '这张图' },
        ]),
      ] as never),
    ).toBe('看看这张图');
  });

  it('没有 user 消息时返回空串', () => {
    expect(lastUserText([] as never)).toBe('');
  });
});

/**
 * 续订一个**已经在后端跑着**的运行（刷新 / 切回会话那条路）。
 *
 * 需求原话：「刷新后第一次打开某个 conversation，自动检测有无在 run 的实例，
 * 有则直接订阅」。这里钉住的是 agent 这一侧的四件事：
 *   · 续订**不建会话也不建运行**（否则会把用户上一条消息又提交一次）；
 *   · 标记是**一次性**的（残留下来会劫持用户下一轮真发的消息）；
 *   · 界面上的旧助手回复要**摘掉**（不然重放会多出一条一模一样的），而且
 *     摘的时机必须是 **attachRun 那一刻** —— 晚于 runAgent 就会被
 *     @ag-ui/client 的整份回写覆盖回来（见下面第一条用例）；
 *   · 摘下来的东西**不能就这么丢了**：流真的没内容（记录过期）时到点要放回原位。
 */
describe('续订已有运行（attachRun）', () => {
  /** 造一个带着旧消息的 agent：u1/a1 属于要续订的那次运行，a0 是更早那一轮的。 */
  const agentWithReplies = (ensureSession = async () => 'sess-1') => {
    const agent = makeAgent(ensureSession);
    agent.setMessages([
      {
        id: 'u1',
        role: 'user',
        content: '刷新前问的',
        metadata: { runId: 'run-9' },
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '半截回答',
        metadata: { runId: 'run-9' },
      },
      {
        id: 'a0',
        role: 'assistant',
        content: '更早那轮的回答',
        metadata: { runId: 'run-0' },
      },
    ] as never);
    return agent;
  };

  it('不建会话也不建运行，直接订阅那个 run_id（内容靠从头补发重建）', async () => {
    const ensureSession = vi.fn(async () => 'sess-1');
    const agent = agentWithReplies(ensureSession);
    agent.attachRun('run-9');

    const events = await collect(agent, makeInput([userMessage('刷新前问的')]));

    expect(ensureSession).not.toHaveBeenCalled();
    expect(mockedCreateRun).not.toHaveBeenCalled();
    expect(mockedRunEvents).toHaveBeenCalledWith('run-9', {
      lastEventId: undefined,
    });
    expect(events[0]).toMatchObject({
      type: EventType.RUN_STARTED,
      threadId: 'thread-1',
      runId: 'client-run-1',
    });
  });

  it('标记只用一次：紧接着真发消息还是走建运行那条路', async () => {
    const agent = makeAgent(async () => 'sess-1');
    agent.attachRun('run-9');

    await collect(agent, makeInput([userMessage('续订那轮')]));
    await collect(agent, makeInput([userMessage('用户真发的一句')]));

    expect(mockedCreateRun).toHaveBeenCalledTimes(1);
    expect(mockedRunEvents).toHaveBeenLastCalledWith('run-1', {
      lastEventId: undefined,
    });
  });

  it('⭐ clearAttach 之后不劫持用户的新消息（续订没跑起来时靠它收尾）', async () => {
    // 模拟 RunResume 的失败路径：attachRun 了，但 runAgent 同步抛、没进 run()
    const agent = makeAgent(async () => 'sess-1');
    agent.attachRun('run-9');
    agent.clearAttach();

    await collect(agent, makeInput([userMessage('新问题')]));

    // 这一轮必须真的提交给后端，而不是去订阅那个旧 run
    expect(mockedCreateRun).toHaveBeenCalledWith('sess-1', {
      input: { text: '新问题' },
      trace_id: expect.any(String),
    });
    expect(mockedRunEvents).toHaveBeenCalledWith('run-1', {
      lastEventId: undefined,
    });
  });

  it('答审批那一轮不会被残留的标记劫持（resume 优先于续订）', async () => {
    // 先正常跑一轮，拿到一个带 interrupt 的中断（记账 int-1 → run-1）
    givenFrames([frame('hitl.requested', HITL_DATA)]);
    const agent = makeAgent(async () => 'sess-1');
    await collect(agent, makeInput([userMessage('触发一次审批')]));
    expect(mockedRunEvents).toHaveBeenCalledWith('run-1', {
      lastEventId: undefined,
    });

    // 标记还在身上（比如续订那一次没订阅成）
    agent.attachRun('run-9');
    mockedResumeRun.mockResolvedValue(undefined);
    givenFrames([]);

    await collect(
      agent,
      makeResumeInput([
        {
          interruptId: 'int-1',
          status: 'resolved',
          payload: { decision: 'approve' },
        },
      ]),
    );

    // 走的是 resume：回答发给了**原来那次**运行，而不是去订阅 run-9
    expect(mockedResumeRun).toHaveBeenCalledWith('run-1', {
      answers: [{ interrupt_id: 'int-1', data: { decision: 'approve' } }],
    });
    expect(mockedRunEvents).toHaveBeenCalledWith('run-1', {
      lastEventId: undefined,
    });
    expect(mockedRunEvents).not.toHaveBeenCalledWith(
      'run-9',
      expect.anything(),
    );
  });

  it('⭐ 摘旧副本发生在 attachRun **当场** —— 晚于 runAgent 就会被整份回写覆盖', () => {
    const agent = agentWithReplies();

    agent.attachRun('run-9');

    // 还没订阅任何东西，旧副本就已经不在界面上了（这一步正是修 bug 的落点：
    // 等"第一帧到达"再摘是来不及的 —— apply 算子会在 runAgent 那一刻克隆一份
    // agent.messages，之后整份回写，清掉的又被灌回来）
    expect(agent.messages.map((message) => message.id)).toEqual(['u1', 'a0']);
  });

  it('第一帧到达 → 备份丢掉（重放会把那条回答重建出来）', async () => {
    const agent = agentWithReplies();
    agent.attachRun('run-9');

    await collect(agent, makeInput([userMessage('刷新前问的')]));

    const ids = agent.messages.map((message) => message.id);
    expect(ids).not.toContain('a1');
    // 用户那条必须留着：事件流里只有助手消息，重放**不会**重建它
    expect(ids).toContain('u1');
    // 别的运行留下的东西一概不动
    expect(ids).toContain('a0');
  });

  it('⭐ 一帧都没有（记录已过期，只剩心跳）→ 到点把旧内容**原位放回**', async () => {
    vi.useFakeTimers();
    try {
      givenFrames([]);
      const agent = agentWithReplies();

      agent.attachRun('run-9');
      expect(agent.messages.map((message) => message.id)).toEqual(['u1', 'a0']);

      await collect(agent, makeInput([userMessage('刷新前问的')]));
      // 还没到点：仍然是"摘下来"的状态（这段时间那条回答在界面上是缺席的，
      // 所以 REPLAY_GRACE_MS 也不能给太大）
      expect(agent.messages.map((message) => message.id)).toEqual(['u1', 'a0']);

      vi.advanceTimersByTime(REPLAY_GRACE_MS);

      // 原位放回：位置与摘之前一致（a1 回到 u1 与 a0 之间），不是追加到末尾
      expect(agent.messages.map((message) => message.id)).toEqual([
        'u1',
        'a1',
        'a0',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('第一帧到了之后，兜底定时器不再把备份放回（已经结清）', async () => {
    vi.useFakeTimers();
    try {
      const agent = agentWithReplies();
      agent.attachRun('run-9');

      await collect(agent, makeInput([userMessage('刷新前问的')]));
      vi.advanceTimersByTime(REPLAY_GRACE_MS * 2);

      // 关掉定时器靠的是 settle，不是"到点没放回" —— 放回就是两条回答
      expect(agent.messages.map((message) => message.id)).not.toContain('a1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一个 run 重复摘（attachRun → reopenRun 那一跳）只 setMessages 一次', async () => {
    const agent = agentWithReplies();
    const setMessages = vi.spyOn(agent, 'setMessages');

    agent.attachRun('run-9');
    expect(setMessages).toHaveBeenCalledTimes(1);

    await collect(agent, makeInput([userMessage('刷新前问的')]));

    // 整个续订过程只整份替换过一次 —— 反复替换会让界面白闪
    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(agent.messages.map((message) => message.id)).toEqual(['u1', 'a0']);
  });

  it('万一换了续订目标：上一份备份先放回去，不凭空消失', () => {
    const agent = agentWithReplies();
    agent.attachRun('run-9');
    expect(agent.messages.map((message) => message.id)).toEqual(['u1', 'a0']);

    // run-11 在历史里没有助手回复（防御性路径：真实路径上一会话一 agent 实例）
    agent.attachRun('run-11');

    expect(agent.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'a0',
    ]);
  });

  it('不是续订的那一轮（正常发消息）绝不动任何消息', async () => {
    const agent = agentWithReplies();
    // 同一批 id 的旧消息躺着 —— 但它这次是"建新运行"，摘它就是误伤
    await collect(agent, makeInput([userMessage('新的一句话')]));

    expect(agent.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'a0',
    ]);
  });
});

describe('isReplayedReply', () => {
  it('只认**同一次运行的助手回复**；用户那条与别轮的一概不动', () => {
    const reply = (over: Record<string, unknown>) =>
      ({ id: 'x', role: 'assistant', content: '', ...over }) as never;

    expect(isReplayedReply(reply({ metadata: { runId: 'r-1' } }), 'r-1')).toBe(
      true,
    );
    // 用户消息：事件流里没有它，重放不会重建 —— 清了就是永久丢
    expect(
      isReplayedReply(
        reply({ role: 'user', metadata: { runId: 'r-1' } }),
        'r-1',
      ),
    ).toBe(false);
    // 别的运行
    expect(isReplayedReply(reply({ metadata: { runId: 'r-0' } }), 'r-1')).toBe(
      false,
    );
    // 没有 metadata / 没有 runId（真聊天的消息就没有）
    expect(isReplayedReply(reply({}), 'r-1')).toBe(false);
    expect(isReplayedReply(reply({ metadata: null }), 'r-1')).toBe(false);
  });
});

/**
 * 停止（abortRun）—— 库的「停止生成」按钮最终会走到 DockAgent.abortRun()。
 *
 * 为什么这组用例要单独钉：abortRun 在基类 AbstractAgent 里是**空实现**，
 * 不接它的话点暂停什么都不会发生（界面照转、后端照跑），而且**界面上看不出坏了**。
 * 这一组钉三件事，缺一件就等于功能没做完：
 *   ① 本地收流 → 界面退出「正在生成」（发RUN_FINISHED，不带"流莫名断了"那句）；
 *   ② 通知后端 cancel，且用的是**后端** run_id（不是 AG-UI 的那个）；
 *   ③ 点得比 createRun 还快时，也要能停下、也要补发 cancel。
 */
describe('停止（abortRun）', () => {
  /** 一条**挂着不结束**的流 —— 模拟"还在跑"，等 abortRun 来收。 */
  const givenOpenFrames = (frames: RunEventFrame[]) => {
    mockedRunEvents.mockImplementation(
      () =>
        new Observable<RunEventFrame>((subscriber) => {
          for (const f of frames) subscriber.next(f);
          // 故意不 complete：只有 takeUntil 能结束它
        }),
    );
  };

  /**
   * 订阅但不等到结束。
   *
   * ⚠️ 为什么不能直接用 collect()：它 await 完成，而"还没结束"正是这里的前提。
   */
  const startRun = (agent: DockAgent, input: never) => {
    const events: Record<string, unknown>[] = [];
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    agent.run(input).subscribe({
      next: (event) => events.push(event as Record<string, unknown>),
      // 停止不该产生 error；真出了错也算"结束了"，让用例继续往下断言
      error: () => settle(),
      complete: () => settle(),
    });
    return { events, done, settle };
  };

  const PARTIAL = [
    frame('run.started', { status: 'running' }),
    frame('message.delta', { delta: '正在写' }),
    frame('message.completed', { content: '正在写' }),
  ];

  const hasRunFinished = (events: Record<string, unknown>[]) =>
    events.some((e) => e.type === EventType.RUN_FINISHED);

  const textOf = (events: Record<string, unknown>[]) =>
    events
      // ⚠️ 内容帧的载荷字段是 **delta**（AG-UI 的 TextMessageContent），
      //   不是 message.completed 那个 content —— 取错会得到空串，
      //   而"空串不包含任何东西"会让断言变成假失败。
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => e.delta)
      .join('');

  it('本地立刻收尾（RUN_FINISHED），并把 cancel 发给**后端** run_id', async () => {
    givenOpenFrames(PARTIAL);
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    const { events, done } = startRun(
      agent,
      makeInput([userMessage('跑一下')]),
    );
    // 等建会话 + 建运行 + 首帧都过去，确保 backendRunId 已登记
    await vi.waitFor(() => expect(mockedRunEvents).toHaveBeenCalled());

    agent.abortRun();
    await done;

    // ① 界面这一轮真的结束了（否则按钮会一直转）
    expect(hasRunFinished(events)).toBe(true);
    // 已经流出来的半截内容留着（用户看得到他写了什么）
    expect(textOf(events)).toContain('正在写');
    // ② 通知后端，且用的是 createRun 返回的 run_id —— 不是 AG-UI 的 client-run-1
    expect(mockedCancelRun).toHaveBeenCalledTimes(1);
    expect(mockedCancelRun).toHaveBeenCalledWith('run-1');
  });

  it('⭐ 用户是主动停的：不再补那句「事件流在没有终态事件的情况下就关闭了」', async () => {
    givenOpenFrames(PARTIAL);
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    const { events, done } = startRun(
      agent,
      makeInput([userMessage('跑一下')]),
    );
    await vi.waitFor(() => expect(mockedRunEvents).toHaveBeenCalled());

    agent.abortRun();
    await done;

    // 用户刚亲手停的，却被告知"可能还没跑完"—— 这是最容易让人困惑的假消息
    expect(textOf(events)).not.toContain('没有终态事件');
  });

  it('流自己断了（没人点停止）：那句说明照旧要出现', async () => {
    // 对照用例：证明上一条不是因为 finish() 变了，而是"停止"这条路才绕过它。
    // ⚠️ 必须用**没有终态事件**的那组帧：带了 run.completed 就说明"流是正常
    //  结束的"，finish() 本来就不会补那句 —— 那样这条用例就是假绿。
    givenFrames(PARTIAL);
    const events = await collect(
      makeAgent(() => Promise.resolve('sess-1')),
      makeInput([userMessage('跑一下')]),
    );
    expect(textOf(events)).toContain('没有终态事件');
  });

  it('⭐ 点得比 createRun 还快：一轮照样收干净，cancel 也不会丢', async () => {
    // 让 createRun 悬着，期间就点停止 —— 模拟"发出去立刻改主意"
    let releaseRun: (run: AgentRun) => void = () => {};
    mockedCreateRun.mockImplementation(
      () =>
        new Promise<AgentRun>((resolve) => {
          releaseRun = resolve;
        }),
    );
    givenOpenFrames(PARTIAL);
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    const { events, done } = startRun(
      agent,
      makeInput([userMessage('跑一下')]),
    );
    await vi.waitFor(() => expect(mockedCreateRun).toHaveBeenCalled());

    // 这时还没有 backendRunId：abortRun 只能先把"要停"记下来
    agent.abortRun();
    expect(mockedCancelRun).not.toHaveBeenCalled();

    releaseRun(RUN);
    await done;

    expect(hasRunFinished(events)).toBe(true);
    // 关键：拿到 run_id 之后必须补发，否则后端那一轮会在界面上停完之后继续跑，
    // 而且没有任何东西会再提它（刷新也不会自己消失）
    expect(mockedCancelRun).toHaveBeenCalledTimes(1);
    expect(mockedCancelRun).toHaveBeenCalledWith('run-1');
  });

  it('连点两下只发一次 cancel（后端只该被通知一次）', async () => {
    givenOpenFrames(PARTIAL);
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    const { done } = startRun(agent, makeInput([userMessage('跑一下')]));
    await vi.waitFor(() => expect(mockedRunEvents).toHaveBeenCalled());

    agent.abortRun();
    agent.abortRun();
    agent.abortRun();
    await done;

    expect(mockedCancelRun).toHaveBeenCalledTimes(1);
  });

  it('没有在跑的一轮时点停止：什么也不做（不发请求、不抛）', () => {
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    expect(() => agent.abortRun()).not.toThrow();
    expect(mockedCancelRun).not.toHaveBeenCalled();
  });

  it('一轮跑完之后点停止：activeRun 已清空，不会对着旧 run_id 再喊一次', async () => {
    // ⚠️ 用 givenFrames（**会**正常结束）而不是 givenOpenFrames（挂着不结束）：
    //   这条要的就是"一轮已经跑完"的状态，挂着不结束的流会让 collect 永远等下去。
    givenFrames(HAPPY_FRAMES);
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    await collect(agent, makeInput([userMessage('跑一下')]));
    expect(mockedCancelRun).not.toHaveBeenCalled();

    agent.abortRun();

    expect(mockedCancelRun).not.toHaveBeenCalled();
  });

  it('cancel 被后端 409 拒绝（运行已结束/停在审批上）：静默，不冒泡也不吵', async () => {
    givenOpenFrames(PARTIAL);
    // ⚠️ 错误形状要按 umi request 的真实形状造：`{response:{status}}`。
    //   statusOf() 读的就是 error.response.status；造 `{status:409}` 会让它读到
    //   undefined → 走进"非良性"分支 → 打出 warn（第一版就踩了，还以为代码错了）。
    mockedCancelRun.mockRejectedValue({ response: { status: 409 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    const { done } = startRun(agent, makeInput([userMessage('跑一下')]));
    await vi.waitFor(() => expect(mockedRunEvents).toHaveBeenCalled());

    agent.abortRun();
    await expect(done).resolves.toBeUndefined();
    await Promise.resolve();

    expect(mockedCancelRun).toHaveBeenCalledTimes(1);
    // 良性 = 用户不该被打扰：一个字都不许吵
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('cancel 真的失败（5xx）：界面照样是停的，但要留下一条 console 线索', async () => {
    givenOpenFrames(PARTIAL);
    mockedCancelRun.mockRejectedValue({ response: { status: 500 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = makeAgent(() => Promise.resolve('sess-1'));

    const { events, done } = startRun(
      agent,
      makeInput([userMessage('跑一下')]),
    );
    await vi.waitFor(() => expect(mockedRunEvents).toHaveBeenCalled());

    agent.abortRun();
    await done;
    await Promise.resolve();

    // 界面这一轮照样收干净了（不能因为后端失败就卡在"正在生成"）
    expect(hasRunFinished(events)).toBe(true);
    // 但得留下线索：后端可能还在跑，排查时要看得到
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
