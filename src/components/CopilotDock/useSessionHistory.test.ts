// src/components/CopilotDock/useSessionHistory.test.ts
//
// 会话历史的**加载与注入**逻辑。核心场景只有一个，但很容易错：
//
//   点会话 A → 显示历史 → 点会话 B → 显示历史 → **再点回 A** → 必须是历史！
//
// 这里曾经有个 bug：`agent` 是按 `activeId` 重建的（`useMemo` 依赖里有 activeId），
// 新 agent 的 messages 是空的；而加载逻辑又用 `loadedSessionIds` 跳过"已加载过"的
// 会话不重拉 —— 于是第二次点回来时，既没有历史（agent 是新的），也不去拉（被跳过了），
// 界面一片空白。必须钉住这个场景。
import type { Message } from '@ag-ui/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from './agentRuntime';
import { listSessionMessages } from './agentRuntime';
import {
  type HistoryTarget,
  resumeCandidateOf,
  useSessionHistory,
} from './useSessionHistory';

vi.mock('./agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentRuntime')>()),
  listSessionMessages: vi.fn(),
}));

const mockedList = vi.mocked(listSessionMessages);

const message = (seq: number, text: string): SessionMessage => ({
  message_id: `m-${seq}`,
  seq,
  run_id: 'r-1',
  role: seq % 2 === 1 ? 'user' : 'assistant',
  kind: 'chat',
  business_agent_id: null,
  content: [{ type: 'text', text, artifact_id: null, source_id: null }],
  status: 'completed',
  reply_to_message_id: null,
  created_at: '2026-10-03T03:11:32.776052Z',
  updated_at: '2026-10-03T03:11:32.776052Z',
  metadata: {},
});

const page = (count: number) => ({
  session_id: 's-1',
  messages: Array.from({ length: count }, (_, i) =>
    message(i + 1, `第 ${i + 1} 条`),
  ),
  pagination: {
    limit: 50,
    has_more_before: false,
    before_cursor: null,
    has_more_after: false,
    after_cursor: null,
  },
});

/**
 * 造一个假的 agent：关心 setMessages 被喂了什么，也能"提前就有消息"
 * （`preset` = 挂载/切会话之前 agent 里已经躺着的那几条）。
 */
const makeTarget = (preset: readonly string[] = []) => {
  const calls: string[][] = [];
  const messages: Message[] = preset.map(
    (id) => ({ id, role: 'user', content: '' }) as Message,
  );
  return {
    calls,
    messages,
    setMessages: vi.fn((next: Message[]) => {
      calls.push(next.map((m) => m.id));
    }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue(page(2));
});

describe('首次加载', () => {
  it('拉到历史并灌进 agent', async () => {
    const target = makeTarget();
    const { result } = renderHook(() => useSessionHistory(target, 's-1'));

    await waitFor(() => expect(target.setMessages).toHaveBeenCalled());
    expect(target.calls[0]).toEqual(['m-1', 'm-2']);
    expect(result.current.status).toBeUndefined();
  });

  it('加载期间是 loading，拿到后清掉', async () => {
    let resolve: (v: ReturnType<typeof page>) => void = () => {};
    mockedList.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as never,
    );

    const target = makeTarget();
    const { result } = renderHook(() => useSessionHistory(target, 's-1'));

    await waitFor(() => expect(result.current.status).toBe('loading'));

    await act(async () => {
      resolve(page(1));
    });
    await waitFor(() => expect(result.current.status).toBeUndefined());
  });

  it('没有 sessionId（本地会话还没建后端会话）时不拉', () => {
    const target = makeTarget();
    renderHook(() => useSessionHistory(target, undefined));

    expect(mockedList).not.toHaveBeenCalled();
    expect(target.setMessages).not.toHaveBeenCalled();
  });

  it('拉失败时是 error，且不灌 agent', async () => {
    mockedList.mockRejectedValue(new Error('boom'));
    const target = makeTarget();

    const { result } = renderHook(() => useSessionHistory(target, 's-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(target.setMessages).not.toHaveBeenCalled();
  });
});

describe('⭐ 切回已加载过的会话（回归：曾经显示空白）', () => {
  it('第二次进来仍要把历史灌进**新的** agent 实例', async () => {
    // 真实切会话 = 同一个组件实例换 props（CopilotDock 常驻，只有内层
    // CopilotKit 因 key={activeId} 重挂）。target 变了 = agent 重建了。
    const first = makeTarget();
    const second = makeTarget();
    const { rerender } = renderHook(
      ({ target }) => useSessionHistory(target, 's-1'),
      { initialProps: { target: first } },
    );
    await waitFor(() => expect(first.setMessages).toHaveBeenCalled());

    // 切走（换个会话）再切回 —— target 换了，sessionId 相同
    rerender({ target: second });

    // 关键断言：新 agent 必须拿到历史，否则界面是空的
    await waitFor(() => expect(second.setMessages).toHaveBeenCalled());
    expect(second.calls[0]).toEqual(['m-1', 'm-2']);
  });

  it('来回切多次，每次都灌（而不是只有第一次）', async () => {
    const targets = [makeTarget(), makeTarget(), makeTarget()];
    const { rerender } = renderHook(
      ({ target }) => useSessionHistory(target, 's-1'),
      { initialProps: { target: targets[0] } },
    );

    for (const target of targets) {
      rerender({ target });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(target.setMessages).toHaveBeenCalled());
    }

    // 缓存住结果：不该每次切换都打接口
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('已加载过的会话：不重复打接口（缓存命中直接灌）', async () => {
    const first = makeTarget();
    const second = makeTarget();
    const { rerender } = renderHook(
      ({ target }) => useSessionHistory(target, 's-1'),
      { initialProps: { target: first } },
    );
    await waitFor(() => expect(first.setMessages).toHaveBeenCalled());

    rerender({ target: second });
    await waitFor(() => expect(second.setMessages).toHaveBeenCalled());

    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});

describe('会话之间来回切', () => {
  it('每个会话各拉各的，缓存互不干扰', async () => {
    mockedList.mockImplementation((async (sessionId: string) => ({
      ...page(1),
      session_id: sessionId,
      messages: [message(1, `${sessionId} 的消息`)],
    })) as never);

    const a1 = makeTarget();
    const b1 = makeTarget();
    const a2 = makeTarget();

    const { rerender } = renderHook(
      ({ target, sessionId }: { target: HistoryTarget; sessionId: string }) =>
        useSessionHistory(target, sessionId),
      { initialProps: { target: a1, sessionId: 's-A' } },
    );
    await waitFor(() => expect(a1.setMessages).toHaveBeenCalled());

    // 切到 B
    rerender({ target: b1, sessionId: 's-B' });
    await waitFor(() => expect(b1.setMessages).toHaveBeenCalled());

    // 切回 A：应该命中 A 的缓存，不再打接口
    rerender({ target: a2, sessionId: 's-A' });
    await waitFor(() => expect(a2.setMessages).toHaveBeenCalled());

    // A 拿到的必须是 A 的消息（不是 B 的）
    expect(mockedList).toHaveBeenCalledTimes(2);
  });
});

describe('竞态', () => {
  it('切得快：过期响应不灌进当前 target', async () => {
    let resolveSlow: (v: ReturnType<typeof page>) => void = () => {};
    mockedList.mockReturnValueOnce(
      new Promise((r) => {
        resolveSlow = r;
      }) as never,
    );
    mockedList.mockResolvedValueOnce({
      ...page(1),
      messages: [message(1, 'B 的消息')],
    });

    const slowTarget = makeTarget();
    const { unmount } = renderHook(() => useSessionHistory(slowTarget, 's-A'));
    unmount();

    // 切到 B，B 的请求先回
    const fastTarget = makeTarget();
    renderHook(() => useSessionHistory(fastTarget, 's-B'));
    await waitFor(() => expect(fastTarget.setMessages).toHaveBeenCalled());

    // 这时 A 的迟到响应才回来 —— 不能污染当前界面
    await act(async () => {
      resolveSlow(page(3));
    });

    expect(slowTarget.setMessages).not.toHaveBeenCalled();
    expect(fastTarget.calls[0]).toEqual(['m-1']);
  });

  it('退订后不 setState（不产生 React 警告）', async () => {
    let resolve: (v: ReturnType<typeof page>) => void = () => {};
    mockedList.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as never,
    );

    const target = makeTarget();
    const { unmount } = renderHook(() => useSessionHistory(target, 's-1'));
    unmount();

    await act(async () => {
      resolve(page(1));
    });
    // 不该再往已卸载的 target 灌
    expect(target.setMessages).not.toHaveBeenCalled();
  });
});

describe('invalidate', () => {
  it('丢掉缓存：下次进来重新拉（发过新消息后要能看到）', async () => {
    const first = makeTarget();
    const { result, unmount } = renderHook(() =>
      useSessionHistory(first, 's-1'),
    );
    await waitFor(() => expect(first.setMessages).toHaveBeenCalled());
    expect(mockedList).toHaveBeenCalledTimes(1);

    act(() => result.current.invalidate());
    unmount();

    const second = makeTarget();
    renderHook(() => useSessionHistory(second, 's-1'));

    await waitFor(() => expect(second.setMessages).toHaveBeenCalled());
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('⭐ 带 sessionId 时清的是**那一个**，不是当前会话', async () => {
    // 删除走的就是这条：被删的会话往往不是当前会话。
    // ⚠️ 必须用**同一个 hook 实例**来回切会话来验：cache 是 ref，
    //   unmount 之后就是新实例、空缓存（见 hook 里 cacheRef 的注释），
    //   跨实例断言证明不了任何事。
    const target = makeTarget();
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useSessionHistory(target, sid),
      { initialProps: { sid: 's-1' } },
    );
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));

    rerender({ sid: 's-2' });
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));

    // 当前会话是 s-2，但要清的是 s-1
    act(() => result.current.invalidate('s-1'));

    // 回 s-1：被标失效 → 重新拉
    rerender({ sid: 's-1' });
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(3));

    // 再回 s-2：它的缓存没被动过 → 命中缓存，不再请求
    rerender({ sid: 's-2' });
    await waitFor(() => expect(target.setMessages).toHaveBeenCalledTimes(4));
    expect(mockedList).toHaveBeenCalledTimes(3);
  });
});

/**
 * ⭐ 回归（用户报的 bug）：**绝不清掉「已经在飞的那一轮」。**
 *
 * sessionId 不一定挂载时就有 —— 懒建会话的对话，它的 sessionId 是在第一条消息
 * 发出去**之后**才落进 state 的。那一刻 effect 重跑、缓存未命中，于是去拉了一次
 * 历史；而这时 createRun 往往还没把用户消息落库，后端回的是**空数组**，
 * 紧跟着 `setMessages([])` 就把在飞的那一轮整个清掉：
 *   ① 刚发出去的用户消息从界面消失（事件流里没有快照，补不回来）；
 *   ② `agent.messages` 变空 → 空对话的问候语又冒回来，和 loading 动画一起挂着。
 * 用户报的就是 ②。
 */
describe('⭐ 绝不清掉「已经在飞的那一轮」', () => {
  it('agent 里已经有消息：不拉历史、也不覆盖（新对话发第一条消息的场景）', () => {
    const target = makeTarget(['u-刚发的']);
    renderHook(() => useSessionHistory(target, 's-刚建的'));

    // 一条接口都不该打 —— 这个 sessionId 是刚诞生的，它的历史不在"灌历史"的意义里
    expect(mockedList).not.toHaveBeenCalled();
    expect(target.setMessages).not.toHaveBeenCalled();
  });

  it('agent 里已经有消息：status 清成 undefined，别留「正在加载对话记录…」', async () => {
    const target = makeTarget();
    // 停在 loading
    mockedList.mockReturnValue(new Promise(() => {}) as never);
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useSessionHistory(target, sid),
      { initialProps: { sid: 's-旧' } },
    );
    await waitFor(() => expect(result.current.status).toBe('loading'));

    // 用户在等历史的这段时间里发了消息（agent 非空），会话随后被重建 → id 变了
    target.messages.push({
      id: 'u-刚发的',
      role: 'user',
      content: '',
    } as Message);
    rerender({ sid: 's-新' });

    await waitFor(() => expect(result.current.status).toBeUndefined());
    expect(target.setMessages).not.toHaveBeenCalled();
  });

  it('拉到历史的那一刻 agent 已非空：缓存照存，但**不灌**（不清 agent）', async () => {
    let resolveHistory: (v: ReturnType<typeof page>) => void = () => {};
    mockedList.mockReturnValue(
      new Promise((r) => {
        resolveHistory = r;
      }) as never,
    );

    const target = makeTarget();
    const { rerender } = renderHook(
      ({ t }: { t: HistoryTarget }) => useSessionHistory(t, 's-1'),
      { initialProps: { t: target } },
    );
    await waitFor(() => expect(mockedList).toHaveBeenCalled());

    // 接口还没回来，人已经发出了这一轮
    target.messages.push({
      id: 'u-刚发的',
      role: 'user',
      content: '',
    } as Message);

    await act(async () => {
      resolveHistory(page(2));
    });

    // 没被清掉 —— 这是这条不变量本身
    expect(target.setMessages).not.toHaveBeenCalled();
    expect(target.messages.map((m) => m.id)).toEqual(['u-刚发的']);

    // 但历史**存进缓存**了：切走再切回（新 agent、agent 为空）直接用，不重拉
    const fresh = makeTarget();
    rerender({ t: fresh });

    await waitFor(() => expect(fresh.setMessages).toHaveBeenCalled());
    expect(fresh.calls[0]).toEqual(['m-1', 'm-2']);
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});

/**
 * 刷新（或切走再切回）之后"要不要把某次运行接回来"的判据。
 *
 * 这一组全是**边界**：判错的两种代价不对称 ——
 *   · 该接没接 → 用户看着一个永远不动的半截回答，还没法继续问（会话锁在 waiting_input）；
 *   · 不该接却接了 → 整段回答被重放一遍，界面上多出一条一模一样的（不报错、不白屏，
 *     只是内容重复，最容易被当成"后端发重了"）。
 */
describe('刷新后要不要续订（resumeCandidateOf）', () => {
  /** 造一条指定形状的后端消息（message() 只给默认值，这里按需覆盖）。 */
  const msg = (over: Partial<SessionMessage>): SessionMessage => ({
    ...message(1, '内容'),
    ...over,
  });

  const user = (seq: number, runId: string) =>
    msg({ seq, role: 'user', run_id: runId, status: 'completed' });
  const assistant = (
    seq: number,
    runId: string,
    status: SessionMessage['status'],
  ) => msg({ seq, role: 'assistant', run_id: runId, status });

  it('最后一条是用户消息 → 那一轮的答复还没落库，接回来（running）', () => {
    expect(resumeCandidateOf([user(1, 'r-a')])).toEqual({
      runId: 'r-a',
      kind: 'running',
    });
  });

  it('最后一条助手消息 interrupted → 停在人工审批，接回来', () => {
    expect(
      resumeCandidateOf([user(1, 'r-a'), assistant(2, 'r-a', 'interrupted')]),
    ).toEqual({ runId: 'r-a', kind: 'interrupted' });
  });

  it.each([
    'completed',
    'failed',
    'cancelled',
  ] as const)('最后一条助手消息是 %s → 这一轮已经了结，不接（重放只会多一条重复的）', (status) => {
    expect(
      resumeCandidateOf([user(1, 'r-a'), assistant(2, 'r-a', status)]),
    ).toBeUndefined();
  });

  it('认**最后**一轮：前面几轮了结了也算数', () => {
    expect(
      resumeCandidateOf([
        user(1, 'r-a'),
        assistant(2, 'r-a', 'completed'),
        user(3, 'r-b'),
      ]),
    ).toEqual({ runId: 'r-b', kind: 'running' });
  });

  it('同一次运行落了两条助手消息（答完审批后继续跑）：看最后那条，已了结就不接', () => {
    expect(
      resumeCandidateOf([
        user(1, 'r-a'),
        assistant(2, 'r-a', 'interrupted'),
        assistant(3, 'r-a', 'completed'),
      ]),
    ).toBeUndefined();
  });

  it('跳过没有 run_id 的消息，继续往前找', () => {
    expect(
      resumeCandidateOf([user(1, 'r-a'), msg({ seq: 2, run_id: null })]),
    ).toEqual({ runId: 'r-a', kind: 'running' });
  });

  it('一条都没有 / 全都没有 run_id → 不接', () => {
    expect(resumeCandidateOf([])).toBeUndefined();
    expect(resumeCandidateOf([msg({ seq: 1, run_id: null })])).toBeUndefined();
  });
});

describe('把续订候选交给上层', () => {
  const userMessage = (runId: string): SessionMessage => ({
    ...message(1, '问一句'),
    seq: 1,
    role: 'user',
    run_id: runId,
  });

  /** 停在人工审批上的助手消息 —— 这类才有 interrupted 候选。 */
  const interruptedReply = (runId: string): SessionMessage => ({
    ...message(2, '半截回答'),
    seq: 2,
    role: 'assistant',
    run_id: runId,
    status: 'interrupted',
  });

  /**
   * ⭐ 用户报的 bug（回归）：「打开新对话触发 interrupt，切到别的 session，
   * 页面上也显示待审批 confirm」。
   *
   * 成因就在这一帧：切会话时 `resumeCandidate` 这份 state 还留着**上一个会话**
   * 的值（effect 在渲染之后才跑），而新会话那一帧正是 RunResume 挂载、
   * 决定"要不要续订"的那一帧 —— 它会把 A 的 run 接到 B 的 agent 上，
   * 订阅之后重放的 hitl.requested 就让审批卡在 B 里冒出来了。
   *
   * ⚠️ 所以这里**不能**用 waitFor：B 的接口一返回，候选自然会被改掉，
   * waitFor 恰好把出事的那一帧盖过去（现有那条"缓存命中"用例就是这么写的）。
   * 必须卡住 B 的接口，直接断言"切走这一帧"的值。
   */
  it('⭐ 切走的那一帧就不能再交出上一个会话的候选（否则 B 会冒出 A 的审批卡）', async () => {
    mockedList.mockResolvedValueOnce({
      ...page(0),
      messages: [userMessage('r-9'), interruptedReply('r-9')],
    } as never);

    const first = makeTarget();
    const { result, rerender } = renderHook(
      ({ t, sid }: { t: HistoryTarget; sid: string }) =>
        useSessionHistory(t, sid),
      { initialProps: { t: first, sid: 's-1' } },
    );
    await waitFor(() =>
      expect(result.current.resumeCandidate).toEqual({
        runId: 'r-9',
        kind: 'interrupted',
      }),
    );

    // 切到 s-2，而它的历史**还在路上**（真实里这一页要等一会儿才到）
    let resolveB: (value: unknown) => void = () => {};
    mockedList.mockReturnValue(
      new Promise((resolve) => {
        resolveB = resolve;
      }) as never,
    );
    const second = makeTarget();
    rerender({ t: second, sid: 's-2' });

    expect(result.current.resumeCandidate).toBeUndefined();

    await act(async () => {
      resolveB(page(2));
    });
    expect(result.current.resumeCandidate).toBeUndefined();
  });

  it('拉到历史后交出候选（这次运行还没跑完）', async () => {
    mockedList.mockResolvedValue({
      ...page(0),
      messages: [userMessage('r-9')],
    } as never);

    const target = makeTarget();
    const { result } = renderHook(() => useSessionHistory(target, 's-1'));

    await waitFor(() =>
      expect(result.current.resumeCandidate).toEqual({
        runId: 'r-9',
        kind: 'running',
      }),
    );
  });

  it('历史都是已了结的 → 没有候选', async () => {
    const target = makeTarget();
    const { result } = renderHook(() => useSessionHistory(target, 's-1'));

    await waitFor(() => expect(result.current.status).toBeUndefined());
    expect(result.current.resumeCandidate).toBeUndefined();
  });

  it('缓存命中那条路（切走再切回）也要给候选 —— 不重拉接口也能答', async () => {
    mockedList.mockResolvedValue({
      ...page(0),
      messages: [userMessage('r-9')],
    } as never);

    const first = makeTarget();
    const { result, rerender } = renderHook(
      ({ t, sid }: { t: HistoryTarget; sid: string }) =>
        useSessionHistory(t, sid),
      { initialProps: { t: first, sid: 's-1' } },
    );
    await waitFor(() => expect(first.setMessages).toHaveBeenCalled());

    // 先切到另一个会话：它那一页历史都是已了结的 → 候选必须跟着清掉
    // （否则会把上一个会话的运行接到这个会话上）
    mockedList.mockResolvedValue(page(2) as never);
    const middle = makeTarget();
    rerender({ t: middle, sid: 's-2' });
    await waitFor(() => expect(result.current.resumeCandidate).toBeUndefined());

    // 再切回 s-1：走**缓存**（不重拉），候选要原样回来
    const back = makeTarget();
    rerender({ t: back, sid: 's-1' });
    await waitFor(() =>
      expect(result.current.resumeCandidate).toEqual({
        runId: 'r-9',
        kind: 'running',
      }),
    );
    expect(back.setMessages).toHaveBeenCalled();
    expect(mockedList).toHaveBeenCalledTimes(2);
  });
});
