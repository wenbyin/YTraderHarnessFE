// src/components/CopilotDock/history.ts
//
// 把后端持久化的会话历史（messages.yaml）转成 AG-UI 消息，注入面板的 agent。
//
// 为什么走 agent.setMessages 而不是自己画卡片
// -------------------------------------------
//   聊天界面是 CopilotKit 的，它只认 agent.messages。注入历史有两条路：
//     ① 自己渲染一套气泡 —— 要复制一遍 markdown、代码高亮、复制按钮、
//        滚动定位，而且**发新消息时两套渲染会打架**（界面清空 ours、
//        agent 那边从空历史重跑，用户看着像"对话丢了"）；
//     ② 把历史灌进 agent.messages —— 界面还是原来那套，且接着聊时
//        `prepareRunAgentInput` 会把历史一起带上，语义连续。
//   选 ②。`AbstractAgent.setMessages()` 会通知所有订阅者
//   （onMessagesChanged），v1 聊天正是靠这个 forceUpdate 重渲染的。
//
// ⚠️ 灌历史**不会**把历史回传给后端（也不用担心它污染模型上下文）
// ----------------------------------------------------------
//   后端自己持有 thread checkpoint（见 agent_run_dispatch.py 的 THREAD_NAMESPACE），
//   而且它的派发路径**根本不读** `RunAgentInput.messages`（那个文件里只有
//   `HumanMessage` 与自己的 checkpoint，grep 过）。所以前端灌进 agent 的这份
//   是纯「界面显示用的镜像」：既不会写库、也不会被当成给模型的上下文。
//   这一点很重要 —— 它意味着"多塞几条 tool_activity 进去"只有显示效果，
//   没有副作用。（契约上 `RunAgentInput.messages` 本该是上下文，是这个后端
//   选择不用它；将来它若开始用，这段注释就是需要重新评估的地方。）
//
// 显示哪些 kind（2026-10-10 起 tool_activity 也显示）
// ------------------------------------------------
//   契约里 kind 有四种，处理方式各不相同：
//     · chat          —— 对话正文，渲染成普通气泡（用户 / 助手）；
//     · tool_activity —— 工具调用与工具结果。**现在也显示**，但不是塞成
//                        助手气泡（那会让人以为模型把这些话说了出来），
//                        而是渲染成一条独立的「工具活动」记录块 ——
//                        见 ToolActivityRow.tsx，靠 metadata.kind 分流。
//     · notice        —— 系统通知（目前只有"运行已取消"）。它连"谁说的话"
//                        都不是，仍然不显示；
//     · interaction   —— HITL 问答（**用户**的回答，2026-10-20 后端开始落库）。
//                        它渲染成"我发出的那条消息卡片"（见 InteractionView /
//                        InteractionMessage.tsx）—— 刷新之后"问了什么、我答了
//                        什么"必须还在，否则那段对话读起来像模型自问自答。
//     · task_instruction / task_result（2026-10-22 新增的两条）
//                     —— 子代理的**任务说明**与**任务产出**。它们要显示
//                        （"将他也生成在对话框中"），形态是**对话区左侧一条
//                        纵向时间线**：每个任务一个灰色节点，任务相关的内容
//                        挂在节点下面。分组靠 metadata.task（task_id / plan_id
//                        / skill_key），见 taskTimeline.ts 的文件头。
//
// ⚠️ 时间戳不用来排序
// ------------------
//   后端已经按 `seq` 升序返回了（seq 是会话内单调递增的顺序号），
//   而且 created_at 是 UTC 微秒精度 —— 不同消息的墙上时间可能因时钟与
//   精度问题乱序。再排一次是用不可靠的数据覆盖可靠的数据。

import type { Message } from '@ag-ui/client';
import type {
  ContentBlock,
  MessageStatus,
  SessionMessage,
} from './agentRuntime';
import { type AskUserQuestion, parseQuestions } from './askUserQuestion';
import {
  TASK_INSTRUCTION_KIND,
  TASK_RESULT_KIND,
  type TaskMessageMeta,
} from './taskTimeline';
import {
  type CachedStatusResolver,
  createCachedStatusResolver,
} from './toolStatusCache';
import type { ToolCallStatus } from './useToolActivity';

/** 一次工具调用三件套里的参数。后端给的是任意 JSON。 */
export type ToolCallArgs = Record<string, unknown> | null;

/** 渲染一条工具调用要的几样东西（后端在 content 的 `tool_call` 块里给）。 */
export interface ToolCallView {
  id: string;
  name: string;
  args: ToolCallArgs;
  /**
   * 这一次调用的成败 —— **只有当前端自己知道时才填**。
   *
   * ⚠️ 不是从后端历史里读的（后端没落这个字段，见 toolStatusCache 的文件头）：
   *    它在 `toAgentMessages` 里由本地存档（同一次运行刚跑过、浏览器记下的
   *    终态）补上。补不到就是 `undefined` —— 那一行只显示名字，**不猜**。
   */
  status?: ToolCallStatus;
  /** 失败原因，只给红叉的悬停提示用。 */
  error?: string;
}

/**
 * 一条 tool_activity 消息的渲染原料。
 *
 * ⚠️ 为什么要**预解析**、而不是让渲染层自己去读 content 块
 * --------------------------------------------------
 *   渲染层（DockRenderMessage）只拿得到 AG-UI 的 Message —— 它的 `content`
 *   是**字符串**，后端那串内容块数组在这一步已经被压平了。
 *   所以"调了哪个工具、参数是什么"必须在这里就抽出来、随 metadata 带过去。
 *
 * ⚠️ 界面当前**只用得到 `calls[].name`**（需求：工具行只显示名字，
 *   见 ToolActivityRow）。`args` / `text` 照旧解析、照旧随 metadata 走 ——
 *   它们是这条记录的原始数据，**不是"没人读就能删"**：少解析等于把历史里的
 *   参数与产出直接丢掉（顺带把 history 的单测也弄没意义），而展示策略是
 *   随时会变的一层。
 */
export interface ToolActivityView {
  /**
   * 这条消息里的工具调用。
   *
   * ⚠️ 空数组是有意义的，不是"没解析出来"：它表示这条是**工具结果**
   *   （ToolMessage 落的那条，content 里只有输出文本，没有 tool_call 块）。
   *   两种记录在 wire 上只能靠这一点区分 —— 后端给同一批消息填的是**同一个**
   *   `reply_to_message_id`（都指向那条用户消息），没有"谁是谁的结果"的字段。
   */
  calls: ToolCallView[];
  /**
   * 文本部分。两种含义要看 `calls`：
   *   · calls 非空 → 是模型的旁白（"我先查一下…"），正文里和工具调用并存；
   *   · calls 为空 → 是**工具的产出**。
   */
  text: string;
}

/** AG-UI 消息的 metadata 里带上后端字段，界面/调试时能看出这条来自哪次运行。 */
export interface HistoryMeta {
  messageId: string;
  seq: number;
  runId: string | null;
  status: MessageStatus;
  kind: string;
  /** 只有 kind === 'tool_activity' 才有 —— 见 ToolActivityView 的说明。 */
  toolActivity?: ToolActivityView;
  /** 只有 kind === 'interaction' 才有 —— HITL 问答（见 InteractionView）。 */
  interaction?: InteractionView;
  /** 只有 kind 是任务的两条之一时才有 —— 见 TaskMessageMeta。 */
  task?: TaskMessageMeta;
  /** 思维链原文。有值时界面把它画成气泡上方那块可折叠的灰色区（见 ReasoningBlock）。 */
  reasoning?: string;
}

/** 一条消息在界面上以什么形态出现。`null` = 不显示。 */
export type MessageView = 'chat' | 'tool_activity' | 'interaction' | 'task';

/**
 * 一条 `kind: 'interaction'` 记录的渲染原料 —— HITL 问答的"我发出的那条消息"。
 *
 * 后端在 resume 路径写它（`message_recorder.record_interaction`）：
 * `role=user`、`content` = 一个 `text` 块（人读的 `Q: … A: …`）+ 一个
 * `interaction` 块（结构化的 questions / answers / annotations）。
 *
 * ⚠️ 界面用**结构化那份**，不用 text 块
 * ------------------------------------
 *   text 块是给"别的消费方"（导出、检索）看的一段纯文本；照着画会把
 *   `Q: … A: …` 这种机读格式原样摆到用户面前。渲染层要的是"问了什么、我答了
 *   什么"两列信息 —— 那就是 interaction 块里的 questions + answers。
 */
export interface InteractionView {
  /**
   * 问过的问题（用实时提问卡片**同一个**解析器，见 askUserQuestion.ts）。
   *
   * 复用的理由：后端 `ask_user_question` 的 `questions` 与这里是同一份结构
   * （`question/header/options/multiSelect`），再写一份解析只会漂。
   */
  questions: AskUserQuestion[];
  /** 题面 -> 答案。多选题的答案后端已拼成 `", "` 分隔的字符串。 */
  answers: Record<string, string>;
}

/** 一条内容块里的文本。契约里 text 是可选的（附件块 / tool_call 块都没有），空就是空串。 */
function blockText(block: ContentBlock): string {
  return typeof block.text === 'string' ? block.text : '';
}

/** 推理块的类型名。与后端 `REASONING_BLOCK_TYPE` 同名（上游词汇，不自造）。 */
const REASONING_BLOCK_TYPE = 'reasoning';

/** HITL 问答块的类型名。与后端 `record_interaction` 写的那个 `type` 同名。 */
const INTERACTION_BLOCK_TYPE = 'interaction';

/**
 * 一个推理块里的原文。
 *
 * ⚠️ 先取 `reasoning` 键、退回 `text` —— 与后端 `_block_reasoning` /
 *    `message_reasoning` 是**同一条判据**（两种键在历史上都出现过，只认
 *    一种的症状是"整段静默取不到"，那比多认一种难查得多）。
 */
function blockReasoning(block: ContentBlock): string {
  const raw = block as ContentBlock & { reasoning?: unknown };
  const direct = typeof raw.reasoning === 'string' ? raw.reasoning : '';
  return direct !== '' ? direct : blockText(block);
}

/**
 * 这条消息的**思维链原文**。没有就是 `''`（空串 = "这条没有推理"）。
 *
 * ⚠️⚠️ 取值规则是**两个来源取先非空者**，顺序不能改
 * ------------------------------------------------
 *     reasoning = reasoning_content ?? content 里 type=reasoning 的块
 *
 *   · 新写入的消息里推理**只**在 `reasoning_content`（content 只放可见块，
 *     后端 `_content_blocks` 明确把推理块过滤掉了）；
 *   · 但那一列是**后加的**，**存量行没有它** —— 实测库里 169 条 assistant
 *     消息的推理就躺在 content 的块数组里，而那批行**刻意不回填**。
 *
 *   所以这不是临时兼容代码，是**长期**的读法：只读新字段 → 所有历史会话的
 *   推理消失；只读 content 块 → 新会话的推理消失。契约 messages.yaml 里
 *   也是这么写的。
 */
export function reasoningOf(message: SessionMessage): string {
  const column =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content.trim()
      : '';
  if (column !== '') return column;

  return message.content
    .filter((block) => block.type === REASONING_BLOCK_TYPE)
    .map(blockReasoning)
    .filter((text) => text.trim() !== '')
    .join('\n\n')
    .trim();
}

/**
 * 一条消息的**可见**文本。
 *
 * 多个 text 块用空行连起来，而不是直接拼 —— 契约里 content 是数组，
 * 相邻块可能是"正文 + 引用"这类结构，粘在一起会读不出边界。
 * 纯空白的结果返回 ''，让调用方能识别"这条其实没有可显示内容"。
 *
 * ⚠️ `tool_call` 块没有 `text`，所以它在这条路里"消失" —— 那是**故意的**：
 *   工具调用不是正文，它的渲染原料由 toolActivityOf 单独抽（见下）。
 *
 * ⚠️⚠️ `type=reasoning` 的块**也要跳过**
 * -------------------------------------
 *   存量行把推理写进了 content（见 reasoningOf 的说明）。照旧把它们拼进
 *   正文，推理就会**出现两遍** —— 正文里一遍、气泡上方那块折叠区里一遍。
 *   而需求正是"推理默认藏起来"，所以它必须从正文里摘出去。
 *   对新消息这条过滤是 no-op（后端压根不往 content 里写推理块）。
 */
export function messageText(message: SessionMessage): string {
  return message.content
    .filter((block) => block.type !== REASONING_BLOCK_TYPE)
    .map(blockText)
    .filter((text) => text.trim() !== '')
    .join('\n\n')
    .trim();
}

/**
 * 抽出这条 tool_activity 消息里的工具调用。
 *
 * 字段逐个 `typeof` 校验：契约是 `additionalProperties: true` 的开放块，
 * 后端将来加东西（或某条数据缺字段）时，宁可少显示一项，也不要让
 * `undefined` 漏进界面变成 "undefined(undefined)"。
 */
export function toolActivityOf(message: SessionMessage): ToolActivityView {
  const calls: ToolCallView[] = [];

  for (const block of message.content) {
    if (block.type !== 'tool_call') continue;
    calls.push({
      id: typeof block.id === 'string' ? block.id : '',
      name: typeof block.name === 'string' ? block.name : '',
      args: block.args ?? null,
    });
  }

  return { calls, text: messageText(message) };
}

/**
 * 抽出这条 interaction 消息里的问答。
 *
 * 只认 `type === 'interaction'` 的块 —— text 块（`Q: … A: …`）是机读格式，
 * 渲染层不用（理由见 InteractionView）。
 *
 * answers 的取值逐个 `typeof` 校验：契约里它是 `{题面: string}`，但那条块是
 * 开放结构，缺字段 / 老数据带别的类型时宁可少显示一项，也别让 `undefined`
 * 变成界面上那个字面量。
 */
export function interactionOf(message: SessionMessage): InteractionView {
  const answers: Record<string, string> = {};
  let questions: AskUserQuestion[] = [];

  for (const block of message.content) {
    if (block.type !== INTERACTION_BLOCK_TYPE) continue;

    const raw = block as ContentBlock & {
      questions?: unknown;
      answers?: unknown;
    };

    questions = parseQuestions(raw.questions);

    if (raw.answers && typeof raw.answers === 'object') {
      for (const [key, value] of Object.entries(
        raw.answers as Record<string, unknown>,
      )) {
        if (typeof value === 'string') answers[key] = value;
      }
    }
  }

  return { questions, answers };
}

/**
 * 任务消息的归属（只有 `task_instruction` / `task_result` 两条有）。
 *
 * 后端 `message_recorder._meta` 把 `task_id` / `plan_id` / `skill_key` 放进
 * 消息的 `metadata`（from `additional_kwargs`）。三个都是**开放结构里的可选键**，
 * 所以逐个 `typeof` 校验：缺了就是空串，由 taskTimeline 决定"没有 id 就不分组"。
 *
 * ⚠️ 这里**不**读 `message.metadata.kind` 来判种类
 * ---------------------------------------------
 *   `kind` 是消息自己的列（`message.kind`），metadata 里那份是后端顺手带的副本。
 *   两处取值不一致时，"这条消息是什么"必须以**列**为准 —— 那是后端落库时
 *   唯一权威的那一份。
 */
export function taskMetaOf(message: SessionMessage): TaskMessageMeta | null {
  if (
    message.kind !== TASK_INSTRUCTION_KIND &&
    message.kind !== TASK_RESULT_KIND
  ) {
    return null;
  }

  const meta = message.metadata ?? {};
  const pick = (key: string): string =>
    typeof meta[key] === 'string' ? (meta[key] as string) : '';

  return {
    kind: message.kind,
    taskId: pick('task_id'),
    planId: pick('plan_id'),
    skillKey: pick('skill_key'),
  };
}

/**
 * 这条消息该画成什么（或不该画）。
 *
 * 两道公共过滤 + 每种 kind 各自的一条：
 *   1. 角色必须是 user / assistant —— 契约是开放字符串，后端将来加角色时
 *      不该让一条我们不认的消息变成一个空白气泡；
 *   2. `chat` 必须有可显示的东西 —— **正文或推理，有一个就画**
 *      （只有推理时气泡是空的、上方那块折叠区有内容，那也是一条真实存在的
 *      回答；按"正文为空"整条丢掉等于把这轮从历史里抹了）；
 *   3. `tool_activity` 必须有**可渲染的东西**（调用了工具，或者有输出文本）
 *      —— 一条既没工具调用又没文本的记录，画出来是个空壳；
 *   4. `interaction` 必须有问答 —— 一条读不出问题的问答记录画出来是空卡片；
 *   5. 任务的两条边界同理：**有字就画**。`task_instruction` 的正文是那段
 *      "你当前处于任务执行模式…"，`task_result` 是子代理的产出 ——
 *      两者都是"这一步真实发生过"的记录，丢掉的代价是时间线上少一个节点。
 */
export function classifyMessage(message: SessionMessage): MessageView | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;

  if (
    message.kind === TASK_INSTRUCTION_KIND ||
    message.kind === TASK_RESULT_KIND
  ) {
    const hasSomething =
      messageText(message) !== '' || reasoningOf(message) !== '';
    // ⚠️ 没有 task_id 的边界消息**仍然显示**（只是一个单行组）：
    //    "这条属于哪个任务"信息缺失，比"这条干脆看不见"轻得多。
    return hasSomething ? 'task' : null;
  }

  if (message.kind === 'interaction') {
    const view = interactionOf(message);
    // 问题读不出来时退回 text 块（`Q: … A: …`）也还能显示 —— 有字就算有内容。
    return view.questions.length > 0 || messageText(message) !== ''
      ? 'interaction'
      : null;
  }

  if (message.kind === 'tool_activity') {
    const view = toolActivityOf(message);
    if (view.calls.length === 0 && view.text === '') return null;
    return 'tool_activity';
  }

  if (message.kind === 'chat') {
    const hasSomething =
      messageText(message) !== '' || reasoningOf(message) !== '';
    return hasSomething ? 'chat' : null;
  }

  // notice：见文件头，仍然不显示。
  return null;
}

/**
 * 给这条记录里的每个调用补上「成没成」。
 *
 * ⚠️ 只对**被观测过的那次运行**生效：存档是按后端 run_id 分桶的
 *    （见 toolStatusCache），没看过的运行没有桶 —— 那些行宁可没有图标，
 *    也不要拿别的运行来凑。判据因此**就在 resolve 里**（它按 run_id 找桶），
 *    这里不需要再判一次"是不是最后一次运行"。
 *
 * 匹配靠 `sameTool` 且**按序消费**：同一个工具在一轮里调了两次（一成一败）时，
 * 两行各自拿到自己的状态，而不是都变成"最后一个"。
 */
function withCallStatuses(
  view: ToolActivityView,
  resolve: CachedStatusResolver | null,
  runId: string | null,
): ToolActivityView {
  if (!resolve) return view;

  return {
    ...view,
    calls: view.calls.map((call) => {
      const hit = resolve(runId, call.name);
      if (!hit) return call;
      return hit.error
        ? { ...call, status: hit.status, error: hit.error }
        : { ...call, status: hit.status };
    }),
  };
}

/**
 * 后端消息 -> AG-UI 消息。id 直接沿用后端的 message_id（稳定、重载不变）。
 *
 * `resolve` 是可选的「这次运行里，这个名字那次调用成没成」—— 由 `toAgentMessages`
 * 从本地存档里造出来（见 toolStatusCache.ts）。不传就是"不知道"，工具行只显示名字。
 */
export function toAgentMessage(
  message: SessionMessage,
  resolve: CachedStatusResolver | null = null,
): Message {
  const meta: HistoryMeta = {
    messageId: message.message_id,
    seq: message.seq,
    runId: message.run_id,
    status: message.status,
    kind: message.kind,
  };

  // tool_activity 的渲染原料随 metadata 一起带过去（理由见 ToolActivityView）。
  // 成败的判据是这条消息属于哪一次运行 —— 存档按 run_id 分桶，见 toolStatusCache。
  if (message.kind === 'tool_activity') {
    meta.toolActivity = withCallStatuses(
      toolActivityOf(message),
      resolve,
      message.run_id,
    );
  }

  // HITL 问答（"我发出的那条消息"）同理由这里抽好带走。
  if (message.kind === 'interaction') {
    meta.interaction = interactionOf(message);
  }

  // 任务的两条边界：带上 task_id / plan_id / skill_key，时间线靠它分组
  // （见 taskTimeline.ts）。没有 task_id 时也写进去 —— "属于哪个任务"未知
  // 与"是不是任务消息"是两件事，前者由 taskTimeline 判。
  const task = taskMetaOf(message);
  if (task) meta.task = task;

  // 推理同理：渲染层只看得到被压成字符串的 content，思维链必须在这里抽出来。
  const reasoning = reasoningOf(message);
  if (reasoning !== '') meta.reasoning = reasoning;

  return {
    id: message.message_id,
    role: message.role,
    content: messageText(message),
    metadata: meta as unknown as Message['metadata'],
  };
}

/**
 * 一页后端历史 -> 可显示的 AG-UI 消息列表。
 *
 * 保持后端给定的顺序（seq 升序 = 旧 → 新，聊天界面从上往下正好是时间序）。
 * 不做去重：同一条 message_id 重复出现说明后端给了脏数据，静默去重会
 * 掩盖问题；真要防的话应该按 message_id 报错而不是悄悄丢。
 *
 * ⚠️ `sessionId` 只用来查「工具调用的成败」那份本地存档（toolStatusCache）：
 *    刷新之后要让历史里的工具行和刚才 SSE 里跑出来的**长得一样**。
 *    存档按**后端 run_id** 分桶（而不是"这一页里最后一次运行"），所以这里把
 *    解析器交给每一条消息、由它拿自己的 run_id 去问 —— 审批前后那两段因此
 *    都能拿到图标（那正是"一个会话只留一份"那版丢掉的东西）。
 */
export function toAgentMessages(
  messages: readonly SessionMessage[],
  sessionId?: string,
): Message[] {
  const resolve = createCachedStatusResolver(sessionId);

  return messages
    .filter((message) => classifyMessage(message) !== null)
    .map((message) => toAgentMessage(message, resolve));
}
