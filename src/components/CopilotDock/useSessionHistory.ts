// src/components/CopilotDock/useSessionHistory.ts
//
// 「点某个会话 → 拉它的历史 → 灌进 agent」这条链路，单独抽成一个 hook。
//
// 为什么不写在 index.tsx 里
// ----------------------
//   这段逻辑有两个坑，都必须用测试钉住，而组件级测试（要把 CopilotKit 一起挂起来）
//   很难观察到"agent 收到了什么"。抽成 hook 就能用 renderHook 直接断言。
//
// ⚠️ 坑 1：agent 会随 activeId 重建，缓存命中也**必须重新灌**
// --------------------------------------------------
//   DockAgent 实例是 `useMemo(..., [activeId])` 出来的 —— 切会话就是一个**全新**的
//   agent，它的 `messages` 是空的。所以「这个会话之前加载过」只能用来**跳过接口**，
//   绝不能用来跳过 `setMessages`：跳了就是一片空白。
//   （这正是"第一次点能显示、之后点不显示"的成因。）
//
// ⚠️ 坑 2：缓存要按 sessionId 存，且要有失效入口
// ------------------------------------------
//   · 存 sessionId 而不是本地会话 id：本地会话可能被删重建，sessionId 才是后端事实；
//   · `invalidate()`：用户在这个会话里发过新消息后，历史缓存就不全了
//     （缓存里没有刚发的那轮），下次进来必须重拉。
//     注意**发消息之后不要立刻 invalidate 并重灌** —— 那会把正在流式输出的
//     界面内容冲掉。invalidate 只是"下次进来重新拉"的标记。
//
// ⚠️ 坑 3：**绝不清掉「已经在飞的那一轮」**
// ----------------------------------------
//   sessionId 不一定在挂载时就有 —— 懒建会话的对话，它的 sessionId 是在
//   **第一条消息发出去之后**才落进 state 的（index.tsx 的 newSession）。
//   那一刻会发生两件事：
//     · sessionId 从 undefined 变成有值 → 本 hook 的 effect 重跑；
//     · 而 agent 里**已经有**这一轮的用户消息了（CopilotKit 在提交那一刻 addMessage）。
//   重跑时缓存必然未命中（这个 sessionId 是刚诞生的），于是去拉了一次历史 ——
//   而这时 createRun 往往还没把用户消息落库，后端返回**空数组**，
//   紧接着 `setMessages([])` 就把**正在飞的这一轮整个清掉**。
//
//   两个可见后果（用户报的是第 ② 个）：
//     ① 刚发出去的用户消息从界面上消失（快照事件也没有，补不回来）；
//     ② `agent.messages` 变空 → 空对话的问候语**又冒回来**，
//        而此刻 run 还在跑、CopilotKit 的 loading 动画也在转 ——
//        「你好，我能帮什么忙吗？」和 loading 同时挂在面板上。
//
//   所以本 hook 有一条不变量：**它只往 agent 里灌历史，绝不把 agent 已有的
//   消息清掉**。判据是「灌之前 agent 空不空」—— 见下面 effect 里的守卫。
//   这条不变量不会误伤切会话：切会话时 agent 是 `useMemo(..., [activeId])` 出来的
//   **新实例**，它的 messages 必然是空的（灌历史正是靠本 effect 自己 setMessages）。
//
// ⚠️ 顺带回答：刷新之后要不要**续订**某个正在跑的运行
// --------------------------------------------------
//   刷新（或切走再切回）之后，这一轮的订阅已经断了，但**后端的运行还在** ——
//   它可能在跑，也可能停在人工审批上等人回答。要把界面接回去，只需要知道
//   「最近一次运行的 run_id」，而这份信息就在历史消息里：后端在**建运行那一刻**
//   就把用户消息落库了，并且带上了 `run_id`（agent_run_service_impl.py 的
//   create_run），所以"最后一条消息的 run_id"就是答案 —— 不必新增任何接口
//   （`GET /runs/{run_id}/events` 本身就是订阅兼存活探测：404 = 没了、
//   200 + 立刻补发终止帧 = 已结束、200 + 流挂着不关 = 还在跑 / 在等人答）。
//
//   判据是下面的 resumeCandidateOf（纯函数，边界都有单测）；这里只负责在拉到
//   历史之后把它交出去 —— 真正的续订动作在 RunResume.tsx（它要 CopilotKit 的
//   context 才能让 agent 再跑一次）。
//
//   ⚠️ 为什么不做成"总是续订"：订阅是**从头补发**的，事后重订会把整轮重放一遍。
//   对已经跑完的那一轮，那只会让界面凭空多出一份重复内容（messageId 里带着
//   这次流自己的 streamId，不会覆盖，只会新增）。所以判据必须能区分
//   「有未了结的运行」与「这一轮早就结束了」。
//
//   ⚠️ 候选必须**成对带上 sessionId**（用户报过一个 bug，别改回去）
//   --------------------------------------------------------
//     切会话是"先换 props 渲染、再跑 effect"：候选这份 state 在那一帧还留着
//     **上一个会话**的值，而新会话那一帧正是 RunResume 随
//     `<CopilotKit key={activeId}>` 重挂、决定"要不要续订"的那一帧 ——
//     不按 sessionId 过滤，它就会把 A 的运行接给 B 的 agent，重放的
//     `hitl.requested` 让**审批卡在别的会话里冒出来**。
//     所以 state 存 CandidateHolder（候选 + 它来自哪个会话），出口只放行相符的那份。

// 竞态：
//   · 切得快 —— 过期响应不灌（cancelled 标志）；
//   · 退订 —— 不 setState，避免 React 警告。

import type { Message } from '@ag-ui/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listSessionMessages, type SessionMessage } from './agentRuntime';
import { toAgentMessages } from './history';

/**
 * 每页条数。后端上限 100（`limit` le=100，越界回 422）。
 * 取 50：聊天面板高度有限，一次拉满 100 条会多出一屏看不见的请求。
 */
const HISTORY_PAGE_SIZE = 50;

export type HistoryStatus = 'loading' | 'error' | undefined;

/**
 * 只需要 agent 的这几个能力 —— 写窄接口，测试能传个假对象进来。
 */
export interface HistoryTarget {
  setMessages: (messages: Message[]) => void;
  /**
   * agent 现在有哪些消息（只读，读的是当前那一份）。
   *
   * 唯一用途：判断「这个 sessionId 出现的时候，这一轮是不是已经在飞了」——
   * 见文件头坑 3 和 effect 里的守卫。**不要**拿它当渲染数据源。
   */
  messages: readonly Message[];
}

/**
 * 「刷新之后要把哪一次运行接回来」——没有就是无事可做。
 *
 * `kind` 只是**为什么**要接（给界面/日志看的），续订动作本身与它无关：
 * 两种情况都走同一条路（订阅那个 run_id 的事件流，从头补发）。
 */
export interface ResumeCandidate {
  /** 要续订的后端 run_id。 */
  runId: string;
  /**
   * `interrupted` —— 那一轮的助手消息落库时状态是"被打断"，即**停在人工审批**上；
   * `running`     —— 最后一条是用户消息，助手那条还没落库，即**多半还在跑**。
   */
  kind: 'interrupted' | 'running';
}

/**
 * 从一页会话历史里推出「有没有一次没跑完的运行」。
 *
 * 只看**最后一条带 run_id 的消息**，因为消息是按 seq 升序（旧 → 新）来的：
 *   · 它是 user   → 这一轮的助手消息还没落库 → 可能还在跑 → 续订；
 *     也可能那一轮以失败告终且没有助手消息 —— 那也没关系，订阅会立刻补发
 *     `run.failed`，界面照实显示（比"什么都不做、用户永远看不到结果"好）；
 *   · 它是 assistant 且 `interrupted` → 停在人工审批 → 续订（重放会把审批卡重建出来）；
 *   · 它是 assistant 且 completed/failed/cancelled → 这一轮已经了结 → 不续订。
 *
 * ⚠️ 为什么"已了结"这一条是必需的，而不是"能订阅就订阅"
 * ------------------------------------------------
 *   事件流**从头补发**。对已经跑完的那一轮重订，等于把整段回答重放一遍，
 *   而 AG-UI 的消息 id 里带着这次流自己的 streamId（见 runEventStream 的
 *   RunStreamContext）—— 不会覆盖旧的那条，只会**多出一条一模一样的**。
 *   用户看到的就是"同一段回答出现了两次"。
 *
 * ⚠️ 这一步**读的是后端事实**，不是本地标记
 * ----------------------------------------
 *   本地那份会话数据（data.ts）只知道"用过没有"，不知道后端跑到哪了。
 *   消息行上的 `run_id` / `status` 才是后端写的，能区分上面三种情形。
 */
export function resumeCandidateOf(
  messages: readonly SessionMessage[],
): ResumeCandidate | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const { run_id: runId, role, status } = messages[i];
    // 没有 run_id 的行（今天不会有，契约里它可空）说明不了任何事，继续往前找。
    if (!runId) continue;

    if (role === 'user') return { runId, kind: 'running' };
    // 契约里 role 只有 user / assistant 两个取值，走到这里必然是 assistant。
    return status === 'interrupted'
      ? { runId, kind: 'interrupted' }
      : undefined;
  }
  return undefined;
}

export interface UseSessionHistoryResult {
  /** 当前状态。注意「已经加载完」是 undefined，不是 'success'（没有信息量）。 */
  status: HistoryStatus;
  /**
   * 让下次进入这个会话时重新拉历史。
   * 在**发过新消息之后**调用（不是发消息那一刻立即重灌，见文件头坑 2）。
   *
   * 传参可指定别的会话（删除时要清的是**被删的那个**，它通常不是当前会话）；
   * 不传就是当前会话。
   */
  invalidate: (sessionId?: string) => void;
  /**
   * 有没有一次"没跑完"的运行需要接回来（判据见 resumeCandidateOf）。
   *
   * ⚠️ 它随 history 一起更新，且**缓存命中也算** —— 缓存里那份历史反映的是
   * 上次拿到的后端事实，同样能推出结论。切走再切回同一个会话时走的就是缓存那条路，
   * 而"切回来要接着看"正是这个功能的主场景之一。
   *
   * ⚠️ 只有**属于当前会话**的候选才会出现在这里 —— 见下面 resumeCandidate 的推导。
   */
  resumeCandidate: ResumeCandidate | undefined;
}

/**
 * 候选 + 它是从哪个会话的历史里推出来的。
 *
 * ⚠️ 为什么要成对存 sessionId（这是个真踩过的 bug）
 * --------------------------------------------
 *   组件切会话时是"先换 props 渲染、再跑 effect"：`resume` 这份 state 在**那一帧**
 *   还留着上一个会话的值。而新会话那一帧恰好是 RunResume 随
 *   `<CopilotKit key={activeId}>` 重挂、决定"要不要续订"的那一帧 —— 直接交出去
 *   就等于把上一个会话的 run_id 接给了新会话的 agent：订阅之后重放出来的
 *   `hitl.requested` 会让**审批卡在别的会话里冒出来**（用户报的 bug）。
 *   所以候选必须自报家门，出口处再按当前 sessionId 过滤。
 */
interface CandidateHolder {
  sessionId: string;
  candidate: ResumeCandidate;
}

/**
 * 缓存里存一条会话的：灌给 agent 的消息 + 从**同一份历史**推出的续订候选。
 *
 * 候选要一起存，是因为缓存命中那条路（切走再切回）也要能回答"要不要接回来"，
 * 而它手里只有这份缓存、不会重新请求。存消息的同时存下当时的结论，
 * 就不必事后从 AG-UI 消息的 metadata 里再推一遍（那需要 Readonly 解包、
 * 还得再写一个平行判据 —— 两份判据迟早会走岔）。
 */
interface CacheEntry {
  messages: Message[];
  resumeCandidate: ResumeCandidate | undefined;
}

export function useSessionHistory(
  target: HistoryTarget,
  sessionId: string | undefined,
): UseSessionHistoryResult {
  const [status, setStatus] = useState<HistoryStatus>(undefined);

  /**
   * 有没有一次没跑完的运行要接回来（见 resumeCandidateOf）—— 连同它来自哪个会话。
   *
   * ⚠️ 它**不**进 effect 的依赖 —— 依赖只有 [sessionId, target]，
   * 否则这个 effect 自己写自己、自己又触发自己，转圈。
   */
  const [resume, setResume] = useState<CandidateHolder | undefined>(undefined);

  /**
   * 已拉到的历史，按 sessionId 存。
   *
   * ⚠️ 必须是 **ref** 而不是 useState
   * ------------------------------
   *   `key={activeId}` 让整棵 CopilotKit 在切会话时重挂，但**这个 hook 所在的
   *   组件（CopilotDock）不卸载** —— 所以 ref 与 useState 在真实运行里都能活下来。
   *   可它同时也是这个 hook 唯一正确的选择：`useState` 写缓存会触发重渲染，
   *   而重渲染会让下面的 effect 重跑（cache 在依赖里）—— 逻辑上多转一圈，
   *   依赖一改（比如 agent 换实例）就可能变成"缓存刚写完又发一次请求"。
   *   ref 写入不触发渲染，effect 的触发时机完全由 sessionId / target 决定。
   *
   *   ⚠️ 曾经这里写着「并发实例共享缓存」—— 那是错的：useRef 是**每个 hook 实例
   *   一份**，`unmount` 之后重新 `renderHook` 就是新实例、新 ref、缓存为空。
   *   （useSessionHistory.test.ts 的 invalidate 用例在 remount 后断言「打了 2 次
   *   接口」，正好反证了这条 —— 那次第 2 发是因为缓存没了，不是因为 invalidate。）
   *   缓存的真实作用是：**同一个实例内跨会话切换**复用（CopilotDock 常驻，
   *   切会话时本 hook 不卸载，见文件头坑 1）。invalidate 也在这个前提下才有意义。
   */
  const cacheRef = useRef<Record<string, CacheEntry>>({});

  /**
   * 缓存已失效的 sessionId。
   *
   * 什么时候失效：用户在这个会话里**又发了新消息** —— 缓存里没有刚发的那轮。
   * 什么时候**不**失效：接口返回的那一刻。历史在返回时就是新的，此时置失效
   * 会让下次进来白拉一次。
   */
  const staleRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 没建后端会话（本地新对话还没发过消息）→ 没有历史可拉
    if (!sessionId) {
      setStatus(undefined);
      setResume(undefined);
      return;
    }

    let cancelled = false;

    /**
     * ⚠️ 守卫：agent 里已经有消息了 —— 这一轮正在飞，**什么都不要做**（坑 3）。
     *
     * 典型的触发时机：新对话发第一条消息。CopilotKit 先 `addMessage`，随后
     * 懒建会话拿回 session_id、写进 state，sessionId 一变本 effect 就重跑 ——
     * 此刻 agent 非空，而历史接口多半还没看到这条消息（createRun 没提交完），
     * 拉回来是空的。继续往下走就是 `setMessages([])` 把在飞的那一轮清掉。
     *
     * 直接早退还顺带解决「缓存该不该写」的疑问：什么都不写 —— 这个 sessionId
     * 的历史**本来就不在缓存的意义里**，等下次真切进来（新 agent、agent 为空）
     * 会走正常路径重新拉，那时后端也已经把这一轮落库了，拿到的才是完整历史。
     *
     * `setStatus(undefined)` 不能省：上一次进来若停在 'loading'，不清掉那条
     * 「正在加载对话记录…」会一直挂着，而我们已经不再等任何东西了。
     */
    if (target.messages.length > 0) {
      setStatus(undefined);
      // agent 里已经有消息 = 这一轮正在这个页面里飞（见坑 3），不必再去接一次。
      setResume(undefined);
      return;
    }

    /**
     * 缓存命中也要灌 target —— agent 每次切会话都是新实例（见文件头坑 1）。
     * 这一步是"第二次点回同一个会话还能看到历史"的全部原因。
     */
    const cached = cacheRef.current[sessionId];
    if (cached && !staleRef.current.has(sessionId)) {
      target.setMessages(cached.messages);
      setResume(
        cached.resumeCandidate
          ? { sessionId, candidate: cached.resumeCandidate }
          : undefined,
      );
      setStatus(undefined);
      return;
    }

    setStatus('loading');
    listSessionMessages(sessionId, { limit: HISTORY_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        // 带上 sessionId：工具行的成败取自本地存档（后端没落这个字段），
        // 见 history.ts 的 toAgentMessages 与 toolStatusCache.ts。
        const messages = toAgentMessages(page.messages, sessionId);
        // 续订候选从**后端那一页**推，不是从转换后的 AG-UI 消息推 ——
        // 判据要读 run_id / role / status 三个后端字段（见 resumeCandidateOf）。
        const candidate = resumeCandidateOf(page.messages);
        // 缓存照存（下次切回来要用），但**灌之前再看看 agent 空不空** ——
        // 等接口的这段时间里用户完全可能已经发出了新的一轮（挂载时就带着
        // sessionId 的对话，历史还没回来人就开始打字）。同一条不变量，同一个判据。
        cacheRef.current[sessionId] = {
          messages,
          resumeCandidate: candidate,
        };
        staleRef.current.delete(sessionId);
        if (target.messages.length === 0) target.setMessages(messages);
        setResume(candidate ? { sessionId, candidate } : undefined);
        setStatus(undefined);
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, target]);

  const invalidate = useCallback(
    (target?: string) => {
      /**
       * 不带参数 = 当前会话（"发过新消息了，缓存不全"那条路）。
       *
       * 带参数 = 指定的那个会话 —— 删除用的就是这条：被删的往往**不是**
       * 当前会话，不加参数就会把当前会话的缓存误标失效（下次进来白拉一次），
       * 而真正该清的那份反而留着。
       */
      const id = target ?? sessionId;
      if (!id) return;
      staleRef.current.add(id);
    },
    [sessionId],
  );

  /**
   * ⚠️ 出口只交**属于当前会话**的候选
   * ---------------------------------
   *   切会话时 state 换得比 props 慢一帧（effect 在渲染之后才跑），而 RunResume
   *   正是在那一帧随 `<CopilotKit key={activeId}>` 重挂 —— 不做这个过滤，
   *   它就会把**上一个会话**的 run_id 接给新会话的 agent，重放的
   *   `hitl.requested` 会让审批卡在别的会话里冒出来（用户报的 bug）。
   *
   *   判据放在这一个出口上，比在每个 setState 点都记得清一遍可靠 ——
   *   而缓存命中那条路也天然被它盖住（缓存里的候选同样带着自己的 sessionId）。
   */
  const resumeCandidate =
    resume && resume.sessionId === sessionId ? resume.candidate : undefined;

  return { status, invalidate, resumeCandidate };
}
