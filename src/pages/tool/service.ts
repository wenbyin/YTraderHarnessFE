// src/pages/tool/service.ts
// 对接 YTraderHarness 后端的 /api/v1/tools（tool.yaml v1.0.0）
// 与 /api/v1/capabilities（capability.yaml v1.0.0）。
//
// **能力（capability）树已经从 tool.yaml 搬到 capability.yaml**，路径与实体名都变了：
//   GET/POST        /classifications      →  /capabilities
//   GET/PATCH/PUT/  /classifications/{id} →  /capabilities/{id}
//   DELETE
//   实体            Classification       →  Capability
//
// **没跟着搬的**：`/tools/{tool_id}/classifications`（Tool ↔ 能力 的关联）仍在 tool.yaml，
// 契约里它就叫 Classification、路径也没变 —— 见下面 getToolClassifications /
// replaceToolClassifications，那两个函数**故意保留原名**。
//
// 所以要记的是：同一个业务对象在两个服务里有两个名字。能力树本身归
// /capabilities 管，工具"挂了哪些能力"归 /tools 管。
//
// 另外两件与调用方式有关的事：
//   - documentation 的写操作是 **PUT 全量替换**，没有 PATCH / DELETE；
//     某个 tool 没有文档记录时 GET documentation 可能 404，图层自己兜底。
//   - 列表是分页的（page / page_size，最大 200）；能力树是**一次性全量返回**，不分页。
import { request } from '@umijs/max';

import type {
  Capability,
  CapabilityCreate,
  CapabilityReplace,
  CapabilityUpdate,
  ListCapabilitiesParams,
  ListToolsParams,
  MCPProviderListResponse,
  PagedToolSummaryResponse,
  ToolDefinitionDetail,
  ToolDocumentation,
  ToolDocumentationUpdate,
  ToolEnabledState,
  ToolEnabledUpdate,
  ToolSyncRequest,
  ToolSyncResult,
} from './data';

/**
 * 首屏加载用的 GET 一律 skipErrorHandler：
 *
 * 首屏有三四个 GET 并行发出（工具列表 / 能力树 / provider 清单 / 处理链），
 * 后端没起、令牌过期、某个模块还没建表都会让它们一起失败 —— 全局错误处理
 * 会把这几个失败刷成一片 toast，而页面本身已经准备了页内告警条与空态。
 * 失败事由由页面收下来（loadError / providersError），不看的人不受打扰。
 *
 * 写操作（POST/PUT/PATCH）刻意**不加**这个选项：那是用户显式触发的动作，
 * 失败必须出声。
 */

const TOOLS = '/api/v1/tools';
/** 能力树（capability.yaml）。原先是 /api/v1/classifications，已整体迁移。 */
const CAPABILITIES = '/api/v1/capabilities';
/**
 * MCP provider 清单（mcp_provider.yaml / app/api/v1/mcp_providers.py）。
 * 路径主语是 provider（外部 server），所以**不在** /tools 下面。
 */
const MCP_PROVIDERS = '/api/v1/mcp/providers';

/** 列表查询。GET /api/v1/tools */
export async function listTools(params: ListToolsParams) {
  return request<PagedToolSummaryResponse>(TOOLS, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}

/** 详情（manifest + documentation + classifications 一次拿全）。GET /api/v1/tools/{tool_id} */
export async function getTool(toolId: string) {
  return request<ToolDefinitionDetail>(`${TOOLS}/${toolId}`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

/** 从代码/运行时重新发现并同步 Tool 定义。POST /api/v1/tools/discovery/sync */
export async function syncTools(body?: ToolSyncRequest) {
  return request<ToolSyncResult>(`${TOOLS}/discovery/sync`, {
    method: 'POST',
    data: body ?? {},
  });
}

/**
 * 运行时下线 / 恢复一个 Tool。PATCH /api/v1/tools/{tool_id}/enabled
 *
 * 这是这一页**唯一一个会改变 Agent 行为的写操作**：
 *   enabled=false -> 从**下一轮**工具解析起不再下发给 LLM（主 agent / planner /
 *                    skill 共用同一条解析路径）；正在跑的那一轮不受影响。
 *   enabled=true  -> 恢复，下一轮又能看到它。
 *
 * 三个必须记住的点：
 *   1. 它是**状态设置**（幂等），不是切换 —— 别写成 `!current`，并发点两次会打架。
 *   2. 持久层是"有行 = 禁用"，键是稳定的 `tool_key`；sync（含 remove_missing）
 *      **不会碰**这张表，所以代码改动冲不掉人工设的开关，重新发现后仍然禁用
 *      （fail-closed）。只有这个接口能改回来。
 *   3. 不加 skipErrorHandler：这是用户显式触发的动作，失败必须出声 ——
 *      否则会出现"界面显示已下线、实际后端没变"的静默错位。
 */
export async function setToolEnabled(toolId: string, enabled: boolean) {
  return request<ToolEnabledState>(`${TOOLS}/${toolId}/enabled`, {
    method: 'PATCH',
    data: { enabled } satisfies ToolEnabledUpdate,
  });
}

/** GET /api/v1/tools/{tool_id}/documentation */
export async function getToolDocumentation(toolId: string) {
  return request<ToolDocumentation>(`${TOOLS}/${toolId}/documentation`, {
    method: 'GET',
  });
}

/**
 * PUT /api/v1/tools/{tool_id}/documentation
 *
 * **全量替换**：body 里没带的 parameter_path 会被当成「这条覆盖被删掉了」。
 * 想要保留某条覆盖就得原样带着它的 description_override。
 */
export async function replaceToolDocumentation(
  toolId: string,
  body: ToolDocumentationUpdate,
) {
  return request<ToolDocumentation>(`${TOOLS}/${toolId}/documentation`, {
    method: 'PUT',
    data: body,
  });
}

/** GET /api/v1/tools/{tool_id}/classifications */
export async function getToolClassifications(toolId: string) {
  return request<Capability[]>(`${TOOLS}/${toolId}/classifications`, {
    method: 'GET',
  });
}

/** PUT /api/v1/tools/{tool_id}/classifications —— 同样是全量替换。 */
export async function replaceToolClassifications(
  toolId: string,
  body: { classification_ids: string[] },
) {
  return request<Capability[]>(`${TOOLS}/${toolId}/classifications`, {
    method: 'PUT',
    data: body,
  });
}

/**
 * 能力树。GET /api/v1/capabilities
 *
 * 不分页 —— 能力是给 LLM 做路由用的字典，量级只有几十上百，
 * 前端一次拉全再自己 buildTree，比按层懒加载简单也更快。
 */
export async function listCapabilities(params?: ListCapabilitiesParams) {
  return request<Capability[]>(CAPABILITIES, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}

/**
 * MCP provider 列表。GET /api/v1/mcp/providers
 *
 * 三个用途，都在这一页上：
 *   1. `name`        作为 `GET /tools?source_ref=<name>` 的取值（过滤条件）；
 *   2. `tool_count`  下拉项里显示"这个来源有几个工具"；
 *   3. enabled/connected/exposed_*  选中后的状态明细（见 mcpProvider.ts）。
 *
 * ⚠️ 只读。增删改 provider 要改后端 mcp.yaml 并重启进程 —— 连接是启动期
 *   建立的，热改配置不会自动重连。所以这一页**不提供**任何 provider 写操作，
 *   别在这里加"启用/停用开关"：保存了也不生效，比没有更误导。
 *
 * skipErrorHandler：和列表一样是首屏 GET，失败要退化成页内空下拉，
 * 不能刷一片 toast。
 */
export async function listMcpProviders() {
  return request<MCPProviderListResponse>(MCP_PROVIDERS, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

/** POST /api/v1/capabilities */
export async function createCapability(body: CapabilityCreate) {
  return request<Capability>(CAPABILITIES, {
    method: 'POST',
    data: body,
  });
}

/** GET /api/v1/capabilities/{capability_id} */
export async function getCapability(capabilityId: string) {
  return request<Capability>(`${CAPABILITIES}/${capabilityId}`, {
    method: 'GET',
  });
}

/** PATCH /api/v1/capabilities/{capability_id} */
export async function updateCapability(
  capabilityId: string,
  body: CapabilityUpdate,
) {
  return request<Capability>(`${CAPABILITIES}/${capabilityId}`, {
    method: 'PATCH',
    data: body,
  });
}

/**
 * PUT /api/v1/capabilities/{capability_id}
 *
 * 与 PATCH 的区别是**省略即清空**（description / parent_id 会被写成 null），
 * 所以调用方必须把 sort_order / is_active 也一起传。编辑表单走 PATCH，
 * 这里留给确实要"整体覆盖"的场景。
 */
export async function replaceCapability(
  capabilityId: string,
  body: CapabilityReplace,
) {
  return request<Capability>(`${CAPABILITIES}/${capabilityId}`, {
    method: 'PUT',
    data: body,
  });
}

/**
 * DELETE /api/v1/capabilities/{capability_id}?force=
 *
 * 硬删除，成功是 **204 无 body**，所以返回类型是 void。
 *
 * 两种 409（契约原文）：
 *   - **还有子节点** —— 一律拒绝，**force 无效**。自引用 FK 故意不做级联，
 *     要先把子节点挪走或停用，再删这个节点。
 *   - **仍被工具引用** —— 默认拒绝，错误信息里带引用数；`force=true` 才删，
 *     并把那些关联一并解掉（ON DELETE CASCADE，只靠它分类的工具会变未分类）。
 *
 * 不传 force 时后端按 false 处理，但显式写上能让调用处一眼看清语义。
 */
export async function deleteCapability(capabilityId: string, force = false) {
  return request<void>(`${CAPABILITIES}/${capabilityId}`, {
    method: 'DELETE',
    params: { force },
  });
}

/**
 * 从 request 抛出的错误里掏 HTTP 状态码。
 *
 * umi 的错误对象是 `{ response, data, ... }` 的形态但没有类型声明，
 * 这里做鸭子类型判断，取不到就返回 undefined —— 判不出来时**不要**假装是 409，
 * 宁可当普通失败处理。
 */
export function httpStatus(e: unknown): number | undefined {
  const res = (e as { response?: { status?: number } } | null)?.response;
  return typeof res?.status === 'number' ? res.status : undefined;
}
