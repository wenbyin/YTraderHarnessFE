// src/components/CopilotDock/index.tsx
//
// 全局 AI 助手：**固定在视口右侧、贯穿整高的常驻面板** —— 左侧菜单的镜像。
//
// 五条设计约束（需求点名的，改这个文件时别破）：
//
//   1. **常驻，不是浮动按钮 + 弹窗**。它挂在路由之外（见 src/app.tsx 的 childrenRender），
//      切页面时压根不卸载，对话一直在。
//   2. **收起 = 右侧完全不占位**。宽度归 0，内容区拿回全部宽度，只留一个贴边竖中的
//      展开图标（expandTab）。
//   3. **展开 = 可视宽度的 1/3，可放大到 1/2**。宽度由 panelWidth() 算
//      （clientWidth / 3 或 / 2），写进 :root 的 --copilot-dock-w；内容区让位由
//      src/global.less 消费这个变量给 .ant-pro-layout 加等宽 margin-right ——
//      面板自己不占文档流，让位是布局层的事。
//      ⚠️ "放大到半屏"是**面板自己的档位**（`wide`，只有 1/3 ↔ 1/2 两档），
//         与"收起/展开"是两个独立开关：左上角那枚图标改档位，收起仍然走
//         右下角悬浮球 / 头部箭头。
//   4. **跟左侧菜单互斥**：展开这边就把那边收起来。折叠状态由 src/app.tsx 统一持有
//      （受控组件），本文件只负责「显示成什么样」+「用户点了要变成什么」。
//   5. **消息用 CopilotKit 原生样式**，只把外观换成卡片（见 style.ts 的 chatPane）。
//      但**输入框不是库的默认实现** —— 见下面的 composer 说明。
//
// 后端接的是 YTraderHarness 的 Agent Runtime API（会话 / 运行），但**不是** CopilotKit
// Runtime：后端是自研 REST（/api/v1/sessions...），没有 /api/copilotkit 这个服务。
// 所以不走 runtimeUrl，而是把面板自己的 agent（agent.ts）直接交给 provider
// （agents__unsafe_dev_only）—— 聊天界面照旧用 CopilotKit 原生的。
//
// 回复是**流式**来的：发消息 → 建一次运行 → 订阅 GET /runs/{run_id}/events，
// 后端的 message.delta 逐帧翻成界面上的文字（翻译见 runEventStream.ts）。
import {
  DeleteOutlined,
  EditOutlined,
  ExpandAltOutlined,
  HistoryOutlined,
  LeftOutlined,
  MoreOutlined,
  PlusOutlined,
  PushpinOutlined,
  RightOutlined,
  RobotOutlined,
  ShareAltOutlined,
  ShrinkOutlined,
} from '@ant-design/icons';
import { CopilotKit } from '@copilotkit/react-core';
import { CopilotChat } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import type { MenuProps } from 'antd';
import { App, Button, Dropdown, Spin, Tooltip } from 'antd';
import { cx } from 'antd-style';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { DOCK_AGENT_ID, DockAgent } from './agent';
import {
  createSession,
  DEFAULT_AGENT_ID,
  deleteSession,
  describeRuntimeError,
  listSessions,
} from './agentRuntime';
import Composer from './Composer';
import DockRenderMessage from './DockRenderMessage';
import {
  type ConversationGroup,
  type CopilotConversation,
  type DockState,
  formatConversationTime,
  groupConversations,
  hasStartedConversation,
  panelWidth,
  readDockState,
  reconcileWithSessions,
  withFirstMessage,
  withNewConversation,
  withRemovedConversation,
  withSessionId,
  writeDockState,
} from './data';
import HitlInterrupt from './HitlInterrupt';
import LiveActivityOverlay from './LiveActivityOverlay';
import { setLiveToolItems } from './liveToolFeed';
import { CHAT_ACTION_ICONS } from './messageActionIcons';
import RunResume from './RunResume';
import { useReasoningStream } from './reasoningStream';
import { useStyles } from './style';
import { rememberToolStatuses } from './toolStatusCache';
import { useAgentHasMessages } from './useAgentMessages';
import { useHiddenWork } from './useHiddenWork';
import { useInputRegionHeight } from './useInputRegionHeight';
import { usePlanFeed } from './usePlanFeed';
import { useSessionHistory } from './useSessionHistory';
import { useSmoothFollow } from './useSmoothFollow';
import { useToolActivity } from './useToolActivity';

/** 面板宽度广播到 :root 的变量名，消费方是 src/global.less 里的 .ant-pro-layout。 */
const WIDTH_VAR = '--copilot-dock-w';

/**
 * 拉后端会话列表的页大小 —— 取契约上限（`page_size` le=100）。
 *
 * 取上限是为了让"后端就是全量"这件事尽量成立：只有 `total <= items.length`
 * 时才允许按后端剔除本地条目（见 `refreshSessions` 里的 `complete`）。
 * 真超过 100 条时自动退化成"只并集、不剔除"，不会误删第 2 页之外的会话。
 */
const REMOTE_SESSION_PAGE_SIZE = 100;

export interface CopilotDockProps {
  /** 折叠状态由布局层（app.tsx 的 initialState）持有 —— 它要跟左侧菜单做互斥。 */
  collapsed: boolean;
  /** 请求把面板换成某个折叠状态（展开这边时，app.tsx 会顺手把左侧菜单收起来）。 */
  onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * 面板宽度靠 CSS 变量广播出去，内容区据此让位（消费方是 src/global.less 里的 .ant-pro-layout）。
 * 走 CSS 变量而不是直接改 DOM：让位属于布局层的事，面板只负责说自己有多宽 ——
 * 而且这样宽度变化天然能吃到 CSS transition，展开/收起有过渡。
 *
 * 两个 effect 分开是有意的：宽度 effect 在 collapsed 变化时要重新注册 resize 监听
 * （闭包里的 collapsed 得是新的），所以它不能把变量的清理也带上 ——
 * 否则每次切换都会先 removeProperty 再 setProperty，中间那一帧白白丢掉过渡。
 *
 * ⚠️ `wide`（1/3 ↔ 1/2）也要进依赖：同一个理由 —— 闭包里得是新值，
 *    否则放大之后一改窗口大小就被打回 1/3。
 */
function useDockWidth(collapsed: boolean, wide: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    // clientWidth 跟 .ant-pro-layout 的实际宽度同源；用 vw 会把纵向滚动条也算进去。
    const sync = () =>
      root.style.setProperty(
        WIDTH_VAR,
        `${panelWidth(collapsed, root.clientWidth, wide)}px`,
      );
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [collapsed, wide]);

  // 面板卸载（正常不会发生，它常驻）时才把变量撤掉，免得留下一个孤儿变量。
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty(WIDTH_VAR);
    },
    [],
  );
}

const CopilotDock: React.FC<CopilotDockProps> = ({
  collapsed,
  onCollapsedChange,
}) => {
  const { styles } = useStyles();
  const [state, setState] = useState<DockState>(() => readDockState());

  /**
   * 面板是不是"放大到半屏"（否则就是默认的 1/3）。
   *
   * ⚠️ 为什么不和 `collapsed` 一样交给布局层持有（2026-10-22）
   * ----------------------------------------------------
   *   `collapsed` 上移是因为**跟左侧菜单互斥**，那是布局的事；"我这半屏还是
   *   三分之一"只有面板自己关心，布局层拿到它也没别的用途。
   *   也**不落盘**：和折叠状态同一个口径（见 data.ts 的 DockState），
   *   刷新回默认的 1/3。
   */
  const [wide, setWide] = useState(false);

  useDockWidth(collapsed, wide);

  /**
   * 渲染期把最新 state 挂到 ref 上。
   * 理由：ensureSession 要读「这个对话建过后端会话没有」，但它是异步的、而且被
   * agent 持有（agent 本身不想因为每来一条消息就重建），所以不能让它的闭包
   * 依赖 state —— 读到旧 state 会导致重复建会话。
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 本地会话 id → 「正在建的后端会话」的 promise：两手同时发消息也只建一个。 */
  const sessionTasks = useRef(new Map<string, Promise<string>>());

  /**
   * 真正去后端建一个会话，返回 id。
   *
   * 建完把 id 记回本地会话（data.ts 的 withSessionId）；失败就把 inflight 记录
   * 清掉 —— 否则那个 rejected 的 promise 会被当成"正在建"一直复用，
   * 之后每一轮都失败。
   */
  const newSession = useCallback((conversationId: string): Promise<string> => {
    const task = createSession({
      agent_id: DEFAULT_AGENT_ID,
      // 能写不能读（契约里 Session 不含 metadata），只用于后端排查时认出是谁建的
      metadata: { conversation_id: conversationId },
    })
      .then((session) => {
        setState((s) => withSessionId(s, conversationId, session.session_id));
        return session.session_id;
      })
      .catch((error: unknown) => {
        sessionTasks.current.delete(conversationId);
        throw error;
      });

    sessionTasks.current.set(conversationId, task);
    return task;
  }, []);

  /**
   * 确保当前对话在后端存在。**懒建**：新建对话时不建（用户可能只是开了个空对话），
   * 第一次真发消息时才建。
   */
  const ensureSession = useCallback(
    (conversationId: string): Promise<string> => {
      const known = stateRef.current.conversations.find(
        (c) => c.id === conversationId,
      )?.sessionId;
      if (known) return Promise.resolve(known);

      return (
        sessionTasks.current.get(conversationId) ?? newSession(conversationId)
      );
    },
    [newSession],
  );

  /**
   * 丢掉本地缓存的会话 id，**重建一个**。
   *
   * 为什么需要：会话 id 落在本地存储里（data.ts），后端换库 / 清库 / 重启之后
   * 那个 id 就成了死 id —— `POST /sessions/{id}/runs` 一律 404。
   * agent 在收到这个 404 时会调它自愈一次，而不是让用户手动删会话。
   *
   * ⚠️ 必须**同步**地清掉 inflight 再建：重建后 agent 紧接着可能再问一次
   * `ensureSession`，那时 state 还没更新完（React 是异步的），只有从这个
   * map 里拿到新 task 才不会又返回那个死 id。
   */
  const renewSession = useCallback(
    (conversationId: string): Promise<string> => {
      sessionTasks.current.delete(conversationId);
      return newSession(conversationId);
    },
    [newSession],
  );

  // 状态一变就落盘。放 effect 里而不是每个回调里写一遍 —— 少一处遗漏的可能。
  useEffect(() => {
    writeDockState(state);
  }, [state]);

  /** 卸载后别再 setState（面板常驻，但测试会卸载）。 */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /**
   * 从后端拉一次会话列表，用它**校准**本地账本。
   *
   * 这是"数据以 sessions 为准"的唯一入口 —— 成员、时间、顺序都由后端决定，
   * 本地只留两样后端给不了的东西：**标题**（契约里 Session 没有 title）和
   * **还没发过消息的草稿会话**。所以这不是"合并缓存"，是"以后端为准对齐"：
   * 后端没有的条目会被删掉（见 reconcileWithSessions 的三条例外）。
   *
   * ⚠️ 什么时候调
   *   · 挂载时一次；
   *   · **每次打开历史抽屉**（用户看到列表的每一刻都该是后端此刻的样子，
   *     哪怕他刚从另一台设备删过一条）；
   *   · 删除成功之后（校准一次，防止本地和后端各说各话）。
   *
   * ⚠️ 失败**静默**：老后端没有这条路由（405）、断网、令牌过期，都不该在
   *   对话区弹错误 —— 界面停在上一次校准的结果上，比一片空白好。
   */
  const refreshSessions = useCallback(async () => {
    // 请求**发出**的时刻：响应里没有"这之后才出现的会话"是正常的，
    // 不能据此把它当已删除（见 ReconcileOptions.snapshotAt）。
    const snapshotAt = Date.now();

    try {
      const page = await listSessions({ page_size: REMOTE_SESSION_PAGE_SIZE });
      if (!aliveRef.current) return;

      // ⚠️ 只有"拿全了"才允许剔除本地条目：
      //   · total > items.length → 还有第 2 页，没返回不代表已删；
      //   · total === 0 也不算 —— 空页可能是令牌里没有 sub（后端对空 user_id
      //     直接回空页），把它当"你一条会话都没有"会**永久**抹掉标题
      //     （标题只有本地有，后端不存）。
      const complete = page.total > 0 && page.total <= page.items.length;

      // ⚠️ **没有变化就不 setState**（而不是 setState(s => s)）：
      //   函数式更新的"同值即跳过"发生在 React 内部，但那次 dispatch 已经
      //   算一次更新了（测试里会报 not wrapped in act，线上也多一次调度）。
      //   这里在外面先用 ref 算一遍，真的变了才派发。
      const current = stateRef.current;
      const next = reconcileWithSessions(current, page.items, {
        snapshotAt,
        complete,
      });
      if (next !== current) setState(next);
    } catch {
      // 见上：静默停在上一次校准的结果
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const { conversations, activeId } = state;

  /**
   * 每个会话一个 agent 实例（下面对 CopilotKit 用了 key={activeId}，切会话会重挂）。
   * 它负责把「用户发的一条消息」翻成「建会话 + 建运行」。
   *
   * ⚠️ 因为它随 activeId 重建，所以「加载历史」那个 hook 在缓存命中时**也必须**
   * 往新 agent 灌一遍 —— 否则第二次点回同一个会话界面是空的。
   * 细节见 useSessionHistory.ts 的文件头。
   */
  const agent = useMemo(
    () =>
      new DockAgent({
        ensureSession: () => ensureSession(activeId),
        renewSession: () => renewSession(activeId),
      }),
    [activeId, ensureSession, renewSession],
  );

  /**
   * 后台正在跑、但**正文不给用户看**的那件活儿（上下文压缩 / 意图分类…）。
   *
   * 它在 converse 里是"看不到但仍然发生"的一段，所以要在这里借 agent 的
   * 事件通道读出来 —— 见 LiveActivityOverlay.tsx 的文件头。
   */
  const hiddenWork = useHiddenWork(agent);

  /**
   * 这一轮调了哪些工具（`tool.called` / `tool.completed`）。
   *
   * 为什么不塞进 messages、为什么与 hiddenWork 分开两个 hook，
   * 见 useToolActivity.ts 与 runEventStream.ts 的文件头。
   */
  const toolActivity = useToolActivity(agent);

  /**
   * 这一轮的任务计划（`plan.published` / `task.updated` / `plan.cleared`）。
   *
   * 输入框上方那条「任务 / 子代理」dock 读它 —— 见 PlanStatusBars.tsx 的文件头。
   * 同样走 CUSTOM 平行通道，不进 messages。
   */
  const plan = usePlanFeed(agent);

  /**
   * 把这一轮的工具记录同步进模块级 store（见 liveToolFeed.ts）。
   *
   * 为什么不直接当 props 传给 DockRenderMessage：它是**以组件身份**交给
   * CopilotChat 的（`RenderMessage={DockRenderMessage}`），中间没有插 props 的
   * 地方；而写成 `(props) => <DockRenderMessage {...props} liveTools={…}/>`
   * 会每次变化都造出一个新组件类型、把整棵消息树重挂（逐字淡入直接被打断）。
   */
  useEffect(() => {
    setLiveToolItems(toolActivity.items);
  }, [toolActivity.items]);

  /**
   * 对话区容器 —— 平滑跟随滚动要在它里面找 `.copilotKitMessages`（见下）。
   */
  const chatPaneRef = useRef<HTMLDivElement | null>(null);

  /**
   * 贴底时新内容把上一行顶上去要**滑**，不要瞬跳（见 useSmoothFollow.ts）。
   */
  useSmoothFollow(chatPaneRef);

  /**
   * `--dock-input-h` 改成**实测**：贴输入框上沿的那几层（任务 dock、
   * 审批卡、问候语）全靠它定位，而输入区的真实高度是变的（Powered by
   * 有没有渲染、正文写满几行都会变）。写死常数会让 dock 离输入框几十像素。
   * 完整来龙去脉见 useInputRegionHeight.ts。
   */
  useInputRegionHeight(chatPaneRef, activeId);

  /**
   * 推理（思维链）的实时通道：把 CUSTOM 事件喂进 reasoningStream 的 store。
   *
   * 它本身**不渲染任何东西** —— 只是让 DockRenderMessage（作为组件传给
   * CopilotChat，中间插不进 props）能按 messageId 查到推理。
   * 必须在 <CopilotKit> 内部订阅，理由见 reasoningStream.ts。
   */
  useReasoningStream(agent);

  /** 当前会话的后端 id —— 没有就意味着"还没建后端会话"，没有历史可拉。 */
  const activeSessionId = useMemo(
    () => conversations.find((c) => c.id === activeId)?.sessionId,
    [conversations, activeId],
  );

  /**
   * 把这一轮「哪个工具成没成」记进本地存档。
   *
   * 只为刷新之后：后端落库的 tool_activity 没有逐次成败（`ToolMessage.status`
   * 被 message_recorder 丢掉了，消息行的 status 是**整次运行**的），所以历史
   * 那边只能靠这份存档补图标。详见 toolStatusCache.ts 的文件头。
   *
   * ⚠️ 必须挂在 `activeSessionId` **之后**：存档按后端 session_id 索引，
   *    而它在文件里比 useToolActivity 晚声明 —— 依赖数组在这个 effect 调用点
   *    求值，写在前面就是 TDZ 报错。
   */
  useEffect(() => {
    rememberToolStatuses(activeSessionId, toolActivity.items);
  }, [activeSessionId, toolActivity.items]);

  /**
   * 历史列表里**只列用过的会话**（在里面发过至少一条消息）。
   *
   * 空会话（建了但一句没发）不列，两个理由：
   *   ① 叫它"历史对话"本来就不成立 —— 没有任何内容可回顾；
   *   ② 它们之间**完全无法区分**（同一句欢迎语、同一个标题、时间戳还在同一分钟），
   *      列出来就是一排一模一样的「新对话」，纯噪音。
   * 判据在 data.ts 的 hasStartedConversation，那里写清了为什么不能只看 sessionId 或标题。
   *
   * ⚠️ 注意别拿这个数组去做"当前会话"的查找 —— 当前会话很可能正是一条空会话
   * （用户刚点开面板就是），过滤掉它就找不到了。activeSessionId 必须查全量 conversations。
   */
  const historyItems = useMemo(
    () => conversations.filter(hasStartedConversation),
    [conversations],
  );

  /**
   * 历史列表按「置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更久以前」分组。
   *
   * `now` 用一个 state 持有、**每分钟**刷一次，而不是每次渲染 `Date.now()`：
   * 直接在渲染期取的话，groupConversations 的结果每次渲染都可能是新数组
   * —— 虽然值一样不会重渲染 DOM，但配合下游的 memo/useMemo 就是无谓的抖动源。
   * 定时器还有一个必须的作用：**跨过零点时把「今天」重新算对**
   * （00:01 之后，昨天聊的会话要落到「昨天」、本该在「今天」的要去「昨天」，
   * 而会话自己不会在零点自动换组）。
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /** 空组不进结果（见 data.ts 的 groupConversations），渲染层直接 map 即可。 */
  const historyGroups = useMemo<ConversationGroup[]>(
    () => groupConversations(historyItems, now),
    [historyItems, now],
  );

  /** 列表里一共有几条 —— 「共 N 个」按分组后的实际条数算。 */
  const historyTotal = useMemo(
    () => historyGroups.reduce((sum, g) => sum + g.items.length, 0),
    [historyGroups],
  );

  /** 对话区里现在有没有消息 —— 决定问候语显隐，理由见下面 showEmptyHint。 */
  const hasMessages = useAgentHasMessages(agent);

  const {
    status: historyStatus,
    invalidate: invalidateHistory,
    resumeCandidate,
  } = useSessionHistory(agent, activeSessionId);

  /**
   * 要不要显示空对话的问候语（「你好，我能帮什么忙吗？」）。
   *
   * 判据是「**对话区里现在真的有没有消息**」（useAgentHasMessages，订阅 agent 的
   * 消息变更），**不是**「这条会话用没用过」（data.ts 的 hasStartedConversation）。
   *
   * ⚠️ 为什么不能用业务标记 —— 踩过，用户报的就是这个
   * --------------------------------------------
   *   `hasStartedConversation` 在提交那一刻就置 true，与后端成不成功无关。
   *   于是「`used: true` 但一条消息都没有」是个能落地的状态（建会话/建运行失败、
   *   页面在建会话落地前被刷新、后端换库导致历史拉不回来）。按业务标记算：
   *   问候语被藏起来 + 消息列表是空的 = **一整页空白**。
   *   （CDP 实测复现：`{'used': true, 无 sessionId}` → `greet=false, domMessages=0`。）
   *
   * 也不用「agent.messages 为空」之外的信号：消息有两条来源（灌历史 / 真聊天），
   * 订阅 agent 是唯一不漏的答案 —— 详见 useAgentMessages.ts 的文件头。
   *
   * 两个刻意的取舍：
   *   · **加载历史期间不显示** —— 此刻 agent 确实是空的，但它马上就要有消息，
   *     这时候蹦出问候语再被顶掉是一次**可见的**闪烁（不同于"发出去还没回来"
   *     那段空窗：那时用户消息已经进列表了，hasMessages 天然是 true）。
   *   · **加载失败反而显示** —— 列表确实是空的，一块纯白面板比
   *     「问候语 + 顶部一条失败提示」更像"面板坏了"。
   *
   * ⚠️ 「发出去还没回来」那段空窗之所以天然没事，前提是**没有人会把已有的消息清掉**。
   *   曾经有人清过：新对话发第一条消息时，懒建会话拿回的 session_id 会让
   *   useSessionHistory 重跑一次，拉回一条空历史再 `setMessages([])` ——
   *   hasMessages 翻回 false，问候语就**又冒回来**，和 loading 动画一起挂在面板上
   *   （用户报的就是这个）。那条路现在有守卫了，见 useSessionHistory.ts 的「坑 3」：
   *   **它只往 agent 里灌历史，绝不把 agent 已有的消息清掉。**
   */
  const showEmptyHint = !hasMessages && historyStatus !== 'loading';

  /**
   * 历史抽屉的开关。
   *
   * 为什么历史列表要**点开才有**（而不是像原来那样常驻在对话区上方）：
   *   常驻一条列表会一直占掉面板 1/3 ~ 1/2 的高度，聊天区被压得很窄 ——
   *   而面板宽度只有屏宽 1/3，聊天才是主角。收进抽屉后，对话区拿到全部高度。
   */
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * 点「历史」时切换；已经在看历史时再点就是收起。
   *
   * ⚠️ 每次**打开**都从后端重新校准一次（数据以 sessions 为准）：
   *   用户看到列表的那一刻，它就应该是后端此刻的那一份 —— 包括"在另一台
   *   设备上删掉的会话现在不该出现"。不要把它做成"打开本地缓存"。
   *   只在"关 → 开"这一侧触发，别写进 state updater 里（StrictMode 下
   *   updater 会被调用两次，会打两次请求）。
   */
  const toggleHistory = useCallback(() => {
    if (!historyOpen) void refreshSessions();
    setHistoryOpen((open) => !open);
  }, [historyOpen, refreshSessions]);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
  }, []);

  /**
   * Esc 关闭历史抽屉。
   *
   * role="dialog" 就该支持 Esc —— 否则键盘用户只能 Tab 到返回按钮才能出去。
   * 只监听 Esc、不做焦点陷阱：抽屉里只有「选会话 / 删会话」两类操作，
   * 强行把焦点锁在一个屏宽 1/3 的面板里，反而让用户没法快速离开。
   * 只在打开时挂监听，关着的时候不该抢 Esc（页面上别的地方可能也要用）。
   */
  useEffect(() => {
    if (!historyOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [historyOpen]);

  const create = useCallback(() => {
    setState((s) => withNewConversation(s, Date.now()));
  }, []);

  const select = useCallback((id: string) => {
    setState((s) => (s.activeId === id ? s : { ...s, activeId: id }));
  }, []);

  /**
   * 删除确认走 **App.useApp() 的 modal**，不是静态 Modal.confirm。
   *
   * 静态方法拿不到 ConfigProvider context（antd lint 也会告警），
   * 弹出来是没有主题的那一套灰。App 由 umi 的 antd 插件注入
   * （src/.umi/plugin-antd/runtime.tsx 的 innerProvider），这里拿得到。
   *
   * ⚠️ 声明位置必须在 remove **之前**：remove 的依赖数组在**渲染期**就要求值，
   *   写在后面就是 TDZ（`message` 还没初始化就被读）。而 convMenuItems 又在
   *   remove 之后 —— 那里引用的是**回调体内**的 remove，调用时才求值，无妨。
   */
  const { modal, message } = App.useApp();

  /**
   * 删除一个会话。
   *
   * ⚠️ 顺序不能反：**先删后端，成功了再删本地**
   * ----------------------------------------
   *   反过来的话，接口失败时界面上已经没了、后端还在 —— 用户以为删掉了，
   *   下次并列表（或换设备）它又冒回来。这正是"假删除"。
   *
   * ⚠️ 没有 sessionId 的会话（从没发过消息）直接删本地
   * -------------------------------------------------
   *   后端压根没有这条，打接口只会拿到 404。
   *
   * ⚠️ 后端删的是**归档**（软删），不是物理删除
   * ----------------------------------------
   *   消息 / 运行 / checkpoint / 记忆索引都保留，只是默认列表不再返回、
   *   也不能再开新运行（409）。所以文案别写"彻底删除、无法恢复"。
   *   后端还会**顺带取消**这个会话里没跑完的运行（异步受理）。
   *
   * 返回是否真的删掉了 —— 调用方（确认框）据此决定后续，不必再猜。
   */
  const remove = useCallback(
    async (conv: CopilotConversation): Promise<boolean> => {
      if (conv.sessionId) {
        try {
          await deleteSession(conv.sessionId);
        } catch (error) {
          // 失败就停在原地 —— 本地条目不能先没
          message.error(`删除失败：${describeRuntimeError(error)}`);
          return false;
        }
        // 这个 sessionId 的历史缓存还躺在 useSessionHistory 里。正常情况不会再
        // 进来，但归档是可逆的（后端能查 archived），别让旧缓存冒充新事实。
        // ⚠️ 必须把**被删的那个** sessionId 传进去：被删的往往不是当前会话，
        //   不带参数清的是当前会话，等于清错了对象。
        invalidateHistory(conv.sessionId);
      }

      setState((s) => withRemovedConversation(s, conv.id, Date.now()));
      // 校准一次：本地这是**乐观**删除，后端才是事实（例如幂等重删、或
      // 别的设备在此期间又建了新会话）。
      void refreshSessions();
      return true;
    },
    [invalidateHistory, message, refreshSessions],
  );

  /**
   * 「⋯」菜单的四个动作里**只有删除是通的**（需求原话）。
   *
   * 置顶 / 重命名 / 分享三项 disabled：数据层其实已经备好了 withPinned
   * （见 data.ts），但**不接** —— 给一个点了没反应的按钮比不放更糟，
   * 用户会以为是 bug 而不是"还没做"。等真接上时去掉 disabled、把回调挂上即可。
   */
  const convMenuItems = useCallback(
    (conv: CopilotConversation): MenuProps['items'] => [
      {
        key: 'delete',
        label: '删除',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () =>
          modal.confirm({
            title: '删除这个会话？',
            // 措辞要对得上后端的语义：归档 = 从列表消失 + 打断在跑的运行；
            // 消息与运行记录仍在库里，写"无法恢复"是不准确的承诺。
            content: `「${conv.title}」会从历史对话里移除，这条对话里正在进行的回答会被中断。`,
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            centered: true,
            // onOk 返回 Promise 时确认框会转到接口返回再关。失败时**照常关闭**，
            // 但列表条目留在原地 —— 原因由 remove 内部的 toast 给出，比把错误
            // 塞进确认框里更好读。
            onOk: () => remove(conv),
          }),
      },
      {
        key: 'pin',
        label: '置顶',
        icon: <PushpinOutlined />,
        disabled: true,
      },
      {
        key: 'rename',
        label: '重命名',
        icon: <EditOutlined />,
        disabled: true,
      },
      {
        key: 'share',
        label: '分享',
        icon: <ShareAltOutlined />,
        disabled: true,
      },
    ],
    [modal, remove],
  );

  /**
   * 首条消息拿来做会话标题 —— 之后就不再改了（见 withFirstMessage）。
   *
   * 顺带 invalidate 历史缓存：这一轮是新内容，缓存里没有它。
   * **只清缓存、不重灌** —— 此刻界面上是流式输出中的那条，
   * 重灌会把它冲掉（那正是"刚发的消息又变回旧内容"的成因）。
   */
  const handleSubmitMessage = useCallback(
    (message: string) => {
      setState((s) => withFirstMessage(s, message));
      invalidateHistory();
    },
    [invalidateHistory],
  );

  /**
   * 选会话后自动关掉历史抽屉。
   *
   * 为什么选完就关：抽屉是**覆盖**在对话区上的，选完还要它挡着就看不到
   * 刚切过去的对话 —— 那等于白点。关闭时机放在"选完"，不是"点遮罩"。
   */
  const selectAndClose = useCallback(
    (id: string) => {
      select(id);
      setHistoryOpen(false);
    },
    [select],
  );

  /** 新建对话同理：先离开当前会话，再关抽屉 */
  const createAndClose = useCallback(() => {
    create();
    setHistoryOpen(false);
  }, [create]);

  return (
    <>
      {/*
        收起后右侧唯一留下的东西：贴边竖中的展开「拉手」。
        它是面板的**兄弟节点**、不在 aside 里 —— aside 收起时宽度是 0 且 overflow:hidden，
        fixed 子元素虽然眼下不会被裁（未被 transform 提为包含块），
        但只要日后给面板加位移动画就会连带被裁，不如从结构上断开。
      */}
      {collapsed ? (
        <Tooltip title="展开 AI 助手" placement="left">
          {/*
            右下角悬浮球。原来是贴右边**竖中**的，会跟表格页脚/分页器抢位置
            —— 面板收起时那圈把手正好压在内容右下角的操作区上（截图 2 的场景）。
            挪到右下角之后：底部区域本来就是空的，且离页脚更远。
            仍然与 aside 是**兄弟节点**（见上方注释），收起态不会把它一起裁掉。
          */}
          <button
            type="button"
            className={styles.expandTab}
            onClick={() => onCollapsedChange(false)}
            aria-label="展开 AI 助手"
          >
            <RobotOutlined />
          </button>
        </Tooltip>
      ) : null}

      <aside
        className={cx(styles.panel, collapsed && styles.panelCollapsed)}
        data-collapsed={collapsed || undefined}
        data-wide={wide || undefined}
        aria-label="AI 助手"
      >
        {/* 收起时只是隐藏，不卸载 —— 卸载会把 CopilotKit 里的消息一起清掉 */}
        <div className={cx(styles.inner, collapsed && styles.innerHidden)}>
          {/*
            头部：左边标题，右边一排图标动作。
            会话列表**不在这里常驻** —— 收进「历史」抽屉（见 historyPane），
            把聊天区的全部高度让出来。

            ⚠️ 标题是**两态叠放**的：对话态（YTrader Harness）与历史态（‹ 历史对话），
            用 opacity + 位移做转换动画。返回按钮直接就是历史态的标题本身
            （需求：返回按钮放在一级标题上），不再有单独一行抽屉头。
            两态都常驻 DOM —— 卸载就没有过渡可做了。
          */}
          <div className={styles.head}>
            {/*
              左上角的「放大」标签 —— 只做 1/3 ↔ 半屏，**不碰折叠**
              （折叠仍然是右下角那颗悬浮球 / 头部的收起箭头）。

              ⚠️ 为什么单独一枚、而不是塞进右边那排动作里
              --------------------------------------
              右边三枚是"对话操作"（新建 / 历史 / 收起），改的是**内容**；
              这枚改的是**面板自己多大**，是布局档位。摆在标题左边、跟标题
              同一起始线，读起来是"这块区域的缩放开关"—— 与左侧菜单栏那个
              折叠把手的语汇一致（用户原话：「仿照菜单栏的扩大标签即可」）。

              ⚠️ 展开历史时它要**收起来**（需求：「展开对话历史的时候，扩大全屏就
              隐藏掉，只留 ‹ 历史对话」）—— 那一页是"另一个页面"，右边的操作栏
              只有「新建 / 收起」，多一枚改宽度的会让人以为能同时开两个。
              收法是"宽度收到 0 + 淡出"，不是 `display: none`：
              后者会让整块标题瞬间左移 32px，跟标题两态的淡入撞成一次闪烁。
              所以外面套了一层 `wideTabSlot`（宽度归我们自己管，见 style.ts）。
            */}
            <span
              className={cx(
                styles.wideTabSlot,
                historyOpen && styles.wideTabSlotClosed,
              )}
              aria-hidden={historyOpen || undefined}
            >
              <Tooltip title={wide ? '还原为三分之一' : '放大到半屏'}>
                <Button
                  type="text"
                  size="small"
                  className={styles.wideTab}
                  icon={
                    wide ? (
                      <ShrinkOutlined className={styles.wideTabIcon} />
                    ) : (
                      <ExpandAltOutlined className={styles.wideTabIcon} />
                    )
                  }
                  onClick={() => setWide((value) => !value)}
                  aria-label={
                    wide ? '把面板还原为三分之一' : '把面板放大到半屏'
                  }
                  aria-pressed={wide}
                  tabIndex={historyOpen ? -1 : undefined}
                />
              </Tooltip>
            </span>
            <div className={styles.headTitleSlot}>
              {/*
                对话态：产品名本身。
                ⚠️ 这一层必须**常驻 DOM**（只是透明掉），否则淡出淡入的过渡就没了；
                测试也是靠 `getByText('YTrader Harness')` 钉这个前提的。
              */}
              <div
                className={cx(
                  styles.headTitleLayer,
                  historyOpen ? styles.headTitleOff : styles.headTitleOn,
                )}
              >
                YTrader Harness
              </div>
              {/* 历史态：整个标题就是一个返回按钮 */}
              <button
                type="button"
                className={cx(
                  styles.headTitleLayer,
                  styles.headTitleBack,
                  historyOpen ? styles.headTitleOn : styles.headTitleOff,
                )}
                onClick={closeHistory}
                aria-label="返回对话"
                aria-expanded={historyOpen}
                tabIndex={historyOpen ? 0 : -1}
              >
                <LeftOutlined className={styles.headTitleIcon} />
                历史对话
                <span className={styles.historyCount}>
                  共 {historyTotal} 个
                </span>
              </button>
            </div>
            <span className={styles.headActions}>
              <Tooltip title="新建对话">
                <Button
                  type="text"
                  size="small"
                  icon={<PlusOutlined className={styles.headActionIcon} />}
                  onClick={createAndClose}
                  aria-label="新建对话"
                />
              </Tooltip>
              {/*
                历史入口。**收起态下没有独立的「关闭历史」按钮** ——
                需求把返回入口放到了标题上，这里只负责"打开 / 再点一下收起"。
              */}
              <Tooltip title="历史对话">
                <Button
                  type="text"
                  size="small"
                  icon={<HistoryOutlined className={styles.headActionIcon} />}
                  onClick={toggleHistory}
                  aria-label="历史对话"
                  aria-expanded={historyOpen}
                />
              </Tooltip>
              <Tooltip title="收起">
                <Button
                  type="text"
                  size="small"
                  icon={<RightOutlined className={styles.headActionIcon} />}
                  onClick={() => onCollapsedChange(true)}
                  aria-label="收起 AI 助手"
                />
              </Tooltip>
            </span>
          </div>

          {/*
            历史抽屉。**覆盖**在对话区之上，不挤压聊天区高度 ——
            面板只有屏宽 1/3，聊天才是主角。
            不用 antd Drawer：它是 fixed 定位，会跑到视口最右边、脱离这个 aside，
            收起态（宽度 0、overflow hidden）时也藏不住。自己在面板内做一层更可控。

            ⚠️ 顶部留出 --dock-head-h（head 的高度），**不盖住标题栏** ——
            盖住的话标题栏上的「返回对话」按钮连同它的关闭能力一起被遮掉，
            用户就只剩"怎么关掉这个全屏层"这一个疑问了（实测踩过）。
            它的值与 style.ts 里 head 的高度同源（同一个 CSS 变量）。

            ⚠️ 这里**没有自己的头部**：标题 + 返回按钮就是上面那根 head。
            原来抽屉里那行「‹ 历史对话 / 共 N 个」是重复的，两个标题栏叠着
            既占高度又让人不知道该点哪个。

            ⚠️ **常驻挂载**（不再 `historyOpen ? ... : null`）—— 用户要求
            「点击新页面 / 历史页面，页面切换全部添加动画效果」，而条件渲染
            只有进场、没有退场：上一帧还在、下一帧就消失了，永远做不出滑出。
            关着的时候靠 `visibility: hidden` + `aria-hidden` 藏起来：
            看不见、点不到、Tab 不到，`role="dialog"` 的查询也查不到
            （测试就是靠它判"抽屉关着"的）。
          */}
          <div
            className={cx(
              styles.historyPane,
              historyOpen && styles.historyPaneOpen,
            )}
            role="dialog"
            aria-label="历史对话"
            aria-hidden={!historyOpen || undefined}
          >
            <div className={styles.historyList}>
              {historyGroups.length === 0 ? (
                <div className={styles.historyEmpty}>
                  <span className={styles.historyEmptyTitle}>
                    还没有历史对话
                  </span>
                  <span className={styles.historyEmptyHint}>
                    发一条消息就会自动记在这里
                  </span>
                </div>
              ) : null}
              {/*
                  按「置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更久以前」分组。
                  空组在 data.ts 的 groupConversations 里就已经滤掉了，
                  这里不需要再判空。
                */}
              {historyGroups.map((group) => (
                <section
                  className={styles.historyGroup}
                  key={group.key}
                  aria-label={group.label}
                >
                  <h3 className={styles.historyGroupTitle}>{group.label}</h3>
                  {group.items.map((conv) => (
                    /*
                        整行一个容器：蓝底挂在**这一行**上，不是只挂在标题按钮上。
                        否则选中的那一条只有标题那半截是蓝的，「⋯」吊在蓝条外面的
                        白底上 —— 看着像按钮飘出来了（原来是这个形态）。
                      */
                    <div
                      className={cx(
                        styles.convRow,
                        conv.id === activeId && styles.convRowActive,
                      )}
                      // 行级标记：底色挂在行上（见 style.ts），测试/探针要能读到
                      // "哪一行是选中态"，而不是靠猜 antd-style 哈希出来的类名。
                      data-conv-row={conv.id}
                      data-active={conv.id === activeId ? 'true' : 'false'}
                      key={conv.id}
                    >
                      <button
                        type="button"
                        className={cx(
                          styles.convItem,
                          conv.id === activeId && styles.convItemActive,
                        )}
                        onClick={() => selectAndClose(conv.id)}
                      >
                        <span className={styles.convTitle}>{conv.title}</span>
                        {conv.pinned === true ? (
                          <PushpinOutlined className={styles.convPin} />
                        ) : null}
                        {/*
                            最后对话时间：贴右缘、单行不换行。

                            用 `<time>` 而不是 span：它是机器可读的时刻，读屏会念出来；
                            而且它是 button 的子节点（phrasing content），不会变成嵌套按钮。
                            分组（今天 / 昨天 / …）和这一格时间都由
                            `conversationUpdatedAt` 算 —— 两处若各解析一遍，
                            就会出现"排在今天组里、右边却写着昨天"。
                          */}
                        <time
                          className={styles.convTime}
                          dateTime={conv.updated_at}
                        >
                          {formatConversationTime(conv)}
                        </time>
                      </button>
                      {/*
                          「⋯」入口：点击弹出下拉菜单（删除 / 置顶 / 重命名 / 分享）。

                          ⚠️ trigger 用 ['click', 'contextMenu']：需求说的是
                          "弹出鼠标右键下拉菜单效果"——既要点得开，也要真右键
                          也能开（两种手势指向同一个菜单）。
                        */}
                      <Dropdown
                        trigger={['click', 'contextMenu']}
                        menu={{ items: convMenuItems(conv) }}
                        placement="bottomRight"
                      >
                        <Button
                          type="text"
                          size="small"
                          className={cx(styles.convMore, 'yt-copilot-more')}
                          icon={<MoreOutlined />}
                          aria-label={`更多操作 ${conv.title}`}
                        />
                      </Dropdown>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>

          <div className={styles.chatPane} ref={chatPaneRef}>
            {/*
            key={activeId} —— 切会话时整棵 CopilotKit 重挂，消息自然就隔离了。
            历史由上面那个 effect 灌进 agent（agent.setMessages），重挂后仍然是它 ——
            所以切回来时看到的是上次的对话，不是空白。
            CopilotChat 这里**不传 className**，用它的原生样式。
          */}
            {/*
            加载/失败提示放在 CopilotKit **外面**：它是绝对定位的一层，
            塞进去会被聊天界面的布局当成消息区的一部分。
            只在「已经有后端会话」时才可能拉历史，所以没 session_id 时不显示
            （新对话本来就该是空白 + 欢迎语）。
          */}
            {historyStatus === 'loading' ? (
              <div className={styles.historyTip} role="status">
                <Spin size="small" /> 正在加载对话记录…
              </div>
            ) : null}
            {historyStatus === 'error' ? (
              <div
                className={cx(styles.historyTip, styles.historyTipError)}
                role="alert"
              >
                对话记录加载失败。后端没起，或这个会话在服务端已经不存在了
                （再发一条消息会自动重建会话）。
              </div>
            ) : null}
            {/*
              空对话的占位问候语。**不用 CopilotKit 的 labels.initial** ——
              那个会在消息列表最前面插一条**假的助手消息**（它压根不是后端发来的），
              刷新/切换会话时还会一直挂在那儿（见下面的 labels 注释）。
              这里自己画一个纯展示层：居中、加粗，一发出消息就消失。
            */}
            {showEmptyHint ? (
              <div className={styles.emptyHint}>你好，我能帮什么忙吗？</div>
            ) : null}
            <ErrorBoundary>
              {/*
              enableInspector={false}：开发构建下 CopilotKit 会在右上角挂一个圆形的
              Inspector 按钮，正好压在本面板的头部按钮上（深色圆点带红点）。
              它是纯开发工具，不是产品 UI，关掉。
            */}
              {/*
              不传 runtimeUrl：后端没有 CopilotKit Runtime，传了只会去探
              /api/copilotkit/info 然后一直「未连接」。直接把自己这个 agent 交给
              provider（agents__unsafe_dev_only 就是「应用自带的 agent」这个入口），
              聊天界面照样是 CopilotKit 原生的。
              agentId 与注册名都是 'default'（DOCK_AGENT_ID），v1 聊天默认找的就是它。
            */}
              <CopilotKit
                key={activeId}
                agentId={DOCK_AGENT_ID}
                agents__unsafe_dev_only={{ [DOCK_AGENT_ID]: agent }}
                enableInspector={false}
              >
                <CopilotChat
                  /*
                    输入框换成了自己的 Composer（DeepSeek 风：深度思考开关 + 附件
                    + 圆形发送）。为什么不盖一层而是整个换掉、附件与深度思考
                    今天为什么只是 UI —— 都在 Composer.tsx 的文件头里。
                    行为上与库的默认实现逐条对齐（自动增高 / Enter 发送 /
                    IME 组合不下发 / 停止 / 未就绪转圈 / 两个 data-testid）。
                  */
                  Input={Composer}
                  /*
                    接管消息渲染 —— 只为改一个判定：**谁算"最后一条 AIMessage"**。

                    库的默认实现用 `index === messages.length - 1`（数组最后一个
                    元素，不管角色），于是"反馈图标行"会在每条助手消息上都能露出来
                    （hover / 触摸设备常显），而将来数组以 tool 消息结尾时又会整体
                    消失。需求是"一轮里只在最后一条 AIMessage 下面有反馈按钮"，
                    所以改由 DockRenderMessage 自己判 —— 它除了这一个 prop，
                    其余逐条照抄库的实现（理由写在那两个文件的头部）。
                  */
                  RenderMessage={DockRenderMessage}
                  /*
                    消息操作行的图标 —— 与「我的消息」下方那两枚**同一份来源**
                    （见 messageActionIcons.tsx）。不传的话库会用自带 SVG：
                    同一个「复制」在两条消息下面一个细线一个描边，尺寸也不一样。
                    库是 `{...默认图标, ...icons}` 合并的，所以这里只覆盖四个，
                    发送 / 停止 / 转圈那几个仍走默认（Composer 要用）。
                  */
                  icons={CHAT_ACTION_ICONS}
                  labels={{
                    title: 'AI 助手',
                    placeholder: '发消息给 AI 助手…',
                    // ⚠️ **故意不传 `initial`** —— CopilotKit 拿它调
                    // makeInitialMessages()，生成一条 role: 'assistant' 的**假消息**
                    // 塞到消息列表最前面：它不是后端发的、会跟真历史混在一起
                    // （有历史的会话里它会一直挂在最上面），而且抢占空对话的视觉重心。
                    // 空对话的问候语由上面的 emptyHint 自己画（居中加粗）。
                    // 不传 / 传 '' 时 makeInitialMessages 直接返回 []。
                  }}
                  onSubmitMessage={handleSubmitMessage}
                />
                {/*
                  人工审批（HITL）卡片。

                  ⚠️ 位置在 <CopilotKit> **里面**、<CopilotChat> **外面**
                  ----------------------------------------------------
                  · 必须在 CopilotKit 里面：它要用 useInterrupt（v2 headless），
                    那个 hook 读的是 CopilotKit 的 context；
                  · 又必须在 CopilotChat 外面：卡片要贴输入框上沿、常驻可见 ——
                    审批期间输入框是锁的，卡片一旦被滚出视野用户就卡住了。
                    塞进聊天区的结果是**多画一张**（不是白挂）：v1 的 <CopilotChat>
                    确实会渲染 useInterrupt 交出来的那个元素（dist 里
                    `useCopilotChatInternal().interrupt` 之后直接 `{interrupt}`），
                    所以 HitlInterrupt 用的是 `renderInChat: false`：元素只**返回**
                    给调用方、不发布出去，库那边自然没东西可画。
                    来龙去脉见 HitlInterrupt.tsx 的文件头。

                  CopilotKit 本身是纯 provider（不产出 DOM 包裹层），所以
                  HitlInterrupt 那层 absolute 定位的包含块就是 chatPane
                  （它是 position: relative）—— 卡片于是贴在输入框上沿。
                  它是 absolute，不占 chatPane 的 flex 流，不会把聊天区挤扁。
                */}
                {/* 工具记录 + 「正在调用工具 / 正在…」—— 贴输入框上沿，见 style.ts */}
                <LiveActivityOverlay
                  work={hiddenWork}
                  tools={toolActivity}
                  plan={plan}
                />
                <HitlInterrupt />
                {/*
                  刷新 / 切回会话时，把**还在后端跑着的那一次运行**接回来 ——
                  需求原话是「刷新后第一次打开某个 conversation，自动检测有无
                  在跑的实例，有则直接订阅」。

                  判据来自上面的 useSessionHistory（读会话历史里最后一条
                  带 run_id 的消息），动作见 RunResume.tsx。
                  它不产出 DOM（render null），挂在这里纯粹是为了拿 CopilotKit
                  的 context —— `copilotkit.runAgent` 只有在那里面才取得到。
                */}
                <RunResume agent={agent} candidate={resumeCandidate} />
              </CopilotKit>
            </ErrorBoundary>
          </div>
        </div>
      </aside>
    </>
  );
};

export default CopilotDock;
