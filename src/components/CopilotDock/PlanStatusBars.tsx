// src/components/CopilotDock/PlanStatusBars.tsx
//
// 输入框上方那一条「dock」（仿 cc-gui）：
//
//   ┌──────────────────────────┬───────────────┐
//   │ ⟳ 任务  1/3              │ ⟳ 子代理  1/2 │   ← 只有这一行
//   └──────────────────────────┴───────────────┘
//        ↑ 点左半边                              ↑ 点右半边
//
// 展开时**整条框向上长**：面板插在这一行的上方，收起时高度为 0。
//
// ⚠️ 为什么是一行两栏，而不是上下两条（2026-10-22 用户改的口径）
// ------------------------------------------------------------
//   上一版是两条独立的横条（任务一条、子代理一条），各占一行。问题在于
//   它俩是**同一件事的两个侧面**（这一轮在编排什么 / 谁在干），拆成两行
//   会让输入框上方凭空高出 50px，而两行里各有一半是空白。
//   现在合成一条：左半边任务、右半边子代理、中间一条竖线，
//   视觉上就是"输入框的第二行"，而不是浮在上面的面板。
//
// ⚠️ 展开面板在上面 —— 这是"向上展开"的实现方式
// ----------------------------------------
//   这一层（hiddenWorkLayer）是 flex-end 贴底、absolute 的，所以**只要面板
//   长在这一行的上方**，容器就从底边往上长，行本身的位置纹丝不动。
//   反过来把面板放在行下面，就等于往下挤输入框 —— 用户让它"向上"是有道理的：
//   下面就是输入框，没有空间。
//
// ⚠️ 两个展开**互斥**，而且整条框一起长
// ---------------------------------
//   收起态只有 28px 高，只够说"有 3 个任务、跑到第 1 个"。要看细节就得展开，
//   而两个面板同时展开会把消息区吃掉一大块（任务可能十几条），
//   所以标题行是**一个开关**：点哪半边就展开哪半边，另一边自动收起。
//   状态只有一个 `open: 'task' | 'agent' | null` —— 用两个布尔值迟早会
//   出现"两个都开着"的那一帧。
//
// ⚠️ 收起态只说"在跑"，不再复述标题
// ------------------------------
//   需求原话："没展开，直接在 task 前面显示 loading 效果即可"。
//   收起态因此只有：**语义图标**（任务 = 三条横杠 / 子代理 = 分叉）+ 名字 +
//   小 loading（只在真有东西在跑时）+ 计数。
//   那句人话（正在跑什么）退到 `title` 提示里 —— 想细看就展开，不占常驻空间。
//
// ⚠️⚠️ 计划结束**不消失**，只折叠（2026-10-22 用户）
// --------------------------------------------
//   原先 `plan.cleared` 直接把快照扔掉，dock 在最后一个任务完成的瞬间整个
//   消失：进度跑满 → 没了，连"到底成没成"都得靠回忆。现在后端收摊只是把快照
//   标成 `finished`（见 planTasks 的 PlanView.finished），这里做三件事：
//     · 面板**自动折叠**（用户要的那个动画就是同一条 max-height 过渡）；
//     · 图标从"在跑"变成勾/叉（颜色按终态）；
//     · 整条 dock 留在原位，等下一条 `plan.published` 把它整体替换。
//   想回看任务明细，再点一次照样能展开。
//
// ⚠️ 下一轮运行开始时，整条框**带动画退场**（2026-10-22 用户）
// ------------------------------------------------------
//   `plan.retiring` 一为真，整条 dock 就折叠 + 淡出（样式在 style.ts 的
//   planDock[data-plan-state='retiring']），`PLAN_RETIRE_MS` 之后才从 state
//   里真正移除（见 usePlanFeed）。所以这里**不需要**任何 JS 动画：
//   把状态挂到 `data-plan-state` 上就够了。
//   这段时间里它必须 `pointer-events: none` —— 一个正在淡出的框还能点，
//   点下去触发的却是即将被删掉的计划。
//
// ⚠️ 位置：它是 LiveActivityOverlay 那一摞里的一员（贴输入框上沿、absolute），
//    **不是**把输入框往下挤的普通流元素。理由：
//      · 展开/收起会让输入框上下跳 —— 用户正在打字时最烦这个；
//      · 消息区的高度预留（--dock-tool-feed-h）已经在那层里量好了，
//        挂进去白拿一份"别盖住最后一条消息"的保障；
//      · 这一层是 `pointer-events: none`，所以这条 dock 必须自己
//        把 pointer-events 打开（否则点不动）。见 style.ts 的 planDock。

import {
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MenuOutlined,
  MinusCircleOutlined,
  QuestionCircleOutlined,
  UpOutlined,
} from '@ant-design/icons';
import React, { useEffect, useState } from 'react';

import {
  agentName,
  currentTask,
  PHASE_LABEL,
  type PlanAgentView,
  type PlanTaskView,
  type PlanView,
  planCounts,
  subAgentBarSummary,
  subAgentPhase,
  subAgents,
  type TaskPhase,
  taskBarSummary,
  WORKER_PHASE_LABEL,
} from './planTasks';
import { useStyles } from './style';
import { taskShortTitle } from './taskTimeline';

type DockStyles = ReturnType<typeof useStyles>['styles'];

/** 一个任务态 → 一枚图标。颜色在 style.ts 里按 `data-phase` 给。 */
function PhaseIcon({ phase }: { phase: TaskPhase }) {
  switch (phase) {
    case 'running':
      // ⚠️ `spin` 必须写：antd 的 LoadingOutlined 默认不转。
      return <LoadingOutlined spin aria-hidden />;
    case 'done':
      return <CheckCircleOutlined aria-hidden />;
    case 'failed':
      return <CloseCircleOutlined aria-hidden />;
    case 'canceled':
      return <MinusCircleOutlined aria-hidden />;
    case 'pending':
      return <ClockCircleOutlined aria-hidden />;
    default:
      return <QuestionCircleOutlined aria-hidden />;
  }
}

/**
 * 标题行的**半边**。
 *
 * ⚠️ 用**原生 button**，不是 div + onClick：
 *   `aria-expanded` / 键盘可达 / 焦点框全是白拿的。
 *
 * ⚠️ 箭头朝上（`UpOutlined`）而不是朝右：这条框是**向上**展开的，
 *   朝右的箭头会让人以为要从左边滑出一块面板。
 *
 * ⚠️ 左边那枚**语义图标**（任务 = 三条横杠、子代理 = 分叉）与"在跑"是两件事
 * ------------------------------------------------------------------
 *   2026-10-22 用户：「任务和子代理都要图标，比如任务清单图标就是三条横杠」。
 *   上一版把图标位让给了 loading 圈，于是这一行只有"在转"没有"是什么" ——
 *   图标负责**说什么**，颜色负责**什么状态**（`data-phase` 上色），
 *   loading 单独排在名字后面（小一号），三者不抢同一个位置。
 */
const Segment: React.FC<{
  styles: DockStyles;
  /** 用于测试与排障的稳定标识（`task` / `sub-agent`）。 */
  kind: string;
  label: string;
  /** 语义图标（`MenuOutlined` / `BranchesOutlined`）—— 说"这一栏是什么"。 */
  glyph: React.ReactNode;
  /** 语义态，样式按它上色（在跑 = 主色、完成 = 成功、失败 = 错误）。 */
  phase: TaskPhase;
  /** 真的有东西在跑 → 名字后面补一枚 loading。 */
  running: boolean;
  /** 栏尾那枚计数（`1/3`）；空串不画。 */
  count: string;
  /** 悬停提示：收起态省掉的那句人话。 */
  hint: string;
  open: boolean;
  onToggle: () => void;
}> = ({
  styles,
  kind,
  label,
  glyph,
  phase,
  running,
  count,
  hint,
  open,
  onToggle,
}) => (
  <button
    type="button"
    className={styles.planDockSeg}
    data-plan-bar={kind}
    aria-expanded={open}
    title={hint}
    onClick={onToggle}
  >
    <span
      className={styles.planDockIcon}
      data-phase={phase}
      data-plan-icon={phase}
    >
      {glyph}
    </span>
    <span className={styles.planDockLabel}>{label}</span>
    {running ? (
      // ⚠️ `spin` 必须写：antd 的 LoadingOutlined 默认**不转**。
      <LoadingOutlined
        spin
        className={styles.planDockSpin}
        data-plan-spin="true"
        aria-hidden
      />
    ) : null}
    {count ? <span className={styles.planDockCount}>{count}</span> : null}
    <span className={styles.planDockGrow} />
    <UpOutlined
      className={`${styles.planDockCaret} ${open ? styles.planDockCaretOpen : ''}`}
      aria-hidden
    />
  </button>
);

/**
 * 展开后的一个任务行。
 *
 * ⚠️ 行里**不显示 skill**（它挪到 goal 那一行了）
 * ------------------------------------------
 *   同一个计划里的任务几乎总是同一个 skill（样例里三条都是 financial_research）。
 *   挂在每一行上等于在每行重复同一串 12 个字符，而这一行最缺的正是横向空间。
 *   改成"一个计划说一次"，行的三段就只剩下真正逐行不同的东西：
 *   标题 / 执行者 / 状态。
 *
 * ⚠️ `data-current` 是"后端说现在跑的是这条"（`current_task_id`），
 *   与 `data-phase` 不重复：一个任务可能状态还是 WORKING、但后端已经把
 *   current 指向了下一个（续租与切换不同步的那一帧）。高亮只看 current。
 */
const TaskRow: React.FC<{
  styles: DockStyles;
  task: PlanTaskView;
  current: boolean;
}> = ({ styles, task, current }) => (
  <div
    className={styles.planTaskRow}
    data-phase={task.phase}
    data-current={current}
    // 后端原值挂上去：对接口时得按原值说话（与 pages/tool 的 Tag 同一个口径）
    data-task-state={task.state}
    title={task.resultSummary ?? task.title}
  >
    <span className={styles.planTaskIcon} data-phase={task.phase}>
      <PhaseIcon phase={task.phase} />
    </span>
    {/*
      ⚠️ 只显示**第一句**（2026-10-22 用户："task 描述里面有简易描述或者标题吗，
        不要显示全文"）。后端没有 per-task 标题字段，title 是整段 description
        （"目标：… 输入：… 输出：…"），整段塞进这一行会被 CSS 切在半句话上。
        全文仍然在行的 title 属性里，悬停可见。
    */}
    <span className={styles.planTaskTitle}>
      {taskShortTitle(task.title) || '（这条任务没有描述）'}
    </span>
    <span className={styles.planTaskMeta}>
      {task.owner ? (
        <span className={styles.planTaskOwner}>{agentName(task.owner)}</span>
      ) : null}
      <span className={styles.planTaskPhase}>{PHASE_LABEL[task.phase]}</span>
    </span>
  </div>
);

/**
 * 展开后的一个**子代理**行（`subagent.*` 名册里的一条）。
 *
 * ⚠️ 三段的含义与任务行不一样，别照搬
 * ------------------------------
 *   名字    —— `worker:0`（`agentName` 保留 worker 那一段，见那里的注释）
 *   中间    —— 它手上那件事：优先"执行中的"，其次"已派出但还没认领的"，
 *              已收尾的退回"最后那件"（别把它干过什么擦掉），
 *              一条任务都没有才说"等待下一件任务 / 空闲"
 *   右端    —— **worker 自己的相位**（`WORKER_PHASE_LABEL`），不是任务的相位：
 *              一个 worker 派出去但还没认领时，它没有任务却有状态（已派出）
 *
 * ⚠️ 没有名册条目时（老后端 / claim 反推出来的执行者）要能照常渲染 ——
 *   退化成"从任务推相位"，与子代理事件上线之前的行为一致。
 */
const AgentRow: React.FC<{ styles: DockStyles; agent: PlanAgentView }> = ({
  styles,
  agent,
}) => {
  const running = agent.tasks.find((task) => task.phase === 'running');
  const waiting = agent.tasks.find((task) => task.phase === 'pending');
  const phase: TaskPhase =
    agent.worker?.phase ?? (running ? 'running' : 'pending');
  /*
   * ⚠️ 已收尾的 worker **仍然显示"它干了什么"**，不写"等待下一件任务"
   * ---------------------------------------------------------------
   *   右端已经写着「已完成」，中间再说"等待下一件任务"就等于把这行最有用
   *   的信息（做的是哪件事）擦掉了 —— 三行里只有一行有内容，读起来像表缺列。
   *   所以终态时退回它最后那个任务；只有"没任务"（`空闲`）和"派了但认领帧
   *   还没到"（`等待下一件任务`）才用空态文案。
   */
  const settled = [...agent.tasks]
    .reverse()
    .find(
      (task) =>
        task.phase === 'done' ||
        task.phase === 'failed' ||
        task.phase === 'canceled',
    );
  const terminal =
    phase === 'done' || phase === 'failed' || phase === 'canceled';
  const current = running ?? waiting ?? (terminal ? (settled ?? null) : null);
  const attempt = agent.worker?.attempt ?? 0;

  /*
   * 中间那格的字。
   * ⚠️ 空标题时的兜底要分相位看：一个**已完成**的任务若读不到标题（history
   *   缺 description），写"正在执行任务"会与右端「已完成」自相矛盾 ——
   *   宁可退回空态文案。
   */
  const shortTitle = current ? taskShortTitle(current.title) : '';
  const middle =
    shortTitle !== ''
      ? shortTitle
      : current && !terminal
        ? '正在执行任务'
        : agent.tasks.length
          ? '等待下一件任务'
          : '空闲';

  /*
   * 悬停提示：把"这一帧不显示、但对接口有用"的两组数字放这儿 ——
   *   · created 那一帧的波次规模（task_count / pending_count，**派出那一刻**的快照，
   *     不是实时值，所以只在 tooltip 里说"派出时"）；
   *   · claim.attempt（>1 = 这个任务被重试过，后端专门说了可以拿它显示）。
   */
  const worker = agent.worker;
  const hint = [
    worker?.taskCount != null
      ? `派出时：本波 ${worker.taskCount} 个任务${
          worker.pendingCount != null
            ? `，还有 ${worker.pendingCount} 个未认领`
            : ''
        }`
      : '',
    attempt > 1 ? `第 ${attempt} 次尝试` : '',
    current?.title ?? '',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  return (
    <div
      className={styles.planAgentRow}
      data-agent={agent.name}
      data-worker-phase={worker?.phase ?? 'none'}
      title={hint}
    >
      <span className={styles.planAgentName}>{agent.name}</span>
      <span className={styles.planAgentTask} title={current?.title ?? ''}>
        {middle}
      </span>
      {attempt > 1 ? (
        <span className={styles.planAgentAttempt}>第 {attempt} 次</span>
      ) : null}
      <span className={styles.planTaskPhase}>{WORKER_PHASE_LABEL[phase]}</span>
    </div>
  );
};

export interface PlanStatusBarsProps {
  plan: PlanView | null;
}

/** 哪半边是展开的。互斥的保证就在这一个值上（见文件头）。 */
type OpenSide = 'task' | 'agent' | null;

const PlanStatusBars: React.FC<PlanStatusBarsProps> = ({ plan }) => {
  const { styles } = useStyles();
  const [open, setOpen] = useState<OpenSide>(null);

  /*
   * ⭐ 计划一收摊，**自动把面板折叠起来**（用户 2026-10-22：「任务结束…
   *    做个动画折叠起来」）。
   *
   * ⚠️ 折叠用的是同一套 max-height 过渡，所以这里只要把 `open` 置空，
   *    面板就自己滑回去 —— 不需要额外的动画代码。
   * ⚠️ 只依赖 `finished` 这一个布尔：依赖整个 plan 会让每个 task.updated
   *    都跑一遍（虽然置空是幂等的，但会多出无意义的 setState）。
   * ⚠️ 这条 effect 必须在 early return **之前**（hook 顺序）。
   */
  const finished = plan?.finished ?? false;
  useEffect(() => {
    if (finished) setOpen(null);
  }, [finished]);

  /*
   * ⭐ 入场：「从底部附上来，把状态胶囊挤上去」（用户 2026-10-22）
   *
   * ⚠️ 为什么不能用 key 让它重挂来触发 CSS 动画
   * ----------------------------------------
   *   这条 dock 在 plan 为空时是 `return null`（组件本身**一直挂着**），
   *   所以 `useEffect(..., [])` 不会在"计划第一次出现"时重跑 —— 挂空的
   *   依赖项只会跑一次（那时 plan 还是 null）。
   *   用计划的身份（runId + planId）当依赖才是"新计划来了"那个时刻：
   *   同一份计划内的 task.updated 不会重播动画，换一轮才播。
   *
   * ⚠️ 为什么要**两帧**
   * -----------------
   *   过渡要成立，浏览器必须先按 `0fr` 布局一次再改成 `1fr`。一次 rAF 有时
   *   赶在同一帧里被合并（React 的 setState 与样式写入同批），动画就"直接
   *   出现"。两帧之后必然已经绘制过一次 `0fr`，过渡才真的从零高度长起来。
   *
   * ⚠️ 高度用 grid-template-rows 过渡（而不是 max-height）
   * --------------------------------------------------
   *   内容只有 24px 高，而 max-height 要写一个够大的上限（260px）才能兼容
   *   展开态 —— 从 0 过渡到 260 时，前 9% 的时间就已经超过真实高度，
   *   视觉上等于"瞬间出现"。grid 的 0fr → 1fr 过渡的是**真实高度**，
   *   胶囊是被**均匀**顶上来的。
   */
  const planKey = plan ? `${plan.runId}:${plan.planId}` : '';
  const [risen, setRisen] = useState(false);
  useEffect(() => {
    if (planKey === '') {
      setRisen(false);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setRisen(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [planKey]);

  // ⚠️ hook 必须在 early return **之前**调（useState 已经调完了，这里只是返回）。
  if (!plan) return null;

  const counts = planCounts(plan);
  const running = currentTask(plan);
  // 只列**并行子代理**：主代理手上那件事已经由左半边说清楚了，
  // 两边各说一遍同一件事，读起来像出现了两个执行者。
  const subs = subAgents(plan);
  const runningSubs = subs.filter((agent) => agent.running);

  /*
   * 左半边的状态：在跑 > 有失败 > 全完成 > 其余。
   * 顺序不能换 —— "有失败"要压过"全完成"，否则一个失败任务会被
   * 一次「全部完成」的勾掩盖掉。**只看颜色，不看图标**（图标固定是三条横杠）。
   */
  const taskPhase: TaskPhase = running
    ? 'running'
    : counts.failed > 0
      ? 'failed'
      : counts.total > 0 && counts.done === counts.total
        ? 'done'
        : 'pending';

  /*
   * 右半边：并行子代理（`subagent.*` 四条事件，2026-10-23 后端上线）。
   *
   * ⚠️ 相位由一个纯函数决定（`subAgentPhase`），不在这里现算 ——
   *    "在跑 > 有失败 > 全完成 > 其余"这条顺序与任务那边同一条判据，
   *    写两遍迟早会漂。一个子代理都没有时归 `canceled`（灰）：
   *    那是"这一轮没有第二个执行者"，不是"失败了"。
   */
  const agentPhase: TaskPhase = subAgentPhase(plan);

  const toggle = (side: Exclude<OpenSide, null>) =>
    setOpen((prev) => (prev === side ? null : side));

  /*
   * 计划级的 skill：整份计划只用一个技能时，在 goal 那一行说一次。
   * 多于一个就不说 —— 那说明它是逐任务的属性，一句话概括不了。
   */
  const skills = new Set(
    plan.tasks
      .map((task) => task.skillKey)
      .filter((key): key is string => !!key),
  );
  const planSkill = skills.size === 1 ? [...skills][0] : '';

  return (
    <div
      className={styles.planDock}
      data-plan-bars="true"
      // 展开的是哪一边 —— 测试与排障都读它，免得去数 DOM 高度
      data-plan-open={open ?? 'none'}
      /*
       * ⚠️ `retiring` = 下一轮运行已经开始了，这条 dock 正在**退场**
       *    （见 usePlanFeed）。样式层负责折叠 + 淡出，这里只把状态挂出去，
       *    顺手从无障碍树里摘掉：它已经在消失了，读屏再念一遍没有意义，
       *    也会让"点了没反应"的焦点无处可去（样式里同时关掉 pointer-events）。
       */
      data-plan-state={plan.retiring ? 'retiring' : 'live'}
      /* 入场（见上面 planKey 那段）：enter = 还没长出来，in = 已就位。 */
      data-plan-rise={risen ? 'in' : 'enter'}
      aria-hidden={plan.retiring ? true : undefined}
    >
      <div className={styles.planDockBody}>
        {/*
          ⚠️ 这层是**高度过渡的载体**（grid-template-rows 0fr → 1fr 要一个
          单独的格子来装内容）。没有它，三个子节点会各占一行，0fr 只压掉第一行。
          它自己不画任何东西：底色 / 圆角 / 边框都在外层 planDock 上。
        */}
        {/*
          展开面板（在标题行**上方** → 容器向上长）。
          两块都留在 DOM 里、各自用 data-open 控高：这样展开/收起都有动画，
          而互斥由 `open` 这一个值保证（同一时刻只有一块 data-open='true'）。
        */}
        <div
          className={styles.planDockPanel}
          data-plan-panel="task"
          data-open={open === 'task'}
          aria-hidden={open !== 'task'}
        >
          <div className={styles.planDockPanelInner}>
            {plan.goal || planSkill ? (
              <p className={styles.planGoal} title={plan.goal}>
                {plan.goal}
                {planSkill ? (
                  <span className={styles.planTaskSkill}> · {planSkill}</span>
                ) : null}
              </p>
            ) : null}
            {plan.tasks.length === 0 ? (
              <p className={styles.planEmpty}>计划里还没有任务</p>
            ) : (
              plan.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  styles={styles}
                  task={task}
                  current={task.id === plan.currentTaskId}
                />
              ))
            )}
          </div>
        </div>

        <div
          className={styles.planDockPanel}
          data-plan-panel="sub-agent"
          data-open={open === 'agent'}
          aria-hidden={open !== 'agent'}
        >
          <div className={styles.planDockPanelInner}>
            {subs.length === 0 ? (
              // 此刻真的没有并行执行者：要么这一轮由主代理独自完成，
              // 要么子代理事件还没到（第一个 created 之前）。
              // 两种情况说法一样 —— 界面只说事实，不去猜"稍后会不会派"。
              <p className={styles.planEmpty}>
                本轮全部由主代理执行，暂无并行子代理
              </p>
            ) : (
              <div className={styles.planAgentList}>
                {subs.map((agent) => (
                  <AgentRow key={agent.id} styles={styles} agent={agent} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles.planDockRow}>
          <Segment
            styles={styles}
            kind="task"
            label="任务"
            // 三条横杠 = 任务清单（用户点名要的形状）
            glyph={<MenuOutlined aria-hidden />}
            phase={taskPhase}
            running={running !== null}
            count={counts.total > 0 ? `${counts.done}/${counts.total}` : ''}
            hint={taskBarSummary(plan)}
            open={open === 'task'}
            onToggle={() => toggle('task')}
          />
          <span className={styles.planDockDivider} aria-hidden />
          <Segment
            styles={styles}
            kind="sub-agent"
            label="子代理"
            // 分叉 = 一个主代理派出去的几路并行
            glyph={<BranchesOutlined aria-hidden />}
            phase={agentPhase}
            running={runningSubs.length > 0}
            count={
              subs.length > 0 ? `${runningSubs.length}/${subs.length}` : ''
            }
            hint={subAgentBarSummary(plan)}
            open={open === 'agent'}
            onToggle={() => toggle('agent')}
          />
        </div>
      </div>
    </div>
  );
};

export default PlanStatusBars;
