// src/pages/task/utils.test.ts
// 纯函数层的边界。
//
// 为什么这一层值得单独测：契约里"哪个字段能为 null、哪个组合代表异常状态"
// 全在这一层被解释，而它解释错了**不会报错** —— 只会显示一个看着合理的错值
// （比如把"没这个时间"显示成 1970 年、把"正在收尾"说成"取消成功"）。
import { describe, expect, it } from 'vitest';

import { isTerminalStatus, type TaskStatus } from './data';
import {
  attemptText,
  canCancel,
  canInvoke,
  canRetry,
  delayHint,
  describeCancelResult,
  elapsedText,
  formatTime,
  fromNow,
  invokeConfirmText,
  isEmptyParams,
  leaseHealth,
  shortId,
  stringifyParams,
} from './utils';

describe('formatTime', () => {
  it('null / undefined / 空串 都回落成破折号，绝不回落成 1970', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatTime(undefined)).toBe('—');
    expect(formatTime('')).toBe('—');
  });

  it('坏字符串也回落，不抛', () => {
    expect(formatTime('not-a-date')).toBe('—');
  });

  it('正常 ISO 字符串格式化到秒', () => {
    expect(formatTime('2026-10-06T13:45:12Z')).toMatch(
      /^2026-10-06 \d{2}:\d{2}:12$/,
    );
  });
});

describe('fromNow', () => {
  // 固定"现在"，让断言与机器时钟无关
  const NOW = Date.parse('2026-10-06T12:00:00Z');

  it('一分钟内说"刚刚"', () => {
    expect(fromNow('2026-10-06T11:59:30Z', NOW)).toBe('刚刚');
  });

  it('分钟 / 小时 / 天三档，且带"前"', () => {
    expect(fromNow('2026-10-06T11:55:00Z', NOW)).toBe('5 分钟前');
    expect(fromNow('2026-10-06T09:00:00Z', NOW)).toBe('3 小时前');
    expect(fromNow('2026-10-03T12:00:00Z', NOW)).toBe('3 天前');
  });

  it('未来时刻说"后"而不是"前"（execute_at 在未来是常态）', () => {
    expect(fromNow('2026-10-06T12:30:00Z', NOW)).toBe('30 分钟后');
    expect(fromNow('2026-10-06T15:00:00Z', NOW)).toBe('3 小时后');
  });

  it('无效值回落', () => {
    expect(fromNow(null, NOW)).toBe('—');
    expect(fromNow('nope', NOW)).toBe('—');
  });
});

describe('shortId', () => {
  it('长 uuid 截断，短的原样，空的破折号', () => {
    expect(shortId('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe('0199a1b2…');
    expect(shortId('abc')).toBe('abc');
    expect(shortId(null)).toBe('—');
  });
});

describe('attemptText', () => {
  it('本轮次数按 attempt / max_attempts 展示', () => {
    expect(attemptText({ attempt: 0, max_attempts: 3 })).toBe('0 / 3');
    expect(attemptText({ attempt: 2, max_attempts: 3 })).toBe('2 / 3');
  });
});

describe('elapsedText', () => {
  it('没开始过就是破折号', () => {
    expect(elapsedText(null, null)).toBe('—');
  });

  it('秒 / 分 两档', () => {
    expect(
      elapsedText('2026-10-06T12:00:00Z', '2026-10-06T12:00:00.400Z'),
    ).toBe('< 1 秒');
    expect(elapsedText('2026-10-06T12:00:00Z', '2026-10-06T12:00:42Z')).toBe(
      '42 秒',
    );
    expect(elapsedText('2026-10-06T12:00:00Z', '2026-10-06T12:03:07Z')).toBe(
      '3 分 7 秒',
    );
  });

  it('结束早于开始（数据脏）时回落，不显示负数', () => {
    expect(elapsedText('2026-10-06T12:05:00Z', '2026-10-06T12:00:00Z')).toBe(
      '—',
    );
  });
});

describe('leaseHealth（租约）', () => {
  const past = '2020-01-01T00:00:00Z';
  const future = '2099-01-01T00:00:00Z';

  it('没有租约 -> none', () => {
    expect(leaseHealth({ status: 'running', lease_expires_at: null })).toBe(
      'none',
    );
  });

  it('不是 running 就谈不上租约（终态会把租约清掉）', () => {
    expect(leaseHealth({ status: 'success', lease_expires_at: past })).toBe(
      'none',
    );
  });

  it('running 且租约已过期 -> expired（执行者崩了，这是唯一可见信号）', () => {
    expect(leaseHealth({ status: 'running', lease_expires_at: past })).toBe(
      'expired',
    );
  });

  it('running 且租约未到期 -> active', () => {
    expect(leaseHealth({ status: 'running', lease_expires_at: future })).toBe(
      'active',
    );
  });
});

describe('delayHint（它现在为什么停着）', () => {
  it('pending 且 execute_at 在未来 -> 说明是延迟任务（正常，不是卡住）', () => {
    const hint = delayHint({
      status: 'pending',
      execute_at: '2099-01-01T00:00:00Z',
      lease_expires_at: null,
    });
    expect(hint).toContain('延迟任务');
  });

  it('pending 但 execute_at 已过 -> 不说"延迟"（那会掩盖真正的卡住）', () => {
    expect(
      delayHint({
        status: 'pending',
        execute_at: '2020-01-01T00:00:00Z',
        lease_expires_at: null,
      }),
    ).toBeNull();
  });

  it('pending 且没有 execute_at（立即执行）-> 无提示', () => {
    expect(
      delayHint({
        status: 'pending',
        execute_at: null,
        lease_expires_at: null,
      }),
    ).toBeNull();
  });

  it('running 且租约过期 -> 执行者失联', () => {
    expect(
      delayHint({
        status: 'running',
        execute_at: null,
        lease_expires_at: '2020-01-01T00:00:00Z',
      }),
    ).toContain('租约过期');
  });

  it('retryable -> 等下一次调度', () => {
    expect(
      delayHint({
        status: 'retryable',
        execute_at: null,
        lease_expires_at: null,
      }),
    ).toContain('重试上限');
  });

  it('一切正常（success / running 无异常）-> null，不编一句话', () => {
    expect(
      delayHint({
        status: 'success',
        execute_at: null,
        lease_expires_at: null,
      }),
    ).toBeNull();
    expect(
      delayHint({
        status: 'running',
        execute_at: null,
        lease_expires_at: '2099-01-01T00:00:00Z',
      }),
    ).toBeNull();
  });
});

describe('describeCancelResult（取消结果必须分三种说）', () => {
  it('cancelled -> 成功', () => {
    expect(describeCancelResult('cancelled').level).toBe('success');
  });

  it('running -> 只是"正在收尾"，不是失败（协作式取消不强杀 Handler）', () => {
    const outcome = describeCancelResult('running');
    expect(outcome.level).toBe('info');
    expect(outcome.text).toContain('收尾');
  });

  it('已经是终态 -> "来晚了"，不是错误（后端刻意不报 409）', () => {
    expect(describeCancelResult('success').level).toBe('warning');
    expect(describeCancelResult('failed').level).toBe('warning');
    expect(describeCancelResult('success').text).toContain('来晚了');
  });

  it('理论上不该出现的 pending / retryable 也如实说，不硬套三种说法', () => {
    expect(describeCancelResult('pending').text).toContain('pending');
    expect(describeCancelResult('retryable').text).toContain('retryable');
  });
});

describe('按钮可用性（与后端 409 条件对齐）', () => {
  it('只有 failed / cancelled 能重试 —— 其余点了必然 409', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('cancelled')).toBe(true);
    expect(canRetry('success')).toBe(false);
    expect(canRetry('running')).toBe(false);
    expect(canRetry('pending')).toBe(false);
    expect(canRetry('retryable')).toBe(false);
  });

  it('中间态能取消，终态没什么可取消的', () => {
    expect(canCancel('pending')).toBe(true);
    expect(canCancel('running')).toBe(true);
    expect(canCancel('retryable')).toBe(true);
    expect(canCancel('success')).toBe(false);
    expect(canCancel('failed')).toBe(false);
    expect(canCancel('cancelled')).toBe(false);
  });
});

describe('isTerminalStatus', () => {
  it('终态只有 success / failed / cancelled', () => {
    const terminal: TaskStatus[] = ['success', 'failed', 'cancelled'];
    const live: TaskStatus[] = ['pending', 'running', 'retryable'];

    for (const status of terminal) expect(isTerminalStatus(status)).toBe(true);
    for (const status of live) expect(isTerminalStatus(status)).toBe(false);
  });
});

describe('params 展示', () => {
  it('空对象算空', () => {
    expect(isEmptyParams({})).toBe(true);
    expect(isEmptyParams({ run_id: 'x' })).toBe(false);
  });

  it('序列化成缩进 JSON', () => {
    expect(stringifyParams({ run_id: 'r-1' })).toBe('{\n  "run_id": "r-1"\n}');
  });
});

// invoke（POST /tasks/{id}/invoke）—— 只对"还没开跑"的任务有效。
// 这条判定写错的代价很具体：按钮画在 running / 终态上，用户点一次吃一个 409。
describe('canInvoke（立即触发，只对还没开跑的任务）', () => {
  const FUTURE = '2099-01-01T00:00:00Z';

  it('pending / retryable 且有 execute_at → 可提前触发', () => {
    expect(canInvoke('pending', FUTURE)).toBe(true);
    expect(canInvoke('retryable', FUTURE)).toBe(true);
  });

  it('running / 终态 → 不可（后端 409：在跑会写回结果，终态是第二次副作用）', () => {
    expect(canInvoke('running', FUTURE)).toBe(false);
    expect(canInvoke('success', FUTURE)).toBe(false);
    expect(canInvoke('failed', FUTURE)).toBe(false);
    expect(canInvoke('cancelled', FUTURE)).toBe(false);
  });

  it('execute_at 为空说明它本来就要跑了，画这颗按钮是空动作', () => {
    expect(canInvoke('pending', null)).toBe(false);
    expect(canInvoke('retryable', undefined)).toBe(false);
  });

  it('⚠️ 过了点却还停在 pending 的也要能点 —— 这正是"投递丢了"的样子', () => {
    expect(canInvoke('pending', '2020-01-01T00:00:00Z')).toBe(true);
  });

  it('时间串坏了就当没有，不画按钮', () => {
    expect(canInvoke('pending', 'not-a-date')).toBe(false);
  });
});

describe('invokeConfirmText（确认框必须讲清"同一轮、异步"）', () => {
  const now = Date.parse('2026-10-17T14:00:00Z');

  it('未来时刻：说清提前到哪、还剩多久', () => {
    const text = invokeConfirmText('2026-10-17T14:30:00Z', now);
    expect(text).toContain('不等');
    expect(text).toContain('30 分钟后');
  });

  it('已过点：改成"补推一次投递"，不说"提前"', () => {
    const text = invokeConfirmText('2026-10-17T13:00:00Z', now);
    expect(text).toContain('补推');
    expect(text).not.toContain('不等');
  });

  it('两种情形都要提「同一轮执行，attempt 不变」—— 这是它与 retry 的分界', () => {
    for (const iso of ['2026-10-17T14:30:00Z', '2026-10-17T13:00:00Z']) {
      expect(invokeConfirmText(iso, now)).toContain('attempt 不变');
    }
  });
});
