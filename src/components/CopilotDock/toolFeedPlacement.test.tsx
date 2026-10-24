// src/components/CopilotDock/toolFeedPlacement.test.tsx
//
// 「这一轮的工具记录画在哪」—— 一个纯位置问题，但错了很明显。
//
// 两个阶段（都是用户实报，别把结论记反）：
//   · 原先是贴输入框上沿的浮层（LiveActivityOverlay），位置**恒在正文下方**：
//     模型还在流式写、工具已经跑完时，那几行挂在正文末尾 ——
//     「工具调用跑正文下方去了」；
//   · 之后改成 DockRenderMessage 画在**最后一条正文上方**（先工具后回答）。
//
// 2026-10-20 起第三条路，也是现在的口径：
//   **工具行属于"那一步"**，跟着它所属的消息一起渲染成一个 section，顺序
//   深度思考 → 正文 → 工具框。刷新之后历史里的 `tool_activity` 本来就是
//   独立消息、天然落在正确的步之间；实时这一侧靠 `messageId` 归位
//   （见 ToolActivityPayload.messageId），于是两边终于长得一样。
//
// ⚠️ 因此"画在最后一条正文上方"这批断言全部作废 —— 它编码的是上一版行为。
import type { Message } from '@ag-ui/client';
import { act, render } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ 库的两个消息组件在测试里没有 provider（会去 useChatContext 取 labels/icons）。
//    这里只替身**外观**，被测的是"工具行插在哪"，与外观无关。
vi.mock('@copilotkit/react-ui', () => ({
  AssistantMessage: ({ message }: { message?: { id?: string } }) => (
    <div data-testid="assistant-row">
      <div data-testid="assistant">{message?.id}</div>
    </div>
  ),
  UserMessage: ({ message }: { message?: { id?: string } }) => (
    <div data-testid="user">{message?.id}</div>
  ),
  // 任务行的正文（见 DockRenderMessage 的 taskRow 分支）。
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="task-markdown">{content}</div>
  ),
  ImageRenderer: () => null,
}));

import DockRenderMessage from './DockRenderMessage';
import { noteLiveTask, resetLiveTasks } from './liveTaskFeed';
import { resetLiveToolItems, setLiveToolItems } from './liveToolFeed';

const msg = (role: Message['role'], id: string, content = '正文') =>
  ({ id, role, content }) as unknown as Message;

const user = (id: string) => msg('user', id);
const assistant = (id: string) => msg('assistant', id);

/** 把整串消息按 CopilotChat 的方式逐个交给 DockRenderMessage。 */
function renderThread(messages: Message[], inProgress = false) {
  return render(
    messages.map((message, index) => (
      <DockRenderMessage
        key={message.id}
        message={message}
        messages={messages}
        inProgress={inProgress}
        index={index}
        isCurrentMessage
      />
    )),
  );
}

/** DOM 里的先后顺序：工具记录用 `tool:`、助手消息外壳用 `msg:`。 */
function order(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll(
      '[data-kind="tool_activity"], [data-testid="assistant-row"]',
    ),
  ).map((el) => {
    if (el.getAttribute('data-kind') === 'tool_activity') {
      return `tool:${el.textContent ?? ''}`;
    }
    const inner = el.querySelector('[data-testid="assistant"]');
    return `msg:${inner?.textContent ?? ''}`;
  });
}

describe('DockRenderMessage：工具行跟着它那一步走', () => {
  beforeEach(() => {
    resetLiveToolItems();
    resetLiveTasks();
  });

  it('⭐ 工具行排在**自己那一步**的正文后面（section 内顺序：正文 → 工具框）', () => {
    setLiveToolItems([
      { key: 'c1', name: 'mock.calc', status: 'done', messageId: 'a1' },
    ]);

    const { container } = renderThread([user('u1'), assistant('a1')]);

    expect(order(container)).toEqual(['msg:a1', 'tool:mock.calc']);
  });

  it('⭐⭐ 两条助手消息各有各的工具：各自落在自己的 section 里，不串位', () => {
    setLiveToolItems([
      { key: 'c1', name: 'mock.calc', status: 'done', messageId: 'a1' },
      { key: 'c2', name: 'calc', status: 'done', messageId: 'a2' },
    ]);

    const { container } = renderThread([
      user('u1'),
      assistant('a1'),
      assistant('a2'),
    ]);

    // a1 → 它的工具；a2 → 它的工具。上一版是"两条都堆在 a2 前面"。
    expect(order(container)).toEqual([
      'msg:a1',
      'tool:mock.calc',
      'msg:a2',
      'tool:calc',
    ]);
  });

  it('⭐ 一步里并行两个工具：都归在那一步、各占一行', () => {
    setLiveToolItems([
      { key: 'c1', name: 'a.read', status: 'done', messageId: 'a1' },
      { key: 'c2', name: 'b.write', status: 'done', messageId: 'a1' },
    ]);

    const { container } = renderThread([user('u1'), assistant('a1')]);

    expect(order(container)).toEqual(['msg:a1', 'tool:a.read', 'tool:b.write']);
  });

  it('⭐ 挂不到任何消息上的（messageId 空）兜底落在**本轮第一条**、画在它上方', () => {
    setLiveToolItems([
      {
        key: 'c1',
        name: 'agent.enter_plan_mode',
        status: 'done',
        messageId: '',
      },
    ]);

    const { container } = renderThread([
      user('u1'),
      assistant('a1'),
      assistant('a2'),
    ]);

    // ⚠️ 2026-10-22 改口径：原来挂在最后一条 —— 那会**往下漂**（后续消息越多
    //    它越靠后，用户看到的正是"本来在最上面，结果跑到 task_1 正文下方"），
    //    还会把它所挂那条消息的任务轨道一起拖到末尾。现在锚在本轮第一条、
    //    画在它上方，位置就固定了。
    expect(order(container)).toEqual([
      'tool:agent.enter_plan_mode',
      'msg:a1',
      'msg:a2',
    ]);
  });

  it('没有工具记录时一个节点都不多（历史消息不该长出一条空行）', () => {
    const { container } = renderThread([user('u1'), assistant('a1')]);

    expect(container.querySelector('[data-kind="tool_activity"]')).toBeNull();
  });

  it('记录清空后（新一轮开始）工具行立刻消失', () => {
    setLiveToolItems([
      { key: 'c1', name: 'mock.calc', status: 'done', messageId: 'a1' },
    ]);

    const { container, rerender } = renderThread([user('u1'), assistant('a1')]);
    expect(
      container.querySelector('[data-kind="tool_activity"]'),
    ).not.toBeNull();

    act(() => {
      setLiveToolItems([]);
    });
    rerender(
      <DockRenderMessage
        message={assistant('a1')}
        messages={[user('u1'), assistant('a1')]}
        inProgress={false}
        index={1}
        isCurrentMessage
      />,
    );

    expect(container.querySelector('[data-kind="tool_activity"]')).toBeNull();
  });

  it('⚠️ 兜底只出现一次：中途的助手消息不会把别人的工具复读一遍', () => {
    setLiveToolItems([
      { key: 'c1', name: 'mock.calc', status: 'done', messageId: '' },
    ]);

    const { container } = renderThread([
      user('u1'),
      assistant('a1'),
      assistant('a2'),
    ]);

    // 只渲染了一遍 —— 两条消息各挂一次的话这里会是 2。
    // ⚠️ 数**卡片**而不是数文字：行内的字现在是翻过的人话名（2026-10-23 起
    //    连状态词都不印了），拿文字当锚点等于让断言追着文案与词典跑。
    expect(
      container.querySelectorAll('[data-kind="tool_activity"]'),
    ).toHaveLength(1);
  });

  it('★ 兜底卡片**不带任务轨道**（它发生在任务之前，接上去线会从半截开始）', () => {
    setLiveToolItems([
      {
        key: 'c1',
        name: 'agent.enter_plan_mode',
        status: 'done',
        messageId: '',
      },
    ]);

    // a1 落在任务 t1 里（实时标记）—— 孤儿卡片挂在它上方。
    noteLiveTask('a1', { taskId: 't1', title: '取数', planId: 'p1' });
    const { container } = renderThread([user('u1'), assistant('a1')]);

    const orphan = container.querySelector('[data-kind="tool_activity"]')
      ?.parentElement as HTMLElement;
    expect(orphan.hasAttribute('data-task-id')).toBe(false);
    expect(orphan.querySelector('[data-task-rail]')).toBeNull();

    // 任务自己的节点仍然在 a1 那一行上（没被孤儿卡片顶掉、也没被复制一份）
    expect(container.querySelectorAll('[data-task-node]')).toHaveLength(1);
    expect(
      container
        .querySelector('[data-task-node]')
        ?.closest('[data-section-view]')
        ?.hasAttribute('data-task-id'),
    ).toBe(true);
  });
});
