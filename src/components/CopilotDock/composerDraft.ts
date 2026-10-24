// src/components/CopilotDock/composerDraft.ts
//
// 「把这段话填回输入框」—— 用户消息卡片上那个「编辑」按钮的落地方式。
//
// 为什么是一个模块级指令（而不是 props）
// ---------------------------------
//   按钮画在**消息列表**里（DockRenderMessage），输入框是 CopilotKit 的
//   `Input` 插槽（Composer），两者之间隔着 CopilotKit 那一层，没有可以传
//   props 的路 —— 同 reasoningStream / liveToolFeed / hitlSignal 一个处境。
//   一条一次性指令 + 订阅，比把 CopilotChat 整棵子树用 context 包起来轻得多。
//
// 为什么只是"填回去"、不删原消息、不重发
// ----------------------------------
//   后端的运行是不可变的（一次 run 一条记录，thread checkpoint 在服务端），
//   前端没有"撤回上一条再重跑"的接口。所以「编辑」= 把原文放回输入框、
//   光标落到末尾，用户改完自己发 —— 语义诚实，也不会造出界面与后端不一致
//   的状态（那种不一致要等到下一次刷新才暴露，是最难查的一类）。
//
// 为什么带 `nonce`
// -------------
//   连续两次编辑**同一段文本**时（用户点了编辑、改乱、又点一次编辑），
//   只看 text 是"没变化"，effect 不会重跑，输入框里的乱字就留着了。
//   每次请求都递增，订阅方按"这一版是不是我已经吃过的"判断。

import { useSyncExternalStore } from 'react';

export interface ComposerDraft {
  text: string;
  /** 请求序号。每次「编辑」递增 —— 见文件头。 */
  nonce: number;
}

let current: ComposerDraft | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 请求把这段文字填进输入框。
 *
 * 空文本直接忽略：一个空的输入框配上"编辑"，点下去什么都不会发生，
 * 只会让用户怀疑按钮坏了。
 */
export function requestComposerDraft(text: string): void {
  if (text.trim() === '') return;
  seq += 1;
  current = { text, nonce: seq };
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ComposerDraft | null {
  return current;
}

/** 最近一次「编辑」请求。Composer 订阅它、把文本灌进自己的 state。 */
export function useComposerDraft(): ComposerDraft | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 供测试复位（模块级状态）。 */
export function resetComposerDraft(): void {
  current = null;
  seq = 0;
  notify();
}
