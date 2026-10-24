// src/components/CopilotDock/toolStatusCache.ts
//
// 「那次调用到底成没成」的本地存档 —— 只为一件事：**刷新之后，历史里的工具行
// 和刚才 SSE 里跑出来的一模一样**（用户 2026-10-20 的要求）。
//
// 为什么必须存在前端（而不是直接读历史）
// ----------------------------------
//   后端落库的 tool_activity 只有"调了谁"：
//     · ToolMessage 上其实有 `status="success|error"`（见 tools.py 的
//       `_tool_message`），但 `message_recorder._content_blocks` **只留文本块**，
//       `tool_call_id` 与 `status` 都没进 content、也没进 meta；
//     · 消息行的 `status` 是**整次运行**的终态（record_messages 给同一批消息
//       打同一个值），不是"这一次调用"的。
//   所以库里没有逐次成败 —— 刷新后前端想复现 SSE 的那三个图标，只能自己记。
//
//   这是**过渡**方案：真正的修法是后端把 ToolMessage 的 status / tool_call_id
//   随内容块一起落库（契约的 ContentBlock 是 additionalProperties: true，
//   不用迁移），前端再加一段"以库里为准"的读取即可。在那之前，这份缓存让
//   同一个浏览器里的"刷新"与"实时"完全一致。
//
// ⚠️⚠️ 必须按**后端 run_id** 分桶，不能"一个会话只留一份"
// ------------------------------------------------
//   初版是一个会话一份列表，靠"页面里最后一次运行的 run_id"去匹配行 ——
//   那个写法在 HITL 问答这条路上**必然错**（用户 2026-10-21 报的就是它）：
//     一次审批在界面侧是**两次 AG-UI run**（中断一次、带上答案恢复一次，
//     见 agent.ts 的文件头），而这两次都属于**同一个后端 run_id**。
//     初版把后一次的记录整个覆盖掉前一次的，于是刷新之后只有「审批之后调的
//     那几个工具」有图标，审批之前的一排全部没有。
//   分桶之后：两次落在同一个桶里（记录本身会累加 —— useToolActivity 已经不再
//   无条件清空），前后两段的图标都在。
//
//   附带修掉另外两处同类隐患：历史翻页被截断时「页面里最后一个 run_id」未必是
//   我们真看过的那次；以及 interaction 消息夹在同一次运行的中间 —— 按 run 匹配
//   都不受影响。
//
// 存什么、怎么匹配
// --------------
//   · 一级键是**后端 session_id**（不是本地会话 id —— 后者删了重建就变）；
//   · 二级键是**后端 run_id**，一个会话留最近 `MAX_RUNS` 次运行；
//   · **看过的**运行才有桶 —— 没看过的行一个图标都不画（下面那条原则）；
//   · 值是一次运行里的工具状态，按调用开始的顺序；
//   · 匹配用 `sameTool`（点分 / 下划线 / 短名三种写法都认），并且**按序消费**：
//     同一个工具在一轮里被调了两次（一成一败）时，两行各自拿到自己的状态。
//   · 只存**已经落地**的记录（done / error）。running 不存 —— 刷新之后那次
//     运行要么已经结束（历史里会有终态），要么会被 RunResume 接回来重新跑事件。
//
// 为什么不在没有缓存时瞎猜
// --------------------
//   没见过的运行（别的浏览器 / 清了缓存 / 更早的会话）**不猜**：
//   `status` 留空，那一行就只显示名字（与加状态图标之前一样）。
//   凭"这次运行 completed"就给所有调用画绿勾是错的 —— 后端把工具失败包成
//   `ToolMessage(status="error")` 之后**图会继续跑**，一次 completed 的运行里
//   完全可能夹着失败的工具调用（见 tools.py 的 `_unexposed_message` 注释）。
//
// 容量与失败
// --------
//   localStorage 可能不可用（隐私模式 / 配额满 / 单测环境）—— 一律 try/catch
//   静默降级成"没有缓存"，绝不因为记不下来就让聊天崩掉。总容量按
//   「40 个会话 × 每个会话 3 次运行 × 每次 40 条调用」封顶，写下新的同时
//   丢掉最旧的那一次运行（再旧就丢会话）。

import { sameTool } from './toolIdentity';
import type { ToolActivityItem, ToolCallStatus } from './useToolActivity';

/** 落地的两种状态。running 不入库（见文件头）。 */
export type SettledToolStatus = Exclude<ToolCallStatus, 'running'>;

/** 存档里的一条：工具名 + 终态（错误文本只给悬停提示用）。 */
export interface CachedToolStatus {
  name: string;
  status: SettledToolStatus;
  error?: string;
}

/** 一次运行的那份记录。按插入顺序存，最旧的那份先被丢。 */
export interface CachedRunStatuses {
  runId: string;
  statuses: CachedToolStatus[];
}

const STORAGE_KEY = 'ytrader.dock.tool-status';
/** 最多记多少个会话（超出丢最旧的键）。 */
const MAX_SESSIONS = 40;
/** 一个会话最多留几次运行（超出丢最旧的那个 run）。 */
const MAX_RUNS = 3;
/** 一次运行最多记多少条调用。 */
const MAX_ITEMS = 40;

type Store = Record<string, CachedRunStatuses[]>;

function storage(): Storage | null {
  try {
    // 直接取 localStorage：SSR / 被禁用的环境里访问本身就会抛。
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读整份存档。任何异常（坏 JSON / 不可用 / 旧格式）都当成"没有"。 */
function read(): Store {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};

    // 逐层校验：这份数据是**别人也可能写**（旧版本、手改过的 localStorage），
    // 形状不对就整个当没有 —— 半份能读、半份是 undefined 比全丢更难查。
    const out: Store = {};
    for (const [sessionId, value] of Object.entries(parsed as Store)) {
      if (!Array.isArray(value)) continue;
      const runs: CachedRunStatuses[] = [];
      for (const bucket of value) {
        if (!bucket || typeof bucket.runId !== 'string') continue;
        if (!Array.isArray(bucket.statuses)) continue;
        runs.push({ runId: bucket.runId, statuses: bucket.statuses });
      }
      if (runs.length > 0) out[sessionId] = runs;
    }
    return out;
  } catch {
    return {};
  }
}

function write(value: Store): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 配额满 / 被禁用：宁可这次记不下来，也不要抛到渲染链路上。
  }
}

/**
 * 把一次运行里工具调用的成败收出来（按工具分桶）。
 *
 * `items` 可能横跨**两次界面侧的运行**（审批前后），但它们属于同一个后端
 * run_id —— 事件里带着那个 id（见 ToolActivityPayload.runId），所以这里按它分组，
 * 交给 caller 逐组落盘。
 *
 * ⚠️ 只在真的知道时产出：全都在跑（刚 called）时什么都不给 ——
 *    否则刷新后看到一片"已完成"的假象。等它们落地，下一次同步会写进去。
 * ⚠️ 认不出 run_id 的那一部分直接丢（见文件头 —— 宁可没有图标，也不存错的）。
 */
function groupSettled(
  items: readonly ToolActivityItem[],
): Map<string, CachedToolStatus[]> {
  const groups = new Map<string, CachedToolStatus[]>();

  for (const item of items) {
    // running 不入库；没有 run_id 的这条记不下来（不知道该归到哪次运行）。
    if (item.status === 'running') continue;
    if (!item.runId) continue;

    const list = groups.get(item.runId) ?? [];
    list.push(
      item.error
        ? { name: item.name, status: item.status, error: item.error }
        : { name: item.name, status: item.status },
    );
    groups.set(item.runId, list);
  }

  return groups;
}

/**
 * 把**这一轮**的工具状态记下来（按后端 run_id 分桶写入）。
 *
 * ⚠️ 同一个 run 是**覆盖**而不是追加：`useToolActivity` 那条记录本身在审批恢复
 *    时会累加（不清空），所以最后同步过来的这份已经是「这一轮到目前为止的全部」。
 *    改成追加则会让每一次 UI 刷新都把它自己再录一遍 —— 一会儿就撑爆上限。
 */
export function rememberToolStatuses(
  sessionId: string | undefined,
  items: readonly ToolActivityItem[],
): void {
  if (!sessionId || items.length === 0) return;

  const groups = groupSettled(items);
  if (groups.size === 0) return;

  const store = read();
  // 保留顺序：`cached` 里旧的在前、新的在后 —— Insertion 顺序即我们写入的顺序。
  let runs = store[sessionId] ?? [];

  for (const [runId, statuses] of groups) {
    const kept = statuses.slice(-MAX_ITEMS);
    const index = runs.findIndex((bucket) => bucket.runId === runId);
    if (index === -1) runs.push({ runId, statuses: kept });
    else runs[index] = { runId, statuses: kept };
  }

  // 每次写完 schema 顺序：写过的那个 run 排到队尾（最"新"），多余的丢队首。
  for (const runId of groups.keys()) {
    const index = runs.findIndex((bucket) => bucket.runId === runId);
    if (index === -1 || index === runs.length - 1) continue;
    runs = [...runs.slice(0, index), ...runs.slice(index + 1), runs[index]];
  }
  while (runs.length > MAX_RUNS) runs = runs.slice(1);

  store[sessionId] = runs;

  const keys = Object.keys(store);
  if (keys.length > MAX_SESSIONS) {
    // 插入顺序 = 我们的写入顺序，最前面的就是最久没写过的。
    for (const key of keys.slice(0, keys.length - MAX_SESSIONS))
      delete store[key];
  }
  write(store);
}

/**
 * 「按运行 + 工具名取状态」的解析器。一个会话一个，内部给**每个 run** 各维护
 * 一个消费游标（同一个工具被调多次时，逐行取各自那一条）。
 */
export type CachedStatusResolver = (
  runId: string | null | undefined,
  name: string,
) => CachedToolStatus | undefined;

/** 给这个会话造一个解析器；没有存档就 `null`（调用方不必逐条问）。 */
export function createCachedStatusResolver(
  sessionId: string | undefined,
): CachedStatusResolver | null {
  if (!sessionId) return null;

  const runs = read()[sessionId];
  if (!Array.isArray(runs) || runs.length === 0) return null;

  const cursors = new Map<string, Set<number>>();

  return (runId: string | null | undefined, name: string) => {
    if (!runId || name === '') return undefined;

    const bucket = runs.find((entry) => entry.runId === runId);
    if (!bucket || !Array.isArray(bucket.statuses)) return undefined;

    const used = cursors.get(runId) ?? new Set<number>();
    cursors.set(runId, used);

    const index = bucket.statuses.findIndex(
      (entry, i) =>
        !used.has(i) &&
        entry &&
        typeof entry.name === 'string' &&
        sameTool(entry.name, name),
    );
    if (index === -1) return undefined;

    used.add(index);
    const hit = bucket.statuses[index];
    return hit.status === 'done' || hit.status === 'error' ? hit : undefined;
  };
}

/** 供测试复位（模块无状态，但 localStorage 是共享的）。 */
export function resetToolStatusCache(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // 同 write：失败就算了
  }
}
