// src/components/CopilotDock/liveTaskFeed.ts
//
// 「这条消息属于哪个任务」的**实时**那一份 —— 只为了给 DockRenderMessage 读。
//
// 为什么需要它（后端在实时通道上**不发** kind）
// ----------------------------------------
//   后端的 `task_instruction` / `task_result` 是**落库时**才打的标
//   （`message_recorder._kind` 读 `additional_kwargs.kind`），而实时那条路
//   只发 `message.started / delta / completed`，载荷里根本没有 kind / task_id
//   （见 `run_event_projector.py` 的 MESSAGE_COMPLETED：只有 content / role /
//   tool_calls / visible）。所以：
//     · 历史通道 —— 分组信息来自消息自己的 metadata（见 taskTimeline.ts）；
//     · 实时通道 —— 分组信息只能由翻译器**顺手记一笔**，就是这里。
//
// 记什么：`messageId -> 这个任务`。任务从哪儿来
// -------------------------------------------
//   `plan.published` / `task.updated` 里的 `current_task_id`（顺带把标题也带上，
//   它是唯一一处能读到"人话任务名"的地方，见 planTasks.taskTitle）。
//   于是"某个任务在跑的时候开出来的消息"就归到了这个任务名下 ——
//   与后台把 `task_result` 打成那个 tasks 的 id 是同一个语义。
//
// ⚠️ 为什么不是 hook、也不需要订阅
// -----------------------------
//   写入发生在**消息被开出来之前**（`ensureMessageOpen` 先记一笔再发
//   TEXT_MESSAGE_START），所以消息第一次渲染时这笔记录一定已经在里面了 ——
//   不存在"先渲染成无任务、后补上轨道"的中间帧。
//   读侧因此是纯同步查表，没有 useSyncExternalStore、也没有重渲染风暴。
//
// ⚠️ 什么时候清
// ------------
//   messageId 里带着 runId + streamId（见 translator 的 currentMessageId），
//   跨运行不可能撞 —— 所以**不需要**在换运行时清空。只做一个上限兜底：
//   一次会话里看几十轮之后这张表会有点长，超过上限就整体丢掉（丢的只会是
//   已经不在界面上的旧消息，它们的行已经渲染过了；重新渲染时会退化成
//   "没有轨道"，不影响正确性，只影响那种"很久以前那轮的长对话还在屏上
//   并且又触发了一次重渲染"的极端场面）。

/** 一条消息属于哪个任务。`title` 只有实时通道拿得到（历史里没有可靠标题）。 */
export interface LiveTaskMark {
  taskId: string;
  title: string;
  planId: string;
}

/** 上限：超过就整体丢弃（理由见文件头，正确性不依赖这张表的历史长度）。 */
const MARK_LIMIT = 400;

let marks = new Map<string, LiveTaskMark>();

/** 供测试复位（模块级状态）。 */
export function resetLiveTasks(): void {
  marks = new Map();
}

/**
 * 记下"这条消息属于哪个任务"。`null` = 这条消息不属于任何任务（显式清掉）。
 *
 * ⚠️ `messageId` 为空时**什么都不做**：空 id 是我们自己的"还不知道"，
 *    拿它当键会让所有那些消息共用同一条错记录。
 */
export function noteLiveTask(
  messageId: string,
  mark: LiveTaskMark | null,
): void {
  if (messageId === '') return;

  if (!mark || mark.taskId === '') {
    marks.delete(messageId);
    return;
  }

  if (marks.size >= MARK_LIMIT) marks = new Map();
  marks.set(messageId, mark);
}

/** 这条消息属于哪个任务（没有就是 `null`）。 */
export function liveTaskOf(messageId: string): LiveTaskMark | null {
  if (messageId === '') return null;
  return marks.get(messageId) ?? null;
}
