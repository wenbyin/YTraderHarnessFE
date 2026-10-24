// src/components/CopilotDock/toolStatusCache.test.ts
//
// 「刷新后工具行的状态要和刚才 SSE 里一样」—— 这份本地存档是那条需求唯一的
// 数据来源（后端没把逐次成败落库，见 toolStatusCache.ts 的文件头）。
//
// 这里钉的是**匹配规则**与**不猜**的边界：
//   · 同一个工具的三种写法要认成同一个；
//   · 一轮里同一个工具调了两次、一成一败时，两行各拿各的（按序消费）；
//   · 没跑完的（running）不许存；存不到就什么都没有，不能抛；
//   · ⭐⭐ **按后端 run_id 分桶** —— 一次 HITL 审批在界面侧是**两次** AG-UI
//     run，却属于**同一个** run_id（见 agent.ts 的文件头）。"一个会话只留一份"
//     那版把后一次整份盖掉前一次，于是刷新之后只有「审批之后调的那几个」有
//     图标、审批之前那一排全秃（用户 2026-10-21 报的正是它）。下面那两条
//     ⭐⭐ 用例就是它的回归网。
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createCachedStatusResolver,
  rememberToolStatuses,
  resetToolStatusCache,
} from './toolStatusCache';
import type { ToolActivityItem } from './useToolActivity';

/** 默认落在 r-1 这一次运行里 —— 大部分用例只关心名字匹配。 */
const item = (
  name: string,
  status: ToolActivityItem['status'],
  error?: string,
  runId = 'r-1',
): ToolActivityItem => ({
  key: `k-${name}-${status}`,
  name,
  status,
  error,
  runId,
});

/** 查一次就丢（解析器是**按序消费**的，每次都新造一个）。 */
const matched = (sessionId: string, name: string, runId = 'r-1') => {
  const resolve = createCachedStatusResolver(sessionId);
  return resolve?.(runId, name);
};

beforeEach(() => {
  resetToolStatusCache();
});

describe('rememberToolStatuses / createCachedStatusResolver', () => {
  it('跑完的调用按名字查得到', () => {
    rememberToolStatuses('s-1', [item('web.search', 'done')]);

    expect(matched('s-1', 'web.search')).toMatchObject({ status: 'done' });
  });

  it('同一个工具的三种写法都认（点分 / 下划线 / 短名）', () => {
    rememberToolStatuses('s-1', [item('agent.current_time', 'done')]);

    expect(matched('s-1', 'agent_current_time')?.status).toBe('done');
    expect(matched('s-1', 'current_time')?.status).toBe('done');
  });

  it('⚠️ 名字相近但不是一个工具 -> 查不到（不能张冠李戴）', () => {
    rememberToolStatuses('s-1', [item('web.search', 'done')]);

    expect(matched('s-1', 'doc.search')).toBeUndefined();
  });

  it('错误文本一起留着（红叉的悬停提示要用）', () => {
    rememberToolStatuses('s-1', [item('web.search', 'error', 'TimeoutError')]);

    expect(matched('s-1', 'web.search')).toMatchObject({
      status: 'error',
      error: 'TimeoutError',
    });
  });

  it('⚠️ 还在跑的（running）不存 —— 否则刷新后满屏假"已完成"', () => {
    rememberToolStatuses('s-1', [
      item('web.search', 'running'),
      item('doc.read', 'done'),
    ]);

    expect(matched('s-1', 'web.search')).toBeUndefined();
    expect(matched('s-1', 'doc.read')?.status).toBe('done');
  });

  it('全都在跑时什么都不写（连键都不建）', () => {
    rememberToolStatuses('s-1', [item('web.search', 'running')]);

    expect(createCachedStatusResolver('s-1')).toBeNull();
  });

  it('⭐ 同一个工具调了两次（一成一败）：按序各拿各的', () => {
    rememberToolStatuses('s-1', [
      item('web.search', 'done'),
      item('web.search', 'error', '第二次超时', 'r-1'),
    ]);

    const resolve = createCachedStatusResolver('s-1');
    expect(resolve?.('r-1', 'web.search')?.status).toBe('done');
    expect(resolve?.('r-1', 'web.search')).toMatchObject({
      status: 'error',
      error: '第二次超时',
    });
    // 两次都消费完了，第三次问就是"不知道"
    expect(resolve?.('r-1', 'web.search')).toBeUndefined();
  });

  it('没有 session_id / 没有存档 -> null（调用方不必逐条问）', () => {
    expect(createCachedStatusResolver(undefined)).toBeNull();
    expect(createCachedStatusResolver('s-unknown')).toBeNull();
  });

  it('空名字不参与匹配（两条都没名字的记录不能因此配上）', () => {
    rememberToolStatuses('s-1', [item('', 'done')]);

    expect(matched('s-1', '')).toBeUndefined();
  });

  it('⭐ 没有 run_id 的记录不入库（不知道该归到哪次运行）', () => {
    rememberToolStatuses('s-1', [
      { key: 'k1', name: 'web.search', status: 'done' },
    ]);

    expect(createCachedStatusResolver('s-1')).toBeNull();
  });

  it('⭐ 同一个 run 再记一次 -> 覆盖而不是追加（否则每次界面刷新都翻倍）', () => {
    rememberToolStatuses('s-1', [item('web.search', 'done')]);
    rememberToolStatuses('s-1', [item('web.search', 'error', '后来炸了')]);

    const resolve = createCachedStatusResolver('s-1');
    expect(resolve?.('r-1', 'web.search')?.status).toBe('error');
    // 只有一条 —— 追加的话这里会返回 "done"
    expect(resolve?.('r-1', 'web.search')).toBeUndefined();
  });

  it('⭐ 不同的 run_id 各成一桶：老的那次运行仍然查得到', () => {
    rememberToolStatuses('s-1', [item('web.search', 'done', undefined, 'r-1')]);
    rememberToolStatuses('s-1', [item('web.search', 'error', '炸了', 'r-2')]);

    expect(matched('s-1', 'web.search', 'r-1')?.status).toBe('done');
    expect(matched('s-1', 'web.search', 'r-2')).toMatchObject({
      status: 'error',
      error: '炸了',
    });
  });

  it('⚠️ 查询时 run_id 对不上 -> 查不到（不拿别的运行来凑）', () => {
    rememberToolStatuses('s-1', [item('web.search', 'done', undefined, 'r-1')]);

    expect(matched('s-1', 'web.search', 'r-other')).toBeUndefined();
    expect(matched('s-1', 'web.search', '')).toBeUndefined();
  });

  it('⭐⭐ HITL：审批前后两段属于同一个 run_id -> 两段都查得到', () => {
    // 审批之前（第一次 AG-UI run）
    rememberToolStatuses('s-1', [
      item('web.search', 'done'),
      item('doc.read', 'done'),
    ]);
    // 审批之后（第二次 AG-UI run，后端 run_id 仍然是 r-1）：
    // useToolActivity 不清空，同步过来的是"这一轮到目前为止的全部"。
    rememberToolStatuses('s-1', [
      item('web.search', 'done'),
      item('doc.read', 'done'),
      item('db.write', 'error', '审批后被拒'),
    ]);

    expect(matched('s-1', 'web.search')?.status).toBe('done');
    expect(matched('s-1', 'doc.read')?.status).toBe('done');
    expect(matched('s-1', 'db.write')).toMatchObject({
      status: 'error',
      error: '审批后被拒',
    });
  });

  it('一个会话最多留 3 次运行（超了丢最旧的那次）', () => {
    for (const runId of ['r-1', 'r-2', 'r-3', 'r-4']) {
      rememberToolStatuses('s-1', [
        item('web.search', 'done', undefined, runId),
      ]);
    }

    const resolve = createCachedStatusResolver('s-1');
    expect(resolve?.('r-1', 'web.search')).toBeUndefined();
    expect(resolve?.('r-4', 'web.search')?.status).toBe('done');
  });

  it('会话之间互不串味', () => {
    rememberToolStatuses('s-1', [item('web.search', 'done')]);
    rememberToolStatuses('s-2', [item('web.search', 'error', 'B 会话失败')]);

    expect(matched('s-1', 'web.search')?.status).toBe('done');
    expect(matched('s-2', 'web.search')?.status).toBe('error');
  });
});

describe('存储不可用 / 数据损坏时不抛', () => {
  it('localStorage 存取抛异常 -> 静默降级成"没有存档"', () => {
    // ⚠️ 不 spy `Storage.prototype.getItem`：jsdom 的 localStorage 是个
    //    Proxy（命名属性），原型上的方法拦不住，用例会"假绿"。
    //    直接把 window.localStorage 换成一个只会抛的桩，走的是真实代码路径。
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('SecurityError');
        },
        setItem() {
          throw new Error('QuotaExceededError');
        },
        removeItem() {
          throw new Error('SecurityError');
        },
      },
    });

    try {
      expect(() =>
        rememberToolStatuses('s-1', [item('web.search', 'done')]),
      ).not.toThrow();
      expect(createCachedStatusResolver('s-1')).toBeNull();
      expect(() => resetToolStatusCache()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('坏 JSON / 数组态 -> 当成"没有存档"', () => {
    localStorage.setItem('ytrader.dock.tool-status', '{ 这不是 JSON');
    expect(createCachedStatusResolver('s-1')).toBeNull();

    localStorage.setItem('ytrader.dock.tool-status', '[]');
    expect(createCachedStatusResolver('s-1')).toBeNull();
  });

  it('⭐ 旧格式（一个会话一**份列表**）不再被认成存档', () => {
    // 升级前的形状：`{ 's-1': [{ name, status }] }` —— 桶里没有 runId。
    localStorage.setItem(
      'ytrader.dock.tool-status',
      JSON.stringify({ 's-1': [{ name: 'web.search', status: 'done' }] }),
    );

    expect(createCachedStatusResolver('s-1')).toBeNull();
  });
});
