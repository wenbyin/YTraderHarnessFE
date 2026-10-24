// src/components/CopilotDock/toolActivity.test.tsx
//
// 工具调用那条平行通道（useToolActivity + LiveActivityOverlay）。
//
// 为什么单独测
// ----------
//   工具事件**不进 messages**（见 runEventStream.ts 的文件头），所以
//   DockRenderMessage / history 那些测试一条都扫不到它。而它会错得很安静：
//     · 「正在调用工具」转不停（end 没配上对）；
//     · 跑完的工具不出现（记录没攒下来）；
//     · 或者**一次调用长出两行** —— 后端历史上有两条发布通道（custom 带
//       tool_key 与真 id；langgraph tools 通道带函数名与假 id），
//       只按 id 去重合不起来。用户看到的就是"每个工具都调了两次"。
//
// agent 是假的：这条通道的入口只有 `subscribe({ onCustomEvent,
// onRunStartedEvent })` 两个回调，手动触发就够了（同 hiddenWork.test.tsx）。

import type { AbstractAgent } from '@ag-ui/client';
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import LiveActivityOverlay, { TOOL_RUNNING_LABEL } from './LiveActivityOverlay';
import { TOOL_ACTIVITY_CUSTOM_EVENT } from './runEventStream';
import { type LiveToolActivity, useToolActivity } from './useToolActivity';

type Emit = (value: unknown) => void;

/** 假 agent：只留这条通道用到的两个口。 */
function stubAgent(): AbstractAgent & {
  emit: Emit;
  runStarted: (runId?: string) => void;
} {
  let onCustom:
    | ((params: { event: { name: string; value: unknown } }) => void)
    | null = null;
  let onStarted: ((params: { event: { runId?: unknown } }) => void) | null =
    null;

  // ⚠️ 包 `act`：这些 setState 不在 React 的事件处理器里，不包的话
  //    断言读到的还是上一帧的值（同 hiddenWork.test.tsx 的说明）。
  const emit: Emit = (value) => {
    act(() => {
      onCustom?.({ event: { name: TOOL_ACTIVITY_CUSTOM_EVENT, value } });
    });
  };

  const agent = {
    subscribe: (params: {
      onCustomEvent?: (p: { event: { name: string; value: unknown } }) => void;
      onRunStartedEvent?: (p: { event: { runId?: unknown } }) => void;
    }) => {
      onCustom = params.onCustomEvent ?? null;
      onStarted = (p) => params.onRunStartedEvent?.(p);
      return { unsubscribe: () => {} };
    },
  } as unknown as AbstractAgent;

  return Object.assign(agent, {
    emit,
    runStarted: (runId?: string) =>
      act(() => onStarted?.({ event: { runId } })),
  });
}

const start = (callId: string, name: string) => ({
  phase: 'start',
  callId,
  name,
});
const end = (callId: string, name: string, error?: string) => ({
  phase: 'end',
  callId,
  name,
  ...(error ? { error } : {}),
});

/** 把 hook 的返回值挂出来读（hook 只能在组件里调）。 */
function harness() {
  const agent = stubAgent();
  let latest: LiveToolActivity = { running: 0, items: [] };
  const current = () => latest;

  const Probe: React.FC = () => {
    latest = useToolActivity(agent);
    return null;
  };
  render(<Probe />);

  return { agent, current };
}

/** 只取"界面上会写出来的那两样" —— key 是内部配对用的，断言时不必啰嗦。 */
const shape = (h: ReturnType<typeof harness>) =>
  h.current().items.map((item) => `${item.name}:${item.status}`);

describe('useToolActivity：一次调用一行，状态跟着事件走', () => {
  it('⭐ called 就把行放出来（转圈），不是等跑完才出现', () => {
    const h = harness();
    h.agent.emit(start('c1', 'agent.current_time'));

    expect(h.current().running).toBe(1);
    expect(shape(h)).toEqual(['agent.current_time:running']);
  });

  it('completed → 勾；带 error → 叉', () => {
    const h = harness();
    h.agent.emit(start('c1', 'web.search'));
    h.agent.emit(end('c1', 'web.search'));
    expect(shape(h)).toEqual(['web.search:done']);

    h.agent.emit(start('c2', 'agent.http'));
    h.agent.emit(end('c2', 'agent.http', 'TimeoutError: 30s'));
    expect(shape(h)).toEqual(['web.search:done', 'agent.http:error']);
    expect(h.current().items[1].error).toBe('TimeoutError: 30s');
    expect(h.current().running).toBe(0);
  });

  it('⭐ 并行调用按 tool_call_id 配对（交错到达也不会多转一个）', () => {
    const h = harness();
    h.agent.emit(start('a', 'tool.a'));
    h.agent.emit(start('b', 'tool.b'));

    // b 先回来 —— 只有靠 id 才知道该消哪一个
    h.agent.emit(end('b', 'tool.b'));
    expect(h.current().running).toBe(1);

    h.agent.emit(end('a', 'tool.a'));
    expect(h.current().running).toBe(0);
    // 顺序 = **调用开始**的顺序（不是完成顺序）：界面按用户看到的先后排列
    expect(shape(h)).toEqual(['tool.a:done', 'tool.b:done']);
  });

  it('⚠️ 同一个 callId 的 completed 来两次：更新那一行，不追加第二条', () => {
    const h = harness();
    h.agent.emit(start('c1', 'tool.a'));
    h.agent.emit(end('c1', 'tool.a'));
    h.agent.emit(end('c1', 'tool.a'));

    expect(h.current().items).toHaveLength(1);
    expect(h.current().running).toBe(0);
  });

  it('⚠️⚠️ 两条通道报同一次调用（id 不同、名字一个点分一个短名）→ 只有一行', () => {
    const h = harness();

    // custom 通道：真 id + tool_key
    h.agent.emit(start('call_00_zm8', 'agent.current_time'));
    // tools 通道：假 id（UUID）+ 函数名 —— 同一次调用的另一种写法
    h.agent.emit(start('8f1c2a44-0000-4000-8000-000000000000', 'current_time'));

    expect(h.current().items).toHaveLength(1);
    // 留下的是**更具体的**那个名字（点分 tool_key）
    expect(shape(h)).toEqual(['agent.current_time:running']);

    // 完成也是两条，仍然一行
    h.agent.emit(end('call_00_zm8', 'agent.current_time'));
    h.agent.emit(end('8f1c2a44-0000-4000-8000-000000000000', 'current_time'));

    expect(h.current().items).toHaveLength(1);
    expect(shape(h)).toEqual(['agent.current_time:done']);
  });

  it('⚠️ 但不同命名空间里的同名工具**不许**合并（那会吞掉一次真调用）', () => {
    const h = harness();
    h.agent.emit(start('a', 'web.search'));
    h.agent.emit(start('b', 'doc.search'));

    expect(shape(h)).toEqual(['web.search:running', 'doc.search:running']);
  });

  it('⚠️ 拿不到 tool_call_id 时按顺序配对（串行场景不会卡住）', () => {
    const h = harness();
    h.agent.emit(start('', 'tool.a'));
    h.agent.emit(end('', 'tool.a'));

    expect(h.current().running).toBe(0);
    expect(shape(h)).toEqual(['tool.a:done']);
  });

  it('串行两次调同一个工具（无 id）→ 两行，不并成一次', () => {
    const h = harness();
    h.agent.emit(start('', 'tool.a'));
    h.agent.emit(end('', 'tool.a'));
    h.agent.emit(start('', 'tool.a'));
    h.agent.emit(end('', 'tool.a'));

    expect(h.current().items).toHaveLength(2);
    expect(h.current().running).toBe(0);
  });

  it('没有 start 的 end（续订中途接上）也照样记一行', () => {
    const h = harness();
    h.agent.emit(end('c9', 'tool.z'));

    expect(h.current().running).toBe(0);
    expect(shape(h)).toEqual(['tool.z:done']);
  });

  it('迟到的 start 不会把已经跑完的行退回转圈', () => {
    const h = harness();
    h.agent.emit(start('c1', 'tool.a'));
    h.agent.emit(end('c1', 'tool.a'));
    h.agent.emit(start('c1', 'tool.a'));

    expect(shape(h)).toEqual(['tool.a:done']);
    expect(h.current().running).toBe(0);
  });

  it('新一轮（**不同的** runId）开始就清空上一轮的记录', () => {
    const h = harness();
    h.agent.runStarted('run-1');
    h.agent.emit(start('c1', 'tool.a'));
    h.agent.emit(end('c1', 'tool.a'));
    expect(h.current().items).toHaveLength(1);

    h.agent.runStarted('run-2');
    expect(h.current()).toEqual({ running: 0, items: [] });
  });

  it('⭐ 同一个 runId 再开始**不清**（HITL 恢复是第二次 run，前面的工具记录不能丢）', () => {
    const h = harness();
    h.agent.runStarted('run-1');
    h.agent.emit(start('c1', 'tool.a'));
    h.agent.emit(end('c1', 'tool.a'));

    // 审批恢复：CopilotKit 复用同一个 runId —— 清了的话审批之前
    // 调过的工具会从界面上整批消失（用户报的"卡片被合并"）。
    h.agent.runStarted('run-1');
    expect(shape(h)).toEqual(['tool.a:done']);
  });

  it('形状不对的自定义事件一律忽略（不抛）', () => {
    const h = harness();
    h.agent.emit(null);
    h.agent.emit({ phase: 'middle' });
    expect(h.current()).toEqual({ running: 0, items: [] });
  });
});

describe('LiveActivityOverlay：一行 loading 胶囊', () => {
  it('⭐ 有工具在跑时只显示「正在调用工具」，**不说工具名**', () => {
    render(
      <LiveActivityOverlay work={null} tools={{ running: 1, items: [] }} />,
    );

    const chip = screen.getByRole('status');
    expect(chip.textContent).toContain(TOOL_RUNNING_LABEL);
    // 需求原话："不用说是什么工具" —— 名字一个字都不该出现在这行里
    expect(chip.textContent).not.toContain('tool.a');
  });

  it('⭐ 胶囊与输入框同一左边缘（2026-10-21：不再让开正文那条 56px 的线）', () => {
    const { container } = render(
      <LiveActivityOverlay
        work={{ node: 'tools', role: null, depth: 1 }}
        tools={{ running: 0, items: [] }}
      />,
    );

    const layer = container.querySelector(
      '[data-live-activity-layer]',
    ) as HTMLElement;
    expect(layer).not.toBeNull();

    /*
     * 输 入 框（.copilotKitInput）的左右外边距是 token.padding = 16 ——
     * 胶囊要跟它对齐，就得用同一个 16，而不是原来那个"正文左线"56。
     * 这里读**计算值**：改数字时样式表一注入就能抓到，不必依赖截图。
     */
    const style = getComputedStyle(layer);
    expect(style.paddingLeft).toBe('16px');
    expect(style.paddingRight).toBe('16px');
  });

  it('⭐ 工具记录**不再**画在浮层里（改由消息流画在正文上方）', () => {
    const { container } = render(
      <LiveActivityOverlay
        work={null}
        tools={{
          running: 0,
          items: [{ key: 'c1', name: 'tool.a', status: 'done' }],
        }}
      />,
    );

    /*
     * 浮层只剩胶囊。工具记录搬到消息流里了（见 liveToolFeed.ts）：
     * 它原先贴输入框上沿、永远落在正文**下方**，而真实顺序是先工具后回答 ——
     * 用户的原话是"工具调用跑正文下方去了"。
     *
     * 这条断言是"搬走了"这件事的钉子：浮层里再冒出工具行就说明有人把它加回来了。
     */
    // ⚠️ 按**卡片**判，不按那句前缀：前缀文案随状态变（正在调用 / 调用成功…），
    //    用文字当锚点会在改文案时变成一条永远通过的摆设。
    expect(container.querySelector('[data-kind="tool_activity"]')).toBeNull();
    // 只在跑的时候才有胶囊；跑完了这一层就不该存在
    expect(container.querySelector('[data-live-activity-layer]')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('工具在跑时**压掉**节点那侧的「正在执行工具」（同一件事不说两遍）', () => {
    render(
      <LiveActivityOverlay
        work={{ node: 'tools', role: null, depth: 1 }}
        tools={{ running: 1, items: [] }}
      />,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain(
      TOOL_RUNNING_LABEL,
    );
  });

  it('什么都没有时整层不渲染（别留一个空壳盖住消息）', () => {
    const { container } = render(
      <LiveActivityOverlay work={null} tools={{ running: 0, items: [] }} />,
    );
    expect(container.querySelector('[data-live-activity-layer]')).toBeNull();
  });
});
