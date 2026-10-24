// src/components/CopilotDock/planTasks.ts
//
// 后端「任务编排」事件的解析与归约 —— 今天一共七条，分两族：
//
//   计划族（2026-10-22 上线）
//     plan.published  一次计划（或它的新版本）整体下发 —— 带 goal + 全部 tasks
//     task.updated    单个任务的状态变了 —— 带**完整的一条 task**（不是补丁）
//     plan.cleared    这次计划结束了（completed / 别的 reason）—— **折叠但保留**，
//                     不快照 → 见 PlanView.finished 与归约里那段注释
//
//   子代理族（2026-10-23 上线，见 SUBAGENT_EVENT）
//     subagent.created      派出一个 worker（预 claim 成功、Send 之前）
//     subagent.claimed      worker 认下了任务（紧接 created）
//     subagent.task.updated 某个任务收了尾（波次 join 时**补发**，不是实时）
//     subagent.completed    同上，紧接其后的一条终态确认
//
// 它们和 run 事件走**同一条 SSE**，但**不进消息流**：任务计划不是"模型说了
// 什么"，而是"这一轮在编排什么"。所以翻译器把它们转成 `EventType.CUSTOM`
// （见 runEventStream 的 planActivity），由 usePlanFeed 归约成下面这个快照，
// 再交给输入框上方那条「任务 / 子代理」dock（PlanStatusBars）。
//
// ⚠️ 计划族三条事件的 `data` 是**同一种 task 形状**，但 plan.published 给的是一整组
// ----------------------------------------------------------------------
//   所以归约要分两种语义：
//     · published —— **整体替换** tasks（它代表"此刻计划的权威内容"，
//       revision 变了还可能删掉任务；按 id 合并会留下已经被删掉的幽灵任务）；
//     · updated   —— **按 id 合并**（只覆盖它带来的那一条，其余不动）。
//
// ⚠️ `task.updated` 里的 task 可能比先前少字段
// -----------------------------------------
//   实测样例里 `task.updated` 的 metadata 只有 `claim` / `blocked_by` /
//   `blocked` / `skill_key` / `capabilities`，而 `result_summary` 是到
//   COMPLETED 那一帧才出现的。所以合并时**空值不覆盖旧值**：一个字段这帧没有、
//   上帧有，就保留上帧的（不然任务标题会在中途"消失"）。
//
// ⚠️ 子代理族只加两样东西，**不改任务那套判据**
// ---------------------------------------
//   · 一份**活跃 worker 名册**（`PlanView.workers`）；
//   · 它们顺手带来的 task 快照（claimed / task.updated / completed 都带）
//     照样走上面那条 `mergeTask` —— 这样"任务面板"和"子代理面板"永远是
//     同一份 tasks，不会出现两个面板各说一个状态。
//
//   在它们上线之前，"有哪几个子代理"只能从 `claim.owner` 反推（见 planAgents
//   那段注释）。现在名册是**后端说的**，claim 反推退成兜底（老后端 / 丢帧）。
//
// ⚠️ 认不出的状态不要"猜成完成"
// ---------------------------------
//   `TASK_STATE_*` 是 A2A 的 TaskState 词表，后端将来会加新值（auth-required
//   之类）。认不出就归 `unknown` 并按"还没结束"对待 —— 把未知状态当完成会让
//   进度条提前走满、任务列表显示成"全都做完了"，那是最坏的一种撒谎。

import { oneLine } from './taskTimeline';

/**
 * 后端事件名（`app/common/event/event.py` 那一族）。
 *
 * ⚠️ 与 `RUN_EVENT`（agentRuntime.ts）分开写：那是一份"运行生命周期"的词表，
 *   这是"任务编排"的词表，两者会各自长。
 */
export const PLAN_EVENT = {
  PUBLISHED: 'plan.published',
  TASK_UPDATED: 'task.updated',
  CLEARED: 'plan.cleared',
} as const;

/**
 * 子代理那一族（2026-10-23 后端上线）。
 *
 * 四条事件共用 `topic: agent_run` / `node: subagent_dispatch`，`data` 里都有
 * `plan_id` / `revision` / `worker_id` / `task_id` —— 差别只在多带什么：
 *
 *   created      + worker_index / task_count / pending_count / context_id
 *                （**没有 task**：这一刻还没认领，任务板上的 owner 还是空的）
 *   claimed      + current_task_id / task（claim 之后的 A2A 快照，带 claim.attempt）
 *   task.updated + previous_state / current_task_id(null) / task（终态快照 + artifacts）
 *   completed    + status / task（同上，紧接 task.updated 的一条确认）
 *
 * ⚠️ 顺序（后端保证，前端不要假设别的排法）
 * -----------------------------------
 *   派发一波：worker0 created → claimed；worker1 created → claimed
 *             （worker 之间可能交错，同一个 worker 内部 created 先于 claimed）
 *   波次结束：t1 task.updated → completed；t2 task.updated → completed
 *   还有 ready task 就再来一波，没有就 dispatch 回 task_listener、父 run 收尾。
 *
 * ⚠️ `subagent.task.updated` **不是**实时推送
 * -------------------------------------
 *   它是 worker 波次 join、dispatch 重读任务板时补发的 —— 也就是说执行期间
 *   任务行**不会**跟着变，要到这一波结束才一次性落定。所以「任务」那半边在
 *   并行期间显示的"执行中"是完全正常的，别把它当卡住。
 */
export const SUBAGENT_EVENT = {
  CREATED: 'subagent.created',
  CLAIMED: 'subagent.claimed',
  TASK_UPDATED: 'subagent.task.updated',
  COMPLETED: 'subagent.completed',
} as const;

const PLAN_EVENT_NAMES: readonly string[] = [
  ...Object.values(PLAN_EVENT),
  ...Object.values(SUBAGENT_EVENT),
];

/**
 * 这一帧是不是「任务编排」事件（翻译器据此改道，见 runEventStream 的 push）。
 *
 * ⚠️ 子代理那四条也算：它们和计划三条走**同一条** CUSTOM 通道、进**同一个**
 *   reducer。分成两条通道会让"任务行"和"子代理行"各拿一份快照，两边的状态
 *   迟早对不上（一边说完成、一边说在跑）。
 */
export function isPlanEvent(name: string): boolean {
  return PLAN_EVENT_NAMES.includes(name);
}

/** 这四帧里，哪几帧属于"子代理族"（归约时走 worker 那条分支）。 */
export function isSubAgentEvent(name: string): boolean {
  return (Object.values(SUBAGENT_EVENT) as readonly string[]).includes(name);
}

/**
 * 这一帧是在说「某个任务**收了尾**」。
 *
 * ⚠️ 只给翻译器用来决定"要不要收掉 liveTask"（见 runEventStream 的 planActivity）：
 *   task.updated 与 completed 都带终态快照，`current_task_id` 已经不再是它。
 *   claimed 是**开跑**，正好相反。
 */
export function isSubAgentTerminalEvent(name: string): boolean {
  return (
    name === SUBAGENT_EVENT.TASK_UPDATED || name === SUBAGENT_EVENT.COMPLETED
  );
}

/**
 * 收摊动画的时长（毫秒）。
 *
 * ⚠️ **一个数，两处用**：`usePlanFeed` 到点把快照真正移除、`style.ts` 的
 *   `planDock` 用它做 max-height / opacity 的过渡。两边必须一致 ——
 *   改短了会"动画还没播完就消失"，改长了会"淡出之后原地停一会儿才没"。
 */
export const PLAN_RETIRE_MS = 260;

/**
 * 入场（"从底部附上来"）的时长（毫秒）。
 *
 * ⚠️ 只给 CSS 用（见 style.ts 的 planDock[data-plan-rise]）：
 *   入场**不需要** JS 定时器 —— 它是纯过渡，结束就结束。
 *   和退场的 260 分开是故意的：两件事的观感不同，
 *   出场要"慢一点才看得出是收摊"，入场太快会像闪了一下。
 */
export const PLAN_RISE_MS = 220;

/** 一条任务的展示态。`unknown` 是"后端给了个我不认识的值"，不是"没状态"。 */
export type TaskPhase =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'unknown';

/**
 * 后端 `status.state` → 展示态。
 *
 * 前缀 `TASK_STATE_` 是 proto 风格枚举名的习惯，剥掉再小写比较；
 * 顺带认几个不带前缀的写法（`queued` / `in_progress`）—— 后端换词表时
 * 这些别名不会让它掉进 `unknown`。
 */
export function taskPhase(state: string): TaskPhase {
  switch (state.replace(/^TASK_STATE_/i, '').toLowerCase()) {
    case 'submitted':
    case 'queued':
    case 'input_required':
    case 'input-required':
      return 'pending';
    case 'working':
    case 'in_progress':
    case 'running':
      return 'running';
    case 'completed':
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'unknown';
  }
}

/** 展示态的中文。放在这里而不是组件里：状态栏与任务行要同一套词。 */
export const PHASE_LABEL: Record<TaskPhase, string> = {
  pending: '排队中',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  unknown: '状态未知',
};

/** 一个任务在界面上需要的全部信息。 */
export interface PlanTaskView {
  id: string;
  /** 人话标题：任务指令里的 `description`（见 taskTitle）。 */
  title: string;
  /** 后端原值（`TASK_STATE_WORKING` 这种）。留着给 title 属性 / 排查用。 */
  state: string;
  phase: TaskPhase;
  /** `status.timestamp` —— 这一条状态是什么时候的。 */
  at: string | null;
  /**
   * 认领者（`claim.owner`，形如 `run-7c9e6679:main`）。
   * 空串 = 还没被任何执行者认领。
   */
  owner: string;
  /** `metadata.skill_key` —— 用的是哪个技能。 */
  skillKey: string | null;
  /** `metadata.result_summary`（完成时才出现）。 */
  resultSummary: string | null;
  /** `metadata.blocked_by` —— 它还等着哪些任务。 */
  blockedBy: string[];
}

/**
 * 一个**子代理 worker**（来自 `subagent.*` 四条事件）。
 *
 * ⚠️ 它是"人"而不是"事"：同一个 worker 会先 created（刚派出）、再 claimed
 *   （认下任务）、最后 completed（任务终态）。所以这份名册按 `worker_id`
 *   **原地更新**，不是每次追加一条 —— 否则一波 5 个任务答完，子代理栏会变成
 *   "15 个子代理"。
 *
 * ⚠️ 新一波会复用同一批 `worker_id`（`run-xxx:worker:0` …）
 * ---------------------------------------------------
 *   所以 upsert 是**正确的**：新一波的 created 会把上一条重置回"已派出"，
 *   计数换成这一波的。名册长度永远是"并行度"而不是"派过多少次"。
 */
export interface PlanWorkerView {
  /** `worker_id` 原值（`run-7c9e6679:worker:0`）。和 `claim.owner` 是同一个值。 */
  id: string;
  /** `worker_index` —— 这一波里第几个。读不到时 0。 */
  index: number;
  /** 走到哪一段了（`pending` = 已派出还没认领）。 */
  phase: TaskPhase;
  /** 手上（或最后手上）那个任务的 id。读不到时空串。 */
  taskId: string;
  /**
   * `subagent.created` 给的这一波任务总数 / 还排队的数。
   * ⚠️ `null` = 这一帧没带（只有 created 带），**不是 0** ——
   *    用 0 冒充"不知道"会让界面上写"还有 0 个待派"。
   */
  taskCount: number | null;
  pendingCount: number | null;
  /** `task.metadata.claim.attempt` —— 第几次尝试（>1 = 重试过）。0 = 没给。 */
  attempt: number;
}

/** 一次计划的快照。`null` = 现在没有计划（或已经 cleared）。 */
export interface PlanView {
  /** 后端 run_id（事件的 `topic_id`）。换了一轮运行，旧计划必须作废。 */
  runId: string;
  planId: string;
  goal: string;
  revision: number;
  tasks: PlanTaskView[];
  /**
   * 已派出的子代理名册（`subagent.*`）。空数组 = 还没有这族事件
   * （老后端 / 这一波还是主代理自己干）。
   *
   * ⚠️ 与 `tasks[].owner` 是**两份**信息，都要：名册说"派了几个 worker"，
   *   owner 说"这条任务是谁在干"。丢了名册，created 之后、claimed 之前的
   *   那一个就完全没有踪影（任务板上还没有 owner）。
   */
  workers: PlanWorkerView[];
  /** 后端说"现在正在跑哪一个"；`null` = 此刻没有在跑的任务。 */
  currentTaskId: string | null;
  /**
   * 后端已经发过 `plan.cleared` —— 这次计划收摊了。
   *
   * ⚠️ 「收摊」≠「消失」（2026-10-22 用户：「任务结束自动消失，不要消失，
   *    等待下一次任务发起，做个动画折叠起来」）。
   *    所以这个字段只用来做**表现**：dock 留在原地、面板自动折叠、图标换成
   *    完成/失败态，等下一条 `plan.published` 把它整体替换掉。
   *    归约**不再**在 cleared 时返回 null —— 那是之前"整个消失"的根源。
   */
  finished: boolean;
  /** `plan.cleared` 的 reason（通常是 `completed`）。排查用，界面不直接显示。 */
  finishReason: string;
  /**
   * 正在**退场**：下一轮运行已经开始了，这条 dock 该带着动画沉下去。
   *
   * ⚠️ 为什么这是一个状态、而不是直接 `setPlan(null)`
   * --------------------------------------------
   *   直接置空 = 元素从 DOM 里瞬间消失，没有任何过渡（用户 2026-10-22：
   *   「第二次订阅新的 run 做一个动画效果隐藏」）。
   *   所以先标 `retiring` 让 CSS 播完折叠 + 淡出，再由 `usePlanFeed`
   *   到 `PLAN_RETIRE_MS` 之后把快照真正清掉。
   *   期间如果来了新计划（`plan.published`），新快照会把 `retiring` 冲掉，
   *   动画自然中断 → dock 直接换成新内容，不会先沉下去再弹回来。
   */
  retiring: boolean;
}

/** 翻译器塞进 CUSTOM 事件的载荷（见 runEventStream 的 planActivity）。 */
export interface PlanEventPayload {
  runId: string;
  event: string;
  data: Record<string, unknown>;
}

// ============================================================
// 解析
// ============================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 任务标题从哪来：`history[0]` 那条 `ROLE_USER` 指令的
 * `parts[*].data.description`，退到 `parts[*].text`。
 *
 * ⚠️ 为什么不用 `task_id` / `skill_key` 顶替
 * -------------------------------------
 *   它们是机器名（`financial_research` / `...:t1`），而状态栏是给人看的：
 *   "获取并整理 A 公司本季度财报"才是用户认得出自己刚才要的那件事。
 *   两者都读不到时留空串，由组件决定降级文案（不要在这一层编一个）。
 *
 * ⚠️ 必须压成一行（2026-10-22「刷新前后不一致」）
 * ------------------------------------------
 *   `description` 常常是多行文本。同一个字符串在刷新之后是从
 *   `task_instruction` 正文里抠出来的（taskTimeline.taskDescriptionOf），
 *   那边必然压平 —— 这里不压，两边就差一个换行，视觉效果一样但"相等"
 *   不再成立，时间线的节点标题也就没法用一个用例钉住。
 *   压平规则只有一份实现：taskTimeline.oneLine。
 */
export function taskTitle(task: Record<string, unknown>): string {
  const history = Array.isArray(task.history) ? task.history : [];
  for (const raw of history) {
    const message = asRecord(raw);
    if (!message) continue;
    if (str(message.role) !== 'ROLE_USER') continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part) continue;
      const data = asRecord(part.data);
      const description = oneLine(str(data?.description));
      if (description !== '') return description;
      const text = oneLine(str(part.text));
      if (text !== '') return text;
    }
  }
  return '';
}

/** 一条后端 task → 展示用的 PlanTaskView。字段缺失一律给空值，不抛。 */
export function parsePlanTask(raw: unknown): PlanTaskView | null {
  const task = asRecord(raw);
  if (!task) return null;
  const id = str(task.id);
  // 没有 id 就没法合并、没法标"当前"，留着只会在列表里变成一个哑巴条目。
  if (id === '') return null;

  const status = asRecord(task.status);
  const state = str(status?.state);
  const metadata = asRecord(task.metadata);
  const claim = asRecord(metadata?.claim);

  return {
    id,
    title: taskTitle(task),
    state,
    phase: taskPhase(state),
    at: str(status?.timestamp) || null,
    owner: str(claim?.owner),
    skillKey: str(metadata?.skill_key) || null,
    resultSummary: str(metadata?.result_summary) || null,
    blockedBy: strList(metadata?.blocked_by),
  };
}

// ============================================================
// 解析：子代理
// ============================================================

/** 读一个数字；**读不到是 `null`**，不是 0 —— 要区分"后端说 0"和"这帧没带"。 */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 一条 `subagent.*` 事件的 `data` → 名册条目。字段缺失一律给空值，不抛。
 *
 * ⚠️ 状态怎么取（三条来源，按可信度）
 * ------------------------------
 *   ① `subagent.completed` 的 `data.status`（字符串，`TASK_STATE_COMPLETED`）；
 *   ② `data.task.status.state`（三条带 task 的事件都有它）；
 *   ③ 都没有 —— `created` 归 `pending`（"已派出、还没认领"），
 *      其余归 `running`（认领了但状态没写全，按在跑处理才对得起"它刚被派出去"）。
 */
export function parseWorker(
  event: string,
  data: Record<string, unknown>,
): PlanWorkerView | null {
  const id = str(data.worker_id);
  // 没有 worker_id 就无法与 claim.owner 对齐、也没法原地更新 —— 丢掉，
  // 别在列表里留一个每帧都新增一条的哑巴条目。
  if (id === '') return null;

  const task = asRecord(data.task);
  const status = asRecord(task?.status);
  const metadata = asRecord(task?.metadata);
  const claim = asRecord(metadata?.claim);

  const state = str(data.status) || str(status?.state);
  const phase: TaskPhase =
    state !== ''
      ? taskPhase(state)
      : event === SUBAGENT_EVENT.CREATED
        ? 'pending'
        : 'running';

  return {
    id,
    index: num(data.worker_index),
    phase,
    taskId: str(data.task_id) || str(task?.id),
    taskCount: numOrNull(data.task_count),
    pendingCount: numOrNull(data.pending_count),
    attempt: num(claim?.attempt),
  };
}

/**
 * 合并一个 worker。**按 `worker_id` 原地更新**（理由见 PlanWorkerView）。
 *
 * 与任务一样"空值不覆盖"：`task_count` / `pending_count` 只有 created 带，
 * 后续帧的 null 不该把它们抹掉。
 */
function mergeWorker(
  prev: PlanWorkerView | undefined,
  next: PlanWorkerView,
): PlanWorkerView {
  if (!prev) return next;
  return {
    id: next.id,
    // index 只在 created 里给；后续帧缺省（0）时保留上一次的。
    index: next.index || prev.index,
    phase: next.phase,
    taskId: next.taskId || prev.taskId,
    taskCount: next.taskCount ?? prev.taskCount,
    pendingCount: next.pendingCount ?? prev.pendingCount,
    attempt: next.attempt || prev.attempt,
  };
}

/** 两条名册记录是不是完全一样（用来避免续租帧造新数组）。 */
function sameWorker(a: PlanWorkerView, b: PlanWorkerView): boolean {
  return (
    a.id === b.id &&
    a.index === b.index &&
    a.phase === b.phase &&
    a.taskId === b.taskId &&
    a.taskCount === b.taskCount &&
    a.pendingCount === b.pendingCount &&
    a.attempt === b.attempt
  );
}

/** 名册 upsert（按 id 原地更新，不在末尾追加）。 */
function upsertWorker(
  workers: PlanWorkerView[],
  next: PlanWorkerView,
): PlanWorkerView[] {
  const at = workers.findIndex((worker) => worker.id === next.id);
  if (at === -1) return [...workers, next];
  const merged = mergeWorker(workers[at], next);
  // 什么都没变就不造新数组（续租/重发帧不该让 React 白渲染一次）
  if (sameWorker(merged, workers[at])) return workers;
  return workers.map((worker, index) => (index === at ? merged : worker));
}

// ============================================================
// 归约
// ============================================================

/**
 * 合并一条 task：新值**只覆盖有值的那几项**。
 *
 * 为什么不是 `{ ...prev, ...next }`
 * ------------------------------
 *   `task.updated` 的中途帧会少带字段（见文件头），直接展开会让标题 / 技能
 *   这类"只在第一帧出现过"的信息中途被空串抹掉 —— 任务行当场变成一行空白。
 */
function mergeTask(prev: PlanTaskView | undefined, next: PlanTaskView) {
  if (!prev) return next;
  return {
    id: next.id,
    title: next.title || prev.title,
    state: next.state || prev.state,
    phase: next.state === '' ? prev.phase : next.phase,
    at: next.at ?? prev.at,
    owner: next.owner || prev.owner,
    skillKey: next.skillKey ?? prev.skillKey,
    resultSummary: next.resultSummary ?? prev.resultSummary,
    blockedBy: next.blockedBy.length > 0 ? next.blockedBy : prev.blockedBy,
  };
}

/**
 * 把一条任务并进列表（按 id 合并；没有就追加）。
 *
 * ⚠️ 没变就返回**同一个数组引用** —— 上层靠它判"这一帧要不要重渲染"。
 *   并行波次里 claimed / task.updated / completed 三帧说的常常是同一份快照。
 */
function mergeTaskInto(
  tasks: PlanTaskView[],
  next: PlanTaskView,
): PlanTaskView[] {
  const at = tasks.findIndex((task) => task.id === next.id);
  if (at === -1) return [...tasks, next];
  const merged = mergeTask(tasks[at], next);
  if (JSON.stringify(merged) === JSON.stringify(tasks[at])) return tasks;
  return tasks.map((task, index) => (index === at ? merged : task));
}

/**
 * 把一帧计划事件并入快照。
 *
 * 返回 `null` = 现在不该显示任何任务栏（`plan.cleared`，或事件根本读不出来）。
 * 返回**同一个引用** = 什么都没变（避免 React 白重渲染）。
 */
export function reducePlan(
  prev: PlanView | null,
  payload: PlanEventPayload,
): PlanView | null {
  const data = asRecord(payload.data);
  if (!data) return prev;

  const planId = str(data.plan_id);
  const revision = num(data.revision);

  // ⚠️ 换了一轮运行（runId 变了）就当上一份计划从没存在过 ——
  //   `plan.cleared` 丢一帧（后端重启 / 流被掐断）时全靠这条兜底，
  //   否则上一轮的任务列表会一直挂在输入框上面。
  //   ⚠️ 但**已经 finished 的计划不在此列**：它本来就该留着（见 PlanView.finished）。
  const stale =
    prev !== null && payload.runId !== '' && prev.runId !== payload.runId;
  const base = stale ? null : prev;

  if (payload.event === PLAN_EVENT.CLEARED) {
    /*
     * ⚠️ **不返回 null**（2026-10-22 用户改的口径）
     * ---------------------------------------
     *   原先这里 `return null`，dock 会在最后一个任务完成的瞬间整个消失 ——
     *   用户看到的是"进度条跑满就没了"，连"到底成功没成功"都得靠回忆。
     *   现在改成**标 finished**：dock 留在输入框上方、面板自动折叠、
     *   图标变成勾/叉，一直到下一条 `plan.published` 把它整体替换。
     *
     *   手里这份不是这条 cleared 对应的计划（stale）→ 一律不动：
     *   标错了会让上一轮的旧计划停在"进行中"，比不显示更糟。
     */
    if (!prev || stale || prev.finished) return prev;
    return {
      ...prev,
      finished: true,
      finishReason: str(data.reason),
      // 收摊就是没有"当前任务"了，高亮跟着撤掉。
      currentTaskId: null,
    };
  }

  if (payload.event === PLAN_EVENT.PUBLISHED) {
    const tasks = (Array.isArray(data.tasks) ? data.tasks : [])
      .map(parsePlanTask)
      .filter((task): task is PlanTaskView => task !== null);

    /*
     * 名册：**同一份计划才带过来**。
     * ⚠️ 换了 plan_id 就是另一份计划，上一份的 worker 一个都不算
     *   （它们的 `run-xxx:worker:N` 在新计划里会重新分配）。
     */
    const samePlan = base !== null && (planId === '' || planId === base.planId);

    return {
      runId: payload.runId || base?.runId || '',
      planId: planId || base?.planId || '',
      goal: str(data.goal) || base?.goal || '',
      revision,
      // 整体替换：published 是"权威内容"，按 id 合并会把已删掉的任务留下来。
      tasks,
      workers: samePlan ? (base?.workers ?? []) : [],
      currentTaskId: str(data.current_task_id) || null,
      // 新一轮计划 = 重新开始跑，把"收摊"的标记清掉。
      finished: false,
      finishReason: '',
      // 新内容进来就把退场动画打断（dock 原地换成新任务，不要再沉一次）
      retiring: false,
    };
  }

  if (payload.event === PLAN_EVENT.TASK_UPDATED) {
    const next = parsePlanTask(data.task);
    if (!next) return prev;

    const tasks = base?.tasks ?? [];
    const merged = mergeTaskInto(tasks, next);
    const at = tasks.findIndex((task) => task.id === next.id);

    // 只有这一条、且什么字段都没变时不必造新对象（`claim` 的续租会按秒推）。
    const same =
      at !== -1 &&
      JSON.stringify(merged[at]) === JSON.stringify(tasks[at]) &&
      base?.currentTaskId === (str(data.current_task_id) || null);
    if (same) return prev;

    return {
      runId: payload.runId || base?.runId || '',
      planId: planId || base?.planId || '',
      goal: base?.goal ?? '',
      revision: revision || base?.revision || 0,
      tasks: merged,
      workers: base?.workers ?? [],
      currentTaskId: str(data.current_task_id) || null,
      // 收摊之后再来的迟到帧不改这个标记（finished 是个单向门）。
      finished: base?.finished ?? false,
      finishReason: base?.finishReason ?? '',
      // 同上：退场途中来的内容帧不把动画往回拉。
      retiring: base?.retiring ?? false,
    };
  }

  if (isSubAgentEvent(payload.event)) {
    /*
     * 子代理族的四条：**一份 task 快照 + 一条名册更新**。
     *
     * ⚠️ 顺手把 task 并进 tasks（而不是只记名册）
     * -------------------------------------
     *   `subagent.claimed` / `task.updated` / `completed` 带的都是 A2A 的
     *   **canonical task 快照**（含 claim / artifacts / result_summary）。
     *   只更新名册的话，「任务」那半边就只能等 task_listener 的 `task.updated`
     *   —— 而它在并行波次里是**事后补发**的，于是执行期间任务行会一直停在
     *   "排队中"，两个面板各说一套。并进来之后两边永远是同一份 tasks。
     *
     * ⚠️ created **没有** task：这一刻还没认领，载荷里只有 task_id。
     *   所以它只动名册（那一行先显示"已派出"，任务标题靠 task_id 去 tasks 里查）。
     */
    const worker = parseWorker(payload.event, data);
    const nextTask = parsePlanTask(data.task);

    const prevWorkers = base?.workers ?? [];
    const prevTasks = base?.tasks ?? [];
    const workers = worker ? upsertWorker(prevWorkers, worker) : prevWorkers;
    const tasks = nextTask ? mergeTaskInto(prevTasks, nextTask) : prevTasks;

    /*
     * currentTaskId：**只有认领时往前提，收尾时按 id 撤回**。
     *
     * ⚠️ 不能像 task.updated 那样无条件照抄
     * --------------------------------
     *   并行波次里 `subagent.task.updated` / `completed` 的 `current_task_id`
     *   恒为 null。照抄的话，第一个 worker 交差就会把"当前任务"整个清掉，
     *   而另一个 worker 明明还在跑。
     *   所以：收尾只在**它正好是当前这个**时撤回，别人的完成不影响。
     */
    const taskId = worker?.taskId ?? str(data.task_id);
    let currentTaskId = base?.currentTaskId ?? null;
    if (payload.event === SUBAGENT_EVENT.CLAIMED) {
      currentTaskId = str(data.current_task_id) || taskId || currentTaskId;
    } else if (isSubAgentTerminalEvent(payload.event)) {
      if (currentTaskId === taskId) currentTaskId = null;
    }

    // 什么都没变（名册与任务都是同一批引用、当前任务也没动）就别造新快照。
    const unchanged =
      base !== null &&
      workers === prevWorkers &&
      tasks === prevTasks &&
      currentTaskId === base.currentTaskId;
    if (unchanged) return prev;

    return {
      runId: payload.runId || base?.runId || '',
      planId: planId || base?.planId || '',
      goal: base?.goal ?? '',
      revision: revision || base?.revision || 0,
      tasks,
      workers,
      currentTaskId,
      finished: base?.finished ?? false,
      finishReason: base?.finishReason ?? '',
      retiring: base?.retiring ?? false,
    };
  }

  return prev;
}

// ============================================================
// 派生：给状态栏用
// ============================================================

export interface PlanCounts {
  total: number;
  done: number;
  running: number;
  pending: number;
  failed: number;
}

export function planCounts(plan: PlanView): PlanCounts {
  const counts: PlanCounts = {
    total: plan.tasks.length,
    done: 0,
    running: 0,
    pending: 0,
    failed: 0,
  };
  for (const task of plan.tasks) {
    if (task.phase === 'done') counts.done += 1;
    else if (task.phase === 'running') counts.running += 1;
    else if (task.phase === 'pending' || task.phase === 'unknown') {
      counts.pending += 1;
    } else counts.failed += 1;
  }
  return counts;
}

/**
 * 此刻正在跑的那个任务。
 *
 * 优先信后端的 `current_task_id`；它为空（比如刚完成、还没认领下一个）时
 * 退到"第一条 working" —— 后端不再重发 plan.published 的情况下，
 * `current_task_id` 只在 task.updated 里出现，个别帧会缺。
 */
export function currentTask(plan: PlanView): PlanTaskView | null {
  if (plan.currentTaskId) {
    const hit = plan.tasks.find((task) => task.id === plan.currentTaskId);
    if (hit) return hit;
  }
  return plan.tasks.find((task) => task.phase === 'running') ?? null;
}

// ============================================================
// 派生：这一刻在跑的是哪个任务（给实时时间线用）
// ============================================================

/** 实时时间线要的那一件事：此刻在跑的任务是谁。 */
export interface PlanCurrentTask {
  taskId: string;
  /** 人话任务名（读不到就是空串）。 */
  title: string;
  planId: string;
}

/**
 * 一帧计划事件之后，"此刻在跑的任务"变成了谁。`null` = 没有任务在跑。
 *
 * 谁在用：翻译器（`runEventStream`）在开一条消息的**那一刻**问一次，把
 * 结果记进 liveTaskFeed —— 于是"任务运行期间产出的消息"都归到了这个任务
 * 名下，与后端把 `task_result` 打进那个 task_id 是同一个语义。
 *
 * ⚠️ 为什么用 `current_task_id` 而不是"tasks 里第一条 working"
 * --------------------------------------------------------
 *   后者会在**并行子代理**（后端还没实现，用户说后续会有）时选错人：
 *   那时同时在跑的有好几个，只有 current_task_id 能说明"这一帧说的是谁"。
 *   两者都读不到时才退回 working（个别帧确实会缺 current_task_id）。
 *   读不到具体任务本体（比如这帧只带了一个别的任务的更新）时，宁可只留 id
 *   也不猜标题 —— 标题空了时间线上就只写"任务 N"。
 *
 * ⚠️ 终态一律返回 null
 * -------------------
 *   任务完成那一帧的 `current_task_id` 常常还指着它自己。照抄这个 id 会让
 *   **收尾之后的主对话回答**（"刚才的邮件改写任务已经完成了…"）也被吸进
 *   最后一个任务的轨道 —— 那正是用户截图里读到"任务结束后还有东西挂在
 *   节点下面"的成因。
 */
export function currentPlanTask(
  event: string,
  data: Record<string, unknown>,
): PlanCurrentTask | null {
  if (event === PLAN_EVENT.CLEARED) return null;

  const planId = str(data.plan_id);
  const currentId = str(data.current_task_id);

  const pool =
    event === PLAN_EVENT.PUBLISHED
      ? Array.isArray(data.tasks)
        ? data.tasks
        : []
      : [data.task];

  const tasks = pool
    .map(parsePlanTask)
    .filter((task): task is PlanTaskView => task !== null);

  const picked = currentId
    ? (tasks.find((task) => task.id === currentId) ?? null)
    : (tasks.find((task) => task.phase === 'running') ?? null);

  if (!picked) {
    // 任务本体读不到，但后端说了现在是谁 —— 只留 id（标题空）。
    return currentId === '' ? null : { taskId: currentId, title: '', planId };
  }

  if (
    picked.phase === 'done' ||
    picked.phase === 'failed' ||
    picked.phase === 'canceled'
  ) {
    return null;
  }

  return { taskId: picked.id, title: picked.title, planId };
}

/** 一个执行者（主代理 / 某个子代理）以及它手上的任务。 */
export interface PlanAgentView {
  /** `claim.owner` 原值。 */
  id: string;
  /** 冒号后半段（`main` / `worker:0`），认不出就原样。 */
  name: string;
  /** 它认领的任务，执行中的排前面。 */
  tasks: PlanTaskView[];
  /** 手上还有没有在跑的任务。 */
  running: boolean;
  /**
   * 名册里对应的那条 worker（`subagent.*` 才有）。
   * ⚠️ `undefined` = 这个执行者是从 `claim.owner` 反推出来的（老后端 / 名册丢帧），
   *    界面要能忍受这一点 —— 没有它就没有"第几次尝试"、也没有"已派出"这个相位。
   */
  worker?: PlanWorkerView;
}

/** 主代理的 owner 尾巴。后端用 `:main` 标记"这一轮的总控"。 */
const MAIN_AGENT = 'main';
/** 子代理 owner 里的那一段标记（`run-xxx:worker:0`）。 */
const WORKER_SEGMENT = 'worker';

/**
 * `run-xxx:main` → `main`；`run-xxx:worker:0` → `worker:0`。
 *
 * ⚠️ 为什么子代理要留**两段**
 * ---------------------
 *   子代理的 owner 比主代理多一段（`worker` + 序号）。只取最后一段会得到 "0"
 *   —— 任务行和子代理行里一个人名都没有，只剩一个数字。
 *   两段拼回去（`worker:0`）既短又和后端的 `worker_id` 对得上。
 * ⚠️ 只认**倒数第二段正好是 `worker`** 这一种形状，不做"取最后两段"那种通配：
 *   注释里早就写了 owner 前半段（run_id）里出现 `:` 并不奇怪，通配会把
 *   `run:a:b:main` 切成 `b:main`。
 */
export function agentName(owner: string): string {
  const parts = owner.split(':');
  if (parts.length === 1) return owner;
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  return parts.length >= 3 && prev === WORKER_SEGMENT
    ? `${prev}:${last}`
    : last;
}

/** 这时有没有"并行子代理"这个概念 —— 判据只有一条：owner 不是 `:main`。 */
export function isSubAgent(owner: string): boolean {
  return owner !== '' && agentName(owner) !== MAIN_AGENT;
}

/**
 * 子代理自己那一句话的状态。
 *
 * ⚠️ 为什么不直接用 `PHASE_LABEL`：`pending` 在任务上叫「排队中」（还没轮到它），
 *   在 worker 上却应该是「已派出」（已经派出去了、只是还没认领任务）。
 *   两个主语不一样，词就不该共用。
 */
export const WORKER_PHASE_LABEL: Record<TaskPhase, string> = {
  pending: '已派出',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  unknown: '状态未知',
};

/**
 * 子代理名册 → 执行者视图。
 *
 * 两个来源，**名册优先、claim 兜底**：
 *   · `plan.workers`（`subagent.*` 四条事件）—— 后端说的"派了哪个 worker"，
 *     created 之后、claimed 之前**只有这里**有它的踪影；
 *   · `tasks[].owner`（`claim.owner`）—— 老后端 / 名册丢帧时的兜底，
 *     也是"这条任务是谁在干"的唯一来源。
 *   两者的交集靠 `worker_id === claim.owner` 天然对齐（后端就是同一个值）。
 *
 * ⚠️ 2026-10-22 那段注释里预告过"将来只需要多记一份名册"—— 就是这里：
 *   分组的形状没变，只是多了一个来源。
 */
export function planAgents(plan: PlanView): PlanAgentView[] {
  const buckets = new Map<string, PlanTaskView[]>();
  const ensure = (id: string) => {
    const list = buckets.get(id);
    if (list) return list;
    const created: PlanTaskView[] = [];
    buckets.set(id, created);
    return created;
  };

  for (const task of plan.tasks) {
    if (task.owner === '') continue;
    ensure(task.owner).push(task);
  }

  /*
   * 名册里的 worker 也开一个桶 —— 哪怕它手上一条任务都没有
   * （created 之后、claimed 之前，任务的 owner 还是空的）。
   * 再把它的 `task_id` 对到 tasks 上挂进去：那一波的任务可能已经在
   * plan.published 里了，只是还没人认领。
   */
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const workers = new Map(plan.workers.map((worker) => [worker.id, worker]));
  for (const worker of plan.workers) {
    const list = ensure(worker.id);
    const task = worker.taskId === '' ? undefined : byId.get(worker.taskId);
    if (task && !list.some((item) => item.id === task.id)) list.push(task);
  }

  const agents: PlanAgentView[] = [];
  for (const [id, tasks] of buckets) {
    const ordered = [...tasks].sort((a, b) => {
      const rank = (task: PlanTaskView) =>
        task.phase === 'running' ? 0 : task.phase === 'pending' ? 1 : 2;
      return rank(a) - rank(b);
    });
    const worker = workers.get(id);
    agents.push({
      id,
      name: agentName(id),
      tasks: ordered,
      /*
       * "在跑"取**并集**：名册说它还活着（claimed）就够，任务说在跑也够。
       * 只信任务的话，claimed 之后、任务快照落地之前会有一帧显示"空闲"；
       * 只信名册的话，老后端（没有名册）会永远显示没在跑。
       */
      running:
        worker?.phase === 'running' ||
        ordered.some((task) => task.phase === 'running'),
      worker,
    });
  }

  // 主代理排最前：它是"总控"，子代理是它派出去的；子代理之间按 worker_index。
  return agents.sort((a, b) => {
    const rank = (agent: PlanAgentView) => {
      if (!isSubAgent(agent.id)) return 0;
      return 1;
    };
    const delta = rank(a) - rank(b);
    if (delta !== 0) return delta;
    return (a.worker?.index ?? 0) - (b.worker?.index ?? 0);
  });
}

/** 只在有并行子代理时才非空 —— 状态栏据此决定第二行写什么。 */
export function subAgents(plan: PlanView): PlanAgentView[] {
  return planAgents(plan).filter((agent) => isSubAgent(agent.id));
}

/**
 * 「任务」那条折叠态的一句话。
 *
 * 三种形状，按信息量排序：有在跑的就说在跑什么（用户最想知道的）；
 * 全跑完了说完成数；否则报进度。
 *
 * ⚠️ 有任务在跑时**只给标题、不带进度**
 * --------------------------------
 *   进度已经由栏尾那枚计数（`done/total`）说了。同一行里说两遍（"1/3 · 标题"
 *   再加尾巴上的 1/3）在窄面板里会把标题挤到只剩几个字 —— 第一版就是这么
 *   渲染出来的，实测截图里标题被截成"获取并整理 B 公司本季度财报"还勉强，
 *   任务名再长一点就什么都看不出来了。
 */
export function taskBarSummary(plan: PlanView): string {
  const counts = planCounts(plan);
  const running = currentTask(plan);

  if (running) return running.title || '正在执行任务';
  if (counts.total === 0) return '等待计划下发';
  if (counts.done + counts.failed >= counts.total) {
    return counts.failed > 0
      ? `已结束 · ${counts.done}/${counts.total} 完成，${counts.failed} 失败`
      : `已全部完成 · ${counts.total} 个任务`;
  }
  return `${counts.done}/${counts.total} 已完成 · 等待下一步`;
}

/**
 * 「子代理」那一栏图标该上什么色（一个值概括这一群）。
 *
 * ⚠️ 顺序不能换：在跑 > 有失败 > 全完成 > 其余。
 *   "有失败"要压过"全完成"，否则一个失败的 worker 会被一次「都完成了」的绿
 *   盖掉 —— 与任务栏那条判据同一个理由。
 * ⚠️ 一个都没有 → `canceled`（灰色）。这是"这一轮没有第二个执行者"，
 *   不是"失败了"，所以别用 failed。
 */
export function subAgentPhase(plan: PlanView): TaskPhase {
  const agents = subAgents(plan);
  if (agents.length === 0) return 'canceled';
  if (agents.some((agent) => agent.running)) return 'running';

  const phases = agents.map(
    (agent) =>
      agent.worker?.phase ??
      agent.tasks.find((task) => task.phase !== 'done')?.phase ??
      'done',
  );
  if (phases.some((phase) => phase === 'failed')) return 'failed';
  if (phases.every((phase) => phase === 'done')) return 'done';
  return 'pending';
}

/** 「子代理」那条折叠态的一句话。 */
export function subAgentBarSummary(plan: PlanView): string {
  const agents = subAgents(plan);
  if (agents.length === 0) return '暂无并行子代理';
  const running = agents.filter((agent) => agent.running);
  if (running.length === 0) {
    // 全都收工了就说"都完成了"，比笼统的"空闲"更能回答"到底跑完没有"。
    const phase = subAgentPhase(plan);
    return phase === 'done'
      ? `${agents.length} 个子代理 · 已全部完成`
      : `${agents.length} 个子代理 · 空闲`;
  }
  return `${running.length} 个运行中`;
}
