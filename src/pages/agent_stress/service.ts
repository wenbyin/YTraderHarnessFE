// src/pages/agent_stress/service.ts
//
// 对接 design_agent_eval/openapi.yaml（Mock Model Stress Eval, v1.0.0）的 5 条路由：
//
//   POST   /api/v1/stress-runs                      → 202 StressRun
//   GET    /api/v1/stress-runs                      → 200 { items, next_cursor }
//   GET    /api/v1/stress-runs/{run_id}             → 200 StressRun / 404
//   GET    /api/v1/stress-runs/{run_id}/metrics     → 200 StressRunMetrics / 404
//   POST   /api/v1/stress-runs/{run_id}/cancel      → 202 StressRun / 409
//
// ⚠️ 后端已落地（app/api/v1/stress_runs.py + app/services/stress/**），
//    默认**走真接口**。mockData.ts 只在两种情况下用：
//      · 前端离线预览 / 后端没启动（localStorage 置 '1'）；
//      · 组件测试（vi.mock('./service') 或直接测 mockData）。
//
//    切换：localStorage.setItem('agent-stress:mock', '1') 后刷新即回到内存推演，
//    删掉这条记录即回到真接口。
//
// 分页是 **cursor**（不是 page/page_size）：契约只给 `next_cursor`，翻页只能
// 从前一页拿到的游标往后走。列表页因此禁用页码跳转，只留上一页 / 下一页。
import { request } from '@umijs/max';
import type {
  StressRun,
  StressRunCreate,
  StressRunListParams,
  StressRunListResponse,
  StressRunMetrics,
} from './data';
import * as mock from './mockData';

const API_BASE = '/api/v1';

const DEFAULT_USE_MOCK = false;

function resolveUseMock(): boolean {
  try {
    const flag = window.localStorage.getItem('agent-stress:mock');
    if (flag === '0') return false;
    if (flag === '1') return true;
  } catch {
    // 隐私模式 / SSR：读不到 localStorage 就用默认值
  }
  return DEFAULT_USE_MOCK;
}

/** 当前是否走本地模拟（页面头部会把这件事显式告诉用户，不装成真数据） */
export const USE_MOCK_STRESS = resolveUseMock();

/** 从 umi request 的异常里取 HTTP 状态码；取不到返回 undefined。 */
export function stressErrorStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * FastAPI 的 `detail` 有两种形状：
 *   · 业务错误：`"跑测已结束"`（字符串）
 *   · 422 校验错误：`[{loc:['body','target'], msg:'Value error, ...'}]`（数组）
 *
 * 全局 errorHandler 只认字符串，数组会退化成 "Response status:422" ——
 * 表单填错时那种提示等于没说，所以在这里把 loc 和 msg 拼出来。
 */
function extractDetail(data: unknown): string | undefined {
  const detail = (data as { detail?: unknown } | undefined)?.detail;

  if (typeof detail === 'string' && detail.trim()) return detail;

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        const entry = item as { loc?: unknown; msg?: unknown };
        const loc = Array.isArray(entry.loc)
          ? entry.loc.filter((part) => part !== 'body').join('.')
          : '';
        const msg = String(entry.msg ?? '').replace(/^Value error,\s*/, '');
        return msg ? (loc ? `${loc}: ${msg}` : msg) : '';
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join('；');
  }

  return undefined;
}

/** 把异常压成一句能直接丢给 message.error 的话。 */
export function stressErrorMessage(error: unknown): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  const detail = extractDetail(data);
  if (detail) return detail;

  const msg = (error as { message?: string })?.message;
  return msg?.trim() ? msg : '请求失败';
}

// 这组请求统一 `skipErrorHandler: true`，理由：
//   · 全局 handler 只认字符串 detail，422 的数组 detail 会退化成状态码；
//   · 400（坏游标）/ 404（不存在）/ 409（已终态）都需要**页面做状态动作**
//     （重置分页 / 显示 404 页 / 提示"已结束"），不是弹一条就完事；
//   · 不接管的话，全局弹一次、页面 catch 再弹一次 —— 每个错误提示两遍。
// 于是：错误提示的责任收在本页，`stressErrorMessage` / `stressErrorStatus`
// 就是给页面用的两个入口。

export async function createStressRun(
  body: StressRunCreate,
): Promise<StressRun> {
  if (USE_MOCK_STRESS) return mock.createStressRun(body);
  return request<StressRun>(`${API_BASE}/stress-runs`, {
    method: 'POST',
    data: body,
    skipErrorHandler: true,
  });
}

export async function listStressRuns(
  params: StressRunListParams = {},
): Promise<StressRunListResponse> {
  if (USE_MOCK_STRESS) return mock.listStressRuns(params);
  return request<StressRunListResponse>(`${API_BASE}/stress-runs`, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}

export async function getStressRun(runId: string): Promise<StressRun> {
  if (USE_MOCK_STRESS) return mock.getStressRun(runId);
  return request<StressRun>(`${API_BASE}/stress-runs/${runId}`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

export async function getStressRunMetrics(
  runId: string,
): Promise<StressRunMetrics> {
  if (USE_MOCK_STRESS) return mock.getStressRunMetrics(runId);
  return request<StressRunMetrics>(`${API_BASE}/stress-runs/${runId}/metrics`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

export async function cancelStressRun(runId: string): Promise<StressRun> {
  if (USE_MOCK_STRESS) return mock.cancelStressRun(runId);
  return request<StressRun>(`${API_BASE}/stress-runs/${runId}/cancel`, {
    method: 'POST',
    skipErrorHandler: true,
  });
}
