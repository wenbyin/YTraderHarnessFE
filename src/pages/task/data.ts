// src/pages/task/data.ts
// 类型与元数据严格对齐 YTraderHarness 后端：
//   · 契约    app/services/task/task.yaml
//   · 序列化  app/services/task/domain/schemas/task.py
//   · 枚举    app/common/task/types.py 的 TaskStatus
//
// ⚠️ 字段名与类型**逐字照抄**契约：snake_case 原样、date-time 就是 string。
//    不在这里转 camelCase，也不把时间转成毫秒数 —— 一旦转了，每个消费点都要
//    各自写一遍「万一解析失败怎么办」，而正确答案只有一个（见 formatTime 的兜底）。

/**
 * 一条任务的生命周期。对应后端 TaskStatus（6 个取值，顺序也是它的状态机顺序）。
 *
 * ⚠️ `retryable` 与 `pending` 是两件事，后端刻意分开：前者是"这次失败了、
 *    还在等下一次调度"，后者是"从没跑过"。前端也不许把它们合成一个展示，
 *    否则「谁还在重试」这件运维第一要看的事就没了。
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'retryable'
  | 'success'
  | 'failed'
  | 'cancelled';

/**
 * 状态 -> 展示元数据。
 *
 * `color` 用 antd Tag 的 preset 色（success / processing / warning / error / default）。
 * 6 个状态里 pending 与 cancelled 都用 `default`（灰）：它们语义上都是"中性、未在做工"，
 * 而**文字标签不同**（等待中 / 已取消）已经足以区分 —— 不为了凑六种颜色把语义搞乱。
 */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; color: string }
> = {
  pending: { label: '等待中', color: 'default' },
  running: { label: '执行中', color: 'processing' },
  retryable: { label: '待重试', color: 'warning' },
  success: { label: '成功', color: 'success' },
  failed: { label: '失败', color: 'error' },
  cancelled: { label: '已取消', color: 'default' },
};

/** 状态筛选下拉的取值顺序（按状态机顺序，不是字母序）。 */
export const TASK_STATUS_OPTIONS: TaskStatus[] = [
  'pending',
  'running',
  'retryable',
  'success',
  'failed',
  'cancelled',
];

/** 终态：不会再变、也不会再被 claim。对应后端 `TaskStatus.is_terminal`。 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'success',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 列表里的一行。对应后端 TaskSummary。
 *
 * ⚠️ **没有 `params`、也没有 `error` 正文** —— 这是契约刻意的划分（列表一页可能
 *    几百条，渲染列表用不到它们），不是后端漏了。要那两项请取单条（TaskDetail）。
 *    所以列表页**不许**去渲染它们，也不许"先拿列表凑一个详情"。
 */
export interface TaskSummary {
  task_id: string;
  /** 逻辑 Handler Name，如 run.execute / hitl.timeout / memory.extract。 */
  handler: string;
  status: TaskStatus;
  /** **本轮**已执行次数；手动 retry 会把它清零。 */
  attempt: number;
  max_attempts: number;
  /** 可执行时刻；null 表示立即执行。 */
  execute_at: string | null;
  parent_task_id: string | null;
  root_task_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * 单条任务的完整视图。对应后端 TaskDetail（TaskSummary 的超集）。
 *
 * `params` 在契约里是**必填**（`dict[str, Any]`，pydantic 没有默认值），
 * 所以类型是 `Record` 而不是可选；它可以是空对象，但不会缺席。
 */
export interface TaskDetail extends TaskSummary {
  /** 提交时写进去的业务参数。按约定只有业务 ID 与最小参数。 */
  params: Record<string, unknown>;
  /** 触发源：通常是父任务 ID，也可能是业务事件 ID。 */
  causation_id: string | null;
  /** 最近一次失败的原因。**重试成功后仍然保留**（它回答"为什么重试过"）。 */
  error: string | null;
  /** 当前执行的租约到期时刻；running 且已过期 = 执行者崩了，等着被收回。 */
  lease_expires_at: string | null;
  leased_by: string | null;
}

/** 一条后台执行链。对应后端 TaskLineage。 */
export interface TaskLineage {
  root_task_id: string;
  /** 链上全部任务，**按产生顺序（老的在前）** —— 不要再排序。 */
  tasks: TaskSummary[];
}

/** 分页结果。对应后端 TaskPage。 */
export interface TaskPage {
  items: TaskSummary[];
  /** 满足筛选条件的**总数**，不只是本页条数。 */
  total: number;
}

/**
 * 取消的结果。对应后端 TaskCancelResponse。
 *
 * ⚠️ `status` 是取消**之后**它真实所处的位置，不是一个无脑的成功：
 *    · `cancelled`  已拦下；
 *    · `running`    **正在收尾**（协作式取消不强杀 Handler），不是"没取消成功"；
 *    · 终态         取消来晚了。
 *    UI 必须把这三者分开说，否则用户会以为"点了没反应"。
 */
export interface TaskCancelResponse {
  task_id: string;
  status: TaskStatus;
}

/** GET /tasks 的 query 参数。对应 task.yaml 的 parameters。 */
export interface ListTasksParams {
  status?: TaskStatus;
  /** 精确匹配，不是模糊搜索。 */
  handler?: string;
  /** 取整条执行链上的任务。 */
  root_task_id?: string;
  /** 取某个任务的直接子任务。 */
  parent_task_id?: string;
  limit?: number;
  offset?: number;
}
