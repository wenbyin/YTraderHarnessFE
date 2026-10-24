// src/pages/retrieval_eval/runRegistry.test.ts
//
// 跑测列表的数据源测试。
//
// 为什么这里值得测 —— 它踩的是「前端自己存 id」这条路特有的坑：
//
//   1. 坏数据（手改过 / 别的版本写进去的 JSON）必须当作"没有记录"，
//      不能让一个辅助功能把整页搞崩；
//   2. 单个 id 拉不到（run 被删了）要**顺手清掉**，否则每次进列表都白跑
//      一个必败的请求，且永远不会自愈；
//   3. **全失败不能返回空数组**。空数组会被读成"你还没跑过测"，
//      而真相是"后端不可达"—— 这两件事的处置完全相反（去发起 vs 去查后端）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// request 必须在 mock 工厂之外先建好；各用例用**动态 import** 拿模块，
// 保证工厂被调用时 request 已经初始化（静态 import 会踩 TDZ）。
const request = vi.fn();
vi.mock('@umijs/max', () => ({
  request: (...args: unknown[]) => request(...args),
}));

/** 与 runRegistry.ts 里的键保持一致 —— 改键会让老用户的历史一次性消失，值得钉住。 */
const STORAGE_KEY = 'ytrader.retrieval_eval.run_ids';

const makeRun = (id: string, createdAt: string) => ({
  eval_run_id: id,
  bundle_id: 'bundle-1',
  status: 'completed',
  max_k: 10,
  include_stage_trace: true,
  query_processor_override: {},
  effective_config_snapshot: {},
  total_cases: 3,
  completed_cases: 3,
  failed_cases: 0,
  metrics: {
    total_cases: 3,
    completed_cases: 3,
    failed_cases: 0,
    hit_count: 2,
    miss_count: 1,
    hit_rate_at_1: 0.33,
    hit_rate_at_5: 0.67,
    hit_rate_at_k: 0.67,
    mrr_at_k: 0.5,
    p50_latency_ms: 120,
    p95_latency_ms: 300,
    max_k: 10,
  },
  created_at: createdAt,
});

beforeEach(() => {
  window.localStorage.clear();
  request.mockReset();
});

describe('runRegistry', () => {
  it('记住的 id 新的在前，重复记住只挪位置不产生副本', async () => {
    const { getRememberedEvalRunIds, rememberEvalRun } = await import(
      './runRegistry'
    );

    rememberEvalRun('a');
    rememberEvalRun('b');
    expect(getRememberedEvalRunIds()).toEqual(['b', 'a']);

    // 再记一次已经存在的 a：应该挪到最前，且总数不变
    rememberEvalRun('a');
    expect(getRememberedEvalRunIds()).toEqual(['a', 'b']);
  });

  it('空 id 不记（避免出现一个永远拉不到的占位）', async () => {
    const { getRememberedEvalRunIds, rememberEvalRun } = await import(
      './runRegistry'
    );

    rememberEvalRun('');
    expect(getRememberedEvalRunIds()).toEqual([]);
  });

  it('最多保留 100 条，超出丢最旧的', async () => {
    const { getRememberedEvalRunIds, rememberEvalRun } = await import(
      './runRegistry'
    );

    for (let i = 0; i < 105; i += 1) rememberEvalRun(`run-${i}`);

    const ids = getRememberedEvalRunIds();
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe('run-104');
    expect(ids).not.toContain('run-0');
  });

  it('forget 之后不再返回', async () => {
    const { forgetEvalRun, getRememberedEvalRunIds, rememberEvalRun } =
      await import('./runRegistry');

    rememberEvalRun('a');
    rememberEvalRun('b');
    forgetEvalRun('a');

    expect(getRememberedEvalRunIds()).toEqual(['b']);
  });

  it('storage 里是坏 JSON 时当作「没有记录」，不抛', async () => {
    const { getRememberedEvalRunIds, rememberEvalRun } = await import(
      './runRegistry'
    );

    window.localStorage.setItem(STORAGE_KEY, '{ not json');
    expect(getRememberedEvalRunIds()).toEqual([]);

    // 坏数据不能把写入也带崩
    rememberEvalRun('a');
    expect(getRememberedEvalRunIds()).toEqual(['a']);

    // 非数组（比如手动塞了个对象）同样当作空
    window.localStorage.setItem(STORAGE_KEY, '{"a":1}');
    expect(getRememberedEvalRunIds()).toEqual([]);
  });
});

describe('listEvalRunHistory', () => {
  it('没有记录时不打任何请求', async () => {
    const { listEvalRunHistory } = await import('./service');

    await expect(listEvalRunHistory()).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('按 created_at 倒序返回', async () => {
    const { rememberEvalRun } = await import('./runRegistry');
    rememberEvalRun('old');
    rememberEvalRun('new');

    request.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('old')
          ? makeRun('old', '2026-10-01T00:00:00Z')
          : makeRun('new', '2026-10-15T00:00:00Z'),
      ),
    );

    const { listEvalRunHistory } = await import('./service');
    const rows = await listEvalRunHistory();

    expect(rows.map((r) => r.eval_run_id)).toEqual(['new', 'old']);
  });

  it('单个 id 拉不到就顺手清掉，其余照常返回', async () => {
    const { getRememberedEvalRunIds, rememberEvalRun } = await import(
      './runRegistry'
    );
    rememberEvalRun('alive');
    rememberEvalRun('deleted');

    request.mockImplementation((url: string) =>
      url.endsWith('deleted')
        ? Promise.reject(new Error('404'))
        : Promise.resolve(makeRun('alive', '2026-10-15T00:00:00Z')),
    );

    const { listEvalRunHistory } = await import('./service');
    const rows = await listEvalRunHistory();

    expect(rows.map((r) => r.eval_run_id)).toEqual(['alive']);
    // 死记录已经清掉，下次进页面不会再白跑一次必败请求
    expect(getRememberedEvalRunIds()).toEqual(['alive']);
  });

  it('全部失败时抛错，而不是假装「一条跑测都没有」', async () => {
    const { rememberEvalRun } = await import('./runRegistry');
    rememberEvalRun('a');
    rememberEvalRun('b');

    request.mockRejectedValue(new Error('backend down'));

    const { listEvalRunHistory } = await import('./service');
    await expect(listEvalRunHistory()).rejects.toThrow('backend down');
  });
});
