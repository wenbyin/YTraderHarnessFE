// src/components/CopilotDock/HitlInterrupt.tsx
//
// 人工审批（HITL）：把「后端停下来等人回答」渲染成对话区里的一张卡片。
//
// 它在整条链路里的位置
// ------------------
//   后端 hitl.requested
//     → runEventStream.ts 翻成 RUN_FINISHED { outcome: { type: 'interrupt' } }
//     → agent.ts 立刻收流（runAgent 因此才 resolve）
//     → CopilotKit 把这批 interrupts 交给 useInterrupt
//     → 本文件渲染
//     → 用户点按钮 → resolve({ decision })
//     → CopilotKit 调 runAgent({ resume, runId })
//     → agent.ts 的 resumePending() → POST /runs/{run_id}/resume
//
// ⚠️ 为什么必须走 useInterrupt，而不是"自己画一条消息"
// ----------------------------------------------
//   卡片得能**回头**：把回答送到后端。消息没有这个能力（它只是聊天记录，
//   点一下没有任何回调）。useInterrupt 是协议的一部分 —— 它订阅 agent 的
//   RUN_FINISHED outcome，并把 resolve() 接到"下一次 runAgent 的 resume"上。
//   自己画一条消息的代价是：按钮点了没反应，或者要手搓一遍这套中断状态机。
//
// ⚠️ 为什么 v1 的 <CopilotKit> 里能用 v2 的 useInterrupt
// -------------------------------------------------
//   · `useInterrupt` 只从 `@copilotkit/react-core/v2` 导出。v1 入口里那个
//     同名的东西早就废弃了，而且 `useLangGraphInterrupt` 是**另一套机制**
//     （custom event `on_interrupt`，不是 AG-UI 的 RUN_FINISHED outcome）。
//   · 但 v1 的 `<CopilotKit>` 内部**本来就挂了 v2 的 CopilotKitProvider**
//     （dist 里的实现是 CopilotKit → CopilotKitProvider → CopilotKitInternal），
//     而 useInterrupt 读的就是同一个 context（内部用 useCopilotKit / useAgent）。
//     所以不需要整体迁移到 v2，直接 import 就能用 —— 这是本文件敢这么写的依据。
//
// ⚠️ 从 `/v2/headless` 进，不从 `/v2` 进
// ------------------------------------
//   两个入口导出同一个 useInterrupt，但代价差一个量级：
//     · `/v2` 的入口 `import "./index.css"` —— 顺带把 v2 整套 UI 样式表拖进来，
//       而且 vitest 把 node_modules 当外部依赖交给 Node 的 loader，
//       它**不认 .css**，import 它的测试文件会整包加载失败（实测踩过）；
//     · `/v2/headless` 零 CSS、不带 CopilotChat 那些组件。
//   面板用的是 v1 的 <CopilotChat> + react-ui 的样式，v2 的样式本来就不该进来
//   （两份样式表会互相打架）。所以固定走 headless。
//
// ⚠️⚠️ 固定 `renderInChat: false`，卡片自己挂（这里踩过一次，把错的结论改回来）
// --------------------------------------------------------------------
//   先纠正一条**我之前写错的**结论：v1 的 `<CopilotChat>` **会**渲染这个元素，
//   不是空操作。`@copilotkit/react-ui/dist/index.cjs` 里两行就是证据：
//      1703  const { messages: visibleMessages, interrupt } = useCopilotChatInternal()
//      1756  ...（messages 与 loading 光标之后）直接 {interrupt}
//   于是用默认的 `renderInChat: true` 时同一个卡片会**出现两次**：对话流里一张
//   （库画的）+ 我们的浮动层一张（自己挂的）。界面上就是两张一模一样的确认卡，
//   而且各有各的 `deciding` 状态（点一张，另一张还是可点的）。
//   实测截图确认过（2026-10-06）。
//
//   `renderInChat: false` 则是：hook 把元素**返回**给我们，不发布出去
//   → 库那边没有东西可画（一张都不出现），我们挂进自己的浮动层。
//
//   ⚠️ 代价要一起处理：`copilotkit.interruptElement` 同时变 null，而输入框
//   「有审批时禁发送」原来正是读它（`useCopilotChatInternal().interrupt`）。
//   这个副作用不能丢 —— 等审批期间这个会话**建不了新运行**（后端 409），
//   agent 的 onInitialize 也会因为"有未应答的中断"直接抛错，让人能按下发送键
//   只会换来一条报错。所以那个布尔改由本文件发布给 hitlSignal.ts，输入框从那里读。
//
//   ⚠️ 为什么留浮动层、而不是留库在对话流里画的那张：
//   审批期间输入框是锁的，卡片一旦被滚出视野，用户就卡住了。浮动层贴输入框上沿、
//   永远可见 —— 这是它存在的唯一理由。
//
// ⚠️⚠️ 形状：**工具调用状态栏（title）+ 审批控件（content）**（2026-10-23）
// ---------------------------------------------------------------------
//   用户原话：「直接把审批控件作为 content，工具调用状态栏作为 title /
//   审批完成之后就融合进 title 栏即可」。落点：
//
//     · 标题行 = 对话里那条工具记录的同款（图标 + i18n 过的人话工具名 + 右侧
//       位次/倒计时 + 折叠箭头）。谁在等、等什么，一眼就在这一行里；
//     · 内容 = 原来的审批控件（那句话、工具/参数、按钮、作用域说明）；
//     · 点了允许/拒绝 → 内容**立刻**收进标题行（`open = false`），卡片只剩
//       那一行；随后中断被清空，整块卸载 —— 用户看到的就是"这条审批并进了
//       工具调用记录"。
//
//   ⚠️ 为什么先收再等，而不是等 `resolve` 回来再收
//     收的是**本地状态**，请求是并行的：先收让人立刻看到"我点到了"，
//     不必等网络。`resolve` 失败会**重新展开**（见 submit 的 catch）——
//     否则界面上只剩一行标题，用户既看不到报错也点不了按钮。
//
//   ⚠️ 底色必须不透明（上一版的 bug）：这一层压在消息文本上方，半透明底色
//     会让下面的字透上来（用户截图里整张卡是"透"的）。详见 style.ts 的 hitlCard。
//
// ⚠️⚠️ 一组多个中断：**一张卡 + 位次**，逐条答，答完整组一次性上报
// ------------------------------------------------------------
//   后端的工具是并行跑的，一次派发可能同时停下来问好几件事。这一组在协议里是
//   **一个** RUN_FINISHED 里带的 `interrupts: [...N]`（聚合见 runEventStream.ts
//   与 agent.ts 的 collectHitlGroup）。
//
//   ⚠️ 但库**不会**替我们分页：`useInterrupt` 的 render 只被调用一次，
//   `interrupt` 恒等于 `interrupts[0]`（`@copilotkit/react-core/dist/v2/headless.cjs`
//   1102 行），另一个 prop `interrupts` 才是整组。所以"当前第几条"是**我们**的状态。
//
//   分页怎么做（本文件的 index / current）：
//     · 一次只显示一条（`interrupts[index]`），头部显示「当前第 N 条 / 总计 M 条」；
//     · 答一条 → `resolve(payload, id)` 只记下这一条的答案，库返回 `waiting`
//       （`InterruptState.#respond`：没全答完就 `{ kind: 'waiting' }`，不跑 runAgent）
//       → 我们翻到下一条；
//     · 最后一条答完 → 库才 `buildResumeArray` 出整组、**一次** runAgent 上报
//       → agent.ts 的 resumePending 把整组包成 `{ answers:[{interrupt_id,data}] }`
//       一次 POST（后端 `ResumeRequest` 的模型就是"把手上所有待答的一次性回掉"，
//       少一条或给多了都 409）。
//   所以"批量上报"不是前端攒出来的，是协议自带的；前端只要**整组声明**、
//   并且**逐条**把答案给到对应的 interruptId 上。
//
//   ⚠️ 必须传 interruptId
//   ------------------
//   不传的话库会警告并**默认第一条**（headless.cjs 949 行）—— 那样第二条永远
//   答不上，整组卡死在 waiting。`interrupts.length === 1` 时传不传等价（没有警告），
//   但这里一律传，路径只有一条、不靠"分支记得传"。
//
// ⚠️ 后端今天有**两类**中断，但这里按四种形状渲染
// -------------------------------------------
//   这是「共同性」的落点：外壳、回传口径、"谁在等"的信息展示全都共用，
//   只有中间那段按形状分。四种形状由 resolveVariant 一个函数判定 ——
//   **唯一的分叉点**，别在别处再长分支。
//
//     approval —— 值域就是 ApprovalDecision 那三个（approve/reject/always），
//                 审批拦截器发的那一类；
//     question —— `agent.ask_user_question`：载荷带 `type: "ask_user_question"`
//                 与 `questions[]`，中间那段换成问题控件
//                 （AskUserQuestionBody.tsx），回答走 `{ answers }` 而不是
//                 `{ decision }`；
//     options  —— responseSchema 里有枚举、但不是审批那三个（"具体的问题选项"
//                 那一类，demo 里那两种之一）。按钮的文字直接用后端给的值，
//                 **不编**中文标签：不知道它的语义，编出来的标签就是错的；
//     unknown  —— 读不出值域。这时渲染原始信息 + 只给"取消"，
//                 宁可让人看出"这里有个东西我还不认识"，也不要白屏。
//
//   ⚠️ question 必须排在 approval / options **之前**判：提问的载荷里没有
//      `options` 字段，落到后面只会被判成 unknown（读不出值域）—— 界面就把
//      一个四平八稳的问答退化成"原始载荷 + 取消"了。
//
// ⚠️ 为什么在 hitl.requested 上弹，而不是在 tool.called 上弹
// -------------------------------------------------------
//   `tool.called` **先到**，而且带着同一份 `questions`（那是模型的入参，
//   与 `interrupt()` 的载荷逐字相同）。但**它没法回答**：resume 必须带
//   `interrupt_id`，而那个 id 是 langgraph 在 `interrupt()` 抛出时才生成的，
//   只随 `hitl.requested` 下发（见后端 `_publish_hitl_requested`）。
//   在 tool.called 上弹，用户完全可能先填完再点提交 —— 那一刻还没有 id 可用，
//   这个按钮只能是死的，最坏的结果是"点了没反应"。
//   所以分工是：**触发看中断**（唯一能提交的时机），`tool.called` 那份入参
//   只当兜底内容源（见 runEventStream.ts 的 `askQuestions`）。
//
// ⚠️ 不做的事（刻意，都有理由）
// --------------------------
//   · **倒计时有，但窗口只来自后端，且到点什么都不做**（2026-10-06 补）
//     ------------------------------------------------------------
//     这条原来写的是「没有倒计时：后端没有超时概念，画一个倒计时就是在编一个
//     不存在的 deadline」。**那个前提现在只剩一半** —— 补齐后结论是这样的：
//
//       窗口是真的 —— `ApprovalConfig.wait_seconds`（默认 300 秒）现在随
//       `hitl.requested` 的载荷下发（后端 `_payload()`），卡片直接显示它。
//       前端**不写窗口常量**：自己定一个等于发明一条后端不认的策略。
//       锚点也是真的 —— 用**这一帧的 `occurred_at`**（后端 UTC），不是
//       "卡片挂载的那一刻"。于是刷新/续订后**重放**出来的中断仍带原始时刻，
//       倒计时**接着走**，不会从满格重启（"刷新一下就又满格"是装饰，不是倒计时）。
//       两样原料缺一样就**不画**（`wait_seconds` 或 `occurred_at` 读不到，
//       比如老后端、别的形状的中断）—— 宁可没有，也不要画一个假的。
//
//     ⚠️⚠️ 走到 0 的那一刻：**什么都不做**（这是被问过两次的地方）
//     --------------------------------------------------------
//     不自动拒绝、不自动允许、也**不设** AG-UI 的 `expiresAt`：
//
//       · 自己提交一个决定 = 前端**发明一条审批策略**。到点该拒绝、该取消、
//         还是继续等，是**运行生命周期所有者**的事（后端 `waiting_input` 的
//         清理任务）—— approval.py 的 docstring 明说 `wait_seconds` 就是留给
//         那个消费者的。前端抢着拒绝，将来两边会各动作一次（第二次撞 409），
//         而且审批是真的拦着工具调用的，误拒会真的拒掉一个交易动作。
//       · 设 `expiresAt` 比"自己提交"更糟：`useInterrupt` 会**真拿它执法**，
//         方式还很烂（两处实测见 runEventStream.ts 里那段注释）—— 最坏那条是
//         「整组答完后才发现过期 → 静默丢弃全部答案 + 清掉卡片」，用户以为
//         批过了，而后端仍停在 `waiting_input`，只在 console 留一行错误。
//
//     所以到点只是把那个小药丸改成「已超过等待时长」，按钮照旧等人点。
//     等后端那条清理任务落地、开始推出自己的状态后，前端再改成"跟随后端状态"。
//   · **没有风险等级**：后端不提供。拿 tool_key 猜"这是个危险工具"会误判；
//   · **按钮只按后端给的 options 画**：`always` 是能绕过工具自己风险策略的
//     那个（见后端 approval.py），多画一个就等于多开一条路。
import {
  DownOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  type Interrupt,
  type InterruptRenderProps,
  useInterrupt,
} from '@copilotkit/react-core/v2/headless';
import { Button, Tag } from 'antd';
import { cx } from 'antd-style';
import React, { useCallback, useEffect, useState } from 'react';
import AskUserQuestionBody from './AskUserQuestionBody';
import { readQuestions } from './askUserQuestion';
import { setHitlPending } from './hitlSignal';
import { pushInteraction } from './liveInteractionFeed';
import { useStyles } from './style';
import { useToolLabels } from './toolLabels';

/**
 * 审批那三个值的中文。这是 **ApprovalDecision** 的固定词表
 * （后端 processor/interceptor/approval.py 的 `ApprovalDecision`），
 * 只有这一类可以翻译 —— 别的形状的值域是后端自定义的，翻译就是编。
 */
export const APPROVAL_LABELS: Record<string, string> = {
  approve: '允许',
  reject: '拒绝',
  always: '始终允许',
};

/** 审批的形状：值域是这三个之一。 */
export const APPROVAL_VALUES: readonly string[] = [
  'approve',
  'reject',
  'always',
];

/**
 * 倒计时的**截止时刻**（毫秒）。两样原料缺一样就返回 `null` —— 那就**不画**倒计时。
 *
 * ⚠️ 两样都必须是**真数据**，这是这个函数存在的全部理由
 * -----------------------------------------------------
 *   `waitSeconds`   后端配置里声明的等待窗口（`wait_seconds`，随载荷来）；
 *   `requestedAt`   这一帧自己的 `occurred_at`（后端 UTC）。
 *
 *   窗口**不许**在前端写常量 —— 自己定一个等于发明一条后端不认的策略，
 *   而且它跟后端将来真正清理的时刻对不上，比没有倒计时更容易误导人。
 *
 * ⚠️ 已知偏差：`occurred_at` 是**服务端**时刻，这里跟**本机**时钟比。客户端
 *   时钟有偏差时倒计时会整体偏一点（生产上是秒级）。可以接受 —— 它只做显示，
 *   真正判超时的是后端，不受本机时钟影响。
 */
export function approvalDeadline(
  waitSeconds: unknown,
  requestedAt: unknown,
): number | null {
  const seconds = typeof waitSeconds === 'number' ? waitSeconds : Number.NaN;
  // `> 0` 而不是 `>= 0`：窗口 0 秒意味着"一出现就超时"，那更像是后端漏填了，
  // 而不是真的设了 0 —— 宁可不显示，也不要显示一个荒唐的。
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const started =
    typeof requestedAt === 'string' ? Date.parse(requestedAt) : Number.NaN;
  if (!Number.isFinite(started)) return null;

  return started + seconds * 1000;
}

/**
 * 剩余时间的显示形式：`mm:ss`，超过一小时才带上小时位。
 *
 * ⚠️ 显示到**秒**，不用"剩 5 分钟"那种粗粒度：窗口下限是 1 秒（后端的
 *   `ge=1`），粗粒度会把短的窗口显示成"剩 0 分钟"。既然要显示，就显示准。
 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 「一共多久」的人话形式。只用在 `title` 提示里，不进主文本。 */
function formatWindow(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

/** 卡片中间那段按什么渲染。 */
export type HitlVariant = 'approval' | 'options' | 'question' | 'unknown';

interface ApprovalMetadata {
  toolKey?: unknown;
  arguments?: unknown;
  approverRole?: unknown;
  options?: unknown;
  runId?: unknown;
  /**
   * 后端声明的等待窗口（秒）与这一帧的产生时刻 —— 倒计时的两样原料。
   * ⚠️ 由 runEventStream.ts 的 `hitlInterrupt` 从载荷/信封里搬进来，
   *   见那里的注释（以及"为什么不走 `expiresAt`"）。
   */
  waitSeconds?: unknown;
  requestedAt?: unknown;
  /**
   * 中断的种类（`ask_user_question` 才有）与题目清单。
   * ⚠️ 同样是 `hitlInterrupt` 搬进来的：后端这两个字段在 `hitl.requested`
   *   的载荷顶层，不在 AG-UI 的 metadata 里。
   */
  hitlType?: unknown;
  questions?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 从 interrupt 里读出"该画哪几个按钮"。
 *
 * 两个来源，顺序是刻意的：
 *   ① `responseSchema.properties.decision.enum` —— AG-UI 描述**回答形状**的
 *      标准位置，也是协议里唯一有约束力的那个；
 *   ② 退到 `metadata.options` —— 后端的原始字段（runEventStream 没动它，只是
 *      搬进 metadata）。①在而②缺（或反过来）都不该让按钮消失。
 */
export function readOptions(interrupt: Interrupt | null): string[] {
  const schema = interrupt?.responseSchema as
    | { properties?: { decision?: { enum?: unknown } } }
    | undefined;

  const fromSchema = schema?.properties?.decision?.enum;
  if (Array.isArray(fromSchema)) {
    const values = fromSchema.filter(
      (item): item is string => typeof item === 'string',
    );
    if (values.length > 0) return values;
  }

  const meta = interrupt?.metadata as ApprovalMetadata | undefined;
  if (Array.isArray(meta?.options)) {
    return meta.options.filter(
      (item): item is string => typeof item === 'string',
    );
  }

  return [];
}

/**
 * **唯一的分叉点**：这批中断该按哪种形状渲染。
 *
 * 判据**先**看"这是不是一次提问"（载荷自述的 `type` + 读得出的 `questions`），
 * **再**看"值域像不像审批"。顺序不能反 —— 见文件头末尾那条 ⚠️：提问没有
 * `options`，落到值域那套判据里只会被判成 unknown。
 *
 * 而值域那一支的判据只有一条 —— 不去认 tool_key、更不认 reason：
 *   · 认 tool_key 等于把"哪些工具要审批"这份配置抄到前端来，配置一改前端就错；
 *   · reason 是集成方自己填的类别（这里恒为 `tool_approval`），它描述的是
 *     "为什么停下来"，不能推出"回答长什么样"。
 * 值域才是唯一的答案，因为它就是按钮要画的东西。
 */
export function resolveVariant(interrupt: Interrupt | null): HitlVariant {
  if (readQuestions(interrupt).length > 0) return 'question';

  const options = readOptions(interrupt);
  if (options.length === 0) return 'unknown';

  return options.every((option) => APPROVAL_VALUES.includes(option))
    ? 'approval'
    : 'options';
}

/** 按钮文字：审批用固定词表，别的形状**原样显示后端给的值**。 */
export function optionLabel(option: string): string {
  return APPROVAL_LABELS[option] ?? option;
}

/** 把参数对象渲染成给人看的文本。空对象不算"有参数"。 */
export function formatArguments(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  if (Array.isArray(value)) return '';
  if (Object.keys(value).length === 0) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

/**
 * 卡片本体。
 *
 * 四个动作全部**只**做一件事：把回答交给 resolve —— 网络那一段在
 * agent.ts 的 resumePending 里（它要知道后端 run_id、要带 Last-Event-ID
 * 重订阅），放在这里就等于把两层的知识揉在一起。
 *
 * 导出是为了单测能直接喂中断数据（HitlInterrupt 那层要真 context 才跑得起来）。
 */
export const HitlCard: React.FC<InterruptRenderProps> = ({
  interrupt,
  interrupts,
  resolve,
}) => {
  const { styles } = useStyles();
  // 哪一颗正在提交，null = 空闲。
  // ⚠️ 存"值"而不是布尔量：用 `loading={deciding}` 的话，点「允许」时「拒绝」
  //   也在转圈，看着像两个按钮同时在提交（antd 会给每颗都插一个
  //   `role="img" aria-label="loading"` 的图标 —— 实测过）。其余按钮只置灰：
  //   锁住，但用户仍看得出"我点的是哪一颗、还有哪些选择"。
  const [pending, setPending] = useState<string | null>(null);

  /**
   * 表单是否展开（标题行永远在）。
   *
   * ⚠️ 默认**展开**：不展开的话用户根本不知道在等什么。
   * ⚠️ 一提交就折起来（见 submit）—— 这就是需求里那句"点了允许/拒绝之后，
   *    动画融合进 title 栏"：内容高度收到 0，只剩那行「<图标> 工具名」，
   *    然后随中断被清空而整块卸载。
   */
  const [open, setOpen] = useState(true);

  /**
   * 这一组待办中断。
   *
   * ⚠️ 以 `interrupts` 为准，`interrupt` 只是兜底
   * ---------------------------------------
   *   真 hook 那边 `interrupt` 恒等于 `interrupts[0]`（见文件头），两个都读会
   *   多出一条并不存在的分支。但 `interrupts` 在协议里可以是空数组
   *   （legacy 那套就是空），那时才退回单条。
   */
  const group =
    interrupts.length > 0 ? interrupts : interrupt ? [interrupt] : [];

  /** 正在显示第几条（0 基）。一次只答一条 —— 见文件头的分页说明。 */
  const [index, setIndex] = useState(0);
  // 组变小了也不会越界（真出现的话，宁可重复显示最后一条，也不要白屏）
  const current = group[Math.min(index, group.length - 1)] ?? interrupt;
  const total = group.length;
  const position = total > 1 ? Math.min(index, total - 1) + 1 : 1;

  const variant = resolveVariant(current);
  const options = readOptions(current);
  const questions = readQuestions(current);
  const meta = (current?.metadata ?? {}) as ApprovalMetadata;

  const labels = useToolLabels();
  const toolKey = asString(meta.toolKey);
  const approverRole = asString(meta.approverRole);
  const args = formatArguments(meta.arguments);

  /**
   * 倒计时。两样原料缺一样就 `deadline === null` —— 那就整块不出现，
   * 卡片退化成"没有倒计时"（见文件头那条说明）。
   *
   * ⚠️ 用 `current` 的 metadata：一组并行审批里每一条各有各的时刻与窗口，
   *   倒计时得跟着**正在显示的那一条**走，不能拿整组第一条第时钟套所有人。
   */
  const deadline = approvalDeadline(meta.waitSeconds, meta.requestedAt);
  const waitSeconds =
    typeof meta.waitSeconds === 'number' ? meta.waitSeconds : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      // 到点就停表：之后数字不再变（药丸改成"已超过"），没必要每秒空转。
      // ⚠️ 停表**不是**"到点做点什么"—— 到点什么都不做，见文件头。
      if (tick >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  const remaining = deadline === null ? null : deadline - now;
  const overdue = remaining !== null && remaining <= 0;
  // 两样原料都在才画（`deadline` 已经蕴含它们，这里再判一次是为了让 TS 收窄，
  // 也为了让"要什么才算有倒计时"在这一个表达式里看得见）。
  const countdown =
    remaining === null || waitSeconds === null
      ? null
      : {
          overdue,
          text: overdue
            ? '已超过等待时长'
            : `剩余 ${formatRemaining(remaining)}`,
          title: overdue
            ? '已超过后端声明的等待时长。界面不会自动提交任何决定 —— ' +
              '超时该由后端的清理任务处理，仍需你来选择。'
            : `后端声明的等待时长：共 ${formatWindow(
                waitSeconds,
              )}。到点后界面不会自动提交，仍需你来选择。`,
        };

  /**
   * 把回答交给 `resolve`。
   *
   * `key` 只用来标"哪一颗按钮在转圈"（值 / 选项 / 'submit' / 'skip'），
   * `payload` 才是往回报的东西 —— 两种形状：
   *   · 审批/选项：`{ decision: <后端给的那个值> }`；
   *   · 提问：`{ answers: { <问题原文>: <答案> } }`。
   * 后端 `_parse_resume` 两种都认，而且**按 key 分流**（有 `answers` 就取它，
   * 否则把整个字典当答案表）。所以这两支不能混着发。
   */
  const submit = useCallback(
    async (key: string, payload: unknown) => {
      // ⚠️ 自己去重，不指望 UI 挡住
      //   按钮的 loading/disabled 是"希望"，不是保证（antd 的行为会变、
      //   键盘/程序化点击也绕得过）。重复提交的后果是第一个请求刚受理、
      //   第二个撞 409 —— 用户会看到一条莫名其妙的报错。
      if (pending !== null) return;
      setPending(key);

      /*
       * 先把表单**收进标题行**，再发请求（需求："点了允许/拒绝之后，动画
       * 融合进 title 栏"）。收的是 max-height，transition 在 style.ts 里；
       * `resolve` 本身是异步的，这两件事天然并行 —— 动画跑完时请求也已经
       * 发出去了，不会让用户多等。
       * ⚠️ 失败要重新展开（见下面的 catch），否则界面上只剩一行标题、
       *    用户既看不到报错也点不了按钮。
       */
      setOpen(false);

      /**
       * ⚠️ 先把「我答了什么」记进**实时**那份 —— 提交的那一刻它就该出现在
       *    对话里（见 liveInteractionFeed.ts 的文件头：后端要等 resume 才落库，
       *    那之前刷新是看不到自己答过什么的）。
       *
       *    只有**提问**这一类有 questions：审批那一类回的是 `{ decision }`，
       *    后端本来也不为它写问答记录 —— 不画卡才是对的。
       */
      const answers = (payload as { answers?: Record<string, string> } | null)
        ?.answers;
      if (questions.length > 0 && answers) {
        pushInteraction({ questions, answers });
      }

      // ⚠️ 只答**这一条**：把 id 交回去，库才会把答案记在正确的条目上。
      //   不传 id 时它会默认第一条（并打一条 warning）—— 那样第二条永远答不上。
      const answered = index;
      try {
        // ⚠️ 这个 promise 的行为随"是不是最后一条"而不同（CopilotKit 的实现）：
        //   · 没答完 → 立刻 resolve（库返回 waiting，不发请求）；
        //   · 答完最后一条 → 等**整轮恢复跑完**才 resolve。
        //   所以下面这一点很重要：只有"还没答完"时才收尾翻页；答完最后一条
        //   时组件已经随中断被清空而卸载（没卸载也无所谓，翻页是个 no-op）。
        await resolve(payload, current?.id);

        if (answered < total - 1) {
          // 翻到下一条，并**把按钮放开** —— 不复位 pending 的话下一条的按钮
          // 会一直是灰的，用户就卡在这儿了。
          setIndex(answered + 1);
          setPending(null);
          // 下一条要重新展开：上一条收起时留下的"折叠"不该被继承
          // （否则用户看到的是一行标题，还得自己点开才知道在问什么）。
          setOpen(true);
        }
      } catch {
        // 原因已经由 agent.ts 的 catchError 写成一条助手消息（含是哪一步失败），
        // 这里不重复显示；只把按钮放开，让用户能再试或改选。
        // ⚠️ 展开也要恢复：提交失败时界面不能停在"只剩一行标题"。
        setPending(null);
        setOpen(true);
      }
    },
    [pending, resolve, current?.id, index, total],
  );

  /*
   * 标题行那两段字。
   *
   * ⚠️ 主语是**工具名**（用 toolLabels 翻成人话），"需要你的审批"退成旁注
   * --------------------------------
   *   用户的要求就是"工具调用状态栏作为 title"，而那条栏的主语一直是工具。
   *   没有 toolKey 的（legacy 中断 / 读不出）才退回那句旁注当主语 ——
   *   两段都画同一句话就成了「需要你的审批 需要你的审批」。
   */
  const kicker =
    variant === 'approval'
      ? '需要你的审批'
      : variant === 'options'
        ? '请选择'
        : variant === 'question'
          ? '需要你的回答'
          : '需要你的确认';
  const toolName = toolKey ? labels.name(toolKey) : '';
  const title = toolName || kicker;
  const note = toolName ? kicker : '';

  return (
    // <fieldset> 而不是 div + role="group"：这里本来就是"一组相关的按钮 + 一个
    // 组名"，fieldset 是它的原生语义（aria-label 给它当组名，不需要可见的 legend）。
    // 浏览器默认样式已在 hitlCard 里清掉。
    <fieldset
      className={styles.hitlCard}
      aria-label={variant === 'question' ? '需要你的回答' : '需要你确认'}
    >
      {/*
        ⭐ 标题行 = **工具调用状态栏**（2026-10-23 用户："直接把审批控件作为
        content，工具调用状态栏作为 title"）。
        它长成和在对话里那条工具记录一模一样：图标 + 工具名（i18n 过的人话），
        右端是位次/倒计时，末尾一枚箭头表示可折叠。
        ⚠️ 用真 <button>：aria-expanded / 键盘可达 / 焦点框全是白拿的。
        ⚠️ 箭头朝下（内容在标题**下面**展开），展开后转 180°。
      */}
      <button
        type="button"
        className={styles.hitlTitle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-hitl-title={variant}
        // 悬停给"这个工具干什么 + 原始 tool_key"（与 ToolActivityRow 同口径）：
        // 标题里的名字被省略号截断时，排障还得靠原值去对后端日志。
        title={toolKey ? labels.hint(toolKey) : undefined}
      >
        <span className={styles.hitlTitleIcon} data-variant={variant}>
          {variant === 'unknown' || variant === 'question' ? (
            <QuestionCircleOutlined />
          ) : (
            <SafetyCertificateOutlined />
          )}
        </span>
        <span className={styles.hitlTitleName}>{title}</span>
        {note ? <span className={styles.hitlTitleNote}>{note}</span> : null}
        {/*
          右端那一组状态：位次 +（可选）倒计时。
          ⚠️ 包一层容器、把 `margin-inline-start: auto` 从 hitlQueue 挪到容器上：
            两个药丸要作为**一个组**一起靠右；各自带 auto 会把空白平分、
            把它们推到两个位置上。只有一个药丸时外观与原来完全一致。
        */}
        <span className={styles.hitlHeadSide}>
          {/*
            一次派发带了多个中断时的位次（并行工具各停一次 → 聚成一组）。
            只有一条时整块不出现 —— 单条审批前面加个"总计 1 条"是纯噪音。
          */}
          {total > 1 ? (
            <span className={styles.hitlQueue} data-hitl-position={position}>
              当前第 {position} 条 / 总计 {total} 条
            </span>
          ) : null}
          {/*
            倒计时（纯显示）。窗口与锚点都来自后端，见 approvalDeadline。
            `data-hitl-countdown` 让单测/探针能一眼读到"现在是哪种状态"。
          */}
          {countdown ? (
            <span
              className={styles.hitlCountdown}
              data-hitl-countdown={countdown.overdue ? 'overdue' : 'counting'}
              title={countdown.title}
            >
              {countdown.text}
            </span>
          ) : null}
        </span>
        <DownOutlined
          className={`${styles.hitlCaret} ${open ? styles.hitlCaretOpen : ''}`}
          aria-hidden
        />
      </button>

      {/*
        content：审批控件本体。`data-open` 控高度（0fr → 1fr，见 style.ts 的
        hitlBody），折叠时只剩上面那一行标题 —— 这就是"融合进 title 栏"。
        ⚠️ 同时挂 `visibility`（hitlBodyInner）：高度收成 0 只是**看不见**，
          里面那排按钮仍在 tab 序里 —— 键盘会 Tab 到一个看不见的「允许」上。
      */}
      <div className={styles.hitlBody} data-open={open} data-hitl-body="1">
        <div className={styles.hitlBodyInner} data-open={open}>
          {variant === 'question' ? (
            /*
              提问：中间那段整体换掉（题面 + 选项 + 它自己的按钮）。
              ⚠️ `key` 用中断 id 而不是下标：一组里翻到下一条时，草稿与"第几题"
                必须**跟着换**。没有 key 的话 React 会复用同一个实例，上一条的
                答案会原样出现在下一条的输入框里 —— 那种错看着像"后端串了数据"。
            */
            <AskUserQuestionBody
              key={current?.id ?? 'ask_user_question'}
              questions={questions}
              pending={pending}
              onResolve={(answers, action) => void submit(action, { answers })}
            />
          ) : (
            <>
              {/* 后端给的那句话（审批拦截器的 prompt）。读不到就用一句克制的中性话 */}
              <p className={styles.hitlAsk}>
                {current?.message || '这个操作需要你确认之后才能继续。'}
              </p>

              {variant === 'approval' || variant === 'options' ? (
                <dl className={styles.hitlMeta}>
                  {toolKey ? (
                    <>
                      <dt className={styles.hitlMetaLabel}>工具</dt>
                      <dd className={styles.hitlMetaValue}>
                        <Tag className={styles.hitlTool}>{toolKey}</Tag>
                      </dd>
                    </>
                  ) : null}

                  {args ? (
                    <>
                      <dt className={styles.hitlMetaLabel}>参数</dt>
                      <dd className={styles.hitlMetaValue}>
                        <pre className={styles.hitlArgs}>{args}</pre>
                      </dd>
                    </>
                  ) : null}

                  {approverRole ? (
                    <>
                      <dt className={styles.hitlMetaLabel}>审批角色</dt>
                      <dd className={styles.hitlMetaValue}>{approverRole}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}

              {/*
                unknown 的兜底：把原始载荷摊开。**必须封顶**（见 hitlRaw 的 max-height）——
                后端给一个很大的载荷时，不封顶会把按钮顶出可视区，人就出不去了。
              */}
              {variant === 'unknown' ? (
                <pre className={styles.hitlRaw}>
                  {JSON.stringify(
                    {
                      reason: current?.reason,
                      message: current?.message,
                      metadata: current?.metadata ?? {},
                    },
                    null,
                    2,
                  )}
                </pre>
              ) : null}

              <div className={styles.hitlActions}>
                {variant === 'unknown' ? (
                  // 读不出值域 = 不知道怎么回答。只留"取消"，而且它**会**把回答送回去
                  // （agent.ts 里 cancelled 落成 reject）—— 什么都不发的话，这个会话
                  // 会永远卡在 waiting_input（后端在等人工输入期间建不了新运行）。
                  <Button
                    size="small"
                    loading={pending !== null}
                    onClick={() =>
                      void submit('reject', { decision: 'reject' })
                    }
                  >
                    取消这次操作
                  </Button>
                ) : (
                  options.map((option) => (
                    <Button
                      key={option}
                      size="small"
                      type={option === 'approve' ? 'primary' : 'default'}
                      danger={option === 'reject'}
                      loading={pending === option}
                      disabled={pending !== null && pending !== option}
                      onClick={() => void submit(option, { decision: option })}
                    >
                      {optionLabel(option)}
                    </Button>
                  ))
                )}
              </div>

              {/*
                作用域说明。审批记录是**按运行**归档的（后端 approval_namespace(run_id)），
                所以"始终允许"只管这一轮 —— 不说清这件事，用户会以为是永久设置。
              */}
              {variant === 'approval' ? (
                <p className={styles.hitlNote}>
                  {options.includes('always')
                    ? '「始终允许」只在本次对话的这一轮运行内、对这个工具生效，不是永久设置。'
                    : '这个工具没有开启「始终允许」，每次调用都会再问一次。'}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </fieldset>
  );
};

/**
 * 挂在对话区里的那一层。
 *
 * ⚠️ 为什么要两个组件（这个 + HitlCard）
 * ----------------------------------
 *   useInterrupt 必须由**我们**调用。传 `renderInChat: false` 时它把 render
 *   产出的元素**返回**给我们（传 true 则是发布到 copilotkit 上，不在返回值里）——
 *   取到之后交给谁渲染、渲染在哪，就完全由我们决定。这是它和库的关系的全部。
 *
 * ⚠️ 位置：chatPane 的直属层、贴着输入框上沿
 * -------------------------------------
 *   塞进 <CopilotKit> 的子树里没有意义（库只在它自己的 Messages 里画，那正是
 *   我们要避免的第二张卡）。挂在 chatPane 上（它是 position: relative，且
 *   overflow: hidden）用绝对定位实现"浮在消息区底部、输入框之上"，
 *   消息列表自己滚动，不被顶下去。
 */
const HitlInterrupt: React.FC = () => {
  const { styles } = useStyles();

  // renderInChat: false —— 库里那张不画了，元素交给我们自己挂。
  // 输入框要的"有审批时禁发送"改由下面的 setHitlPending 提供（见 hitlSignal.ts）。
  const element = useInterrupt({
    render: (props) => <HitlCard {...props} />,
    renderInChat: false,
  });

  // 把这个布尔发布给输入框。⚠️ 分成两个 effect 是刻意的：
  // 第一个跟着元素走（有中断 → true、点了按钮/中断被清 → false）；
  // 第二个只管卸载时收回，不跟着 element 跑 —— 否则元素一变就会先 false 再 true，
  // 白白让输入框闪一下解锁。
  useEffect(() => {
    setHitlPending(element !== null);
  }, [element]);
  useEffect(() => () => setHitlPending(false), []);

  // 没有待办就整层收掉：不占位、不抢点击（底下是消息与输入区）
  if (!element) return null;

  return (
    <div className={cx(styles.hitlLayer)} data-hitl-layer="1">
      {element}
    </div>
  );
};

export default HitlInterrupt;
