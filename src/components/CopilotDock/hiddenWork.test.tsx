// src/components/CopilotDock/hiddenWork.test.tsx
//
// 「看不见正文的那件活儿」这条平行通道（useHiddenWork + LiveActivityOverlay）。
//
// 为什么单独测
// ----------
//   它不进 `messages`，所以现有的渲染层测试（DockRenderMessage / history）
//   一条都扫不到它 —— 这里是它唯一的覆盖。而它会错得很安静：该出现时不出现
//   （那段静默期又变回"看起来卡住"），或者出现了再也不走（转一辈子）。
//
// ⚠️ agent 是假的
// -------------
//   真 `DockAgent` 要建会话、连 SSE，测不起也没必要 —— 这条通道的入口就是
//   `subscribe({ onCustomEvent })` 这一个契约，假 agent 只要能在测试里
//   手动触发它就够了。

import type { AbstractAgent } from '@ag-ui/client';
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import LiveActivityOverlay from './LiveActivityOverlay';
import { PROGRESS_CUSTOM_EVENT } from './runEventStream';
import { type HiddenWork, useHiddenWork } from './useHiddenWork';

type Emit = (name: string, value: unknown) => void;
type EmitText = (delta: string) => void;

/**
 * 假 agent：留了三个手动触发口，别的一个都没有。
 *
 * ⚠️ 刻意**只**给这条通道用到的回调留句柄（真契约传进来的是整个
 *    AgentSubscriber）—— 多留的成员都是没人用的面。
 */
function stubAgent(): AbstractAgent & {
  emit: Emit;
  emitText: EmitText;
} {
  let handler:
    | ((params: { event: { name: string; value: unknown } }) => void)
    | null = null;
  let onText: ((params: { event: { delta?: unknown } }) => void) | null = null;

  // ⚠️ 每次触发都要包 `act`：这几次 setState 不发生在事件处理器里，
  //    不包的话 React 会把它们攒着，下一个断言读到的还是上一帧的值 ——
  //    症状是"第一次 emit 好像没生效"，特别容易误判成 hook 写错了。
  const emit: Emit = (name, value) => {
    act(() => {
      handler?.({ event: { name, value } });
    });
  };

  const emitText: EmitText = (delta) => {
    act(() => {
      onText?.({ event: { delta } });
    });
  };

  const agent = {
    subscribe: (params: {
      onCustomEvent?: (p: { event: { name: string; value: unknown } }) => void;
      onTextMessageContentEvent?: (p: { event: { delta?: unknown } }) => void;
    }) => {
      handler = params.onCustomEvent ?? null;
      onText = params.onTextMessageContentEvent ?? null;
      return {
        unsubscribe: () => {
          handler = null;
          onText = null;
        },
      };
    },
  };

  // ⚠️ `emit` 必须**挂**到对象上再返回：它是闭包里的函数，光在 return 处
  //    做类型断言不会真的多出一个成员（`agent.emit` 会是 undefined）。
  return Object.assign(agent, {
    emit,
    emitText,
  }) as unknown as AbstractAgent & {
    emit: Emit;
    emitText: EmitText;
  };
}

/** 把 hook 挂起来，返回一个手动触发口。 */
function harness(): { emit: Emit; current: () => HiddenWork | null } {
  const agent = stubAgent();
  let latest: HiddenWork | null = null;

  const Probe: React.FC = () => {
    latest = useHiddenWork(agent);
    return null;
  };
  render(<Probe />);

  return { emit: agent.emit, current: () => latest };
}

const progress = (
  phase: 'start' | 'end',
  work: { node?: string | null; role?: string | null } = {
    role: 'summarization',
  },
) => ({
  phase,
  node: work.node ?? null,
  role: work.role ?? null,
  visible: false,
});

describe('useHiddenWork：刚开始 -> 结束 = 归零', () => {
  it('start 之前什么都没有', () => {
    const h = harness();
    expect(h.current()).toBeNull();
  });

  it('收到 start 就有了，收到 end 又没了', () => {
    const h = harness();
    h.emit(PROGRESS_CUSTOM_EVENT, progress('start'));
    expect(h.current()).toEqual({
      node: null,
      role: 'summarization',
      depth: 1,
    });

    h.emit(PROGRESS_CUSTOM_EVENT, progress('end'));
    expect(h.current()).toBeNull();
  });

  it('⚠️ 按**深度**算：两段交叠时中间那次 end 不该把它清掉', () => {
    // 压缩还没结束、分类又开始了（后端不保证不交叉）。拿"最后一个相位"
    // 当判据，这里的 end 会让那一行闪一下。
    const h = harness();
    h.emit(PROGRESS_CUSTOM_EVENT, progress('start', { role: 'summarization' }));
    h.emit(
      PROGRESS_CUSTOM_EVENT,
      progress('start', { role: 'classification' }),
    );
    h.emit(PROGRESS_CUSTOM_EVENT, progress('end', { role: 'summarization' }));

    expect(h.current()?.depth).toBe(1);

    h.emit(PROGRESS_CUSTOM_EVENT, progress('end', { role: 'classification' }));
    expect(h.current()).toBeNull();
  });

  it('⚠️ 多来几个 end 也不会跌成负数（防御式，不然 depth 会永远为正）', () => {
    const h = harness();
    h.emit(PROGRESS_CUSTOM_EVENT, progress('start'));
    h.emit(PROGRESS_CUSTOM_EVENT, progress('end'));
    h.emit(PROGRESS_CUSTOM_EVENT, progress('end'));
    expect(h.current()).toBeNull();
  });

  it('不是这条通道上的自定义事件一律忽略（value 形状不对也不抛）', () => {
    const h = harness();
    h.emit('别的人家的事件', progress('start'));
    expect(h.current()).toBeNull();

    h.emit(PROGRESS_CUSTOM_EVENT, null);
    h.emit(PROGRESS_CUSTOM_EVENT, { phase: 42 });
    expect(h.current()).toBeNull();
  });
});

describe('LiveActivityOverlay：一行过程提示，不是消息', () => {
  const NO_TOOLS = { running: 0, items: [] };

  it('认得的角色给专名', () => {
    render(
      <LiveActivityOverlay
        work={{ node: null, role: 'summarization', depth: 1 }}
        tools={NO_TOOLS}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('正在整理上下文');
  });

  it('⚠️ 认不出来的角色照样能显示（词汇表会长大）', () => {
    render(
      <LiveActivityOverlay
        work={{ node: null, role: 'brand.new.role', depth: 1 }}
        tools={NO_TOOLS}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('正在处理');
  });

  it('节点名与角色原值都挂在 DOM 上（探针/定位有稳定的抓手）', () => {
    render(
      <LiveActivityOverlay
        work={{ node: 'builder', role: null, depth: 1 }}
        tools={NO_TOOLS}
      />,
    );
    const chip = screen.getByRole('status');
    expect(chip.getAttribute('data-work-node')).toBe('builder');
    expect(screen.getByRole('status').textContent).toContain(
      '正在理解你的问题',
    );
  });
});

describe('已经有正文流出来时不再挂"正在…"', () => {
  it('正文一开始流就让位（正文本身就是反馈）', () => {
    const agent = stubAgent();
    let latest: HiddenWork | null = null;
    // ⚠️ 必须经函数读：直接读 `latest` 会被 TS 窄化成 null（`?.depth` 变 never）。
    const current = () => latest;
    const Probe: React.FC = () => {
      latest = useHiddenWork(agent);
      return null;
    };
    render(<Probe />);

    agent.emit(PROGRESS_CUSTOM_EVENT, progress('start', { node: 'builder' }));
    expect(current()?.depth).toBe(1);

    agent.emitText('紫蓬山');
    expect(current()).toBeNull();
  });

  it('⚠️ 纯空白的 delta **不算**"有正文"（实测 content 可能是两个换行）', () => {
    // 那段 content 是 "\n\n"：它会打开正文通道却什么都不显示，
    // 按它算"已有正文"，loading 会在真正的回答开始前先消失一次。
    const agent = stubAgent();
    let latest: HiddenWork | null = null;
    // ⚠️ 必须经函数读：直接读 `latest` 会被 TS 窄化成 null（`?.depth` 变 never）。
    const current = () => latest;
    const Probe: React.FC = () => {
      latest = useHiddenWork(agent);
      return null;
    };
    render(<Probe />);

    agent.emit(PROGRESS_CUSTOM_EVENT, progress('start', { node: 'builder' }));
    agent.emitText('\n\n');
    expect(current()?.depth).toBe(1);
  });
});

/**
 * 「给对话区预留多少底部留白」（--dock-tool-feed-h）。
 *
 * ⚠️ 为什么值得单独钉一条
 * -------------------
 *   这一层的**外框**是铺满整块消息区的（inset-block: 0 …），内容才在
 *   hiddenWorkStack 里。写错过一次：量的是外框 → 留白 = 整个消息区的高度 →
 *   CopilotKit 在用户消息进来时 `scrollTop = scrollHeight` 正好滚到那片空白上，
 *   **已有消息全被顶出可视区**，面板看上去一片空白，只剩输入框上沿那枚
 *   「正在整理上下文…」胶囊（用户报的"发送消息之后对话框先全部变空"）。
 *
 *   happy-dom 没有布局（`offsetHeight` 恒为 0），所以这里**直接桩掉**它的
 *   返回值，把"外框很高、内容很矮"这个真实关系造出来 —— 断言预留值等于
 *   内容高度，而不是外框高度。
 */
describe('LiveActivityOverlay：预留高度只算内容，不算铺满消息区的外框', () => {
  /** 真实布局里：外框 ≈ 消息区高度，内容 ≈ 胶囊高度。 */
  const LAYER_BOX = 663;
  const CONTENT_BOX = 31;

  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  );

  /** 桩掉 offsetHeight：按 data 属性区分「外框」与「内容层」。 */
  function stubBoxHeights(): void {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.hasAttribute('data-live-activity-stack')) return CONTENT_BOX;
        if (this.hasAttribute('data-live-activity-layer')) return LAYER_BOX;
        return 0;
      },
    });
  }

  afterEach(() => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
    } else {
      // 原本没有这个属性描述符时直接删掉，别给后面的用例留下一个假的 getter。
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    }
  });

  it('把内容高度写给对话区（不是外框高度）', () => {
    stubBoxHeights();

    const { container } = render(
      <div data-chat-pane="true">
        <LiveActivityOverlay
          work={{ node: null, role: 'summarization', depth: 1 }}
          tools={{ running: 0, items: [] }}
        />
      </div>,
    );

    const pane = container.querySelector(
      '[data-chat-pane]',
    ) as HTMLElement | null;
    expect(pane).not.toBeNull();

    const reserved = pane?.style.getPropertyValue('--dock-tool-feed-h');
    expect(reserved).toBe(`${CONTENT_BOX}px`);
    // 反证：写成外框高度就是"整块消息区"那么高，这条断言能立刻抓住回归。
    expect(reserved).not.toBe(`${LAYER_BOX}px`);
  });

  it('内容消失（组件返回 null）后留白归零，不残留上一次的高度', () => {
    stubBoxHeights();

    const { container, rerender } = render(
      <div data-chat-pane="true">
        <LiveActivityOverlay
          work={{ node: null, role: 'summarization', depth: 1 }}
          tools={{ running: 0, items: [] }}
        />
      </div>,
    );
    const pane = container.querySelector(
      '[data-chat-pane]',
    ) as HTMLElement | null;
    expect(pane?.style.getPropertyValue('--dock-tool-feed-h')).toBe(
      `${CONTENT_BOX}px`,
    );

    rerender(
      <div data-chat-pane="true">
        <LiveActivityOverlay work={null} tools={{ running: 0, items: [] }} />
      </div>,
    );
    expect(pane?.style.getPropertyValue('--dock-tool-feed-h')).toBe('0px');
  });
});
