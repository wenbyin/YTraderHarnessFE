// src/components/CopilotDock/reasoningStream.ts
//
// 思维链（CoT）在**实时**那条路上的存放处。
//
// 为什么它不在 `agent.messages` 里
// -------------------------------
//   AG-UI 的 Message 只有 `content` 一个字符串容器，而推理与正文是**两个
//   不能混的容器**：推理是模型的草稿纸（里面有内部判据与原始输入），正文是
//   给用户看的答复。混进 content 只有两种结局 —— 要么推理原样出现在气泡里
//   （本次需求就是要把它藏起来），要么得在渲染时再从正文里把推理切出来
//   （那等于让显示层去猜"哪一段是草稿纸"）。
//
//   与 tool_activity 同样的道理：走 `EventType.CUSTOM` 的那条平行通道
//   （见 runEventStream.ts 里 PROGRESS_CUSTOM_EVENT 那段取舍），
//   不碰 messages。
//
// 为什么按 messageId 存
// --------------------
//   渲染层（DockRenderMessage）拿到的就是 AG-UI 的 Message，手上只有它的
//   id。按 id 查表是唯一不需要把整棵组件树用 context 串起来的做法 ——
//   而 `RenderMessage` 是作为**组件**传给 CopilotChat 的（`RenderMessage=
//   {DockRenderMessage}`），中间根本没有我们能插 props 的地方。
//
// ⚠️ 两个来源，界面只认一个地方
// ----------------------------
//   · 实时：本文件的 store（由 CUSTOM 事件喂）；
//   · 历史：`metadata.reasoning`（history.ts 从后端的 `reasoning_content`
//     或 content 里的推理块抽出来）。
//   DockRenderMessage 里 metadata 优先 —— 刷新/重载历史之后，那条消息的
//   权威数据来自后端，不该再让流上的残留覆盖它。

import type { AbstractAgent } from '@ag-ui/client';
import { useEffect, useSyncExternalStore } from 'react';

/** CUSTOM 事件名。与 `ytrader.progress` 是两条独立的通道。 */
export const REASONING_CUSTOM_EVENT = 'ytrader.reasoning';

/**
 * 一帧推理。
 *
 * ⚠️ `delta` 与 `content` 的关系与 `message.*` 那条路逐字相同：
 *    delta 是旁路（丢了不重发），content 是**全文对账点**（以它为准）。
 *    `done` 是前端自己的兜底 —— 见 `applyReasoning`。
 */
export interface ReasoningPayload {
  messageId: string;
  /** 增量（`message.reasoning.delta`）。 */
  delta?: string;
  /** 全文（`message.reasoning.completed`）。给了就以它为准，覆盖 delta 拼出来的。 */
  content?: string;
  /** 这段推理结束了 —— 后端不发这个，见下。 */
  done?: boolean;
}

/** 一条消息当前的推理。 */
export interface ReasoningEntry {
  text: string;
  /** 还在流（界面显示"思考中…"+ 转圈）。 */
  streaming: boolean;
}

/**
 * ⚠️ 为什么要 `done` —— 后端**不会**为"没有思维链"发一条空壳
 * ------------------------------------------------------
 *   契约原文：`message.reasoning.completed` 在模型没给思维链时**根本不发**
 *   （"这次没有推理"与"推理是空的"不是一回事）。而 `message.reasoning.delta`
 *   是旁路、丢了不重发 —— 只靠这两条，"还在流"这个状态**没有可靠的终点**：
 *   最后一个推理 token 之后如果 completed 丢了，那行"思考中…"会一直转下去。
 *   所以翻译器在 `message.completed` 时补发一条 `done`，那才是"这条消息的
 *   推理不管有没有，到此为止"的确定信号。
 */

/** messageId -> 推理。模块级单例：整个面板同一时刻只有一份。 */
const entries = new Map<string, ReasoningEntry>();

const listeners = new Set<() => void>();

/** 写次数。跨消息派生的值（见 useReasoningVersion）靠它判断要不要重算。 */
let version = 0;

function emitChange(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 订阅"什么都没发生"的编译器 —— 让用不到整轮状态的消息压根不进订阅表。 */
function subscribeNothing(): () => void {
  return () => {};
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 写一条。返回是否真的改了（没改就不通知，免得每帧重渲染整条消息流）。 */
export function applyReasoning(payload: ReasoningPayload): void {
  const id = payload.messageId;
  if (typeof id !== 'string' || id === '') return;

  const prev = entries.get(id);

  // ⚠️ `content` 必须比 `done` 先判：后端那帧是**同时**带 content 与
  //    "这一段结束了"的（翻译器给的 payload 里两个都有）。先走 done 那条
  //    分支的话，content 被丢掉、界面上只剩 delta 拼出来的残缺版本。
  if (typeof payload.content === 'string') {
    // 全文 = 对账点。空串也算（后端说"有推理但它就是空的"不会发生，
    // 真给了就如实显示空 —— 比假装没有更诚实）。
    if (prev && prev.text === payload.content && !prev.streaming) return;
    entries.set(id, { text: payload.content, streaming: false });
    emitChange();
    return;
  }

  // `done` 只为"已经存在的那段"收尾 —— 没有就什么都不做。
  // 否则每条没有推理的消息都会留下一个空 entry，而空 entry 会在界面上
  // 渲染出一个什么都没有的折叠块。
  if (payload.done) {
    // 没有 entry、或已经在收尾态，都没有"停转圈"这回事 —— 别留空 entry。
    if (!prev?.streaming) return;
    entries.set(id, { text: prev.text, streaming: false });
    emitChange();
    return;
  }

  const delta = typeof payload.delta === 'string' ? payload.delta : '';
  if (delta === '') return;

  const next = (prev?.text ?? '') + delta;
  if (prev && prev.text === next && prev.streaming) return;
  entries.set(id, { text: next, streaming: true });
  emitChange();
}

/** 新一轮开始：清掉上一轮的残留（换 agent 同理，见 useReasoningStream）。 */
export function resetReasoning(): void {
  if (entries.size === 0) return;
  entries.clear();
  emitChange();
}

/**
 * 给 `useSyncExternalStore` 的快照。
 *
 * ⚠️ **必须返回缓存里的那个对象本身**，不能现场 `{}` —— getSnapshot 每次
 *    返回新引用会让 React 判定"一直变了"，渲染直接死循环。
 */
export function reasoningEntryOf(
  messageId: string | null | undefined,
): ReasoningEntry | null {
  if (!messageId) return null;
  return entries.get(messageId) ?? null;
}

/**
 * 一条消息的推理 —— **订阅版**，给渲染层用（DockRenderMessage）。
 *
 * ⚠️ 为什么又有了"按单条消息取推理"的 hook（2026-10-20 需求反转）
 * -----------------------------------------------------------
 *   2026-10-17 曾把逐条的 `useReasoning(messageId)` 删掉、改成"整轮合并成
 *   一块"（当时的原话是"一个回复上方只能有一个思考过程"）。2026-10-20
 *   需求反过来：**多个思考过程不要合并**，而且要"按事件顺序"显示 ——
 *   用户要的是"第几步想了什么、然后调了哪个工具"的对位关系，合并之后
 *   那层对应关系就没了（截图里就是"一列工具行 + 最后一大块思考"）。
 *
 *   所以逐条渲染是**现在的正确形态**，这个 hook 也就该存在。它不会像
 *   2026-10-17 担心的那样"每个回答上挂 N 个折叠行"变成噪音 —— 那 N 块
 *   本来就对应 N 步，中间夹着工具行，读起来是一条时间线。
 *
 * ⚠️ 为什么按 id 订阅不会让每条消息都重渲染
 * ---------------------------------------
 *   `subscribe` 是"任何一条变了都通知"，但 `getSnapshot` 返回的是
 *   **entries 里那个对象本身**：只有**正在流的那条**换引用，其余消息拿到的
 *   还是同一个对象，React 因此**跳过**它们的重渲染。所以长对话里每个 token
 *   的代价是"几十次 Map.get"，不是"几十次重渲染"。
 *
 * ⚠️ metadata 优先于 store（理由见 reasoningOfMessage）
 * -------------------------------------------------
 *   刷新之后那条消息的权威数据来自后端，store 里可能还留着上一轮的残留。
 */
export function useReasoningOf(message: {
  id?: string;
  metadata?: unknown;
}): ReasoningEntry | null {
  const live = useSyncExternalStore(
    subscribe,
    () => reasoningEntryOf(message.id),
    () => null,
  );
  return reasoningFromMeta(message) ?? live;
}

/**
 * store 的版本号 —— 给"要跨多条消息看状态"的地方用。
 *
 * 目前唯一的用户是 DockRenderMessage 里那条判据：**最后一条正文**要不要
 * 关掉库自己的 loading 光标，取决于"这一轮里**还有没有一段**推理在流"
 * （那段可能在**别的**消息上 —— 长链路里前一步的推理先流完、答案那条才开出来）。
 * 这个值跨多条消息，单条订阅（useReasoningOf）看不见，所以要版本号。
 *
 * ⚠️ 为什么要一个版本号，而不直接读 entries
 * -------------------------------------
 *   `useSyncExternalStore` 的 `getSnapshot` 必须返回**引用稳定**的值，否则
 *   每帧都判定"变了"、直接渲染死循环。版本号是整数，天然稳定；派生值由
 *   调用方自己算（每次渲染算一遍，几个 Map.get 而已）。
 *
 * ⚠️ `enabled=false` 时**连订阅都不进**
 * ----------------------------------
 *   只有"最后一条且正在跑"需要看整轮，其余消息订阅纯属浪费 —— 长对话里
 *   那是几十次无谓回调。不可用时就换一个永不触发的 subscribe。
 */
export function useReasoningVersion(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeNothing,
    () => (enabled ? version : 0),
    () => (enabled ? version : 0),
  );
}

/**
 * 一条消息的推理 —— **metadata 优先于实时 store**（纯函数，非 hook）。
 *
 * 两条路都能给出推理：历史消息由 history.ts 从 `reasoning_content` 抽好放进
 * metadata；实时消息在 store 里。刷新之后那条消息的权威数据是后端给的，
 * store 里可能还留着上一轮的残留，所以 metadata 一有值就以它为准。
 *
 * ⚠️ 纯函数版与 hook 版（`useReasoningOf`）的分工
 * -------------------------------------------
 *   · 渲染**自己**那条 → 用 hook（要订阅才能跟着流长出来）；
 *   · 渲染时要看**别的**消息（目前只有"这一轮还有没有推理在流"那一条判据）
 *     → 用这个纯函数 + `useReasoningVersion` 提供重算信号。
 */
export function reasoningOfMessage(message: {
  id?: string;
  metadata?: unknown;
}): ReasoningEntry | null {
  return reasoningFromMeta(message) ?? reasoningEntryOf(message.id);
}

/** metadata 里那一段（历史通道）。没有/空白就是 `null` —— 交给实时 store 兜底。 */
function reasoningFromMeta(message: {
  metadata?: unknown;
}): ReasoningEntry | null {
  const meta = message.metadata as { reasoning?: unknown } | null | undefined;
  if (typeof meta?.reasoning === 'string' && meta.reasoning.trim() !== '') {
    // 历史里的推理一定是收尾状态（它来自一条已经落库的消息）。
    return { text: meta.reasoning, streaming: false };
  }
  return null;
}

/**
 * 订阅 agent，把 CUSTOM 推理事件喂进 store。
 *
 * ⚠️ 必须在 `<CopilotKit>` **内部**调用（index.tsx 那一层）：
 *    CUSTOM 只在 `runAgent()` 那条路径上通知订阅者（见 useHiddenWork 的
 *    文件头），而 runAgent 是 CopilotKit 发起的。
 */
export function useReasoningStream(agent: AbstractAgent): void {
  useEffect(() => {
    // 换 agent（切会话）就清干净：旧 agent 那半段推理永远收不到收尾事件，
    // 不 reset 的话那一行会一直"思考中"。
    resetReasoning();

    const { unsubscribe } = agent.subscribe({
      onRunStartedEvent: () => {
        resetReasoning();
        return {};
      },
      onCustomEvent: ({ event }) => {
        if (event.name !== REASONING_CUSTOM_EVENT) return;
        // 这一层只是"存一份给界面看"，认不出就当没这回事 —— 崩不起。
        const payload = event.value as Partial<ReasoningPayload> | null;
        if (!payload || typeof payload !== 'object') return;
        applyReasoning(payload as ReasoningPayload);
      },
    });

    return unsubscribe;
  }, [agent]);
}
