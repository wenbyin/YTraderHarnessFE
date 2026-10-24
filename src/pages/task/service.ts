// src/pages/task/service.ts
// 对接 YTraderHarness 后端 /api/v1/tasks
//
// 契约：app/services/task/task.yaml，实现：app/api/v1/tasks.py
//
// ⚠️ 这里**刻意没有** submitTask / createTask
// ------------------------------------------
//   task.yaml 的 info.description 把「提交任务」写成了明文的 Non-responsibility：
//   后端**故意不提供** POST /tasks。任务由服务端业务代码经 TaskService.submit()
//   创建；一个公开的提交接口等于让任何已认证调用方都能触发任意已注册的 Handler
//   （模型调用、文档入库），而这绕过了业务接口自己的授权与限流。
//
//   所以前端也**不许**"先加个按钮，等后端补接口" —— 那是在 UI 上发明一条后端
//   明确拒绝的通路。本页面只做四件事：看（列表 / 详情）、追（执行链）、
//   干预（取消 / 重试）、提前触发（invoke，见下）。
//
// 错误处理：不传 skipErrorHandler，交给全局 errorHandler（src/requestErrorConfig.ts）。
//   它已经会把 FastAPI 的 `detail` 取出来弹出来 —— 而 409 的中文原因（"任务当前是
//   success，不能重试……"）正是这里最需要给用户看的东西。组件层再 catch 一遍会
//   变成两条 toast，所以调用方的 catch 只做「刷新列表」这类收尾，不再弹文案。
import { request } from '@umijs/max';

import type {
  ListTasksParams,
  TaskCancelResponse,
  TaskDetail,
  TaskLineage,
  TaskPage,
} from './data';

const API_BASE = '/api/v1/tasks';

/**
 * 分页查询任务列表，最近创建的在前。
 * GET /api/v1/tasks
 *
 * 排序由后端固定为 created_at 倒序，前端不传排序字段。
 * 响应**不含 params 与 error 正文**（见 data.ts 的 TaskSummary），要看请调 getTask。
 */
export async function listTasks(params: ListTasksParams) {
  return request<TaskPage>(API_BASE, {
    method: 'GET',
    params,
  });
}

/**
 * 取单条任务的完整视图：params、失败原因、租约。
 * GET /api/v1/tasks/{task_id}
 */
export async function getTask(taskId: string) {
  return request<TaskDetail>(`${API_BASE}/${taskId}`, {
    method: 'GET',
  });
}

/**
 * 取这条任务所属的**整条执行链**，老的在前。
 * GET /api/v1/tasks/{task_id}/lineage
 *
 * 传链上任意一条都可以，不必自己找根 —— 根由后端反推。
 * 什么都没找到时返回空的 `tasks` 数组，不是 404。
 */
export async function getTaskLineage(taskId: string) {
  return request<TaskLineage>(`${API_BASE}/${taskId}/lineage`, {
    method: 'GET',
  });
}

/**
 * 取消任务。**既没有请求体，也没有响应体之外的东西** —— 但响应**有内容**：
 * 它回的是取消之后任务真实所处的状态（见 TaskCancelResponse）。
 * POST /api/v1/tasks/{task_id}/cancel
 *
 * 两条别踩的：
 *   · 它是**协作式**的 —— 已经跑起来的 Handler 不会被强杀，所以返回 `running`
 *     表示"正在收尾"，要如实告诉用户，不能报"取消失败"。
 *   · **已结束的任务取消"来晚了"不是错误**（后端刻意不报 409，那是竞态）。
 *     它照旧 200，把终态回给你。前端据此说"取消来晚了"。
 *   · 幂等：调两次无害。
 */
export async function cancelTask(taskId: string) {
  return request<TaskCancelResponse>(`${API_BASE}/${taskId}/cancel`, {
    method: 'POST',
  });
}

/**
 * 人工重跑一条**已失败或已取消**的任务（下一轮：attempt 清零、立即执行，
 * 上一条 error 保留）。
 * POST /api/v1/tasks/{task_id}/retry
 *
 * 两种情况后端回 **409**（detail 里是中文原因，由全局 errorHandler 弹出）：
 *   · 还在排队 / 正在跑  —— 重跑会与执行中的那次冲突；
 *   · 已经成功           —— 重跑会产生第二次外部副作用（真通知两次、真扣两次款）。
 *     那该提交一条新任务；但前端没有这个能力，所以遇到它只如实报错，不诱导用户。
 */
export async function retryTask(taskId: string) {
  return request<TaskDetail>(`${API_BASE}/${taskId}/retry`, {
    method: 'POST',
  });
}

/**
 * 让一条**还没开始跑**的定时任务立即执行（把 `execute_at` 提前到现在）。
 * POST /api/v1/tasks/{task_id}/invoke
 *
 * 这是「控制台里手动触发」那颗按钮的落点，**不是**"提交任务"：
 *   · 任务已经由业务代码提交过（`execute_at` 在未来），这里只是不等定时了；
 *   · 不新建任务、**也不动 attempt** —— 它仍是同一轮执行。
 *
 * 返回的是触发之后的任务（`execute_at` 已为 null）。执行依然是**异步**的，
 * 所以调用方拿到 200 只代表"已投递"，真正跑完要再 GET 一次这条任务。
 *
 * 两种情况后端回 **409**（detail 是中文原因，由全局 errorHandler 弹出）：
 *   · 正在跑   —— 执行者马上就写回结果了；
 *   · 已终结   —— 再触发会变成第二次外部副作用（失败/取消的重跑请用 retry）。
 */
export async function invokeTask(taskId: string) {
  return request<TaskDetail>(`${API_BASE}/${taskId}/invoke`, {
    method: 'POST',
  });
}
