// src/components/CopilotDock/useHiddenWork.ts
//
// 订阅「这会儿有个**看不见正文**的模型在干活」这件事。
//
// 它在说什么
// ----------
//   后端的 `message.started` / `message.completed` 带 `role` + `visible`
//   （见 agentRuntime.ts 的 MessageMeta）。`visible: false` 的那一段是
//   **给用户干活、但不是给用户看**的 —— 上下文压缩、意图分类、打分复核……
//   它一个字的 delta 都不发，`message.completed` 的 content 是空串。
//
//   于是界面上会出现一段"什么都收不到"的静默期（实测日志里那一段是 7 秒）。
//   后端为了让这段时间不看起来像卡住，**特意**照样发 started / completed
//   （原文大意：「没有 message.started，前端在那几秒里什么都收不到」）。
//   本 hook 就是把这两帧翻译成"当前有几件看不见的事在跑"。
//
// ⚠️ 前端不拿 `visible` 之外的东西判这件事 —— 见 runEventStream.ts 那段取舍。
//
// 为什么按「深度」而不是按「最后一个相位」
// --------------------------------
//   一次运行里可能有好几段不可见的调用（压缩 + 分类），它们是**可以嵌套/连着**
//   来的。拿"最后一个相位"当判据，第二段 started 之前那一下空档会把它闪掉，
//   而两段之间的顺序后端并不保证不交叉。用深度：start +1、end -1，归零才消。
//
// ⚠️ 换了 agent（切会话）必须清干净
// ----------------------------
//   后续帧是新 agent 发的，而订阅已经换到它身上 —— 旧 agent 那半件"还在跑"
//   的事永远收不到它的 end，不重置的话那行会一直转下去。

import type { AbstractAgent } from '@ag-ui/client';
import { useEffect, useState } from 'react';

import type { ProgressPayload } from './runEventStream';
import { PROGRESS_CUSTOM_EVENT } from './runEventStream';

/** 当前正在跑、但界面上还没有字的那件活儿。`null` = 没有（或已经有字了）。 */
export interface HiddenWork {
  /** 节点名（`builder` / `agent` / `tools`…）；来自模型段时是 `null`。 */
  node: string | null;
  /** 模型角色（`ModelRole` 原值）；文案由 `progressLabel` 决定。 */
  role: string | null;
  /** 同时有几段在跑（>1 时界面不需要区分，取最后一次的 node/role）。 */
  depth: number;
}

const IDLE: HiddenWork = { node: null, role: null, depth: 0 };

export function useHiddenWork(agent: AbstractAgent): HiddenWork | null {
  const [state, setState] = useState<{
    work: HiddenWork;
    /** 这一轮有没有已经流出过正文 —— 有就不需要再挂"正在…"了。 */
    hasText: boolean;
  }>({ work: IDLE, hasText: false });

  useEffect(() => {
    // 换了 agent 就从头算 —— 见文件头 ⚠️。
    setState({ work: IDLE, hasText: false });

    const { unsubscribe } = agent.subscribe({
      /**
       * ⚠️ 正文一开始流就**让位**：那时用户已经看到字在动了，再挂一个
       *    "正在组织回答…"是重复反馈（而且会和流式正文同时闪）。
       *    真正需要它的正是"一个字都还没有"的那段。
       */
      onTextMessageContentEvent: ({ event }) => {
        // ⚠️ **纯空白不算"有字了"**：实测日志里有一段 `message.completed`
        //    的 content 就是 `"\n\n"`，它会把正文通道打开却什么都不显示 ——
        //    按它算"已有正文"，loading 会在真正的回答开始前先消失一次。
        const delta = (event as { delta?: unknown }).delta;
        if (typeof delta === 'string' && delta.trim() === '') return {};

        setState((prev) => (prev.hasText ? prev : { ...prev, hasText: true }));
        return {};
      },
      /** 新一轮开始：清掉上一轮残留，免得旧的"正在…"挂着不走。 */
      onRunStartedEvent: () => {
        setState({ work: IDLE, hasText: false });
        return {};
      },
      onCustomEvent: ({ event }) => {
        if (event.name !== PROGRESS_CUSTOM_EVENT) return;

        // 契约是 `CUSTOM`，value 是外部形状：认不出来就当没这回事，
        // 不要抛 —— 这一层的作用只是"显示一行"，崩不起。
        const payload = event.value as Partial<ProgressPayload> | null;
        if (!payload || typeof payload !== 'object') return;

        if (payload.phase === 'start') {
          setState((prev) => ({
            hasText: prev.hasText,
            work: {
              node: payload.node ?? null,
              role: payload.role ?? null,
              depth: prev.work.depth + 1,
            },
          }));
          return;
        }
        if (payload.phase === 'end') {
          setState((prev) => ({
            hasText: prev.hasText,
            work: {
              ...prev.work,
              depth: Math.max(0, prev.work.depth - 1),
            },
          }));
        }
      },
    });

    return unsubscribe;
  }, [agent]);

  // ⚠️ 两个条件**都要**：depth 归零说明活儿干完了；hasText 说明正文本身
  //    已经在给反馈了 —— 这两种情况下再挂一行都是噪音。
  return state.work.depth > 0 && !state.hasText ? state.work : null;
}
