// src/components/CopilotDock/agentRuntime.ts
//
// 对接 YTraderHarness 的 Agent Runtime API（契约：app/services/session/session.yaml v1.0.0）。
//
// 接**后端已经实现**的端点（见 app/api/v1/sessions.py）：
//
//   POST /api/v1/sessions                    建会话
//   GET  /api/v1/sessions/{session_id}       查会话
//   POST /api/v1/sessions/{session_id}/runs  建运行
//   GET  /api/v1/runs/{run_id}/events        订阅这次运行的事件流（SSE）
//   POST /api/v1/runs/{run_id}/resume        回答人工审批（HITL）：**一次带上
//                                            当前所有**待答项（见 resumeRun）
//   GET  /api/v1/sessions/{session_id}/messages  取会话历史（契约见 messages.yaml）
//
// 事件流是**传输层**，只负责「把 SSE 帧收下来、解析成对象」；
// 怎么把领域事件翻成 AG-UI 事件是 runEventStream.ts 的事，两者别混。
//
// ⚠️ 后端事件名是**领域名**，不是 AG-UI 的 EventType
// ------------------------------------------------
//   app/common/event/event.py 的 RunEventType 取值是 `run.started` /
//   `message.delta` / `message.completed` / `run.completed` / `run.failed` …
//   而 AG-UI 是 RUN_STARTED / TEXT_MESSAGE_CONTENT / RUN_FINISHED。
//   两套词表一一对应但不是一回事，翻译在 runEventStream.ts 里做。
//
// ⚠️ 为什么不用 EventSource
// ------------------------
//   ① 它的重连是"浏览器自己悄悄重连"，重连窗口里丢没丢帧我们不知道；
//   ② 想带 `Last-Event-ID` 以外的东西（将来要带）没法带；
//   ③ 断开只能 close()，没法区分"流自然结束"和"被我掐断"。
//   用 fetch + ReadableStream 自己读，这三件事都在掌控内。
//   （代价：断点续传得自己记 lastEventId，本轮不做自动重连。）
//
// ⚠️ resume 与 cancel 解决的是**两件不同的事**，别混用（与后端 docstring 同款口径）
// ---------------------------------------------------------------------------
//   · `POST /runs/{run_id}/resume` —— 人工审批（HITL）的回答口，后端在
//     app/api/v1/sessions.py::resume_run 实现。契约见下面的 ResumeRequest。
//     ⚠️ 它是**一次回答当前所有待答项**（`{answers:[...]}`，没有单条形状）——
//     后端 2026-10-06 定稿；扇出下多个工具同时等审批是常态。
//   · `POST /runs/{run_id}/cancel` —— 图**在跑**（queued / running）时中止它。
//     ⚠️ 停在人工审批上的运行（`waiting_input`）**没有在跑的任务，不能这样取消** → 409；
//     要表达"不要这一步"得用 resume 回答 reject。见下面的 cancelRun。
//
// 错误处理：三个调用都带 skipErrorHandler
// --------------------------------------
//   失败要以「对话里的一条消息」出现，而不是弹一条全局 toast（同 poll 类请求的口径）。
//   文案由 describeRuntimeError() 统一生成：FastAPI 的 detail 优先，
//   退到 HTTP 状态码，再退到 message —— 三种都能读出「到底为什么没成」。
//   ⚠️ cancelRun 是唯一的例外：它是「用户已经点停止」之后的善后，界面**当场**就
//     退出「正在生成」了，这时再往对话里插一条错误消息只会让人莫名其妙。
//     所以失败只落 console（见 cancelRun 里的说明），不弹 toast、不进对话。
//
// 字段与契约逐条对齐：Session = session_id / agent_id / status / user_id / updated_at；
// Run 只有 run_id / session_id / status；CreateRunRequest.input **只有 text**
// （后端 DTO 是 extra="forbid"，多给键会被 422 拒掉，不是被忽略）；
// 顶层除了 input / metadata 还有 **trace_id**（2026-10-17 后端加的，见 CreateRunRequest）。

import { request } from '@umijs/max';
import { Observable } from 'rxjs';

import { authHeaders, needsRefresh, refreshAccessToken } from '@/services/auth';

/** 后端挂载前缀。dev 下由 config/proxy.ts 把 /api/ 转发到 YTraderHarness(8080)。 */
export const API_BASE = '/api/v1';

/**
 * 会话交给哪种 Agent。
 *
 * 后端里 agent_id **只是会话上记着的一个标签**：走这个 API 进来的只有一种图
 * （agent_run_service_impl.py 里固定 REACT_GRAPH_NAME，没有 agent_id → 图的查表），
 * 前端不选图、也不感知它。用一个固定值，好让库里的会话一眼看出是面板建的。
 */
export const DEFAULT_AGENT_ID = 'assistant_dock';

/** Session.status（session.yaml 是开放枚举，这里按已知值收窄）。 */
export type SessionStatus = 'active' | 'archived';

/** Run.status。 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentSession {
  session_id: string;
  agent_id: string;
  status: SessionStatus;
  /**
   * 会话归属（Casdoor 的 sub）。为 `null` 的是加这一列之前建的存量会话，
   * 它们对**所有**登录用户可见（后端刻意的向后兼容，不是漏洞）。
   */
  user_id: string | null;
  /**
   * **最后活动时间**，ISO 8601 字符串。后端在 create_run 时把它推到当下 ——
   * 消息写在 agent_message 表，会话行本身没有字段变动，所以是显式推进的。
   * 新建时它等于创建时刻；契约里**只有它、没有 created_at**
   * （前端要的是"最后活动"，两者在建会话那一刻是同一个值）。
   *
   * ⚠️ 本地会话列表的 `updated_at`（见 data.ts）就是对齐这个字段取的名字 ——
   *   别在前端另起一个 `lastUpdateTime` 之类的名字，那样两边永远要写转换代码。
   */
  updated_at: string;
}

export interface AgentRun {
  run_id: string;
  session_id: string;
  status: RunStatus;
}

export interface CreateSessionRequest {
  agent_id: string;
  /**
   * 原样存下，且**当前没有读回的接口**（契约里 Session 不含该字段）。
   * 所以别把「只有前端需要」的东西放进来当数据库用 —— 这里只放一个
   * 能让后端排查时认出「这个会话是面板哪个对话建的」的标记。
   */
  metadata?: Record<string, unknown>;
}

export interface CreateRunRequest {
  input: {
    /** 用户这一轮说的话。图把它包成一条 HumanMessage。 */
    text: string;
  };
  metadata?: Record<string, unknown>;
  /**
   * Trace 聚合键 —— **传了才开 Trace，不传一条事件都不写**。
   *
   * 契约：`CreateRunRequest.trace_id`（`app/services/session/domain/schemas/run.py` 70-78，
   * `str | None`、`max_length=255`、默认 `None`）+ `agent_run_service_impl.py` 226-228：
   *
   *     trace_id = (request.trace_id or "").strip() or None
   *     # "Trace 的开关就是'客户端有没有传 trace_id'"
   *
   * 三条容易踩的：
   *
   * 1. **空串 ≠ 关掉 Trace 的另一种写法，它等于"没传"**：后端 `.strip() or None` 归一，
   *    目的是别生成一个空 trace_id 的 Redis 键（那玩意儿跟"没开"长得一模一样，
   *    事后根本分不出是"没开"还是"开了但键名是空"）。所以要么给一个真 id，要么别给。
   * 2. **它是聚合键，不是 run 的代名词**：可以跨 run / session 用，所以事件里另带
   *    `run_id`。前端现在按「一次运行一条 trace」生成（见 agent.ts 的 submitRun）。
   * 3. **resume / cancel 不用管**：这两条路不接受 trace_id，派发时读的是运行行里
   *    已经存下的那个（`agent_run_dispatch.py` 全程用 `run.trace_id`），所以审批
   *    之后的事件仍然落在同一条 trace 里。
   */
  trace_id?: string;
}

/**
 * 对**一次**中断的回答 —— `POST /runs/{run_id}/resume` 请求体里的一项。
 *
 * 契约：`ResumeAnswer`（`app/services/session/domain/schemas/run.py` 71-87）
 * + session.yaml 的 `ResumeAnswer`（required: interrupt_id / data），逐字对齐。
 *
 * ⚠️ `interrupt_id` 必须原样带回，它是**唯一**的匹配键
 * -------------------------------------------------
 *   后端把它拼成 `Command(resume={id: data, ...})` 交给 langgraph，实测按 id
 *   **精确匹配、不会串位**。给错 id 的分支会一直停着（见下面 ResumeRequest 的
 *   "必须不多不少"），而且服务端会先比对 pending 集合 —— 现在给错/给多直接 409，
 *   不再有"200 空操作"那种静默失败。
 *
 * ⚠️ `data` 是自由字典，形状由**审批拦截器**定，不由引擎定
 * ----------------------------------------------------
 *   后端原样透传给 `interrupt()`，由工具侧的处理器解析。就审批这条路而言，
 *   那个处理器是 `ApprovalDecision`（processor/interceptor/approval.py），
 *   它认的形状是：
 *
 *       {"decision": "approve" | "reject" | "always"}    ← 推荐，也是它的文档形状
 *       "approve" / "reject" / "always"                  ← 裸字符串也认
 *       {"decision": "approve", "scope": "always"}       ← 旧形状，等价于 always
 *
 *   **认不出来的一律按拒绝**（fail-closed），所以别自创字段名。
 *   `options`（这次该画哪几个按钮）来自 `hitl.requested` 事件，前端**只应**
 *   在 options 里选；选了 `always` 而这个工具没开 `always_allowed`，后端会
 *   降级成"仅这次"并记一条 WARNING —— 不是报错，但界面与配置不一致。
 */
export interface ResumeAnswer {
  /** `hitl.requested` 事件 `data.interrupt_id` 的原值。 */
  interrupt_id: string;
  /** 原样交给 `interrupt()`。审批的形状见上面的说明。 */
  data: Record<string, unknown>;
}

/**
 * `POST /runs/{run_id}/resume` 的请求体 —— 一次回答**当前所有**待审批。
 *
 * 契约：`ResumeRequest`（run.py 90-135）+ session.yaml（required: [answers]，
 * `minItems: 1`）。**只有 `answers` 这一个字段，没有单条形状** ——
 * 所以哪怕只答一个中断，也要包成 `{ answers: [ 一条 ] }`。
 *
 * ⚠️ 为什么必须"一次全部"，而不是"一次一条"
 * --------------------------------------
 *   扇出下**多个工具可以同时等审批**（每个分支各停各的，实测一次运行里
 *   `next=('tools','tools')`、两个中断并存）。所以正确的模型不是"依次回答"，
 *   而是把手上的待答**一次性**回掉。引擎本来就支持一次多条，限制只在契约层。
 *
 * ⚠️⚠️ 必须**不多不少**，正好覆盖当前的 pending 集合 —— 错一个就是 409
 * ----------------------------------------------------------
 *   服务端会读 checkpoint 里那条 thread 上**真实**的待处理中断集合，与
 *   `answers` 比对：
 *
 *     少给一个  → 那个仍然停着，这次运行回不到 running，而调用方拿到的是 200
 *                 —— 一次"成功"的请求什么都没推进（最阴的一种）
 *     多给/给错 → 说明客户端手上的集合是过期的（多半漏读了后到的 hitl.requested）
 *
 *   两种都是"请求与当前状态不一致"，所以是 **409** 而不是 400。
 *   ⚠️ 前端的应对已经在聚合那一层做好了（`runEventStream` 把连着来的
 *   `hitl.requested` 聚成**一组**、一次 `RUN_FINISHED` 全声明出去，
 *   CopilotKit 攒齐后一次送回来）—— 那一组就是"当前 pending 集合"。
 *
 * ⚠️ 幂等性**不做在服务端**
 * ----------------------
 *   同样的请求重发第二次拿到的还是 409（运行已经不在 `waiting_input`），
 *   不是"重复受理"。要幂等只能客户端按 `interrupt_id` 自己记。
 */
export interface ResumeRequest {
  /** 对当前**每一个**待处理中断的回答，至少要有一条。 */
  answers: ResumeAnswer[];
}

/** 建会话。后端按规格返回 200（不是 201）。 */
export async function createSession(
  body: CreateSessionRequest,
): Promise<AgentSession> {
  return request<AgentSession>(`${API_BASE}/sessions`, {
    method: 'POST',
    data: body,
    skipErrorHandler: true,
  });
}

/** 查会话。会话不存在是 404。 */
export async function getSession(sessionId: string): Promise<AgentSession> {
  return request<AgentSession>(`${API_BASE}/sessions/${sessionId}`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

/**
 * 一页会话（session.yaml 的 `SessionPage`）。
 *
 * ⚠️ 里面**没有标题** —— 契约里 Session 只有 session_id / agent_id / status /
 *   user_id / updated_at。标题一直是前端本地生成的（`data.ts` 的
 *   titleFromMessage），后端不存。"从后端拉列表"因此只能补回**会话的存在与
 *   最后活动时间**，补不回名字，见 `mergeRemoteSessions` 的说明。
 */
export interface SessionPage {
  items: AgentSession[];
  /** 满足筛选条件的**总数**（不是当前页条数），用于画页码。 */
  total: number;
}

/** `GET /sessions` 的查询参数。字段名照抄契约，别在这里改名。 */
export interface ListSessionsParams {
  /**
   * 按状态过滤，**不传等价于 active**。
   *
   * 所以"软删（归档）过的会话"默认不会出现 —— 想看到要显式传 archived。
   * 前端目前只用默认值：归档了就是不要它了。
   */
  status?: SessionStatus;
  agent_id?: string;
  /**
   * 最后活动时间区间，**闭区间且必须带时区**（如 `2026-10-18T00:00:00Z`）。
   * 不带时区是 400，不是"按服务器时区猜一个"。
   */
  updated_after?: string;
  updated_before?: string;
  /** 页码从 1 开始。 */
  page?: number;
  /** 1..100，越界是 422。 */
  page_size?: number;
}

/**
 * 列**当前用户本人**的会话，按最后活动时间倒序。
 *
 * ⚠️ 只包含 `user_id` 严格等于调用者的会话
 * --------------------------------------
 *   存量会话（`user_id` 为 null）**不在列表里** —— 它们仍能按 id 读、发消息，
 *   但"我的会话列表"不属于任何一个人。这一点与 `getSession` 不同（那个允许读
 *   NULL 的公共会话），别把两者当成同一套可见性。
 *
 * ⚠️ 拿不到标题，也拿不到"这个会话里说了什么"
 * ----------------------------------------
 *   要标题只能本地账本有；要内容得再打 `GET /sessions/{id}/messages`。
 *
 * ⚠️ 这是**分页**接口，不是全量
 * --------------------------
 *   默认 `page_size=20`、上限 100。调用方只取第一页时，**不能**据此推断
 *   "本地有、后端没返回的会话已经被删了" —— 那可能只是在第 2 页。
 *   这就是 `mergeRemoteSessions` 只做并集、不做剔除的原因。
 */
export async function listSessions(
  params: ListSessionsParams = {},
): Promise<SessionPage> {
  return request<SessionPage>(`${API_BASE}/sessions`, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}

/**
 * 软删（归档）一个会话 —— `DELETE /sessions/{id}`。
 *
 * 契约（session.yaml 的 deleteSession + sessions.py::delete_session）：
 *   · **204 且没有响应体**，所以返回 `Promise<void>`，不要读 `data`；
 *   · **是归档，不是物理删除**：行还在，消息 / 运行 / checkpoint / 记忆索引
 *     全保留；归档后默认列表不再返回，也不能再开新运行（409）；
 *   · **幂等**：已归档的再删一次还是 204，但不推进 `updated_at`；
 *   · **404 覆盖三种情形**：不存在 / 不是你的 / `user_id` 为 null 的存量公共
 *     会话 —— 同一个响应，不泄露 id 是否存在。
 *
 * ⚠️ 后端会**顺带结束**这个会话里没跑完的运行
 * ----------------------------------------
 *   queued / running 的请求取消（**异步受理**，不等图真的停下），
 *   waiting_input / 孤儿运行在事务内直接记成 cancelled。
 *   所以 204 只表示"归档已提交、取消已请求"，前端不要以为流立刻会断 ——
 *   正在订阅的那条事件流会在发现运行已终态后自然收尾。
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await request<void>(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    skipErrorHandler: true,
  });
}

/**
 * 在某个会话下建一次运行。
 *
 * 返回状态是 `queued` —— 这不是「失败了」，而是这一刻它确实还没开始跑：
 * 派发登记在请求事务提交之后，提交后才交给 agent_react 图，
 * 状态随之走到 running / completed / failed。
 * 想观测终态要等事件流（现在只能查库）。
 *
 * `body.trace_id` 有值时这次运行会写 trace 事件到 `trace:<trace_id>:events`
 * （键名见后端 `models.sql` 124 行附近）；不给就完全不写。开关语义与坑见
 * `CreateRunRequest.trace_id` 的注释 —— 一句话：**要么给真 id，要么别给**。
 */
export async function createRun(
  sessionId: string,
  body: CreateRunRequest,
): Promise<AgentRun> {
  return request<AgentRun>(`${API_BASE}/sessions/${sessionId}/runs`, {
    method: 'POST',
    data: body,
    skipErrorHandler: true,
  });
}

/**
 * 回答人工审批（**一次带上当前所有**待答项），让停在 `waiting_input` 的运行继续。
 *
 * ⚠️ **没有响应体**（后端只在受理那一刻返回 200）
 * --------------------------------------------
 *   受理时库里还是 `waiting_input` —— 把它说成 `running` 是个还没成为事实的
 *   断言，所以后端不返回 Run。想知道"回答到底有没有生效"，只能看事件流：
 *   `hitl.resolved` 表示回答被受理，之后图接着跑，最终以 `run.completed` /
 *   `run.failed` 关流。于是这个函数返回 `void`，**不是**返回 Run。
 *
 *   ⚠️ 别因为"没返回东西"就以为它是 fire-and-forget：失败**会抛**
 *   （404 / 409 / 422），调用方必须接住。
 *
 * ⚠️ 只有一个入口、一个形状：`{ answers: [...] }`
 * ---------------------------------------------
 *   ⚠️ **不要**再为"只答一个"开一个"单条形状"的分支：后端那个 `ResumeRequest`
 *   只有 `answers` 一个字段（`minItems: 1`），没有单条形状 —— 答一个也要包成数组。
 *   曾经这里有过 `resumeRun`（单条）+ `resumeRunBatch`（整组）两个出口，
 *   后端定稿成"一次全部"之后合并成一个，别把它拆回去。
 *
 *   这样做的根据是后端的模型：扇出下多个工具同时等审批，**必须一次凑齐**
 *   当前全部的 `interrupt_id`（见 ResumeRequest 的"不多不少"）。
 *
 * 失败语义（后端 docstring / session.yaml 明写的）：
 *   404 —— 运行不存在，或它所属的会话不属于当前用户；
 *   409 —— **两种**情形：① 这次运行不在 `waiting_input`（已经答过、或压根没停）；
 *          ② `answers` 与当前待处理的中断集合**不一致**（少一个 / 给多了 / 给了错的 id）。
 *   422 —— `answers` 为空数组、`interrupt_id` 为空串，或 `data` 不是对象。
 *
 * ⚠️ 409 是**正常**的一种情形，不是 bug
 * -----------------------------------
 *   用户手快点了两次、或者页面重连后又答了一次，第二次就是 409。
 *   文案要能读 —— 见 agent.ts 里对它的处理（它得同时覆盖上面两种 409）。
 *
 * ⚠️ 顺带一提：等人工输入期间这个会话**建不了新运行**（后端 409）
 * ----------------------------------------------------------
 *   那条 thread 上确实还挂着一件没做完的事。所以前端在有待办中断时
 *   必须禁掉输入框（HitlInterrupt 发布 hitlSignal 做到了这点）。
 */
export async function resumeRun(
  runId: string,
  body: ResumeRequest,
): Promise<void> {
  await request<void>(`${API_BASE}/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    data: body,
    skipErrorHandler: true,
  });
}

/**
 * 中止一次正在跑的运行 —— `POST /runs/{run_id}/cancel`。
 *
 * 契约（app/api/v1/sessions.py::cancel_run + session.yaml 的 cancelRun）：
 *   · **既没有请求体，也没有响应体** —— 200 且 body 为空。所以返回 `Promise<void>`，
 *     不要去读 `data`（读了是 undefined，不是"接口没返回"）。
 *   · **它是异步的**：受理只表示已通知，任务要跑到下一个 await 点才真的停。
 *     想确认结果得盯事件流上的 `run.failed`（`data.status` 是 `cancelled`）或查库。
 *     ⚠️ 所以调用方**不要**在 cancel 之后等它返回来表示"已经停了"。
 *   · 409 —— 状态不允许取消。最常见的是停在人工审批上的运行（`waiting_input`）：
 *     它没有在跑的任务，只有一次待答的 resume，那种情况要用 resume 回答 reject。
 *     已结束的运行同样没什么可取消。
 *   · 404 —— 运行不存在，或它所属的会话不属于当前用户。
 *   · 422 —— `run_id` 不是合法 UUID（后端 path 参数就是 UUID 类型）。
 *
 * ⚠️ 为什么失败只落 console，不进对话、不弹 toast
 * ----------------------------------------------
 *   这是「用户已经点了停止」之后的**善后**调用，而界面在点下的那一刻就已经
 *   退出「正在生成」了（本地流当场结束，见 agent.ts 的 abortRun）。这时候再往
 *   对话里插一条「取消失败」的消息，用户看到的是"我明明停了，它却报错"——
 *   比不报更糟。所以：404 / 409 当作**正常**（本来就没东西可取消），静默；
 *   其余（网络 5xx 之类）只 console.warn，不弹全局提示。
 *   ——这与本文件头部「失败要以对话消息出现」的口径**故意不同**，理由见上。
 */
export async function cancelRun(runId: string): Promise<void> {
  await request<void>(`${API_BASE}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    // 没有请求体，所以**不传 data**。给了 data 也不会被忽略 —— 后端这个端点
    // 没有声明 body，多余字段可能被 FastAPI 拒掉；不传是最省事也最安全的。
    skipErrorHandler: true,
  });
}

/**
 * 判断一次 cancel 失败是否**不值得打扰用户**。
 *
 * 分成"良性"与"真出问题"两类，理由见 cancelRun 的说明：
 *   · 404 —— 运行不存在/不归本用户：本来就没东西可取消。
 *   · 409 —— 状态不允许（停在审批上、或已经结束）：取消没生效，但用户的目标
 *     （别再跑了）多半已经达成，或者有别的入口管这件事（resume 回答 reject）。
 *   · 422 —— run_id 不是 UUID：这是**前端自己的**问题（传错了 id），得看得到，
 *     所以不算良性。
 */
export function isBenignCancelError(error: unknown): boolean {
  const status = statusOf(error);
  return status === 404 || status === 409;
}

// ============================================================
// 事件流（SSE）—— GET /runs/{run_id}/events
// ============================================================

/**
 * 后端事件名（app/common/event/event.py 的 RunEventType）。
 *
 * ⚠️ 这些是**领域名**，跟 AG-UI 的 EventType 不是同一套词表，别互相赋值。
 */
export const RUN_EVENT = {
  RUN_STARTED: 'run.started',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  NODE_STARTED: 'node.started',
  NODE_COMPLETED: 'node.completed',
  MESSAGE_STARTED: 'message.started',
  MESSAGE_DELTA: 'message.delta',
  MESSAGE_COMPLETED: 'message.completed',
  // 思维链（2026-10-13 后端加的，见 app/common/event/event.py）
  MESSAGE_REASONING_DELTA: 'message.reasoning.delta',
  MESSAGE_REASONING_COMPLETED: 'message.reasoning.completed',
  TOOL_CALLED: 'tool.called',
  TOOL_COMPLETED: 'tool.completed',
  HITL_REQUESTED: 'hitl.requested',
  HITL_RESOLVED: 'hitl.resolved',
} as const;

/**
 * `message.started` / `message.completed` 这两帧 `data` 里的
 * `role` + `visible`（2026-10-13 后端加的，见 run_event_projector.py）。
 *
 * ⚠️ **判「给不给用户看」只能看 `visible`，不许自己列一张 role 名单**
 * ---------------------------------------------------------------
 * `role` 是后端的 `ModelRole` 词汇表（`reasoning` / `summarization` /
 * `classification` / `vision` / `fast` / `memory.*` …）。它在类型源码里
 * **刻意不是 Enum**，注释原话是「角色是会长的（今天五个，明天可能八个）」。
 *
 * 所以前端拿 role 只能做一件事 —— **挑一句人话说明这会儿在干什么**
 * （见 `progressLabel`）；一旦用它判可见性，后端明天加一个 role，
 * 那段正文就会**原样漏进聊天窗**，而且前后端都说不清是谁的错。
 *
 * 白名单在后端一处（`agent_run_dispatch.py` 的 `message_roles={MODEL_ROLE}`，
 * 今天只有 `reasoning`），事实随帧发下来，前端照读即可。
 *
 * ⚠️ 不可见的消息**也会**发 started / completed，只是**不发 delta**、
 *   `completed.content` 是空串。后端这么做就是为了这一条（原文大意）：
 *   「没有 message.started，前端在那几秒里什么都收不到，看起来像卡住」。
 *   所以"空 content"不是"模型没说话" —— 它可能是"这条按规矩不给看"。
 */
export interface MessageMeta {
  /** 这次调用的角色；帧里没有这个字段时转成 `null`。 */
  role: string | null;
  /** 正文给不给用户看。**只由后端白名单决定**，前端照读。 */
  visible: boolean;
}

/**
 * 思维链（CoT）那两条通道（`message.reasoning.delta` / `.completed`）。
 *
 * 后端刻意用了**新事件名**而不是往 `message.delta` 里加字段 —— 原文大意：
 * 「`message.delta` 的契约明写只有可见文本、**不含思维链**，把推理并进去
 *   就是改一条已经生效的契约；新事件名是加法，老订阅端不认识就不订阅」。
 *
 * ⚠️ **可见性由同一道门管**（projector 的 message_nodes × message_roles）
 * ---------------------------------------------------------------
 *   摘要（summarization）在同一个 agent 节点里调模型 —— 没有角色门的话，
 *   它的思维链会直接漏进聊天窗。**推理泄漏比正文泄漏更糟**：推理里往往有
 *   内部判据与原始输入。所以前端这边的推理通道与正文通道共用
 *   `segmentAllowsText()` 那道闸（见 runEventStream.ts），不自设第二套判据。
 *
 * ⚠️ `message.reasoning.completed` **可能一条都没有**
 * ------------------------------------------------
 *   模型没给思维链时（非推理模型、关掉思考的调用）它根本不发 —— 而不是发一个
 *   空壳。"这次没有推理"与"推理是空的"不是一回事，所以**不要**用它判断
 *   "这条消息结束了"：那个信号永远是 `message.completed`。
 *   （实测日志里 deepseek-flash 那次运行就一条推理事件都没有。）
 *
 * ⚠️ 两者都**不是**终止事件：推理还在流的时候关掉 SSE，用户会以为回答结束了。
 */
export interface ReasoningMeta {
  /** 逐 token 的增量（与 `message.delta` 的 `delta` 同名同义）。 */
  delta?: string;
  /** 全文（`completed` 才有）—— 对账点：与 delta 拼出来的不一致时以它为准。 */
  content?: string;
}

/**
 * 会让后端**主动关流**的事件（对应后端 TERMINAL_EVENT_TYPES）。
 *
 * 注意 `waiting_input` 不在其中：那种情况下运行确实没结束，流会一直挂着 ——
 * 这是后端的刻意设计（见 agent_run_dispatch.py::_publish_terminal），
 * 前端靠空闲超时兜底，不把它当成"卡住了"。
 */
export const TERMINAL_RUN_EVENTS: readonly string[] = [
  RUN_EVENT.RUN_COMPLETED,
  RUN_EVENT.RUN_FAILED,
];

/** 一帧 SSE 解析后的样子。 */
export interface RunEventFrame {
  /** SSE 的 `id:` 行 —— Redis Stream 的 entry id，断点续传时回填给 Last-Event-ID。 */
  id?: string;
  /** SSE 的 `event:` 行（领域名，如 `message.delta`）。 */
  event: string;
  /** `data:` 行的整个 JSON（含 event / topic / topic_id / occurred_at / data）。 */
  payload: Record<string, unknown>;
  /** payload.data —— 这一帧真正带的业务字段。 */
  data: Record<string, unknown>;
}

/**
 * `hitl.requested` 这一帧 `data` 的形状。
 *
 * ⚠️ 这一帧是**唯一**能让运行停下来的信号
 * --------------------------------------
 *   后端在派发里看到图被 `interrupt()` 停下时发它（agent_run_dispatch.py 的
 *   `_publish_hitl_requested`），然后**保持事件流开着** —— 因为运行确实没结束
 *   （它没有 `hitl.cancelled` / `hitl.timeout`，终态只有 run.completed / run.failed）。
 *   所以「等审批」这件事在前端**只能**从这一帧看出来，不能等流关。
 *
 * ⚠️ 前 6 个字段是**审批拦截器**的私有格式，后端明说不解释
 * -----------------------------------------------
 *   `ask` / `tool_key` / `arguments` / `approver_role` / `options` 原样透传自
 *   `ApprovalInterceptor._payload()` —— 换一种需要人工介入的处理器（比如
 *   "补充信息"时的提问）时，形状会变，而后端一行都不用改。
 *   因此前端**不许假设这几个字段一定在**：按可选读，缺了就用兜底渲染
 *   （见 runEventStream.ts 的 hitlInterrupt）。只有 `interrupt_id` 是
 *   派发层自己加的、恒在的（它是"回答哪一次"的唯一键）。
 *
 * ⚠️ `options` 是按钮列表，**不许前端猜**
 * ------------------------------------
 *   没开 `always_allowed` 的工具只有 `['approve','reject']`，
 *   开了才有第三个 `'always'`。硬编码"始终允许"就等于给一个不该有的按钮
 *   —— 而"始终允许"是能绕过工具自己风险策略的那个（见 approval.py）。
 *
 * ⚠️ `wait_seconds` 只用来**显示**倒计时
 * -----------------------------------
 *   它是配置里声明的等待窗口。⚠️ **服务端并不拿它判超时**（`interrupt()`
 *   没有超时机制，判超时归运行生命周期的所有者，见 approval.py 的模块
 *   docstring）—— 所以前端也**不许**拿它自己提交一个拒绝：那等于前端发明
 *   一条审批策略，而后端到点时可能做另一件事。
 *   它是**可选**的：读不到就不画倒计时（退化成没有倒计时）。
 */
export interface HitlRequestData {
  /** 回答时原样带回给 `resumeRun`。**唯一必填**。 */
  interrupt_id: string;
  /** 问什么（审批拦截器的 `prompt`）。 */
  ask?: string;
  /** 被审批的工具，点分形式（如 `agent.platform.describe_platform`）。 */
  tool_key?: string;
  /** 这次调用的参数 —— 审批的粒度必须与参数对齐，不给参数就是让人盲批。 */
  arguments?: Record<string, unknown>;
  /** 要求审批人具备的角色，没配就是 null。 */
  approver_role?: string | null;
  /** 该画哪几个按钮，值域见 `ApprovalDecision`：approve / reject / always。 */
  options?: string[];
  /** 审批记录的作用域 —— 是 **run_id**，不是会话级的 thread_id。 */
  run_id?: string;
  /**
   * 配置里声明的等待窗口（秒）。**只用于显示倒计时** —— 见上。
   *
   * ⚠️ 倒计时的**锚点**不在这里：它是这一帧的 `occurred_at`（信封字段），
   *    由 runEventStream 的 `hitlInterrupt` 一起收进 interrupt 的 metadata。
   *    两样都缺一样，卡片就不画倒计时。
   */
  wait_seconds?: number;
  /**
   * 停下来的**种类**。
   *
   * 审批拦截器**不带**这个字段（它的形状由 `options` 自述）；`agent.ask_user_question`
   * 带 `ask_user_question` —— 前端就靠它认出"这是提问、不是审批"
   * （见 askUserQuestion.ts 的 readQuestions：认 type，不认 tool_key）。
   */
  type?: string;
  /**
   * 要问的题（只在 `type === 'ask_user_question'` 时有）。
   *
   * 形状见 `app/agent/tools/hitl_tool.py` 的 `Question`：
   * `{question, header, options:[{label,description,preview}], multiSelect}`。
   * 这里写成 `unknown[]` 是刻意的：派发层把整个字典当**不透明载荷**搬运
   * （见 `_publish_hitl_requested` 的 docstring），前端在 askUserQuestion.ts
   * 里按需解析、读不出来的部分滤掉 —— 契约类型不该替它预先断言形状。
   */
  questions?: unknown[];
  /**
   * 处理器自己的元信息。
   *
   * ⚠️ 与 AG-UI `Interrupt.metadata` **不是**同一个东西：这个是后端载荷里的
   *    字段（提问时是 `{"source": "planner"}`），前端把它搬进 interrupt 的
   *    metadata 时换了键名（`hitlMetadata`），免得两个同名字段打架。
   */
  metadata?: Record<string, unknown>;
  /** 对应哪一次工具调用（= `tool.called` 的 `tool_call_id`）。 */
  tool_call_id?: string;
}

/** `hitl.resolved` 的 `data`：只说明"有人答了"，不代表通过（见后端 docstring）。 */
export interface HitlResolvedData {
  interrupt_id: string;
  data?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 解析**一个** SSE 块（空行之前的那几行）。
 *
 * 返回 null 的三种情况都是"这一块没有可交付的事件"，不是错误：
 *   · 心跳 —— 后端在阻塞读超时时会发 `: ping\n\n`，只有注释行没有 data；
 *   · 空块 —— 流刚建立时可能会有；
 *   · data 不是 JSON 对象 —— 不该出现，丢掉比让上层崩掉好。
 */
export function parseSseBlock(block: string): RunEventFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    if (!rawLine) continue;
    // 注释行（心跳）。SSE 规范里它就是给客户端保活/防代理超时用的，不是数据。
    if (rawLine.startsWith(':')) continue;

    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    // 规范允许 "data:xxx" 与 "data: xxx"，冒号后的**一个**空格要剥掉
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // retry: 等其它字段一概忽略 —— 重连策略由调用方决定，不由流决定
  }

  if (dataLines.length === 0) return null;

  const payload = parseJsonObject(dataLines.join('\n'));
  if (!payload) return null;

  return {
    id,
    // event 行可能缺（手写 SSE 常常只给 data），退回 payload 里的 event 字段
    event: event ?? (typeof payload.event === 'string' ? payload.event : ''),
    payload,
    data: isRecord(payload.data) ? payload.data : {},
  };
}

/**
 * 把**流式**到达的字节切成一帧帧。
 *
 * 必须增量解析：TCP 不保证一帧正好一个 chunk，一个 chunk 里也可能有半帧 + 三帧。
 * 因此留一个 buffer，只在见到空行时切一刀。
 */
export class SseDecoder {
  private buffer = '';

  push(chunk: string): RunEventFrame[] {
    // 规范的行分隔符是 CRLF，也可能是 LF 或 CR；统一成 LF 再切。
    // data 里是 JSON（不会有裸换行），所以整体替换是安全的。
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const frames: RunEventFrame[] = [];
    let separator = this.buffer.indexOf('\n\n');
    while (separator !== -1) {
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);

      const frame = parseSseBlock(block);
      if (frame) frames.push(frame);

      separator = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}

/** 多久没收到**任何字节**就认为流断了。后端心跳是 ~1s 一发，60s 极其宽松。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * 建流时吃到 404 的重试节奏：**3 次 × 500ms**（默认）。
 *
 * ⚠️ 为什么必须重试（踩过：刚发完一句话，几乎必然弹"运行已不在后端"）
 * ----------------------------------------------------------------
 *   `POST /sessions/{id}/runs` 返回 **200**（契约里就是 200，不是 202 ——
 *   语义上仍是"异步受理"，回来的 Run 是 queued）的那一刻，**运行行还没提交**。
 *   FastAPI（0.141 的 `routing.request_response`）是这么写的：
 *
 *       async with AsyncExitStack():     # ← 依赖里 factory.scope 的事务在这层
 *           response = await f(request)
 *           await response(...)          # ← 200 已经发给浏览器了
 *       # 退出 async with → COMMIT        # ← 行此刻才对别的连接可见
 *
 *   而浏览器的下一个动作就是打 `/events`，那条请求用**另一条连接**查库：
 *   查不到 → 后端 `get_run` 抛 NotFoundError → 404。
 *   窗口通常只有几毫秒，但它是真的 —— 而且越是"点了发送立刻收到响应"的
 *   快网络，越容易踩到。
 *
 *   ⚠️ 这不是"Redis 里还没建键"：后端那个端点是**刻意查库**判存在的
 *   （见 sessions.py 的 stream_run_events：「键可能因为 TTL 过期而消失，
 *   也可能还没建，看键在不在两种情况都会判错」）。所以修 Redis 那边
 *   消除不了这个 404，只能由建流这一侧容忍它。
 *
 *   3 次 × 500ms = 1.5s：足够跨过提交延迟；如果运行真的没了，也只是把
 *   报错晚 1.5 秒。重试只在**建流那一次**做，流一旦连上就不会再走这里。
 */
export const STREAM_404_MAX_RETRIES = 3;

/** 每次 404 重试之间的等待。固定间隔（不是退避）—— 窗口就几毫秒，没必要拉长。 */
export const STREAM_404_RETRY_DELAY_MS = 500;

export interface RunEventsOptions {
  /** 断点续传：从这个 entry id **之后**开始（语义同后端的 start）。 */
  lastEventId?: string;
  idleTimeoutMs?: number;
  /** 注入用（测试里给一个假的实现，不走网络）。 */
  fetchImpl?: typeof fetch;
  /**
   * 404 的重试节奏。`attempts` 是**额外重试次数**（默认 3，即最多 4 次请求）。
   * 测试里传 `delayMs: 0` 免等。
   */
  notFoundRetry?: { attempts?: number; delayMs?: number };
}

function streamError(
  status: number,
  notFoundRetries = 0,
): Error & { response: unknown } {
  const hint: Record<number, string> = {
    401: '登录状态已失效（事件流也要带 token），自动续期也没成功，请重新登录',
    403: '当前账号不在允许的群组里，事件流被拒绝',
    // 404 的文案要把"已经重试过"说出来：否则用户看到"运行不在后端"，
    // 会以为是后端把活丢了；实际上多半是重试次数不够 / 后端 404 另有原因。
    404:
      notFoundRetries > 0
        ? `这次运行已经不在后端了（已结束、或后端重启过；已自动重试 ${notFoundRetries} 次），请重新发送这一句`
        : '这次运行已经不在后端了（已结束、或后端重启过），请重新发送这一句',
    503: '事件流不可用（后端的 Redis 流没接上）',
  };
  // 只给原因，不写"订阅事件流失败" —— 步骤名由 agent.ts 统一加前缀，
  // 两处都写就会叠成「订阅事件流（…）：订阅事件流失败：…」
  const detail = `${hint[status] ?? '请求失败'}（HTTP ${status}）`;
  const error = new Error(detail) as Error & { response: unknown };
  // 带上 response 是为了让 statusOf() 认得出状态码；
  // detail 要**同时**放进 response.data —— describeRuntimeError 会先读它，
  // 不放的话这条人话会被 `HTTP ${status}` 顶掉（踩过：界面只显示「HTTP 404」）。
  error.response = { status, data: { detail } };
  return error;
}

/**
 * 让出事件循环一个**宏任务**，让 React 有机会把刚收到的这一帧真的画出来。
 *
 * ⚠️ 为什么需要这个（踩过：看起来完全不像流式）
 * ----------------------------------------------
 *   网络不会「一帧一次 read()」地送。后端 6~14ms 就出一个 token（Redis entry id
 *   695311 / 695325 / 695331 … 挨着），几十个 token Frequently 被塞进**同一个
 *   TCP chunk**。而读流循环如果同步 for 循环把它们挨个 `subscriber.next()` 出去，
 *   几十次 `onMessagesChanged` 就全落在**同一个 tick** 里 ——
 *   React 18+ 的自动批处理会把它们合并成**一次渲染**。
 *   结果就是：文字要等整段收完才「啪」地一下全出来。
 *
 *   AG-UI 客户端本身没问题（`processApplyEvents` 是按事件逐次回调的），
 *   CopilotChat 也没有节流 —— 瓶颈就在这个同步 for 上。
 *
 * 为什么用 MessageChannel 而不是 setTimeout(0)
 * -------------------------------------------
 *   浏览器会把嵌套超过 5 层的 `setTimeout(0)` 钳到 ≥4ms（setTimeout 的嵌套钳制），
 *   几十帧就变成几百毫秒的**人为卡顿**。MessageChannel 是零延迟宏任务，
 *   正是「让出事件循环」的标准做法（Vue 的 nextTick、React 自己的 scheduler
 *   都是这么实现的）。
 *
 * 代价：只在**同一个 chunk 里的第 2 帧起**才让出。正常情况（后端一帧一个 chunk）
 * 一次都不会触发，零额外延迟。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'function') {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        // 用完就关，否则长连接下会攒下大量通道
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * 可被 abort 打断的等待（404 重试用）。
 *
 * ⚠️ 为什么不能直接 `setTimeout`
 * ---------------------------
 *   退订（切会话 / 关面板 / 点停止）时 `stop()` 会 abort 请求，
 *   但一个裸的 `setTimeout(500)` 还会在那儿躺着，到点再打一次后端 ——
 *   那是"用户已经走了，前端还在敲接口"。这里让 abort 立刻把等待打断，
 *   重试循环因 `closed` 为真直接退出。
 */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };

    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 订阅一次运行的事件流。
 *
 * 返回的 Observable：
 *   · 逐帧 next（顺序即后端写入顺序，从头补发 —— 晚连也不会漏开头）；
 *     **同一个 chunk 里的多帧之间会让出事件循环**，保证界面是"边收边画"
 *     而不是等整段收完再一次性渲染（见 yieldToEventLoop 的说明）；
 *   · 后端遇到 `run.completed` / `run.failed` 会自己关流，届时 complete；
 *   · **建流时 404 会重试**（3 次 × 500ms，见 STREAM_404_MAX_RETRIES）：
 *     刚建完的运行在 202 发出时还没提交，立刻订阅必然查不到；
 *   · 其余 HTTP 非 2xx、读取异常、空闲超时 → error；
 *   · 退订 → abort 掉请求（切会话/关面板时不会留下悬挂的连接）。
 */
/**
 * 给事件流这条 fetch 单独续一次 token。刷不出来返回 `null`。
 *
 * ⚠️ 为什么必须单独做，而不能指望拦截器
 * ----------------------------------
 *   这条 fetch 绕开了 umi 的 `request`，也就**拿不到它的 401 拦截器**
 *   （`requestErrorConfig.ts` 的 `retryAfterRefresh` 只对 axios 生效）。
 *   `authHeaders()` 的注释曾写着"401 的处理逻辑仍然只有一处（拦截器）"——
 *   对普通接口成立，对这条 fetch **不成立**。结果就是：令牌一过期，
 *   umi 的请求会被自动刷回来（用户无感），而这一条直接 401，
 *   界面报"订阅事件流…登录状态已失效"，刷新页面才恢复。
 *   这正是"前端偶尔报错、刷新就好"的来源之一。
 *
 * 失败不在这里抛：让真正的 401 去回答"为什么没订上"，
 * 免得把 401 说成一个"刷新失败"（用户更看不出该干什么）。
 */
async function refreshStreamToken(): Promise<string | null> {
  try {
    return await refreshAccessToken();
  } catch {
    return null;
  }
}

export function runEvents(
  runId: string,
  options: RunEventsOptions = {},
): Observable<RunEventFrame> {
  const {
    lastEventId,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    fetchImpl,
    notFoundRetry,
  } = options;
  const doFetch: typeof fetch = fetchImpl ?? globalThis.fetch;
  const retry404Attempts = notFoundRetry?.attempts ?? STREAM_404_MAX_RETRIES;
  const retry404DelayMs = notFoundRetry?.delayMs ?? STREAM_404_RETRY_DELAY_MS;

  return new Observable<RunEventFrame>((subscriber) => {
    const controller = new AbortController();
    const decoder = new SseDecoder();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const stop = () => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      controller.abort();
    };

    // 每收到任何字节就重新计时 —— 心跳也算活着。
    // 不能只在"收到事件帧"时计时：一次长思考期间可能几十秒没有事件，
    // 但心跳一直在，那不是断流。
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        subscriber.error(
          new Error(`事件流超过 ${idleTimeoutMs / 1000} 秒没有任何数据`),
        );
        stop();
      }, idleTimeoutMs);
    };

    void (async () => {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;

        /**
         * ⚠️ 手动补 Authorization —— 这里的 fetch **绕开了 umi 的 request**，
         *    也就绕开了请求拦截器。不带就是 401（后端 /api/v1 全量鉴权）。
         *
         * 契约里这个端点额外接受 `?access_token=`（casdoor.yaml 的
         * `query_token_paths`，**全仓唯一一处例外**）。那个口子是给
         * 浏览器的 `EventSource` 开的 —— 它没法设置请求头。
         * 我们用的是 fetch + ReadableStream，**能带头就带**：
         * query 里的 token 会进访问日志、代理日志和浏览器历史。
         * 少用一次那个例外，就少一份被日志收走的凭据。
         */
        Object.assign(headers, authHeaders());

        // ① 已知过期（进了提前量窗口）就先刷一次，别拿死 token 去敲门。
        //    `needsRefresh()` 在"不知道过期时间"时返回 false，所以不会每次都绕 Casdoor。
        if (needsRefresh()) {
          const token = await refreshStreamToken();
          if (token) headers.Authorization = `Bearer ${token}`;
        }

        const open = () =>
          doFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/events`, {
            method: 'GET',
            headers,
            signal: controller.signal,
            cache: 'no-store',
          });

        let response = await open();

        // ② 仍然是 401（本地不知道过期时间 / 时钟偏差 / 令牌刚被服务端作废）→
        //    刷一次再重试**一次**。只重试一次：刷完还 401 就说明不是过期问题
        //    （比如 audience 配错），再刷就是死循环。
        if (response.status === 401) {
          const token = await refreshStreamToken();
          if (token) {
            headers.Authorization = `Bearer ${token}`;
            response = await open();
          }
        }

        // ③ 404：多半是"运行行刚建、响应发出去了但事务还没提交"（见
        //    STREAM_404_MAX_RETRIES 的说明）。等 500ms 再订，最多 3 次。
        //
        //    ⚠️ 只重试**建流**这一次。流连上之后不会再走到这里；而"续订一个
        //    早就没了的运行"也会因此多花 1.5s —— 这个代价换的是"发完消息
        //    不再偶发地报一次假错"。
        //    ⚠️ 每次重试都要先看 closed：等待期间用户可能切走了，那就别再打后端。
        let notFoundRetries = 0;
        while (
          response.status === 404 &&
          notFoundRetries < retry404Attempts &&
          !closed
        ) {
          notFoundRetries += 1;
          try {
            await waitOrAbort(retry404DelayMs, controller.signal);
          } catch {
            // 被 abort（退订）打断 —— stop() 已经把 closed 置位，直接收尾
            return;
          }
          if (closed) return;
          response = await open();
        }

        if (!response.ok) {
          subscriber.error(streamError(response.status, notFoundRetries));
          return;
        }
        if (!response.body) {
          subscriber.error(
            new Error('事件流没有响应体（浏览器不支持流式读取）'),
          );
          return;
        }

        armIdle();
        const reader = response.body.getReader();
        const text = new TextDecoder('utf-8');

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();

          const frames = decoder.push(text.decode(value, { stream: true }));
          for (let i = 0; i < frames.length; i += 1) {
            // ⚠️ 从**第二帧**起让出事件循环：第一帧要立刻发（别让首字延迟），
            // 之后每帧之间给 React 一次绘制机会。否则同一 chunk 里的几十帧
            // 会在同一个 tick 内全部触发 onMessagesChanged，被批成一次渲染，
            // 文字就变成"等全部收完才一次性出现"（见 yieldToEventLoop）。
            if (i > 0) await yieldToEventLoop();
            if (closed) break;
            subscriber.next(frames[i]);
          }
        }

        if (!closed) subscriber.complete();
      } catch (error) {
        // 退订引发的 AbortError 是正常收尾，不是错误 —— closed 已置位
        if (!closed) subscriber.error(error);
      } finally {
        stop();
      }
    })();

    return stop;
  });
}

// ============================================================
// 会话历史（messages）—— GET /sessions/{session_id}/messages
// ============================================================

/** 契约：app/services/session/messages.yaml v1.0.0（+ sessions.py 实际实现）。 */

/**
 * ⚠️ 字段与**真实响应**对齐过，不是照 yaml 抄的
 * -------------------------------------------
 *  · `content` 是**数组**（ContentBlock[]），不是字符串 —— 里面可能带
 *    artifact_id / source_id 指向附件与引用源；
 *  · `artifact_id` / `source_id` 实测会**显式返回 null**（yaml 里没写 required），
 *    所以类型必须是 `string | null`，不能当可选处理；
 *  · `created_at` 是 UTC ISO 串（`2026-10-03T03:11:32.776052Z`，6 位微秒）。
 */
export type MessageRole = 'user' | 'assistant';

/**
 * 消息种类。
 *
 * ⚠️ 后端**真的会落** `tool_activity`（不是"只有枚举"）
 * ------------------------------------------------
 *   `message_recorder._kind()` 把两类消息判成它：
 *     · 带 `tool_calls` 的 AIMessage（"要求调用工具"）；
 *     · ToolMessage（工具的执行结果）。
 *   一条既说了话、又调了工具的消息也算它 —— 正文里文本块和 tool_call 块都有。
 *
 *   其余三个：`chat` 是对话正文（含用户那条），`notice` 目前只有"运行被取消"
 *   时补的那一条，`interaction`（HITL 问句）是目前"我回答的那一问"。
 *
 * ⚠️ 2026-10-22 多了两条：`task_instruction` / `task_result`
 * ------------------------------------------------------
 *   后端 `MessageKind` 里新增（`app/services/session/domain/schemas/enum.py`），
 *   由 `message_recorder._kind()` 按 `additional_kwargs.kind` 打标：
 *     · task_instruction —— 后端注入给子代理的任务说明（**role 是 user**，
 *       但用户从没打过这句话，所以前端不能画成"我发的消息"）；
 *     · task_result      —— 子代理的最终回答（role 是 assistant）。
 *   两者成对出现，`metadata` 里带 task_id / plan_id / skill_key，
 *   前端拿它把消息挂到对话区左侧那条任务时间线上（见 taskTimeline.ts）。
 *
 * 它们不是同一类东西，渲染时要分开（见 history.ts 的 classifyMessage）。
 */
export type MessageKind =
  | 'chat'
  | 'interaction'
  | 'tool_activity'
  | 'notice'
  | 'task_instruction'
  | 'task_result';

export type MessageStatus =
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export interface ContentBlock {
  type: string;
  text?: string | null;
  artifact_id?: string | null;
  source_id?: string | null;
  /**
   * 仅 `type === 'tool_call'` 的块有 —— 工具调用的三件套。
   *
   * 后端把 langchain 消息上的 `tool_calls` 附成内容块
   * （`message_recorder._content_blocks`：`{type:'tool_call', id, name, args}`），
   * 因为契约的 `content` 是"这条消息的全部内容块"；不附的话前端只看 content
   * 就看不到"它调了哪个工具"。契约的 ContentBlock 是 `additionalProperties: true`，
   * 所以这三个键不在 yaml 里出现也合法。
   */
  id?: string | null;
  name?: string | null;
  args?: Record<string, unknown> | null;
}

export interface SessionMessage {
  message_id: string;
  /** 会话内的顺序号。 */
  seq: number;
  run_id: string | null;
  role: MessageRole;
  kind: MessageKind;
  business_agent_id: string | null;
  content: ContentBlock[];
  /**
   * 思维链原文（2026-10-13 后端加的列）。`null` = 这条消息没有思维链
   * （非推理模型 / 用户消息 / 取消公告）。
   *
   * ⚠️⚠️ **取值规则是 `reasoning_content ?? content 里 type=reasoning 的块**
   * -----------------------------------------------------------------
   *   契约（messages.yaml）原文：新写入的消息里推理**只**在 `reasoning_content`
   *   （content 只放可见内容块，两个容器不重叠）；但这一列是**后加的**，
   *   **存量行没有它** —— 实测库里 169 条 assistant 消息的推理就躺在 content
   *   的块数组里，而那批行**刻意不回填**（回填要 UPDATE，会把 updated_at 推走）。
   *
   *   所以这条 `??` 不是临时兼容代码，而是**长期**的读法：
   *     · 只读新字段 → 所有历史会话的推理消失；
   *     · 只读 content 块 → 新会话的推理消失。
   *
   *   实现见 history.ts 的 `reasoningOf`。
   *
   *   ⚠️ **可选**（`?`）：契约的 required 里没有它，而存量行**整个键都没有** ——
   *   那正是 `??` 要兜的情况。写成必填等于假装存量数据不存在。
   */
  reasoning_content?: string | null;
  status: MessageStatus;
  reply_to_message_id: string | null;
  created_at: string;
  /**
   * 契约里给的"最后有效时间"（ISO 8601 字符串）。
   *
   * ⚠️ 目前后端**恒等于 created_at**：消息写一次就不再改。
   *   所以它现在**不用来排序** —— 排序按 `seq`（见 history.ts 的文件头），
   *   别拿墙上时间去覆盖一个可靠得多的顺序号。
   */
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface MessagePagination {
  limit: number;
  has_more_before: boolean;
  before_cursor: string | null;
  has_more_after: boolean;
  after_cursor: string | null;
}

export interface MessagePage {
  session_id: string;
  messages: SessionMessage[];
  pagination: MessagePagination;
}

export interface ListMessagesParams {
  /** 每页条数，1~100。越界后端回 **422**（不是 400）。 */
  limit?: number;
  /** 往更旧翻。不透明游标，原样回传。 */
  before?: string;
  /** 往更新翻。不透明游标，原样回传。 */
  after?: string;
}

/**
 * 取一页会话历史（按 seq 升序，旧 → 新）。
 *
 * ⚠️ 两个容易踩的点
 * --------------
 *  1. **游标不透明**：后端现在是 `base64url("v1:<seq>")`，但契约只承诺它是
 *     一个能原样回传的字符串 —— 别去解它，换编码不该把前端搞坏。
 *  2. **404 ≠ 空数组**：「这个会话还没聊过」返回 `messages: []`，「会话不存在」
 *     才是 404。混成同一种响应就分不清自己是不是拿错了 session_id。
 */
export async function listSessionMessages(
  sessionId: string,
  params: ListMessagesParams = {},
): Promise<MessagePage> {
  return request<MessagePage>(`${API_BASE}/sessions/${sessionId}/messages`, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}

/**
 * 从请求错误里挖出一句能读的原因。
 *
 * ⚠️ 错误体在**两个地方**，两个都要看
 * --------------------------------
 *   · `@umijs/max` 的 request 是 **axios**：响应体在 `error.response.data`，
 *     `error.data` 是 undefined；
 *   · 自己 fetch 抛的（见 streamError）习惯放 `error.data`。
 *
 * 只看 `error.data` 的后果是：后端给的中文原因（"会话不存在：xxx"、
 * "运行不存在"）全被丢掉，退化成一句 `HTTP 404` —— 用户看不出到底哪儿没了。
 * 这正是"面板上只显示 HTTP 404"的原因。
 */
export function describeRuntimeError(error: unknown): string {
  const err = error as {
    response?: { status?: number; data?: { detail?: unknown } };
    data?: { detail?: unknown };
    message?: string;
  };

  // 两个位置的 detail 都试一遍（axios 在前，自己的在后）
  const { detail } = err?.response?.data ?? err?.data ?? {};
  if (typeof detail === 'string' && detail) return detail;

  // FastAPI 的 422：detail 是一个数组，逐条是 { loc, msg, type }
  if (Array.isArray(detail)) {
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    if (first?.msg) {
      const where = (first.loc ?? []).join('.');
      return where ? `${where}: ${first.msg}` : first.msg;
    }
  }

  const status = err?.response?.status;
  // 没有 detail 时，退化成状态码；有 message 的话把它也带上（比如
  // "订阅事件流失败：运行不存在" 这种自己造的错）
  if (status) {
    const message = err?.message;
    return message ? `${message}（HTTP ${status}）` : `HTTP ${status}`;
  }

  if (err?.message) return err.message;
  return '未知错误';
}

/** 错误里的 HTTP 状态码（没有就 undefined）。用于判断"是不是 404"。 */
export function statusOf(error: unknown): number | undefined {
  const err = error as { response?: { status?: number } };
  return err?.response?.status;
}
