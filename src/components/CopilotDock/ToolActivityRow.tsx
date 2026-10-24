// src/components/CopilotDock/ToolActivityRow.tsx
//
// 一条工具记录 —— **一次调用一张卡**，卡上只显示名字 + 状态。
//
// 需求原话：「将所有的 tool 调用，仅仅展示名字即可，无需列出参数和结果」，
// 2026-10-20 再补一句「终态就是一次 tool 调用一行数据」。所以具体到四种东西：
//
//   · 一次工具调用      -> **一张卡**「<状态图标> <人话名>」（一条记录里若有多个
//                          调用，就画多张 —— 并行调用不该挤在同一行里用「、」连）
//
// 名字走 i18n、状态只留图标（2026-10-22 起，10-23 收敛）
// ------------------------------------------------
//   原先卡上写死了「工具调用：」+ 后端原始标识符（`agent.enter_plan_mode`）。
//   现在：名字按 tool_key 查语言包（映射在 toolLabels.ts），
//   状态**只由一枚图标表达**（转圈 / 绿勾 / 红叉），不再印"正在调用"这种字
//   —— 用户 2026-10-23：「文字不用显示了，只要 icon 即可」。
//   那几句话说到底没删，退到了图标的 aria-label（读屏仍然念得出"调用成功"）。
//   原值仍然挂在 `data-tool` 与悬停提示里（排障要按原值对齐后端日志）。
//   · 参数（JSON）      -> **不显示**
//   · 工具产出（结果）  -> **不显示**，于是"工具结果"那一条（calls 为空、
//                          只有输出文本）**整条都不渲染**
//   · 模型旁白          -> **不显示**（"我先查一下…"也是名字之外的东西）
//
// 「不显示参数与产出」不是丢信息，而是**换个地方看**：那两样是给排障用的，
// 权威副本在后端日志与 message 表里；对话区是给用户看的，一行"调了哪个工具"
// 就够。⚠️ 但它们仍然在 `ToolActivityView` 里被解析出来（`args` / `text`）——
// 见下面那条注释，别把"没人读"当成"可以删"。
//
// ⚠️⚠️ 一次调用 = 一张卡（2026-10-21，用户报「工具调用卡片被合并了」）
// ----------------------------------------------------------------
//   上一版把一张记录里的 N 次调用画成**同一张卡里的 N 行**（行间最小档 24px）。
//   读起来就是"一坨工具行粘在正文卡片里"，而历史里同一条 `tool_activity`
//   明明是一条独立的消息。现在：
//
//     · 每张卡**只有一行**工具调用，卡与卡之间是**最大档** SPACE_WIDE；
//     · 卡片不再并入正文卡片 —— 正文一张卡、工具各一张卡，卡片之间一律最大档；
//     · 实时（SSE）与刷新后的历史走**同一个**组件，因此长得一模一样。
//
//   代价是"深度思考 → 正文 → 工具框"不再挤在同一个 section 里 —— 它拆成了
//   「正文卡」+「工具卡」。顺序（正文在前、工具在后）仍然保持，只是它们
//   现在是**两张卡**而不是"一张卡的两段"。
//
// 状态图标
// ------
//     running → 转圈    tool.called
//     done    → 绿勾    tool.completed（成功）
//     error   → 红叉    tool.completed 带 error（或 tool.error）
//
//   实时那一份的状态由事件推进（见 useToolActivity.ts）；历史那一份由
//   history.ts 从本地存档补进 `call.status`（见 toolStatusCache.ts 的文件头：
//   后端**没有**把逐次成败落库，所以不补就没有）。
//   补不到 = 不画图标：宁可只显示名字，也不替后端编一个绿勾 / 红叉。
//
// 为什么历史里也要"一次调用一张卡"
// --------------------------
//   历史里一条 tool_activity 可能把几次调用塞进同一条消息（模型一次要了
//   好几个工具），而后端对同一次调用的落库可能带两种写法
//   （`agent_current_time` / `agent.current_time`，见 useToolActivity 的文件头）。
//   照原样 join 出来就是「agent_current_time、agent_current_time」——
//   用户看到的正是这个。这里先按 `sameTool` 归并掉**同一次调用的两种写法**，
//   再一张卡一个 —— 于是刷新前后、并行串行，都是"一个调用一张卡"。
//
// 为什么不塞进助手气泡
// --------------------
//   最省事的做法是放开 history.ts 的过滤、让它当普通助手消息渲染 —— 但那样
//   工具的名字会以"模型说的话"的姿态出现在气泡里，用户会以为模型念了这些。
//   所以仍给它自己的形态：一张**次要**的记录卡（退一级的文字色 + 淡底，
//   没有头像、没有反馈按钮），一眼能看出"这是过程记录，不是回答"。

import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
} from '@ant-design/icons';
import { Tooltip } from 'antd';
import type React from 'react';

import type { ToolActivityView, ToolCallView } from './history';
import { useStyles } from './style';
import { sameTool } from './toolIdentity';
import { canonicalToolKey, UNNAMED_TOOL, useToolLabels } from './toolLabels';
import type { ToolCallStatus } from './useToolActivity';

/** 状态排序：合并同一次调用的两种写法时，**坏的那个赢**（别把失败藏起来）。 */
function worseStatus(
  a: ToolCallStatus | undefined,
  b: ToolCallStatus | undefined,
): ToolCallStatus | undefined {
  const rank = (status: ToolCallStatus | undefined): number => {
    if (status === 'error') return 3;
    if (status === 'done') return 2;
    if (status === 'running') return 1;
    return 0;
  };
  return rank(a) >= rank(b) ? a : b;
}

/**
 * 把一条记录里的调用归并成「一次调用一项」。
 *
 * ⚠️ 归并键是**工具身份**（`sameTool`），不是 `id`：后端对同一次调用的落库
 *    可能带着两个不同的 id（custom 通道的真 `tool_call_id` 与 langgraph
 *    `tools` 通道的 `str(run_id)`），按 id 去重会原样留下两张卡。
 *    代价是同一轮里真的并行调了**两个同名工具**时会被并成一项 —— 而那种
 *    情况下后端给的两行本来就无从区分（id 都可能是假的），少一张比多一张好。
 *
 * 名字为空的那条降级成占位文案：**绝不显示 `undefined`，也不整张吞掉**
 * （"看不到某个工具被调用过"比"名字难看"严重得多）。
 */
export function mergeToolCalls(calls: readonly ToolCallView[]): ToolCallView[] {
  const merged: ToolCallView[] = [];

  for (const call of calls) {
    const name = call.name || UNNAMED_TOOL;
    const index = merged.findIndex((item) => sameTool(item.name, name));
    if (index === -1) {
      merged.push({ ...call, name });
      continue;
    }

    const previous = merged[index];
    merged[index] = {
      ...previous,
      status: worseStatus(previous.status, call.status),
      error: previous.error ?? call.error,
    };
  }

  return merged;
}

/**
 * 一张「工具调用」卡片 —— 卡上只有一行：状态图标（可选）+ 状态词 + 工具名
 * （`正在调用：检索文档`，见文件头的 i18n 说明）。
 *
 * ⚠️ 为什么它**不是** section 本身（外面那层 div 才是）
 * -----------------------------------------------
 *   `[data-section-view]` 那套间距规则会给它的**直接子项**两两之间加最小档
 *   —— 卡片自己挂这个属性的话，里面的图标 / 状态词 / 名字三个 span
 *   会被拉开 24px。所以卡片是里层那一个 div，外层只负责"这是一张卡"。
 */
export const ToolActivityCard: React.FC<{
  name: string;
  status?: ToolCallStatus;
  /** 失败原因，挂在红叉的悬停提示上。 */
  error?: string;
}> = ({ name, status, error }) => {
  const { styles } = useStyles();
  const labels = useToolLabels();

  return (
    <div
      className={styles.toolActivity}
      data-kind="tool_activity"
      data-status={status ?? 'none'}
      /* 契约原值留痕：界面上是「正在调用：检索文档」，排障要拿原值对齐后端日志 */
      data-tool={canonicalToolKey(name)}
      title={labels.hint(name)}
    >
      {status ? (
        <Tooltip title={status === 'error' ? labels.error(error) : undefined}>
          {/*
            ⚠️ 状态**只由图标表达**（2026-10-23 用户："正在调用、调用成功、
              调用失败 文字不用显示了，只要 icon 即可"）。
              文字没有消失，只是退到 aria-label —— 读屏仍能念出"调用成功"，
              视觉上只留一枚 12px 的点。
            ⚠️ 图标自己 aria-hidden：antd 的 `<span role="img">` 自带
              英文名（"check-circle"），不关掉会把中文的 aria-label 顶掉。
          */}
          <span
            className={styles.toolActivityStatus}
            role="img"
            aria-label={labels.state(status)}
          >
            {status === 'running' ? (
              // ⚠️ `spin` 必须写：antd 的 LoadingOutlined 默认**不转**。
              <LoadingOutlined spin aria-hidden />
            ) : status === 'done' ? (
              <CheckCircleFilled aria-hidden />
            ) : (
              <CloseCircleFilled aria-hidden />
            )}
          </span>
        </Tooltip>
      ) : null}
      {/* 行内只剩工具名（状态词已退到上面那枚图标的 aria-label 里）。 */}
      <span className={styles.toolActivityName}>{labels.name(name)}</span>
    </div>
  );
};

/**
 * 时间线接续信息 —— 「这一组工具卡属于哪个任务」。
 *
 * 由 DockRenderMessage 给（它才是"这条消息在时间线上哪一行"的持有者）。
 * 工具卡是 `[data-section-view='tool']` 的独立 section，落在任务里时**必须
 * 自己把轨道画上**，否则时间线会在每一次工具调用处断一截 —— 而工具调用正是
 * 任务执行过程里最密集的那一段。
 */
export interface TaskLink {
  /** 任务 id（与 taskTimeline 的 TaskRow.taskId 一致）。 */
  id: string;
  /** 这一组的第一张卡要不要画圆点（正文卡没画出来时它接管节点）。 */
  dot: boolean;
  /** 这一组之后还有同一个任务的行（轨道要往下穿）。 */
  tail: boolean;
}

/**
 * 一条记录 -> 一张卡一个调用（**实时与历史共用**这一条路）。
 *
 * 两种通道喂进来的都是 `ToolActivityView`：
 *   · 历史：`history.ts` 从 `kind: 'tool_activity'` 那条消息里解析出来的；
 *   · 实时：`DockRenderMessage` 把 live 的那几行临时包成同一个形状 ——
 *     于是"SSE 与 message 渲染必须一致"不用写两遍。
 *
 * ⚠️ 返回的是 **Fragment 而不是一个容器**：每张卡必须是消息容器（`.copilotKitMessagesContainer`）
 *    的**直接子节点**，才能吃到"卡片与卡片"那条相邻规则
 *    （见 style.ts 的 chatPane 段）。套一层容器的话它们就都变成"卡内的段"了 ——
 *    那正是上一版"看起来被合并"的成因。
 *
 * ⚠️ 组首 / 组尾那两个标记（2026-10-21：四条缝要一样宽）
 * ---------------------------------------------
 *   用户：「思考 → 正文 → 工具卡之间的间距不是应该都一样吗，都属于统一挡位」。
 *   所以工具卡与**它自己这一步**之间走最小档（和"思考 → 正文"同一条），
 *   只有"这一步 → 下一步"才走最大档。CSS 只能看**相邻**，分不出"这两张
 *   卡是不是同一条消息"，所以由这里把边界标出来：
 *
 *     · `data-section-step-attached` —— 本组紧跟在**自己这条消息**的正文卡
 *       后面（渲染层传 `attached`）。只有这时"正文卡 → 工具卡"才是最小档；
 *       上一条消息的正文卡 + 这一组，那是两条消息之间，仍然最大档；
 *     · `data-section-step-end` —— 本组的最后一张。它后面是**另一条消息**，
 *       回到最大档（一步的边界）。
 *
 * ⚠️ 时间线（2026-10-22）不改变上面任何一条
 * -------------------------------------
 *   任务里的卡片多挂几个 `data-task-*` 标记（间距由 style.ts 的
 *   `[data-task-linked]` 那条统一收到最小档），其余语义照旧。
 */
const ToolActivityCards: React.FC<{
  view: ToolActivityView;
  /** 这一组是不是紧跟在自己那条消息的正文卡后面（决定组首的间距档位）。 */
  attached?: boolean;
  /** 这一组属于哪个任务（不在任务里就是 null/不传）。 */
  task?: TaskLink | null;
}> = ({ view, attached = false, task = null }) => {
  // 名字可以直接当 key：`mergeToolCalls` 之后同批之间不可能重名
  // （同一个工具会被并成一条，见那边）。别用数组下标 —— 调用顺序
  // 一变，React 就会把状态挪到别人身上。
  const calls = mergeToolCalls(view.calls);
  if (calls.length === 0) return null;

  return (
    <>
      {calls.map((call, index) => {
        const last = index === calls.length - 1;
        const dot = task !== null && index === 0 && task.dot;
        // 上面紧挨着的是同一个任务里的行吗 —— 组首看 attached，其余必然。
        const linked = task !== null && (attached || index > 0);

        return (
          <div
            data-section-view="tool"
            key={call.name}
            // 组首（紧跟本条消息的正文卡时）/ 组尾 —— 见上面的说明
            {...(index === 0 && attached
              ? { 'data-section-step-attached': 'true' }
              : {})}
            {...(last ? { 'data-section-step-end': 'true' } : {})}
            {...(task === null
              ? {}
              : {
                  'data-task-id': task.id,
                  ...(dot ? { 'data-task-dot': 'true' } : {}),
                  ...(linked
                    ? {
                        'data-task-open-top': 'true',
                        'data-task-linked': 'true',
                      }
                    : {}),
                  ...(!last || task.tail
                    ? { 'data-task-open-bottom': 'true' }
                    : {}),
                })}
          >
            {task === null ? null : (
              <>
                <span data-task-rail="true" aria-hidden="true" />
                {dot ? <span data-task-node="true" aria-hidden="true" /> : null}
              </>
            )}
            <ToolActivityCard
              name={call.name}
              status={call.status}
              error={call.error}
            />
          </div>
        );
      })}
    </>
  );
};

export default ToolActivityCards;
