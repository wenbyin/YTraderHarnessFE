// src/components/CopilotDock/finalAnswer.ts
//
// 「这一轮的最后一条 AIMessage 是哪一条」—— 一个纯判定。
//
// 为什么需要它（而不是用库给的那个 isCurrentMessage）
// ------------------------------------------------
//   @copilotkit/react-ui 的 Messages 组件把它算成
//   **`index === messages.length - 1`**（dist/index.mjs），也就是
//   "**数组里最后一个元素**，不管它是什么角色"：
//
//       // node_modules/@copilotkit/react-ui/dist/index.mjs
//       isCurrentMessage: index === messages.length - 1,
//
//   数组恰好以助手消息结尾时，它和"最后一条 AIMessage"重合；
//   **不以助手消息结尾时就不重合**，两种情形都已经在眼前：
//
//     · **一次运行产出多条助手消息**（react 图多个 agent 节点，见
//       runEventStream.ts 的取舍 2）。这三条里只有最后那条是"答案"，
//       前面的都是过程 —— 数组以助手消息结尾，所以那一条能拿到 currentMessage，
//       正确；但**其余几条**同样会渲染反馈图标行（库的 CSS 在
//       `:hover` 和 `@media (hover: none)` 下都会把它点亮），于是每条消息
//       看着都像有自己的反馈按钮。
//
//     · **数组以 role: 'tool' 结束**。后端现在**还没发** tool.called /
//       tool.completed（runEventStream.ts 里有 grep 结论），但事件一出，
//       一次 ReAct 轮次的消息就会是
//       `[user, assistant(带 toolCalls), tool, assistant(答案)]`。那时
//       "数组最后一个元素"是一条**工具结果**，所有助手消息都拿不到
//       currentMessage —— 反馈图标行会**整体消失**（不是错位，是全都看不见）。
//       "最后一条 AIMessage"这条规则不受影响。
//
//   所以这条规则**自己算**，不看元素在数组里的位置。
//
// ⚠️ 它判的是"最后一条",**不是**"这一轮的答案"—— 两者今天等价，将来不等价
// ---------------------------------------------------------------------
//   **历史里的**工具活动已经能识别了：后端把工具调用 / 工具结果落成
//   `kind: 'tool_activity'`，history.ts 把它带进 `metadata.kind`，
//   于是这里可以明确地**跳过**它（见 isChatAssistant）。
//
//   但**实时**那条路还识别不了：后端没有发布 tool.called / tool.completed
//   （run_event_projector 里有投影代码，但它的 tools 通道没接），AG-UI 侧
//   也就没有 TOOL_CALL_* 事件，流式产生的助手消息除了 content 之外没有
//   "这条是过程"的标记。所以对实时消息仍然**只按位置**判（需求原话：
//   "现在暂时无法识别"）。
//
//   两边的判据都集中在这一处：实时消息没有 metadata.kind，天然走"不跳过"
//   那一支；等后端把工具事件发出来，只需要在这里再加一条"跳过带 toolCalls
//   的消息"，改一处就够。
import type { Message } from '@ag-ui/client';

/**
 * 对话里**最后一条助手消息**的下标；一条助手消息都没有时返回 `-1`。
 *
 * 倒着扫而不是 `filter` + `at(-1)`：一步到位，也不为一次判定建中间数组。
 */
export function lastAssistantIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isChatAssistant(messages[i])) return i;
  }
  return -1;
}

/**
 * 这条是不是一条**对话正文**的助手消息。
 *
 * ⚠️ 光判 `role === 'assistant'` 是不够的
 * -------------------------------------
 *   工具活动记录（`kind === 'tool_activity'`）在后端契约里**也是 assistant**
 *   （契约只有 user / assistant 两个角色，工具结果没有第三个格子放，
 *   见 MessageRole 的说明）。它显示出来是"工具调用 / 工具结果"块，不是回答。
 *
 *   不排掉它的后果很具体：一轮运行若**停在工具调用上**（比如 interrupted
 *   等待审批，或者运行在本轮最后一步调了工具），那条 tool_activity 就会成为
 *   "最后一条 AIMessage" → 反馈按钮（重新生成 / 复制 / 赞 / 踩）挂到工具记录
 *   块上 —— 对着一份工具输出点"重新生成"，语义是错的。
 */
export function isChatAssistant(message: Message | undefined): boolean {
  if (message?.role !== 'assistant') return false;
  const kind = (message.metadata as { kind?: unknown } | null | undefined)
    ?.kind;
  return kind !== 'tool_activity';
}

/**
 * `index` 这条消息是不是**最后一条 AIMessage**。
 *
 * 这是"反馈图标行要不要显示"的唯一判据（渲染层见 DockRenderMessage.tsx，
 * 样式层见 style.ts 里那条 `:not(.currentMessage)`）。
 */
export function isLastAssistantMessage(
  messages: readonly Message[],
  index: number,
): boolean {
  if (index < 0) return false;
  return index === lastAssistantIndex(messages);
}

/**
 * 「这一轮回复」在消息数组里占的那一段。
 *
 * 为什么需要它
 * -----------
 *   长链路（工具循环）里，模型会连续产出**多条**消息 —— 每轮 LLM 调用一条，
 *   中间还夹着 `tool_activity` 记录。它们整体是"上一句用户提问的答复"。
 *   现在这个范围**只服务一条判据**：最后那条正文要不要关掉库自己的 loading
 *   光标（取决于"这一轮里**还有没有**一段推理在流"，那段可能在别的消息上）。
 *
 * ⚠️ 曾经它还算"思考过程该挂在哪条消息上"（anchor）
 * ------------------------------------------------
 *   2026-10-17 到 10-20 之间，折叠行只画在 anchor（本轮第一条正文助手消息）
 *   上、内容是整轮拼起来的一份。10-20 需求反转：**多个思考过程不要合并**、
 *   要按事件顺序显示。于是 anchor 没了 —— 每条消息画自己那段，位置天然正确。
 *   留着 anchor 只会让下一个人以为"还有些东西要挪到第一条上"。
 */
export interface ReplyRange {
  /** 本轮第一条消息的下标（上一条 user 之后）。 */
  start: number;
  /** 本轮最后一条消息的下标（下一条 user 之前）。 */
  end: number;
}

/**
 * `index` 落在哪一轮回复里。
 *
 * 判据只看 `role`：`user` 是一条回复的**起点**，之后的每一条（assistant /
 * tool / 未来的其他角色）都属于同一轮，直到下一条 `user`。
 */
export function replyRangeOf(
  messages: readonly Message[],
  index: number,
): ReplyRange {
  const empty: ReplyRange = { start: -1, end: -1 };
  if (index < 0 || index >= messages.length) return empty;

  // 1) 往上找本轮起点：越过 index 之后遇到的第一个 user 的后面
  let start = 0;
  for (let i = index; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      start = i + 1;
      break;
    }
  }

  // 2) 往下找本轮终点
  let end = messages.length - 1;
  for (let i = index; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') {
      // index 自己是 user 时不算终点（它属于"上一轮的结尾"这种边角）
      if (i > index) {
        end = i - 1;
        break;
      }
    }
  }
  if (end < start) return { start, end: start - 1 };
  return { start, end };
}

/**
 * 「挂不到任何消息上的工具行」该画在**哪一条**消息上 —— 本轮回复的第一条。
 *
 * ⚠️⚠️ 为什么是第一条，而不是原来的"最后一条"（2026-10-22 用户实报）
 * ---------------------------------------------------------------
 *   实时工具行靠 `messageId` 归位（见 ToolActivityPayload）。翻译器已经尽力
 *   保证每次调用都先开一条消息（`toolActivity()` 里的 `ensureMessageOpen`），
 *   但仍然会有落不了位的：`messageId` 空，或者它指向的那条消息在后来的
 *   重灌 / 重放里已经不在数组里了。这类行必须有兜底 —— 凭空消失比放错更糟。
 *
 *   原来的兜底是"挂到**最后一条**消息上"。它有一个很隐蔽的副作用：
 *   **会随时间往下漂。** 刚发生时列表里只此一条，看起来就在最上面；随着
 *   后续消息一条条进来，"最后一条"一路后移，这行工具记录就**一路往下跑**，
 *   最后停在整轮对话的末尾。用户看到的正是
 *   「工具调用：agent.enter_plan_mode 本来是在最上面的，结果跑到 task_1 正文
 *   下方了」。
 *
 *   更糟的是它还**拖着轨道走**：那行卡片会把"挂在它身上的那条消息"的
 *   `taskLinkOf()` 一起继承过去（见 DockRenderMessage 的 toolNodes），于是
 *   任务 N 的圆点/竖线被画到了末尾 —— 用户报的
 *   「task_1 的 timeline 跑到 task_2 正文上方去了」就是这么来的。
 *
 *   改成"本轮第一条"之后，位置是**稳定**的：这类工具调用在语义上就是
 *   "这一轮刚开始、还没有任何一步产出时发生的"（进入计划模式、重新规划），
 *   画在本轮最上方正是它发生的位置 —— 不再漂，也不再偷别人的节点。
 *
 * ⚠️ 缓存键是那个 messages 数组（与 taskTimeline 同一套理由）
 * ------------------------------------------------------
 *   每渲染一条消息都会问一次"我是不是那条锚点"，不缓存就是 O(n²)；
 *   CopilotKit 每加一条消息换一个新数组，引用本身就是版本号。
 */
const anchorCache = new WeakMap<readonly Message[], number>();

export function orphanAnchorIndex(messages: readonly Message[]): number {
  const hit = anchorCache.get(messages);
  if (hit !== undefined) return hit;

  const last = lastAssistantIndex(messages);
  // 一条助手消息都没有（用户刚发出去、还没回来）→ 无处可挂，返回 -1。
  let anchor = -1;
  if (last >= 0) {
    const { start } = replyRangeOf(messages, last);
    anchor = start >= 0 && start <= last ? start : last;
  }

  anchorCache.set(messages, anchor);
  return anchor;
}

/** `index` 这条消息是不是"孤儿工具行"该挂的那一条。 */
export function isOrphanAnchor(
  messages: readonly Message[],
  index: number,
): boolean {
  return index >= 0 && index === orphanAnchorIndex(messages);
}
