// src/components/CopilotDock/DockRenderMessage.tsx
//
// 覆盖 CopilotChat 默认的消息渲染 —— **只改一件事**：谁算"当前消息"。
//
// 为什么要覆盖
// ------------
//   库的 Messages 把 `isCurrentMessage` 算成 `index === messages.length - 1`
//   （"数组里最后一个元素"，不管角色），见 finalAnswer.ts 的推导。
//   这个值往下传两处：
//     · AssistantMessage 的 `isCurrentMessage` prop →
//       控件行上的 `.copilotKitMessageControls.currentMessage` 类 →
//       库的 CSS `.currentMessage { opacity: 1 !important }` 就是"这一行常显"；
//     · `isLoading` / `isGenerating`（正在生成时的光标）。
//
//   我们要的是"**最后一条 AIMessage**"，两者在"数组以助手消息结尾"时重合、
//   否则不重合（多条助手消息 / 将来以 tool 消息结尾，见 finalAnswer.ts）。
//
// ⚠️ 除了这一处判定，其余 props **逐条照抄库的实现**（dist/index.mjs 的
//    RenderMessage），一个都不省：
//      `data-message-role` / `subComponent` / `rawData` / `message` / `messages` /
//      `isLoading` / `isGenerating` / `onRegenerate` / `onCopy` / `onThumbsUp` /
//      `onThumbsDown` / `feedback` / `markdownTagRenderers` / `ImageRenderer`
//    这些标记与 props 是 style.ts 里几十条覆盖样式的挂钩（`.copilotKitMarkdown`、
//    `.copilotKitAssistantMessage`、`.copilotKitMessageControls` …），
//    少传一个就是一段样式静默失效 —— 而界面上只会"看起来有点不对"。
//    所以这个文件**不是**"自己重写一个消息组件"，是"包一层，只改一个 prop"。
//
// ⚠️ 用户消息也必须照旧交给库的 UserMessage：不接管的话用户气泡会整段消失
//    （switch 的 default 分支返回 null）。
//
// 2026-10-22 起多了一个分支：**任务时间线**
// --------------------------------------
//   用户原话：「识别后端的 message 类型。现在 main 节点的 task_instruction，
//   task_result 也会回复。将他也生成在对话框中。但是 task 相关的内容左侧添加
//   纵向 timeline，灰色节点以 task 为单位」。
//
//   所以这里除了"谁算当前消息"之外，现在还会回答"这条消息在哪个任务里"：
//   分组结果来自 `taskTimeline.taskRowOf(messages, id)`（纯逻辑、有缓存），
//   渲染上就是在 section 里多两个绝对定位的装饰节点（竖线 + 空心圆点）和一
//   行小标题 —— 见 style.ts 的 taskTimeline 那一段。
//
//   ⚠️ 任务行**不走库的 AssistantMessage / UserMessage**：那两条会给正文套上
//   气泡、挂上复制/反馈图标，而时间线里的一行是"过程记录"，与工具行同级。
//   正文改用库的 `Markdown`（与气泡里那份是同一个渲染器，样式一致）。
import type { Message } from '@ag-ui/client';
import type {
  AssistantMessageProps,
  RenderMessageProps,
} from '@copilotkit/react-ui';
import {
  AssistantMessage as DefaultAssistantMessage,
  ImageRenderer as DefaultImageRenderer,
  UserMessage as DefaultUserMessage,
  Markdown,
} from '@copilotkit/react-ui';
import React, { useEffect } from 'react';

import {
  isLastAssistantMessage,
  isOrphanAnchor,
  replyRangeOf,
} from './finalAnswer';
import type { InteractionView, ToolActivityView } from './history';
import InteractionMessage from './InteractionMessage';
import { noteAnchor, useLiveInteractions } from './liveInteractionFeed';
import { useLiveToolItems } from './liveToolFeed';
import ReasoningBlock from './ReasoningBlock';
import {
  reasoningOfMessage,
  useReasoningOf,
  useReasoningVersion,
} from './reasoningStream';
import {
  commitRevealCount,
  makeStreamingRenderers,
  revealFromOf,
  type StreamingRenderers,
} from './streamingMarkdown';
import { useStyles } from './style';
import ToolActivityCards, { type TaskLink } from './ToolActivityRow';
import {
  type TaskRow,
  taskMessageOf,
  taskRowLabel,
  taskRowOf,
  taskShortTitle,
} from './taskTimeline';
import UserMessageActions, { userMessageText } from './UserMessageActions';
import type { ToolActivityItem } from './useToolActivity';

/**
 * CopilotKit 在 AG-UI 的消息对象上加的扩展字段（库的类型里没有）。
 *
 * ⚠️ 这个字段**不是恒为 undefined** 的：`useCopilotChatInternal` 的
 *    `resolvedMessages` 会给**每一条**助手消息挂上它（coagent state bridge，
 *    本面板下渲染 null）。库的 `AssistantMessage` 拿它去顶 `subComponent` ——
 *    推理块那件事的坑就在这儿，详见下面 assistant 分支的注释。
 */
type WithGenerativeUi = { generativeUI?: () => React.ReactNode };

/** 我们在 `metadata` 里塞的字段（由 history.ts 写进去，见那边的 HistoryMeta）。 */
type WithHistoryMeta = {
  kind?: unknown;
  toolActivity?: unknown;
  interaction?: unknown;
  reasoning?: unknown;
};

/**
 * 这条消息的推理从哪来 —— 见 `reasoningStream.ts` 的 `useReasoningOf`。
 *
 * ⚠️ 2026-10-20：它又变回**逐条消息各查各的**了
 * -------------------------------------------------
 *   10-17 那版是"一条回复只画一块、内容由整轮拼成"，所以这里不能用自己的
 *   hook（要读别的消息）。10-20 需求反转成"多个思考过程不要合并、按事件
 *   顺序显示"，于是每条消息只关心自己那一段 —— 用 hook 才是对的：订阅
 *   自己那条，流式过来时只有它重渲染（理由见 useReasoningOf 的注释）。
 */

/**
 * 这条消息是不是一条「工具活动」记录（工具调用 / 工具结果），是就取出它的渲染原料。
 *
 * ⚠️ 为什么要在这里分流、而不是让 history.ts 少塞几条
 * -------------------------------------------------
 *   把它当普通助手消息渲染的话，工具的原始输出会显示成"模型说的话"
 *   （工具名 + 参数 JSON 以正文姿态出现在对话里）。两者的**语义完全不同**：
 *   一个是模型讲的，一个是工具返回的。所以形态要分开 —— 详见 ToolActivityRow.tsx。
 *
 * ⚠️ 实时的消息不带这个 metadata（它们来自 AG-UI 事件，没有后端 kind），
 *   所以判据是"metadata 里明确写了 tool_activity"，不是"不是 chat 就是它"。
 */
function toolActivityViewOf(message: {
  metadata?: unknown;
}): ToolActivityView | null {
  const meta = message.metadata as WithHistoryMeta | null | undefined;
  if (meta?.kind !== 'tool_activity') return null;

  const view = meta.toolActivity;
  if (
    !view ||
    typeof view !== 'object' ||
    !Array.isArray((view as ToolActivityView).calls)
  ) {
    return null;
  }

  const parsed = view as ToolActivityView;
  return {
    calls: parsed.calls,
    text: typeof parsed.text === 'string' ? parsed.text : '',
  };
}

/**
 * 这条消息是不是一条 **HITL 问答记录**（历史通道的 `kind: 'interaction'`），
 * 是就取出它的问题与答案。
 *
 * ⚠️ 判据同样是"metadata 里明确写了"，不是"角色是 user 且带 interaction 块"
 * ----------------------------------------------------------------
 *   实时那条路没有这种消息（问答是在中断里发生的，回答走 resume，不产生
 *   AG-UI 消息）。所以拿不到 metadata 时一律返回 `null`，交给普通用户/助手分支 ——
 *   别让一条普通的用户消息因为"看起来像问答"就变成卡片。
 */
function interactionViewOf(message: {
  metadata?: unknown;
}): InteractionView | null {
  const meta = message.metadata as WithHistoryMeta | null | undefined;
  if (meta?.kind !== 'interaction') return null;

  const view = meta.interaction;
  if (!view || typeof view !== 'object') return null;

  const parsed = view as InteractionView;
  if (!Array.isArray(parsed.questions)) return null;
  if (parsed.questions.length === 0) return null;

  const answers: Record<string, string> = {};
  if (parsed.answers && typeof parsed.answers === 'object') {
    for (const [key, value] of Object.entries(parsed.answers)) {
      if (typeof value === 'string') answers[key] = value;
    }
  }

  return { questions: parsed.questions, answers };
}

/**
 * 这条消息是不是**这个页面里刚产生的**（不是从后端历史灌进来的）。
 *
 * 只有一个用途：决定"从消息栏上移入对话"那个进入动画给不给。历史里那几十条
 * 是在一次 `setMessages` 里一起出现的，让它们一起滑进来是纯粹的噪音。
 *
 * ⚠️ 判据是"带不带后端 kind" —— 灌进来的每一条都由 history.ts 写好
 *    `metadata.kind`（见 HistoryMeta），而 CopilotKit 自己产生的消息没有它。
 */
function isLocalMessage(message: { metadata?: unknown }): boolean {
  const meta = message.metadata as WithHistoryMeta | null | undefined;
  return meta?.kind === undefined;
}

/**
 * 这一批消息的 id 集合 —— 判"某条工具行还找不找得到自己的那一步"。
 *
 * 缓存键是 messages 数组本身（同 taskTimeline 的理由）：每渲染一条消息都要
 * 问一次，不缓存就是 O(n²)，而流式时每帧都在重渲染。
 */
const idSets = new WeakMap<readonly Message[], Set<string>>();

function messageIds(messages: readonly Message[]): Set<string> {
  const hit = idSets.get(messages);
  if (hit) return hit;
  const set = new Set(messages.map((item) => item.id));
  idSets.set(messages, set);
  return set;
}

/**
 * 「挂不到任何消息上的」实时工具行 —— 只有本轮**第一条**消息要回答这个问题。
 *
 * 判据与理由见调用点的注释（为什么不再挂"最后一条"）。
 */
function orphanToolsOf(
  messages: readonly Message[],
  index: number,
  items: readonly ToolActivityItem[],
): ToolActivityItem[] {
  if (!isOrphanAnchor(messages, index)) return [];

  const known = messageIds(messages);
  return items.filter((item) => {
    const sectionId = item.messageId ?? '';
    return sectionId === '' || !known.has(sectionId);
  });
}

/**
 * 时间线上的两枚装饰节点：一根竖线 +（仅组首）一个空心圆点。
 *
 * ⚠️ 为什么是**两个裸 span**而不是一个带伪元素的容器
 * ------------------------------------------------
 *   section 是 flex 列、且 `> * + *` 会给相邻子项补 12px 间距。绝对定位的
 *   子项不参与 flex 排布，所以它们作为 section 的**直接子节点**是安全的
 *   （`margin-block: 0` 那条规则对它们也无意义）。用伪元素的话位置信息会
 *   散在两个选择器里，而且 `[data-section-view] > *` 这类规则管不到伪元素 ——
 *   一旦将来要按状态改圆点（跑完 / 失败）就没有挂点。
 *
 * 位置与外观全在 style.ts 的 taskTimeline 段（同一处定义 x 坐标，圆点与
 * 竖线才能对齐）。
 */
const TaskRail: React.FC<{ dot?: boolean }> = ({ dot = false }) => (
  <>
    <span data-task-rail="true" aria-hidden="true" />
    {dot ? <span data-task-node="true" aria-hidden="true" /> : null}
  </>
);

/**
 * 组首那行小标题。
 *
 * 有任务名就写任务名（实时通道能从 plan 事件里读到，见 planTasks.taskTitle）；
 * 读不到时退回角色词 —— 历史里任务名**没有可靠来源**（task_instruction 的正文
 * 是一整段提示词，不是标题），所以宁可只写"任务指令"。
 *
 * ⚠️ 任务名要**收短**（2026-10-22 用户："不要显示全文"）
 * --------------------------------------------------
 *   后端没有 per-task 标题字段，`title` 是整段 `description`（"目标：… 输入：…"）。
 *   从前是把全文塞进一行再让 CSS 切，切出来是半截废话。现在由
 *   `taskTimeline.taskShortTitle` 取第一句，全文仍留在 `title` 属性里悬停可见。
 *
 * ⚠️ `ordinal === 0` 时**不写数字**（2026-10-22 第五轮）：序号来自任务 id 的
 *   `:tN` 尾巴（taskTimeline.planIndexOf），模型哪天给了 `research` 这种
 *   local id 就读不出来。这时候写"任务 0"比不写更糟 —— 用户会当成一个真编号。
 */
function taskHead(row: TaskRow): string {
  const label = taskShortTitle(taskRowLabel(row));
  const head = row.ordinal > 0 ? `任务 ${row.ordinal}` : '任务';
  return label === '' ? head : `${head} · ${label}`;
}

const DockRenderMessage: React.FC<RenderMessageProps> = ({
  message,
  messages,
  inProgress,
  index,
  AssistantMessage = DefaultAssistantMessage,
  UserMessage = DefaultUserMessage,
  ImageRenderer = DefaultImageRenderer,
  onRegenerate,
  onCopy,
  onThumbsUp,
  onThumbsDown,
  messageFeedback,
  markdownTagRenderers,
}) => {
  // 唯一的自定义：不再用"数组最后一个元素"，改用"最后一条 AIMessage"。
  const isFinalAnswer = isLastAssistantMessage(messages, index);

  /**
   * ---- 思考过程：**每条消息画自己那一段，按事件顺序，不合并** ----
   *
   * 需求原话（2026-10-20）：「刷新之后这些工具调用思考过程 按照事件顺序排序，
   * 多个思考过程也不要合并了，并且 tool_activity 的信息也正确显示」。
   *
   * ⚠️ 这一版**推翻了 2026-10-17 的"整轮合并成一块"**
   * ---------------------------------------------------
   *   那一版把一轮里所有推理拼成一份、只挂在**本轮第一条正文助手消息**上，
   *   理由是"一个回复上方只能有一个思考过程"。副作用是**顺序信息全丢了**：
   *   长链路的界面变成"一列工具行 + 最后一大块思考"，而真实顺序是
   *   「想一段 → 调工具 → 再想一段 → 再调工具 → 写答案」。
   *
   *   而后端本来就是**每条消息各带一段** `reasoning_content`（见 history.ts
   *   的 reasoningOf），也本来就让 seq 严格递增（见 toAgentMessages 的顺序
   *   说明）。所以逐条画就是事件顺序 —— 不需要挪、不需要拼。
   *
   * ⚠️ 折叠行排在消息**自己前面**，工具记录也一样
   * --------------------------------------------
   *   工具那条消息上的推理是"决定调这个工具"的那段思考，顺序上先于调用
   *   本身；画在工具行下面会读成"调完才想"。见下面 tool_activity 分支。
   */
  const ownReasoning = useReasoningOf(message);

  /**
   * 这一轮在数组里占的那一段 —— **只**服务下面那条判据：
   * "最后一条要不要关掉库自己的 loading 光标"。
   */
  const range = replyRangeOf(messages, index);

  /**
   * 要不要订阅"整轮"的版本号。
   *
   * 只有**最后一条且正在跑**需要：那段还在流的推理可能挂在**别的**消息上
   * （长链路里前一步的推理先流完、答案那条才开出来），单条订阅看不见它。
   * 不订阅的话，前一段推理还在流时下方小圆点会跟我们的转圈同时出现 ——
   * 就是"两个 loading"那个老问题，只是在长链路上。
   *
   * ⚠️ 其余消息**不订阅**：一段流要吐几百个 token，让每条消息都去重算
   *    "整轮有没有在流"纯属浪费（见 useReasoningVersion 的注释）。
   */
  const scansReply = inProgress && isFinalAnswer;
  useReasoningVersion(scansReply);

  /**
   * 「这一轮里还有没有一段推理在流」—— 取的是**整轮**的状态，不是这一条自己的。
   *
   * ⚠️ 它决定要不要**关掉库自己那个 loading 光标**（`AssistantMessage` 里
   *    `isLoading && <LoadingIcon/>`，渲染在气泡**下方**）。不关的话同一个
   *    时刻有两个 loading：折叠行里一个转圈、气泡下面一组跳动的小圆点。
   *
   * ⚠️ 为什么是"**流式时**才关"而不是"有推理就关"
   * ------------------------------------------
   *   推理收尾之后、正文第一个字到之前，还有一小段空隙。那时折叠行已经变成
   *   **静止**的「思考过程」，不再是 loading 提示 —— 这时候把库的光标也关掉，
   *   界面上就一个"在动的东西"都没有了，看起来像卡死。
   *   所以判据只跟"我们的 loading 现在可见吗"走，与"有没有推理"无关。
   */
  const replyStreaming =
    scansReply && range.start >= 0 && range.end >= range.start
      ? messages
          .slice(range.start, range.end + 1)
          .some((item) => reasoningOfMessage(item)?.streaming === true)
      : false;

  /**
   * 逐字淡入要用的 class（`charIn` 在 style.ts 里带 keyframes）。
   * `useStyles` 是 hook，必须无条件调 —— 所以放在这里，不进下面的 switch。
   */
  const { styles } = useStyles();

  /**
   * 这一轮**调过的工具**（实时通道）：一行一次调用，带 running / done / error。
   *
   * ⚠️ 2026-10-20 起按 `messageId` **归位到各自的 section**（原来是整轮堆在
   *    最后一条正文上方）。理由：刷新之后历史里的工具行是独立消息、天然落在
   *    正确的步之间，实时却把整轮堆在末尾 —— 同一段对话两种样子。
   *    归位的落点见下面 `toolRows`。
   *
   * `LiveActivityOverlay` 那枚「正在调用工具…」胶囊仍然保留：它是**此刻在发生
   * 什么**的瞬时提示（贴在输入框上沿），工具行是**已经发生了什么**的记录。
   */
  const liveTools = useLiveToolItems();

  /**
   * 这条消息是不是**正在流式生成的那条回答** —— 逐字淡入只对它开。
   *
   * 历史消息 / 已经收尾的消息一个字都不切：span 只是"逐字出现"的载体，
   * 没有新字要出现时留着它只有开销（长回答几千个 span）。
   */
  const isStreamingAnswer =
    message.role === 'assistant' &&
    isFinalAnswer &&
    inProgress &&
    typeof message.content === 'string' &&
    message.content !== '';

  /**
   * 这一次渲染的 markdown components（会逐字淡入）。
   *
   * ⚠️ `from` 取的是**上一次渲染走过的字数**（按 message.id 记，见
   *    streamingMarkdown 的 watermarks），不是 content.length —— 后者比文档
   *    顺序的字数多（markdown 语法符号被解析掉了），拿它做水位线会永远错位。
   *    第一次渲染时退化成 content.length：等于"这句现有的字都不淡入"，
   *    只从下一个 delta 开始。
   */
  const reveal: StreamingRenderers | null = isStreamingAnswer
    ? makeStreamingRenderers({
        base: markdownTagRenderers as Record<string, unknown> | undefined,
        className: styles.charIn,
        from: revealFromOf(message.id) ?? (message.content as string).length,
      })
    : null;

  /**
   * 提交后把"这次走到第几个字"记下来 —— 下一次渲染的水位线。
   *
   * 必须等子组件渲染完才能读到（`readCount` 是渲染过程中累加的），所以放
   * effect 里；不带依赖 = 每次都跑（流式时每帧都在长，本来就要每次更新）。
   */
  useEffect(() => {
    if (reveal && message.id) commitRevealCount(message.id, reveal.readCount());
  });

  /**
   * 这条消息自己那段推理的折叠行（没有推理就 `null`，一个节点都不多）。
   *
   * 正文消息和工具记录用的是**同一个**节点 —— 两者都是"这一步想了什么"，
   * 只是下面跟着的东西不同（气泡 / 工具行）。
   */
  const reasoningNode = ownReasoning ? (
    <ReasoningBlock reasoning={ownReasoning} />
  ) : null;

  /** 这条消息自带的工具记录（历史通道：`kind: 'tool_activity'`）。 */
  const toolActivity = toolActivityViewOf(message);
  /** 这条消息是 HITL 问答记录（历史通道：`kind: 'interaction'`）。 */
  const interaction = interactionViewOf(message);

  /**
   * ⚠️ 「工具结果」那条的正文**不画**
   * --------------------------------
   *   后端对同一次调用落两条 `tool_activity`：一条带 `tool_call` 块（模型的
   *   旁白 + 调用），一条只有输出文本（`ToolMessage` 的内容）。后者那段文本
   *   是**工具的产出**（JSON / 原始日志），把它当"正文"渲染出来就是往聊天窗
   *   里倒 JSON —— 需求明确「只展示工具名，不展示结果」。
   *   判据就是"有没有调用"（`calls` 为空 = 结果那条），见 ToolActivityView。
   */
  const isToolResult = toolActivity !== null && toolActivity.calls.length === 0;

  /**
   * 这一次的工具调用：**按"这一步"归位**，两种通道同一个落点。
   *
   *   · 历史：这条消息自己带着（`tool_activity` 的 `calls`）；
   *   · 实时：`useLiveToolItems` 里 `messageId === 这条消息` 的那些
   *     （id 由翻译器打上，见 ToolActivityPayload.messageId）。
   *
   * 这正是"SSE 与 message 渲染必须一致"的一半：历史里工具行本来就是独立的
   * 消息、天然落在正确的步之间；实时若在整轮末尾另起一堆，看起来就是两套界面。
   */
  const liveOfSection = liveTools.filter(
    (item) => (item.messageId ?? '') === message.id,
  );

  /**
   * 落不了位的实时工具行（`messageId` 空 / 指不到任何消息）—— 兜底挂在
   * **本轮第一条**消息上，并且画在那条消息**上方**。
   *
   * ⚠️⚠️ 2026-10-22 改口径：原来是"挂到最后一条"（用户实报了两个症状）
   * -------------------------------------------------------------
   *   ① **它会往下漂**：这类调用（典型的是 `agent.enter_plan_mode` ——
   *      发生在计划还没建出来的时候）刚出现时列表里只有它，看着在最上面；
   *      后续消息一条条进来，"最后一条"一路后移，它就被一路推到底部。
   *      用户原话：「本来是在最上面的，结果跑到 task_1 正文下方了」。
   *   ② **它会把别人的轨道一起拖走**：卡片上的 `task` 取自它所挂那条消息的
   *      `taskLinkOf()`，于是"任务 N 的圆点和竖线"被画到了末尾 ——
   *      用户原话：「task_1 的 timeline 跑到 task_2 正文上方去了」。
   *
   *   改成"本轮第一条 + 画在它上方"之后位置就**不漂**了，而语义也更对：
   *   这类工具调用就是"这一轮还没有任何一步产出时发生的"，它本来就在最前面。
   *   判据见 finalAnswer.orphanAnchorIndex。
   *
   * ⚠️ 卡片不带 `task`：它发生在任务之前（所以没有归属），硬接一条轨道会
   *    让线从半截开始。
   */
  const orphanRows = orphanToolsOf(messages, index, liveTools);

  /**
   * 归到这一条消息下的实时工具调用（没有就是空数组）。
   *
   * ⚠️ 不再需要"到底有几行"那个计数：工具卡片是**自己的 section**，画不画
   *    由 `ToolActivityCards` 自己决定（calls 为空时它一个节点都不输出）。
   */
  const liveRows = liveOfSection;

  /**
   * 这一次的工具**卡片** —— **一次调用一张**，两条通道同一个出口。
   *
   * ⚠️ 2026-10-21：工具行不再是"正文卡片里的一段"，而是**它自己的卡片**
   * ------------------------------------------------------------
   *   上一版把它们画进这条消息的 section（正文 → 工具行 → 工具行），
   *   于是正文与它这一步的工具读起来是**一张卡**，而历史里同一条
   *   `tool_activity` 明明是一条独立的消息 —— 用户看到的就是
   *   「工具调用卡片被合并了」。现在两条通道都合成同一个 `ToolActivityView`
   *   交给 `ToolActivityCards`，实时与历史必然长得一样。
   *
   *   · 历史：这条消息自带（`tool_activity` 的 `calls`）；
   *   · 实时：`useLiveToolItems` 里归到这一条消息的那些（`messageId`）。
   */
  const toolCardsView: ToolActivityView | null = toolActivity
    ? toolActivity
    : liveRows.length > 0
      ? {
          calls: liveRows.map((item) => ({
            id: item.key,
            name: item.name,
            args: null,
            status: item.status,
            error: item.error,
          })),
          text: '',
        }
      : null;

  /** 实时那一侧的问答卡（历史那份走下面的 `interaction` 分支）。 */
  const liveInteractions = useLiveInteractions();
  const mineInteractions = liveInteractions.filter(
    (item) => item.anchor !== '' && item.anchor === message.id,
  );

  /**
   * 把"此刻最后一条消息是谁"报给问答那份 store —— 它决定下一张问答卡**挂在
   * 哪条消息下面**（见 liveInteractionFeed.ts 的文件头：问答卡不能被后来的
   * 回答越挤越靠上）。
   *
   * 不带依赖（每次渲染都跑）：`noteAnchor` 同值即返回，代价是一次比较，
   * 而"最后一条"这个事实本来每次渲染都可能变。
   */
  useEffect(() => {
    if (index === messages.length - 1) noteAnchor(message.id);
  });

  /**
   * 这条消息在**任务时间线**上的位置（不在任何任务里 = `null`）。
   *
   * 分组逻辑在 taskTimeline.ts（纯函数、按消息数组缓存），这里只负责画。
   * 两个通道同一个出口：历史靠 metadata.task（后端落库时打的标），实时靠
   * 翻译器在开消息那一刻记下的 liveTaskFeed —— 所以刷新前后长得一样。
   */
  const taskRow = taskRowOf(messages, message.id);

  /**
   * 时间线上的工具卡：`dot` 只在"这条消息的正文卡没画出来"时由第一张卡顶上。
   *
   * ⚠️ 为什么需要这层兜底
   * -------------------
   *   模型这一步一个字都没说、也没推理时（上来直接调工具），section 整个是
   *   null —— 于是这一组工具卡成了任务组的**第一行**。圆点不画在那儿，
   *   这个任务的节点就凭空消失了（用户看到的是"这一段没有节点"）。
   */
  const taskLinkOf = (dot: boolean): TaskLink | null =>
    taskRow ? { id: taskRow.taskId, dot, tail: !taskRow.last } : null;

  /**
   * 工具卡片（没有工具 = null，一个节点都不多）。
   *
   * ⚠️ 为什么要传 `attached`
   * --------------------------------
   *   工具卡与"它自己这一步"之间走**最小档**（和"思考 → 正文"同一条 ——
   *   用户 2026-10-21：这四条缝都属于统一挡位）。而 CSS 只看**相邻**，分不出
   *   "这两张卡是不是同一条消息"，所以"这一组前面是不是本条消息的正文卡"
   *   由渲染层给 —— 见 ToolActivityCards 那两个标记的注释。
   *
   * ⚠️ 为什么还要 `dot`
   * -----------------
   *   理由见上面 taskLinkOf：正文卡没画时，这一组要接管时间线的节点。
   */
  const toolNodes = (attached: boolean, dot = false) =>
    toolCardsView ? (
      <ToolActivityCards
        view={toolCardsView}
        attached={attached}
        task={taskLinkOf(dot)}
      />
    ) : null;

  /**
   * 兜底的那些工具行（见 orphanRows）—— 画在本轮第一条消息**上方**。
   *
   * ⚠️ `task={null}` 是故意的：这些调用发生在任务之前（进入计划模式 / 重新
   *    规划），它们不属于任何任务。硬接一条轨道会让竖线从半截开始，而且
   *    会把这个任务的圆点重复画一次 —— 那正是用户报的
   *    「task_1 的 timeline 跑到 task_2 正文上方」的成因。
   */
  const orphanNodes =
    orphanRows.length > 0 ? (
      <ToolActivityCards
        view={{
          calls: orphanRows.map((item) => ({
            id: item.key,
            name: item.name,
            args: null,
            status: item.status,
            error: item.error,
          })),
          text: '',
        }}
        task={null}
      />
    ) : null;

  /**
   * 本页刚答过的问答卡 —— 挂在这条消息下面，带"从消息栏上移"的进入动画。
   *
   * ⚠️ 为什么它**不**走 `interaction` 那个分支：那个分支读的是消息自己的
   *    metadata（只有后端历史才有），而这一份是"这个页面里刚刚答的"，
   *    还没有后端消息 —— 刷新之后由历史那份接管，两者不会同时出现。
   *
   * ⚠️ 它落在任务里时也要接上轨道（`data-task-*`）：否则时间线会在这一张卡
   *    的位置断一截 —— 而"任务执行中途停下来问用户"恰恰是最常见的中断场景。
   */
  const interactionNodes =
    mineInteractions.length > 0
      ? mineInteractions.map((item, index) => (
          <div
            key={item.key}
            data-section-view="interaction"
            className={styles.cardEnter}
            {...(taskRow
              ? {
                  'data-task-id': taskRow.taskId,
                  'data-task-linked': 'true',
                  'data-task-open-top': 'true',
                  // 最后一张且任务到此为止 -> 轨道收在这一行
                  ...(index < mineInteractions.length - 1 || !taskRow.last
                    ? { 'data-task-open-bottom': 'true' }
                    : {}),
                }
              : {})}
          >
            {taskRow ? <TaskRail /> : null}
            <InteractionMessage view={item.view} />
          </div>
        ))
      : null;

  /** 这一条消息后面还跟着别的行（工具卡 / 问答卡）—— 轨道不能在这一行收尾。 */
  const hasTail = toolCardsView !== null || mineInteractions.length > 0;

  /** 工具卡 + 问答卡：两种角色下都一样，抽出来免得在 switch 里写两遍。 */
  const tail = (attached: boolean, dot = false) => (
    <>
      {toolNodes(attached, dot)}
      {interactionNodes}
    </>
  );

  /**
   * 一条消息 = 一张**卡片**（section），内部顺序固定：
   *
   *     深度思考 → 正文
   *
   * ⚠️ 工具调用**不在**这张卡里 —— 它现在是紧跟在后面的一张张独立卡片
   *    （见上面 `toolCardsView`）。顺序仍然是"正文在前、工具在后"，
   *    只是它们成了两张卡而不是一张卡的两段。
   *
   * ⚠️ 为什么不再区分 chat / tool_activity 两套渲染
   * ------------------------------------------
   *   两者本来就都是"这一步"：一段思考 + 一句说明 + 几个工具调用。
   *   分两套画的结果是 chat 有气泡、tool_activity 只有一行名字，同一轮里
   *   两种形态交替出现（用户截图里最刺眼的就是这个）。现在统一成卡片，
   *   "有没有正文 / 有没有工具"只是卡片数量的多少。
   *
   * 间距由 style.ts 的三档表负责（SPACE_TIGHT / MID / WIDE）：**卡内一律最小档，
   * 卡片与图标行中档，卡片之间最大档**。所以这里只输出结构，不输出任何
   * 间距相关的属性 —— 卡片不因"有没有工具"而换一套间距。
   *
   * ⚠️ 任务行（`taskRow` 非空）会多带几个 `data-task-*` 标记
   * ---------------------------------------------------
   *   时间线是**纯 CSS 画**的：竖线是绝对定位的一根 1px 线、节点是一个空心
   *   圆点，都由这里输出的标记决定长在哪、延伸到哪（见 style.ts 的
   *   taskTimeline 段）。渲染层不测高度、不插 spacer —— 因为"上一行到下一行
   *   之间那段缝"（--task-rail-gap）是常量，CSS 直接往两头各探出这一段即可，
   *   不需要知道真实像素。
   */
  const section = (
    body: React.ReactNode,
    view: string,
    className?: string,
    options?: { dot?: boolean; tail?: boolean },
  ) => {
    const dot = taskRow ? (options?.dot ?? taskRow.first) : false;

    /*
     * ⚠️ 组首那一行**即使没有正文也要画**
     * ----------------------------------
     *   任务说明那一行现在只剩标题（正文是提示词，不画 —— 见上面 taskRow
     *   分支的说明）。按"没正文就返回 null"处理的话，这个任务的圆点和标题会
     *   一起消失，轨道也会跟着断一截。
     */
    if (!body && !reasoningNode && !dot) return null;

    /* 轨道要不要继续往下穿：后面还有同一个任务的行（消息 / 工具卡 / 问答卡）。 */
    const openBottom = taskRow
      ? options?.tail === true || !taskRow.last
      : false;

    return (
      <div
        // ⚠️ 样式不挂 class、只挂 data 属性：section 的排版（内部最小档 / 段间
        // 最大档）住在 style.ts 的 chatPane 那一段里，与 .copilotKitMessage 的
        // 选择器一起定义才看得出"谁在管间距"（见那边的注释）。
        // ⚠️ `className` 只给"进入动画"用（`cardEnter`），不要拿它改排版。
        data-section-view={view}
        className={className}
        {...(taskRow
          ? {
              'data-task-id': taskRow.taskId,
              'data-task-role': taskRow.role,
              // 组首：画圆点 + 小标题
              ...(dot ? { 'data-task-dot': 'true' } : {}),
              // 非组首：轨道从上一行延伸过来（间距也收到最小档）
              ...(taskRow.first
                ? {}
                : {
                    'data-task-open-top': 'true',
                    'data-task-linked': 'true',
                  }),
              ...(openBottom ? { 'data-task-open-bottom': 'true' } : {}),
            }
          : {})}
      >
        {taskRow ? <TaskRail dot={dot} /> : null}
        {taskRow && dot ? (
          /*
           * ⚠️ `title` 是必须的：这行现在**一行截断**（见 style.ts 的
           * [data-task-head]）。任务说明往往是一整段（目标 / 输入 / 约束 /
           * 验收标准），截断之后只有悬停才看得到全貌 —— 不给 title 就等于
           * 把信息藏起来了。
           */
          <div data-task-head="true" title={taskRowLabel(taskRow) || undefined}>
            {taskHead(taskRow)}
          </div>
        ) : null}
        {reasoningNode}
        {body}
      </div>
    );
  };

  // HITL 问答先判：它 role 是 user，但形态是"我回答的那一问"，不是普通气泡。
  if (interaction) {
    const sectionNode = section(
      <InteractionMessage view={interaction} />,
      'interaction',
    );
    return (
      <>
        {orphanNodes}
        {sectionNode}
      </>
    );
  }

  /*
   * 任务的两条边界（`task_instruction` / `task_result`）—— 时间线上的一行。
   *
   * ⚠️ 为什么**不走**库的 UserMessage / AssistantMessage
   * ------------------------------------------------
   *   · `task_instruction` 的 role 是 **user**（它是后端注入的 HumanMessage），
   *     照旧交给 UserMessage 就会画成一个**蓝色的"我发的消息"气泡**，
   *     右对齐 —— 而它其实是"系统派给子代理的任务说明"，用户从没打过这句话。
   *     这是最离谱的一种错位：整段提示词被当成用户的原话。
   *   · `task_result` 走 AssistantMessage 会带上复制 / 重新生成 / 赞踩那一行
   *     图标，而它是**过程产出**（后面还有主代理的总结），不是这一轮的回答。
   *
   *   两者在时间线里的地位和工具行一样：**过程记录**。所以统一用库的
   *   `Markdown` 渲染正文（与气泡里同一个渲染器，样式一致），外面由 section
   *   提供轨道、圆点和小标题。
   *
   * ⚠️⚠️ 任务说明的正文**不画**（2026-10-22，用户："刷新前后不一致"）
   * ------------------------------------------------------------
   *   第一版把 `task_instruction` 的全文当正文渲染 —— 刷新之后对话框里就是
   *   「你当前处于任务执行模式。请完成下面的任务…任务 ID：…技能：…
   *    授予的能力：AGENT_INTERRUPT…任务参数：{json}…」一大坨提示词，
   *   而**实时那条路上根本没有这条消息**（它是后端注入的 HumanMessage，
   *   从不经过模型流式输出，见 liveTaskFeed 的文件头）。
   *   于是同一段对话，刷新前是「一个标题 + 这一步的工作」，刷新后是
   *   「一个标题 + 一整段提示词 + JSON」—— 用户截图里最刺眼的就是这个。
   *
   *   现在两边统一：**节点标题就是那段人话任务说明**（历史侧从正文里抠，
   *   实时侧读计划里的 description，同一个字符串 —— 见 taskDescriptionOf），
   *   正文只放这一步真正做了什么。提示词剩余部分（任务 ID / 能力 / 参数 JSON）
   *   属于排障材料，不该出现在对话区。
   */
  if (taskRow) {
    const content = typeof message.content === 'string' ? message.content : '';
    const body =
      content === '' || taskRow.role === 'instruction' ? null : (
        <div data-task-body="true">
          <Markdown content={content} />
        </div>
      );

    const sectionNode = section(body, 'chat', undefined, { tail: hasTail });

    return (
      <>
        {orphanNodes}
        {sectionNode}
        {/* 正文卡没画出来时（只有标题 / 纯工具的那一步），节点交给工具卡接管 */}
        {tail(sectionNode !== null, sectionNode === null && taskRow.first)}
      </>
    );
  }

  /*
   * 认得出是任务消息、却没能成组 —— **一个节点都不画**。
   *
   * 两种来路：① 这一组"只有任务说明、什么都没做"，被 taskTimeline.group() 整组
   * 丢掉了（见那边的注释）；② 没有 task_id，无法成组。
   * ⚠️ 这里必须显式返回 null：`task_instruction` 的 role 是 user，掉进下面
   *    user 分支就会变成一个"我发的消息"气泡，把整段提示词糊到用户脸上。
   */
  if (taskMessageOf(message)) {
    // 兜底工具行仍要画（这条消息自己被丢掉了，但工具行不能跟着消失）。
    return <>{orphanNodes}</>;
  }

  switch (message.role) {
    case 'user': {
      /*
       * 气泡下方那两枚按钮（复制 / 编辑）。
       *
       * ⚠️ 为什么是**兄弟节点**而不是套一层 wrapper
       * ----------------------------------------
       *   `.copilotKitUserMessage` 是 style.ts 里十几条对齐规则的直接目标
       *   （右对齐靠 `margin-inline-start: auto`，与前后消息的间距靠相邻选择器）。
       *   套 wrapper 会把它变成"唯一子元素"，那些相邻规则全部失效 ——
       *   界面只是"看起来差一点"，不报错。所以保持气泡是消息容器的直接子节点，
       *   按钮行跟在它后面。理由与代价见 UserMessageActions.tsx 的文件头。
       *
       * 没有可读文本（纯附件 / 空消息）就不画：复制一个空串、编辑一个空输入框，
       * 两个按钮都是坏的，不如不出现。
       */
      const text = userMessageText(message.content);
      const sectionNode = section(
        <>
          <UserMessage
            rawData={message}
            data-message-role="user"
            message={message}
            ImageRenderer={ImageRenderer}
          />
          {text !== '' ? <UserMessageActions text={text} /> : null}
        </>,
        'chat',
        // ⚠️ 只有"这个页面里刚发出去的那条"做上移动画 —— 从历史灌进来的
        //    几十条一起滑进来只会吵（判据见 isLocalMessage）。
        isLocalMessage(message) ? styles.cardEnter : undefined,
        { tail: hasTail },
      );

      return (
        <>
          {orphanNodes}
          {sectionNode}
          {tail(sectionNode !== null)}
        </>
      );
    }

    case 'assistant': {
      /**
       * 推理那块放在哪 —— **自己放在助手消息正上方**。
       *
       * ⚠️⚠️ 为什么不走库的 `subComponent`（2026-10-13 踩过，症状就是
       *    "界面上根本没有折叠行"）
       * --------------------------------------------------------------
       *   库（dist/index.mjs 的 AssistantMessage）是这么定的：
       *       const subComponent = message?.generativeUI?.() ?? props.subComponent;
       *   `??` 的语义是"**左边一有值，右边整个丢掉**"。
       *
       *   而 CopilotKit 会给**每一条**助手消息挂上 `generativeUI`
       *   （react-core 的 useCopilotChatInternal → resolvedMessages：
       *    `legacyCustomMessageRenderer` 只要 agent 在就非空，于是无条件
       *    `{ ...message, generativeUI: bridgeRenderer, generativeUIPosition: 'before' }`）。
       *   那个 bridge 是 CoAgentStateRenderBridge —— 本面板没注册任何
       *   coagent state render，所以它**渲染 null**：看不见，却稳稳占住了
       *   subComponent 那个槽。我们传进去的折叠行被静默顶掉，界面上就是
       *   "什么都没有"，而且不报任何错。
       *
       *   所以改成 Fragment 里两个**兄弟节点**（不新增包裹元素、不碰
       *   message 对象），谁也不依赖库内部那条 `??` 的优先级。
       *
       * ⚠️ 位置与间距：正上方，**不要**在这里补 margin
       * ------------------------------------------
       *   库那条 before 分支渲染的是 `<div style={{ marginBottom: '0.5rem' }}>`，
       *   它是 AssistantMessage 的**第一个**子节点 —— 那段留白本来就在那儿
       *   （bridge 渲染 null，但那个空 div 照样占 0.5rem）。我们的折叠行落在它
       *   **前面**，于是是「折叠行 → 0.5rem → 气泡」。
       *
       *   ⚠️ 但这两段留白（0.5rem + 气泡的 padding-top 12px）在**折叠行下面**
       *   显得太大（用户截图：一行灰色小字和正文之间空出一条大缝）。所以
       *   现在由 style.ts 里那两条"紧跟折叠行的助手消息"规则把它们一起收到
       *   8px —— 那是**结构层面的间距**，别在这里用 margin 调，否则叠加。
       *
       * ⚠️ `subComponent` 仍然照库的默认实现传（`message.generativeUI?.()`）：
       *   这一轮 bug 的教训正是"别指望这个槽显示我们的东西"，但也不该反过来
       *   把它掐掉 —— coagent 那件事本该由库自己决定，我们只负责不依赖它。
       */
      // `reasoningNode` 在函数顶部算好了（那条消息自己的推理，逐条、不合并），
      // 见"思考过程：每条消息画自己那一段"那一段注释。

      /**
       * 「正在思考」那一行是不是正在转圈 —— 取的是**整轮**的状态（上面
       * `replyStreaming` 按"任意一段还在流"算），不是这一条自己的。
       *
       * ⚠️ 为什么不为它单独看自己那条：长链路里前一段推理还在流时，答案那条
       *    可能还没开始自己的推理 —— 那两个 loading 一样会同时亮。判据必须
       *    覆盖整轮，理由与取舍见上面 `replyStreaming` 的注释。
       */
      const reasoningStreaming = replyStreaming;

      // 组装成属性对象再展开，而不是写成 JSX 属性：
      //   `data-message-role` 与 `subComponent` 在 AssistantMessageProps 里
      //   没有对应声明（库自己的 JSX 也靠 JS 绕过了检查），
      //   写成 JSX 属性会被 tsc 直接顶回来。这里是**一次**显式断言，
      //   而不是把每个值都 as 一遍。
      const assistantProps = {
        'data-message-role': 'assistant',
        subComponent: (
          message as typeof message & WithGenerativeUi
        ).generativeUI?.(),
        rawData: message,
        message,
        messages,
        // ⚠️ `!reasoningStreaming` 就是"**同一个 loading 不要出现两次**"：
        //    见上面 reasoningStreaming 的注释。正文一旦开始到（`message.content` 非空）
        //    这两个都自然关掉，交给 `isGenerating`。
        isLoading:
          inProgress &&
          isFinalAnswer &&
          !message.content &&
          !reasoningStreaming,
        isGenerating: inProgress && isFinalAnswer && !!message.content,
        isCurrentMessage: isFinalAnswer,
        onRegenerate: () => onRegenerate?.(message.id),
        onCopy,
        onThumbsUp,
        onThumbsDown,
        feedback: messageFeedback?.[message.id] || null,
        /*
         * 流式时换成"会逐字淡入"的那一份；其余时候原样透传（历史消息一个字都不切）。
         *
         * 为什么替换这个 prop 就能生效：库的 AssistantMessage 内部是
         *   `<Markdown content={content} components={markdownTagRenderers} />`，
         * 而 Markdown 把它合并进 ReactMarkdown 的 components —— 这是唯一一个
         * "能插进正文渲染"的入口（库没暴露 Markdown / components 的其它路径）。
         */
        markdownTagRenderers: reveal ? reveal.components : markdownTagRenderers,
        ImageRenderer,
      } as unknown as AssistantMessageProps;

      /**
       * 正文。三种情况不画：
       *
       *   · `content` 为空 —— 这一步只有推理 / 只有工具，没有话要说；
       *   · 这一条是**工具结果**（`calls` 为空）—— 它的文本是工具产出，不是
       *     模型说的话（见上面 isToolResult）；
       *   · 库那边这一刻只该画 loading 光标（`isLoading`）—— 交给下面的
       *     `showCursor` 单独处理，不用一个空气泡占位。
       */
      const text = typeof message.content === 'string' ? message.content : '';
      const showBody = text !== '' && !isToolResult;
      const isLoading = assistantProps.isLoading;
      const showCursor = !showBody && isLoading;

      // 没有正文、也不该画光标 —— 一个节点都不多（推理画在卡里、工具是自己的卡）。
      const body =
        showBody || showCursor ? (
          <AssistantMessage {...assistantProps} />
        ) : null;

      // 正文卡有没有真的画出来 —— 决定它下面那组工具卡用哪一档（见 toolNodes）。
      const sectionNode = section(body, 'chat', undefined, { tail: hasTail });
      return (
        <>
          {orphanNodes}
          {sectionNode}
          {tail(sectionNode !== null)}
        </>
      );
    }

    default:
      // 工具结果 / 系统消息等：库的默认实现同样什么都不画
      // （前端至今收不到 tool 消息，见 finalAnswer.ts），照旧。
      // ⚠️ 但兜底的工具行要跟着留下 —— 它挂在这条消息上，一起 return null
      //    就等于凭空消失（比放错位置严重得多）。
      return <>{orphanNodes}</>;
  }
};

export default DockRenderMessage;
