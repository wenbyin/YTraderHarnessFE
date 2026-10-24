// src/pages/agent_stress/mockData.test.ts
//
// mock 是页面的**离线数据源**（localStorage 开 `agent-stress:mock`），所以它自己
// 也要有回归测试：游标分页、状态过滤、取消的 409，以及 v2 的「指标内部自洽」——
//   · 会话：started 与 sampled_turns_per_session.count 对齐；
//   · 轮次：completed = succeeded + failed（不含 timed_out / cancelled）。
import { describe, expect, it } from 'vitest';

import type { StressRunCreate } from './data';
import * as mock from './mockData';

const RUNNING_ID = 'd4e6b8a0-1f3c-4d7e-9a2b-6c5d4e3f2a10';
const COMPLETED_ID = '3f2a9c41-0b7e-4a52-9c1d-5e6f7a8b9c01';
const FAILED_ID = '6b0f2e58-7c41-4a3d-8e9f-1a2b3c4d5e60';
const CANCELLED_ID = 'a17c9e34-5b62-4d80-9f1e-0c3b7a6d2e41';

function createBody(overrides: Partial<StressRunCreate> = {}): StressRunCreate {
  return {
    name: 'unit test run',
    target: { base_url: 'http://127.0.0.1:8080' },
    session: {
      agent_id: 'react_agent',
      turns: { mean: 4, stddev: 1, min: 1, max: 8, rounding: 'round' },
      on_turn_failure: 'abort',
      on_hitl: 'abort',
      cleanup: 'keep',
    },
    turn: { streaming: true, input_size_chars: 480 },
    load: { mode: 'concurrency', concurrency: 5 },
    duration_seconds: 30,
    total_sessions: 8,
    request_timeout_ms: 60_000,
    mock_model: {
      base_latency_ms: 100,
      ttft_ms: 100,
      output_tokens_min: 50,
      output_tokens_max: 100,
      tokens_per_second: 50,
    },
    ...overrides,
  };
}

describe('listStressRuns', () => {
  it('按创建时间倒序，且携带种子数据的状态分布', async () => {
    const res = await mock.listStressRuns();
    expect(res.items.length).toBeGreaterThanOrEqual(5);
    const times = res.items.map((run) => Date.parse(run.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(res.next_cursor).toBeNull();
  });

  it('cursor 分页：第二页不重复第一页，末页 next_cursor 为 null', async () => {
    const first = await mock.listStressRuns({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBe('2');

    const second = await mock.listStressRuns({
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    const firstIds = new Set(first.items.map((run) => run.run_id));
    for (const run of second.items) {
      expect(firstIds.has(run.run_id)).toBe(false);
    }

    const rest = await mock.listStressRuns({ limit: 100, cursor: '2' });
    expect(rest.next_cursor).toBeNull();
  });

  it('status 过滤只返回该状态', async () => {
    const res = await mock.listStressRuns({ status: 'failed' });
    expect(res.items.length).toBeGreaterThan(0);
    for (const run of res.items) expect(run.status).toBe('failed');
  });

  it('非法的 limit / cursor 会被夹到安全值', async () => {
    const res = await mock.listStressRuns({ limit: 0, cursor: 'not-a-number' });
    expect(res.items[0]).toBeTruthy();
  });

  it('返回的 config 是 v2 结构（target 是对象，session 带 turns）', async () => {
    const res = await mock.listStressRuns();
    for (const run of res.items) {
      expect(typeof run.config.target.base_url).toBe('string');
      expect(run.config.session.agent_id).toBeTruthy();
      expect(run.config.session.turns.mean).toBeGreaterThan(0);
    }
  });
});

describe('create / cancel', () => {
  it('创建后是 queued，并在列表首条', async () => {
    const created = await mock.createStressRun(createBody());
    expect(created.status).toBe('queued');
    expect(created.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const list = await mock.listStressRuns({ limit: 1 });
    expect(list.items[0].run_id).toBe(created.run_id);

    const detail = await mock.getStressRun(created.run_id);
    expect(detail.status).toBe('queued');
    expect(detail.started_at).toBeNull();
  });

  it('排队中也能取消；重复取消返回 409', async () => {
    const created = await mock.createStressRun(
      createBody({ name: 'cancel me' }),
    );
    const cancelled = await mock.cancelStressRun(created.run_id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finished_at).not.toBeNull();

    await expect(mock.cancelStressRun(created.run_id)).rejects.toMatchObject({
      response: { status: 409 },
    });
  });

  it('不存在的 run_id 是 404', async () => {
    await expect(mock.getStressRun('no-such-run')).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});

describe('getStressRunMetrics（会话 × 轮次）', () => {
  it('running：collecting，会话/轮次两侧都有数且自洽', async () => {
    const metrics = await mock.getStressRunMetrics(RUNNING_ID);
    expect(metrics.aggregation_status).toBe('collecting');
    expect(metrics.finalized_at).toBeNull();

    const sessions = metrics.sessions;
    expect(sessions.started).toBeGreaterThan(0);
    // 每个会话建会话时抽一个 N，样本数必须与 started 对齐
    expect(sessions.sampled_turns_per_session?.count).toBe(sessions.started);
    expect(sessions.turns_per_session?.count).toBe(sessions.started);
    expect(sessions.duration_ms?.p50).not.toBeNull();

    const turns = metrics.turns;
    expect(turns.started).toBeGreaterThan(0);
    // 契约：completed = succeeded + failed（timed_out / cancelled 不算完成）
    expect(turns.completed).toBe((turns.succeeded ?? 0) + (turns.failed ?? 0));
    expect(turns.started ?? 0).toBeGreaterThanOrEqual(
      (turns.completed ?? 0) + (turns.timed_out ?? 0) + (turns.cancelled ?? 0),
    );
    expect(turns.latency_ms?.p50).not.toBeNull();
    expect(turns.time_to_first_output_ms?.p99).not.toBeNull();
    // by_index 的 key 是 "1".."30" 的字符串
    expect(Object.keys(turns.by_index ?? {}).length).toBeGreaterThan(0);
    for (const key of Object.keys(turns.by_index ?? {})) {
      expect(Number.parseInt(key, 10)).toBeGreaterThan(0);
    }

    expect(turns.first_turn_latency_ms?.count).toBeGreaterThan(0);
    expect(metrics.model?.call_count).toBeGreaterThan(0);
    // 多轮会涨：后续轮的输入 token 应大于首轮
    expect(metrics.model?.input_tokens_per_turn?.mean ?? 0).toBeGreaterThan(0);
    expect(metrics.nodes?.main_agent?.count).toBeGreaterThan(0);
    expect(metrics.ingestion?.events_seen).toBeGreaterThan(0);
  });

  it('completed：final，带 finalized_at', async () => {
    const metrics = await mock.getStressRunMetrics(COMPLETED_ID);
    expect(metrics.aggregation_status).toBe('final');
    expect(metrics.finalized_at).not.toBeNull();
    expect(metrics.aggregation_algorithm).toBeTruthy();
  });

  it('failed：跑测带 error_code，指标标记 incomplete', async () => {
    const run = await mock.getStressRun(FAILED_ID);
    expect(run.status).toBe('failed');
    expect(run.error_code).toBe('MOCK_MODEL_UNAVAILABLE');

    const metrics = await mock.getStressRunMetrics(FAILED_ID);
    expect(metrics.aggregation_status).toBe('incomplete');
  });

  it('cancelled：incomplete，被波及的会话计 abandoned、轮次计 cancelled', async () => {
    const metrics = await mock.getStressRunMetrics(CANCELLED_ID);
    expect(metrics.aggregation_status).toBe('incomplete');
    expect(metrics.sessions.abandoned).toBe(metrics.sessions.started);
    expect(metrics.turns.cancelled).toBeGreaterThan(0);
  });

  it('queued：全 0，聚合仍是 collecting', async () => {
    const created = await mock.createStressRun(
      createBody({ name: 'still queued' }),
    );
    const metrics = await mock.getStressRunMetrics(created.run_id);
    expect(metrics.aggregation_status).toBe('collecting');
    expect(metrics.sessions.started).toBe(0);
    expect(metrics.turns.started).toBe(0);
    expect(metrics.turns.latency_ms?.count).toBe(0);
    expect(metrics.turns.latency_ms?.p50).toBeNull();
    expect(metrics.trace_counts).toEqual({});
  });
});

describe('sampleTurns（截断正态）', () => {
  it('同一 (seed, index) 恒得同一个 N，且落在 [min, max]', () => {
    const turns = {
      mean: 4.5,
      stddev: 1.5,
      min: 1,
      max: 8,
      rounding: 'round' as const,
    };
    const first = mock.sampleTurns(turns, 42, 3);
    expect(mock.sampleTurns(turns, 42, 3)).toBe(first);
    for (let i = 0; i < 200; i += 1) {
      const n = mock.sampleTurns(turns, 42, i);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(8);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('stddev=0 就是固定轮数', () => {
    expect(
      mock.sampleTurns({ mean: 6, stddev: 0, min: 1, max: 30 }, 7, 0),
    ).toBe(6);
  });
});
