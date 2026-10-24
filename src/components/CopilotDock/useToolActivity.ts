// src/components/CopilotDock/useToolActivity.ts
//
// 订阅「这一轮调了哪些工具、每一条现在是什么状态」。
//
// 一条调用 = 一行，状态机完全由事件驱动：
//
//     tool.called                → running   （行内转圈）
//     tool.completed（无 error） → done      （绿勾）
//     tool.completed（带 error） → error     （红叉）
//
// ⚠️⚠️ 为什么必须按「工具身份」去重，而不只是按 tool_call_id
// ---------------------------------------------------------
//   后端对同一次调用在历史上存在**两条**发布通道（见
//   app/agent/event/run_event_projector.py 的 `_on_tool` 注释）：
//
//     · custom 通道（正路）—— tools 节点执行前后自己写自定义流，带的是
//       模型的 `tool_call_id`（`call_00_…`）与 **tool_key**（点分：
//       `agent.current_time` / `web.search`）；
//     · langgraph 的 `tools` 通道（老路）—— `on_tool_start/end` 回调，
//       名字取的是**工具函数名**（`current_time` / `search`），id 是
//       langgraph 回退的 `str(run_id)`（一个 UUID）—— 与真正的
//       `tool_call_id` **完全对不上**。
//
//   老路现在**已经不再发 RunEvent**（只喂 trace），但只要线上还跑着旧版
//   后端，前端就会收到成对的两条：一条点分 tool_key、一条短函数名，
//   而且 **id 不同**。只按 id 去重的话，一次调用就是两行 ——
//   用户看到的就是「每个工具都调了两次」（2026-10-20 实报）。
//
//   所以这里以「工具身份」兜底：`agent.current_time` 与 `current_time`
//   认作同一个工具（见 `sameTool`），合并成一行，并保留**更具体的那个名字**
//   （点分的 tool_key）。这样无论线上是哪个版本的后端，界面都是"一调用一行"。
//
// ⚠️ 为什么行在 called 时就要建
// -------------------------
//   以前只在 completed 时记录，于是"工具跑着的这段时间"界面上没有任何一行
//   属于它 —— 只有输入框上沿那枚「正在调用工具…」胶囊（那枚胶囊另有职责：
//   正文一条都还没出现时，它是唯一的信号，所以仍然保留）。
//   现在调用一开始就把行放出来（转圈），完成 / 失败**原地**改图标 ——
//   同一条调用的生命周期不换行、不抖动。
//
// ⚠️ 为什么不往 `messages` 里塞一条 tool_activity
// --------------------------------------------
//   塞不进去，而且会"出现又消失"：`@ag-ui/client` 的 `defaultApplyEvents`
//   在流开始时就把 `agent.messages` 克隆成局部数组，之后每帧基于**同一份**
//   克隆重算并整份回写 —— 中途 `addMessage()` 插进去的那条，下一帧就被覆盖。
//   详见 runEventStream.ts 的文件头。
//
// ⚠️ 配对顺序：callId → 同名 → 顺序
// -------------------------------
//   并行调用时 start/end 是交错的，只有 id 能精确配对；拿不到 id（后端那个
//   字段是 `Any`，缺了就是空串）时退化成"同名的最早那个还没结束的"，
//   再退化成"最早那个还没结束的"。串行场景足够准；并行且无 id 时可能配错，
//   但不会卡住（宁可配错，也不要让 loading 永远转）。

import type { AbstractAgent } from '@ag-ui/client';
import { useEffect, useState } from 'react';

import {
  TOOL_ACTIVITY_CUSTOM_EVENT,
  type ToolActivityPayload,
} from './runEventStream';
import { sameTool } from './toolIdentity';

/** 一条工具调用的状态。与三个事件一一对应（见文件头的状态机）。 */
export type ToolCallStatus = 'running' | 'done' | 'error';

/** 一条工具调用记录。界面只需要名字 + 状态。 */
export interface ToolActivityItem {
  /**
   * 稳定 key：优先 `tool_call_id`。后端没给 id 时是 `anon-<序>`（本地自增）。
   * ⚠️ 别拿 `name` 当 key：并行调同一个工具时两条记录的 key 会撞。
   */
  key: string;
  /** 工具名。两条通道写法不同时保留更具体的那个（点分 tool_key）。 */
  name: string;
  status: ToolCallStatus;
  /**
   * 这次调用属于**哪一次后端运行**（空 = 这次流还没拿到 run_id）。
   *
   * 它的唯一作用是让本地存档（toolStatusCache）按运行归并 —— 一次 HITL
   * 审批在界面侧是两次 AG-UI run，但属于**同一个**后端 run_id，两边的工具
   * 记录必须合成一份，否则刷新之后只有最后那一小段画得出图标。
   */
  runId?: string;
  /**
   * 这次调用属于**哪一步**（那一步助手消息的 id）；不知道就没有这个字段。
   *
   * 渲染层按它把工具行放回对应消息的 section（见 ToolActivityPayload 的
   * 同名注释）：实时与刷新后的历史要长得一样，而历史里工具行本来就是
   * 独立消息、天然落在正确的步之间。
   *
   * ⚠️ 可选而不是必填：本地存档（toolStatusCache）之类的调用方只关心
   *    名字与状态，逼它们填一个自己不认识的 id 只会造出假数据。
   */
  messageId?: string;
  /** `tool.completed` 里带的错误文本（成功时没有）。只用于悬停提示。 */
  error?: string;
}

export interface LiveToolActivity {
  /** 现在有几个工具在跑（>0 → 显示「正在调用工具…」胶囊）。 */
  running: number;
  /** 这一轮调过的全部工具，**按调用开始的顺序**（含还在跑的）。 */
  items: ToolActivityItem[];
}

const EMPTY: LiveToolActivity = { running: 0, items: [] };

interface State {
  items: ToolActivityItem[];
  /** 没有 id 的记录要用它生成 key。 */
  anon: number;
  /**
   * 这批记录属于哪一次 **AG-UI run**（CopilotKit 那一轮的标识）。
   *
   * ⚠️ 它是"要不要清空"的判据：审批恢复时 CopilotKit **复用同一个 runId**
   *    （见 agent.ts 的文件头），那时不能清 —— 清了界面上审批之前调过的
   *    那些工具就整批消失了（Historical: 用户报的"工具卡片被合并"）。
   */
  agUiRunId: string;
}

const IDLE: State = { items: [], anon: 0, agUiRunId: '' };

/**
 * 这个名字"更具体"吗 —— 点分 tool_key 优先于短函数名，同级取长的。
 *
 * 两条通道给的是同一个工具时留哪个：`agent.current_time` 比 `current_time`
 * 信息多（带命名空间），而 `current_time` 又比空串好。永远不要让**更差的
 * 名字**覆盖掉已经拿到的好名字。
 */
function isBetterName(next: string, current: string): boolean {
  if (next === '' || next === current) return false;
  if (current === '') return true;
  const nextDotted = next.includes('.');
  const currentDotted = current.includes('.');
  if (nextDotted !== currentDotted) return nextDotted;
  return next.length > current.length;
}

/**
 * 「同一个工具」的判据 —— 实现与理由在 toolIdentity.ts。
 *
 * ⚠️ 判据**不再住在**这个文件里：历史通道（history + ToolActivityRow）也要用它，
 *    而从这里 import 会把 runEventStream → agentRuntime 整条请求链拖进纯数据层
 *    的单测。这里只是转出口，别处老的 import 不用改。
 */
export { sameTool, wireOf } from './toolIdentity';

/** 这一帧描述的那条记录在列表里的位置（没有就是 -1）。 */
function findIndex(
  items: readonly ToolActivityItem[],
  callId: string,
  name: string,
  phase: ToolActivityPayload['phase'],
): number {
  if (callId !== '') {
    const byId = items.findIndex((item) => item.key === callId);
    if (byId !== -1) return byId;
  }

  // 先找**还在跑**的同名记录：两条通道报同一次调用时，第二条要把第一条认领掉。
  const running = items.findIndex(
    (item) => item.status === 'running' && sameTool(item.name, name),
  );
  if (running !== -1) return running;

  // ⚠️ 只有 end 才允许认领**已经落地**的同名记录（那是重复发布的 completed）。
  //    start 认领已完成的记录会把"串行第二次调同一个工具"并进上一次 ——
  //    界面上就少了一行，而少一行比多一行更难发现。
  if (phase === 'end') {
    return items.findIndex((item) => sameTool(item.name, name));
  }
  return -1;
}

/**
 * 把一帧事件套到列表上：命中就**原地更新**，没命中才追加。
 *
 * 同一个 key 的重复到达（后端偶尔会重复发布一次）走更新分支，不会多出行。
 */
function apply(
  items: readonly ToolActivityItem[],
  next: {
    key: string;
    name: string;
    status: ToolCallStatus;
    messageId: string;
    runId: string;
    error?: string;
  },
  phase: ToolActivityPayload['phase'],
): ToolActivityItem[] {
  const index = findIndex(items, next.key, next.name, phase);

  if (index === -1) {
    return [
      ...items,
      {
        ...next,
        name: next.name || '(未命名工具)',
      },
    ];
  }

  const current = items[index];
  return items.map((item, i) => {
    if (i !== index) return item;
    const name = isBetterName(next.name, current.name)
      ? next.name
      : current.name;
    // 已经落地（done / error）的记录不因为一条迟到的 start 退回 running：
    // 那会让界面在"完成"和"转圈"之间反复横跳。
    const status =
      next.status === 'running' && current.status !== 'running'
        ? current.status
        : next.status;
    return {
      ...item,
      name,
      status,
      // 两条通道报同一次调用时可能只有一边带着 messageId —— 有值就别丢。
      messageId: item.messageId || next.messageId,
      error: next.error ?? item.error,
    };
  });
}

export function useToolActivity(agent: AbstractAgent): LiveToolActivity {
  const [state, setState] = useState<State>(IDLE);

  useEffect(() => {
    // 换了 agent（切会话）就从头算：上一个 agent 那几个"还在跑"的工具
    // 永远等不到它的 end，不清就会一直显示"正在调用工具"。
    setState(IDLE);

    const { unsubscribe } = agent.subscribe({
      /**
       * 新一轮：**换 id 才清空**。
       *
       * ⚠️ 不能无条件清 —— 审批恢复（resume）是"再来一次 run"，而 CopilotKit
       *    **复用同一个 runId**（见 agent.ts 的文件头）。无条件清的话，用户答完
       *    审批的那一刻，审批之前调过的那些工具卡片会从界面上整批消失 ——
       *    界面看起来就像"前面的工具记录被合并/被吞掉了"，而它们明明发生过。
       */
      onRunStartedEvent: ({ event }) => {
        const id = typeof event?.runId === 'string' ? event.runId : '';
        setState((prev) => {
          if (id === '' || prev.agUiRunId === id) return prev;
          // 第一次进来（prev 还没 id）：没有东西可清，只把 id 记下。
          if (prev.agUiRunId === '') return { ...prev, agUiRunId: id };
          return { ...IDLE, agUiRunId: id };
        });
        return {};
      },

      onCustomEvent: ({ event }) => {
        if (event.name !== TOOL_ACTIVITY_CUSTOM_EVENT) return;

        // CUSTOM 的 value 是外部形状：认不出来就当没这回事，不要抛 ——
        // 这一层只负责显示，崩不起。
        const payload = event.value as Partial<ToolActivityPayload> | null;
        if (!payload || typeof payload !== 'object') return;
        if (payload.phase !== 'start' && payload.phase !== 'end') return;

        // 收窄成局部常量：`payload` 是可变的 Partial，narrowing 进不到
        // setState 的回调里（那里读到的仍是 `start | end | undefined`）。
        const phase: ToolActivityPayload['phase'] = payload.phase;
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        const name = typeof payload.name === 'string' ? payload.name : '';
        const error = typeof payload.error === 'string' ? payload.error : '';
        const messageId =
          typeof payload.messageId === 'string' ? payload.messageId : '';
        const runId = typeof payload.runId === 'string' ? payload.runId : '';

        setState((prev) => {
          const status: ToolCallStatus =
            phase === 'start' ? 'running' : error !== '' ? 'error' : 'done';

          const anon = callId === '' ? prev.anon + 1 : prev.anon;
          const key = callId === '' ? `anon-${anon}` : callId;

          return {
            ...prev,
            items: apply(
              prev.items,
              {
                key,
                name,
                status,
                messageId,
                runId,
                error: error || undefined,
              },
              phase,
            ),
            anon,
          };
        });
      },
    });

    return unsubscribe;
  }, [agent]);

  if (state.items.length === 0) return EMPTY;

  return {
    running: state.items.filter((item) => item.status === 'running').length,
    items: state.items,
  };
}
