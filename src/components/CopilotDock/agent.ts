// src/components/CopilotDock/agent.ts
//
// 把「CopilotKit 的对话界面」和「YTraderHarness 的会话/运行接口」接起来的那一层。
//
// 为什么是一个 agent 子类
// ----------------------
//   CopilotKit 的聊天 UI 只认 agent，来源有两条：
//     ① 去 runtimeUrl 找 CopilotKit Runtime —— 后端没有这个服务（它是自研 REST）；
//     ② 由应用**直接传进来**的 agent（provider 的 agents__unsafe_dev_only /
//        selfManagedAgents）。这条路就是本文件。
//   @ag-ui/client 的 AbstractAgent 只有一个抽象方法：run(input) → Observable<AG-UI 事件>。
//   于是「调 REST 接口 + 订阅 SSE」可以被翻译成一条 AG-UI 事件流，聊天界面一行都不用改。
//
// 一轮的完整链路
// --------------
//   1. ensureSession()   —— 懒建会话，拿到 session_id
//   2. createRun()       —— 把用户这一轮说的话提交成一次运行，拿到 run_id
//   3. runEvents(run_id) —— 订阅 GET /runs/{run_id}/events（SSE）
//   4. RunEventTranslator —— 把后端领域事件逐帧翻成 AG-UI 事件（见 runEventStream.ts）
//
//   前三步任何一步失败，都退成「一条写清原因的助手消息 + RUN_FINISHED」——
//   用户一定看得见为什么没成，而不是界面默默转圈。
//
// ⚠️ 事件流的方向是单向的 —— 除了 HITL 那一次
// -----------------------------------------
//   后端事件是**领域名**（message.delta 等），AG-UI 是**协议名**
//   （TEXT_MESSAGE_CONTENT 等）。两套词表一一对应但不是一个东西，
//   翻译全在 runEventStream.ts，本文件只负责编排顺序。
//
//   唯一的例外是人工审批（HITL）：后端发 `hitl.requested` 停下等人回答，
//   客户端要把回答送回 `POST /runs/{run_id}/resume`。这条回路是**协议内**的：
//
//       ① 翻译器把 hitl.requested 翻成
//          RUN_FINISHED { outcome: { type: 'interrupt', interrupts: [...] } }
//       ② 收流（**必须现在收**，见下面 takeWhile 的说明）
//       ③ 用户点按钮 → CopilotKit 的 useInterrupt 调
//          `runAgent({ agent, resume: [{ interruptId, status, payload }], runId })`
//          —— 注意它**复用同一个 AG-UI runId**
//       ④ 于是本文件的 run() 被第二次调用，这次 input.resume 非空
//          → 走 resumePending()：POST /resume，然后带 Last-Event-ID 重订阅
//
//   一次"审批"因此在界面侧表现为**两次 AG-UI run**，而不是一次长长的 run。
//   代价是两次之间的状态要自己记（backendRunIds / lastEventIds 三个 Map），
//   好处是界面不会在等人期间一直转圈 —— 那次 run 确实结束了。
//
// ⚠️ 第三条入口：**续订**一个已经在跑的运行（刷新 / 切回会话）
// ----------------------------------------------------
//   刷新页面（或切走再切回）时，界面这一侧的订阅断了，而后端的运行还在 ——
//   它可能在跑，也可能停在人工审批上等人回答。这时**不需要**再建一次运行：
//   从会话历史里就能推出最近一次的 run_id（消息行上带着它，见
//   useSessionHistory 的 resumeCandidateOf），直接订阅那次运行的事件流即可 ——
//   后端会**从头补发**，于是整轮内容与挂起的中断都回来了（审批卡自动重建）。
//
//   触发方式是 attachRun(runId) + 让 CopilotKit 再跑一次（见 RunResume.tsx）。
//   因为是"我们自己让 agent 再跑一次"，run(input) 从入参里看不出这次要续订，
//   所以用一个一次性标记告诉它 —— 见 openRun 的三个入口与 attachRun 的说明。
//
//   ⚠️ 重放会**多出一条**回答，所以订阅前得先把旧副本摘掉；而"摘下"这个动作的
//   时机是这里最容易做错的地方 —— 必须在 `runAgent()` **之前**（即 attachRun 里），
//   不能等第一帧到达。理由在 attachRun 的说明里，一句话：@ag-ui/client 在
//   `runAgent()` 里就克隆了一份 `agent.messages`，之后整份回写。
//
// ⚠️⚠️ 一次并行审批是**多条** hitl.requested，必须聚成一组再收流
// -------------------------------------------------------
//   后端的工具是**并行**执行的，每个停在审批上的工具各发一条 hitl.requested
//   （`_publish_hitl_requested` 是个 for 循环），而它们之间**没有**"这一组发完了"
//   的标记事件。所以这里按「静默窗口」切组（见 collectHitlGroup）：第一条中断
//   到来后开一个窗口，每来一条就往后推；窗口内没有新的就认为这组齐了，
//   把**整组**一次性交给翻译器。
//
//   为什么非得一次给整组（而不是来一条翻一条）：
//     · 翻译器一收到 hitl.requested 就发 `RUN_FINISHED { outcome: interrupt }`
//       并置 runFinished —— 逐条喂的话，第一帧就把这一轮收尾了，后面 N-1 条会被
//       丢掉，界面上只看得到一个待办；
//     · 而"整组**一次性声明**"正是 CopilotKit 攒齐答案、**一次**上报的前提
//       （它内部 InterruptState 是"全部答完才 buildResumeArray"）。
//
//   窗口到了就收流（abort 掉 SSE）：这条不能省 —— `runAgent` 要等 observable
//   **完结**才会走 onRunFinalized，而 CopilotKit 正是在那里把 interrupts 交给
//   useInterrupt 的。不收流，卡片永远不出现。
//
//   恢复那一轮因此带**整组**答案回来（`input.resume` 是数组），
//   而 `POST /resume` 的契约正是"一次回答当前所有待答项"
//   （`{ answers:[{interrupt_id,data}] }`，见 resumePending）。两边形状刚好对齐。

import {
  AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  randomUUID,
} from '@ag-ui/client';
import {
  catchError,
  concat,
  concatMap,
  defer,
  from,
  Observable,
  ReplaySubject,
  takeUntil,
  tap,
  throwError,
} from 'rxjs';
import {
  cancelRun,
  createRun,
  describeRuntimeError,
  isBenignCancelError,
  type ResumeAnswer,
  RUN_EVENT,
  type RunEventFrame,
  resumeRun,
  runEvents,
  statusOf,
} from './agentRuntime';
import {
  HITL_GROUP_WINDOW_MS,
  isHitlFrame,
  RunEventTranslator,
} from './runEventStream';

/**
 * 注册给 provider 的 agent 名。
 *
 * 用 'default' 而不是业务名：v1 的聊天组件默认就去找这个 id 的 agent，
 * 这样不必依赖 `agentId` 这个 v2 属性的行为（两边都设，等于双保险）。
 */
export const DOCK_AGENT_ID = 'default';

/**
 * 续订时"摘下来的旧回复"最多等多久的第一帧（见 detachReplayedReplies）。
 *
 * 为什么需要等：摘下来是为了让重放**重建**它（不摘的话重放会多出一条一模一样
 * 的回答）。但事件流有可能**一帧都没有** —— Redis 那条流的键是滑动 TTL
 * （24h，每次写入才刷新），一个停了太久、期间再没有新事件的运行，记录可能已经
 * 过期。那时重放补不回内容，必须把摘下来的放回去。
 *
 * 3 秒是个很宽的界：补发是"把已有记录一次性读出来"，第一帧按毫秒到达；
 * 而等待期间那条消息在界面上是**缺席**的，所以这个值也不能太大。
 */
export const REPLAY_GRACE_MS = 3000;

/** 多模态/结构化 content 里的文本部分。 */
function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object') {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * 从这一轮的完整消息列表里取出「用户最后说的那句话」。
 *
 * CopilotKit 每轮都会把**整条线**发过来，而 CreateRunRequest.input 只收这一轮
 * 用户说的话（图会把它包成一条 HumanMessage）—— 所以取最后一条 user 消息，
 * 不是把所有消息拼起来：历史由后端自己持有（会话 + thread checkpoint），
 * 前端不重复喂。
 */
export function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;

    const { content } = message;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content.map(partText).join('').trim();
    }
  }
  return '';
}

/**
 * 把「哪一步失败」钉进错误信息。
 *
 * 为什么必须做：**一句 `HTTP 404` 是没法排查的**。同样一个 404，可能是
 * 会话没了、运行没了、事件流端点没了，三种修法完全不同。步骤名 + 接口写进
 * 消息里，用户一眼就知道该去看哪儿。
 *
 * 注意这里丢掉原始 error 的形状（只留 message）：外层再调一次
 * describeRuntimeError 时不会再重复解析，也不会二次加前缀。
 */
function stepError(step: string, error: unknown): Error {
  return new Error(`${step}：${describeRuntimeError(error)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 `resolve(payload)` 交上来的东西收成后端要的 `data`。
 *
 * ⚠️ 为什么要"收"而不是原样传
 * -------------------------
 *   后端 `ResumeRequest.data` 必须是 dict（否则 422），而 `resolve(payload)`
 *   的类型是 `unknown` —— 卡片传 `{ decision: 'approve' }` 是我们自己的约定，
 *   但这条路径不该假设调用方一定守约定（将来还会有别的 HITL 卡片）。
 *
 *   规范化的产物**只用后端认的字段名**：
 *     dict 原样过（未来别的处理器有自己的形状，这里不该替它们裁剪）、
 *     bool / 裸字符串折成 `{ decision }`（approval.py 的 ApprovalDecision
 *     认这三种形状，见 agentRuntime.ts 的 ResumeAnswer）。
 *
 * ⚠️ 认不出来的一律**按拒绝**
 * -------------------------
 *   兜底给 `{ decision: 'reject' }`。后端 `ApprovalDecision.parse` 对认不出的
 *   形状也是拒绝（fail-closed）—— 两边同向：宁可这次工具不跑，也不要放行
 *   一个说不清的回答。
 */
export function resumeDecision(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) return payload;
  if (typeof payload === 'boolean') {
    return { decision: payload ? 'approve' : 'reject' };
  }
  if (typeof payload === 'string') return { decision: payload };
  return { decision: 'reject' };
}

/**
 * 这条消息是不是**某一次运行留下的助手回复**。
 *
 * 只有一个用途：续订（刷新/切回会话时接回一个还在跑的后端运行）时，
 * 把界面上那一轮的旧副本摘下来，好让事件流**从头补发**的内容把它重建出来 ——
 * 见 detachReplayedReplies。
 *
 * ⚠️ 为什么只认 assistant，不连用户那条一起清
 * ----------------------------------------
 *   事件流里只有助手的消息（message.delta / message.completed）。
 *   用户那一行是**建运行**时写进库的，由会话历史灌进来 —— 重放不会重建它。
 *   一起清掉的话，那一轮就永远少了一条提问（而且再看不出问的是什么）。
 *
 * `metadata.runId` 来自 history.ts 的 HistoryMeta —— 灌历史时按后端字段写进去的，
 * 所以这里有值就等于"这条消息属于后端的哪一次运行"。
 */
export function isReplayedReply(message: Message, runId: string): boolean {
  if (message.role !== 'assistant') return false;
  const meta = message.metadata as { runId?: unknown } | null | undefined;
  return meta?.runId === runId;
}

/**
 * 把「一次并行审批连着来的若干条 `hitl.requested`」收成一个批次。
 *
 * 输入：逐帧的后端事件；输出：**批次**（一批 1 帧，或者一组 N 帧的中断）。
 *
 * ⚠️ 为什么要按「静默窗口」切，而不是数一数
 * --------------------------------------
 *   后端工具是并行跑的，每个停在审批上的工具发一条 `hitl.requested`
 *   （`agent_run_dispatch.py::_publish_hitl_requested` 是个 for 循环），
 *   而**没有**"这一组发完了"的标记事件（枚举里只有 hitl.requested /
 *   hitl.resolved）。所以只能靠"安静多久算齐了"：第一条中断到来时开一个窗口，
 *   每来一条就往后推（debounce），窗口内没有新的就发出去。
 *   窗口每来一条就推后 —— 所以 N 条之间的间隔只要都小于 windowMs 就能聚成一组，
 *   与 N 的大小无关。
 *
 * ⚠️ 兜底：窗口到点就**收流**，这条不能省
 * -----------------------------------
 *   后端在等审批期间**不关流**（等审批不算终态），而 CopilotKit 要等这个
 *   observable **完结**才会走 onRunFinalized、把 interrupts 交给 useInterrupt ——
 *   卡片才会出现。所以"结束"必须由我们主动做。收流会连带 abort 掉 SSE 请求，
 *   不留悬挂连接（见 runEvents 的退订处理）。
 *
 * ⚠️ 窗口选小了会怎样
 * ----------------
 *   一组被切成两次：先只声明第一条。等用户答完它、运行恢复之后，后端会把
 *   **仍然挂着的**那几条重发，于是再聚一次、再弹一张卡 —— 用户多答几轮，
 *   但不会丢。⚠️ 不要指望"下一帧再并进同一张卡"：第一批一发出，收流就完成了
 *   （不收流卡片永远不出现），这一轮的流到此为止。取值理由见
 *   HITL_GROUP_WINDOW_MS。
 *
 * ⚠️ 第一帧中断**之前**的帧不算批次
 * ----------------------------
 *   审批往往跟在模型的一句话后面（message.delta / message.completed），
 *   那些要照常**逐帧**往下走（否则就不是流式了）。所以只有 hitl 帧才进组，
 *   其它帧一律"一帧一批"立刻下去。
 *   而一旦开始等审批，后面再来的一概不要 —— 运行已经停了。
 */
export function collectHitlGroup(
  windowMs: number,
): (source: Observable<RunEventFrame>) => Observable<RunEventFrame[]> {
  return (source) =>
    new Observable<RunEventFrame[]>((subscriber) => {
      let group: RunEventFrame[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;

      const clearTimer = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      /** 窗口到期（或源自己结束）：把攒下的一组交出去，然后完结。 */
      const flush = () => {
        clearTimer();
        if (group.length === 0) {
          subscriber.complete();
          return;
        }
        const batch = group;
        group = [];
        subscriber.next(batch);
        subscriber.complete();
      };

      const sourceSubscription = source.subscribe({
        next: (frame) => {
          if (isHitlFrame(frame)) {
            group.push(frame);
            // 每来一条把窗口往后推 —— debounce，不是固定计时
            clearTimer();
            timer = setTimeout(flush, windowMs);
            return;
          }
          // 已经在等审批了 —— 这是"我们已经决定收流"之后的东西，丢掉
          if (group.length > 0) return;
          // 还没开始等审批：一帧一批，立刻下去（保住流式）
          subscriber.next([frame]);
        },
        error: (error: unknown) => {
          clearTimer();
          subscriber.error(error);
        },
        complete: () => flush(),
      });

      return () => {
        clearTimer();
        sourceSubscription.unsubscribe();
      };
    });
}

export interface DockAgentDeps {
  /**
   * 确保当前对话在后端存在，返回 session_id。
   * 实现方负责「只在第一次发消息时建会话」以及把映射存下来（见 index.tsx）。
   */
  ensureSession: () => Promise<string>;
  /**
   * 丢弃本地缓存的会话、**重新建一个**并返回它的 id。
   *
   * 为什么需要它：会话 id 是落在本地存储里的（data.ts），后端换库 / 清库 /
   * 重启之后，那个 id 就成了死 id —— `POST /sessions/{id}/runs` 会 404。
   * 有了这个回调就能自愈一次，而不是让用户手动删会话。
   * 不给就是不自愈（退回一条带步骤名的错误）。
   */
  renewSession?: () => Promise<string>;
  /**
   * 审批聚合窗口（毫秒），默认 HITL_GROUP_WINDOW_MS。
   *
   * 只有测试需要动它：把窗口设成 0，同一批同步推下来的帧就必然聚成一组，
   * 断言与时间无关。生产用默认值 —— 那个数不是随便定的（见常量的注释）。
   */
  hitlGroupWindowMs?: number;
}

/**
 * 当轮上下文（见 DockAgent.activeRun）。
 *
 * ⚠️ `stop` 必须是 **ReplaySubject(1)**，不能是普通 Subject：
 *   用户可能在 createRun 还没返回时就点了停止（点得飞快）。Subject 是热的，
 *   那一刻的 next() 没有订阅者、会被丢掉 —— 于是那一轮**根本停不下来**，
 *   界面继续转、后端继续跑。ReplaySubject 会把它重放给后来的订阅者，
 *   takeUntil 一订阅就立刻收流（连 SSE 请求都不会发出去）。
 */
interface ActiveRun {
  /** AG-UI 的 runId（界面这一轮的标识，与后端 run_id 不是一回事）。 */
  agUiRunId: string;
  /** 后端 run_id —— 拿到之前是 null（openRun 还没返回的那种情况）。 */
  backendRunId: string | null;
  /** 叫停本地流的闸；next() 一下就等于"这一轮到此为止"。 */
  stop: ReplaySubject<void>;
  /** 已经点过停止（含"点的时候 run_id 还没拿到"这种早期请求）。 */
  stopRequested: boolean;
  /** cancel 请求是否已经发出过 —— 用户连点两下也只发一次。 */
  cancelSent: boolean;
}

/**
 * 面板用的 agent：一轮运行 = 建会话（首次）+ 建一次运行 + 订阅事件流。
 */
export class DockAgent extends AbstractAgent {
  private readonly deps: DockAgentDeps;

  /**
   * AG-UI 的 runId → 后端的 run_id。
   *
   * 中断恢复时要拿**后端的** run_id 去 `POST /runs/{run_id}/resume`，
   * 而恢复那一次调用里 CopilotKit 只给了 AG-UI 的 runId（它复用的就是上一个）。
   * 所以这个映射不是"缓存"，是恢复路径的唯一入口。
   */
  private readonly backendRunIds = new Map<string, string>();

  /** interrupt_id → 后端 run_id。恢复时优先用它：id 才是稳定键。 */
  private readonly backendRunIdsByInterrupt = new Map<string, string>();

  /**
   * 后端 run_id → 已消费的最后一帧 SSE id。
   *
   * ⚠️ 恢复时**必须**回填给 Last-Event-ID
   * -----------------------------------
   *   后端的流是**从头补发**的（不带头就从 start="0" 开始）。中断前那一轮我们
   *   已经渲染过了，恢复后再从头收一遍会把之前的话**重复发一次** —— 而且因为
   *   messageId 换了新的（见 RunStreamContext.streamId），重复出来的是两段
   *   气泡，不是覆盖。带上最后一帧的 id 就只收新帧。
   */
  private readonly lastEventIds = new Map<string, string>();

  /**
   * **当前正在跑的那一轮** —— 停止请求（abortRun）唯一的落点。
   *
   * 为什么必须自己记：cancel 要的是**后端** run_id，而 abortRun 是被库**同步**调用的
   * （stopGeneration → `agent.abortRun()`），它拿不到 run() 里的局部变量。
   * 所以在 run() 一进来就登记、整轮收尾时清掉。
   *
   * ⚠️ 只登记一个：面板同一时刻只可能有一轮在跑（有待办审批时输入框是禁用的，
   *   而审批那轮 our stream 早就收完了 —— 见 collectHitlGroup）。
   */
  private activeRun: ActiveRun | null = null;

  /**
   * 通知后端"这一轮不要了"（`POST /runs/{id}/cancel`），**同一轮只发一次**。
   *
   * 两个调用点，缺一不可 —— 用户可能在 createRun 还没返回时就点了停止：
   *   ① abortRun：点停止那一刻已经拿到 run_id（绝大多数情况）。
   *   ② run() 的 concatMap：点停止时还没拿到、这一刻才拿到 —— 不补这一次的话，
   *      后端那个 run 会在界面上已经"停干净"之后继续跑下去（烧 token、调工具），
   *      而且**没有任何东西会再提它**（刷新页面它也不会自己消失）。
   *      这是本轮真踩的设计漏洞：两条路径都得走这里。
   *
   * 失败处理见 agentRuntime.cancelRun 的注释：404/409 静默，其余只 console.warn。
   */
  private requestBackendCancel(current: ActiveRun): void {
    const backendRunId = current.backendRunId;
    // 还没拿到 id：这一刻还发不了（调用点会等拿到后重试一次）。
    if (!backendRunId) return;
    if (current.cancelSent) return;
    current.cancelSent = true;

    void cancelRun(backendRunId).catch((error: unknown) => {
      // 404/409 是**正常**的：运行已经结束、或它停在审批上（那种情况该走
      // resume 回答 reject）。这类不用打扰用户 —— 见 isBenignCancelError。
      if (isBenignCancelError(error)) return;
      console.warn(
        `[CopilotDock] 已通知后端取消 ${backendRunId}，但请求失败（界面已停止，后端可能还在跑）`,
        error,
      );
    });
  }

  /** 一次并行审批的聚合窗口（见 collectHitlGroup / HITL_GROUP_WINDOW_MS）。 */
  private readonly hitlGroupWindowMs: number;

  /**
   * 下一次 run() 要**续订**的后端 run_id（一次性指令，读完立刻清空）。
   *
   * 「刷新后把还在跑的运行接回来」不是用户动作触发的，是我们自己让 agent
   * 再跑一次（见 RunResume.tsx）—— 而 `run(input)` 从入参里看不出"这次是去续订"
   * （`input.resume` 只表示"在答审批"），所以用一个显式标记告诉它。
   */
  private attachRunId: string | null = null;

  /**
   * 续订前从界面上**摘下来**的旧助手回复 —— 见 detachReplayedReplies。
   *
   * 非空 = 这一轮是续订，而且"摘下来"的内容还没被重放的帧接上。两种结局：
   *   · 事件流**任何一帧**到达（记录还在、重放进行中）→ 丢掉备份（settle）；
   *   · 到点还没有任何帧 → 说明这条流的记录已经过期（Redis 键是滑动 TTL 24h），
   *     重放补不回内容 → **放回去**（restore），至少别让用户的内容凭空消失。
   *
   * 注意"帧"指**真事件**：心跳（`: ping`）在 SseDecoder 里就被剥掉了，
   * 不会走到 tap —— 所以"只有心跳"的流不会把备份骗掉。
   */
  private replayBackup: Message[] | null = null;

  /** 备份对应的 run_id（守卫用：只有同一个 run 的第一帧才算"流是活的"）。 */
  private replayRunId: string | null = null;

  /** 备份是从第几条开始摘的 —— 放回去时原位插回，不改变消息顺序。 */
  private replayAt = 0;

  /** 等第一帧的兜底定时器（见 REPLAY_GRACE_MS）。 */
  private replayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: DockAgentDeps) {
    super({
      agentId: DOCK_AGENT_ID,
      description: 'YTraderHarness 会话/运行接口 + 事件流（SSE）',
    });
    this.deps = deps;
    this.hitlGroupWindowMs = deps.hitlGroupWindowMs ?? HITL_GROUP_WINDOW_MS;
  }

  /**
   * 让**下一次** run() 去续订这个已经在后端跑着的运行，而不是建一次新的。
   *
   * 场景（需求原话：「刷新后第一次打开某个 conversation，自动检测有无在跑的
   * 实例，有则直接订阅」）：刷新页面或切走再切回时，界面这一侧的订阅已经断了，
   * 但**后端的运行还在** —— 它可能在跑，也可能停在人工审批上等人回答。
   * 调用方先从会话历史里推出 run_id（useSessionHistory 的 resumeCandidateOf），
   * 再调这里、然后触发一次 `runAgent({ agent })`（见 RunResume.tsx）。
   *
   * ⚠️ 标记是**一次性**的，且必须在 run() 的**同步段**消费掉
   * ----------------------------------------------------
   *   留在身上会出事：下一轮用户真发消息时会被这个残留的标记劫持成"续订上次
   *   那个运行"—— 用户的新问题根本没提交上去，而界面上还看不出所以然。
   *   所以是"读走即清"，不是"用完再清"：即便这次没订阅成，也不会污染下一轮。
   *
   * 优先级：`input.resume` 非空（用户在答审批）> 续订标记 > 建新运行。
   * 答审批那一轮 CopilotKit 会**复用同一个 runId** 再跑一次，绝不能按续订处理
   * （那会把回答丢掉、重新播一遍旧内容）。
   *
   * ⚠️ 顺带**当场**把界面上那一轮的旧助手回复摘下来（detachReplayedReplies）
   * -----------------------------------------------------------------
   *   为什么必须在这个函数里摘，而不是等"第一帧到达、确认流是活的"再摘 ——
   *   这是踩过的坑，根因在 @ag-ui/client 里：
   *
   *     `runAgent()` 一进来就 `prepareRunAgentInput()` 克隆了 `agent.messages`，
   *     紧接着装配 apply 算子时又 `const o = structuredClone(agent.messages)`
   *     （defaultApplyEvents），此后每一帧都往这份克隆里改，并在
   *     RUN_STARTED / 各事件上**整份回写** `agent.messages`。
   *
   *   也就是说：run() 被订阅**之后**再改 `agent.messages`，改动会被那份克隆
   *   覆盖回去。CDP 实测（esbuild 探针页，做法见 skill §11h/§14b）就是这一幕：
   *   第一帧到达时清了旧副本，最后 `agent.messages` 仍然是
   *   `[用户那条, 旧副本, 新回复]` —— 界面上同一段回答出现两次。
   *   摘的时机只能是 `runAgent()` 之前，也就是这里。
   *
   *   副产物：`replayBackup` 的兜底定时器也从这里开始计时，于是"runAgent 抛了、
   *   根本没订阅成"这种情况也有机会把内容放回去（见 detachReplayedReplies）。
   */
  attachRun(backendRunId: string): void {
    this.attachRunId = backendRunId;
    this.detachReplayedReplies(backendRunId);
  }

  /**
   * 丢掉还没被消费的续订标记。
   *
   * ⚠️ 为什么需要它（2026-10-17 踩实）
   * -------------------------------
   *   标记只在 `run()` 的**同步段**被读走才清（见上面"读走即清"那条）。而
   *   `RunResume` 是 `attachRun()` 之后再去 `copilotkit.runAgent()` —— 后者
   *   一旦**同步抛**（典型："已经有一个 run 在跑"），或者压根没走到 `agent.run()`，
   *   标记就留在身上了。下一次用户真发消息会被它劫持成"续订那个旧运行"：
   *   新消息**根本没提交**，界面上只留一句"运行不存在"（旧 run 早就没了）。
   *
   *   刷新能治好这件事，正是因为内存里的标记随页面一起没了 —— 典型
   *   「偶发报错 + 刷新就好」。所以续订尝试**落定之后**（成功/失败都算）
   *   必须回来清一次：成功时它是空操作（早被消费），失败时它才是修 bug 的那一下。
   */
  clearAttach(): void {
    this.attachRunId = null;
  }

  /**
   * 一轮的事件流。三段 concat，顺序是协议要求的：
   *
   *   RUN_STARTED → （事件流翻出来的事件…）→ 收尾（关消息 + RUN_FINISHED）
   *
   * 每段都写成 `defer(...)`：真正的动作发生在**订阅时**，不是调用 run() 时 ——
   * 由谁订阅、什么时候订阅是 CopilotKit 决定的，提前干活等于白干一次。
   *
   * ⚠️ 中段是**一批一批**往下走的，不是一帧一帧
   * --------------------------------------
   *   普通帧是一批 1 帧（保住流式）；一次并行审批连着来的那几条 hitl.requested
   *   是一批 N 帧（见 collectHitlGroup）—— 必须整批一次交给翻译器，它才能发出
   *   一个带 `interrupts: [...N]` 的 RUN_FINISHED，用户也就只需要答一张卡。
   *
   * ⚠️ 这个方法一次"审批"会被调用**两次**（见文件头的四条链路）：
   *   第一次是提问、第二次是带回答案。两次共用一个 AG-UI runId。
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    // AG-UI 的 runId 与后端的 run_id 是两回事：前者是界面这一轮的标识，
    // 后者是订阅事件流的地址。别拿一个当另一个用。
    const runId = input.runId ?? randomUUID();

    /**
     * 续订意图在**同步段**就地消费（见 attachRun）：读走即清，绝不留到下一轮。
     * 放在这里而不是 openRun 里，是因为 openRun 在 `defer` 里跑 —— defer 保证
     * 动作发生在订阅时，但"标记有没有被用掉"必须与调用 run() 同步决定。
     */
    const attachRunId = this.attachRunId;
    this.attachRunId = null;

    const translator = new RunEventTranslator({
      threadId: input.threadId,
      runId,
      // 恢复会复用 runId，所以消息 id 还得再带一层这次流自己的标
      // （否则恢复后的文字会和中断前那段撞 id、被静默合并）
      streamId: randomUUID(),
    });

    /**
     * 本轮上下文。**一进来就登记**（而不是等 openRun 返回）——
     * 用户可能在 createRun 还没回来时就点了停止，那时 stopRequested 就得先记下来，
     * 等拿到 run_id 再照着做（见 abortRun）。
     */
    const current = {
      agUiRunId: runId,
      backendRunId: null as string | null,
      stop: new ReplaySubject<void>(1),
      stopRequested: false,
      cancelSent: false,
    };
    this.activeRun = current;

    return concat(
      // ① 开头：界面立刻进入「正在运行」
      from(translator.start()),

      // ② 中段：建运行（或回答审批 / 续订已有的运行）→ 订阅 SSE → 逐帧翻译
      defer(() => from(this.openRun(input, runId, attachRunId))).pipe(
        concatMap((backendRunId) => {
          // 拿到后端 run_id 的这一刻就是"可以 cancel 了"的时刻。
          // ⚠️ 必须**先记 id 再 return**：用户在这之后点停止，abortRun 要靠它。
          current.backendRunId = backendRunId;
          // 翻译器也要知道：它给每个工具事件打的 `runId` 就是从这里来的
          // （裁决恢复前后属不属于同一次运行，见 ToolActivityPayload.runId）。
          translator.setBackendRunId(backendRunId);
          // 已经点过停止（点得比建运行还快）→ 现在就收流，并且**补发那次 cancel**
          // （abortRun 当时拿不到 id 就返回了，cancel 只在这里发得出去 ——
          //  不补的话后端那个 run 会在界面停干净之后继续跑，且没人再提它）。
          if (current.stopRequested) {
            current.stop.next();
            this.requestBackendCancel(current);
          }
          return runEvents(backendRunId, {
            lastEventId: this.lastEventIds.get(backendRunId),
          }).pipe(
            catchError((error: unknown) =>
              throwError(() =>
                stepError('订阅事件流（GET /runs/{run_id}/events）', error),
              ),
            ),
            // 先记账（最后一帧 id、interrupt→run 的映射），再决定要不要收流 ——
            // 记账要看**每一帧**（包括整组中断里的每一条，回来恢复时要用它们
            // 的 interrupt_id 找 run），而收流只看这一组什么时候齐。
            //
            // 顺带结清续订那一次"摘下"：**真事件的第一帧**到达说明流是活的
            // （后端会从头补发），备份从此可以丢掉了 —— 见 settleReplayedReplies
            // （非续订轮、或已经结清，它都是空操作）。
            // 注意心跳不算帧（SseDecoder 把 `: ping` 就剥掉了），所以"只有心跳"
            // 骗不掉备份 —— 那种情况要留给兜底定时器把内容放回去。
            tap((frame) => {
              this.rememberFrame(backendRunId, frame);
              this.settleReplayedReplies(backendRunId);
            }),
            // ⚠️ 看到 hitl.requested 就收流（见 collectHitlGroup），而且要把
            //   并行工具连着来的那几条一起收成**一批** —— 一批只声明一次中断组，
            //   才可能出现"一次答完、一次上报"。
            collectHitlGroup(this.hitlGroupWindowMs),
            // 停止闸。用户点「停止」→ abortRun 让这个 stop 发一下 → ② 整段收尾
            //   → ③ 的 finish() 补 RUN_FINISHED → 界面退出「正在生成」。
            // ⚠️ 放在 collectHitlGroup **之后**：它要能掐断整条 SSE，
            //   而不只是"不再等下一组审批"。
            // ⚠️ 退订会让 runEvents 内部 abort 掉 fetch（见它的 teardown），
            //   所以连接不会悬着。
            takeUntil(current.stop),
          );
        }),
        // 一帧后端事件可能对应 0~N 条 AG-UI 事件，所以摊平；
        // 一批（中断组）必须**整批一次**交给翻译器 —— 它才能发出一个带
        // `interrupts: [...N]` 的 RUN_FINISHED（见 pushChunk 的说明）。
        concatMap((chunk) => from(translator.pushChunk(chunk))),
        // 这一段里任何错误（建会话 / 建运行 / 回答审批 / SSE 请求 / 读流中断）
        // 都收敛成一条能读的消息，然后照常往下走 —— 不让 UI 卡在「正在运行」
        catchError((error: unknown) =>
          from(translator.fail(describeRuntimeError(error))),
        ),
      ),

      // ③ 收尾：流自然结束但没见终态事件时补一句，然后 RUN_FINISHED
      //    （终态事件已经发过 RUN_FINISHED 的话 —— 包括中断那次 —— 这里返回空数组）
      defer(() => {
        /*
         * 用户点过停止 → 这一轮是**我们自己**掐断的，不是"流莫名断了"。
         *
         * ⚠️ 为什么要放在**这里**、而不是 abortRun() 里直接标：
         *   translator 是 run() 的局部变量，abortRun 拿不到它。
         *   而 ③ 是所有收尾路径（正常结束 / 出错 / 被停止）**必然**经过的地方 ——
         *   在这里判断一次就覆盖了全部路径，漏不掉。
         *   （第一版把 markStoppedByUser() 放在 run() 的 concatMap 里，
         *   结果只有"点得比 createRun 还快"那条路径会标 —— 正常路径反而漏了，
         *   用户亲手停的运行照样被补一句"可能还没跑完"。测试是钉出来的。）
         */
        if (current.stopRequested) translator.markStoppedByUser();
        // 本轮到此为止：把 stop 的订阅者都释放掉，并且**只在还是这一轮**时才清。
        // （续订/回答审批会再调一次 run()，那时这里早该清干净了。）
        current.stop.complete();
        if (this.activeRun === current) this.activeRun = null;
        return from(translator.finish());
      }),
    );
  }

  /**
   * 停止这一轮 —— 库的「停止生成」按钮最终会走到这里。
   *
   * 链路：Composer's `onStop` → CopilotChat 的 `stopGeneration`
   *   → `agent.abortRun()`（@copilotkit/react-core 与 @ag-ui/client 之间的约定）。
   * ⚠️ 基类 `AbstractAgent.abortRun()` 是**空实现**（它就是个留给子类接的扩展点，
   *   HttpAgent 才在里面 abort 自己的 fetch）。不接这个方法，点暂停什么都不会发生。
   *
   * 做两件事，缺一不可：
   *   ① **本地收流**：让 stop 发一下 → ② 段 takeUntil 收尾 → 界面退出「正在生成」。
   *      只做 ② 的话界面会一直转下去，用户点了跟没点一样。
   *   ② **通知后端 cancel**：只做 ① 的话后端那个 run 还在跑（还会继续烧 token、
   *      继续调工具），刷新页面它又冒出来了。cancel 是异步的，所以它返回时
   *      界面早已停下来 —— 这是"界面不等后端"的乐观停止。
   *
   * ⚠️ 为什么 cancel 失败只落 console：见 agentRuntime.cancelRun 的说明 ——
   *   界面已经停了，这时候往对话里插"取消失败"只会让人莫名其妙。
   */
  abortRun(): void {
    // 基类现在是空的，但别假设它永远空着（升级 @ag-ui/client 就可能带实现）。
    super.abortRun();

    const current = this.activeRun;
    if (!current) return;

    current.stopRequested = true;
    // ReplaySubject：哪怕没人订阅（run_id 还没拿到）这次 next() 也会被记住，
    // 等 ② 段订阅时立刻生效。见 ActiveRun 的注释。
    current.stop.next();

    const backendRunId = current.backendRunId;
    if (!backendRunId) {
      // 还没拿到 run_id：这一轮刚发出去，用户点得比 createRun 还快。
      // 那就等它回来 —— run() 的 concatMap 里看到 stopRequested 会收流并补发 cancel。
      return;
    }
    this.requestBackendCancel(current);
  }

  /**
   * 拿到**这次要订阅的**后端 run_id。三个入口，优先级是固定的：
   *
   *   ① `input.resume` 非空 → 回答审批（resumePending），**不建会话也不建运行**。
   *      那是 AG-UI 协议里"我这次是在回答上面的中断"的标记，由 CopilotKit 的
   *      useInterrupt 填上。
   *   ② `attachRunId` 有值 → **续订**一个已有的运行（reopenRun）。它来自
   *      RunResume.tsx：刷新/切回会话时从历史里推出了一个没跑完的 run_id。
   *      必须排在 ① 之后 —— 答审批那一轮 CopilotKit 复用同一个 runId 再来一次，
   *      按续订处理会把回答丢掉。
   *   ③ 都没有 → 新的一轮（建会话 + 建运行）。
   *
   * ⚠️ `input.resume` 是**数组**：一次并行审批答完之后，CopilotKit 会把整组
   *   答案一起送回来（它内部攒到"每个待办都答过"才调 runAgent）。所以这里
   *   不能只看 `[0]` —— 那样 N-1 个回答会被静默丢掉。
   */
  private async openRun(
    input: RunAgentInput,
    agUiRunId: string,
    attachRunId: string | null,
  ): Promise<string> {
    const resumes = input.resume ?? [];
    if (resumes.length > 0) return this.resumePending(agUiRunId, resumes);
    if (attachRunId) return this.reopenRun(attachRunId);

    let sessionId: string;
    try {
      sessionId = await this.deps.ensureSession();
    } catch (error) {
      throw stepError('建会话（POST /sessions）', error);
    }

    const userText = lastUserText(input.messages);
    if (!userText) throw new Error('这一轮没有用户消息，没什么可提交的');

    try {
      return await this.submitRun(agUiRunId, sessionId, userText);
    } catch (error) {
      // 会话在后端已经不存在了（本地缓存的是个死 id）→ 重建一次再试。
      // 只重试一次：连着失败说明不是"缓存过期"这回事，别把后端打爆。
      if (statusOf(error) !== 404 || !this.deps.renewSession) {
        throw stepError('建运行（POST /sessions/{id}/runs）', error);
      }

      let fresh: string;
      try {
        fresh = await this.deps.renewSession();
      } catch (renewError) {
        throw stepError('重建会话（原会话在后端已不存在）', renewError);
      }

      try {
        return await this.submitRun(agUiRunId, fresh, userText);
      } catch (retryError) {
        throw stepError('用新会话重新建运行', retryError);
      }
    }
  }

  /**
   * 提交这一轮，返回后端 run_id —— 它就是事件流的订阅地址。
   *
   * `trace_id` 由前端生成（后端只接受一个字符串，不会替我们造）：
   * **一次运行一条 trace**，用 v4 uuid，与 run_id 分开 —— run_id 是后端的落库主键，
   * trace_id 是"这次执行写了哪些 span/事件"的聚合键，前者要等响应才有，后者必须在
   * **请求发出前**就定下来，所以不能拿 run_id 兼任。
   *
   * 三个刻意的选择：
   *
   * 1. **每次 `submitRun` 都新造一个**（不是会话级常量）。理由是 trace 的语义是
   *    "一次端到端执行"：同一会话里第 2 轮跑的是另一套上下文，混进同一条 trace
   *    只会让 `trace:<id>:events` 越滚越长、还得靠 `run_id` 二次筛。要会话级聚合
   *    就把 `randomUUID()` 提到 `ensureSession()` 那一层缓存起来（后端明确支持跨
   *    run 复用），但别在这里悄悄改成常量 —— 那样两条并发的运行会写同一个键。
   * 2. **resume / cancel 不传**：这两条路不收这个字段，后端派发时读运行行里存下的
   *    那个（见 `CreateRunRequest.trace_id` 注释第 3 条），审批之后的事件因此仍落在
   *    同一条 trace 里 —— 前端不用、也没法在这里续。
   * 3. **404 重试会换一个新 id**：那次请求在"会话不存在"就 404 了，运行行根本没落，
   *    也就没写任何 trace 事件；沿用旧 id 只会得到一个"只有后半段"的键，反而更难读。
   *
   * ⚠️ 空串等于没传（后端 `.strip() or None`），所以这里绝不"兜底成空串" ——
   *    要开就开，要关就不发这个键。
   */
  private async submitRun(
    agUiRunId: string,
    sessionId: string,
    text: string,
  ): Promise<string> {
    const run = await createRun(sessionId, {
      input: { text },
      trace_id: randomUUID(),
    });
    this.backendRunIds.set(agUiRunId, run.run_id);
    return run.run_id;
  }

  /**
   * 续订一个**已经在后端跑着**的运行：不建会话、不建运行，直接订阅它的事件流。
   *
   * 这就是「刷新后第一次打开某个 conversation，检测到有在跑的实例就直接订阅」
   * 的落点。判据在 useSessionHistory，触发在 RunResume.tsx，这里只负责把
   * run_id 交回给订阅那一段。
   *
   * ⚠️ 必须丢掉这个 run 的 Last-Event-ID
   * ---------------------------------
   *   带着它只收"上次之后"的新帧，而界面上的旧内容我们正要摘掉
   *   （见 detachReplayedReplies）—— 那就会重建出半句话，比不重建更糟。
   *   丢掉 = 后端 `start="0"` **从头补发**，整轮重放，界面才拼得回来。
   *
   * ⚠️ 订阅本身就是"存活探测"，不需要先问一次"还在跑吗"
   * ----------------------------------------------
   *   `GET /runs/{run_id}/events` 的三种响应自带区分度：404 = 这次运行没了
   *   （判据是库里那行，不是 Redis 键 —— 见后端 stream_run_events 的说明）；
   *   200 且很快补发终止帧 = 已经跑完（重放一遍后关流）；
   *   200 且流挂着不关 = 还在跑 / 停在人工审批（重放会把 hitl.requested 带回来，
   *   卡片因此能自动重建）。所以不需要额外接口来回答"有没有在跑的实例"。
   *
   *   ⚠️ 404 不会立刻报错：建流那一次会先重试 3 次 × 500ms
   *   （见 agentRuntime.STREAM_404_MAX_RETRIES）。刚 `POST /runs` 完的运行，
   *   **响应是在事务提交之前发出去的**，立刻订阅必然查不到 —— 那条路径
   *   靠这个重试兜住；这里"续订一个真没了的运行"也只是多等 1.5 秒。
   */
  private async reopenRun(backendRunId: string): Promise<string> {
    this.lastEventIds.delete(backendRunId);

    // 摘旧副本这件事**已经**在 attachRun 里做过了（必须早于 runAgent，见那里）。
    // 这里再叫一次只为一件事：把兜底定时器**从"真的开始订阅"这一刻重新计时** ——
    // attachRun 到订阅之间还要经过 CopilotKit 的 runAgent 装配，这段时间不该算进
    // REPLAY_GRACE_MS。已经是同一个 run 时它是幂等的（detachReplayedReplies 里
    // 有 replayRunId 守卫，不会再动 setMessages）。
    this.detachReplayedReplies(backendRunId);
    return backendRunId;
  }

  /**
   * 续订前，把界面上那一轮的旧助手回复**摘下来**（不删，存进 replayBackup）。
   *
   * ⚠️ 为什么是"摘"而不是"清"
   * ----------------------
   *   事件流可能**一帧都没有**：Redis 那条流的键是滑动 TTL 24h
   *   （event_stream.yaml 的 ttl_seconds，每次写入才刷新），一个停了很久、
   *   期间再没有新事件的审批，它的记录可能已经过期 —— 那时订阅只会收到心跳。
   *   真删掉的话，用户会看到回答**凭空消失**（旧副本没了、重放又没有内容），
   *   而且这个页面里再也拿不回来。所以先存着：确定"流是活的"再丢
   *   （settleReplayedReplies），到点还没动静就放回去（restoreReplayedReplies）。
   *
   * ⚠️ 为什么必须摘掉旧的（而不是留着让它俩并存）
   * ----------------------------------------
   *   重放出来的助手消息 id 里带着**这次流自己的** streamId
   *   （见 runEventStream 的 RunStreamContext）—— 跟旧副本不是同一个 id，
   *   client 不会覆盖，只会**新增一条**。不摘就是两条一模一样的回答。
   *
   * ⚠️ 调用时机：必须早于 `runAgent()`（所以挂在 attachRun 里），不能等第一帧
   * ------------------------------------------------------------
   *   原因见 attachRun 的说明：@ag-ui/client 的 apply 算子会在 runAgent 那一刻
   *   克隆一份 agent.messages，之后整份回写 —— 晚于它的任何修改都会被覆盖。
   *
   * 只摘 assistant、保留用户那一条（理由见 isReplayedReply）。没有旧副本时
   * （最后一条是用户消息 = 那一轮还在跑、助手那条还没落库）它什么都不做 ——
   * 那种情况重放出来的内容不会跟任何东西重复。
   */
  private detachReplayedReplies(backendRunId: string): void {
    // 同一个 run 重复进来（attachRun → reopenRun 那一跳）：已经摘过了就别再碰
    // setMessages（反复整份替换会让界面白闪一下），只把兜底计时重新起算。
    if (this.replayRunId === backendRunId) {
      this.armReplayRestore(backendRunId);
      return;
    }

    // 换了个目标：上一份备份属于另一个 run，而这次不再等它的帧了 ——
    // 先放回去，别让上一轮的内容因为我们换了方向而凭空消失。
    // （真实路径走不到：一个会话一个 agent 实例、RunResume 也是只跑一次；
    //  这里是防御性的，代价最多是多一次 setMessages。）
    this.restoreReplayedReplies();

    const removed = this.messages.filter((message) =>
      isReplayedReply(message, backendRunId),
    );
    if (removed.length === 0) return;

    // 先记状态再 setMessages：setMessages 会同步通知订阅者（触发 React 重渲染），
    // 状态要是还没写，那一刻读到的就是"摘了但不知道摘给谁、也不知道往哪放"。
    this.replayAt = this.messages.findIndex((message) =>
      isReplayedReply(message, backendRunId),
    );
    this.replayBackup = removed;
    this.replayRunId = backendRunId;

    this.setMessages(
      this.messages.filter(
        (message) => !isReplayedReply(message, backendRunId),
      ),
    );
    this.armReplayRestore(backendRunId);
  }

  /**
   * 起／重起「等第一帧」的兜底定时器：到点还没有帧就把备份放回去。
   *
   * 两个调用点都是刻意的：attachRun 覆盖"runAgent 抛了、根本没订阅成"，
   * reopenRun 把窗口对齐到真正开始订阅的那一刻。
   */
  private armReplayRestore(backendRunId: string): void {
    if (this.replayTimer !== undefined) clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(() => {
      this.replayTimer = undefined;
      // 期间已经结清（帧到了）或换了目标 → 什么都不做。
      if (this.replayRunId !== backendRunId) return;
      this.restoreReplayedReplies();
    }, REPLAY_GRACE_MS);
  }

  /**
   * **真事件的第一帧**到达 —— 流是活的，重放会把那一轮（重新）画出来，
   * 备份从此可以丢掉。非续订轮、或已经结清时，它都是空操作。
   *
   * 为什么"心跳不算"：SseDecoder 直接把 `: ping` 那种注释行丢掉了（parseSseBlock
   * 返回 null），tap 根本收不到 —— 于是"记录已过期、只剩心跳"的流不会把备份骗掉。
   */
  private settleReplayedReplies(backendRunId: string): void {
    if (this.replayRunId !== backendRunId) return;

    if (this.replayTimer !== undefined) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }
    this.replayBackup = null;
    this.replayRunId = null;
  }

  /**
   * 把摘下来的旧回复**原位放回去**（兜底：流一帧都没有，或换了续订目标）。
   *
   * 原位 = detach 时记下的 replayAt。期间 agent 里可能被别的东西追加过
   * （订阅失败时翻译器写的那条说明），所以位置夹一下；已经在那儿的 id 跳过，
   * 避免真出现重复条目。
   */
  private restoreReplayedReplies(): void {
    if (this.replayTimer !== undefined) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }

    const backup = this.replayBackup;
    this.replayBackup = null;
    this.replayRunId = null;
    if (!backup || backup.length === 0) return;

    const present = new Set(this.messages.map((message) => message.id));
    const missing = backup.filter((message) => !present.has(message.id));
    if (missing.length === 0) return;

    const restored = [...this.messages];
    restored.splice(Math.min(this.replayAt, restored.length), 0, ...missing);
    this.setMessages(restored);
  }

  /**
   * 回答人工审批（**一次带上当前所有**待答项），返回要继续订阅的后端 run_id。
   *
   * ⚠️ 这是"再订阅一次同一个后端运行"，不是"开一次新运行"
   * ---------------------------------------------------
   *   后端把回答接到同一个 thread 上继续跑，所以 run_id 不变、事件也写进
   *   同一条 Redis 流。靠 `lastEventIds` 回填 Last-Event-ID 只收新帧。
   *
   * ⚠️ 为什么是"一次全部"，而且**只有一个请求**
   * ---------------------------------
   *   `resumes` 是 CopilotKit 攒齐之后一次送来的整组答案（并行工具各停一次）。
   *   后端 `ResumeRequest` 的模型就是"把手上所有待答的一次性回掉"：
   *   它会读 checkpoint 里**真实**的 pending 集合与 `answers` 比对，
   *   **少一个或给多了都 409**。
   *   所以：① 不能循环发（恢复派发之后运行不再 waiting_input，后面几条全撞 409）；
   *        ② 也不能只发第一条（少给的那个会静默留在待办里，而这次请求返回 200
   *           —— 一次"成功"的什么都没推进，这是最阴的失败）。
   *
   * ⚠️ 成功返回的是**后端的 run_id**，不校验回答有没有被受理
   * ---------------------------------------------------
   *   真正的生效与否由接下来的流说话：`hitl.resolved` + message.delta 就是生效；
   *   再来一条 `hitl.requested`（同一批 id）就是没生效 —— 那时翻译器会照常把
   *   卡片再渲染出来，用户能再答一次。这是刻意的：与其在这里猜，
   *   不如让界面如实反映后端的状态。
   */
  private async resumePending(
    agUiRunId: string,
    resumes: NonNullable<RunAgentInput['resume']>,
  ): Promise<string> {
    // 优先按 interrupt_id 找（稳定键）；AG-UI 的 runId 只是兜底。
    // 一组里的每个中断都指向**同一个** run，所以任取一个能找到的就行 ——
    // 用 map+find 而不是只看第一个：第一条要是没记账（比如它其实是
    // 上一组遗留的），后面的还能救回来。
    const backendRunId =
      resumes
        .map((resume) => this.backendRunIdsByInterrupt.get(resume.interruptId))
        .find((id): id is string => Boolean(id)) ??
      this.backendRunIds.get(agUiRunId);

    if (!backendRunId) {
      throw new Error(
        '找不到这次审批对应的运行。中断与运行的对应关系只存在内存里，' +
          '刷新页面就会丢 —— 正常路径下刷新后会自动续订那次运行、' +
          '从补发的 hitl.requested 里把映射重建出来（见 RunResume.tsx）。' +
          '走到这里还找不到，说明这组中断不是经由事件流交给界面的。',
      );
    }

    // `cancelled`（用户点了"取消"）没有 payload → resumeDecision 落成拒绝。
    // 这一条不能省：后端要求 `answers` **正好覆盖** pending 集合，
    // 少一条就是 409 —— 而什么都不发的话，这个会话会永远停在 waiting_input，
    // 期间**建不了新运行**（后端 409），等于锁死会话。
    const answers: ResumeAnswer[] = resumes.map((resume) => ({
      interrupt_id: resume.interruptId,
      data: resumeDecision(resume.payload),
    }));

    try {
      await resumeRun(backendRunId, { answers });
    } catch (error) {
      // 409 有两种含义（后端 docstring 明写），文案要同时覆盖：
      //   ① 这次运行已经不在 waiting_input —— 多半是"同一个回答提交了两次"
      //      （连点、或页面重连后又答了一次），那是**正常**情形；
      //   ② `answers` 与当前 pending 集合对不上 —— 丢了一条 `hitl.requested`
      //      （聚合窗口切早了、或中途断了流），客户端手上的集合是过期的。
      if (statusOf(error) === 409) {
        throw stepError(
          '回答这次审批（POST /runs/{run_id}/resume）—— 这个回答之前受理过、这次运行已经不在等人回答，' +
            '或者这一组回答与后端当前等待的审批对不上（可能漏收了一条中断）',
          error,
        );
      }
      throw stepError('回答这次审批（POST /runs/{run_id}/resume）', error);
    }

    // 用掉了就清掉，免得同一批中断被记住太久
    for (const resume of resumes) {
      this.backendRunIdsByInterrupt.delete(resume.interruptId);
    }
    return backendRunId;
  }

  /** 记两笔账：最后一帧 SSE id（恢复时回填）、以及 interrupt → run 的映射。 */
  private rememberFrame(backendRunId: string, frame: RunEventFrame): void {
    if (frame.id) this.lastEventIds.set(backendRunId, frame.id);

    if (frame.event !== RUN_EVENT.HITL_REQUESTED) return;

    const { interrupt_id: interruptId } = frame.data;
    if (typeof interruptId === 'string' && interruptId) {
      this.backendRunIdsByInterrupt.set(interruptId, backendRunId);
    }
  }
}
