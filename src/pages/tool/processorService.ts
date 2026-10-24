// src/pages/tool/processorService.ts
// 对接 YTraderHarness 后端 /api/v1/processors 与 /api/v1/tools/{tool_id}/processors
// （tool_processor.yaml v1.0.0，实现见 app/api/v1/processors.py 与 tool_processors.py）。
//
// 与 tool/service.ts 同一套取舍：
//   - 首屏 GET 一律 skipErrorHandler —— Tool 侧服务可能还没起，404 由页内空态承接，
//     不让首屏刷成一片 toast；写操作（PUT/POST）刻意不加，用户显式触发必须出声。
//   - 保存**只走 PUT 全量替换**一条路。POST / PATCH / DELETE 虽然都有，
//     但链是"顺序 + hook + config"一起变的，拆成多次写会出现"只有一半"的中间态；
//     而且 PUT 的返回说明写得很清楚：行是全删重建的，**processor_id 会全部重新生成**，
//     所以保存后必须重新 GET —— 别拿旧 id 去做后续操作。
import { request } from '@umijs/max';

import type {
  PagedProcessorDefinitionResponse,
  ReplaceToolProcessorChainRequest,
  ToolProcessorChain,
} from './processorChain';

const PROCESSORS = '/api/v1/processors';

/** 一次取满（契约上限 200）。注册表是代码里注册的，量级几十个。 */
export const REGISTRY_PAGE_SIZE = 200;

/**
 * 处理器**实现**目录。GET /api/v1/processors
 *
 * 只读 —— 实现归代码，管理面不能造处理器。
 * 这个接口不碰数据库（数据源是进程内注册表），所以后端别的服务挂了它也照样能出。
 */
export async function listProcessorDefinitions(params?: {
  keyword?: string;
  hook?: string;
  execution_mode?: string;
  page?: number;
  page_size?: number;
}) {
  return request<PagedProcessorDefinitionResponse>(PROCESSORS, {
    method: 'GET',
    params: { page: 1, page_size: REGISTRY_PAGE_SIZE, ...params },
    skipErrorHandler: true,
  });
}

/** GET /api/v1/tools/{tool_id}/processors —— 按 sequence 升序返回整条链。 */
export async function listToolProcessors(toolId: string, enabledOnly = false) {
  return request<ToolProcessorChain>(`/api/v1/tools/${toolId}/processors`, {
    method: 'GET',
    params: { enabled_only: enabledOnly },
    skipErrorHandler: true,
  });
}

/**
 * PUT /api/v1/tools/{tool_id}/processors —— 整体替换一条链。
 *
 * 数组顺序即执行顺序；传空数组即全部摘掉。
 * **没列出的会被删除**，且 processor_id 全部重新生成 —— 保存后要重新 GET。
 */
export async function replaceToolProcessorChain(
  toolId: string,
  body: ReplaceToolProcessorChainRequest,
) {
  return request<ToolProcessorChain>(`/api/v1/tools/${toolId}/processors`, {
    method: 'PUT',
    data: body,
  });
}

/**
 * PUT /api/v1/tools/{tool_id}/processors/order —— 只改顺序。
 *
 * 必须提交该 Tool **全部**挂载记录的 ID，少给 / 多给 / 混入别家的都会 409。
 * 当前页面统一走 replaceToolProcessorChain，这个接口留着给"只调顺序"的场景用。
 */
export async function reorderToolProcessors(
  toolId: string,
  body: { processor_ids: string[] },
) {
  return request<ToolProcessorChain>(
    `/api/v1/tools/${toolId}/processors/order`,
    { method: 'PUT', data: body },
  );
}
