// src/pages/task/utils.ts
// 纯函数层：格式化与判定。不碰 DOM、不碰 React，可以直接在 node 里跑断言。
//
// 为什么单独一层：这一层是"读契约"最容易出错的地方（哪个字段能为 null、
// 哪个组合代表异常状态），做成纯函数才测得动。
import dayjs from 'dayjs';

import { isTerminalStatus, type TaskStatus, type TaskSummary } from './data';

/** 契约里的时间都是 ISO 8601 字符串；null 表示"还没发生"。 */
export type TimeValue = string | null | undefined;

/**
 * 把契约里的 datetime 字符串格式化成人看的时刻。
 *
 * ⚠️ 无效值一律回落 `'—'`，**绝不回落到 0 / 1970** —— 那会让"没有这个时间"
 *    看起来像"发生在一九七零年"，比什么都不显示更糟。
 */
export function formatTime(value: TimeValue): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm:ss') : '—';
}

/**
 * 相对时间（"3 分钟前"）。
 *
 * ⚠️ 自己算，不用 dayjs 的 `fromNow()`
 * -----------------------------------
 *   那个方法要 `dayjs.extend(relativeTime)`，而本项目只在 **umi 的运行时插件**
 *   （`.umi/plugin-moment2dayjs/runtime.tsx`）里注册过它 —— 单测里没有那一层，
 *   调用会直接 `TypeError: fromNow is not a function`；而且它的文案跟 dayjs 的
 *   locale 走，本项目没设 `dayjs.locale('zh-cn')`，渲染出来是 "3 minutes ago"。
 *   十行纯函数同时解决这两件事，还顺手可测。
 *
 * 未来时刻（execute_at 在未来）说成 "x 分钟后"，不说 "x 分钟前"。
 */
export function fromNow(value: TimeValue, now: number = Date.now()): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  if (!parsed.isValid()) return '—';

  const diff = now - parsed.valueOf();
  const ahead = diff < 0;
  const abs = Math.abs(diff);

  const unit = (n: number, name: string) =>
    ahead ? `${n} ${name}后` : `${n} ${name}前`;

  if (abs < 60_000) return '刚刚';

  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return unit(minutes, '分钟');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, '小时');

  const days = Math.floor(hours / 24);
  return unit(days, '天');
}

/** UUID 短码：列表里一行 36 个字符太占地方。 */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** 本轮的执行次数展示，如 `1 / 3`。手动 retry 后 attempt 会回到 0。 */
export function attemptText(
  task: Pick<TaskSummary, 'attempt' | 'max_attempts'>,
) {
  return `${task.attempt} / ${task.max_attempts}`;
}

/** 已经跑了多久（有 started_at 才有意义）。 */
export function elapsedText(
  startedAt: TimeValue,
  finishedAt: TimeValue,
): string {
  if (!startedAt) return '—';
  const start = dayjs(startedAt);
  if (!start.isValid()) return '—';

  const end = finishedAt ? dayjs(finishedAt) : dayjs();
  if (!end.isValid()) return '—';

  const ms = end.diff(start);
  if (ms < 0) return '—';
  if (ms < 1000) return '< 1 秒';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;

  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${restSeconds} 秒`;

  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * 租约状态。对应后端 get_task 的 docstring：
 * `status == running` 而 `lease_expires_at` 已过期 = **执行它的 Worker 崩了**，
 * 任务正等着被 sweeper 收回重跑。
 *
 * 返回 'expired' 时 UI 要显式提示 —— 这是"卡住了"的唯一可见信号，
 * 光看状态列只会看到"执行中"，看着一切正常。
 *
 * ⚠️ 入参是**结构类型**，不是 `Pick<TaskSummary, ...>`
 * ---------------------------------------------------
 *   `lease_expires_at` / `leased_by` **只存在于 TaskDetail**，列表的 TaskSummary
 *   里没有（task.yaml 与 schemas/task.py 都只把租约放在详情）。所以这里不能写成
 *   `Pick<TaskSummary, 'lease_expires_at'>` —— 那是个不存在的键，`tsc` 会直接报
 *   「Type '"lease_expires_at"' does not satisfy the constraint 'keyof TaskSummary'」。
 *
 *   连带的一条纪律：**列表页不许判"卡住了"** —— 它手上根本没有租约字段，
 *   想显示"执行者失联"只能靠详情。别为了在列表上画个警示图标就去猜。
 */
export type LeaseHealth = 'active' | 'expired' | 'none';

/** 判定租约所需的**最小**字段集（TaskDetail 满足它，TaskSummary 不满足）。 */
export interface LeaseView {
  status: TaskStatus;
  lease_expires_at: TimeValue;
}

export function leaseHealth(task: LeaseView): LeaseHealth {
  if (!task.lease_expires_at) return 'none';
  const expiry = dayjs(task.lease_expires_at);
  if (!expiry.isValid()) return 'none';
  if (task.status !== 'running') return 'none';
  return expiry.isBefore(dayjs()) ? 'expired' : 'active';
}

/** 推"为什么停着"所需的字段集（同样只有 TaskDetail 齐全）。 */
export interface DelayView extends LeaseView {
  execute_at: TimeValue;
}

/**
 * "它为什么还没跑 / 卡在哪"的一句话解释。
 *
 * 三种情形直接照抄后端 get_task 的 docstring（那里是权威口径）：
 *   pending 且 execute_at 未到  -> 延迟任务，正常
 *   running 且租约已过期        -> 执行者崩了，等着被收回（异常）
 *   retryable                   -> 上次失败，等下一次调度
 *
 * 读不出特殊情形时返回 null（调用方不显示这一行，而不是编一句话）。
 */
export function delayHint(task: DelayView): string | null {
  if (task.status === 'pending' && task.execute_at) {
    const at = dayjs(task.execute_at);
    if (at.isValid() && at.isAfter(dayjs())) {
      return `延迟任务：等 ${at.format('YYYY-MM-DD HH:mm:ss')} 到点才会被认领。`;
    }
  }

  if (leaseHealth(task) === 'expired') {
    return '执行它的 Worker 已失联（租约过期），任务正等着被收回重跑。';
  }

  if (task.status === 'retryable') {
    return '上一次执行失败，仍在重试上限之内，等下一次调度。';
  }

  return null;
}

/**
 * 取消结果的解读。**这三者必须分开说**（契约里 cancel 刻意回真实状态）：
 *
 *   cancelled        -> 真的拦下了
 *   running          -> 正在收尾（协作式取消不强杀 Handler），不是失败
 *   success / failed -> 取消来晚了（后端刻意不报 409，那本身就是竞态）
 */
export interface CancelOutcome {
  /** 提示的语义级别，直接喂给 message.success / info / warning。 */
  level: 'success' | 'info' | 'warning';
  text: string;
}

export function describeCancelResult(status: TaskStatus): CancelOutcome {
  if (status === 'cancelled') {
    return { level: 'success', text: '已取消，它不会再被认领。' };
  }
  if (status === 'running') {
    return {
      level: 'info',
      text: '已发出取消；Handler 正在收尾，状态稍后会变成已取消。',
    };
  }
  if (isTerminalStatus(status)) {
    return {
      level: 'warning',
      text: '取消来晚了：任务在这之前已经结束。',
    };
  }
  // pending / retryable 理论上不该出现在取消结果里（都会被改成 cancelled），
  // 真出现就如实说清楚，不硬套上面三种说法。
  return {
    level: 'info',
    text: `取消请求已受理，任务当前状态是 ${status}。`,
  };
}

/** 重试按钮是否可用：只有 failed / cancelled 能人工重跑（其余会 409）。 */
export function canRetry(status: TaskStatus): boolean {
  return status === 'failed' || status === 'cancelled';
}

/**
 * 「立即执行」是否可用 —— 对应 POST /tasks/{id}/invoke。
 *
 * 后端只在**还没开始跑**的时候接受（`pending` / `retryable`）：
 *   · `running`  会 409，因为执行者马上就写回结果了；
 *   · 终态       会 409，再触发就是第二次外部副作用（失败/取消请用 retry）。
 *
 * 另外 `execute_at` 为空时**不画这颗按钮**：那说明它本来就已经到点、
 * 随时会被认领，"立即执行"是个空动作 —— 点了除了多一次投递什么也不改变。
 *
 * ⚠️ 故意**不**要求 `execute_at` 在未来：它已经过了点却还停在 pending/retryable，
 *    正说明这次投递丢了（进程重启、定时器没醒），这时"补推一次"才是对的用法。
 */
export function canInvoke(status: TaskStatus, executeAt: TimeValue): boolean {
  if (status !== 'pending' && status !== 'retryable') return false;
  if (!executeAt) return false;
  return dayjs(executeAt).isValid();
}

/**
 * 「立即执行」确认框里那句话。
 *
 * 说清楚三件事，因为这三件都是用户会误解的：
 *   ① 现在是什么时候执行、提前了多久；
 *   ② `execute_at` 会被清空、立刻投递（不是"排队到最前面"）；
 *   ③ **仍是同一轮**，attempt 不变（这跟 retry 的"开新一轮"完全不同）。
 */
export function invokeConfirmText(
  executeAt: TimeValue,
  now: number = Date.now(),
): string {
  const at = dayjs(executeAt);
  if (!at.isValid()) {
    return 'execute_at 会清空并立刻投递一次。仍是同一轮执行，attempt 不变。';
  }
  const stamp = at.format('YYYY-MM-DD HH:mm:ss');
  const ahead = at.valueOf() > now;

  return ahead
    ? `不等 ${stamp} 了（${fromNow(executeAt, now)}）：execute_at 会清空并立刻投递。仍是同一轮执行，attempt 不变。`
    : `已过 ${stamp} 仍未开跑，补推一次投递。仍是同一轮执行，attempt 不变。`;
}

/** 取消按钮是否可用：已经终态就没什么可取消的（点了也是"来晚了"）。 */
export function canCancel(status: TaskStatus): boolean {
  return !isTerminalStatus(status);
}

/** 把 params 序列化成可读 JSON；后端保证它是个对象，所以不必处理 undefined。 */
export function stringifyParams(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(params, null, 2);
  } catch {
    // 理论上到不了（JSON 世界里不存在循环引用），但它要是抛了，页面别白屏
    return String(params);
  }
}

/** params 是否为空对象（空的时候不画那块，省得一片 "{}"）。 */
export function isEmptyParams(params: Record<string, unknown>): boolean {
  return Object.keys(params).length === 0;
}
