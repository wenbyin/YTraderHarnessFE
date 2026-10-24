// src/components/CopilotDock/liveToolFeed.ts
//
// 「这一轮调过哪些工具」的**实时**那一份，放在模块级 store 里 —— 只为了给
// DockRenderMessage 读。
//
// 一份记录 = 一次调用（`tool.called` 就建行，完成 / 失败原地改图标，
// 见 useToolActivity.ts）。所以这一份里**可能还有在跑的**，渲染层要按
// `status` 画转圈 / 勾 / 叉。
//
// 为什么要绕一个 store，而不是 props 直传
// --------------------------------------
//   `RenderMessage` 是**作为组件**交给 CopilotChat 的（`RenderMessage={DockRenderMessage}`），
//   中间没有任何我们能插 props 的地方；`Messages` 传给它的只有库自己的那几个字段。
//   所以"索引.tsx 拿到的 toolActivity"要进到渲染层，只能走平行通道 ——
//   与 reasoningStream 同一套做法（那边也是按 messageId 存推理）。
//
//   ⚠️ 千万别改成 `RenderMessage={(props) => <DockRenderMessage {...props} liveTools={…}/>}`：
//      这样每次 items 变化都会造出一个**新的组件类型**，React 会把整棵消息树
//      卸载重挂 —— 逐字淡入刚要跑就被打断，滚动位置也归零。
//
// 这些行为什么要进消息流、且要按 messageId 归位
// --------------------------------------------
//   原先是 LiveActivityOverlay 画的（贴输入框上沿、justify-content: flex-end），
//   于是它永远在**正文下方**：模型还在流式写、工具已经跑完时，工具记录挂着
//   正文的末尾，看着像"工具调用跑到了回答下面"。真实顺序是**先工具、后回答**。
//
//   现在由 DockRenderMessage 渲染：每条消息是一个 section，section 内部顺序固定为
//   「深度思考 → 正文 → 工具行」。工具事件带着 `messageId`（见 runEventStream），
//   所以实时那一行会落到**它所属那一步**的 section 里；刷新后从历史读到的
//   tool_activity 本来就是独立的、按 seq 排好的一条消息 —— 两边结构一致。
//
// 什么时候清空
// ----------
//   `useToolActivity` 在 RUN_STARTED（新一轮）与换会话（agent 变了）时清空自己，
//   index.tsx 把这个值同步过来，所以这里不需要自己的生命周期。

import { useSyncExternalStore } from 'react';
import type { ToolActivityItem } from './useToolActivity';

const EMPTY: ToolActivityItem[] = [];

let items: ToolActivityItem[] = EMPTY;
const listeners = new Set<() => void>();

/** 供测试复位（模块级状态）。 */
export function resetLiveToolItems(): void {
  items = EMPTY;
  for (const listener of listeners) listener();
}

/**
 * 同步这一轮的工具记录。
 *
 * ⚠️ 引用相等就直接返回：`useToolActivity` 只在真的变了的时候造新数组，
 *    每次渲染都通知一遍会让所有消息跟着重渲染。
 */
export function setLiveToolItems(next: readonly ToolActivityItem[]): void {
  if (next === items) return;
  items = next as ToolActivityItem[];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ToolActivityItem[] {
  return items;
}

/** 当前这一轮调过的工具（按调用开始的顺序，含还在跑的）。 */
export function useLiveToolItems(): ToolActivityItem[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
