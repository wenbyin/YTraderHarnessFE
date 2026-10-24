// src/pages/agent_stress/detail.test.tsx
//
// 详情页的渲染冒烟：真 antd 组件（Descriptions / Progress / Table 都不过 mock），
// 只把 PageContainer 和 umi 路由壳掉，用来钉住四件事：
//   1. running 时能看到「聚合中」与取消入口；
//   2. v2 的会话 / 轮次两套指标都渲染出来了，且单位能读（p50 690 → "690 ms"）；
//   3. 配置区读的是 `config.target.base_url` / `config.session.agent_id`（v2 嵌套结构）；
//   4. 终态（completed）不再给取消按钮，聚合标签变「已定型」。
import { cleanup, render, screen } from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StressRun, StressRunMetrics } from './data';

const getStressRun = vi.fn();
const getStressRunMetrics = vi.fn();

vi.mock('@umijs/max', () => ({
  history: { push: vi.fn() },
  useParams: () => ({ runId: 'run-1' }),
}));

vi.mock('@ant-design/pro-components', () => ({
  PageContainer: ({
    title,
    subTitle,
    tags,
    extra,
    children,
  }: {
    title?: React.ReactNode;
    subTitle?: React.ReactNode;
    tags?: React.ReactNode;
    extra?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <div>{subTitle}</div>
      <div>{tags}</div>
      <div>{extra}</div>
      {children}
    </div>
  ),
}));

vi.mock('./service', () => ({
  getStressRun: (...args: unknown[]) => getStressRun(...args),
  getStressRunMetrics: (...args: unknown[]) => getStressRunMetrics(...args),
  cancelStressRun: vi.fn(),
  stressErrorMessage: (error: unknown) => (error as Error)?.message ?? '',
  stressErrorStatus: () => undefined,
  USE_MOCK_STRESS: false,
}));

import AgentStressDetailPage from './detail';

function makeRun(over: Partial<StressRun> = {}): StressRun {
  const started = new Date(Date.now() - 20_000).toISOString();
  return {
    run_id: 'run-1',
    name: 'baseline · 12 会话 / 平均 4.5 轮',
    status: 'running',
    created_at: started,
    started_at: started,
    finished_at: null,
    error_code: null,
    error_message: null,
    config: {
      target: {
        base_url: 'http://127.0.0.1:8080',
        create_session_path: '/api/v1/sessions',
      },
      auth: { type: 'bearer', token_env: 'STRESS_RUNNER_TOKEN' },
      session: {
        agent_id: 'stock_research',
        turns: { mean: 4.5, stddev: 1.5, min: 1, max: 8, rounding: 'round' },
        think_time_ms: 0,
        on_turn_failure: 'abort',
        on_hitl: 'abort',
        cleanup: 'keep',
      },
      turn: { streaming: true, input_size_chars: 512 },
      load: { mode: 'concurrency', concurrency: 100 },
      duration_seconds: 60,
      warmup_seconds: 5,
      ramp_up_seconds: 10,
      total_sessions: 12,
      request_timeout_ms: 120000,
      mock_model: {
        profile: 'balanced',
        base_latency_ms: 180,
        latency_jitter_ms: 60,
        ttft_ms: 240,
        output_tokens_min: 200,
        output_tokens_max: 600,
        tokens_per_second: 90,
        error_rate: 0.01,
        timeout_rate: 0.002,
      },
    },
    ...over,
  };
}

const METRICS: StressRunMetrics = {
  run_id: 'run-1',
  aggregation_status: 'collecting',
  aggregation_algorithm: null,
  finalized_at: null,
  sessions: {
    started: 100,
    completed: 88,
    failed: 2,
    abandoned: 10,
    completion_rate: 0.88,
    achieved_sessions_per_second: 12.5,
    duration_ms: {
      count: 88,
      p50: 24_000,
      p90: 38_000,
      p95: 42_000,
      p99: 55_000,
      mean: 26_000,
      min: 9_000,
      max: 58_000,
    },
    sampled_turns_per_session: {
      count: 100,
      p50: 4,
      p90: 6,
      p95: 7,
      p99: 8,
      mean: 4.5,
      min: 2,
      max: 8,
    },
    turns_per_session: {
      count: 100,
      p50: 4,
      p90: 6,
      p95: 6,
      p99: 7,
      mean: 4.2,
      min: 1,
      max: 8,
    },
  },
  turns: {
    started: 400,
    completed: 392,
    succeeded: 388,
    failed: 3,
    timed_out: 1,
    cancelled: 0,
    achieved_turns_per_second: 33.3,
    error_rate: 0.01,
    latency_ms: {
      count: 392,
      p50: 690,
      p90: 900,
      p95: 1000,
      p99: 1200,
      mean: 720,
      min: 300,
      max: 1500,
    },
    time_to_first_output_ms: {
      count: 392,
      p50: 420,
      p90: 500,
      p95: 520,
      p99: 600,
      mean: 430,
      min: 380,
      max: 700,
    },
    first_turn_latency_ms: {
      count: 100,
      p50: 700,
      p90: 900,
      p95: 1000,
      p99: 1200,
      mean: 730,
      min: 400,
      max: 1500,
    },
    later_turn_latency_ms: {
      count: 292,
      p50: 680,
      p90: 880,
      p95: 980,
      p99: 1150,
      mean: 710,
      min: 300,
      max: 1400,
    },
    by_index: {
      '1': { count: 100, p50: 700, p95: 1000, mean: 730 },
      '2': { count: 90, p50: 690, p95: 980, mean: 715 },
      '3': { count: 80, p50: 680, p95: 960, mean: 700 },
    },
  },
  trace_counts: { run_span_count: 400, node_span_count: 880 },
  model: {
    call_count: 800,
    retry_count: 3,
    error_count: 2,
    input_tokens_sum: 60_000,
    output_tokens_sum: 120_000,
    duration_ms: { count: 800, p50: 500, p95: 900, p99: 1200 },
    input_tokens_per_turn: { count: 400, p50: 420, p95: 620, p99: 700 },
    output_tokens_per_turn: { count: 400, p50: 380, p95: 560, p99: 600 },
  },
  nodes: { planner: { count: 880, p50: 210, p95: 400, p99: 600 } },
  tools: { web_search: { count: 40, p50: 320, p95: 700, p99: 900 } },
  fanout: { count: 12, branch_count: 24, failed_branch_count: 0 },
  ingestion: {
    events_seen: 1200,
    events_deduplicated: 30,
    events_unmatched: 2,
    events_late: 5,
  },
};

beforeEach(() => {
  // 本仓库没开 vitest globals，RTL 的自动 cleanup 不会注册 —— 不手动清，
  // 上一个用例的 DOM 会留下来，`queryByRole` 就会查到别人的按钮
  cleanup();
  vi.clearAllMocks();
});

describe('压测详情', () => {
  it('running + collecting：展示聚合提示、取消入口与格式化后的分位数', async () => {
    getStressRun.mockResolvedValue(makeRun());
    getStressRunMetrics.mockResolvedValue(METRICS);

    render(
      <App>
        <AgentStressDetailPage />
      </App>,
    );

    // 「运行中」既是状态标签也是页头文案，指标里还有同名 label —— 用 AllBy
    expect((await screen.findAllByText('运行中')).length).toBeGreaterThan(0);
    // 聚合状态标签
    expect(screen.getByText('聚合中')).toBeTruthy();
    expect(screen.getByText(/指标持续聚合中/)).toBeTruthy();
    // 轮次 p50 690ms → "690 ms"；会话速率 12.5 → "12.50"
    expect(screen.getAllByText('690 ms').length).toBeGreaterThan(0);
    expect(screen.getByText('12.50')).toBeTruthy();
    // v2：会话 × 轮次 两组指标卡都在（同名文案在 hero / 卡片标题里都有，用 AllBy）
    expect(screen.getAllByText('会话').length).toBeGreaterThan(0);
    expect(screen.getAllByText('轮次').length).toBeGreaterThan(0);
    expect(screen.getByText('每会话轮数')).toBeTruthy();
    expect(screen.getByText('按轮次序号看时延')).toBeTruthy();
    // 配置区显示 base_url（v2 的 target 是对象）
    expect(screen.getAllByText('http://127.0.0.1:8080').length).toBeGreaterThan(
      0,
    );
    // 未终态才有取消
    expect(screen.getByRole('button', { name: /取消跑测/ })).toBeTruthy();
  });

  it('completed + final：没有取消按钮，标签为已定型', async () => {
    getStressRun.mockResolvedValue(
      makeRun({
        status: 'completed',
        finished_at: new Date().toISOString(),
      }),
    );
    getStressRunMetrics.mockResolvedValue({
      ...METRICS,
      aggregation_status: 'final',
      aggregation_algorithm: 'tdigest-v1',
      finalized_at: new Date().toISOString(),
    });

    render(
      <App>
        <AgentStressDetailPage />
      </App>,
    );

    // 「已完成」同时出现在状态标签与「已完成」指标卡的 label 上
    expect((await screen.findAllByText('已完成')).length).toBeGreaterThan(0);
    expect(screen.getByText('已定型')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /取消跑测/ })).toBeNull();
  });

  it('后端 simulated-v1：顶部打「模拟指标」，避免被当成真实结论', async () => {
    getStressRun.mockResolvedValue(makeRun());
    getStressRunMetrics.mockResolvedValue({
      ...METRICS,
      aggregation_algorithm: 'simulated-v1',
    });

    render(
      <App>
        <AgentStressDetailPage />
      </App>,
    );

    expect(await screen.findByText('模拟指标')).toBeTruthy();
  });

  it('failed：把 error_code 与 error_message 直接摆出来', async () => {
    getStressRun.mockResolvedValue(
      makeRun({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_code: 'MOCK_MODEL_UNAVAILABLE',
        error_message: '网关连续 5 次 5xx',
      }),
    );
    getStressRunMetrics.mockResolvedValue({
      ...METRICS,
      aggregation_status: 'incomplete',
    });

    render(
      <App>
        <AgentStressDetailPage />
      </App>,
    );

    expect(await screen.findByText('跑测失败')).toBeTruthy();
    expect(screen.getByText('MOCK_MODEL_UNAVAILABLE')).toBeTruthy();
    expect(screen.getByText('网关连续 5 次 5xx')).toBeTruthy();
    expect(screen.getByText('数据不全')).toBeTruthy();
  });
});
