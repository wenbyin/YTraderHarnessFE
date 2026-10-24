// src/components/CopilotDock/liveInteractionFeed.ts
//
// **实时**那一侧的 HITL 问答记录 —— 「我答了什么」的即时副本，给 DockRenderMessage 读。
//
// 为什么必须有这一份（历史里明明已经落库了）
// -----------------------------------
//   后端在 resume 路径把问答落成一条 `kind: 'interaction'` 的消息
//   （`message_recorder.record_interaction`），所以**刷新之后**历史里一定有它。
//   但**实时**这条路上它根本不存在：问答是 `Command(resume=…)` 走回去的，
//   不经过任何一条 AG-UI 消息 —— 用户答完之后，自己说过的话在对话里
//   一个字都不留，直到刷新才冒出来（用户 2026-10-21 报的就是这个）。
//
//   所以这里记一份**只属于当前页面**的副本：答完的那一刻就画进对话流，
//   刷新之后由历史那份接管（那时消息是后端 id，这份副本的锚点自然对不上，
//   不会重复）。
//
// 为什么要"锚"在某条消息上，而不是画在最末尾
// -------------------------------------
//   答完之后运行会继续：新的助手消息一条条追加进来。挂在"最后一条消息下面"
//   的话，随着继续生成，这张卡会被越挤越靠上 —— 它其实是**在那些回答之前**
//   发生的。所以记下"提交那一刻的最后一条消息 id"（`anchor`），卡片就固定
//   画在那条消息**下面**：审批前的内容 → 我的回答 → 审批后的回答，
//   与历史里的 seq 顺序一致。
//
// 什么时候清空
// ----------
//   原则上它可以一直留着（它就是本页这一轮的对话记录）。切会话 / 灌历史之后
//   消息整份换成后端的 id，锚点自然对不上、卡片不再出现 —— 不需要自己的
//   生命周期，也就不会因为"清早了"把刚答的记录弄丢。
//   只有测试要复位（`resetLiveInteractions`）。

import { useSyncExternalStore } from 'react';

import type { InteractionView } from './history';

/** 一条实时问答：挂在 `anchor` 那条消息下面。 */
export interface LiveInteraction {
  /** 稳定 key。同一条消息下面可能挂着多次问答（一组多个中断）。 */
  key: string;
  /** 提交那一刻的"最后一条消息"id —— 卡片画在它下面。 */
  anchor: string;
  view: InteractionView;
}

const EMPTY: LiveInteraction[] = [];

let items: LiveInteraction[] = EMPTY;
/** 最近一次渲染时看到的"最后一条消息"id（见文件头：卡片要挂在它下面）。 */
let currentAnchor = '';
/** 自增序号，用来给 key —— 同一次问答可能连着提交好几条。 */
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 渲染层把"此刻最后一条消息是谁"报上来（见文件头）。重复报同一个值不通知。 */
export function noteAnchor(messageId: string): void {
  if (messageId === currentAnchor) return;
  currentAnchor = messageId;
}

/** 当前锚点（测试用）。 */
export function currentInteractionAnchor(): string {
  return currentAnchor;
}

/** 供测试复位（模块级状态）。 */
export function resetLiveInteractions(): void {
  items = EMPTY;
  currentAnchor = '';
  seq = 0;
  emit();
}

/**
 * 记一次问答。锚点取**最后一次 noteAnchor 报上来的**那条消息。
 *
 * ⚠️ 没有锚点（界面上一条消息都没有）时仍然记 —— 那种情况卡片画不出来，
 *    但也不该把"用户答过"这件事悄悄吞掉（至少排障时能看见）。
 */
export function pushInteraction(view: InteractionView): void {
  seq += 1;
  items = [...items, { key: `live-${seq}`, anchor: currentAnchor, view }];
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): LiveInteraction[] {
  return items;
}

/** 本页这一轮答过的问答（按提交顺序）。 */
export function useLiveInteractions(): LiveInteraction[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
