// src/pages/agent_stress/CreateStressRunDrawer.test.tsx
//
// 钉住两件**会误导用户**的交互：
//   1. 填了到达率、但「会话总数上限」把它夹住时，实际跑不到目标 TPS
//      （12 会话 × 4.5 轮 / 60s = 0.9 轮/s），必须当场告警，而不是等跑完看指标才发现；
//   2. 「重新发起」要把该次运行的参数**原样**带回表单并提交 —— 契约形状
//      （嵌套 turns / 三选一 load / 对象 input_template）与表单形状不同，
//      映射写错的话界面"看起来填了"，发出去的却是默认参数。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@umijs/max', () => ({ history: { push: vi.fn() } }));

import { CreateStressRunDrawer } from './components/CreateStressRunDrawer';
import type { StressRun, StressRunCreate } from './data';

function setup(preset?: StressRun) {
  return render(
    <App>
      <CreateStressRunDrawer
        open
        onClose={() => {}}
        onSubmit={async () => {}}
        preset={preset}
      />
    </App>,
  );
}

/** 按表单字段名取输入框（antd 会把 name 写成 input 的 id） */
function input(name: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`#${name}`);
  if (!el) throw new Error(`找不到输入框 #${name}`);
  return el;
}

beforeEach(() => {
  // 本仓库没开 vitest globals → RTL 不会自动 cleanup，不清理会串 DOM
  cleanup();
});

describe('新建压测抽屉 · 负载口径', () => {
  it('默认是「固定并发会话」，量级预估按 会话 × 轮 算', async () => {
    setup();
    expect(await screen.findByText('新建压测')).toBeTruthy();
    // 默认 12 会话 × 4.5 轮。
    // ⚠️ 必须用 findByText（异步）：抽屉标题先出现，量级预估要等表单初值落到
    //    state 之后那一帧才渲染，同步 getByText 会稳定地抢在它之前。
    expect(
      await screen.findByText(/量级预估：约 12 个会话 × 4.5 轮 ≈ 54 轮/),
    ).toBeTruthy();
    // 并发模式下不显示「会话总数上限夹住到达率」的告警
    expect(screen.queryByText(/会先于时长生效/)).toBeNull();
  });

  it('切到固定到达率：显示 TPS 折算，并在被会话总数夹住时告警', async () => {
    setup();
    await screen.findByText('新建压测');

    fireEvent.click(screen.getByText('固定到达率'));

    // 默认 session_rate=2、E[N]=4.5 → 9.0 轮/s
    expect(await screen.findByText(/≈ 9\.0 轮\/s/)).toBeTruthy();

    // 2 会话/s × 60s = 120 个会话 > 上限 12 → 告警（12×4.5/60 = 0.9 轮/s）
    expect(screen.getByText(/会话总数上限 12 会先于时长生效/)).toBeTruthy();
    expect(screen.getByText(/平均 0\.90 轮\/s/)).toBeTruthy();

    // 把速率调到 0.1 → 0.1×60=6 < 12，不再告警
    fireEvent.change(input('session_rate'), { target: { value: '0.1' } });
    expect(await screen.findByText(/≈ 0\.5 轮\/s/)).toBeTruthy();
    expect(screen.queryByText(/会先于时长生效/)).toBeNull();
  });
});

/**
 * 「重新发起」用的一条**非默认**配置 —— 每个字段都刻意与 INITIAL_VALUES 不同，
 * 否则"回填成功"和"其实吃的默认值"在断言里分不出来。
 */
const PRESET_CONFIG: StressRunCreate = {
  name: 'nightly · 到达率 0.5',
  target: {
    base_url: 'http://10.0.0.9:8080',
    create_session_path: '/api/v1/sessions',
    run_events_path: '/api/v1/runs/{run_id}/events',
  },
  auth: { type: 'bearer', token_env: 'MY_STRESS_TOKEN' },
  session: {
    agent_id: 'stock_research',
    turns: { mean: 3, stddev: 0, min: 2, max: 4, rounding: 'floor' },
    think_time_ms: 800,
    on_turn_failure: 'continue',
    on_hitl: 'auto_approve',
    cleanup: 'delete',
  },
  turn: {
    streaming: true,
    input_template: { text: '压测一下' },
    input_size_chars: 900,
  },
  load: { mode: 'session_rate', session_rate: 0.5 },
  duration_seconds: 120,
  warmup_seconds: 10,
  ramp_up_seconds: 5,
  total_sessions: 30,
  max_turns: 120,
  request_timeout_ms: 30000,
  seed: 7,
  mock_model: {
    profile: 'slow',
    base_latency_ms: 900,
    latency_jitter_ms: 120,
    ttft_ms: 1500,
    output_tokens_min: 50,
    output_tokens_max: 120,
    tokens_per_second: 20,
    error_rate: 0.05,
    timeout_rate: 0.01,
    stream_chunk_tokens: 4,
    max_inflight_requests: 6,
  },
};

function presetRun(config: StressRunCreate = PRESET_CONFIG): StressRun {
  return {
    run_id: 'a1b2c3d4-0000-4000-8000-000000000000',
    name: config.name ?? null,
    status: 'completed',
    config,
    created_at: '2026-10-18T06:00:00.000Z',
    started_at: '2026-10-18T06:00:01.000Z',
    finished_at: '2026-10-18T06:05:00.000Z',
    error_code: null,
    error_message: null,
  };
}

describe('重新发起：把该次运行的参数带回来', () => {
  it('标题与来源说明切到「重新发起」，表单字段按 config 回填', async () => {
    setup(presetRun());

    expect(await screen.findByText('重新发起压测')).toBeTruthy();
    // 说清参数从哪来（名称 + run_id 前 8 位），避免"以为是新建"
    expect(screen.getByText(/参数已按所选运行回填/)).toBeTruthy();
    expect(screen.getByText(/nightly · 到达率 0\.5/)).toBeTruthy();
    expect(screen.getByText('a1b2c3d4…')).toBeTruthy();

    // 先等**依赖回填值**的那段文案出现：它证明 useWatch 已经吃到新值，
    // 后面读 input.value 才不是跟一帧之前的 DOM 赛跑。
    // （到达率分支的 extra：0.5 × E[N]=3 → 1.5 轮/s）
    expect(await screen.findByText(/≈ 1\.5 轮\/s/)).toBeTruthy();

    // 摊平/嵌套的映射：turns 是嵌套的，表单里必须是摊平的三个字段
    expect(input('agent_id').value).toBe('stock_research');
    // InputNumber 会按 step=0.5 补一位小数（"3.0"），比数值而不是比字面量
    expect(Number(input('turns_mean').value)).toBe(3);
    expect(Number(input('turns_stddev').value)).toBe(0);
    expect(input('duration_seconds').value).toBe('120');
    expect(input('total_sessions').value).toBe('30');
    expect(input('base_url').value).toBe('http://10.0.0.9:8080');
    expect(input('token_env').value).toBe('MY_STRESS_TOKEN');
    // 对象形态的 input_template 要变成可读的 JSON 文本，不能是 [object Object]
    const template =
      document.querySelector<HTMLTextAreaElement>('#input_template');
    expect(template?.value).toContain('"压测一下"');
    // 到达率模式：session_rate 有值、concurrency 那一支不渲染
    expect(input('session_rate').value).toBe('0.5');
    expect(document.querySelector('#concurrency')).toBeNull();
  });

  it('提交时按回填的参数生成请求体（不是默认值）', async () => {
    // 参数类型要写出来：`vi.fn(async () => {})` 会被推成零元组，
    // mock.calls[0][0] 直接报 TS2493。
    const onSubmit = vi.fn(async (_body: StressRunCreate) => {});
    render(
      <App>
        <CreateStressRunDrawer
          open
          onClose={() => {}}
          onSubmit={onSubmit}
          preset={presetRun()}
        />
      </App>,
    );

    fireEvent.click(await screen.findByText('按此参数发起'));

    const body = (await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
      return onSubmit.mock.calls[0][0];
    })) as StressRunCreate;

    expect(body.name).toBe('nightly · 到达率 0.5');
    expect(body.target).toMatchObject({
      base_url: 'http://10.0.0.9:8080',
      create_session_path: '/api/v1/sessions',
      run_events_path: '/api/v1/runs/{run_id}/events',
    });
    expect(body.auth).toEqual({ type: 'bearer', token_env: 'MY_STRESS_TOKEN' });
    expect(body.session).toMatchObject({
      agent_id: 'stock_research',
      turns: { mean: 3, stddev: 0, min: 2, max: 4, rounding: 'floor' },
      think_time_ms: 800,
      on_turn_failure: 'continue',
      on_hitl: 'auto_approve',
      cleanup: 'delete',
    });
    expect(body.turn).toMatchObject({
      streaming: true,
      input_template: { text: '压测一下' },
      input_size_chars: 900,
    });
    expect(body.load).toEqual({ mode: 'session_rate', session_rate: 0.5 });
    expect(body.duration_seconds).toBe(120);
    expect(body.warmup_seconds).toBe(10);
    expect(body.ramp_up_seconds).toBe(5);
    expect(body.total_sessions).toBe(30);
    expect(body.max_turns).toBe(120);
    expect(body.request_timeout_ms).toBe(30000);
    expect(body.seed).toBe(7);
    expect(body.mock_model).toMatchObject({
      profile: 'slow',
      base_latency_ms: 900,
      ttft_ms: 1500,
      output_tokens_min: 50,
      output_tokens_max: 120,
      tokens_per_second: 20,
      error_rate: 0.05,
      timeout_rate: 0.01,
      stream_chunk_tokens: 4,
      max_inflight_requests: 6,
    });
  });

  it('⚠️ 不带 preset（新建）时不会残留上一次重发的参数', async () => {
    const { rerender } = setup(presetRun());
    await screen.findByText('重新发起压测');

    rerender(
      <App>
        <CreateStressRunDrawer
          open
          onClose={() => {}}
          onSubmit={async () => {}}
        />
      </App>,
    );

    // 回到新建：默认值（general / 4.5 轮 / 60s），而不是上一条运行的
    expect(await screen.findByText('新建压测')).toBeTruthy();
    expect(input('agent_id').value).toBe('general');
    expect(input('turns_mean').value).toBe('4.5');
    expect(input('duration_seconds').value).toBe('60');
  });
});
