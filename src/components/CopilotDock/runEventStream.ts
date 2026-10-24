// src/components/CopilotDock/runEventStream.ts
//
// 把**后端的领域事件流**翻成 **AG-UI 事件流** —— CopilotKit 的聊天界面只认后者。
//
// 为什么要有这一层
// ----------------
//   后端 `GET /runs/{run_id}/events` 吐的是自研领域的事件：
//
//       run.started / node.started / node.completed
//       message.delta        data={delta}         —— 一个 token
//       message.completed    data={content,...}   —— 这条消息说完了
//       run.completed / run.failed
//
//   而聊天界面（AG-UI）要的是：
//
//       RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT × N
//                   → TEXT_MESSAGE_END → RUN_FINISHED
//
//   两套词表一一对应但**不是**同一套，硬把 `message.delta` 当 EventType 发过去
//   界面会一条消息都不出（协议校验不过，且不报错）—— 这种静默失败最难查。
//
// 三条设计取舍
// ------------
//   1. **以 delta 为准、以 content 兜底**。`message.completed` 带的 content 是
//      全量文本，是天然的对账点：如果累积出来的比它短（丢了中间几帧），
//      把缺的那段补发；如果已经一致，什么都不做。这样既流式，又不会因为
//      掉帧而显示半句话。
//   2. **一条 `message.completed` = 一条气泡**。一次运行里图可能产出多条消息
//      （react 图多个 agent 节点），每条各自 END，下一条 delta 开新的 messageId。
//   3. **失败也要看得见**。协议上正确的做法是 RUN_ERROR，但 v1 聊天组件对它
//      的渲染不由我们决定（可能只是一次静默失败）。这里把原因写成一条正常的
//      助手消息再 RUN_FINISHED —— 用户一定看得见为什么没成。
//
// ⚠️ node.* 不翻成气泡、tool.* 翻成**过程通道**、hitl.requested 翻
// ---------------------------------------------------------
//   · node.started / node.completed：翻成**气泡**是噪音（只有耗时与模型名）→ 不翻成气泡；
//     但它**必须**翻成「正在…」的进度事件 —— 它是唯一能覆盖"一个字都收不到"那段时间的
//     信号（builder 节点实测 31 秒零 message 事件），见 PROGRESS_CUSTOM_EVENT。
//   · tool.called / tool.completed：后端**现在真的在发**（2026-10-18，
//     见 app/agent/graph/react/tools.py 的 _publish_tool_event —— 自定义扇出节点
//     不走 langgraph 的 ToolNode，所以由它自己补发）→ 翻成**工具过程通道**
//     （TOOL_ACTIVITY_CUSTOM_EVENT），见下面的说明。
//   · hitl.requested：**后端真的会发**（一度以为不会 —— 那时 grep 只看到枚举，
//     后来 agent_run_dispatch.py 的 _publish_hitl_requested 确实在发），
//     而且它是「运行停下来等人回答」的**唯一**信号 → 必须翻，见下。
//
// ⚠️ 工具事件为什么不翻成消息（TEXT_MESSAGE_*）
// -------------------------------------------
//   1. 它**不是模型说的话**。翻成消息就是让"工具调用：x"以气泡姿态出现，
//      用户会以为模型念了这句（同样的取舍见 ToolActivityRow.tsx 的文件头）。
//   2. 更硬的理由：**翻了也存不下**。`@ag-ui/client` 的 `defaultApplyEvents`
//      在 `apply` 一开始就把 `agent.messages` 克隆成局部变量 `l`，之后
//      每一帧都基于**同一份**克隆重算、并把整份数组回写。也就是说：流跑到
//      一半从外面 `addMessage()` 插一条，下一帧就被那份克隆**整份覆盖掉** ——
//      消息会出现又消失（这正是 runEventStream 里 PROGRESS 那段警告说的事）。
//   所以走平行通道：CUSTOM 事件 → useToolActivity → 消息流里的工具行。
//   它在形态上与"刷新后从历史里读到的那条 tool_activity"**长得一样**
//   （同一个 ToolActivityRow）；事件里带上 `messageId`（当前这条助手消息的 id），
//   渲染层就把它放进**同一步**的 section —— 刷新前后位置也一致。
//
// ⚠️ 人工审批（HITL）为什么不是"多渲染一条消息"
// ------------------------------------------
//   后端发了 `hitl.requested` 之后**把事件流挂着不关**（等审批不算终态，
//   它没有 hitl.cancelled / hitl.timeout）。照原样丢掉，界面会永远停在
//   "正在运行"，等多久都不会变。
//
//   而 AG-UI 里"停下来等人"是**协议内**的一件事，不是一条消息：
//
//       RUN_FINISHED { outcome: { type: 'interrupt', interrupts: [Interrupt] } }
//
//   客户端（@ag-ui/client 的 defaultApplyEvents）收到它才会把这次运行当作
//   "结束但有未决的待办"：写入 `agent.pendingInterrupts`，`isRunning` 归 false。
//   CopilotKit 的 useInterrupt 再把 interrupts 交出来渲染（见 HitlInterrupt.tsx），
//   并把"下一次 runAgent"变成一次 `resume`（见 agent.ts）。
//
//   所以审批**不能**翻成一条普通助手消息 —— 那样它只是个好看的气泡，
//   点按钮没有回头的路（消息本身没有 resolve 的能力）。
//
//   ⚠️⚠️ 一次并行审批是**多条** hitl.requested，必须聚成一组
//   ------------------------------------------------
//   `_publish_hitl_requested`（agent_run_dispatch.py）是个 `for` 循环：**一个中断
//   一条事件**，每条带自己的 `interrupt_id`。工具并行执行时就是连着来好几条，
//   而且**没有**"这一组发完了"的标记事件（枚举里只有 hitl.requested /
//   hitl.resolved）。
//
//   所以这里按「静默窗口」聚合（见 HITL_GROUP_WINDOW_MS）：第一条中断到来后开始
//   计时，每来一条就把窗口往后推，窗口内没有新的就认为这一组齐了，一次性发出
//   `interrupts: [...整组]`。只认第一帧的话，剩下的会被当成新一轮审批 ——
//   卡片会一张接一张地弹，而用户明明只是"一次并行调了三个工具"。
//
//   ⚠️ 为什么整组要**一次性**发出去（而不是一条一条发）
//   -------------------------------------------------
//   CopilotKit 的中断状态机（@copilotkit/core 的 InterruptState）是这么写的：
//
//       this.#responses[id] = response;
//       if (!interrupts.every(i => this.#responses[i.id])) return { kind: 'waiting' };
//       ... buildResumeArray(...) -> { kind: 'resume', resume: [...] }
//
//   而 useInterrupt 的 resolve 只在拿到 `kind === 'resume'` 时才调 runAgent。
//   也就是说：**把整组声明出去 + 逐条 resolve → 最后一条答完时，库用一次
//   `runAgent({ resume: [...整组] })` 全部上报**。这正是「批量上报」，
//   而且是协议自带的，不用自己攒。
//   反过来，一次只声明一条的话，每答一条都会立刻触发一次 resume —— 那就退回
//   一条一条上报，而且后端每次恢复都会把剩下那条再发一遍。
//
//   ⚠️ 两条并行工具的审批长这样
//   -------------------------
//       后端：hitl.requested(I1)  hitl.requested(I2)  ← 连着两条，之后流挂着不关
//       这里：窗口到 → RUN_FINISHED { interrupt: [I1, I2] }（只收尾一次）
//       界面：一张卡片「当前第 1 条 / 总计 2 条」，逐条答
//       答完 I2 → useInterrupt 一次 runAgent({ resume: [I1, I2] })
//       → agent.ts 一次 POST /resume（形状见 resumePending 的注释）
//
//   `hitl.resolved` 不翻：它只说明"有人答了"，而答的是什么前端刚自己提交过，
//   图接着会发 message.delta。翻出来等于把已知的事再说一遍。

import { type BaseEvent, EventType } from '@ag-ui/client';
import {
  type HitlRequestData,
  RUN_EVENT,
  type RunEventFrame,
} from './agentRuntime';
import {
  ASK_USER_QUESTION_TOOL_KEY,
  ASK_USER_QUESTION_TYPE,
} from './askUserQuestion';
import { type LiveTaskMark, noteLiveTask } from './liveTaskFeed';
import {
  currentPlanTask,
  isPlanEvent,
  isSubAgentTerminalEvent,
  type PlanEventPayload,
  SUBAGENT_EVENT,
} from './planTasks';
import {
  REASONING_CUSTOM_EVENT,
  type ReasoningPayload,
} from './reasoningStream';
import { sameTool } from './toolIdentity';

/** 这一轮 AG-UI 侧的标识（跟后端的 run_id 是两回事，别混）。 */
export interface RunStreamContext {
  threadId: string;
  runId: string;
  /**
   * 这一次**流**的标识，用来把 messageId 弄唯一。
   *
   * ⚠️ 为什么光有 runId 不够（踩过）
   * ----------------------------
   *   中断恢复时 CopilotKit 会**复用同一个 AG-UI runId**（见 useInterrupt 的
   *   resolve：`copilotkit.runAgent({ agent, resume, runId })`）。而
   *   `messageId` 是从 runId 派生的，于是恢复后那一段会和恢复前那一段撞 id。
   *   撞上之后 client 不会报错：`TEXT_MESSAGE_START` 发现同 id 的消息已存在就
   *   **复用它**，恢复后的文字被并进中断前那个气泡里 —— 静默、且看起来像
   *   "模型把自己说的话改了"。
   *   给每次流一个自己的标，这类问题就不会再出现。
   */
  streamId: string;
}

/** 一次运行跑完却一个字都没有时说的话。 */
export const EMPTY_REPLY_TEXT = '这次运行没有返回可显示的文本。';

/**
 * 后端 `hitl.requested` 的判定标签 —— AG-UI 的 `Interrupt.reason`。
 *
 * 值固定成工具审批这一种：`Interrupt` 的 `reason` 是"为什么停下来"的类别，
 * 卡片按它选渲染分支（见 HitlInterrupt.tsx 的 resolveVariant）。
 */
export const HITL_REASON = 'tool_approval';

/**
 * 一次并行审批的**聚合窗口**（毫秒）。
 *
 * 后端是"一个中断一条事件"、连着发（`_publish_hitl_requested` 的 for 循环），
 * 却没有"这一组发完了"的标记事件 —— 只能靠"静默多久算齐了"来切。
 *
 * ⚠️ 取值的依据与代价
 * ----------------
 *   · 窗口**每来一条就往后推**（debounce，不是固定计时）：所以 N 条之间的
 *     间隔只要都小于这个值就能聚成一组，跟 N 的大小无关；
 *   · 代价有两个方向，都不致命：
 *       - 太大 → 卡片出现前多等这么久（用户能感知的是"卡了一下"）；
 *       - 太小 → 一组被切成两次：先只声明第一条；等用户答完它、运行恢复之后，
 *         后端会把**仍然挂着的**那几条重发（dispatch 每轮结束都会
 *         `_publish_hitl_requested(pending_interrupts)`），于是再聚一次、
 *         再弹一张卡。用户会多答几轮，但**不会丢** —— 这是"切开了"不致命的理由。
 *     160ms 是"人手感觉不到、而后端两条之间几乎不可能超过"的位置：
 *     `publish_run_event` 是个进程内调用，实测是微秒级。
 *   · ⚠️ 切开的代价**不能**靠"下一帧再并进同一张卡"来补救：第一批一发出，
 *     收流就完成了（agent.ts 必须收流，否则卡片永远不出现），这一轮的流到此为止。
 *     要么这一批就齐，要么靠上面说的后端重发。
 */
export const HITL_GROUP_WINDOW_MS = 160;

/**
 * AG-UI 协议里的 `Interrupt`（@ag-ui/core 的 InterruptSchema）。
 *
 * ⚠️ 为什么自己写一份而不是 import
 * ------------------------------
 *   `@ag-ui/core` 不是本项目的直接依赖（只被 `@ag-ui/client` 传递依赖），
 *   而 `@ag-ui/client` **没有**再导出 `Interrupt` 这个类型。为了一个类型
 *   去 package.json 里加一条传递依赖，比按协议形状写 8 行更容易解释。
 *   字段与 InterruptSchema 逐条对齐，可选的那些就是真的可选。
 */
export interface AgUiInterrupt {
  id: string;
  reason: string;
  message?: string;
  responseSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * 有中断读不出 `interrupt_id` 时说的话 —— 没有它就无法回答，只能告诉用户。
 *
 * ⚠️ 只要**一条**读不出，**整组**都答不了，不是"跳过那一条"
 * -----------------------------------------------------
 *   后端 `ResumeRequest` 要求 `answers` **正好覆盖**当前 pending 集合
 *   （少一个 / 给多了 / 给错 id 都是 409）。所以丢掉读不出的那一条、
 *   照样把剩下几条送上去，结果是每次提交都 409 —— 用户拿着一个点了没用的
 *   按钮，比明说"这一组答不了"更糟。fail-closed。
 */
export const HITL_UNRESUMABLE_TEXT =
  '这次运行停下来等人工审批，但中断事件里缺了回答所需的 interrupt_id，' +
  '整组都没法回答。请检查后端 `_publish_hitl_requested` 是否补上了这个字段。';

/**
 * 自定义事件的 `name` —— "这会儿有个看不见的模型在干活"这件事走它。
 *
 * 为什么不是塞进 AG-UI 的消息流
 * ---------------------------
 * AG-UI 里能显示的东西只有 `messages`，而 `defaultApplyEvents` 对
 * `EventType.CUSTOM` 的处理是**原样透传、不落 messages**（grep dist 可见
 * `case CUSTOM: return g(e)`）。也就是说 CUSTOM 事件既不破坏消息数组、
 * 又能一路走到 `agent.subscribe({ onCustomEvent })` —— 正好是一条
 * "只显示、不进对账"的平行通道。
 *
 * 为什么不走 `agent.addMessage()`（看着更"自然"的那条路）
 * --------------------------------------------------
 * `messages` 是显示这条线路里唯一的事实来源，而 `@ag-ui/client` 的
 * apply 算子**每一帧都基于当时的 `agent.messages` 重算**：在流跑到一半时
 * 从外面插一条，等于和一个正在跑的状态机抢同一个数组 —— 谁赢说不准（尤其将来换 agent 实例、或者 ENVIRONMENT structuredClone
 * 那份快照回来写一遍的时候），而这种事一旦发生就是"出现又消失"的鬼影。
 * 平行通道没有这个耦合。
 */
export const PROGRESS_CUSTOM_EVENT = 'ytrader.progress';

/**
 * 自定义事件的 `name` —— 「一次工具调用的开始 / 结束」走它。
 *
 * 为什么和 PROGRESS 分开而不是复用
 * ----------------------------
 *   两者要回答的问题不一样：
 *     · progress  → "这会儿在干什么"（一行字，**不落任何记录**）；
 *     · tool      → "调了哪几个工具"（要**攒成一行行记录**，跑完还得留着看）。
 *   混在一个 payload 里，`useHiddenWork` 的深度计数就会被工具事件污染
 *   （节点开一层、工具又开一层，而它们其实是同一件事），"什么时候该消掉"
 *   会多出一堆特例。
 *
 * ⚠️ 名字里**没有**工具名的那一半
 * -------------------------
 *   需求是「loading 显示正在调用工具，但不用说是什么工具」。所以输入框上沿
 *   那枚胶囊由 `useToolActivity` 的 running 计数决定、**不读 name**；
 *   name 用于**那一行**记录 —— 从 called 起就画出来（行内转圈），
 *   完成 / 失败原地换成勾或叉（见 useToolActivity.ts 的状态机）。
 */
export const TOOL_ACTIVITY_CUSTOM_EVENT = 'ytrader.tool';

/**
 * 自定义事件的 `name` —— 「这一轮的任务计划」走它。
 *
 * 为什么也必须走平行通道
 * -------------------
 *   `plan.published` / `task.updated` / `plan.cleared` 说的是"这一轮在编排
 *   哪几件事"，不是"模型说了什么"。塞进 messages 会得到几条**假的助手消息**
 *   （刷新后还会留在历史里），而且 `defaultApplyEvents` 每次重算都会把它们
 *   和真正的正文混在一起。CUSTOM 事件原样透传、不落 messages，正好。
 *
 * ⚠️ 载荷里**带 runId**（取信封的 `topic_id`）
 * ---------------------------------------
 *   它是"这条计划属于哪一次运行"的唯一凭据：`plan.cleared` 丢一帧时，
 *   下一轮运行的第一个事件就能靠它把上一轮的任务栏清掉（见 usePlanFeed）。
 *   别改成让 UI 侧自己猜 —— 它拿不到后端 run_id。
 */
export const PLAN_CUSTOM_EVENT = 'ytrader.plan';

/**
 * 「工具失败」的事件名 —— **契约里没有这个事件**。
 *
 * 后端把成功与失败压成同一条 `tool.completed`，失败时带 `error` 字段
 * （见 app/agent/event/run_event_projector.py 的 `_on_tool_stream_event`）。
 * 这里仍然认这个名字，只为一件事：将来真加了这个事件，不认它就会让那一行
 * **永远转圈** —— 那是"看起来还在跑"的静默故障，比多一个分支难查得多。
 */
const TOOL_ERROR_EVENT = 'tool.error';

/** 一次工具调用的过程信号。`name` 允许为空串（后端拿不到 tool_key 时就是原名）。 */
export interface ToolActivityPayload {
  phase: 'start' | 'end';
  /** `tool_call_id`：同一次调用的 start / end 靠它配对（并行调用因此不会串）。 */
  callId: string;
  /** 工具名（点分 tool_key，或模型给的原名）。跑完的那行记录用它。 */
  name: string;
  /**
   * 这次调用属于**哪一步**（模型这条消息的 id）。
   *
   * ⚠️ 为什么工具行必须知道自己挂在哪条消息上
   * ------------------------------------
   *   刷新之后历史里工具行是**独立的消息**（`kind: tool_activity`），所以它
   *   天然落在正确的步与步之间。实时这条没有那条消息，工具行原先只能整轮
   *   堆在最后一条正文的上方 —— 那和历史完全不是一个样子。
   *   有了这个 id，实时也能把行放回它那一步的 section 里（见 DockRenderMessage）。
   *
   *   取的是**最近开出来的那条**消息（见 `lastMessageId`）：`tool.called`
   *   到达时当前这一步的文本消息已经收尾了，现场取会拿到下一条的 id。
   */
  messageId: string;
  /**
   * 这次调用属于**哪一次运行**（后端的 `run_id`，拿不到就是空串）。
   *
   * ⚠️ 为什么工具事件必须认得出"我是这一次运行的"
   * ----------------------------------------
   *   一次 HITL 审批在界面侧是**两次 AG-UI run**（中断一次、恢复一次，
   *   见 agent.ts 的文件头），但它们对应**同一个后端 run_id**。
   *   前端要把"这次调用成没成"存下来给刷新后用（toolStatusCache），而
   *   存下来的账必须按**后端那一次运行**归并 —— 否则"答完审批之后"那份
   *   记录会把审批之前那些调用覆盖掉，刷新之后只有最后那一小段有图标。
   *
   *   ⚠️ 空串表示"还不知道"（`openRun` 还没返回）；那种帧落到
   *      toolStatusCache 里会被跳过 —— 宁可这一行没有图标，也不要存错。
   */
  runId: string;
  /**
   * 失败原因。只有 `tool.completed` 失败时才有 —— 契约里**没有**独立的
   * `tool.error` 事件，成败靠这个字段区分（空 = 成功）。
   */
  error?: string;
}

/**
 * 一段"在干活、但界面上还没有字"的时间：开始 / 结束。
 *
 * ⚠️ 两种来源，共用同一个深度计数
 * ----------------------------
 *   1. **节点**（`node.started` / `node.completed`）。builder 那类节点一个
 *      message 事件都不发（它的 `langgraph_node` 不在 `message_nodes` 里）——
 *      实测日志里它占了 **31 秒**，是界面上最长的一段"什么都收不到"。
 *      只接 message 段的话，这段完全没东西可显示。
 *   2. **不可见的模型段**（`message.started` 的 `visible: false`）——
 *      上下文压缩 / 意图分类这类"给用户干活、不给用户看"的调用。
 */
export interface ProgressPayload {
  phase: 'start' | 'end';
  /** 节点名（`builder` / `agent` / `tools`…）；来自模型段时是 `null`。 */
  node: string | null;
  /** 模型角色（`ModelRole` 原值）；节点段带得出来就带，带不出来是 `null`。 */
  role: string | null;
  /** 模型段专用：后端随帧发下来的"正文给不给看"。节点段恒为 `false`。 */
  visible: boolean;
}

/**
 * 「这会儿在干什么」的人话。
 *
 * ⚠️ **这张表只挑文案，绝不参与"给不给看"的判定** —— 那件事由后端随帧
 *    发下来的 `visible` 说了算（见 agentRuntime.ts 的 MessageMeta）。
 *    角色词汇表是会长的，这里认不出来就回落到通用那句，**不会漏正文**。
 */
export function progressLabel(work: {
  node: string | null;
  role: string | null;
}): string {
  // 节点优先：它是"这一大步在干什么"，比它内部的模型角色更能说明问题。
  switch (work.node) {
    case 'builder':
      return '正在理解你的问题';
    case 'tools':
      // 与「正在调用工具」（工具事件那一侧，见 TOOL_ACTIVITY_CUSTOM_EVENT）
      // 用同一句：同一件事不该有两种说法，叠在一起更像两个 loading。
      return '正在调用工具';
    case 'agent':
      return '正在组织回答';
    default:
      break;
  }

  switch (work.role) {
    case 'summarization':
      return '正在整理上下文';
    case 'classification':
      return '正在判断意图';
    case 'evaluation':
      return '正在复核回答';
    case 'vision':
      return '正在看图';
    case 'fast':
      return '正在快速应答';
    default:
      // `memory.atom.extract` / `memory.scene.consolidate` / 没见过的角色、
      // 以及没见过的节点名，都落到这里 —— 加一个不该让这里长出 branches。
      return work.role?.startsWith('memory.') ? '正在更新记忆' : '正在处理';
  }
}

/** 帧里的布尔字段。**取不到时退回 `fallback`，不猜 truthy**（见下）。 */
function boolField(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * 只收"正的有限数"。
 *
 * ⚠️ 用 `> 0` 而不是 `>= 0`：窗口 0 秒意味着"立刻超时"，一个 0 会让卡片
 * 一出现就显示"已超过"，那更像是后端漏填了字段而不是真的设了 0。
 * 宁可**不显示**倒计时（退化成今天的样子），也不要显示一个荒唐的。
 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** 只收"能解析成时刻"的字符串 —— 收下一个解析不了的，倒计时会算出 NaN。 */
function timeField(value: unknown): string | undefined {
  const text = textField(value);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 这一帧是不是"停下来等人回答"。聚合成组的判据，只有这一个地方判。 */
export function isHitlFrame(frame: RunEventFrame): boolean {
  return frame.event === RUN_EVENT.HITL_REQUESTED;
}

/**
 * 把后端的 `hitl.requested.data` 翻成 AG-UI 的 `Interrupt`。
 *
 * 返回 `null` 表示**没法回答**（缺 interrupt_id）—— 那种情况不能当成"有个中断"：
 * 后端要求 `answers` 正好覆盖当前 pending 集合，漏一个就是 409，
 * 给用户一个点了必然失败的按钮比什么都不给更糟（见 endHitlGroup）。
 *
 * ⚠️ 后端那几个字段是审批拦截器的私有格式，可能缺席
 * ----------------------------------------------
 *   所以每一项都按"读不到就不放"处理：
 *     · `responseSchema` —— 用 `options` 编成一个 decision 的枚举。这是 AG-UI
 *       描述"该给什么回答"的标准位置，卡片据此知道该画几个按钮；
 *     · `metadata` —— 放原始字段（工具名、参数、角色、options、run_id）。
 *       卡片要展示"批的是什么工具、什么参数"，而这些不适合塞进
 *       responseSchema（那是**给回答用的**）。metadata 正是 AG-UI 留给
 *       "集成方自己用"的口袋。
 *
 * ⚠️⚠️ 倒计时的两样原料走 metadata，**不走 `expiresAt`**（这是个坑，别改）
 * ------------------------------------------------------------------
 *   AG-UI 的 `Interrupt` 有 `expiresAt` 字段，看起来正是给倒计时用的。
 *   **不要填它。** 填了就是让库替我们"执法"，而它的执法方式非常糟
 *   （`@ag-ui/client` + `@copilotkit/core`，两处都实测过）：
 *
 *     ① `AbstractAgent.onInitialize`：只要 `pendingInterrupts` 里有一个
 *        `isInterruptExpired`（`new Date(expiresAt) <= now`），
 *        **直接 throw** `Interrupt X expired at ...` —— 这个 agent 之后
 *        连新一轮都开不了；
 *     ② `InterruptState.#respond`：**整组**答完之后才查过期（不是答之前），
 *        任一过期 → 返回 `{ kind: 'expired' }` → `useInterrupt` 只打一条
 *        `console.error` 就 `clear()` + `setPending(null)`：**一个请求都不发**，
 *        卡片直接从界面上消失。
 *
 *   ②的后果最坏：用户点了「允许」，看着卡片没了，以为批了，而后端仍然停在
 *   `waiting_input` —— 答案被静默丢掉，只在 console 里留一行没人看的错误。
 *   所以这里**刻意不设** `expiresAt`（`AgUiInterrupt` 那个本地类型里干脆
 *   没有这个字段，想设也设不了）。
 *
 *   倒计时改成卡片自己算，两样原料都从**真数据**来：
 *     · `metadata.waitSeconds` —— 后端配置里声明的等待窗口
 *       （`ApprovalConfig.wait_seconds`，随 `_payload()` 下发）。前端**不写
 *       自己的常量**：自己定一个窗口等于发明一条后端不认的策略；
 *     · `metadata.requestedAt` —— **这一帧自己的 `occurred_at`**（后端 UTC，
 *       见 `RunEvent.occurred_at`）。用真时刻而不是"卡片挂载的那一刻"，
 *       是为了让刷新/续订后**重放**出来的这一帧仍带着原始时刻 ——
 *       倒计时接着走，而不是从满格重启。
 *
 *   缺任何一样就**不画倒计时**（退化成没有倒计时，而不是画一个假的）。
 *   ⚠️ 也**不设** `metadata.expiresAt`：那是另一套字段，一样会误导下一个人。
 */
export function hitlInterrupt(
  data: Record<string, unknown> | undefined,
  occurredAt?: unknown,
  fallbackQuestions?: readonly unknown[],
): AgUiInterrupt | null {
  const payload = data as HitlRequestData | undefined;
  const id = textField(payload?.interrupt_id);
  if (!id) return null;

  const options = stringList(payload?.options);
  const toolKey = textField(payload?.tool_key);
  const approverRole = textField(payload?.approver_role);
  const runId = textField(payload?.run_id);

  const metadata: Record<string, unknown> = {};
  if (toolKey) metadata.toolKey = toolKey;
  const args = recordField(payload?.arguments);
  if (args) metadata.arguments = args;
  if (approverRole) metadata.approverRole = approverRole;
  if (options.length > 0) metadata.options = options;
  if (runId) metadata.runId = runId;

  // 倒计时的两样原料，见上。缺一样卡片就不画倒计时。
  const waitSeconds = positiveNumber(payload?.wait_seconds);
  if (waitSeconds !== undefined) metadata.waitSeconds = waitSeconds;
  const requestedAt = timeField(occurredAt);
  if (requestedAt) metadata.requestedAt = requestedAt;

  // ----------------------------------------------------------------
  // 提问（`agent.ask_user_question`）
  //
  // 判据是载荷里的 `type` —— 审批拦截器**不带**这个字段，提问带
  // `ask_user_question`（hitl_tool.py 的 payload 第一行就是它）。卡片据此
  // 换掉中间那段（见 HitlInterrupt.tsx 的 resolveVariant）。
  //
  // `questions` 优先取载荷里的那份（它和 interrupt_id 同出一源，成对才答得回去）；
  // 载荷缺字段时退到 `tool.called` 记下的同一份入参（见 askQuestions 那段）。
  // ⚠️ 空数组也当"没读到"：那样才轮得到兜底，而不是把一个空题组交给界面。
  // ----------------------------------------------------------------
  const hitlType = textField(payload?.type);
  if (hitlType) metadata.hitlType = hitlType;

  const fromPayload = Array.isArray(payload?.questions)
    ? payload?.questions
    : undefined;
  const questions =
    fromPayload && fromPayload.length > 0 ? fromPayload : fallbackQuestions;

  if (questions && questions.length > 0) {
    metadata.questions = questions;
    // 兜底来的那份一定是提问（stash 只认这个工具），补上 type 让卡片认得出。
    if (!hitlType) metadata.hitlType = ASK_USER_QUESTION_TYPE;
  }

  // 处理器自己的元信息。⚠️ 换成 `hitlMetadata` 这个键名 —— 不能直接叫
  // `metadata`（这里就是 AG-UI 那个口袋，正被上面这些字段用着）。
  const hitlMeta = recordField(payload?.metadata);
  if (hitlMeta) metadata.hitlMetadata = hitlMeta;

  // 与 `tool.called` 对得上的那次调用。审批与提问都带，卡片暂时不用，
  // 但"这条中断是哪次调用停下来的"是排查时第一个要问的问题。
  const toolCallId = textField(payload?.tool_call_id);
  if (toolCallId) metadata.toolCallId = toolCallId;

  return {
    id,
    reason: HITL_REASON,
    // ask 就是给人看的那句话（审批拦截器的 prompt）
    message: textField(payload?.ask) || undefined,
    responseSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          // 没有 options 时不写 enum：宁可让卡片按兜底渲染，也不要凭空规定一个值域
          ...(options.length > 0 ? { enum: options } : {}),
        },
      },
      required: ['decision'],
    },
    metadata,
  };
}

/** 事件流在没有终态事件的情况下就断了（多半是运行还没跑完）。 */
const STREAM_CLOSED_TEXT =
  '事件流在没有终态事件的情况下就关闭了 —— 这次运行可能还没跑完。';

/** 运行失败时写进对话的说明。 */
export function runFailedText(data: Record<string, unknown>): string {
  const status = textField(data.status) || 'failed';
  const type = textField(data.error_type);
  const message = textField(data.error_message);

  const lines = ['这次运行失败了。', '', `· 状态：${status}`];
  if (type) lines.push(`· 错误类型：${type}`);
  if (message) lines.push(`· 错误信息：${message}`);
  return lines.join('\n');
}

/**
 * 有状态的翻译器 —— 一个实例对应一次运行。
 *
 * 为什么是类而不是纯函数：消息是不是开着、累积了多少字、有没有发过
 * RUN_FINISHED，这些都是"上一帧决定下一帧怎么发"的状态。硬写成纯函数
 * 就得把状态在调用点之间传来传去，反而更容易错。
 *
 * ⚠️ 每个方法返回的都是**数组**：一帧后端事件可能对应 0 条（丢弃）、
 * 1 条（一个 delta）或多条（补发 + 关闭）AG-UI 事件。
 */
export class RunEventTranslator {
  private readonly ctx: RunStreamContext;

  /** 第几条助手消息（一次运行可能有多条）。 */
  private messageSeq = 0;
  private messageOpen = false;
  /**
   * **最近一次真的开出来的**那条消息的 id。
   *
   * ⚠️ 工具调用要挂在它上面（见 toolActivity 的 `messageId`）
   * ---------------------------------------------------
   *   工具是在模型这一步**结束之后**才开始跑的：`tool.called` 到达时
   *   `closeMessage()` 已经把 `messageSeq` 加过一了，此刻的
   *   `currentMessageId()` 指向**下一条还没出现的消息**。所以不能现场取，
   *   必须在 `ensureMessageOpen()` 那一刻记下来。
   */
  private lastMessageId = '';
  /** 当前这条消息已发出的文本 —— 与 `message.completed.content` 对账用。 */
  private text = '';
  /**
   * 当前这条消息是**只装着工具调用**的（一个字都没说）。
   *
   * ⚠️ 为什么需要这个标记（2026-10-22 用户实报）
   * ----------------------------------------
   *   模型这一步上来直接调工具时（典型：`agent.enter_plan_mode`），
   *   `toolActivity` 会替它开一条消息（见那段注释）。**问题在那之后**：
   *   后端对"纯工具调用"这一步常常不发 `message.completed`，于是这条消息
   *   一直开着 —— 接下来那个任务的正文（`message.delta`）就**追加进了
   *   同一条消息**。两个后果，用户都报了：
   *
   *     · 正文与工具卡同属一条消息，而渲染层固定"正文在上、工具卡在下"
   *       （见 DockRenderMessage 的 section / tail）→ 卡跑到了正文**下方**，
   *       尽管它其实发生在正文**之前**。用户原话：「工具调用
   *       agent.enter_plan_mode 还是跑到 step1 正文下方了」。
   *     · 更隐蔽的一个：这条消息的**任务归属是开消息那一刻记的**（那时候
   *       还没有任何任务，记的是 null，见 liveTaskFeed），之后再没人补 →
   *       那个任务的整段产出在时间线上**没有轨道也没有节点**，第一个节点
   *       直接跳到"任务 2"。用户原话：「step_1 timeline 直接没了」。
   *
   *   所以：纯工具步骤占着的那条消息，遇到**下一条正文或下一段推理**都先收掉
   *   （见 splitToolOnlyStep）。
   */
  private toolOnlyStep = false;
  /**
   * 最近**收到推理 delta** 的那条消息 id。
   *
   * ⚠️ 为什么不能用 `currentMessageId()` 收尾（2026-10-22 用户实报
   * 「消息已经结束，前端依旧显示正在思考；刷新之后没有了」）
   * ----------------------------------------------------------
   *   推理的"停转圈"信号有两条：后端的 `message.reasoning.completed`，和
   *   `message.completed` 时补发的那条 `done`（见 reasoningStream 的说明）。
   *   两条从前都拿 `currentMessageId()` 当收尾目标 —— 那是"**现在**开着哪条"，
   *   不一定是"**刚才那些 delta 写进了哪条**"。
   *
   *   只要中间发生一次换消息（典型：纯工具步骤 —— 见 toolOnlyStep），
   *   `messageSeq` 就加过一了，收尾信号落到**下一条**消息上（它没有推理，
   *   applyReasoning 直接 return），真正在流的那条于是永远停在"正在思考"。
   *   刷新之后是历史通道（`metadata.reasoning`，天然是收尾态），所以看着
   *   "刷新就正常了"。
   *
   *   所以 delta 写进哪条，就记住哪条；收尾按它来，用完清掉。
   */
  private reasoningMessageId = '';
  /** 整轮有没有发出过任何文本 —— 决定要不要补一句"没有可显示文本"。 */
  private hasText = false;
  private runFinished = false;
  private terminalSeen = false;
  /**
   * 这一轮是不是**用户自己**按下停止掐断的。
   *
   * 只影响 finish() 补不补那句 STREAM_CLOSED_TEXT（见 finish 的注释）：
   * 用户亲手停的运行，"可能还没跑完"是句假话，而且是最让人困惑的那种假话。
   * 由 agent.ts 在真正叫停的那一刻调 markStoppedByUser() 置位。
   */
  private stoppedByUser = false;

  /**
   * 这次流对应的**后端 run_id**。由 agent.ts 在拿到它的那一刻回填
   * （见 `setBackendRunId`），工具事件要带着它走。
   */
  private backendRunId = '';

  /**
   * 记下这一轮订阅的是哪个后端运行（`openRun` 返回之后才有）。
   *
   * ⚠️ 为什么必须回来补这一笔：`RunStreamContext` 只有 AG-UI 那个 runId
   *    （传输层的事），而后端 run_id 要等 `createRun` / `resume` 的响应才有 ——
   *    翻译器是**在建运行之前**就 new 出来的（见 agent.ts 的 run()）。
   *    工具事件因此只能在翻译时从一个可变字段里读。
   */
  setBackendRunId(runId: string): void {
    this.backendRunId = runId;
  }

  /**
   * **当前这一段**模型调用（后端 `message.started` … `message.completed` 之间）。
   *
   * ⚠️ `visible` 只在**见过 started** 之后才有意义 —— 见 `segmentAllowsText`。
   */
  private segmentOpen = false;
  private segmentVisible = true;
  private segmentRole: string | null = null;

  /**
   * `agent.ask_user_question` 的入参，按 `tool_call_id` 记一份。
   *
   * ⚠️ 为什么需要它（`hitl.requested` 里不是已经有 questions 了吗）
   * ---------------------------------------------------------
   *   有。**这份是兜底**，两个理由：
   *     · `tool.called` 与 `hitl.requested` 携带的是**同一份** `questions`
   *       （前者是模型参数，后者是 `interrupt()` 的载荷），但前者先到、且
   *       只要工具被调用过就一定在；后者是"停下来"那一刻才发的。
   *       前端真正能提交的时机是后者 —— 所以**触发**永远看中断，
   *       这份只在中断载荷缺 `questions` 时补位（老后端 / 载荷裁剪）；
   *     · 认得出"这是一次提问"这件事，因此中断里没写 `type` 也能救回来。
   *
   *   不把它塞进 `ToolActivityPayload`：那条通道喂给工具行，行上只画名字，
   *   把 questions 塞进去等于让一行记录扛着一份没人看的大对象。
   *   这里是翻译器自己的账本，`tool.completed` 一到就删（见 stashAskQuestions）。
   */
  private readonly askQuestions = new Map<string, readonly unknown[]>();

  /**
   * 此刻在跑的是哪个任务（`null` = 没有任务在跑）。
   *
   * ⚠️ 为什么在翻译器里记，而不是让渲染层自己去问 plan feed
   * ---------------------------------------------------
   *   时间线要回答的问题是"**这条消息开出来的那一刻**属于哪个任务"。
   *   渲染时去问 plan feed 拿到的是"**现在**在跑哪个任务"—— 两者在
   *   任务切换的那一帧会错开一整个任务（消息被挂到下一个任务名下）。
   *   翻译器是"消息被开出来"这件事的唯一见证者，只有它能在正确的时刻取值。
   *
   * 值来自编排事件（计划三条 + 子代理四条），由 `planActivity` →
   * `noteLiveTask` 更新 —— 那里把"并行波次里谁在跑"的三种情形写清楚了。
   */
  private liveTask: LiveTaskMark | null = null;

  constructor(ctx: RunStreamContext) {
    this.ctx = ctx;
  }

  /**
   * 标记「这一轮是用户主动停的」。
   *
   * ⚠️ 必须在**收流之前**调（agent.ts 在 takeUntil 触发前就设），因为 finish()
   *   只在"还没收尾"时才有机会补那句说明 —— 补完就 RUN_FINISHED 了。
   */
  markStoppedByUser(): void {
    this.stoppedByUser = true;
  }

  /** 一轮的开头。无条件发 —— 界面要立刻进入"正在运行"。 */
  start(): BaseEvent[] {
    return [
      {
        type: EventType.RUN_STARTED,
        threadId: this.ctx.threadId,
        runId: this.ctx.runId,
      },
    ];
  }

  /** 把一帧后端事件翻成 AG-UI 事件（可能 0 条）。 */
  push(frame: RunEventFrame): BaseEvent[] {
    if (frame.event === TOOL_ERROR_EVENT) {
      return this.toolActivity('end', frame.data);
    }

    // 任务编排那一族（计划三条 + 子代理四条）：不进消息流，只转发给输入框
    // 上方那两条状态栏（见 PLAN_CUSTOM_EVENT / usePlanFeed）。放在 switch 之前，
    // 因为它们不属于"运行生命周期"那张词表（RUN_EVENT）。
    if (isPlanEvent(frame.event)) {
      return this.planActivity(frame);
    }

    switch (frame.event) {
      // ⚠️ `node.started` 必须翻 —— 它不是噪音，是**唯一**能覆盖"没有字的
      //    那段时间"的信号。builder 节点实测 31 秒、期间一条 message 都没有
      //    （它的 `langgraph_node` 不在 `message_nodes` 里），只接 message 段
      //    的话整段静默。原来它走 default 被丢掉，是为了不把它翻成**气泡** ——
      //    翻成"正在…"是另一回事。
      case RUN_EVENT.NODE_STARTED:
        return this.progress('start', {
          node: textField(frame.data.node_id) || null,
          role: textField(frame.data.model_role) || null,
          visible: false,
        });

      case RUN_EVENT.NODE_COMPLETED:
        return this.progress('end', {
          node: textField(frame.data.node_id) || null,
          role: textField(frame.data.model_role) || null,
          visible: false,
        });

      case RUN_EVENT.MESSAGE_STARTED:
        return this.openSegment(frame.data);

      case RUN_EVENT.MESSAGE_DELTA: {
        // 不可见的段：后端本来就一个字都不发，这里是第二道。
        // ⚠️ 挡在这里而不是让 UI 侧识别 —— 一旦发出去过 message pipeline，
        //    它会被拼进`message.completed`对账的那份 text 里，之后再删就要
        //    同时改两个地方。
        if (!this.segmentAllowsText()) return [];
        return this.openMessage(textField(frame.data.delta));
      }

      // ⚠️ 推理走**同一道可见性闸**
      // -------------------------
      //   后端原话：摘要（summarization）在同一个 agent 节点里调模型，没有
      //   角色门的话它的**思维链**会直接漏进聊天窗 —— 那比正文泄漏更糟，
      //   因为推理里往往有内部判据与原始输入。所以这里复用 `segmentAllowsText()`，
      //   不另设一套判据（两套判据迟早会漂）。
      case RUN_EVENT.MESSAGE_REASONING_DELTA: {
        if (!this.segmentAllowsText()) return [];
        const delta = textField(frame.data.delta);
        if (delta === '') return [];

        // ⚠️ 必须**先把消息开出来**：推理通常先于正文到达，消息没开就没有
        //    messageId 可挂（而且气泡不会出现，用户连"正在思考"都看不到）。
        // ⚠️ 也要先跟"纯工具步骤"分开（见 splitToolOnlyStep）：下一步的思考
        //    不能留在上一步那颗工具卡所在的消息里。
        const events: BaseEvent[] = [];
        events.push(...this.splitToolOnlyStep());
        events.push(...this.ensureMessageOpen());
        // 这段推理写进了哪条 —— 收尾时要按它来（见 reasoningMessageId）。
        this.reasoningMessageId = this.currentMessageId();

        events.push(
          ...this.reasoning({
            messageId: this.currentMessageId(),
            delta,
          }),
        );
        return events;
      }

      case RUN_EVENT.MESSAGE_REASONING_COMPLETED: {
        if (!this.segmentAllowsText()) return [];
        // 全文 = 对账点，与 message.completed 那条路同一个道理。
        // ⚠️ 这里**不**开消息：completed 是收尾，为它开一条空气泡没意义。
        // ⚠️ 目标取**写 delta 的那条**，不是"现在开着的那条"（见
        //    reasoningMessageId —— 中间可能已经换过消息了）。
        const id = this.reasoningMessageId || this.currentMessageId();
        this.reasoningMessageId = '';
        return this.reasoning({
          messageId: id,
          content: textField(frame.data.content),
          done: true,
        });
      }

      case RUN_EVENT.MESSAGE_COMPLETED: {
        // ⚠️ id 必须**在 closeMessage 之前**取：closeMessage 会把 messageSeq
        //    加一，之后 currentMessageId() 已经是下一条的 id 了。
        const id = this.currentMessageId();
        /*
         * 推理的收尾目标：**写 delta 的那条**（见 reasoningMessageId）。
         * 取不到才退回本条 —— 中间可能已经因为"纯工具步骤"换过消息，
         * 那时候 `id` 已经不是推理所在的那条了（用户报的"一直正在思考"）。
         */
        const reasoningId = this.reasoningMessageId || id;
        this.reasoningMessageId = '';
        // 只有可见的段才拿 content 对账：不可见那段的 content 后端给空串，
        // 就算塞了东西也不该补进气泡。
        const content = this.segmentAllowsText()
          ? textField(frame.data.content)
          : '';
        // 对账：content 是全量，delta 是增量。缺多少补多少，多了不动
        // （已经发出去的字撤不回来，而这种情况本来也不该发生）。
        const missing = content.startsWith(this.text)
          ? content.slice(this.text.length)
          : '';
        return [
          ...this.openMessage(missing),
          ...this.closeMessage(),
          ...this.closeSegment(),
          // 兜底收尾：后端对"没有思维链"是**不发** reasoning.completed 的
          // （"这次没有推理" ≠ "推理是空的"），而 delta 又是旁路、丢了不重发。
          // 没有这一条，最后一个推理 token 之后那行"思考中…"会一直转。
          ...this.reasoning({ messageId: reasoningId, done: true }),
        ];
      }

      case RUN_EVENT.RUN_COMPLETED:
        this.terminalSeen = true;
        return this.endRun();

      case RUN_EVENT.RUN_FAILED:
        this.terminalSeen = true;
        // 先收掉已经在流的那条消息，失败原因另起一条 —— 混在半句话后面读不清
        return this.endRun([
          ...this.closeMessage(),
          ...this.openMessage(runFailedText(frame.data)),
        ]);

      case RUN_EVENT.HITL_REQUESTED:
        // 单帧进来时也走聚合那条路（见 pushChunk）—— 两条路径一个出口，
        // 免得"单条"和"一组"长出两套行为。
        return this.endHitlGroup([frame]);

      case RUN_EVENT.HITL_RESOLVED:
        // 见文件头：只说明"有人答了"，答案是什么前端刚自己提交过。
        // 它后面还会跟 message.delta —— 那才是要显示的东西。
        return [];

      // ⚠️ 工具调用只发**过程信号**，不进 messages（理由见文件头）：
      //    前端据此显示"正在调用工具…"，跑完之后在那一步的 section 里留一行记录。
      case RUN_EVENT.TOOL_CALLED:
        return this.toolActivity('start', frame.data);

      case RUN_EVENT.TOOL_COMPLETED:
        return this.toolActivity('end', frame.data);

      default:
        // run.started（RUN_STARTED 已在 start() 发过）、node.* 已各自处理
        return [];
    }
  }

  /**
   * 流自然结束（或被掐断）时的收尾。
   *
   * 后端遇到终态事件会自己关流，那时 `runFinished` 已为真，这里返回空数组 ——
   * 不会重复发 RUN_FINISHED。
   */
  finish(): BaseEvent[] {
    if (this.runFinished) return [];
    // ⚠️ `stoppedByUser` 也要算"结束的正当理由"：用户主动停的运行**本来就没跑完**，
    //   补那句"可能还没跑完"既是废话也会让人以为点停止没生效。
    const extra =
      this.terminalSeen || this.stoppedByUser
        ? []
        : this.openMessage(STREAM_CLOSED_TEXT);
    return this.endRun(extra);
  }

  /** 连流都没开起来（建会话/建运行/SSE 请求本身失败）。 */
  fail(reason: string): BaseEvent[] {
    if (this.runFinished) return [];
    return this.endRun([
      ...this.closeMessage(),
      ...this.openMessage(
        `没能把这一轮交给 YTraderHarness。\n\n· 原因：${reason}\n\n检查后端是否已在 8080 上运行（dev 下 /api/ 由 config/proxy.ts 转发过去）。`,
      ),
    ]);
  }

  /**
   * 一批帧。**只有 hitl.requested 会成批**（一次并行审批的整组），其余一帧一批。
   *
   * ⚠️ 为什么要在这里分"批"（而不是让 agent.ts 把组摊成 N 帧喂进来）
   * ----------------------------------------------------------
   *   翻译器必须**一次**看到整组，才能发出一个带 `interrupts: [...N]` 的
   *   RUN_FINISHED。摊平成 N 帧的话，第一帧就把运行收尾了（runFinished = true），
   *   后面 N-1 帧被丢掉 —— 界面上只看到第一个中断，而这一组其实有 N 个。
   *   而"整组一次性声明"正是让 CopilotKit 攒齐答案、一次上报的前提
   *   （见文件头那段 InterruptState 的引用）。
   */
  pushChunk(frames: RunEventFrame[]): BaseEvent[] {
    if (frames.length > 0 && frames.every(isHitlFrame)) {
      return this.endHitlGroup(frames);
    }
    return frames.flatMap((frame) => this.push(frame));
  }

  // ---------------- 内部 ----------------

  /**
   * 把一组 `hitl.requested` 收成一次 `RUN_FINISHED { outcome: 'interrupt' }`。
   *
   * 收尾必须**现在**发生：后端把流挂着不关（等审批不算终态），而
   * `RUN_FINISHED` 只是事件 —— `runAgent` 要等 observable 完结才走收尾，
   * CopilotKit 正在收尾里（onRunFinalized）把 interrupts 交给 useInterrupt。
   * 不收流的话卡片永远不出现。agent.ts 看到这一组就收流（见那边的注释）。
   */
  private endHitlGroup(frames: RunEventFrame[]): BaseEvent[] {
    this.terminalSeen = true;

    const interrupts = frames
      // `occurred_at` 在这一帧的**顶层信封**里（与 event / topic / data 平级，
      // 见 agentRuntime.ts 的 RunEventFrame），不是 data 里面 —— 别取错地方。
      .map((frame) =>
        hitlInterrupt(
          frame.data,
          frame.payload.occurred_at,
          this.stashedQuestions(frame.data),
        ),
      )
      .filter((interrupt): interrupt is AgUiInterrupt => interrupt !== null);

    // ⚠️ 必须**每一条**都读得出 id，不是"有多少算多少"
    //   后端要求 answers 正好覆盖 pending 集合（少一个就 409），所以丢一条
    //   等于整组作废 —— 那就明说，别给点了没反应的按钮。
    //   （调用方保证 frames 全是 hitl 帧：pushChunk 有 every(isHitlFrame) 守卫、
    //     push 只在 HITL_REQUESTED 这个分支调它。）
    if (interrupts.length !== frames.length) {
      return this.endRun([
        ...this.closeMessage(),
        ...this.openMessage(HITL_UNRESUMABLE_TEXT),
      ]);
    }

    // 先关掉流到一半的消息（审批往往跟在模型的话后面），再把整组交出去
    return this.endRun(this.closeMessage(), {
      type: 'interrupt',
      interrupts,
    });
  }

  /**
   * 这一帧中断对应的、`tool.called` 里记下的那份提问入参（没有就是 undefined）。
   * 只在载荷缺 `questions` 时才被用到（见 `askQuestions` 那段）。
   */
  private stashedQuestions(
    data: Record<string, unknown> | undefined,
  ): readonly unknown[] | undefined {
    const id = textField(data?.tool_call_id);
    return id === '' ? undefined : this.askQuestions.get(id);
  }

  /**
   * 记下 / 清掉一次提问的入参（见 `askQuestions` 那段）。
   *
   * ⚠️ 用 `sameTool` 判名字而不是等号：`tool.called` 的 `tool_name` 可能是
   *   `agent.ask_user_question`（tool_key），也可能是模型给的原名
   *   `ask_user_question`（langgraph 的 tools 通道报的是函数名）。
   */
  private stashAskQuestions(
    phase: ToolActivityPayload['phase'],
    callId: string,
    data: Record<string, unknown>,
  ): void {
    if (callId === '') return;

    // 调用结束就清掉：一个 LLM 轮次里同一次调用不会再停一次，
    // 留着只会让这本账无限长大（一次运行可能几十次工具调用）。
    if (phase === 'end') {
      this.askQuestions.delete(callId);
      return;
    }

    if (!sameTool(textField(data.tool_name), ASK_USER_QUESTION_TOOL_KEY))
      return;

    const questions = recordField(data.input)?.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      this.askQuestions.set(callId, questions);
    }
  }

  private currentMessageId(): string {
    const base = `${this.ctx.runId}:${this.ctx.streamId}:reply`;
    return this.messageSeq === 0 ? base : `${base}:${this.messageSeq}`;
  }

  // ---------------- 模型段（message.started … message.completed） ----------------

  /**
   * 开一段：记下它的角色与"正文给不给看"，不可见的话顺手告诉 UI 一声。
   *
   * ⚠️ 为什么**不**照抄后端那句"取不到 role 就是不可见"
   * ----------------------------------------------
   * 后端（projector）role 缺证时按不可见处理，理由是"宁可少发正文，也别让
   * 压缩结果漏进聊天窗"。那一侧判断的依据是同一进程里的 metadata，而前端
   * 这一帧可能**根本没收到**（SSE 心跳之间丢帧、断点续传从中间开始）——
   * 在这里沿用同一个 fail-safe，代价是整轮回答一个字都不显示，用户看到
   * "没有可显示的文本"。那是**更坏的故障模式**，而"漏出摘要"已经由后端
   * 那道白名单保证了。
   * 所以：**没见过 started = 照旧放行**，见过且说不可见 = 拦。
   */
  private openSegment(data: Record<string, unknown>): BaseEvent[] {
    const role = textField(data.role) || null;
    const visible = boolField(data.visible, true);

    this.segmentOpen = true;
    this.segmentRole = role;
    this.segmentVisible = visible;

    return visible ? [] : this.progress('start', { node: null, role, visible });
  }

  /** 关一段。只有之前说过"这段看不见"才需要通知 UI 停下来。 */
  private closeSegment(): BaseEvent[] {
    if (!this.segmentOpen) return [];

    // ⚠️ 不要为了省两行把它写成 `const { segmentRole: role } = this`：
    //    biome 的 noUnusedPrivateClassMembers **认不出解构**里的读取，
    //    会把 `segmentRole` 判成"没人用"并建议删掉（它的 fix 会真删，别手滑）。
    const role = this.segmentRole;
    const visible = this.segmentVisible;

    this.segmentOpen = false;
    this.segmentRole = null;
    this.segmentVisible = true;

    return visible ? [] : this.progress('end', { node: null, role, visible });
  }

  /** 这一段允不允许把正文发出去。 */
  private segmentAllowsText(): boolean {
    return !this.segmentOpen || this.segmentVisible;
  }

  private progress(
    phase: ProgressPayload['phase'],
    work: Omit<ProgressPayload, 'phase'>,
  ): BaseEvent[] {
    const value: ProgressPayload = { phase, ...work };
    return [
      {
        type: EventType.CUSTOM,
        name: PROGRESS_CUSTOM_EVENT,
        value,
      } as BaseEvent,
    ];
  }

  private reasoning(payload: ReasoningPayload): BaseEvent[] {
    return [
      {
        type: EventType.CUSTOM,
        name: REASONING_CUSTOM_EVENT,
        value: payload,
      } as BaseEvent,
    ];
  }

  /**
   * 一帧任务编排事件 → 一条 CUSTOM（`ytrader.plan`）。
   *
   * 七条事件走同一个出口：计划族三条（`plan.published` / `task.updated` /
   * `plan.cleared`）+ 子代理族四条（`subagent.created` / `claimed` /
   * `task.updated` / `completed`）。分流的判据只有"事件名"，
   * 剩下的全在 `planTasks.reducePlan` 里（纯函数、可单测）。
   *
   * ⚠️ `runId` 取**信封**的 `topic_id`，不是 data 里的任何字段
   * ---------------------------------------------------
   *   信封是 `{ event, topic, topic_id, node, occurred_at, data }`，
   *   `topic_id` 就是后端 run_id（`run-7c9e6679`）。data 里的 `plan_id`
   *   是**计划**的 id，两者会被混用（名字都像 id），别取错：
   *   界面要判"这是不是新的一轮运行"，只有 run_id 能回答。
   *
   * ⚠️ data 原样透传，不在这一层解析
   * ---------------------------
   *   解析在 planTasks.ts 的 reducePlan 里做（纯函数、可单测）。这里一旦
   *   开始裁剪字段，两处就会各有一套"什么算有效任务"的判据。
   */
  private planActivity(frame: RunEventFrame): BaseEvent[] {
    const payload: PlanEventPayload = {
      runId: textField(frame.payload.topic_id),
      event: frame.event,
      data: frame.data,
    };

    // 「此刻在跑哪个任务」在这里更新 —— 时间线（taskTimeline）靠它把
    // 实时消息挂到任务节点下面。判据在 planTasks / 下面那个方法里。
    this.noteLiveTask(frame);

    return [
      {
        type: EventType.CUSTOM,
        name: PLAN_CUSTOM_EVENT,
        value: payload,
      } as BaseEvent,
    ];
  }

  /**
   * 一帧编排事件之后，"此刻在跑的任务"变成了谁。
   *
   * 单任务时代这一件事只有一行（直接问 `currentPlanTask`）；子代理上线之后
   * 它有三种情形，**必须分开**，否则并行波次里归属会乱跳：
   *
   *   ① `subagent.created` —— **不动**。
   *      这一帧说的是"派出去了"，载荷里根本没有 task（还没认领）。
   *      照 `currentPlanTask` 算必然是 null，于是 worker1 被派出的那一刻，
   *      worker0 正在跑的那条任务的归属就被抹掉了 —— 它后面产出的消息
   *      会全部掉到"没有任务"的无主轨道上。
   *
   *   ② `subagent.task.updated` / `subagent.completed` —— **只有它正好是
   *      liveTask 时才收**。
   *      这两帧的 `current_task_id` 恒为 null（后端把它当"没有 current"发）。
   *      无条件套 `currentPlanTask` 会让第一个 worker 交差就把归属清空，
   *      而另一个 worker 明明还在跑。所以按 `task_id` 精确比对。
   *
   *   ③ 其余（计划族三条 + `subagent.claimed`）—— 照旧问 `currentPlanTask`：
   *      claimed 的有 `current_task_id` + 运行中的 task 快照，正好能提前
   *      （比 task.updated 早）把这一波的任务认下来。
   */
  private noteLiveTask(frame: RunEventFrame): void {
    if (frame.event === SUBAGENT_EVENT.CREATED) return;

    if (isSubAgentTerminalEvent(frame.event)) {
      const taskId = textField(frame.data.task_id);
      if (taskId !== '' && this.liveTask?.taskId === taskId) {
        this.liveTask = null;
      }
      return;
    }

    const current = currentPlanTask(frame.event, frame.data);
    this.liveTask = current
      ? {
          taskId: current.taskId,
          title: current.title,
          planId: current.planId,
        }
      : null;
  }

  /**
   * 一帧工具事件 → 一条工具过程信号。
   *
   * ⚠️ `tool_call_id` 在你这里**可能是数字**
   * ------------------------------------
   *   后端那个字段是 `Any`（`_publish_tool_event` 直接透传），实测是字符串、
   *   但契约没写死。所以只做"能变成非空字符串"的转换，不假设类型。
   *
   * ⚠️ 读不到 id 时**不要**自己造一个
   * ------------------------------
   *   造出来的 id 一定和 start 那帧造的不一样（两帧各自自增），
   *   "正在调用工具"就永远收不了尾。空串交给 useToolActivity 按顺序配对
   *   （见那边的说明）—— 宁可并行时配错，也不要串行时卡住。
   */
  private toolActivity(
    phase: ToolActivityPayload['phase'],
    data: Record<string, unknown>,
  ): BaseEvent[] {
    const rawId = data.tool_call_id;
    const callId =
      typeof rawId === 'string'
        ? rawId
        : typeof rawId === 'number'
          ? String(rawId)
          : '';

    /**
     * ⚠️ 这一步还**没有**任何被开出来的消息 -> 现在就替它开一条
     * ----------------------------------------------------
     *   工具行靠 `messageId` 落位到"自己那一步"。模型这一步一个字都没说、
     *   也没推理时（很常见：上来直接调工具），此刻 `lastMessageId` 是空的 ——
     *   不带 id 的工具行会被当成孤儿、**整批堆到最后一条消息下面**，
     *   界面上就是"几个工具的卡片被合并到末尾、还插队到了回答之后"。
     *
     *   开一条之后这一步就有了自己的位置：它正文本身是空的，渲染时一个气泡
     *   都不会画（见 DockRenderMessage 的 showBody），工具卡片则落在它下面 ——
     *   与历史里那条 `tool_activity`（独立消息、落在正确的步之间）一致。
     */
    const opened = this.lastMessageId === '' ? this.ensureMessageOpen() : [];

    /*
     * ⚠️ 这条消息里到现在一个字都没有 -> 它是"纯工具步骤"（见 toolOnlyStep）。
     *   只在**它还开着**时标：已经关掉的消息记的是它自己的文本，`this.text`
     *   早在 closeMessage 里被清空了，按它判断会把"下一步的正文"也收掉一次
     *   （虽然无害，但没必要）。
     */
    if (this.messageOpen && this.text === '') this.toolOnlyStep = true;

    const payload: ToolActivityPayload = {
      phase,
      callId,
      name: textField(data.tool_name),
      messageId: this.lastMessageId,
      runId: this.backendRunId,
    };

    // 失败原因：`tool.completed` 带 `error` 就是失败（契约里没有 tool.error）。
    // 只在 end 上带 —— start 那一帧没有这个语义。
    if (phase === 'end') {
      const error = textField(data.error);
      if (error !== '') payload.error = error;
    }

    // 提问工具的入参留一份账（只是兜底，见 askQuestions 那段）。
    this.stashAskQuestions(phase, payload.callId, data);

    return [
      ...opened,
      {
        type: EventType.CUSTOM,
        name: TOOL_ACTIVITY_CUSTOM_EVENT,
        value: payload,
      } as BaseEvent,
    ];
  }

  /**
   * 保证当前消息是开着的（没开就发一条 TEXT_MESSAGE_START）。
   *
   * ⚠️ 推理要先于正文用它：推理 token 通常比正文先到，而 AG-UI 的消息是
   *    到 `TEXT_MESSAGE_START` 才存在的 —— 不开就没有 messageId 可挂。
   */
  private ensureMessageOpen(): BaseEvent[] {
    if (this.messageOpen) return [];
    this.messageOpen = true;
    const messageId = this.currentMessageId();
    // 工具事件要靠它认"我属于哪一步"（见 lastMessageId 的注释）。
    this.lastMessageId = messageId;

    // 这条消息属于哪个任务 —— **在它被开出来的这一刻**记下来
    // （见 liveTask 的注释：晚一步问就会挂错任务）。
    // 没有任务在跑时记的是 null（= 明确"这条不在任何任务里"）。
    noteLiveTask(messageId, this.liveTask);

    return [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: 'assistant',
      },
    ];
  }

  /**
   * 当前这条消息如果是"纯工具步骤"占着的，就把它收掉（返回那条 `TEXT_MESSAGE_END`）。
   *
   * ⚠️ **两步都要过这一道**：正文（`openMessage`）和推理（`message.reasoning.delta`）。
   *   2026-10-22 用户先报了正文那半（工具卡坠到正文下方），修完又报了推理那半：
   *   「确实是 step_1 的思考过程，跑到最开始的工具调用 agent.enter_plan_mode 上方去了」。
   *   原因一模一样 —— 下一个任务**先到的是思考**，它顺着 `ensureMessageOpen`
   *   落进了工具步骤那条消息，而渲染层在一条消息里固定「思考在上、工具卡在下」
   *   （见 DockRenderMessage 的 section / tail），于是任务 1 的思考被摆到了
   *   计划之前那颗工具卡的上方。
   *   现在推理也会先把它收掉：思考随**下一个任务**的那条消息走，轨道和节点一起过去。
   *
   * 没有标记（不是纯工具步骤）时什么都不做 —— 那种"先想再调工具"的步骤里，
   * 思考和工具本来就该待在同一条消息里（思考在上，正是它发生的顺序）。
   */
  private splitToolOnlyStep(): BaseEvent[] {
    if (!this.toolOnlyStep) return [];
    // closeMessage 里会把标记复位（见那边的注释）。
    return this.closeMessage();
  }

  /** 往当前消息追加一段；消息还没开就顺手开一条。 */
  private openMessage(delta: string): BaseEvent[] {
    if (!delta) return [];

    const events: BaseEvent[] = [];

    /*
     * ⚠️ 上一条消息是"纯工具步骤" -> 先把正文与它分开（见 splitToolOnlyStep）
     * --------------------------------------------------------------
     *   这一段正文属于**下一个**步骤（典型：工具开出来的那条消息只有
     *   `agent.enter_plan_mode`，接下来的正文是任务 1 的产出）。不分开的话
     *   工具卡会落在正文下方，而且正文那条消息拿不到任务归属。
     *   收掉之后 `ensureMessageOpen` 会重新问一次"现在在跑哪个任务"，
     *   归属自然就对了 —— 不用另外补记。
     */
    events.push(...this.splitToolOnlyStep());
    events.push(...this.ensureMessageOpen());

    this.text += delta;
    this.hasText = true;
    events.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.currentMessageId(),
      delta,
    });
    return events;
  }

  /** 收掉当前消息（没开就什么都不做）。 */
  private closeMessage(): BaseEvent[] {
    if (!this.messageOpen) return [];
    const end: BaseEvent = {
      type: EventType.TEXT_MESSAGE_END,
      messageId: this.currentMessageId(),
    };
    this.messageOpen = false;
    this.text = '';
    // 标记跟着消息走：消息都收了，这个"纯工具步骤"的说法就不该留到下一步
    // （否则下一次正文会白白多关一次 —— 无副作用，但状态不干净）。
    this.toolOnlyStep = false;
    this.messageSeq += 1;
    return [end];
  }

  /**
   * 收尾：关消息 → RUN_FINISHED。一次运行只会真正执行一次。
   *
   * ⚠️ `outcome` 是"停下来等人"与"跑完了"的唯一区别
   * --------------------------------------------
   *   不带 outcome 的 RUN_FINISHED 在协议里就是 `{ type: 'success' }`，
   *   客户端据此把这次运行当作跑完（并清空 pendingInterrupts）。
   *   带 `{ type: 'interrupt' }` 才是"结束但有待办"。
   *
   *   ⚠️ 带 outcome 时**不补** EMPTY_REPLY_TEXT：模型只调工具、一个字都没说
   *   是完全正常的（用户就让它去调），这时候插一句"没有返回可显示的文本"
   *   是在一个有意义的回答前面加噪音。
   */
  private endRun(
    extra: BaseEvent[] = [],
    outcome?: { type: 'interrupt'; interrupts: AgUiInterrupt[] },
  ): BaseEvent[] {
    if (this.runFinished) return [];
    this.runFinished = true;

    // ⚠️ 兜底：任何一条收尾路径上，段都可能还开着（流被掐断 / 后端异常没发
    //   completed）。不在这里关一次，UI 那行"正在…"会一直转到下一次运行。
    const events = [...this.closeSegment(), ...extra];
    if (!this.hasText && !outcome) {
      events.push(...this.openMessage(EMPTY_REPLY_TEXT));
    }
    events.push(...this.closeMessage());
    events.push({
      type: EventType.RUN_FINISHED,
      threadId: this.ctx.threadId,
      runId: this.ctx.runId,
      // BaseEventSchema 是 passthrough，额外字段合法（RunFinishedEvent 才有 outcome）
      ...(outcome ? { outcome } : {}),
    } as BaseEvent);
    return events;
  }
}
