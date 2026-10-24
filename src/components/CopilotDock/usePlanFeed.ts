// src/components/CopilotDock/usePlanFeed.ts
//
// 订阅「这一轮的任务计划」，归约成一条快照给输入框上方的状态栏用。
//
// 它和 useHiddenWork / useToolActivity 是同一族：都读**翻译器**发出来的
// CUSTOM 事件（`ytrader.plan`），都不碰 `agent.messages`。
// 为什么不进消息流的理由见 runEventStream 的 PLAN_CUSTOM_EVENT 那段。
//
// ⚠️ 什么时候必须**扔掉**手上这份计划
// ------------------------------
//   1. **下一轮运行开始了**（runId 变了）—— 不管上一份是"跑到一半断了"
//      还是"已经收摊"，它都不该继续占着输入框上方。
//      ⚠️ 但不是**立刻**扔掉：先标 `retiring` 让 dock 播完折叠 + 淡出
//      （`PLAN_RETIRE_MS`），到点才真正清出 state（用户 2026-10-22：
//      「第二次订阅新的 run 做一个动画效果隐藏」）。
//      直接置空的话元素是从 DOM 里瞬间没的，一条 23px 的框凭空消失很难看。
//   2. 换 agent（切会话）—— 那是另一个对话的计划。
//
//   ⚠️ 不能拿 `onRunStartedEvent` 当"新一轮"的判据：一次 HITL 审批在界面侧
//      是**两次 AG-UI run**（中断一次、恢复一次，同一个后端 run_id），
//      按它清会让计划在用户答完审批那一刻消失，而后端并不会重发 plan.published。
//      所以判据只能是**后端** runId（事件载荷里的那个）。
//
// ⚠️ 为什么连 tool 事件也要听
// ----------------------
//   计划事件不一定紧跟在一轮运行的开头（有时整轮都没有计划）。而"runId 变了"
//   这件事，最先到的往往是工具事件或计划事件 —— 所以这一层对**所有**带 runId
//   的 CUSTOM 事件都做一次"还是不是同一轮"的检查，只有计划事件才改内容。
//   少这一条的话，"上一轮有任务、这一轮没有"这种情形会永远留着旧的任务栏。
//
// ⚠️ 为什么不用 `prev => ...` 的函数式更新
// ------------------------------------
//   退场要**排一个定时器**，那是副作用；而 updater 在 StrictMode 下会被调用
//   两次 —— 定时器也会排两次。所以这里改成用一个 `planRef` 镜像当前快照，
//   在回调里读它、算完再一次性 commit，副作用留在能够确定只跑一次的地方。
//   这条通道只有一个订阅者（本 hook 自己的 onCustomEvent），单线程下不会打架。

import type { AbstractAgent } from '@ag-ui/client';
import { useEffect, useRef, useState } from 'react';

import {
  PLAN_RETIRE_MS,
  type PlanEventPayload,
  type PlanView,
  reducePlan,
} from './planTasks';
import { PLAN_CUSTOM_EVENT } from './runEventStream';

/** 从任意 CUSTOM 载荷里尽量读出后端 runId（没有就是空串）。 */
function runIdOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : '';
}

export function usePlanFeed(agent: AbstractAgent): PlanView | null {
  const [plan, setPlan] = useState<PlanView | null>(null);
  /**
   * 当前快照的镜像。
   * ⚠️ 不是为了少读一次 state —— 是为了在**回调里**（而不是在 updater 里）
   *    就能判断"该不该退场"，顺便让定时器只排一次。见文件头。
   */
  const planRef = useRef<PlanView | null>(null);

  useEffect(() => {
    // 换了 agent（切会话）→ 上一份计划属于另一个对话，直接丢掉。
    planRef.current = null;
    setPlan(null);

    /** 退场定时器：到点把快照真正清掉（期间来了新计划就被 commit 取消）。 */
    let retireTimer: ReturnType<typeof setTimeout> | null = null;
    const stopRetire = () => {
      if (retireTimer !== null) {
        clearTimeout(retireTimer);
        retireTimer = null;
      }
    };

    /**
     * 提交一份新快照。
     * 同一个引用 = 什么都没变，直接返回（`task.updated` 的续租会按秒推，
     * 不能每帧都让 React 重渲染一遍）。
     */
    const commit = (next: PlanView | null) => {
      if (next === planRef.current) return;
      // 任何一次真正的替换都意味着"不必再退场了"（新计划来了 / 已清空）
      stopRetire();
      planRef.current = next;
      setPlan(next);
    };

    /**
     * 开始退场：先标 `retiring` 让 CSS 播动画，`PLAN_RETIRE_MS` 之后清空。
     *
     * ⚠️ 到点时要再确认一次"现在还是那份要退场的计划"：这 260ms 里完全
     *    可能来一条新计划，否则新 dock 会被这个定时器从屏幕上抹掉。
     */
    const retire = () => {
      const prev = planRef.current;
      if (!prev || prev.retiring) return;
      commit({ ...prev, retiring: true });
      retireTimer = setTimeout(() => {
        retireTimer = null;
        if (planRef.current?.retiring) commit(null);
      }, PLAN_RETIRE_MS);
    };

    const { unsubscribe } = agent.subscribe({
      onCustomEvent: ({ event }) => {
        const value = event.value;

        if (event.name !== PLAN_CUSTOM_EVENT) {
          // 不是计划事件，但可能带来了"换了后端 run"的信号 —— 见文件头。
          const runId = runIdOf(value);
          if (runId !== '' && planRef.current?.runId !== runId) retire();
          return;
        }

        // 载荷是外部形状（后端 JSON 直传），认不出就当没这回事：
        // 这一层只负责"多一条状态栏"，崩不起。
        if (typeof value !== 'object' || value === null) return;
        const payload = value as PlanEventPayload;
        if (typeof payload.event !== 'string') return;
        if (typeof payload.data !== 'object' || payload.data === null) return;

        commit(reducePlan(planRef.current, payload));
      },
    });

    return () => {
      stopRetire();
      unsubscribe();
    };
  }, [agent]);

  return plan;
}
