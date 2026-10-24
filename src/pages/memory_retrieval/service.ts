// src/pages/memory_retrieval/service.ts
// 对接 YTraderHarness 后端 memory_api_v2.yaml（v2.0.0）。
//
// ⚠️ 2026-10-12 契约从「检索」改成「浏览」，这一层跟着换了两件事：
//    1. 路径 `/memory/retrieval/l*` -> `/memory/query/l*`，并新增 `/l2/detail`；
//    2. 返回体从"命中结果 + score"变成"**一页记录 + 游标**"（Pagination）。
//    所以这里不再有 mode 之类的召回参数，也没有 `degraded_routes`。
//
// ⚠️ 本组端点**全部**要求调用者持有 `Y-Trader-Admin` 角色，否则 403
//    （契约：JWT roles 里**精确包含**它）。两条连带后果要在界面上说清楚：
//
//      1. 鉴权关掉时（本地开发开关）bypass 身份里的 roles 是**刻意留空**的，
//         所以「本地能跑」不代表这些端点能通 —— auth 关闭 -> **403（不是 500，
//         也不是放行）**。本地要调它得走真 token。
//      2. 403 的客户端文案后端刻意含糊，全部线索在服务端日志。
//         所以前端不要自作聪明地翻译成"你没有登录"之类。
//
// ⚠️ 本组端点**不调模型**，也不做向量检索：返回的是**数据**（记录、分段结构、
//    拼好的提示词预览），不是渲染好的字符串。
import { request } from '@umijs/max';

import type {
  L0QueryRequest,
  L0QueryResponse,
  L1QueryRequest,
  L1QueryResponse,
  L2DetailRequest,
  L2DetailResponse,
  L2QueryRequest,
  L2QueryResponse,
  L3QueryResponse,
  MemoryRetrievalPrompt,
  MemoryRetrievalRequest,
  TargetRequest,
} from './data';

const API_BASE = '/api/v1/memory';

/**
 * 汇总：模拟每轮上下文组装（默认只带 L3 画像 + L2 场景索引）。
 * POST /api/v1/memory/retrieval
 *
 * ⚠️ 这个端点**不召回 L0/L1**，也不替 Agent 决定要不要调记忆工具（契约原话）。
 *    所以它给的是"默认上下文长什么样"，不是"这一轮该带什么"。
 *
 * 失败语义（展示交给调用方）：
 *   400 target 两个归属都给 / 都没给 / 漏 agent_id，或 retrieve / limits 越界
 *   403 调用者没有 Y-Trader-Admin 角色
 *
 * ⚠️ 某一层没答上来**不失败整次调用** —— 取不到的那层如实出现在 `degraded`
 *    里。所以拿到 200 也要检查 degraded，静默少一段是最坏的结果。
 */
export async function previewMemoryContext(body: MemoryRetrievalRequest) {
  return request<MemoryRetrievalPrompt>(`${API_BASE}/retrieval`, {
    method: 'POST',
    data: body,
  });
}

/**
 * L0 浏览 —— 分页列出**已保存**的原始消息（完整正文）。
 * POST /api/v1/memory/query/l0
 *
 * ⚠️ 不执行 hybrid / 向量 / 关键词召回：`text_contains` 只是**字面包含**。
 * ⚠️ 传了 session_id 但那个会话**不存在**时是 **404**（不是空列表）；
 *    团队 scope 调它直接 400。
 */
export async function queryMemoryL0(body: L0QueryRequest) {
  return request<L0QueryResponse>(`${API_BASE}/query/l0`, {
    method: 'POST',
    data: body,
  });
}

/**
 * L1 浏览 —— 分页列出**已保存**的原子记忆。
 * POST /api/v1/memory/query/l1
 *
 * ⚠️ 正文**整条返回，不截断**：一条 L1 记忆已经是提炼过的陈述，截断会把
 *    "喜欢 X，但**不能** Y"切成半句 —— 那比不返回更糟。
 * ⚠️ 团队 scope 调它直接 400。
 */
export async function queryMemoryL1(body: L1QueryRequest) {
  return request<L1QueryResponse>(`${API_BASE}/query/l1`, {
    method: 'POST',
    data: body,
  });
}

/**
 * L2 浏览 —— 分页列出场景**索引**（filename + summary + heat，没有正文）。
 * POST /api/v1/memory/query/l2
 *
 * ⚠️ v2 把正文从列表里拿掉了（上一版有个 `include_content` 开关）：要全文只能
 *    走 `/l2/detail`。`filename_contains` 是**文件名**的字面包含，不是内容过滤。
 */
export async function queryMemoryL2(body: L2QueryRequest) {
  return request<L2QueryResponse>(`${API_BASE}/query/l2`, {
    method: 'POST',
    data: body,
  });
}

/**
 * L2 详情 —— 按 `filename` 精确读取单篇场景全文（含 META 块）。
 * POST /api/v1/memory/query/l2/detail
 *
 * ⚠️ **找不到就是 404**（与"列表没筛到"的空列表区分开）—— 所以界面要能把这个
 *    404 与"scope 里没数据"分开说。
 */
export async function queryMemoryL2Detail(body: L2DetailRequest) {
  return request<L2DetailResponse>(`${API_BASE}/query/l2/detail`, {
    method: 'POST',
    data: body,
  });
}

/**
 * L3 读取 —— 取该 scope 的画像。
 * POST /api/v1/memory/query/l3
 *
 * ⚠️ 这里**只有 200**：没有画像是**正常状态**（`persona: null`），不是 404 ——
 *    管理员视图下不判 scope 是否存在（任何没见过的 scope 都只是"还没有数据"）。
 */
export async function queryMemoryL3(body: TargetRequest) {
  return request<L3QueryResponse>(`${API_BASE}/query/l3`, {
    method: 'POST',
    data: body,
  });
}
