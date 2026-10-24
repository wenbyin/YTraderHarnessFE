// src/components/CopilotDock/useAgentMessages.ts
//
// 回答一个问题：**对话区里现在到底有没有消息**。
//
// 为什么需要它（而不是继续用「这条会话用没用过」那个业务标记）
// --------------------------------------------------------
//   `data.ts` 的 `hasStartedConversation` 是**业务**标记 —— 它在「用户点了发送」
//   那一刻就置位（见 withFirstMessage），**与后端成不成功无关**。这在"要不要
//   进历史列表"这类语义上是对的，但拿它来判断"对话区空不空"就错了。
//
//   踩过的坑：`used: true` + 一条消息都没有，是**reachable** 的落地状态 ——
//     · 后端建会话失败 / 建运行失败（那一轮没落成消息）；
//     · 会话建好了但页面在拿到 session_id 之前被刷新；
//     · 本地存储里带着旧数据、后端却换了库（历史拉不回来）。
//   按业务标记算，问候语被藏起来、消息列表又是空的 → 用户看到**一整页空白**
//   （CDP 实测复现过：`greet=false, domMessages=0`）。
//
// 为什么订阅而不是读一次（比如读 `history.messages.length`）
// ------------------------------------------------------
//   往 `agent.messages` 里写东西的**有两条**路，只看其中一条都会漏：
//     ① 灌历史 —— `useSessionHistory` 调 `agent.setMessages()`；
//     ② 真聊天 —— CopilotKit 在提交那一刻 `agent.addMessage(用户消息)`，
//        之后每一帧流式事件也会往里加（见 @ag-ui/client 的 defaultApplyEvents）。
//   两者最终都会通知 `onMessagesChanged`（`setMessages` / `addMessage` /
//   `addMessages` 内部都广播一次），所以订阅是**唯一**不漏的答案来源。
//
// ⚠️ 两个必须守住的细节
// --------------------
//   1. **流式期间回调非常密集**（每个 token 一次），所以只在「有/没有」这个
//      布尔值真的翻转时才写 state —— React 对相同值的 setState 会直接 bail out，
//      这里再显式判一次是为了少建对象、也为了意图明确。
//   2. **切会话那一帧**不能拿上一个 agent 的快照冒充新 agent 的事实：
//      agent 是 `useMemo(..., [activeId])` 出来的新实例，它的 messages 必然是
//      空的。快照带上 agent 身份，身份不匹配就直接读新 agent 自己的 messages，
//      于是"切到空会话"不会先闪一帧"有消息"。

import type { AbstractAgent, Message } from '@ag-ui/client';
import { useEffect, useState } from 'react';

/** 快照带上 agent 身份 —— 见文件头 ⚠️ 2。 */
interface MessageSnapshot {
  agent: AbstractAgent;
  hasMessages: boolean;
}

export function useAgentHasMessages(agent: AbstractAgent): boolean {
  const [snapshot, setSnapshot] = useState<MessageSnapshot>(() => ({
    agent,
    hasMessages: agent.messages.length > 0,
  }));

  useEffect(() => {
    const sync = (messages: readonly Message[]) => {
      const hasMessages = messages.length > 0;
      setSnapshot((prev) =>
        prev.agent === agent && prev.hasMessages === hasMessages
          ? prev
          : { agent, hasMessages },
      );
    };

    // 先按现状同步一次：挂载时 agent 可能已经有消息了（历史缓存命中 + setMessages
    // 早于本 effect 跑），只订阅不等通知会漏掉这一次。
    sync(agent.messages);

    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: ({ messages }) => sync(messages),
    });
    return unsubscribe;
  }, [agent]);

  return snapshot.agent === agent
    ? snapshot.hasMessages
    : agent.messages.length > 0;
}
