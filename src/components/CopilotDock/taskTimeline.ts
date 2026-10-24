// src/components/CopilotDock/taskTimeline.ts
//
// 「哪条消息属于哪个任务」—— 对话区左侧那条纵向时间线的分组依据。
//
// 需求原话（2026-10-22）：
//   「识别后端的 message 类型。现在 main 节点的 task_instruction / task_result
//    也会回复。将他也生成在对话框中。但是 task 相关的内容左侧添加纵向 timeline，
//    灰色节点以 task 为单位」
//
// 两个通道，两种分组依据
// --------------------
//   · **历史**（刷新 / 切会话）：消息自带 `kind` + `metadata.task_id`
//     （后端 `message_recorder._meta` 写的 task_id / plan_id / skill_key）。
//     但**只有两条边界消息**带这些字段 —— `task_instruction`（子代理的任务
//     说明，HumanMessage）与 `task_result`（它的最终回答）。中间那些
//     工具调用 / 旁白是普通的 `tool_activity` / `chat`，没有 task_id。
//     所以要用"**作用域**"把它们收进来：一条 `task_instruction` 开一组，
//     到配对的 `task_result` 收尾，中间的一切都属于这一组。
//   · **实时**（SSE）：后端那份载荷里**没有** kind（见 liveTaskFeed 的文件头），
//     分组只能由翻译器边跑边记，这里按 messageId 查。
//
// 为什么作用域是"instruction → result"而不是别的
// ------------------------------------------
//   契约（messages.yaml）写的就是这两条成对出现：task_instruction 是任务的
//   输入，task_result 是它的产出。中间那些步属于这个任务，之后的消息不属于。
//   用 seq 顺序判就够了 —— 后端已经按 seq 升序返回（见 history.ts 文件头），
//   这里**不需要**时间戳，也不该用。
//
// ⚠️ 为什么不"按 task_id 分组"（把同 id 的分散消息归到一起）
// ------------------------------------------------------
//   时间线的语义是"**这一段对话**是这个任务的"，组必须是**连续**的一段；
//   按 id 归并会在界面上把消息搬离它们真实的时间位置。所以这里做的分组是
//   "相邻且同 id 的一段"，落成 first / last 两个标记。
//
// ⚠️ 缓存的键是**那个 messages 数组本身**
// ----------------------------------
//   CopilotKit 每加一条消息就换一个新数组（不可变更新），所以数组引用就是
//   "这批消息是哪一版"的天然版本号。一次渲染里每条消息都要问一次
//   "我在哪个组"（N 条消息 N 次调用），不缓存就是 O(n²)；缓存之后一次渲染
//   只算一遍。热路径（流式每帧都重渲染）靠的就是这一点。

import type { Message } from '@ag-ui/client';
import { liveTaskOf } from './liveTaskFeed';

/** 后端 `MessageKind` 里与任务有关的两条（见 enum.py 的 MessageKind）。 */
export const TASK_INSTRUCTION_KIND = 'task_instruction';
export const TASK_RESULT_KIND = 'task_result';

/** 一行在任务组里担任什么角色。 */
export type TaskRole =
  /** 任务说明（子代理收到的 HumanMessage）。开一组。 */
  | 'instruction'
  /** 任务产出（子代理的最终回答）。收一组。 */
  | 'result'
  /** 任务执行过程中的一步（工具调用 / 旁白 / 实时消息）。 */
  | 'step';

/** 一条消息在时间线上的位置。`null` = 这条消息不在任何任务组里（不画轨道）。 */
export interface TaskRow {
  taskId: string;
  planId: string;
  skillKey: string;
  /** 人话任务名。只有实时通道有（历史里没有可靠来源），没有就是空串。 */
  title: string;
  /**
   * **这份计划里的**第几个任务（1 起）。
   *
   * ⚠️ 按计划内位置，不按"界面上出现的顺序"（2026-10-22 第五轮）
   * ----------------------------------------------------------
   *   位置来自任务 id 的尾巴（`<planId>:t2` → 2，见 planIndexOf）。
   *   按出现顺序编是不行的：规划器会把"已经做完的那一步"也拆成一个任务，
   *   那种任务常常**一句话都不产出**（group 里整组丢掉），于是它后面的任务
   *   整体顶号 —— 实测 t2 被写成「任务 1」，而它的标题正文里明明白白写着
   *   "基于 t1 确定的目的与语气"，用户一眼就看出来了。
   *   0 = 读不出计划内序号（模型给了 `research` 这种 local id），渲染层不写数字。
   *
   * ⚠️ 「第 N 个」是**计划内**的，跨计划会重来
   * --------------------------------------
   *   一句对话里连发两条指令就是两份计划，各自的 t1 都是「任务 1」。
   *   这是有意的：输入框上方那条 dock 显示的也是"当前这份计划"，两处口径一致。
   *   要"整段对话连续编号"的话，历史消息里没有任何字段能支撑（见 planIndexOf）。
   *
   * ⚠️ 同一个任务重复出现（并行认领来回跳 / 重试）时**共用同一个序号** ——
   *   序号本来就是按任务算的，同 id 必然同号（见 group 的注释）。
   */
  ordinal: number;
  role: TaskRole;
  /** 组内第一行 —— **节点圆点**画在这里（"以 task 为单位"就靠它）。 */
  first: boolean;
  /** 这个任务的最后一行 —— 竖线到此为止，不再往下一段延伸。 */
  last: boolean;
}

/** 节点旁那句话（**整段**，给 `title` 悬停用；一行显示走 taskShortTitle）。 */
export function taskRowLabel(row: TaskRow): string {
  if (row.title) return row.title;
  if (row.role === 'instruction') return '任务指令';
  if (row.role === 'result') return '任务结果';
  return '';
}

/** 节点小标题最多取多长（字符）。超过就按标点回退。 */
const HEAD_MAX = 40;
/** 回退截断时允许的最短长度 —— 再短就硬切，别切出一个孤零零的"基于"。 */
const HEAD_MIN = 12;

/**
 * 一句话在哪里结束：句末标点 + 常见的小标题。
 *
 * ⚠️ 为什么要认"输入：/输出：/约束："这一族
 * --------------------------------------
 *   后端的 `description` 是**给子代理看的整段说明**，不是标题。实测长这样：
 *
 *     目标：基于 STEP-1 的目的与语气，确定该客户邮件的邮件主题（Subject）。
 *     输入：STEP-1 的结论。输出：…
 *
 *   取到第一个"。"就够了；但模型经常**不写句号**，直接接着"输入："往下写，
 *   那样第一句会一路吃到几百字 —— 所以在这些标记处也要断。
 */
const HEAD_STOPS: readonly string[] = [
  '。',
  '；',
  '！',
  '？',
  '输入：',
  '输出：',
  '约束：',
  '要求：',
  '验收：',
  '步骤：',
  '参数：',
];

/** 开头的字段名 —— 对读者没有信息量（"目标："本身不是一个标题）。 */
const HEAD_PREFIXES: readonly string[] = [
  '任务说明：',
  '任务：',
  '目标：',
  '描述：',
];

/**
 * 把整段 `description` 收成**一行小标题**（节点旁边那句）。
 *
 * 为什么需要它（2026-10-22 用户："task 描述里面有简易描述或者标题吗，不要显示全文"）
 * -------------------------------------------------------------------------
 *   后端**没有** per-task 的标题字段（`message` 只有 `description` + `params`，
 *   metadata 里是 skill_key / blocked_by / capabilities；整份计划才有个 `goal`）。
 *   所以节点标题只能拿 description 顶 —— 而它是整段说明，从前是把全文塞进一行
 *   再由 CSS 省略号切断，切出来是「目标：基于 STEP-1 的目的与语气，确定该客户
 *   邮件的邮件主题（Subject）。 输入：STE…」，读起来像一句被打断的废话。
 *
 *   这里做三步，全都只依赖文本本身（不猜、不编）：
 *     1. 去掉开头的字段名前缀（"目标："→ 去掉）；
 *     2. 取第一句（句末标点或"输入："这类小标题处断）；
 *     3. 还是太长，就回退到 40 字内最后一个能读得通的标点再补省略号。
 *
 * ⚠️ 不做"语义摘要"：那是模型才能干的事。真要一行像样的标题，得后端在
 *    planner 输出里带一个 `title`（见 overview 的待补字段）。
 * ⚠️ 全文仍然在 `title` 属性里（悬停可见），这里只是**显示**收短。
 */
export function taskShortTitle(title: string): string {
  let text = oneLine(title);

  for (const prefix of HEAD_PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  if (text === '') return '';

  let cut = -1;
  for (const stop of HEAD_STOPS) {
    const at = text.indexOf(stop);
    if (at >= 0 && (cut < 0 || at < cut)) cut = at;
  }
  if (cut >= 0) text = text.slice(0, cut).trim();
  if (text === '') return '';

  if (text.length <= HEAD_MAX) return text;

  // 太长：回退到 40 字内最后一个逗号 / 顿号 / 空格，别把词切一半。
  let boundary = -1;
  for (let at = 0; at < HEAD_MAX; at += 1) {
    const ch = text[at];
    if (ch === '，' || ch === '、' || ch === '；' || ch === ' ') boundary = at;
  }
  const end = boundary >= HEAD_MIN ? boundary : HEAD_MAX;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** 后端 metadata 里那份任务归属（history.ts 写进去的，见 HistoryMeta.task）。 */
export interface TaskMessageMeta {
  kind: typeof TASK_INSTRUCTION_KIND | typeof TASK_RESULT_KIND;
  taskId: string;
  planId: string;
  skillKey: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 一条 AG-UI 消息的正文（history.ts 已经把它压成字符串了）。 */
function textOf(message: Message): string {
  return typeof message.content === 'string' ? message.content : '';
}

/**
 * 这条消息是不是任务的两种之一（**不看有没有 task_id**）。
 *
 * 用途与 taskBoundaryOf 不同：那边问"能不能成组"，这里问"它是不是任务消息"。
 * 差别在**渲染层**：一条任务消息如果没能成组（详见 group() 里"只有任务说明、
 * 什么都没做"那一段），就该**一个节点都不画** —— 而它的 role 是 user，
 * 掉进普通分支会变成一个"我发的消息"气泡，把整段提示词糊到用户脸上。
 */
export function taskMessageOf(message: {
  metadata?: unknown;
}): TaskMessageMeta | null {
  const meta = asRecord(message.metadata);
  const task = asRecord(meta?.task);
  if (!task) return null;

  const kind = str(task.kind);
  if (kind !== TASK_INSTRUCTION_KIND && kind !== TASK_RESULT_KIND) return null;

  return {
    kind,
    taskId: str(task.taskId),
    planId: str(task.planId),
    skillKey: str(task.skillKey),
  };
}

/**
 * 这条消息是不是任务的两条边界之一（且**带得出 task_id**），是就取出它的归属。
 *
 * 判据是 `metadata.task.kind`（history.ts 写的），**不用** `metadata.kind`
 * 单独判 —— 因为分组还要 task_id，只有 kind 没有 id 时无法成组，
 * 到时候会退化成"一条消息一组"，那不如不画（渲染层据 taskMessageOf 直接跳过）。
 */
export function taskBoundaryOf(message: {
  metadata?: unknown;
}): TaskMessageMeta | null {
  const task = taskMessageOf(message);
  return task !== null && task.taskId !== '' ? task : null;
}

/** `render_task_instruction` 里那段人话说明的起始标记（后端同名字符串）。 */
const DESCRIPTION_MARK = '任务说明：';

/** 说明之后紧跟的两种段落标记 —— 遇到任何一个，说明就结束了。 */
const DESCRIPTION_ENDS: readonly string[] = ['任务参数：', '输出要求：'];

/**
 * 把一段可能多行的文本压成一行（连续空白 → 单个空格，两端 trim）。
 *
 * ⚠️ 为什么这件事必须**只有一个实现**
 * -------------------------------
 *   时间线节点标题「任务 3 · X」里的那个 X 有两个来源：实时读计划事件里的
 *   `description`（planTasks.taskTitle），刷新后从 `task_instruction` 正文里抠
 *   （taskDescriptionOf）。两边要落到**同一个字符串**，否则就是用户 2026-10-22
 *   报的"刷新前后不一致"。
 *   而 `description` 本身可能是多行 —— 不压平的话两边差一个换行，虽然 CSS
 *   会把换行折成空格、肉眼看不出来，但"相等"这件事就不再可测了。
 *   所以压平规则放在这里，两个来源都调它。
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 从 `task_instruction` 的正文里取出**那段人话任务说明**。
 *
 * ⚠️ 为什么要在前端从文本里抠（而不是读 metadata）
 * -------------------------------------------
 *   这段说明有一个**实时侧的同源孪生体**：计划事件里的
 *   `tasks[].history[0].parts[].data.description`（`planTasks.taskTitle` 读的
 *   就是它）。实时时间线的节点标题用它，历史时间线的节点标题用这段抠出来的
 *   文本 —— 两者**必须是同一个字符串**，否则"刷新前后不一致"（用户 2026-10-22
 *   截图报的就是这个：实时是 `任务 1 · 【STEP-2 确定主题】…`，刷新后变成
 *   `任务 1 · 任务指令` 加一整坨提示词）。
 *   后端落库时把 task_id / plan_id / skill_key 都放进了 metadata，**唯独没放
 *   description**（`message_recorder._meta` 只留那三个键）；而正文是
 *   `task_prompt.render_task_instruction` 拼出来的固定格式，"任务说明："
 *   后面到"任务参数：/输出要求："之前就是那段 description。
 *   将来后端肯把 description 放进 metadata，这里应当直接读它 —— 届时
 *   这个函数就是第一步要删的东西。
 *
 * 空白一律压成单个空格：实时侧那句 description 本来就可能是多行，而节点标题
 * 是一行文本（CSS 也会把换行折成空格），压平之后两边才真的可比。
 */
export function taskDescriptionOf(text: string): string {
  const lines = text.split('\n');

  const start = lines.findIndex((line) =>
    line.trim().startsWith(DESCRIPTION_MARK),
  );
  if (start === -1) return '';

  const head = lines[start].trim().slice(DESCRIPTION_MARK.length);
  const body: string[] = [head];

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (DESCRIPTION_ENDS.some((mark) => trimmed.startsWith(mark))) break;
    body.push(line);
  }

  return oneLine(body.join(' '));
}

/**
 * 任务 id 的尾巴：`<planId>:t2` → 2。**0 = 读不出**。
 *
 * ⚠️ 这是**目前唯一**在历史通道里也拿得到的"计划内位置"
 * --------------------------------------------------
 *   后端的任务 id 是 `f"{plan_id}:{local_id}"`（`app/agent/plan/a2a.py` 的
 *   `_task_id`），local_id 由 planner 模型写在 `tasks[].id` 上，契约只要求
 *   `^[A-Za-z0-9_-]{1,64}$`（`contracts._ID_RE`）—— 模型**习惯**上写 `t1..tN`
 *   （planner 提示词里的示例就是 `"id": "t1"`），实测数据也是，但没有被强制。
 *   所以这个函数是"读得出就用、读不出就退"的**兜底**，不是契约。
 *
 * ⚠️ 为什么不用 plan.published 的 tasks[] 顺序
 * ----------------------------------------
 *   那条事件只活在实时通道里（刷新之后没有），而序号的正确性恰恰是在刷新
 *   前后要**一致**。所以两侧只能用同一个来源 —— 就是 taskId 本身。
 *
 * ⚠️ 后端补字段之后这里应当改成读它
 * ------------------------------
 *   理想来源是任务 metadata 里的 `plan_index`（拓扑序，1 基），三处同源：
 *   plan.published 的 tasks[]、task.updated 的 task、落库的 metadata.task。
 *   届时这个函数退化成"读 plan_index，读不到才解析 id"。
 *
 * 也认**不带前缀**的 `t1`：历史测试与个别旧数据是裸 local id。
 */
const PLAN_INDEX_RE = /(?:^|:)t(\d+)$/;

export function planIndexOf(taskId: string): number {
  const hit = PLAN_INDEX_RE.exec(taskId);
  if (hit === null) return 0;
  const index = Number.parseInt(hit[1], 10);
  return Number.isSafeInteger(index) && index > 0 ? index : 0;
}

/** 建组时用的中间态（还没有 first/last/ordinal）。 */
interface StagedRow {
  id: string;
  taskId: string;
  planId: string;
  skillKey: string;
  title: string;
  role: TaskRole;
}

/** 当前打开的那一组。`mode` 决定"中间那些没有标注的消息算不算进来"。 */
interface OpenScope {
  taskId: string;
  planId: string;
  skillKey: string;
  title: string;
  mode: 'history' | 'live';
}

/**
 * 一趟扫完所有消息，给每条落在任务里的消息标上位置。
 *
 * 状态只有两个：
 *   · `open` —— 当前打开的是哪个任务，以及它是**怎么打开**的
 *     （`history` = 由 task_instruction 打开；`live` = 由实时标记打开）。
 *   · 两者收尾的条件不同，这是本函数唯一的复杂度来源：
 *       - history 组：**中间的消息全部算进来**（它们没有 task_id），
 *         直到配对的 task_result；遇到下一条 task_instruction 也换组。
 *       - live 组：**只有带标记的消息算**（翻译器在任务运行期间给每条
 *         开出来的消息都打了标）。一条没有标记的消息就意味着"任务已经
 *         不在了"（跑完了 / plan.cleared），组必须就地收尾 ——
 *         否则收尾之后的主对话回答会被吸进最后一个任务的轨道里。
 */
function stage(messages: readonly Message[]): StagedRow[] {
  const staged: StagedRow[] = [];

  let open: OpenScope | null = null;

  for (const message of messages) {
    const boundary = taskBoundaryOf(message);
    const live = boundary ? null : liveTaskOf(message.id);

    /*
     * ⚠️ 先把"这一轮开始时打开的是哪一组"读出来，再判分支
     * -------------------------------------------------
     *   直接在分支里读 `open` 会被 TS 控制流收窄成 `null`（它只看得到循环
     *   体里"读到之前"的赋值），于是 `prev !== null` 被推成 `never`。
     *   在循环体开头读一次，类型就是声明时那个联合 —— 也更好读：
     *   "这一帧面对的是哪一组"与"这一帧要不要换组"是两件事。
     */
    const current: OpenScope | null = open;

    if (boundary) {
      const sameTask: boolean =
        current !== null &&
        current.mode === 'history' &&
        current.taskId === boundary.taskId;

      /**
       * 节点标题。
       *
       * ⚠️ 历史侧只有 `task_instruction` 能给出标题（从正文里抠那段说明），
       *    `task_result` 自己不带说明，沿用组内那一份。实时侧反过来（标题来自
       *    计划事件），两边最终落在**同一个字符串**上 —— 见 taskDescriptionOf。
       */
      const inherited = sameTask && current ? current.title : '';
      const title =
        boundary.kind === TASK_INSTRUCTION_KIND
          ? taskDescriptionOf(textOf(message)) || inherited
          : inherited;

      // 同一个任务的声明只有一条：新任务（或组外来的 result）一律以它为准。
      // ⚠️ 同组时 plan_id / skill_key 缺一项就沿用组内已有的那份 ——
      //    result 那条带的 metadata 可能与 instruction 那条不完全一样。
      const next: OpenScope = {
        taskId: boundary.taskId,
        planId: boundary.planId || (sameTask && current ? current.planId : ''),
        skillKey:
          boundary.skillKey || (sameTask && current ? current.skillKey : ''),
        title,
        mode: 'history',
      };

      staged.push({
        id: message.id,
        taskId: next.taskId,
        planId: next.planId,
        skillKey: next.skillKey,
        title: next.title,
        role:
          boundary.kind === TASK_INSTRUCTION_KIND ? 'instruction' : 'result',
      });

      // result 是这一组的收尾：后面的消息属于"任务之外"。
      open = boundary.kind === TASK_RESULT_KIND ? null : next;

      continue;
    }

    if (live) {
      const sameLive =
        current !== null &&
        current.mode === 'live' &&
        current.taskId === live.taskId;

      open = sameLive
        ? current
        : {
            taskId: live.taskId,
            planId: live.planId,
            skillKey: '',
            title: live.title,
            mode: 'live',
          };

      staged.push({
        id: message.id,
        taskId: live.taskId,
        planId: live.planId,
        skillKey: '',
        title: live.title,
        // 实时没有边界消息，整组都是"一步"。
        role: 'step',
      });

      continue;
    }

    if (current?.mode === 'history') {
      staged.push({
        id: message.id,
        taskId: current.taskId,
        planId: current.planId,
        skillKey: current.skillKey,
        title: current.title,
        role: 'step',
      });
      continue;
    }

    // live 组遇到没标记的消息 = 任务已经不在了（见文件头）。
    open = null;
  }

  return staged;
}

/**
 * 把相邻同 id 的一段收成一组，填上 first / last / ordinal。
 *
 * ⚠️「只有任务说明、什么都没做」的那一组**整组丢掉**（2026-10-22 刷新前后不一致）
 * -------------------------------------------------------------------------
 *   后端对**每个任务**都落一条 `task_instruction`，所以历史里"有几个任务"永远
 *   数得清；而实时侧只有在任务真的**跑出消息**时才留下标记。于是凡是"被分到
 *   任务、却一句话都没产出"的任务（规划器把已经做完的那一步也拆成了一个任务，
 *   实测就有），历史里会多出一个空节点 —— 用户看到的正是"刷新前后不是同一个
 *   界面"。
 *
 *   丢掉之后两边的判据就一致了：**一个节点 = 一个真的跑过的任务**。
 *   代价：那种"分到了但一个字都没产出"的任务在时间线上不留痕迹（它的进度
 *   状态仍然在输入框上方那条 dock 里，见 PlanStatusBars）。
 *
 *   ⚠️ 丢节点**不会**再连累序号：序号按计划内位置算（见 ordinalsOf），
 *      被丢掉的那个号空着，后面的任务不会顶上来。这是第五轮修的 ——
 *      从前按出现顺序编号，t1 一被丢掉，t2 就被写成「任务 1」，
 *      而它的标题正文里还写着"基于 t1 确定的目的与语气"，一眼就穿帮。
 *
 *   判据是"这一段里有任何一行不是任务说明"。有一条 result / 一步工具 / 一句
 *   旁白都算跑过。
 *
 * ⚠️⚠️ 同一个任务被切成多段时，**只能有一个节点**（2026-10-22 第四轮）
 * ------------------------------------------------------------------
 *   切段规则是"相邻同 id"，所以同一个任务只要中间被别的任务插一下，就会分成
 *   两段（甚至更多）。实时通道**必然会**这样：`liveTask` 只有一个，而
 *   `task.updated` 的 `current_task_id` 是**每一次认领**打的 —— 并行子代理
 *   来回认领时它就在几个任务之间跳，于是同一个任务的消息被别的任务的消息隔开。
 *   历史通道在重试同一个任务（`claim.attempt` 翻倍）时也一样。
 *
 *   第一版给**每一段**都填 `first`（画圆点 + 节点标题），于是一个任务被画了
 *   两三次节点，后面那个落在它自己内容的**末尾** —— 用户看到的就是
 *   「task_1 描述的 timeline 跑到 task_2 正文上方」，而刷新之后（历史按
 *   task_instruction 开组）又是对的，两边 DOM 自然不同。
 *
 *   现在的规矩：**一个任务 = 一个序号、一个节点**。
 *     · 序号按**计划内位置**算（见 ordinalsOf），同一任务的各段共用一个号；
 *       不按出现次数累加 —— 否则"任务 2"会被顶成"任务 3"，越刷越乱；
 *     · 节点/标题只画在第一段的**第一行**，后续各段 `first` 全是 false，
 *       于是渲染层只画轨道、不画圆点和标题 —— 轨道照样从上面接过来；
 *     · `last` 只给**最后一段**的最后一行，中间那些段的末尾继续往下穿。
 *
 *   ⚠️ 别把这里改成"按 id 归并成一个块"：组必须是**连续**的一段，把消息搬到
 *      别的时间位置比多画一个节点更糟（见文件头同一条）。
 */
/**
 * 每个任务的序号。
 *
 * 按 planId 分组算，计划之间互不影响：
 *
 *   · 这份计划里**每一个**任务都读得出计划内位置（`t1..tN` 齐全且不重复）
 *     -> 直接用那个位置。于是哪怕 t1 一句话都没产出、压根没出现在时间线上，
 *        t2 仍然是「任务 2」，不会被顶号成「任务 1」。
 *   · 只要有一个读不出（模型写了 `research` 这种 local id），或者出现重复
 *     （同一个 planId 下有两个 `t1` —— 说明 plan_id 缺失，把两轮计划并进了
 *     同一桶）-> **整份计划**退回"出现顺序"。混着用会出现"任务 2 和任务 2"
 *     这种更糟的结果，所以宁可整份保守。
 *   · 退回时的起点接着前面已经用掉的号，避免跨计划撞号。
 */
function ordinalsOf(kept: readonly StagedRow[][]): Map<string, number> {
  /** planId -> 这份计划里的 taskId（按第一次出现的先后）。 */
  const byPlan = new Map<string, string[]>();

  for (const segment of kept) {
    const { taskId, planId } = segment[0];
    const list = byPlan.get(planId);
    if (list === undefined) byPlan.set(planId, [taskId]);
    else if (!list.includes(taskId)) list.push(taskId);
  }

  const ordinal = new Map<string, number>();
  let next = 1;

  for (const ids of byPlan.values()) {
    const parsed = ids.map(planIndexOf);
    const usable =
      parsed.every((value) => value > 0) &&
      new Set(parsed).size === parsed.length;

    if (!usable) {
      for (const taskId of ids) {
        ordinal.set(taskId, next);
        next += 1;
      }
      continue;
    }

    for (let at = 0; at < ids.length; at += 1) {
      ordinal.set(ids[at], parsed[at]);
      next = Math.max(next, parsed[at] + 1);
    }
  }

  return ordinal;
}

function group(staged: readonly StagedRow[]): Map<string, TaskRow> {
  const rows = new Map<string, TaskRow>();

  /** 切成"相邻同 id"的若干段。 */
  const segments: StagedRow[][] = [];
  let start = 0;

  while (start < staged.length) {
    let end = start + 1;
    while (end < staged.length && staged[end].taskId === staged[start].taskId) {
      end += 1;
    }
    segments.push(staged.slice(start, end));
    start = end;
  }

  /** 丢掉"只有任务说明、什么都没做"的段（见上），其余按原顺序留下。 */
  const kept = segments.filter(
    (segment) => !segment.every((item) => item.role === 'instruction'),
  );

  /** 序号：按计划内位置（读不出时退回出现顺序），见 ordinalsOf。 */
  const ordinalOf = ordinalsOf(kept);
  /** 每个任务的**最后一段**在 `kept` 里的下标 —— 只有它才能收尾。 */
  const lastSegOf = new Map<string, number>();

  for (let index = 0; index < kept.length; index += 1) {
    lastSegOf.set(kept[index][0].taskId, index);
  }

  for (let index = 0; index < kept.length; index += 1) {
    const segment = kept[index];
    const taskId = segment[0].taskId;
    const ordinal = ordinalOf.get(taskId) ?? 0;
    // 第一段才画圆点 + 标题；后续段只接着画轨道。
    const opensNode =
      kept.findIndex((item) => item[0].taskId === taskId) === index;
    const closesTask = lastSegOf.get(taskId) === index;

    for (let at = 0; at < segment.length; at += 1) {
      const item = segment[at];
      rows.set(item.id, {
        taskId: item.taskId,
        planId: item.planId,
        skillKey: item.skillKey,
        title: item.title,
        ordinal,
        role: item.role,
        first: opensNode && at === 0,
        last: closesTask && at === segment.length - 1,
      });
    }
  }

  return rows;
}

const cache = new WeakMap<readonly Message[], Map<string, TaskRow>>();

/** 整串消息的任务分组（缓存，见文件头）。 */
export function taskRowsOf(messages: readonly Message[]): Map<string, TaskRow> {
  const hit = cache.get(messages);
  if (hit) return hit;

  const rows = group(stage(messages));
  cache.set(messages, rows);
  return rows;
}

/** 这条消息在时间线上的位置（不在任务里就是 `null`）。 */
export function taskRowOf(
  messages: readonly Message[],
  messageId: string,
): TaskRow | null {
  return taskRowsOf(messages).get(messageId) ?? null;
}
