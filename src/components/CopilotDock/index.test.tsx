// src/components/CopilotDock/index.test.tsx
//
// 面板的组件级冒烟。面板是**受控**的（折叠状态在 app.tsx 的 initialState 里，
// 因为它要跟左侧菜单互斥），所以这里只测两件事：
//   ① 给了 collapsed 之后渲染成什么样；
//   ② 用户点了要「请示」什么状态（onCollapsedChange 收到什么），而不是自己改掉。
// 最要紧的一条：面板要把宽度写到 :root 的 --copilot-dock-w 上，内容区全靠它让位 ——
// 展开 = 可视宽度 1/3，收起 = 0。
// CopilotKit 被换成占位组件：这里测的是我们自己这层的装配，不是它的渲染。
//
// ⚠️ 为什么这里要**抓住真的 agent**
// ------------------------------
//   「空对话问候语」的判据是「agent.messages 空不空」（useAgentMessages），
//   而不是任何 localStorage 里的业务标记 —— 所以测试必须能往 agent 里塞消息。
//   CopilotKit 的占位实现顺手把 agents__unsafe_dev_only 里的 agent 留出来，
//   `runtime.agent` 就是它（真 DockAgent，构造不发任何请求）。
//
//   `listSessionMessages` 被 mock 掉：真实现会走 axios 打网络，happy-dom 里
//   必然 reject，于是 status 恒为 'error' —— 那测不出"加载完成后的样子"。
import type { AbstractAgent } from '@ag-ui/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { App } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DockRenderMessage from './DockRenderMessage';
import CopilotDock from './index';
import { MESSAGE_ACTION_ICONS } from './messageActionIcons';
import { SPACE_MID, SPACE_TIGHT, SPACE_WIDE } from './style';

/**
 * 跨 mock 边界共享的把手。必须走 vi.hoisted —— vi.mock 会被提升到 import 之上，
 * 直接引用外面的 let 会报「Cannot access before initialization」。
 */
const runtime = vi.hoisted(() => ({
  /** CopilotKit 占位实现渲染时留下的真 agent（每个会话一个新实例）。 */
  agent: null as unknown as AbstractAgent | null,
  listSessionMessages: vi.fn(),
  /** 挂载时把后端会话并进本地账本的那一次请求。 */
  listSessions: vi.fn(),
  /** 删除走的是 `DELETE /sessions/{id}`（后端软删 = 归档）。 */
  deleteSession: vi.fn(),
  /** CopilotChat 占位实现收到的 props（用来断言输入框插槽接了谁）。 */
  chatProps: null as Record<string, unknown> | null,
  /** v2 CopilotKit 的 runAgent 桩 —— RunResume 靠它把没跑完的运行接回来。 */
  runAgent: vi.fn(async () => ({})),
}));

vi.mock('./agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentRuntime')>()),
  listSessionMessages: runtime.listSessionMessages,
  // ⚠️ 这两个**必须**一起桩掉：不桩就会走真的 axios 打网络，
  //   happy-dom 里必然 reject —— 删除那条用例会因此永远停在"失败"分支，
  //   看起来像"删除没生效"，实际是测试环境没有后端。
  listSessions: runtime.listSessions,
  deleteSession: runtime.deleteSession,
}));

vi.mock('@copilotkit/react-core', () => ({
  CopilotKit: ({
    children,
    agents__unsafe_dev_only,
  }: {
    children?: ReactNode;
    agents__unsafe_dev_only?: Record<string, AbstractAgent>;
  }) => {
    runtime.agent = agents__unsafe_dev_only?.default ?? null;
    return <div data-testid="copilot-kit">{children}</div>;
  },
  // Composer（我们的输入框实现）会用到这两个 —— 占位实现也把桩给上，
  // 免得将来谁把它渲染出来时，报的是"找不到导出"这种和真实原因无关的错。
  useCopilotChatInternal: () => ({ interrupt: null }),
  useCopilotContext: () => ({ copilotApiConfig: {} }),
}));

/**
 * HitlInterrupt 用的 useInterrupt 来自 **v2** 的子入口（v1 入口没有它）。
 *
 * ⚠️ 这里必须一起 mock，理由和上面那个 mock 是同一条
 * ------------------------------------------------
 *   上面把 `CopilotKit` 换成了占位组件 —— 也就是说**真的 v2 context 没有被挂载**。
 *   而真的 useInterrupt 会去读那个 context（内部用 useCopilotKit / useAgent），
 *   读到的是默认值，于是抛错、被 ErrorBoundary 兜住，整个文件的 52 条用例
 *   一起变红（实测踩过，报错还被 ErrorBoundary 的二次错误盖住，很难查）。
 *
 *   本文件测的是**面板自己的装配**（文件头第 9 行就写明了），HITL 卡片的
 *   渲染由 HitlInterrupt.test.tsx 单独测 —— 那里才喂真的中断数据。
 */
vi.mock('@copilotkit/react-core/v2/headless', () => ({
  // 返回 null（不是 undefined）：HitlInterrupt 拿**返回值**判有没有待办，
  // 而它判的是 `element !== null` —— 返回 undefined 会被当成"有中断"，
  // 于是把输入框锁上（hitlSignal），本文件里一堆"能发消息"的用例就得红。
  useInterrupt: () => null,
  // RunResume 用这里的 runAgent 让 agent 再跑一次（= 续订一个没跑完的运行）。
  // ⚠️ 必须给：真的 useCopilotKit 读不到 CopilotKitProvider 会**直接抛错**，
  //   而本文件里 CopilotKit 是占位组件（真的 provider 没挂）—— 不桩就是
  //   整个文件一起红。
  useCopilotKit: () => ({ copilotkit: { runAgent: runtime.runAgent } }),
}));

/**
 * CopilotChat 的占位实现。
 * **把 labels 透到 DOM 上** —— 我们要断言 `labels.initial` 是空的
 * （CopilotKit 拿它生成一条假的助手欢迎消息），不透出来就没法测。
 * **把 props 记到 runtime 上** —— 用来断言 `Input` 插槽接的是我们的 Composer。
 */
vi.mock('@copilotkit/react-ui', () => ({
  CopilotChat: (
    props: Record<string, unknown> & { labels?: Record<string, string> },
  ) => {
    runtime.chatProps = props;
    return (
      <div
        data-testid="copilot-chat"
        data-initial={props.labels?.initial ?? ''}
      />
    );
  },
  useChatContext: () => ({
    labels: { placeholder: '发消息给 AI 助手…' },
    icons: { sendIcon: 'SEND', stopIcon: 'STOP', spinnerIcon: 'SPINNER' },
    open: true,
    setOpen: () => {},
  }),
  /*
    下面三个是 DockRenderMessage 从库里取的**默认渲染器**（它包一层，
    只改 isCurrentMessage 那一个判定，其余照旧委托给库）。

    ⚠️ 必须一起给上：vitest 的 mock 是个 Proxy，访问**缺失的导出**会直接抛
       「No "AssistantMessage" export is defined on the mock」—— 而那个报错
       跟真实原因（我们新 import 了它们）看不出关系，本仓库在 app.test.tsx 里
       踩过同一个坑（那里的注释写的就是这件事）。
  */
  AssistantMessage: () => <div data-testid="lib-assistant-message" />,
  UserMessage: () => <div data-testid="lib-user-message" />,
  // 任务行的正文（见 DockRenderMessage 的 taskRow 分支）。
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="task-markdown">{content}</div>
  ),
  ImageRenderer: () => null,
}));

const KEY_LIST = 'ytrader.copilot.conversations';
const KEY_ACTIVE = 'ytrader.copilot.active';

/**
 * jsdom 里 clientWidth 恒为 0，而面板宽度是按它算的，所以得显式打桩。
 * 打在 documentElement 这个实例上（jsdom 把 getter 定义在 Element.prototype 上）。
 */
let viewportWidth = 1200;
const setViewportWidth = (width: number) => {
  viewportWidth = width;
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => viewportWidth,
  });
};

const dockWidth = () =>
  document.documentElement.style.getPropertyValue('--copilot-dock-w');

const panel = (container: HTMLElement) =>
  container.querySelector('aside[aria-label="AI 助手"]');

const conversations = () =>
  JSON.parse(localStorage.getItem(KEY_LIST) ?? '[]') as unknown[];

const renderDock = (collapsed: boolean) => {
  const onCollapsedChange = vi.fn();
  const utils = render(
    // ⚠️ 必须包 antd 的 <App>：组件里用 App.useApp() 拿 modal（拿 ConfigProvider
    // context，静态 Modal.confirm 拿不到）。生产环境由 umi 的 antd 插件注入
    // （.umi/plugin-antd/runtime.tsx 的 innerProvider），测试里得自己补上 ——
    // 不包的话 modal 是个空实现，点击「删除」什么都不会发生。
    <App>
      <CopilotDock
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
      />
    </App>,
  );
  return { ...utils, onCollapsedChange };
};

/** 一条后端历史消息（只填 history.ts 真正会读的字段）。 */
const historyMessage = (
  seq: number,
  role: 'user' | 'assistant',
  text: string,
) => ({
  message_id: `m-${seq}`,
  seq,
  run_id: 'r-1',
  role,
  kind: 'chat' as const,
  business_agent_id: null,
  content: [{ type: 'text', text }],
  status: 'completed' as const,
  reply_to_message_id: null,
  created_at: '2026-10-03T03:00:00Z',
  updated_at: '2026-10-03T03:00:00Z',
  metadata: {},
});

/** 一页会话历史（`listSessionMessages` 的返回形状）。 */
const historyPage = (
  ...messages: ReturnType<typeof historyMessage>[]
): {
  session_id: string;
  messages: ReturnType<typeof historyMessage>[];
  pagination: Record<string, unknown>;
} => ({
  session_id: 's-1',
  messages,
  pagination: {
    limit: 50,
    has_more_before: false,
    before_cursor: null,
    has_more_after: false,
    after_cursor: null,
  },
});

/**
 * 往当前 agent 里塞一条**真的**聊天消息（模拟 CopilotKit 在提交那一刻
 * `agent.addMessage(用户消息)`）。`addMessage` 的广播是异步的，必须等。
 */
const feedUserMessage = async (text: string) => {
  const agent = runtime.agent;
  if (!agent) throw new Error('agent 还没被交给 CopilotKit');
  await act(async () => {
    agent.addMessage({ id: `u-${text}`, role: 'user', content: text });
  });
};

const greeting = () => screen.queryByText('你好，我能帮什么忙吗？');

beforeEach(() => {
  localStorage.clear();
  setViewportWidth(1200);
  document.documentElement.style.removeProperty('--copilot-dock-w');
  runtime.agent = null;
  runtime.chatProps = null;
  runtime.listSessionMessages.mockReset();
  // 默认「会话存在但一条都没聊过」（后端对没聊过的会话就是回空数组）
  runtime.listSessionMessages.mockResolvedValue(historyPage());
  runtime.listSessions.mockReset();
  // 默认后端没有别的会话（绝大多数用例只关心本地账本）
  runtime.listSessions.mockResolvedValue({ items: [], total: 0 });
  runtime.deleteSession.mockReset();
  runtime.deleteSession.mockResolvedValue(undefined);
  runtime.runAgent.mockReset();
  runtime.runAgent.mockResolvedValue({});
});

afterEach(cleanup);

describe('CopilotDock 面板（展开态）', () => {
  it('占可视宽度 1/3：有工具栏和对话区，且不出现展开图标', () => {
    const { container } = renderDock(false);

    expect(panel(container)).not.toBeNull();
    expect(panel(container)?.getAttribute('data-collapsed')).toBeNull();
    expect(screen.getByTestId('copilot-chat')).toBeInTheDocument();
    // 对话态标题是产品名（2026-10-22 从「AI 助手」改成「YTrader Harness」）；
    // 无障碍名仍保留「AI 助手」（见下面的 aria-label 断言）。
    expect(screen.getByText('YTrader Harness')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '新建对话' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开 AI 助手' })).toBeNull();

    // 1200 / 3
    expect(dockWidth()).toBe('400px');
  });

  it('⭐ 给 CopilotChat 的 Input 插槽接的是我们自己的 Composer', () => {
    renderDock(false);

    // 不是为了"看它渲染成什么"（那是 Composer.test.tsx 的事），
    // 而是钉住这条装配：换成库的默认输入框，「深度思考 / 附件」就一起没了。
    expect(typeof runtime.chatProps?.Input).toBe('function');
  });

  it('⭐ 给 CopilotChat 的消息渲染接的是我们的覆盖实现', () => {
    renderDock(false);

    // 钉住这条装配：库默认的 RenderMessage 把"当前消息"算成
    // "数组最后一个元素"（见 DockRenderMessage.tsx），反馈按钮会落到每条
    // 助手消息上、或整组消失。换成默认实现这个功能就一起没了。
    // 「按最后一条 AIMessage 判定」本身由 DockRenderMessage.test.tsx 覆盖。
    expect(runtime.chatProps?.RenderMessage).toBe(DockRenderMessage);
  });

  it('⭐ 助手消息的操作图标与「我的消息」同源（icons prop）', () => {
    renderDock(false);

    // 需求（2026-10-21）：「双方消息卡片下方 icon 统一来源和效果样式大小，
    // 相同功能要用相同 icon」。不传 icons 的话库会用自己的 SVG —— 「复制」
    // 在两条消息下面一个细线一个描边，尺寸也不一样。
    //
    // ⚠️ 断言的是**同一个节点**（toBe），不是"看起来一样"：同源是这条需求的
    //    全部含义，哪天有人给助手那边换成另一个图标组件，这里必须红。
    const icons = runtime.chatProps?.icons as
      | Record<string, ReactNode>
      | undefined;
    expect(icons?.copyIcon).toBe(MESSAGE_ACTION_ICONS.copy);
    expect(icons?.regenerateIcon).toBe(MESSAGE_ACTION_ICONS.regenerate);
    expect(icons?.thumbsUpIcon).toBe(MESSAGE_ACTION_ICONS.thumbsUp);
    expect(icons?.thumbsDownIcon).toBe(MESSAGE_ACTION_ICONS.thumbsDown);

    // 别顺手把整张表塞进去：Composer 还要用库默认的发送 / 停止 / 转圈图标，
    // 库里是 `{...默认, ...icons}` 合并，多传的键会把它们顶掉。
    expect(icons).not.toHaveProperty('sendIcon');
    expect(icons).not.toHaveProperty('stopIcon');
    expect(icons).not.toHaveProperty('spinnerIcon');
  });

  it('视口变化时重新算宽度（resize）', () => {
    renderDock(false);
    expect(dockWidth()).toBe('400px');

    setViewportWidth(900);
    fireEvent(window, new Event('resize'));

    expect(dockWidth()).toBe('300px');
  });

  it('点「收起」只是请示新的折叠状态，不自己改', () => {
    const { container, onCollapsedChange } = renderDock(false);

    fireEvent.click(screen.getByRole('button', { name: '收起 AI 助手' }));

    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    // 受控：父组件没把 collapsed 传成 true 之前，这里保持原样
    expect(panel(container)?.getAttribute('data-collapsed')).toBeNull();
  });

  it('⭐ 空会话时点「新建对话」：切过去、**不新建**（不再堆一排「新对话」）', () => {
    renderDock(false);
    expect(conversations()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));

    expect(conversations()).toHaveLength(1);
  });

  it('⭐ 连点 5 次「新建对话」仍然只有一条会话', () => {
    renderDock(false);

    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    }

    expect(conversations()).toHaveLength(1);
  });

  it('已有空会话之外还有聊过的会话时，点「新建对话」会切回那条空会话', () => {
    // 种一条「聊过的」在前 + 一条空的在后，当前停在聊过的那条上
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'used-1', title: '聊过的', createdAt: 200, used: true },
        { id: 'blank-1', title: '新对话', createdAt: 100 },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'used-1');
    renderDock(false);

    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));

    // 不再新建，而是复用那条空会话
    expect(conversations()).toHaveLength(2);
    expect(localStorage.getItem(KEY_ACTIVE)).toBe('blank-1');
  });

  it('没有空会话可用时才真的新建一条', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'used-1', title: '聊过的', createdAt: 200, used: true },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'used-1');
    renderDock(false);

    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));

    const list = JSON.parse(localStorage.getItem(KEY_LIST) ?? '[]') as {
      id: string;
    }[];
    expect(list).toHaveLength(2);
    // 新会话插在最前，并且成为当前会话
    expect(localStorage.getItem(KEY_ACTIVE)).toBe(list[0].id);
  });
});

describe('空对话的问候语（替代 CopilotKit 的初始欢迎消息）', () => {
  it('新对话：显示问候语，且**不再注入**默认的 AI 欢迎消息', () => {
    renderDock(false);

    expect(greeting()).toBeInTheDocument();
    // labels.initial 必须是空的 —— 传了它，CopilotKit 会在消息列表最前面
    // 塞一条 role:'assistant' 的假消息（见 index.tsx 里的注释）
    expect(
      screen.getByTestId('copilot-chat').getAttribute('data-initial'),
    ).toBe('');
  });

  /**
   * ⭐ 回归（用户报的 bug）：问候语的判据曾经是「这条会话用没用过」这个业务标记。
   * `used` 在**提交那一刻**就置位、与后端成不成功无关，于是
   * 「拿不到 session_id 的用过会话」（建会话失败 / 页面被提前刷新 / 后端换库）
   * 会把问候语藏起来、而消息列表又是空的 → **一整页空白**。
   * CDP 实测过这个状态：greet=false, domMessages=0。
   */
  it('⭐ 用过但一条消息都没有（脏数据）：仍然显示问候语，不留空白页', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'u1', title: '聊过的', createdAt: 100, used: true },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    renderDock(false);

    expect(greeting()).toBeInTheDocument();
  });

  it('⭐ 有后端会话但历史是空的：也显示问候语', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'u1', title: '新对话', createdAt: 100, sessionId: 's-1' },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    runtime.listSessionMessages.mockResolvedValue(historyPage());
    renderDock(false);

    await waitFor(() =>
      expect(runtime.listSessionMessages).toHaveBeenCalledWith('s-1', {
        limit: 50,
      }),
    );
    expect(greeting()).toBeInTheDocument();
  });

  it('⭐ 历史里有消息：不显示问候语（让位给真实消息）', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'u1',
          title: '聊过的',
          createdAt: 100,
          used: true,
          sessionId: 's-1',
        },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    runtime.listSessionMessages.mockResolvedValue(
      historyPage(
        historyMessage(1, 'user', '你有什么能力'),
        historyMessage(2, 'assistant', '我可以帮你查文档'),
      ),
    );
    renderDock(false);

    await waitFor(() => expect(greeting()).toBeNull());
  });

  /**
   * 刷新后第一次打开某个会话：历史里最后一条是**用户消息** —— 说明那一轮的
   * 答复还没落库，后端多半还在跑（也可能停在审批上）。这时要**自动续订**：
   * 拿历史里那条消息的 run_id 直接订阅它的事件流。
   *
   * 端到端只体到"触发了"这一层（装配对不对）：判据在 useSessionHistory 的
   * 单测里、续订与清理在 agent 的单测里、这一行的动作在 RunResume 的单测里。
   */
  it('⭐ 历史最后一条是用户消息（那一轮还在跑）→ 自动续订：让 agent 再跑一次', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'u1',
          title: '聊过的',
          createdAt: 100,
          used: true,
          sessionId: 's-1',
        },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    runtime.listSessionMessages.mockResolvedValue(
      historyPage(historyMessage(1, 'user', '这一轮还没回来')),
    );
    renderDock(false);

    await waitFor(() => expect(runtime.runAgent).toHaveBeenCalledTimes(1));
    expect(runtime.runAgent).toHaveBeenCalledWith({ agent: runtime.agent });
  });

  it('⭐ 历史里那一轮已经了结（completed）→ 不续订（重放只会多一条重复的）', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'u1',
          title: '聊过的',
          createdAt: 100,
          used: true,
          sessionId: 's-1',
        },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    runtime.listSessionMessages.mockResolvedValue(
      historyPage(
        historyMessage(1, 'user', '问一句'),
        historyMessage(2, 'assistant', '答一句'),
      ),
    );
    renderDock(false);

    await waitFor(() => expect(greeting()).toBeNull());
    expect(runtime.runAgent).not.toHaveBeenCalled();
  });

  /**
   * ⭐ 回归（用户报的 bug）：「打开新对话触发 interrupt，切到别的 session，
   * 页面上也显示待审批 confirm」。
   *
   * 成因：切会话的那一帧 `useSessionHistory` 里还留着**上一个会话**的续订候选
   * （state 在渲染之后才被 effect 改掉），而 RunResume 恰在这一帧随
   * `<CopilotKit key={activeId}>` 重挂 → 它把 A 的 run_id 接给了 B 的 agent，
   * 订阅后重放的 hitl.requested 就让审批卡在 B 里冒出来。
   *
   * 这里钉的是"端到端的后果"：切过去**不能**再来一次续订。
   */
  it('⭐ 切到别的会话：不能把上一个会话的"没跑完的运行"接过去', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'u1',
          title: 'A 会话',
          createdAt: 100,
          used: true,
          sessionId: 's-1',
        },
        {
          id: 'u2',
          title: 'B 会话',
          createdAt: 200,
          used: true,
          sessionId: 's-2',
        },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    // A 停在审批上（有候选）、B 干干净净（没有候选）
    runtime.listSessionMessages.mockImplementation((async (sid: string) =>
      sid === 's-1'
        ? historyPage(historyMessage(1, 'user', '这一轮停在审批'))
        : historyPage()) as never);
    renderDock(false);

    // A：有候选 → 续订一次
    await waitFor(() => expect(runtime.runAgent).toHaveBeenCalledTimes(1));

    // 切到 B —— 点历史抽屉里的会话标题
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(screen.getByText('B 会话'));

    // 就在这一帧：B 的续订动作不能发生（B 的历史里没有没跑完的运行）
    expect(runtime.runAgent).toHaveBeenCalledTimes(1);

    // B 的历史回来之后（确认那条路真的走完了）也还是只有 A 那一次
    await waitFor(() =>
      expect(runtime.listSessionMessages).toHaveBeenCalledWith('s-2', {
        limit: 50,
      }),
    );
    expect(runtime.runAgent).toHaveBeenCalledTimes(1);
  });

  /**
   * 「刚发出去、回复还没回来」那段空窗不能冒问候语。
   * 之所以天然没事：CopilotKit 提交的**同一个 tick** 里就把用户消息
   * `addMessage` 进 agent（见 react-core 的 v1 useCopilotChatInternal），
   * 消息列表立刻非空。
   */
  it('⭐ 刚发出消息（回复还没回来）：问候语立刻消失', async () => {
    renderDock(false);
    expect(greeting()).toBeInTheDocument();

    await feedUserMessage('在吗');

    expect(greeting()).toBeNull();
  });

  /**
   * ⭐ 回归（用户报的 bug）：**在飞的那一轮不能被"灌历史"清掉。**
   *
   * 用户看到的：第一个问题发出去之后，居中的「你好，我能帮什么忙吗？」没消失，
   * 和 loading 动画一起挂在面板上。
   *
   * 成因不在问候语本身，在灌历史那条路：懒建会话拿回的 session_id 会让
   * useSessionHistory 重跑一次（sessionId 从无到有），而这时 createRun 往往还没
   * 把用户消息落库 —— 后端回一条**空**历史，紧接着 `setMessages([])` 把在飞的
   * 这一轮整个清掉，agent.messages 变空 → `!hasMessages` 重新成立 → 问候语冒回来。
   *
   * 这条用「挂载时就有 sessionId、历史停在半路」复现同一个时序（不必真去建会话）：
   * 用户在等历史的空档里把消息发了出去，历史随后才到、而且是空的。
   */
  it('⭐ 历史灌回来的那一刻，正在飞的那一轮不能被清掉（问候语曾经会因此冒回来）', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'u1',
          title: '聊过的',
          createdAt: 100,
          used: true,
          sessionId: 's-1',
        },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    let resolveHistory: (page: unknown) => void = () => {};
    runtime.listSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    renderDock(false);

    // 历史还在路上
    expect(screen.getByText('正在加载对话记录…')).toBeInTheDocument();

    // 用户等不及，先把第一个问题发了出去
    await feedUserMessage('在吗');
    const agent = runtime.agent as AbstractAgent;
    expect(agent.messages).toHaveLength(1);

    // 后端这时才回：空历史（createRun 还没把这条消息落库）
    await act(async () => {
      resolveHistory(historyPage());
    });

    // 在飞的那一轮还在 —— 没被清掉
    expect(agent.messages).toHaveLength(1);
    // 于是问候语不会冒回来，面板上只剩 loading 动画
    expect(greeting()).toBeNull();
  });

  it('加载历史期间不显示问候语（免得闪一下再被顶掉）', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'u1',
          title: '聊过的',
          createdAt: 100,
          used: true,
          sessionId: 's-1',
        },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    // 永不 resolve —— 停在 loading 态
    runtime.listSessionMessages.mockReturnValue(new Promise(() => {}));
    renderDock(false);

    expect(screen.getByText('正在加载对话记录…')).toBeInTheDocument();
    expect(greeting()).toBeNull();
  });

  it('从聊过的会话点 + 切到空会话，问候语出现', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'u1',
          title: '聊过的',
          createdAt: 200,
          used: true,
          sessionId: 's-1',
        },
        { id: 'blank', title: '新对话', createdAt: 100 },
      ]),
    );
    localStorage.setItem(KEY_ACTIVE, 'u1');
    runtime.listSessionMessages.mockResolvedValue(
      historyPage(historyMessage(1, 'user', '你好')),
    );
    renderDock(false);
    await waitFor(() => expect(greeting()).toBeNull());

    // 列表里已有空会话 -> 复用那条，切过去
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));

    expect(greeting()).toBeInTheDocument();
  });

  it('样式：绝对定位居中 + 加粗，并把底部让开输入区', () => {
    renderDock(false);

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');
    const rule = css
      .split('}')
      .find((chunk) => chunk.includes('var(--dock-input-h'));

    expect(rule).toBeDefined();
    expect(rule).toContain('position:absolute');
    expect(rule).toContain('align-items:center');
    expect(rule).toContain('justify-content:center');
    expect(rule).toContain('font-weight:600');
    // 让开输入区那一条，否则比消息区中心低 60px
    expect(rule).toContain('inset-block:0 var(--dock-input-h');
    // 铺满消息区但不抢点击
    expect(rule).toContain('pointer-events:none');
  });

  it('对话区把输入区高度暴露成变量（问候语靠它对齐）', () => {
    renderDock(false);

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

    /*
     * ⚠️ 186 现在是**兜底值**，不是运行时的真相（2026-10-22）
     * -------------------------------------------------
     *   真实高度由 useInputRegionHeight 实测后写回同一个变量
     *   （Powered by 在没接 Copilot Cloud 时根本不渲染，实测比 186 小一截，
     *   写死常数会让 dock 离输入框四十来像素）。
     *   这条断言留着钉"兜底值存在" —— jsdom 里量不出几何（rect 全是 0），
     *   没有兜底值的话 emptyHint / 浮层在测试环境里会定位到 0。
     *   与它配套的仍是 textarea 的 4 行地板（见下一条）。
     */
    expect(css).toContain('--dock-input-h:186px');

    // 正文的 4 行地板必须与上面一致（line-height 1.5rem = 24px × 4）。
    const bubbleRule = css
      .split('}')
      .find((chunk) => chunk.includes('.copilotKitInput textarea'));
    expect(bubbleRule).toContain('min-height:96px');
  });
});

describe('人工审批卡片所在的那一层（样式）', () => {
  /**
   * 这一层是 absolute 的，几何全在 CSS 里，界面上错了就是"卡片压住输入框" ——
   * 而按钮还点得到，点下去动的却是输入框下面的东西。所以照本文件既有惯例
   * （上面那两条），把规则文本抓出来钉住。
   */
  const sheet = () =>
    Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

  it('贴在输入框上沿、靠底部对齐，且整层不抢点击', () => {
    renderDock(false);

    // ⚠️ 特征必须**指定到这一层**（z-index:3）
    // ------------------------------------
    //   原来只按 `inset-block` + `justify-content:flex-end` 找，而"贴输入框上沿"
    //   是好几层共用的手法（2026-10-13 新增的「正在整理上下文…」那层也是这两条），
    //   它排在 hitlLayer 前面就会被先找到 —— 拿捏不准的判据比没断言更糟：
    //   它会在别人新增一层时突然变红，而真正想钉的那层其实没坏。
    const rule = sheet()
      .split('}')
      .find(
        (chunk) =>
          chunk.includes('inset-block:0 var(--dock-input-h') &&
          chunk.includes('justify-content:flex-end') &&
          chunk.includes('z-index:3'),
      );

    expect(rule).toBeDefined();
    expect(rule).toContain('position:absolute');
    // 底边让开输入区 —— --dock-input-h 由 chatPane 提供（186px），
    // 这层是它的后代所以能继承到这个值；写错的话卡片会盖住输入框。
    expect(rule).toContain('z-index:3');
    // 消息区还要能滚动/选中，所以整层 pointer-events:none
    expect(rule).toContain('pointer-events:none');
  });

  it('卡片本体再把点击打开 —— 否则按钮连同底层一起被 pointer-events:none 屏蔽', () => {
    renderDock(false);

    // 卡片靠这两条与别的规则区分：清 fieldset 默认的 min-inline-size、
    // 以及自己重新打开 pointer-events。按它们定位，避免依赖哈希类名。
    const card = sheet()
      .split('}')
      .find((chunk) => chunk.includes('min-inline-size:0'));

    expect(card).toBeDefined();
    expect(card).toContain('pointer-events:auto');
  });
});

describe('历史对话抽屉（不常驻，点开才有）', () => {
  /**
   * 抽屉开没开的判据是 **`role="dialog"` 那个层在不在**。
   *
   * ⚠️ 不要再用 `queryByText('历史对话')` 判：返回按钮搬到了**一级标题**上
   *   （需求），而标题两态为了做转换动画是**常驻 DOM** 的（卸载就没有过渡可做），
   *   所以那句文案无论开没开都在 —— 用它当判据会永远为真。
   */
  const drawer = () => screen.queryByRole('dialog', { name: '历史对话' });

  it('默认收起：对话区上方没有会话列表', () => {
    renderDock(false);

    expect(drawer()).toBeNull();
    // 工具栏上的「历史对话」按钮必须在
    expect(
      screen.getByRole('button', { name: '历史对话' }),
    ).toBeInTheDocument();
  });

  /**
   * ⭐ 页面切换必须有动画（用户 2026-10-22：「点击新页面 / 历史页面，
   *   页面切换全部添加动画效果」）。
   *
   * 这一层原来的写法是 `historyOpen ? <div/> : null` —— 条件渲染只有进场没有退场，
   * 关掉的那一帧元素直接消失，CSS 过渡根本没机会跑。所以改成常驻挂载：
   * 关着也在 DOM 里，只是 aria-hidden + visibility:hidden。
   */
  it('⭐ 历史页常驻挂载：关着也在 DOM 里，只是 aria-hidden（退场动画的前提）', () => {
    const { container } = renderDock(false);

    const pane = container.querySelector(
      '[role="dialog"][aria-label="历史对话"]',
    );
    expect(pane).not.toBeNull();
    expect(pane).toHaveAttribute('aria-hidden', 'true');
    // 但按无障碍语义查不到（这就是"关着"的判据，别改成查 class）
    expect(drawer()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    // 打开时这个属性整个摘掉（而不是写成 "false"）
    expect(pane).not.toHaveAttribute('aria-hidden');
    expect(drawer()).not.toBeNull();
  });

  it('⭐ 两个页面之间是滑入滑出，不是硬切', () => {
    renderDock(false);

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');
    // 关闭态：往右退 24px + 透明
    expect(css).toContain('translateX(24px)');
    // 关：先让 opacity 走完再 hidden；开：立刻 visible（否则打开要等 0.22s）
    expect(css).toContain('visibility 0s linear 0.22s');
    expect(css).toContain('visibility 0s linear 0s');
  });

  /**
   * ⭐ 展开历史时，「放大」标签要收起来（用户：「展开对话历史的时候，
   *   扩大全屏就隐藏掉，只留 ‹ 历史对话」）。
   *
   * 收法是宽度收到 0（外壳负责），不是 display:none —— 后者会让标题栏
   * 左侧整块瞬间左移 32px，跟标题两态的淡入撞成一次闪烁。
   * 所以断言两件事：无障碍树里消失（查不到按钮）+ DOM 还在（能过渡）。
   */
  it('⭐ 展开历史时「放大」标签收起来，只留 ‹ 历史对话', () => {
    const { container } = renderDock(false);

    expect(
      screen.getByRole('button', { name: '把面板放大到半屏' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // 查不到（aria-hidden），但节点还在
    expect(
      screen.queryByRole('button', { name: '把面板放大到半屏' }),
    ).toBeNull();
    const tab = container.querySelector('[aria-label="把面板放大到半屏"]');
    expect(tab).not.toBeNull();
    // 也 Tab 不到
    expect(tab).toHaveAttribute('tabindex', '-1');
  });

  it('点「历史」展开列表，再点收起（aria-expanded 跟着变）', () => {
    renderDock(false);
    const toggle = screen.getByRole('button', { name: '历史对话' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(drawer()).not.toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(drawer()).toBeNull();
  });

  it('展开后能看到会话条目', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'used-1', title: '123123123', createdAt: 200, used: true },
        { id: 'blank-1', title: '新对话', createdAt: 100 },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(screen.getByText('123123123')).toBeInTheDocument();
  });

  it('⭐ 空会话不进历史列表 —— 列表为空时给空状态，而不是一排「新对话」', () => {
    renderDock(false);
    // 首屏只有一条自动建出来的空会话
    expect(conversations()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(screen.getByText('还没有历史对话')).toBeInTheDocument();
    expect(screen.queryByText('新对话')).toBeNull();
    // 计数也要是 0 个
    expect(screen.getByText('共 0 个')).toBeInTheDocument();
  });

  it('⭐ 只列用过的会话：夹在中间的空会话不出现', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'a', title: '聊过的', createdAt: 400, used: true },
        { id: 'e1', title: '新对话', createdAt: 300 },
        { id: 'b', title: '也聊过', createdAt: 200, used: true },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(screen.getByText('聊过的')).toBeInTheDocument();
    expect(screen.getByText('也聊过')).toBeInTheDocument();
    expect(screen.queryByText('新对话')).toBeNull();
    // 3 条里只有 2 条进列表
    expect(screen.getByText('共 2 个')).toBeInTheDocument();
  });

  it('⭐ 老数据兼容：有 sessionId 的（标题还是默认值）也算用过，会进历史', async () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'with-sid', title: '新对话', createdAt: 300, sessionId: 's-1' },
        { id: 'with-title', title: '你有什么能力', createdAt: 200 },
        { id: 'blank', title: '新对话', createdAt: 100 },
      ]),
    );
    renderDock(false);
    // 当前会话带 sessionId -> 会去拉历史；等它落地，免得留下 act 警告
    await waitFor(() =>
      expect(runtime.listSessionMessages).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // with-title 靠标题认出来
    expect(screen.getByText('你有什么能力')).toBeInTheDocument();
    // with-sid 标题还是「新对话」，但后端会话已经建了 —— 也算用过。
    // blank 才是真正没用过的，不进列表。所以是 2 个而不是 3 个。
    expect(screen.getByText('共 2 个')).toBeInTheDocument();
  });

  /**
   * ⭐ 回归：曾经抽屉铺满整个面板、连工具栏一起盖住 ——
   * 用户既看不到返回按钮，也点不到原「历史」按钮，只能刷新。
   *
   * 现在返回按钮**就是一级标题本身**（需求），所以这条同时验两件事：
   * 点它能关抽屉，且它不依赖工具栏上那个「历史」按钮。
   */
  it('返回按钮就是一级标题，点它关闭', () => {
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    expect(drawer()).not.toBeNull();

    const back = screen.getByRole('button', { name: '返回对话' });
    fireEvent.click(back);

    expect(drawer()).toBeNull();
  });

  it('⭐ 返回按钮与工具栏同处一个父节点 —— 它真的在标题栏上，不在抽屉里', () => {
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // 标题栏 = 那个同时装着「新建对话」按钮的容器
    const head = screen.getByRole('button', { name: '新建对话' }).parentElement
      ?.parentElement;
    expect(head).not.toBeNull();
    expect(
      head?.contains(screen.getByRole('button', { name: '返回对话' })),
    ).toBe(true);
    // 抽屉里**不再有**自己的头部行（原来那行「‹ 历史对话 / 共 N 个」是重复的）
    expect(head?.contains(drawer() as HTMLElement)).toBe(false);
  });

  /**
   * ⭐ 标题两态都常驻 DOM（否则没有过渡可做），靠 opacity + 位分切换。
   * 这条钉住"两态都在"这个前提 —— 将来有人图省事改成条件渲染，
   * 动画会静默退化成闪现，测试要拦住。
   */
  it('⭐ 标题两态同时在 DOM 里，靠 class 切换显隐（动画的前提）', () => {
    renderDock(false);

    const on = document.querySelectorAll('style');
    expect(on.length).toBeGreaterThan(0);
    // 收起时：「YTrader Harness」是显的那层
    expect(screen.getByText('YTrader Harness')).toBeInTheDocument();
    // 历史态的标题也在，只是透明
    expect(screen.getByText('历史对话')).toBeInTheDocument();

    const css = Array.from(on)
      .map((el) => el.textContent ?? '')
      .join('\n');
    // 两态的显隐 class 都要有 transition（0.24s），否则切换是"跳"的
    expect(css).toContain('opacity 0.24s ease');
    expect(css).toContain('transform 0.24s ease');
  });

  /**
   * ⭐ 字号口径（2026-10-18 历史列表放大过一档）：
   *
   *     面板标题        14px（正文默认）
   *     右侧纯图标按钮  16px
   *     历史条目标题    14px（与正文同级 —— 抽屉是"找上一条对话"的地方）
   *     历史分组标题    12px
   *     行尾时间 / 计数  12px / 13px
   *
   * 为什么标题和图标不"统一"成同一个值：面板只有 1/3 屏、标题区还要给右侧
   * 按钮让位 —— "标题 20px + 图标 24px" 头重脚轻，"图标 14px" 那个时钟又糊成
   * 一团。三项是有意的搭配，别顺手统一。
   *
   * 但**层级不能塌**：分组标题必须明显小于条目标题，否则「今天 / 昨天」会和
   * 会话标题糊成一片（这也是它没跟着放大到 14 的原因）。
   */
  it('⭐ 字号口径：标题 14px / 动作图标 16px / 条目 14px、分组 12px', () => {
    renderDock(false);

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

    // 标题层：正文默认字号（token.fontSize 在 antd v6 = 14px）
    const titleRule = css
      .split('}')
      .find(
        (chunk) =>
          chunk.includes('position:absolute') &&
          chunk.includes('font-weight:600'),
      );
    expect(titleRule).toBeDefined();
    expect(titleRule).toContain('font-size:14px');
    // 不许出现放大过的标题字号
    expect(titleRule).not.toContain('font-size:20px');
    expect(titleRule).not.toContain('font-size:16px');

    // 右侧动作图标：16px
    expect(css).toContain('font-size:16px');

    // 历史列表：条目 14px（同正文）、分组 12px、时间 12px、计数 13px
    expect(css).toContain('font-size:13px');
    expect(css).toContain('font-size:12px');
    // 放大后旧值必须消失（否则说明某条规则没改到）
    expect(css).not.toContain('font-size:12.5px');
    expect(css).not.toContain('font-size:11px');
  });

  it('⭐ 标题图标不单独放大（跟文字同为 14px，避免头重脚轻）', () => {
    renderDock(false);

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');
    // headTitleIcon 那条只有 line-height，没有 font-size
    const iconRule = css
      .split('}')
      .find(
        (chunk) => chunk.includes('line-height:1') && !chunk.includes('16px'),
      );
    expect(iconRule).toBeDefined();
    expect(iconRule).not.toContain('font-size:24px');
  });

  it('⭐ 放大标签与标题：横向留 8px、图标缩到 14px（只加横向，不加纵向）', () => {
    renderDock(false);

    expect(
      screen.getByRole('button', { name: '把面板放大到半屏' }),
    ).toBeInTheDocument();

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

    // 横向间距挂在外壳上（宽度也归它管，见 style.ts 的 wideTabSlot）
    const slotRule = css
      .split('}')
      .find((chunk) => chunk.includes('width:24px'));
    expect(slotRule).toBeDefined();
    expect(slotRule).toContain('margin-inline-end:8px');

    // 图标缩回 14px，与标题文字同字号 —— 用户说"缩小刚才添加的纵向高度"，
    // 原来跟右侧动作一起给的 16px 站在 14px 的文字旁边会高出一头。
    const btnRule = css
      .split('}')
      .find((chunk) => chunk.includes('--ant-button-only-icon-size:14px'));
    expect(btnRule).toBeDefined();
  });

  it('抽屉从工具栏下方开始（不盖住工具栏）', () => {
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // 打开抽屉后工具栏按钮仍可点 —— 这是"没被盖住"的行为证据
    // （happy-dom 量不出像素，定位本身由下面的样式表断言 + CDP 实测覆盖）
    expect(
      screen.getByRole('button', { name: '历史对话' }),
    ).toBeInTheDocument();

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');
    // historyPane 那条：absolute + 顶部让开标题栏高度（不是 inset: 0 铺满）。
    // ⚠️ 上偏移用 var(--dock-head-h)、**不再写死 48px** —— 与 head 高度同源，
    //   两处各写一个数字的话，改了标题栏高度就会露出缝 / 反过来盖住标题。
    const rule = css
      .split('}')
      .find(
        (chunk) =>
          chunk.includes('position:absolute') &&
          chunk.includes('inset-block:calc(var(--dock-head-h) + 1px) 0'),
      );
    expect(rule).toBeDefined();
    // 变量本身得在面板上定义，否则上面那句等于 inset-block: 0 0 —— 铺满盖住标题
    const def = css
      .split('}')
      .find((chunk) => chunk.includes('--dock-head-h:56px'));
    expect(def).toBeDefined();
  });

  it('抽屉里能看到会话总数', () => {
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(screen.getByText(/共 \d+ 个/)).toBeInTheDocument();
  });

  it('Esc 关闭抽屉（role="dialog" 该有的键盘出口）', () => {
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    expect(drawer()).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(drawer()).toBeNull();
  });

  it('抽屉关着时 Esc 不该有副作用', () => {
    renderDock(false);

    fireEvent.keyDown(document, { key: 'Escape' });

    // 仍是默认态：工具栏在、抽屉不在
    expect(
      screen.getByRole('button', { name: '历史对话' }),
    ).toBeInTheDocument();
    expect(drawer()).toBeNull();
  });
});

/**
 * 会话行右侧的「⋯」菜单（需求：不再单列删除图标，改为更多菜单）。
 */
describe('会话行「⋯」更多菜单', () => {
  const seedTwo = () =>
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'a', title: '留着这条', createdAt: 200, used: true },
        { id: 'b', title: '删掉这条', createdAt: 100, used: true },
      ]),
    );

  it('⭐ 行右侧只有「⋯」，没有单独的删除图标', () => {
    seedTwo();
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(
      screen.getByRole('button', { name: '更多操作 删掉这条' }),
    ).toBeInTheDocument();
    // 旧的单列删除按钮没了
    expect(
      screen.queryByRole('button', { name: '删除会话 删掉这条' }),
    ).toBeNull();
    // 时间是行尾单独一格（`14:05` / `昨天` / `9-12`），不再是 `MM-DD HH:mm` 的长串
    expect(screen.queryByText(/\d{2}-\d{2} \d{2}:\d{2}/)).toBeNull();
  });

  /**
   * ⭐ 蓝条要包住「⋯」，时间要落在行尾 —— 这两条是同一个结构决定的：
   * 底色挂在**行**（convRow）上，按钮和「⋯」都是它的子节点。
   *
   * 之前的形态是底色挂在按钮上、⋯ 是按钮的**兄弟** → 选中的那一行只有标题
   * 那半截是蓝的，⋯ 吊在蓝条外的白底上（用户截图里就是这样）。
   * 所以这里断言的是**结构**，不是颜色：只要 ⋯ 和 title 按钮同属一个有底色的行，
   * "在蓝条内部"就成立；哪天有人把 ⋯ 挪出去，这条会先红。
   */
  it('⭐ 时间在行尾、「⋯」与标题按钮同属那一行（蓝条包得住）', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'a',
          title: '当前这条',
          createdAt: now,
          updated_at: new Date(now).toISOString(),
          used: true,
        },
        { id: 'b', title: '另一条', createdAt: now - 1000, used: true },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    const more = screen.getByRole('button', { name: '更多操作 当前这条' });
    const row = more.closest('[data-conv-row]') as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row?.dataset.convRow).toBe('a');
    // 选中态标在行上（不是标在标题按钮上）
    expect(row?.dataset.active).toBe('true');
    expect(
      document
        .querySelector('[data-conv-row="b"]')
        ?.getAttribute('data-active'),
    ).toBe('false');

    // 标题按钮也在同一行里
    const item = screen.getByText('当前这条').closest('button');
    expect(item).not.toBeNull();
    expect(row?.contains(item as HTMLElement)).toBe(true);

    // 时间：行尾那一格，且在标题按钮内部（点它也算选中这条会话）
    const time = row?.querySelector('time');
    expect(time).not.toBeNull();
    // 今天 → 只给 `HH:mm`
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(item?.contains(time as HTMLElement)).toBe(true);
  });

  it('⭐ 点「⋯」弹出四个选项：删除 / 置顶 / 重命名 / 分享', async () => {
    seedTwo();
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作 删掉这条' }));

    const menu = await waitFor(() => {
      const el = document.querySelector('.ant-dropdown');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    for (const label of ['删除', '置顶', '重命名', '分享']) {
      expect(menu.textContent).toContain(label);
    }
  });

  it('只有「删除」可点，置顶 / 重命名 / 分享是禁用态', async () => {
    seedTwo();
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作 删掉这条' }));

    const menu = await waitFor(() => {
      const el = document.querySelector('.ant-dropdown');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // 禁用的项带 ant-dropdown-menu-item-disabled 类
    const items = Array.from(menu.querySelectorAll('.ant-dropdown-menu-item'));
    const byText = (t: string) =>
      items.find((el) => el.textContent?.trim() === t);
    expect(byText('删除')?.className).not.toContain('disabled');
    for (const t of ['置顶', '重命名', '分享']) {
      expect(byText(t)?.className).toContain('disabled');
    }
  });

  it('⭐ 点「删除」弹全局 confirm，确认后才真删', async () => {
    seedTwo();
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作 删掉这条' }));

    await waitFor(() =>
      expect(document.querySelector('.ant-dropdown')).not.toBeNull(),
    );
    fireEvent.click(
      screen.getByText('删除', {
        selector: '.ant-dropdown-menu-title-content',
      }),
    );

    // 全局 confirm（modal.confirm 的挂点是 body，不是面板内）
    const modal = await waitFor(() => {
      const el = document.querySelector('.ant-modal-confirm');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // 只是弹了框，还没删
    expect(conversations()).toHaveLength(2);

    // ⚠️ antd v6 会给「两个汉字」的按钮自动插空格，按文本找按钮前先去空白
    const ok = Array.from(modal.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').replace(/\s+/g, '').includes('删除'),
    );
    expect(ok).toBeDefined();
    fireEvent.click(ok as HTMLButtonElement);

    await waitFor(() => expect(conversations()).toHaveLength(1));
    expect((conversations()[0] as { id: string }).id).toBe('a');
  });

  it('confirm 里点「取消」不删', async () => {
    seedTwo();
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作 删掉这条' }));

    await waitFor(() =>
      expect(document.querySelector('.ant-dropdown')).not.toBeNull(),
    );
    fireEvent.click(
      screen.getByText('删除', {
        selector: '.ant-dropdown-menu-title-content',
      }),
    );

    const modal = await waitFor(() => {
      const el = document.querySelector('.ant-modal-confirm');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const cancel = Array.from(modal.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').replace(/\s+/g, '').includes('取消'),
    );
    expect(cancel).toBeDefined();
    fireEvent.click(cancel as HTMLButtonElement);

    // ⚠️ 只断言"没删"这一条业务结果，不断言弹层已从 DOM 消失：
    //   modal.confirm 的关闭带退场动画，happy-dom 下动画帧不推进，
    //   那个节点会一直留着 —— 拿它当断言等于在测动画计时器。
    expect(conversations()).toHaveLength(2);
  });
});

/**
 * 历史列表按「置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更久以前」分组。
 */
describe('历史列表时间分组', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** 契约给的是 ISO 字符串 —— 存储里就该是它 */
  const iso = (ms: number) => new Date(ms).toISOString();

  /**
   * ⚠️ 整组把 Date.now 钉在进入这一刻。
   *
   * 这里的用例全部用「now - 60_000」这种**相对此刻**的数据，而分组是按
   * **自然日**算的（见 data.ts 的 conversationGroupKey）—— 真实时钟只要在
   * 用例执行过程中跨过零点，"一分钟前"就从「今天」掉到「昨天」，
   * 断言会假红。2026-10-20 23:59 跑全量实测踩到：单跑必过、跨零点必红。
   * 钉住之后这些用例与运行时刻无关。
   */
  const frozenNow = Date.now();
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('⭐ 分组标题按 置顶 → 今天 → 昨天 → 7 天内 → 30 天内 → 更久以前 出现，空组不出现', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'p',
          title: '置顶的',
          createdAt: now - 90 * DAY,
          updated_at: iso(now - 90 * DAY),
          used: true,
          pinned: true,
        },
        {
          id: 't',
          title: '今天聊的',
          createdAt: now - 1000,
          updated_at: iso(now - 1000),
          used: true,
        },
        {
          id: 'y',
          title: '昨天聊的',
          createdAt: now - DAY,
          updated_at: iso(now - DAY),
          used: true,
        },
        {
          id: 's',
          title: '三天前聊的',
          createdAt: now - 3 * DAY,
          updated_at: iso(now - 3 * DAY),
          used: true,
        },
        {
          id: 'm',
          title: '二十天前聊的',
          createdAt: now - 20 * DAY,
          updated_at: iso(now - 20 * DAY),
          used: true,
        },
        {
          id: 'o',
          title: '很久以前聊的',
          createdAt: now - 200 * DAY,
          updated_at: iso(now - 200 * DAY),
          used: true,
        },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    const labels = Array.from(document.querySelectorAll('h3')).map(
      (el) => el.textContent ?? '',
    );
    expect(labels).toEqual([
      '置顶',
      '今天',
      '昨天',
      '7 天内',
      '30 天内',
      '更久以前',
    ]);
    // 计数按分组后的实际条数
    expect(screen.getByText('共 6 个')).toBeInTheDocument();
  });

  it('⭐ 今天的会话进「今天」，不再被塞进「7 天内」（这次报的 bug 的回归点）', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 't',
          title: '刚聊完的',
          createdAt: now - 60_000,
          updated_at: iso(now - 60_000),
          used: true,
        },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(screen.getByText('今天')).toBeInTheDocument();
    expect(screen.queryByText('7 天内')).toBeNull();
  });

  it('⭐ 超过 30 天的进「更久以前」，不再假装是「30 天内」', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'o',
          title: '去年的',
          createdAt: now - 400 * DAY,
          updated_at: iso(now - 400 * DAY),
          used: true,
        },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(screen.getByText('更久以前')).toBeInTheDocument();
    expect(screen.queryByText('30 天内')).toBeNull();
  });

  it('⭐ 没有置顶项时不显示「置顶」组', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'y',
          title: '昨天聊的',
          createdAt: now - DAY,
          updated_at: iso(now - DAY),
          used: true,
        },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    expect(screen.queryByText('置顶')).toBeNull();
    expect(screen.getByText('昨天')).toBeInTheDocument();
  });

  it('⭐ 组内按 updated_at 倒序（不是 createdAt）', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        // 建得早（60 天前）、聊得晚（刚聊完）—— 应该排第一
        {
          id: 'old-chat-new',
          title: '老对话新消息',
          createdAt: now - 60 * DAY,
          updated_at: iso(now - 1000),
          used: true,
        },
        // 建得晚（2 秒前）、聊得早（一分钟前）—— 应该排第二
        {
          id: 'new-chat-old',
          title: '新对话旧消息',
          createdAt: now - 2000,
          updated_at: iso(now - 60_000),
          used: true,
        },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // 两条都在「今天」这一组里，比较组内顺序。
    // 按**行**读顺序（`data-conv-row` 的值就是会话 id）—— 别抓按钮的
    // textContent：行尾多了时间那一格，拼出来的字符串不再是纯标题。
    const order = Array.from(document.querySelectorAll('[data-conv-row]')).map(
      (r) => r.getAttribute('data-conv-row'),
    );
    expect(order.indexOf('old-chat-new')).toBeLessThan(
      order.indexOf('new-chat-old'),
    );
  });

  it('⭐ 老数据没有 updated_at：回落到 createdAt，不至于全掉进「更久以前」', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'fresh', title: '刚建的', createdAt: now - 2000, used: true },
        {
          id: 'ancient',
          title: '很老的',
          createdAt: now - 200 * DAY,
          used: true,
        },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // 「刚建的」按 createdAt 落在今天；200 天前的落进「更久以前」兜底组
    expect(screen.getByText('今天')).toBeInTheDocument();
    expect(screen.getByText('更久以前')).toBeInTheDocument();
    expect(screen.queryByText('7 天内')).toBeNull();
  });

  it('⭐ 迁移：老字段 lastUpdateTime（毫秒数）也要认，否则老会话时间全失效', () => {
    const now = Date.now();
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        {
          id: 'legacy',
          title: '老版本存的',
          createdAt: now - 200 * DAY,
          lastUpdateTime: now - 60_000,
          used: true,
        },
      ]),
    );
    renderDock(false);
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // createdAt 是 200 天前，但 lastUpdateTime 是一分钟前 -> 应该进「今天」
    expect(screen.getByText('今天')).toBeInTheDocument();
    expect(screen.queryByText('更久以前')).toBeNull();
  });
});

describe('CopilotDock 面板（收起态）', () => {
  it('右侧完全不占位：宽度 0，只剩一个展开图标', () => {
    const { container } = renderDock(true);

    expect(panel(container)?.getAttribute('data-collapsed')).toBe('true');
    expect(dockWidth()).toBe('0px');
    expect(
      screen.getByRole('button', { name: '展开 AI 助手' }),
    ).toBeInTheDocument();
  });

  it('头部按钮随内容一起藏起来，但对话区仍挂载（收起 ≠ 卸载）', () => {
    renderDock(true);

    // display:none，不只是视觉上挪开
    expect(screen.queryByRole('button', { name: '新建对话' })).toBeNull();
    expect(screen.queryByRole('button', { name: '收起 AI 助手' })).toBeNull();
    // 卸载会把对话消息一起清掉，所以必须还在
    expect(screen.getByTestId('copilot-chat')).toBeInTheDocument();
  });

  it('点展开图标只是请示展开', () => {
    const { onCollapsedChange } = renderDock(true);

    fireEvent.click(screen.getByRole('button', { name: '展开 AI 助手' }));

    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('展开拉手定位在右下角（样式表里 position:fixed + bottom，不是竖中）', () => {
    renderDock(true);

    const tab = screen.getByRole('button', { name: '展开 AI 助手' });
    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

    // 找到 expTab 那条规则（emotion 类名带 expandTab 的哈希）
    const rule = css
      .split('}')
      .find(
        (chunk) =>
          chunk.includes('position:fixed') && chunk.includes('inset-block-end'),
      );
    expect(rule).toBeDefined();
    expect(rule).toContain('inset-block-end');
    // 竖中那套（inset-block-start: 50% + translateY）不该再出现
    expect(rule).not.toContain('translateY');
    expect(tab).toBeInTheDocument();
  });

  it('收起时也不丢会话（重新挂载后列表还在）', () => {
    // 种两条**用过的**会话（空会话只会留一条，测不出"丢没丢"）
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'a', title: '聊过的', createdAt: 200, used: true },
        { id: 'b', title: '也聊过', createdAt: 100, used: true },
      ]),
    );
    const first = renderDock(false);
    expect(conversations()).toHaveLength(2);
    first.unmount();

    renderDock(true);
    expect(conversations()).toHaveLength(2);
  });

  it('⭐ 重新挂载时顺手清掉历史遗留的重复空会话（只留一条）', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        { id: 'a', title: '聊过的', createdAt: 300, used: true },
        { id: 'e2', title: '新对话', createdAt: 200 },
        { id: 'e1', title: '新对话', createdAt: 100 },
      ]),
    );

    renderDock(true);

    const list = JSON.parse(localStorage.getItem(KEY_LIST) ?? '[]') as {
      id: string;
    }[];
    expect(list.map((c) => c.id)).toEqual(['a', 'e2']);
  });
});

describe('CopilotDock 面板（宽度变量生命周期）', () => {
  it('卸载时把 --copilot-dock-w 撤掉，不留孤儿变量', () => {
    const { unmount } = renderDock(false);
    expect(dockWidth()).toBe('400px');

    unmount();

    expect(dockWidth()).toBe('');
  });
});

/**
 * 左上角那枚「放大」标签 —— 只做 1/3 ↔ 半屏（2026-10-22 需求）。
 *
 * 三件事必须成立：
 *   ① 宽度真的变成 1/2（内容区的让位由同一个变量驱动，见 global.less）；
 *   ② 再点回到 1/3；
 *   ③ 它**不碰折叠** —— "收起"仍然只由右下角那颗球 / 头部箭头负责。
 */
describe('CopilotDock 面板：放大到半屏', () => {
  const wideTab = (container: HTMLElement) =>
    container.querySelector(
      'button[aria-label="把面板放大到半屏"]',
    ) as HTMLElement | null;

  it('⭐ 点一下 → 宽度变 1/2；再点一下 → 回到 1/3', () => {
    const { container } = renderDock(false);

    // 1200 / 3
    expect(dockWidth()).toBe('400px');

    fireEvent.click(wideTab(container) as HTMLElement);
    // 1200 / 2
    expect(dockWidth()).toBe('600px');
    // 按钮自己换成"还原"那一档（同一个位置、同一个 aria-pressed 开关）
    expect(panel(container)?.hasAttribute('data-wide')).toBe(true);
    expect(
      container.querySelector('button[aria-label="把面板还原为三分之一"]'),
    ).not.toBeNull();

    fireEvent.click(
      container.querySelector(
        'button[aria-label="把面板还原为三分之一"]',
      ) as HTMLElement,
    );
    expect(dockWidth()).toBe('400px');
    expect(panel(container)?.hasAttribute('data-wide')).toBe(false);
  });

  it('★ 放大之后改窗口大小，仍然是 1/2（不被打回 1/3）', () => {
    const { container } = renderDock(false);
    fireEvent.click(wideTab(container) as HTMLElement);

    setViewportWidth(1600);
    fireEvent(window, new Event('resize'));

    expect(dockWidth()).toBe('800px');
  });

  it('放大态下「收起」照旧工作，而且不会顺手把档位改回去', () => {
    const { container, onCollapsedChange } = renderDock(false);
    fireEvent.click(wideTab(container) as HTMLElement);

    fireEvent.click(
      container.querySelector(
        'button[aria-label="收起 AI 助手"]',
      ) as HTMLElement,
    );

    // 收起是**受控**的：本组件只负责举手，真正改状态的是布局层。
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    // 档位没被顺手改掉 —— 再展开回来还是用户选的半屏。
    expect(panel(container)?.hasAttribute('data-wide')).toBe(true);
  });
});

/**
 * 对话区的**三档间距**（需求 2026-10-20 定死的唯一口径）。
 *
 *   ① 最小档：section 内部（思考 / 正文 / 工具框，相邻子项之间）
 *   ② 中档：卡片 ↔ 卡片下方那行图标（复制 / 编辑 / 反馈）
 *   ③ 最大档：section ↔ section
 *
 * 为什么值得钉：这套东西**全在 CSS 里**，而且刚经历过"2 / 4 / 8 / 12 四种间距
 * 同时存在"的乱局（gap 2px + 负 margin + 库自带 margin + 条件 padding 叠出来）。
 * 谁"顺手"给某个元素补一个 margin，界面上只是"没那么整齐"，测试不红就没人发现。
 *
 * ⚠️ 断言里的数值来自 style.ts 导出的常量，不是写死的字面量 —— 调档位时
 *    只改常量，这里自动跟着走；真正要守的是"只有这三档、且各归各位"。
 */
describe('对话区三档间距（样式表）', () => {
  const sheet = () =>
    Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

  /**
   * 按选择器片段取一条规则：先按 } 切块，再把"块"和"要找的选择器"**两边都
   * 去掉空白**再比。
   *
   * ⚠️ 两边都要归一化：emotion 输出的是压缩后的 CSS（`a>b+c{...}`），而这里
   *    写的是人看得懂的 `a > b + c` —— 只归一化一边就永远匹配不上（本文件
   *    第一版就是这么假绿的：断言写对了、选择器没找到，报的是 toBeDefined）。
   */
  const ruleOf = (sheetText: string, selector: string) => {
    const target = selector.replace(/\s+/g, '');
    return sheetText
      .split('}')
      .find((chunk) => chunk.replace(/\s+/g, '').includes(target));
  };

  it('section 内部：相邻子项一律最小档（思考 / 正文 / 工具框同间距）', () => {
    renderDock(false);
    const css = sheet();

    const rule = ruleOf(css, '[data-section-view]>*+*{');
    expect(rule).toBeDefined();
    expect(rule).toContain(`margin-top:${SPACE_TIGHT}px`);
  });

  it('先归零：section 的直接子项不许自带 margin', () => {
    renderDock(false);
    const css = sheet();

    const rule = ruleOf(css, '[data-section-view]>*{');
    expect(rule).toBeDefined();
    expect(rule).toContain('margin-block:0');
  });

  it('卡片 ↔ 图标行：中档', () => {
    renderDock(false);
    const css = sheet();

    const rule = ruleOf(css, "[data-section-view]>[data-user-actions='true']{");
    expect(rule).toBeDefined();
    expect(rule).toContain(`margin-top:${SPACE_MID}px`);

    // 助手那一侧同理（库把反馈行放在消息块内部，只能用后代选择器）。
    const controls = ruleOf(
      css,
      '.copilotKitAssistantMessage .copilotKitMessageControls{',
    );
    expect(controls).toBeDefined();
    expect(controls).toContain(`margin-top:${SPACE_MID}px`);
    // 库给的 padding-top 5px 会叠在 margin 上，必须清掉。
    expect(controls).toContain('padding:0');
    // ⚠️ 这里不再写"不许出现 12 / 24"那种数值守卫：档位一轮轮调下来，
    //    中档就等于 24，那条守卫会和档位表直接打架。现在守的是"跟着常量走"
    //    （上面那条），数值该是多少由 style.ts 一处决定。
    //
    // 顺带守住"用 margin 占位、不用 top 偏移"（top 不占位，图标会溢出消息块）。
    expect(controls).toContain('position:relative');
    expect(controls).not.toMatch(/[{;]top:/);
  });

  it('卡片 ↔ 卡片：最大档', () => {
    renderDock(false);
    const css = sheet();

    const rule = ruleOf(css, '[data-section-view]+[data-section-view]{');
    expect(rule).toBeDefined();
    expect(rule).toContain(`margin-top:${SPACE_WIDE}px`);
  });

  it('⭐ 工具卡与"它自己这一步"之间：最小档（思考 / 正文 / 工具四条缝同一挡位）', () => {
    // 用户 2026-10-21：「ABCD 的间距不是应该都一样吗？都属于统一挡位的」
    renderDock(false);
    const css = sheet();

    const first = ruleOf(
      css,
      "[data-section-view='chat']+[data-section-view='tool'][data-section-step-attached='true']{",
    );
    expect(first).toBeDefined();
    expect(first).toContain(`margin-top:${SPACE_TIGHT}px`);

    const between = ruleOf(
      css,
      "[data-section-view='tool']+[data-section-view='tool']{",
    );
    expect(between).toBeDefined();
    expect(between).toContain(`margin-top:${SPACE_TIGHT}px`);
  });

  it('⭐ 一组工具卡的**最后一张** -> 下一步：最大档（一步的边界）', () => {
    renderDock(false);
    const css = sheet();

    const rule = ruleOf(
      css,
      "[data-section-view='tool'][data-section-step-end='true']+[data-section-view]{",
    );
    expect(rule).toBeDefined();
    expect(rule).toContain(`margin-top:${SPACE_WIDE}px`);
  });

  it('⭐ 库自带的「三点跳动」loading 不再显示（2026-10-21 用户要求去掉）', () => {
    renderDock(false);
    const css = sheet();

    /*
     * 库有两个地方画那三个蓝点（AssistantMessage 的 isLoading、Messages 末尾
     * 的 inProgress）：都是 `<span data-testid="copilot-loading-cursor">`。
     * 我们只留输入框上沿那枚胶囊。断言写成"选择器 + display:none"的宽松形态
     * —— emotion 会不会给属性值加引号不该影响这条用例。
     */
    expect(css).toMatch(
      /\[data-testid=.?copilot-loading-cursor.?\]\s*\{\s*display:\s*none/,
    );
  });

  it('档位不递减，最大档严格更大', () => {
    // ⚠️ 一二档**允许相等**：用户 2026-10-21 明确「二档间距和一档相同即可」
    //    （图标行与卡片内部现在都是 24）。但"卡片之间"必须**严格**更大，
    //    否则层级就塌成一片，三档这件事本身没有意义了。
    expect(SPACE_TIGHT).toBeLessThanOrEqual(SPACE_MID);
    expect(SPACE_MID).toBeLessThan(SPACE_WIDE);
  });
});

/**
 * markdown 正文的"窄面板"覆盖样式。
 *
 * 为什么值得钉：这些规则补的是**库的缺口**，不是我们的偏好 ——
 *   · @copilotkit/react-ui 的 index.css 里**完全没有 table / th / td 规则**，
 *     defaultComponents 也没映射表格（只映射 a/code/h1~h6/p/pre/blockquote/ul/li）。
 *     GFM 表格于是落到浏览器默认样式：CDP 实测 border-collapse:separate、
 *     边框 0、th padding 1px，宽度被内容撑到 417px > 容器 372px，右列文字
 *     糊出消息框 —— 这就是用户报的"显示非常乱"的真正原因（并不是没渲染 md）。
 *   · 围栏代码块的**工具栏**：库给了 width:100% + padding-left:1rem 却没设
 *     box-sizing，盒子变成 372+16=388，比圆角外框宽 16px。
 * 一旦谁把这些规则删掉/改跑，界面上只是"变乱"，测试不红就没人发现，所以钉住。
 * （几何值不好在 happy-dom 里量，这里只断言样式表里规则存在且取值正确。）
 */
describe('markdown 正文（窄面板覆盖样式）', () => {
  const sheet = () =>
    Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

  /** 从样式表里捞出含某个选择器的那条规则。 */
  const ruleFor = (selector: string) =>
    sheet()
      .split('}')
      .find((chunk) => chunk.includes(selector));

  it('表格：折叠边框 + 固定列宽 + 撑满容器（消灭 417 > 372 的溢出）', () => {
    renderDock(false);

    const rule = ruleFor('.copilotKitMarkdown table');
    expect(rule).toBeDefined();
    expect(rule).toContain('width:100%');
    expect(rule).toContain('max-width:100%');
    // fixed 是故意的：auto 会按内容比例分宽度，一串长行内代码能把说明列挤没
    expect(rule).toContain('table-layout:fixed');
    expect(rule).toContain('border-collapse:collapse');
  });

  it('单元格：画 1px 边框 + 内边距，并允许长 token 在窄列里断行', () => {
    renderDock(false);

    const rule = ruleFor('.copilotKitMarkdown td');
    expect(rule).toBeDefined();
    expect(rule).toContain('padding:6px 8px');
    expect(rule).toContain('text-align:left');
    expect(rule).toContain('vertical-align:top');
    // break-word 压不住 min-content，必须 anywhere，否则列宽又被顶回去
    expect(rule).toContain('overflow-wrap:anywhere');
  });

  it('表头有底色区分', () => {
    renderDock(false);

    const rule = ruleFor('.copilotKitMarkdown th{');
    expect(rule).toBeDefined();
    expect(rule).toContain('font-weight:600');
  });

  it('⭐ 标题收窄一档，且选择器带上 copilotKitMarkdownElement（赢库的特异性）', () => {
    renderDock(false);

    const css = sheet();
    // ⚠️ 这里必须「选择器 + 声明」连着断言：h1~h6 有一条**成组**的 margin 规则，
    //   只按选择器 find 会命中那条成组规则、拿不到各自的 font-size（第一版就栽了）。
    // 库给 h2 是 1.25em(20px)，在 372px 面板里太大 → 收到 1.125em
    expect(css).toContain('h1.copilotKitMarkdownElement{font-size:1.25em');
    expect(css).toContain('h2.copilotKitMarkdownElement{font-size:1.125em');
    expect(css).toContain('h3.copilotKitMarkdownElement{font-size:1em');
    // 库只给 margin-bottom、没有 margin-top，标题会贴住上一段
    expect(css).toContain('margin-top:1.25em');
  });

  it('行内代码在窄栏里可以在任意位置断行', () => {
    renderDock(false);

    const rule = ruleFor('.copilotKitMarkdown .copilotKitInlineCode');
    expect(rule).toBeDefined();
    expect(rule).toContain('overflow-wrap:anywhere');
  });

  it('⭐ 围栏代码块的工具栏改 border-box（库的 388 撑破 372 圆角框）', () => {
    renderDock(false);

    const rule = ruleFor('.copilotKitMarkdown .copilotKitCodeBlockToolbar');
    expect(rule).toBeDefined();
    expect(rule).toContain('box-sizing:border-box');
  });

  it('⭐ 有序列表补回编号（库没有 ol 规则，会被全局重置吃成 none）', () => {
    renderDock(false);

    // 库的 defaultComponents 只映射 ul / li，**不映射 ol** → 那条 ol 是裸元素，
    // 于是项目全局的 `ul, ol { list-style: none }` 把它重置成 none；
    // 而库又把 li 设成 list-style-type: inherit → 编号整排消失（只剩缩进）。
    // ul 之所以没事，是因为库有 ul.copilotKitMarkdownElement{list-style-type:disc}。
    const rule = ruleFor('.copilotKitMarkdown ol');
    expect(rule).toBeDefined();
    expect(rule).toContain('list-style-type:decimal');
    // 缩进对齐 ul，否则同一个回答里两种列表一个缩进一个不缩进
    expect(rule).toContain('padding-left:20px');
  });
});

/**
 * 接入后端的两个会话端点：
 *   GET    /sessions            挂载时并进本地账本
 *   DELETE /sessions/{id}       删除（后端是**归档**，消息仍保留）
 *
 * ⚠️ 这一组盯的是**顺序**：「先接口、后本地」。
 *   反过来写也能通过"点了就消失"的用例，但接口一失败就是假删除 ——
 *   界面上没了、后端还在，换设备后它又冒回来。
 */
describe('接入后端会话列表与删除', () => {
  const remoteSession = (sessionId: string, updatedAt: string) => ({
    session_id: sessionId,
    agent_id: 'assistant_dock',
    status: 'active' as const,
    user_id: 'u-1',
    updated_at: updatedAt,
  });

  const seed = (list: unknown[]) =>
    localStorage.setItem(KEY_LIST, JSON.stringify(list));

  /** 点开抽屉 → 点某条的 ⋯ → 选删除 → 确认。 */
  const deleteViaMenu = async (title: string) => {
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(screen.getByRole('button', { name: `更多操作 ${title}` }));

    // 菜单项是 menuitem，跟确认框里的「删除」按钮不同角色 —— 别用同一个查询
    const item = await screen.findByRole('menuitem', { name: /删\s*除/ });
    // 菜单收起、Modal 弹出都带一轮异步状态更新，包 act 免得刷一堆警告
    await act(async () => {
      fireEvent.click(item);
    });

    // ⚠️ antd 的 Button 会在**两个汉字之间插一个空格**（autoInsertSpace），
    //   所以可及名字是「删 除」而不是「删除」—— 用 `'删除'` 精确匹配会找不到。
    const ok = await screen.findByRole('button', { name: /^删\s*除$/ });
    await act(async () => {
      fireEvent.click(ok);
    });
  };

  it('⭐ 每次打开抽屉都重新校准（不以本地缓存为准）', async () => {
    renderDock(false);
    await waitFor(() => expect(runtime.listSessions).toHaveBeenCalledTimes(1));

    // 打开抽屉 → 再拉一次：用户看到列表的那一刻要等于后端此刻的样子
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    await waitFor(() => expect(runtime.listSessions).toHaveBeenCalledTimes(2));

    // 收起再打开 → 又一次（关的那一下不拉）
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    await waitFor(() => expect(runtime.listSessions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    await waitFor(() => expect(runtime.listSessions).toHaveBeenCalledTimes(3));
  });

  it('⭐ 后端没有的会话会被剔除（complete 时以 sessions 为准）', async () => {
    seed([
      {
        id: 'a',
        title: '后端还有',
        createdAt: 400,
        used: true,
        sessionId: 's-1',
      },
      {
        id: 'b',
        title: '别的设备删了',
        createdAt: 300,
        used: true,
        sessionId: 's-2',
      },
    ]);
    // 拿全了（total === items.length），且只有 s-1
    runtime.listSessions.mockResolvedValue({
      items: [remoteSession('s-1', '2026-10-18T02:00:00.000Z')],
      total: 1,
    });

    renderDock(false);

    await waitFor(() =>
      expect(conversations().map((c) => (c as { id: string }).id)).toEqual([
        'a',
      ]),
    );
  });

  it('⭐ 分页没取全（total > 条数）时不剔除本地条目', async () => {
    seed([
      {
        id: 'a',
        title: '第 1 页',
        createdAt: 400,
        used: true,
        sessionId: 's-1',
      },
      {
        id: 'b',
        title: '在第 2 页',
        createdAt: 300,
        used: true,
        sessionId: 's-2',
      },
    ]);
    runtime.listSessions.mockResolvedValue({
      items: [remoteSession('s-1', '2026-10-18T02:00:00.000Z')],
      total: 250,
    });

    renderDock(false);

    await waitFor(() => expect(runtime.listSessions).toHaveBeenCalled());
    // 等一次落盘，确认没有被误删
    await waitFor(() =>
      expect(conversations().map((c) => (c as { id: string }).id)).toEqual([
        'a',
        'b',
      ]),
    );
  });

  it('挂载时拉一次列表，把后端有、本地没有的会话补进来', async () => {
    runtime.listSessions.mockResolvedValue({
      items: [remoteSession('s-9', '2026-10-18T02:00:00.000Z')],
      total: 1,
    });

    renderDock(false);

    // 只拉第一页、且取上限（契约 page_size le=100）
    await waitFor(() =>
      expect(runtime.listSessions).toHaveBeenCalledWith({ page_size: 100 }),
    );
    // 落进本地账本 = 换设备/清缓存之后还能看见它
    await waitFor(() =>
      expect(
        conversations().some(
          (c) => (c as { sessionId?: string }).sessionId === 's-9',
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    // 补回来的条目也进列表（标题是占位，靠计数确认它确实在）
    expect(screen.getByText('共 1 个')).toBeInTheDocument();
  });

  it('列表接口失败不影响面板打开（静默降级成纯本地账本）', async () => {
    runtime.listSessions.mockRejectedValue(new Error('405 Method Not Allowed'));
    seed([{ id: 'a', title: '聊过的', createdAt: 400, used: true }]);

    renderDock(false);

    await waitFor(() => expect(runtime.listSessions).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));

    // 本地那条照旧在，也没有任何错误提示怼到用户脸上
    expect(screen.getByText('聊过的')).toBeInTheDocument();
    expect(screen.queryByText(/删除失败|加载失败/)).toBeNull();
  });

  it('⭐ 删除：先打 DELETE，成功了才从本地账本删掉', async () => {
    seed([
      {
        id: 'a',
        title: '聊过的',
        createdAt: 400,
        used: true,
        sessionId: 's-1',
      },
      {
        id: 'b',
        title: '另一条',
        createdAt: 300,
        used: true,
        sessionId: 's-2',
      },
    ]);
    renderDock(false);

    await deleteViaMenu('聊过的');

    await waitFor(() =>
      expect(runtime.deleteSession).toHaveBeenCalledWith('s-1'),
    );
    // 本地那条被删掉，另一条不受影响
    await waitFor(() =>
      expect(
        conversations().map((c) => (c as { id: string }).id),
      ).not.toContain('a'),
    );
    expect(conversations().map((c) => (c as { id: string }).id)).toContain('b');
  });

  it('⭐ 删除失败：本地条目必须留着（否则就是"假删除"）', async () => {
    seed([
      {
        id: 'a',
        title: '聊过的',
        createdAt: 400,
        used: true,
        sessionId: 's-1',
      },
    ]);
    runtime.deleteSession.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 404, data: { detail: '会话不存在' } },
      }),
    );

    renderDock(false);
    await deleteViaMenu('聊过的');

    // 原因要露出来（后端的 detail 优先，别退化成一句 HTTP 404）
    expect(await screen.findByText(/会话不存在/)).toBeInTheDocument();
    // 关键：本地一条都没少
    expect(conversations().map((c) => (c as { id: string }).id)).toContain('a');
  });

  it('没有 sessionId 的会话（后端还没建）直接删本地，不打接口', async () => {
    seed([
      { id: 'local-only', title: '没发过消息', createdAt: 400, used: true },
    ]);
    renderDock(false);

    await deleteViaMenu('没发过消息');

    await waitFor(() =>
      expect(
        conversations().map((c) => (c as { id: string }).id),
      ).not.toContain('local-only'),
    );
    // 后端压根没有这条，打过去只会拿 404
    expect(runtime.deleteSession).not.toHaveBeenCalled();
  });
});
