// src/components/CopilotDock/DockRenderMessage.test.tsx
//
// 谁来当"最后一条 AIMessage"—— 也就是**反馈图标行最终挂在哪条消息下面**。
//
// 这是本次需求的核心行为，而且它错了不会报错：反馈按钮会安静地挂到过程消息上，
// 或者一条都不挂。所以用真组件渲染一遍，把"哪几条被判定为当前消息"钉住。
//
// ⚠️ 为什么要把库 mock 成一个把 isCurrentMessage 写进 DOM 的桩
// ---------------------------------------------------------
//   真的 AssistantMessage 会去 useChatContext 取 labels / icons，在测试里没有
//   provider 会抛错；而我们要断言的恰恰只有一个值 —— isCurrentMessage。
//   桩把它暴露成 data-current，既能断言，又不引入 context 依赖。
//   另外两个（UserMessage / ImageRenderer）必须一起给：vitest 的 mock 是个 Proxy，
//   访问缺失导出会直接抛「No "UserMessage" export is defined」，报的错与真实原因无关。
//
// ⚠️⚠️ `subComponent` 那一格**必须照抄库的优先级**
// -------------------------------------------------
//   库的原文是：
//       const subComponent = message?.generativeUI?.() ?? props.subComponent;
//   桩最初写成"直接渲染 props.subComponent"，于是**把库最关键的一条行为
//   测没了** —— 而推理折叠行被顶掉那个 bug（用户报"没有看到思考折叠按钮"）
//   正好出在这条 `??` 上：CopilotKit 给每条助手消息都挂了 `generativeUI`
//   （coagent bridge，本面板下渲染 null），左边一有值就把我们的节点丢掉。
//   桩照抄这条规则之后，"折叠行还在不在"才真的被测到。
//   教训：替身可以简化**外观**，但**不能简化被测的那条交互**。
import type { Message } from '@ag-ui/client';
import type { RenderMessageProps } from '@copilotkit/react-ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@copilotkit/react-ui', () => ({
  AssistantMessage: ({
    isCurrentMessage,
    isLoading,
    message,
    subComponent,
  }: {
    isCurrentMessage?: boolean;
    isLoading?: boolean;
    message?: {
      id?: string;
      generativeUIPosition?: string;
      generativeUI?: () => React.ReactNode;
    };
    subComponent?: React.ReactNode;
  }) => (
    // ⚠️ subComponent 渲染在气泡**外面**（同级、在它前面）—— 库里 'before'
    //    就是这个位置。放在里面会污染既有用例对 assistant 文本内容的断言。
    <div data-testid="assistant-row">
      <div data-testid="assistant-sub">
        {/* 照抄库：message.generativeUI?.() ?? props.subComponent */}
        {message?.generativeUI?.() ?? subComponent}
      </div>
      <div
        data-testid="assistant"
        data-current={String(!!isCurrentMessage)}
        data-position={message?.generativeUIPosition ?? 'after'}
        /* 库在 isLoading 时会画"气泡下方那组小圆点"（copilot-loading-cursor）——
           这里把它暴露出来，好钉住"不许同时出现两个 loading"。 */
        data-loading={String(!!isLoading)}
      >
        {message?.id}
      </div>
    </div>
  ),
  UserMessage: ({ message }: { message?: { id?: string } }) => (
    <div data-testid="user">{message?.id}</div>
  ),
  // 任务行（task_instruction / task_result）的正文用库的 Markdown 渲染。
  // ⚠️ 这里必须给：DockRenderMessage 会 import 它，vitest 的 mock 是个 Proxy，
  //    访问缺失导出会直接抛「No "Markdown" export is defined」。
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="task-markdown">{content}</div>
  ),
  ImageRenderer: () => null,
}));

import DockRenderMessage from './DockRenderMessage';
import { noteLiveTask, resetLiveTasks } from './liveTaskFeed';
import { applyReasoning, resetReasoning } from './reasoningStream';

/** 只填渲染真正读的字段。 */
const msg = (role: Message['role'], id: string) =>
  ({ id, role, content: '正文' }) as unknown as Message;

const user = (id: string) => msg('user', id);
const assistant = (id: string) => msg('assistant', id);
const tool = (id: string) => msg('tool', id);

/**
 * 把整串消息按 CopilotChat 的方式逐个交给 DockRenderMessage。
 *
 * ⚠️ 传进去的 `isCurrentMessage` 一律是 **true**：库真实传的是
 *    "index === messages.length - 1"，这里故意给一个**全 true** 的值 ——
 *    只要还有任何一条被渲染成非当前，就证明组件确实**无视了库的值**、
 *    用的是自己算的那条规则。
 */
function renderThread(messages: Message[]) {
  return render(
    messages.map((message, index) => (
      <DockRenderMessage
        key={message.id}
        message={message}
        messages={messages}
        inProgress={false}
        index={index}
        isCurrentMessage
      />
    )),
  );
}

const currentFlags = () =>
  screen.getAllByTestId('assistant').map((el) => el.dataset.current);

describe('DockRenderMessage：只有最后一条 AIMessage 算"当前消息"', () => {
  it('⭐ 一次运行产出两条助手消息：只有后那条是当前（前那条是过程）', () => {
    renderThread([user('u1'), assistant('a1'), assistant('a2')]);

    // a1 = 过程（思考 + 工具调用那一类），a2 = 答案
    expect(currentFlags()).toEqual(['false', 'true']);
  });

  it('单条助手消息：它就是当前', () => {
    renderThread([user('u1'), assistant('a1')]);
    expect(currentFlags()).toEqual(['true']);
  });

  it('多轮对话：当前只落在最后一轮的那条', () => {
    renderThread([
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
    ]);
    expect(currentFlags()).toEqual(['false', 'false', 'true']);
  });

  it('⭐ 数组以工具结果结尾（后端将来会发 tool.*）：助手消息仍然是当前，不会整体消失', () => {
    renderThread([user('u1'), assistant('a1'), tool('t1')]);
    // 库那条"数组最后一个元素"会把当前给到 tool 消息上 → 这里会是空数组，
    // 反馈按钮整体消失。这一步就是防它。
    expect(currentFlags()).toEqual(['true']);
  });

  it('数组以用户消息结尾（刚发出、还没回）：最后那条助手消息仍是当前', () => {
    renderThread([user('u1'), assistant('a1'), user('u2')]);
    expect(currentFlags()).toEqual(['true']);
  });

  it('一条助手消息都没有：不渲染任何助手气泡（也就没有反馈行）', () => {
    renderThread([user('u1'), user('u2')]);
    expect(screen.queryAllByTestId('assistant')).toHaveLength(0);
  });

  it('用户消息照旧交给库的 UserMessage —— 接管渲染不能把用户气泡弄丢', () => {
    renderThread([user('u1'), assistant('a1')]);
    expect(screen.getByTestId('user')).toHaveTextContent('u1');
  });

  it('不支持的角色（tool）什么都不画', () => {
    renderThread([tool('t1')]);
    expect(screen.queryAllByTestId('assistant')).toHaveLength(0);
    expect(screen.queryAllByTestId('user')).toHaveLength(0);
  });
});

/**
 * 组件本身只做一件事，但"只做一件事"也要有证据：
 * 它必须把库传下来的 isCurrentMessage **丢掉**，换成自己算的。
 */
describe('DockRenderMessage：无视库传来的 isCurrentMessage', () => {
  it('⭐ 库传 true 但这条是过程消息时，渲染出来必须是 false', () => {
    const messages = [user('u1'), assistant('a1'), assistant('a2')];

    render(
      <DockRenderMessage
        message={messages[1] as Message}
        messages={messages}
        inProgress={false}
        index={1}
        isCurrentMessage // ← 库会传 true（它不是最后一个元素吗？不是，但假设是）
      />,
    );

    expect(currentFlags()).toEqual(['false']);
  });
});

/**
 * 工具活动记录（tool_activity）走的是**另一条渲染路**：
 * 它不能套助手消息的外壳 —— 那会让工具的原始输出以"模型说的话"的姿态出现。
 */
describe('DockRenderMessage：tool_activity 分流', () => {
  const toolActivityMsg = (
    id: string,
    view: { calls?: unknown[]; text?: string } = { calls: [], text: '' },
  ) =>
    ({
      id,
      role: 'assistant',
      content: '',
      metadata: { kind: 'tool_activity', toolActivity: view },
    }) as unknown as Message;

  it('⭐ kind 是 tool_activity -> 渲染成工具记录块，不套助手气泡', () => {
    renderThread([
      user('u1'),
      toolActivityMsg('ta1', {
        calls: [{ id: 'c1', name: 'agent.platform.list', args: { limit: 3 } }],
      }),
    ]);

    const row = document.querySelector('[data-kind="tool_activity"]');
    expect(row).not.toBeNull();
    // 只有名字 —— 参数不再展示（本次需求），所以这里是**全等**而不是 contains
    expect(row?.textContent).toBe('agent.platform.list');
    // 关键：**没有**走库的 AssistantMessage（否则会被加上头像行与反馈按钮）
    expect(screen.queryAllByTestId('assistant')).toHaveLength(0);
  });

  it('⭐ 工具结果那条（calls 为空）整行不渲染，也不退回助手气泡', () => {
    renderThread([
      user('u1'),
      toolActivityMsg('ta2', { calls: [], text: '{\n  "ok": true\n}' }),
    ]);

    // 结果内容不展示 → 这一条在界面上什么都不留（既不是工具行，也不是气泡）
    expect(document.querySelector('[data-kind="tool_activity"]')).toBeNull();
    expect(screen.queryAllByTestId('assistant')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('"ok"');
  });

  it('有 kind 但没有渲染原料时退回普通助手消息，而不是白屏', () => {
    renderThread([
      {
        id: 'odd',
        role: 'assistant',
        content: '正文',
        metadata: { kind: 'tool_activity' },
      } as unknown as Message,
    ]);

    // 宁可当成普通助手消息画出来，也不要因为"数据缺了一块"就什么都不显示
    expect(screen.queryAllByTestId('assistant')).toHaveLength(1);
    expect(document.querySelector('[data-kind="tool_activity"]')).toBeNull();
  });

  it('普通 chat 助手消息不受影响（没有 metadata 的实时消息也走这条路）', () => {
    renderThread([user('u1'), assistant('a1')]);
    expect(screen.queryAllByTestId('assistant')).toHaveLength(1);
    expect(document.querySelector('[data-kind="tool_activity"]')).toBeNull();
  });
});

/**
 * ⭐⭐ 一条消息 = 一张**正文卡** + 工具各一张**独立卡**（2026-10-21 改）。
 *
 * 需求原话（2026-10-20）：「sse事件渲染和message渲染必须保持一致……
 * 深度思考 → 正文 → tool 调用状态提示框」；2026-10-21 补了一句
 * 「工具调用卡片被合并了」。所以现在是：
 *
 *     深度思考 + 正文  -> 一张卡（section 里 R→B）
 *     工具调用         -> 每个调用**自己的一张卡**（独立的 tool section）
 *
 * ⚠️ 顺序仍是核心：正文在前、工具在后。上一版把工具行画进正文卡里，
 *    读起来就是"一张卡的两段" —— 历史里同一条 tool_activity 明明是
 *    一条独立消息。
 */
describe('DockRenderMessage：一条消息 = 正文卡 + 独立的工具卡', () => {
  /**
   * 整条消息画出来的**卡序列**（按 DOM 顺序）：
   *   · 独立工具卡 -> 'T'；独立问答卡 -> 'I'；
   *   · 正文卡 -> 卡内直接子节点的种类串（'R' 推理 / 'B' 正文）。
   */
  const layout = () =>
    Array.from(document.querySelectorAll('[data-section-view]')).map((el) => {
      const view = el.getAttribute('data-section-view');
      if (view === 'tool') return 'T';
      if (view === 'interaction') return 'I';
      return Array.from(el.children)
        .map((kid) => {
          if (kid.matches('[data-reasoning-block]')) return 'R';
          if (kid.matches('[data-testid="assistant-row"]')) return 'B';
          return '?';
        })
        .join('');
    });

  it('⭐⭐ 推理 + 正文一张卡（R→B），工具调用是紧随其后的独立卡（T）', () => {
    const message = {
      id: 'ta1',
      role: 'assistant',
      content: '我先查一下。',
      metadata: {
        kind: 'tool_activity',
        toolActivity: {
          calls: [{ id: 'c1', name: 'a.read', args: null }],
          text: '我先查一下。',
        },
        reasoning: '决定读一下',
      },
    } as unknown as Message;

    render(
      <DockRenderMessage
        message={message}
        messages={[user('u1'), message]}
        inProgress={false}
        index={1}
        isCurrentMessage
      />,
    );

    expect(layout()).toEqual(['RB', 'T']);
    expect(
      document.querySelector('[data-kind="tool_activity"]')?.textContent,
    ).toBe('a.read');
  });

  it('⭐ tool_activity 的正文（模型旁白）现在会画出来 —— 以前只有一行工具名', () => {
    const message = {
      id: 'ta1',
      role: 'assistant',
      content: '我先查一下。',
      metadata: {
        kind: 'tool_activity',
        toolActivity: {
          calls: [{ id: 'c1', name: 'a.read' }],
          text: '我先查一下。',
        },
      },
    } as unknown as Message;

    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    // 正文一张卡在上，工具一张卡在下 —— 旁白不再被丢掉
    expect(layout()).toEqual(['B', 'T']);
  });

  it('⭐ 工具结果那条（calls 为空）连正文都不画 —— 那段是工具产出，不是模型说的话', () => {
    const message = {
      id: 'ta2',
      role: 'assistant',
      content: '{"ok":true}',
      metadata: {
        kind: 'tool_activity',
        toolActivity: { calls: [], text: '{"ok":true}' },
      },
    } as unknown as Message;

    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    // 整条什么都不画（连 section 都不出现）：没有正文、没有工具行
    expect(document.querySelector('[data-section-view]')).toBeNull();
    expect(document.body.textContent).not.toContain('"ok"');
  });

  it('⭐⭐ interaction（HITL 问答）-> 我发出的消息卡片，问题与答案都在', () => {
    const message = {
      id: 'it1',
      role: 'user',
      content: '',
      metadata: {
        kind: 'interaction',
        interaction: {
          questions: [
            {
              question: '继续吗？',
              header: '确认',
              options: [],
              multiSelect: false,
            },
          ],
          answers: { '继续吗？': '继续' },
        },
      },
    } as unknown as Message;

    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    const card = document.querySelector('[data-kind="interaction"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('确认');
    expect(card?.textContent).toContain('继续吗？');
    expect(card?.textContent).toContain('继续');
    // 它是一条"我发的消息"，不是助手气泡
    expect(screen.queryAllByTestId('assistant')).toHaveLength(0);

    expect(
      document.querySelector('[data-kind="interaction"]')?.parentElement,
    ).toHaveAttribute('data-section-view', 'interaction');
  });

  it('跳过没答（answers 里没有这一题）-> 画「（未填写）」，不留白', () => {
    const message = {
      id: 'it2',
      role: 'user',
      content: '',
      metadata: {
        kind: 'interaction',
        interaction: {
          questions: [
            {
              question: '继续吗？',
              header: '',
              options: [],
              multiSelect: false,
            },
          ],
          answers: {},
        },
      },
    } as unknown as Message;

    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    expect(
      document.querySelector('[data-kind="interaction"]')?.textContent,
    ).toContain('（未填写）');
  });

  it('每条消息各自一个 section（两条助手消息就两个）', () => {
    renderThread([user('u1'), assistant('a1'), assistant('a2')]);
    expect(document.querySelectorAll('[data-section-view]')).toHaveLength(3);
  });
});

/**
 * props 与库的默认实现逐条对齐 —— 少传一个就是一段覆盖样式静默失效。
 * 这里只钉最容易漏、且漏了看得出问题的那几个。
 */
describe('DockRenderMessage：向下传的 props', () => {
  const props = (overrides: Partial<RenderMessageProps> = {}) =>
    ({
      message: assistant('a1'),
      messages: [user('u1'), assistant('a1')],
      inProgress: false,
      index: 1,
      isCurrentMessage: false,
      onRegenerate: vi.fn(),
      ...overrides,
    }) as unknown as RenderMessageProps;

  it('把 markdownTagRenderers 继续传下去（对话区 markdown 排版靠它）', () => {
    const renderers = { a: () => null };
    const spy = vi.fn(() => <div data-testid="assistant" />);

    render(
      <DockRenderMessage
        {...props({ markdownTagRenderers: renderers })}
        AssistantMessage={spy}
      />,
    );

    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0] as unknown[])[0]).toMatchObject({
      markdownTagRenderers: renderers,
    });
  });

  it('isLoading / isGenerating 跟着"是不是当前消息"走，而不是库给的值', () => {
    const spy = vi.fn(() => <div data-testid="assistant" />);

    render(
      <DockRenderMessage
        {...props({ inProgress: true, isCurrentMessage: false })}
        AssistantMessage={spy}
      />,
    );

    // a1 是 [u1, a1] 里的最后一条助手消息 → 正在生成时该显示光标
    expect((spy.mock.calls[0] as unknown[])[0]).toMatchObject({
      isLoading: false,
      isGenerating: true,
    });
  });

  it('过程消息（不是最后一条）即使在跑也不显示生成光标', () => {
    const spy = vi.fn(() => <div data-testid="assistant" />);
    const messages = [user('u1'), assistant('a1'), assistant('a2')];

    render(
      <DockRenderMessage
        {...props({
          messages,
          message: messages[1],
          index: 1,
          inProgress: true,
        })}
        AssistantMessage={spy}
      />,
    );

    expect((spy.mock.calls[0] as unknown[])[0]).toMatchObject({
      isLoading: false,
      isGenerating: false,
    });
  });
});

/**
 * 推理（思维链）挂在气泡**正上方**。
 *
 * 需求原话：「所有推理内容隐藏在 content 正上方默认灰色隐藏，点击展开」。
 * 这里钉的是**位置与条件**，折叠/展开行为在 ReasoningBlock.test.tsx 里钉。
 *
 * ⚠️ 位置是「**助手消息这个兄弟节点的前一个**」，**不是**「库的 subComponent
 *    槽里」—— 那正是 2026-10-13 那个 bug 的修法（槽会被 message.generativeUI
 *    顶掉，见 DockRenderMessage 的注释）。所以断言只能落在**节点顺序**上；
 *    断言"在 assistant-sub 里"会重新把两条实现绑死在一起，等于把坑埋回去。
 */
describe('DockRenderMessage：推理区放在正文上方', () => {
  const withReasoning = (id: string, text: string) =>
    ({
      id,
      role: 'assistant',
      content: '正文',
      metadata: { kind: 'chat', reasoning: text },
    }) as unknown as Message;

  /** 折叠行（没有就是 null）。 */
  const block = () => document.querySelector('[data-reasoning-block]');

  it('⭐ metadata 里有推理 -> 多一块，且排在助手气泡**前面**', () => {
    const message = withReasoning('a1', '草稿纸');
    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    const row = screen.getByTestId('assistant-row');
    expect(block()).not.toBeNull();
    // 同一个父节点下，折叠行是助手消息的**前一个**兄弟 = "正上方"
    expect(row.previousElementSibling).toBe(block());
  });

  it('⭐⭐ 消息带着 generativeUI（coagent bridge）时折叠行**照样在** —— 回归', () => {
    // 这是用户报「没有看到思考折叠按钮」的真实成因：CopilotKit 给**每一条**
    // 助手消息都挂了 coagent bridge 当 generativeUI（本面板下渲染 null），
    // 而库的 `message.generativeUI?.() ?? props.subComponent` 会让它顶掉
    // 我们的节点。这条绿着 = 折叠行不再依赖库那个槽。
    const message = {
      ...(withReasoning('a1', '草稿纸') as object),
      generativeUI: () => <div data-testid="coagent-bridge" />,
    } as unknown as Message;

    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    expect(block()).not.toBeNull();
    // 顺带把"它现在**不**在那个槽里"也钉住 —— 免得将来有人"顺手"挪回去
    expect(
      screen
        .getByTestId('assistant-sub')
        .querySelector('[data-reasoning-block]'),
    ).toBeNull();
  });

  it('⭐ 没有推理就一块都不加（助手气泡本身照旧）', () => {
    const message = assistant('a1');
    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    expect(block()).toBeNull();
    expect(screen.queryAllByTestId('assistant-row')).toHaveLength(1);
  });

  it('空白的推理当没有（空串不该渲染出一个空折叠块）', () => {
    const message = withReasoning('a1', '   ');
    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    expect(block()).toBeNull();
  });

  it('⭐ 默认折叠：推理原文一开始不在 DOM 里', () => {
    const message = withReasoning('a1', '草稿纸');
    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress={false}
        index={0}
        isCurrentMessage
      />,
    );

    expect(block()?.querySelector('[data-reasoning-body]')).toBeNull();
  });
});

/**
 * ⭐ 同一个 loading 不许出现两次。
 *
 * 需求原话：「不要同时存在两个 loading；开始加载了就删除掉下方的 loading icon」。
 *
 * 那两个分别是：
 *   · **我们的** —— 折叠行里的转圈（`ReasoningBlock`，气泡**上方**）；
 *   · **库的** —— `AssistantMessage` 在 `isLoading` 时画的小圆点
 *     （`copilot-loading-cursor`，气泡**下方**，用户截图里那三个蓝点）。
 *   推理流式期间正文还没到（`!message.content` 成立）→ 两个会同时亮，
 *   所以 `isLoading` 必须把"我们那个正在转圈"也算进判据。
 *
 * ⚠️ 反过来也要钉：推理**收尾之后**我们那行就变成静止的「思考过程」了，
 *    此时库里那个不许再关掉 —— 否则界面上一个在动的东西都没有，看着像卡死。
 *
 * ⚠️ 2026-10-21 补：库里那三个点现在被 CSS 整个隐藏了
 *    （style.ts 的 [data-testid='copilot-loading-cursor'] { display:none }，
 *    用户「去掉这个 loading icon」）。所以下面这组断言的语义变成"别在
 *    isLoading 上再多此一举"——它守的仍然是这个 prop 的推导，只是那三个点
 *    已经不会出现在界面上了。
 */
describe('DockRenderMessage：推理转圈时关掉库那个"下方 loading"', () => {
  const chatMsg = (id: string) =>
    ({ id, role: 'assistant', content: '' }) as unknown as Message;

  /** 库那个 `isLoading && <LoadingIcon/>` 的开关（桩把它暴露成 data-loading）。 */
  const loadingFlag = () => screen.getByTestId('assistant').dataset.loading;

  const renderOne = (message: Message) =>
    render(
      <DockRenderMessage
        message={message}
        messages={[message]}
        inProgress
        index={0}
        isCurrentMessage
      />,
    );

  beforeEach(() => {
    resetReasoning();
  });

  it('⭐ 推理正在流（我们那个在转圈）-> 库的下方 loading 必须关掉', () => {
    const message = chatMsg('a1');
    applyReasoning({ messageId: 'a1', delta: '先看要不要查工具' });

    renderOne(message);

    expect(document.querySelector('[data-reasoning-block]')).not.toBeNull();
    // 正文还没有，库那边也不该画光标 —— 于是整条消息只剩折叠行
    // （2026-10-20 起"没有正文也没有光标"时连 AssistantMessage 都不渲染）
    expect(screen.queryAllByTestId('assistant')).toHaveLength(0);
  });

  it('推理已收尾、正文还没到 -> 库里那个要留着', () => {
    const message = chatMsg('a2');
    applyReasoning({ messageId: 'a2', content: '想完了。', done: true });

    renderOne(message);

    // 我们那行此刻是静止的「思考过程」，不再是 loading 提示
    expect(document.querySelector('[data-reasoning-block]')).not.toBeNull();
    expect(loadingFlag()).toBe('true');
  });

  it('没有推理时行为不变（该转还是转）', () => {
    renderOne(chatMsg('a3'));
    expect(loadingFlag()).toBe('true');
  });
});

/**
 * ⭐⭐ 刷新之后：每一步的思考过程画在**自己那条**上方，按事件顺序，**不合并**。
 *
 * 需求原话（2026-10-20）：「刷新之后这些工具调用思考过程 按照事件顺序排序，
 * 多个思考过程也不要合并了，并且 tool_activity 的信息也正确显示」。
 *
 * 后端给的历史本来就按 `seq`（= 事件顺序）排好、**每条消息各带自己的**
 * `reasoning_content`（见 history.ts 的 reasoningOf），所以渲染只要"别挪、
 * 别拼"就是对的。10-17 那版把整轮拼成一块挂到第一条正文上 —— 顺序信息
 * 全丢了，界面变成"一列工具行 + 最后一大块思考"（用户截图）。
 *
 * ⚠️ 断言要落在**整棵树 + 文档顺序**上：既可能"少画"，也可能"画到别人头上"。
 */
describe('DockRenderMessage：每条推理各画一块，按事件顺序，不合并', () => {
  const chat = (id: string) =>
    ({ id, role: 'assistant', content: '正文' }) as unknown as Message;

  const reasoningChat = (id: string, text: string) =>
    ({
      id,
      role: 'assistant',
      content: '正文',
      metadata: { kind: 'chat', reasoning: text },
    }) as unknown as Message;

  const reasoningTool = (id: string, name: string, text: string) =>
    ({
      id,
      role: 'assistant',
      content: '',
      metadata: {
        kind: 'tool_activity',
        toolActivity: { calls: [{ id: `${id}-c`, name, args: null }] },
        reasoning: text,
      },
    }) as unknown as Message;

  /** 按**文档顺序**返回 —— 顺序本身就是要钉的东西。 */
  const blocks = () => document.querySelectorAll('[data-reasoning-block]');
  const toggles = () => document.querySelectorAll('[data-reasoning-toggle]');
  const bodies = () => document.querySelectorAll('[data-reasoning-body]');

  beforeEach(() => {
    resetReasoning();
  });

  it('⭐⭐ 三条消息各带推理（历史）-> 三块，各自挂在**自己那条**上方', () => {
    renderThread([
      user('u1'),
      reasoningChat('a1', '第一段'),
      reasoningChat('a2', '第二段'),
      reasoningChat('a3', '第三段'),
    ]);

    expect(blocks()).toHaveLength(3);
    expect(toggles()).toHaveLength(3);

    const rows = screen.getAllByTestId('assistant-row');
    expect(rows).toHaveLength(3);
    for (const [i, row] of rows.entries()) {
      expect(row.previousElementSibling).toBe(blocks()[i]);
    }
  });

  it('⭐ 每块只有自己那段（不拼接相邻消息的推理）', () => {
    renderThread([
      user('u1'),
      reasoningChat('a1', '第一段'),
      reasoningChat('a2', '第二段'),
      reasoningChat('a3', '第三段'),
    ]);

    // 默认折叠 → 逐个点开才挂载原文
    for (const toggle of Array.from(toggles())) fireEvent.click(toggle);

    expect(Array.from(bodies()).map((body) => body.textContent)).toEqual([
      '第一段',
      '第二段',
      '第三段',
    ]);
  });

  it('⭐⭐ 正文与工具记录交错：折叠行按事件顺序**夹在**工具行之间', () => {
    const { container } = renderThread([
      user('u1'),
      reasoningChat('a1', '先想想'),
      reasoningTool('ta1', 'agent.read', '决定读一下'),
      reasoningTool('ta2', 'agent.write', '再写一条'),
      reasoningChat('a2', '收尾'),
    ]);

    // 只取"过程标记"，看它们在文档里的先后
    const marks = Array.from(
      container.querySelectorAll(
        '[data-reasoning-block],[data-kind="tool_activity"]',
      ),
    ).map((el) =>
      el.matches('[data-kind="tool_activity"]')
        ? `T:${el.querySelector('span:last-child')?.textContent}`
        : 'R',
    );

    expect(marks).toEqual([
      'R',
      'R',
      'T:agent.read',
      'R',
      'T:agent.write',
      'R',
    ]);
  });

  it('⭐ 工具那条的推理在工具卡**正上方**（先想、再调）', () => {
    renderThread([
      user('u1'),
      reasoningTool('ta1', 'agent.read', '决定读一下'),
    ]);

    const row = document.querySelector('[data-kind="tool_activity"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toBe('agent.read');
    // 工具卡现在是独立的卡（自己的 tool section 包一层）；
    // 它的**上一张卡**就是放着推理的正文卡 —— 先想、再调，顺序不变。
    const card = row?.closest('[data-section-view="tool"]');
    expect(card).not.toBeNull();
    const previous = card?.previousElementSibling ?? null;
    expect(previous?.getAttribute('data-section-view')).toBe('chat');
    expect(previous?.querySelector('[data-reasoning-block]')).toBe(blocks()[0]);
  });

  it('两轮对话：每轮各自画自己的（不会跨轮合并）', () => {
    renderThread([
      user('u1'),
      reasoningChat('a1', '第一轮'),
      user('u2'),
      reasoningChat('a2', '第二轮'),
    ]);

    expect(blocks()).toHaveLength(2);
    for (const toggle of Array.from(toggles())) fireEvent.click(toggle);
    expect(Array.from(bodies()).map((body) => body.textContent)).toEqual([
      '第一轮',
      '第二轮',
    ]);
  });

  it('⭐ 整轮都没有推理 -> 一块都不画（别的消息有也不能凭空冒出来）', () => {
    renderThread([user('u1'), chat('a1'), chat('a2')]);
    expect(blocks()).toHaveLength(0);
  });

  it('⭐⭐ 实时的：推理后到，长在**自己那条**上方（不是第一条）', () => {
    const messages = [user('u1'), chat('a1'), chat('a2')];
    renderThread(messages);

    expect(blocks()).toHaveLength(0);

    // 推理属于 a2（第二轮 LLM 调用）—— 折叠行就该出现在 a2 上方
    act(() => {
      applyReasoning({ messageId: 'a2', content: '第二轮才有的推理' });
    });

    expect(blocks()).toHaveLength(1);
    const rows = screen.getAllByTestId('assistant-row');
    expect(rows[1].previousElementSibling).toBe(blocks()[0]);
    // 第一条上方**不是**那块折叠行（上面是用户消息的操作按钮）
    expect(rows[0].previousElementSibling).not.toBe(blocks()[0]);

    fireEvent.click(toggles()[0]);
    expect(bodies()[0]?.textContent).toBe('第二轮才有的推理');
  });

  it('⭐ 只有真正在流的那块显示"正在思考"，收尾的那块是"思考过程"', () => {
    applyReasoning({ messageId: 'a1', content: '第一段' });
    applyReasoning({ messageId: 'a2', delta: '第二段还在流' });

    renderThread([user('u1'), chat('a1'), chat('a2')]);

    expect(toggles()[0]?.textContent).toContain('思考过程');
    expect(toggles()[0]?.textContent).not.toContain('正在思考');
    expect(toggles()[1]?.textContent).toContain('正在思考');
  });

  it('⭐⭐ 长链路里前一段推理还在流时，最后那条也不许再亮库的 loading', () => {
    applyReasoning({ messageId: 'a1', delta: '还在想' });

    const messages = [user('u1'), chat('a1'), chat('a2')];
    render(
      messages.map((message, index) => (
        <DockRenderMessage
          key={message.id}
          message={message}
          messages={messages}
          inProgress
          index={index}
          isCurrentMessage
        />
      )),
    );

    // 最后那条（a2，答案位）拿到的"这一轮在流"= true -> 关掉下方小圆点
    const rows = screen.getAllByTestId('assistant');
    expect(rows[rows.length - 1].dataset.loading).toBe('false');
  });
});

/**
 * 「一次 tool 调用一行」在历史那条路上的落点。
 *
 * 实时那一份由 useToolActivity 保证一次调用一条（见 toolActivity.test.tsx）；
 * 历史这一份的原料是后端落库的 content 块，可能把几次调用塞进同一条消息，
 * 还可能把同一次调用写两遍（两种名字写法）。
 */
describe('DockRenderMessage：工具记录一次调用一行', () => {
  const toolRow = (id: string, calls: unknown[]) =>
    ({
      id,
      role: 'assistant',
      content: '',
      metadata: { kind: 'tool_activity', toolActivity: { calls, text: '' } },
    }) as unknown as Message;

  const rendered = () =>
    Array.from(document.querySelectorAll('[data-kind="tool_activity"]'));

  it('⭐ 一条记录里两个调用 -> 两行（不再用「、」挤在一行里）', () => {
    renderThread([
      user('u1'),
      toolRow('ta1', [
        { id: 'c1', name: 'a.read', args: null, status: 'done' },
        { id: 'c2', name: 'b.write', args: null, status: 'done' },
      ]),
    ]);

    expect(rendered().map((row) => row.textContent)).toEqual([
      'a.read',
      'b.write',
    ]);
  });

  it('⭐ 两行各带自己的状态（绿色小勾 / 红色小叉和刚才 SSE 里一致）', () => {
    renderThread([
      user('u1'),
      toolRow('ta1', [
        { id: 'c1', name: 'a.read', args: null, status: 'done' },
        {
          id: 'c2',
          name: 'b.write',
          args: null,
          status: 'error',
          error: '拒绝',
        },
      ]),
    ]);

    expect(rendered().map((row) => row.getAttribute('data-status'))).toEqual([
      'done',
      'error',
    ]);
  });
});

/**
 * 「我的消息卡片下方添加复制和编辑按钮」。
 *
 * 这里只钉**位置与有没有**：复制真的写剪贴板、编辑真的把原文交出去，
 * 由 UserMessageActions.test.tsx / Composer.test.tsx 各自负责。
 */
describe('DockRenderMessage：我的消息下方两枚按钮', () => {
  const withContent = (id: string, content: string) =>
    ({ id, role: 'user', content }) as unknown as Message;

  it('⭐ 用户消息后面有「复制」「编辑」', () => {
    renderThread([user('u1')]);

    expect(screen.getByRole('button', { name: /复制/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /编辑/ })).toBeTruthy();
  });

  it('助手消息没有（那两枚是"我的消息"的操作）', () => {
    renderThread([assistant('a1')]);

    expect(screen.queryByRole('button', { name: /复制/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull();
  });

  it('没有可读文本（空消息）就不画：复制空串、编辑空输入框都是坏按钮', () => {
    renderThread([withContent('u1', '   ')]);

    expect(screen.queryByRole('button', { name: /复制/ })).toBeNull();
  });

  it('两条用户消息各自一份按钮（不是全局挂一处）', () => {
    renderThread([user('u1'), user('u2')]);

    expect(screen.getAllByRole('button', { name: /复制/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /编辑/ })).toHaveLength(2);
  });
});

/**
 * 任务时间线（2026-10-22）——「task 相关的内容左侧添加纵向 timeline，
 * 灰色节点以 task 为单位」。
 *
 * 这里钉的是**结构**（轨道 / 圆点 / 小标题落在哪一行），不钉像素 ——
 * 位置与外观在 style.ts 的 taskTimeline 段里。
 */
describe('DockRenderMessage：任务时间线', () => {
  // 实时标记是模块级状态：用例之间必须清干净，否则后面那些
  // 「不在任务里」的断言会读到上一条用例留下的标记。
  afterEach(() => {
    resetLiveTasks();
  });

  const taskMessage = (
    id: string,
    kind: 'task_instruction' | 'task_result',
    taskId: string,
    content = id,
  ) =>
    ({
      id,
      role: kind === 'task_instruction' ? 'user' : 'assistant',
      content,
      metadata: {
        kind,
        task: { kind, taskId, planId: 'plan-1', skillKey: '' },
      },
    }) as unknown as Message;

  const rails = (root: HTMLElement) =>
    root.querySelectorAll('[data-task-rail]').length;
  const nodes = (root: HTMLElement) =>
    root.querySelectorAll('[data-task-node]').length;
  const heads = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('[data-task-head]')).map(
      (el) => el.textContent ?? '',
    );

  it('⭐ 指令 + 中间两步 + 结果 = 一条连续轨道，**只有一个**圆点（组首）', () => {
    const messages = [
      user('u0'),
      taskMessage('i1', 'task_instruction', 't1', '任务说明正文'),
      assistant('a1'),
      taskMessage('r1', 'task_result', 't1', '任务结果正文'),
      assistant('a9'),
    ];

    const { container } = renderThread(messages);

    // 5 条消息里 3 条在任务内（u0 在指令之前、a9 在结果之后，都不在）。
    expect(rails(container)).toBe(3);
    // 「以 task 为单位」= 一个任务只有一个节点。
    expect(nodes(container)).toBe(1);
    expect(heads(container)).toEqual(['任务 1 · 任务指令']);
  });

  it('⭐ 序号跟任务 id 走：t1 没产出时，t2 仍然是「任务 2」（不是「任务 1」）', () => {
    /*
     * 用户 2026-10-22 贴的实时 DOM：`data-task-id="…:t2"` 的节点标题写着
     * 「任务 1 · 基于 t1 确定的目的与语气…」—— id 是 t2、正文也在说 t1，
     * 只有那个数字是 1。根因是 t1 只有一条 instruction（规划器把"已经做完的
     * 那一步"也拆成了任务），整组被丢掉之后按出现顺序编号的 t2 顶上了 1。
     */
    const messages = [
      taskMessage('i1', 'task_instruction', 't1'),
      taskMessage(
        'i2',
        'task_instruction',
        't2',
        '任务说明：基于 t1 确定的目的与语气',
      ),
      assistant('a2'),
      taskMessage('r2', 'task_result', 't2'),
    ];

    const { container } = renderThread(messages);

    // 空任务仍然不画节点（上一轮的结论不变）。
    expect(nodes(container)).toBe(1);
    expect(heads(container)).toEqual(['任务 2 · 基于 t1 确定的目的与语气']);
  });

  it('★ 组首之后的每一行都标记「轨道从上面接过来」（间距收到最小档）', () => {
    const messages = [
      taskMessage('i1', 'task_instruction', 't1'),
      assistant('a1'),
      taskMessage('r1', 'task_result', 't1'),
    ];

    const { container } = renderThread(messages);
    const rows = Array.from(container.querySelectorAll('[data-task-id="t1"]'));

    expect(rows).toHaveLength(3);
    expect(rows[0].hasAttribute('data-task-dot')).toBe(true);
    expect(rows[0].hasAttribute('data-task-open-top')).toBe(false);
    expect(rows[0].hasAttribute('data-task-open-bottom')).toBe(true);

    expect(rows[1].getAttribute('data-task-linked')).toBe('true');
    expect(rows[1].hasAttribute('data-task-open-top')).toBe(true);

    // 组尾：往下不再探出（轨道到此为止）
    expect(rows[2].hasAttribute('data-task-open-bottom')).toBe(false);
  });

  it('⭐ 同一个任务被别的任务隔开时，节点标题只出现一次', () => {
    /*
     * 并行子代理来回认领时 `current_task_id` 会跳，同一个任务的消息被隔成两段。
     * 第一版给每段都画节点，第二个「任务 1」标题就落到它自己内容的末尾 ——
     * 用户看到的是「task_1 描述的 timeline 跑到 task_2 正文上方」。
     */
    noteLiveTask('a1', { taskId: 't1', title: '查财报', planId: 'p1' });
    noteLiveTask('a2', { taskId: 't2', title: '写结论', planId: 'p1' });
    noteLiveTask('a3', { taskId: 't1', title: '查财报', planId: 'p1' });
    noteLiveTask('a4', { taskId: 't2', title: '写结论', planId: 'p1' });

    const { container } = renderThread([
      user('u0'),
      assistant('a1'),
      assistant('a2'),
      assistant('a3'),
      assistant('a4'),
    ]);

    // 两个任务 = 两个节点，不是四个。
    expect(nodes(container)).toBe(2);
    expect(heads(container)).toEqual(['任务 1 · 查财报', '任务 2 · 写结论']);

    // 后出现的那一段仍然接着轨道（否则线会断开），但没有圆点。
    const second = container.querySelectorAll('[data-task-id="t1"]')[1];
    expect(second.getAttribute('data-task-linked')).toBe('true');
    expect(second.querySelector('[data-task-node]')).toBeNull();
  });

  it('★★ 纯工具步骤之后，任务 1 的正文自己带轨道（时间线不再从「任务 2」开始）', () => {
    /*
     * 实况：`agent.enter_plan_mode` 先把消息开出来了（那时还没任务），
     * 任务 1 的正文被追加进**同一条**消息 —— 归属只在开消息时记一次，
     * 之后再没人补，于是整段没有轨道，第一个节点直接是「任务 2」。
     * 翻译器现在会把这种消息收掉（见 runEventStream 的 toolOnlyStep），
     * 正文落到新的一条上、重新问一次归属 —— 这里钉的是**结果**：
     * 两条消息各自成组，节点是「任务 1」「任务 2」。
     */
    noteLiveTask('a1', {
      taskId: 'p-1:t1',
      title: '明确目的与语气',
      planId: 'p-1',
    });
    noteLiveTask('a2', {
      taskId: 'p-1:t2',
      title: '确定邮件主题',
      planId: 'p-1',
    });

    const { container } = renderThread([
      user('u0'),
      assistant('a1'),
      assistant('a2'),
    ]);

    expect(nodes(container)).toBe(2);
    expect(heads(container)).toEqual([
      '任务 1 · 明确目的与语气',
      '任务 2 · 确定邮件主题',
    ]);
  });

  it('★ 节点标题只取第一句；全文留在 title 属性里（悬停可见）', () => {
    /*
     * 后端没有 per-task 标题字段，节点标题只能拿 `message.description` 顶 ——
     * 而它是给子代理看的整段说明。从前把全文塞进一行再由 CSS 切，切出来是
     * 「目标：基于 STEP-1 …（Subject）。 输入：STE…」，用户原话：
     * 「task 描述里面有简易描述或者标题吗，不要显示全文」。
     */
    const full =
      '目标：基于 STEP-1 的目的与语气，确定该客户邮件的邮件主题（Subject）。 输入：STEP-1 的结论。输出：一个主标题 + 两个备选。';
    noteLiveTask('a1', { taskId: 'p-1:t1', title: full, planId: 'p-1' });

    const { container } = renderThread([user('u0'), assistant('a1')]);
    const head = container.querySelector('[data-task-head]');

    expect(head?.textContent).toBe(
      '任务 1 · 基于 STEP-1 的目的与语气，确定该客户邮件的邮件主题（Subject）',
    );
    expect(head?.textContent).not.toContain('输入：');
    // 收短只影响**显示**：悬停仍然给全文，信息不丢
    expect(head?.getAttribute('title')).toBe(full);
  });

  it('★ 任务外的消息没有轨道（主对话不能被画进时间线）', () => {
    const { container } = renderThread([
      taskMessage('i1', 'task_instruction', 't1'),
      taskMessage('r1', 'task_result', 't1'),
      assistant('a9'),
    ]);

    expect(rails(container)).toBe(2);

    const outside = container.querySelectorAll('[data-section-view="chat"]')[2];
    expect(outside.hasAttribute('data-task-id')).toBe(false);
  });

  it('⭐ 任务指令**不画成"我发的消息"气泡**，提示词也**不进正文**', () => {
    renderThread([
      taskMessage('i1', 'task_instruction', 't1', '任务说明正文'),
      taskMessage('r1', 'task_result', 't1', '任务结果正文'),
    ]);

    // 它是后端注入的 HumanMessage，用户从没打过这句话。
    expect(screen.queryByTestId('user')).toBeNull();

    // ⚠️ 2026-10-22「刷新前后不一致」：指令全文（提示词 + 参数 JSON）不能当正文。
    //    实时那条路上根本没有这条消息，画出来就是"刷新后凭空多出一大坨"。
    //    任务行的正文只有任务结果那一行。
    expect(screen.queryByText('任务说明正文')).toBeNull();
    expect(screen.getAllByTestId('task-markdown')).toHaveLength(1);
    expect(screen.getByTestId('task-markdown').textContent).toBe(
      '任务结果正文',
    );
  });

  it('★ 只剩一条任务说明（这一组一句话都没产出）-> 整条消息一个字都不画', () => {
    const { container } = renderThread([
      taskMessage('i1', 'task_instruction', 't1', '任务说明正文'),
    ]);

    // 只有一条任务说明 -> 分组时整组丢掉（见 taskTimeline.group）——
    // 既没有"我发的消息"气泡，也没有节点和轨道。
    expect(container.textContent).toBe('');
    expect(rails(container)).toBe(0);
    expect(nodes(container)).toBe(0);
  });

  it('任务行不带复制 / 重新生成那一行图标（它是过程记录，不是这一轮的回答）', () => {
    renderThread([taskMessage('r1', 'task_result', 't1')]);

    expect(screen.queryByTestId('assistant')).toBeNull();
  });

  it('两个任务 -> 两个节点，序号依次递增', () => {
    const { container } = renderThread([
      taskMessage('i1', 'task_instruction', 't1'),
      taskMessage('r1', 'task_result', 't1'),
      taskMessage('i2', 'task_instruction', 't2'),
      taskMessage('r2', 'task_result', 't2'),
    ]);

    expect(nodes(container)).toBe(2);
    expect(heads(container)).toEqual([
      '任务 1 · 任务指令',
      '任务 2 · 任务指令',
    ]);
  });

  it('没有任务的普通对话：一个轨道节点都不多', () => {
    const { container } = renderThread([user('u1'), assistant('a1')]);

    expect(rails(container)).toBe(0);
    expect(nodes(container)).toBe(0);
    expect(heads(container)).toEqual([]);
  });
});
