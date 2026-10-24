// src/pages/tool/mcpProvider.ts
// MCP provider 的**展示文本 + 筛选联动**（纯函数，可单测）。
//
// 为什么单独一个模块而不是塞进 ToolList.tsx
// ----------------------------------------
// 联动规则有三条，全部来自后端语义（见 data.ts 里 ListToolsParams.source_ref
// 那段）。它们**错了不会报错**：后端只是返回一个空列表，界面看上去跟
// "这个 provider 没有工具"一模一样。这种"错了也像没数据"的逻辑必须有测试
// 盯着 —— 塞在组件里就只能靠渲染 + 断言 DOM 去测，绕且脆。
//
// 三条规则：
//   1. 选了 provider       → source_type 自动置 mcp
//   2. 类型改成非 mcp      → provider 清掉
//   3. 类型清空（不限）    → provider 保留（source_ref 单独就是"这个来源的全部工具"）

import type { MCPProviderSummary } from './data';

/** provider 在界面上的三态。注意 `disabled` 优先于 `connected`，见下面。 */
export type MCPProviderHealth = 'connected' | 'offline' | 'disabled';

/**
 * 归一成一个状态。
 *
 * ⚠️ 判断顺序不能反：配置里停用的 provider，即使进程内会话还没断
 *   （connected=true，热改配置不会自动断开），也不该显示成"已连接" ——
 *   那会让人以为它还能被调用。`enabled` 是**总开关**，它说了算。
 */
export function mcpProviderHealth(p: MCPProviderSummary): MCPProviderHealth {
  if (!p.enabled) return 'disabled';
  return p.connected ? 'connected' : 'offline';
}

const HEALTH_TEXT: Record<MCPProviderHealth, string> = {
  connected: '已连接',
  offline: '未连接',
  disabled: '已停用',
};

export function mcpProviderHealthText(health: MCPProviderHealth): string {
  return HEALTH_TEXT[health];
}

/**
 * 下拉项文字：`tdx · 9 个工具`。
 *
 * 条数用 **tool_count**（库里已同步的行）而不是 exposed_tool_count ——
 * 下拉过滤的是库里的行，显示 exposed 会出现"写着 9 个、点进去 0 条"
 * （连接成功但还没 sync 的 provider 就是这样）。两个数的区别见 data.ts。
 */
export function mcpProviderOptionLabel(p: MCPProviderSummary): string {
  if (!p.tool_count) return `${p.name} · 尚未同步`;
  return `${p.name} · ${p.tool_count} 个工具`;
}

/**
 * 下拉项最终显示的文字：在条数后面**只给异常状态**加后缀。
 *
 * 为什么"已连接"不加后缀：那是正常态，每个 provider 都挂着四个字会让
 * 下拉变成一个读不出重点的状态列表。真正要一眼看见的是"这个来源现在
 * 用不了"——未连接（起不来）/ 已停用（配置关了）。
 */
export function mcpProviderSelectLabel(p: MCPProviderSummary): string {
  const health = mcpProviderHealth(p);
  if (health === 'connected') return mcpProviderOptionLabel(p);
  return `${mcpProviderOptionLabel(p)}（${mcpProviderHealthText(health)}）`;
}

/**
 * 选中后那一行明细：把三组数字**都摊开**。
 *
 * 只显示"已连接"是不够的 —— 真正决定列表里有几条的是 active / missing，
 * 而 missing 行（代码里已找不到、但记录保留）恰恰是这一页最需要看见的东西。
 */
export function mcpProviderDetail(p: MCPProviderSummary): string {
  return [
    mcpProviderHealthText(mcpProviderHealth(p)),
    `暴露 ${p.exposed_tool_count}`,
    `已同步 ${p.tool_count}（ACTIVE ${p.active_tool_count} / MISSING ${p.missing_tool_count}）`,
  ].join(' · ');
}

/**
 * 类型不是 mcp 时，provider 这个筛选项必须禁掉。
 *
 * 空串（不限类型）**不禁** —— 那时候 source_ref 单独就是
 * "这个 provider 的全部工具"，后端支持（实测 `?source_ref=tdx` 有结果）。
 */
export function mcpFilterDisabled(sourceType: string): boolean {
  return Boolean(sourceType) && sourceType !== 'mcp';
}

/** 参与联动的最小状态形状。用泛型是为了让页面的 ToolFilters 原样传进来。 */
export interface SourceFilterState {
  source_type: string;
  source_ref: string;
}

/**
 * 应用一次筛选变更，并维护 source_type ↔ source_ref 的联动。
 *
 * 只改 patch 里出现过的键，其余原样带回去 —— 与 `{...prev, ...patch}` 同义，
 * 额外多做的是那两条自动修正。
 */
export function applyFilterPatch<T extends SourceFilterState>(
  prev: T,
  patch: Partial<SourceFilterState>,
): T {
  const next = { ...prev, ...patch } as T & SourceFilterState;

  // 规则 1：选了 provider -> 类型自动置 mcp。
  //   不自动的话，"local_method + tdx" 这种组合会静默返回空集，
  //   而界面上两个条件都显示为"已选"，没有任何线索指向原因。
  //   注意 `''`（清空）是 falsy，不会误触发。
  if (patch.source_ref) next.source_type = 'mcp';

  // 规则 2：类型改成非 mcp -> provider 清掉（同一条空集理由）。
  //   排在规则 1 之后：两处同时给值时以"选了 provider"为准（它更具体）。
  if (
    patch.source_type !== undefined &&
    patch.source_type !== '' &&
    patch.source_type !== 'mcp'
  ) {
    next.source_ref = '';
  }

  return next;
}
