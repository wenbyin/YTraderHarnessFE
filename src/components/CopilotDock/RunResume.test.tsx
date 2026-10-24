// src/components/CopilotDock/RunResume.test.tsx
//
// RunResume 只做一件事：**在打开会话、历史到手之后，把没跑完的那次运行接回来**。
// 所以这里断言的就是那三行：
//   · 有候选 → 先 `agent.attachRun(runId)`、再 `copilotkit.runAgent({ agent })`
//     （顺序不能反 —— 反了 agent 就不知道这一轮是去续订）；
//   · 没有候选 → 什么都不做（不能"总是续订"：重放会让回答多出一条）；
//   · 只做一次（history 每更新一次都会给个新对象，ref 要兜住）。
//
// ⚠️ 用真的组件 + mock 掉的 `useCopilotKit`：真的那个读不到
//   CopilotKitProvider 会直接抛错（这里没有 provider），而抛错会被
//   ErrorBoundary 吞成一片空白 —— 那样测的就不是这个组件了。
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockAgent } from './agent';
import RunResume from './RunResume';
import type { ResumeCandidate } from './useSessionHistory';

const runtime = vi.hoisted(() => ({
  /** CopilotKit v2 的 runAgent 桩 —— 真的那个会去打网络，这里只关心"调没调"。 */
  runAgent: vi.fn(async () => ({})),
}));

vi.mock('@copilotkit/react-core/v2/headless', () => ({
  useCopilotKit: () => ({ copilotkit: { runAgent: runtime.runAgent } }),
}));

afterEach(cleanup);

beforeEach(() => {
  runtime.runAgent.mockReset();
  runtime.runAgent.mockResolvedValue({});
});

/** 假 agent：RunResume 只用到 attachRun / clearAttach 这两个能力。 */
const makeAgent = () => {
  const attachRun = vi.fn();
  const clearAttach = vi.fn();
  return {
    agent: { attachRun, clearAttach } as unknown as DockAgent,
    attachRun,
    clearAttach,
  };
};

const RUNNING: ResumeCandidate = { runId: 'run-9', kind: 'running' };

describe('RunResume', () => {
  it('有候选：先声明续订意图，再让 agent 跑一次', () => {
    const { agent, attachRun } = makeAgent();
    render(<RunResume agent={agent} candidate={RUNNING} />);

    expect(attachRun).toHaveBeenCalledWith('run-9');
    expect(runtime.runAgent).toHaveBeenCalledWith({ agent });

    // 顺序：attachRun 必须在 runAgent 之前 —— run() 会在同步段把标记读走，
    // 反了就是"没带上意图就跑了"，那会变成**建一次新运行**（把旧消息又提交一遍）。
    const attachOrder = attachRun.mock.invocationCallOrder[0];
    const runOrder = runtime.runAgent.mock.invocationCallOrder[0];
    expect(attachOrder).toBeLessThan(runOrder);
  });

  it('没有候选：什么都不做（这个会话没有没跑完的运行）', () => {
    const { agent, attachRun } = makeAgent();
    render(<RunResume agent={agent} candidate={undefined} />);

    expect(attachRun).not.toHaveBeenCalled();
    expect(runtime.runAgent).not.toHaveBeenCalled();
  });

  it('候选对象换了新引用也只跑一次（history 每次更新都会造新对象）', () => {
    const { agent } = makeAgent();
    const { rerender } = render(
      <RunResume agent={agent} candidate={RUNNING} />,
    );

    rerender(
      <RunResume
        agent={agent}
        candidate={{ runId: 'run-9', kind: 'running' }}
      />,
    );
    rerender(
      <RunResume
        agent={agent}
        candidate={{ runId: 'run-9', kind: 'interrupted' }}
      />,
    );

    expect(runtime.runAgent).toHaveBeenCalledTimes(1);
  });

  it('agent 换实例（切会话）也不重复续订这个会话', () => {
    const first = makeAgent();
    const { rerender } = render(
      <RunResume agent={first.agent} candidate={RUNNING} />,
    );

    const second = makeAgent();
    rerender(<RunResume agent={second.agent} candidate={RUNNING} />);

    expect(first.attachRun).toHaveBeenCalledTimes(1);
    expect(second.attachRun).not.toHaveBeenCalled();
    expect(runtime.runAgent).toHaveBeenCalledTimes(1);
  });

  it('runAgent 失败不往外冒（原因由 agent.run 的管道写进对话里）', async () => {
    runtime.runAgent.mockRejectedValueOnce(new Error('运行不存在'));
    const { agent, attachRun, clearAttach } = makeAgent();

    expect(() =>
      render(<RunResume agent={agent} candidate={RUNNING} />),
    ).not.toThrow();

    // 让那个被吞掉的 rejection 有机会冒出来（有 unhandled rejection 的话这里会红）
    await Promise.resolve();
    await Promise.resolve();
    expect(attachRun).toHaveBeenCalledWith('run-9');
    // 落定之后必须清标记 —— 否则它会在用户下一次发言时劫持那一轮
    expect(clearAttach).toHaveBeenCalled();
  });

  it('⭐ runAgent **同步抛**（已有运行在跑）：标记也要当场清掉', () => {
    runtime.runAgent.mockImplementationOnce(() => {
      throw new Error('A run is already in progress');
    });
    const { agent, attachRun, clearAttach } = makeAgent();

    expect(() =>
      render(<RunResume agent={agent} candidate={RUNNING} />),
    ).not.toThrow();

    expect(attachRun).toHaveBeenCalledWith('run-9');
    // 关键一条：没清的话，用户下一条消息会被当成"续订 run-9"而根本发不出去
    expect(clearAttach).toHaveBeenCalled();
  });

  it('正常跑完也会清（消费过就是空操作，不清也不该报错）', async () => {
    const { agent, clearAttach } = makeAgent();
    render(<RunResume agent={agent} candidate={RUNNING} />);

    await Promise.resolve();
    await Promise.resolve();
    expect(clearAttach).toHaveBeenCalled();
  });
});
