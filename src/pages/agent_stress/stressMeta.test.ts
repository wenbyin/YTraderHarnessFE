// src/pages/agent_stress/stressMeta.test.ts
//
// 钉住四件事：
//   1. 表单值 → 请求体的收敛（契约 additionalProperties:false，多一个键就是 422）；
//   2. v2 的**多轮会话**语义：`agent_id` / `turns` 进 session，`input_template` 进 turn，
//      `request_rate` 改名 session_rate，`load.concurrency` 的含义是「在途会话数」；
//   3. 数字格式化 / 状态判定的边界（null 必须显示 "—"，不能被 Number(null) 吞成 0）；
//   4. `fromStressRunCreate` 是 1 的**逆向**（「重新发起」把 config 反解回表单），
//      与 toStressRunCreate 往返一次必须回到原配置。
import { describe, expect, it } from 'vitest';

import type { StressRun, StressRunFormValues } from './data';
import {
  distributionRows,
  elapsedSeconds,
  expectedTurns,
  formatMs,
  formatPercent,
  formatRate,
  formatSeconds,
  formatTokens,
  fromStressRunCreate,
  isTerminal,
  loadDetail,
  loadSummary,
  parseInputTemplate,
  runProgress,
  toStressRunCreate,
  turnCountLabel,
  turnIndexRows,
  turnRateFromSessionRate,
} from './stressMeta';

function baseValues(
  overrides: Partial<StressRunFormValues> = {},
): StressRunFormValues {
  return {
    name: '  baseline  ',
    base_url: '  http://127.0.0.1:8080  ',
    agent_id: '  react_agent  ',
    turns_mean: 4.5,
    turns_stddev: 1.5,
    turns_min: 1,
    turns_max: 8,
    turns_rounding: 'round',
    on_turn_failure: 'abort',
    on_hitl: 'abort',
    cleanup: 'keep',
    streaming: true,
    load_mode: 'concurrency',
    concurrency: 100,
    session_rate: 50,
    duration_seconds: 60,
    request_timeout_ms: 120000,
    mock_model: {
      base_latency_ms: 180,
      ttft_ms: 240,
      output_tokens_min: 200,
      output_tokens_max: 600,
      tokens_per_second: 90,
    },
    ...overrides,
  };
}

describe('toStressRunCreate · 结构与白名单', () => {
  it('nest 成 target / session / turn 三段，不泄漏前端摊平字段', () => {
    const body = toStressRunCreate(baseValues());

    expect(body.target.base_url).toBe('http://127.0.0.1:8080');
    expect(body.session.agent_id).toBe('react_agent');
    expect(body.session.turns).toEqual({
      mean: 4.5,
      stddev: 1.5,
      min: 1,
      max: 8,
      rounding: 'round',
    });

    // 纯前端字段一个都不能出去（契约 additionalProperties:false）
    for (const key of [
      'base_url',
      'agent_id',
      'token_env',
      'paths',
      'turns_mean',
      'turns_stddev',
      'turns_min',
      'turns_max',
      'turns_rounding',
      'on_turn_failure',
      'on_hitl',
      'cleanup',
      'load_mode',
      'concurrency',
      'session_rate',
      'input_template',
      'input_size_chars',
      'streaming',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('并发模式只带 concurrency', () => {
    const body = toStressRunCreate(baseValues());
    expect(body.load).toEqual({ mode: 'concurrency', concurrency: 100 });
  });

  it('到达率模式只带 session_rate（不是 request_rate）', () => {
    const body = toStressRunCreate(
      baseValues({ load_mode: 'session_rate', session_rate: 12.5 }),
    );
    expect(body.load).toEqual({ mode: 'session_rate', session_rate: 12.5 });
  });

  it('turn.streaming 强制 true，表单传 false 也覆盖', () => {
    const body = toStressRunCreate(baseValues({ streaming: false }));
    expect(body.turn?.streaming).toBe(true);
  });

  it('空的可选字段整条省略（不是写 null）', () => {
    const body = toStressRunCreate(
      baseValues({
        name: '   ',
        token_env: '   ',
        warmup_seconds: undefined,
        ramp_up_seconds: undefined,
        total_sessions: undefined,
        max_turns: undefined,
        think_time_ms: undefined,
        seed: undefined,
        input_size_chars: undefined,
        input_template: '   ',
      }),
    );

    for (const key of [
      'name',
      'auth',
      'warmup_seconds',
      'ramp_up_seconds',
      'total_sessions',
      'max_turns',
      'seed',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.session).not.toHaveProperty('think_time_ms');
    expect(body.turn).not.toHaveProperty('input_size_chars');
    expect(body.turn).not.toHaveProperty('input_template');
  });

  it('string 会 trim；0 是合法值不能被当成空', () => {
    const body = toStressRunCreate(
      baseValues({ warmup_seconds: 0, think_time_ms: 0, seed: 0 }),
    );
    expect(body.name).toBe('baseline');
    expect(body.warmup_seconds).toBe(0);
    expect(body.session.think_time_ms).toBe(0);
    expect(body.seed).toBe(0);
    expect(body.mock_model.error_rate).toBeUndefined();
  });

  it('auth 只带环境变量名，绝不带明文 token', () => {
    const body = toStressRunCreate(
      baseValues({ token_env: '  STRESS_RUNNER_TOKEN  ' }),
    );
    expect(body.auth).toEqual({
      type: 'bearer',
      token_env: 'STRESS_RUNNER_TOKEN',
    });
    expect(body.auth).not.toHaveProperty('token');
  });

  it('端点路径按需覆盖，空串省略（走后端默认）', () => {
    const body = toStressRunCreate(
      baseValues({
        paths: {
          create_session_path: '  /openapi/sessions  ',
          delete_session_path: '   ',
        },
      }),
    );
    expect(body.target.create_session_path).toBe('/openapi/sessions');
    expect(body.target).not.toHaveProperty('delete_session_path');
    expect(body.target).not.toHaveProperty('create_run_path');
  });

  it('input_template 解析成对象', () => {
    const body = toStressRunCreate(
      baseValues({ input_template: '{"text":"synthetic"}' }),
    );
    expect(body.turn?.input_template).toEqual({ text: 'synthetic' });
  });
});

describe('toStressRunCreate · 前置校验（后端 422 的同类判据）', () => {
  it('output_tokens 上下限倒挂会抛错', () => {
    expect(() =>
      toStressRunCreate(
        baseValues({
          mock_model: {
            base_latency_ms: 1,
            ttft_ms: 1,
            output_tokens_min: 500,
            output_tokens_max: 100,
            tokens_per_second: 10,
          },
        }),
      ),
    ).toThrow(/不能小于/);
  });

  it('并发数缺失会抛错而不是发一个 0 会话并发', () => {
    expect(() =>
      toStressRunCreate(baseValues({ concurrency: undefined })),
    ).toThrow(/concurrency/);
  });

  it('到达率缺失 / 非正数会抛错', () => {
    expect(() =>
      toStressRunCreate(
        baseValues({ load_mode: 'session_rate', session_rate: 0 }),
      ),
    ).toThrow(/session_rate/);
  });

  it('agent_id 必填（v1 的 agent_type 位置）', () => {
    expect(() => toStressRunCreate(baseValues({ agent_id: '   ' }))).toThrow(
      /agent_id/,
    );
  });

  it('base_url 必须是 http/https 绝对地址', () => {
    expect(() => toStressRunCreate(baseValues({ base_url: '' }))).toThrow(
      /base_url/,
    );
    expect(() =>
      toStressRunCreate(baseValues({ base_url: '127.0.0.1:8080' })),
    ).toThrow(/http/);
  });

  it('mean 必须落在 [min, max] 内', () => {
    expect(() =>
      toStressRunCreate(baseValues({ turns_mean: 20, turns_max: 8 })),
    ).toThrow(/落在 \[min, max\]/);
  });

  it('min > max 会抛错', () => {
    expect(() =>
      toStressRunCreate(
        baseValues({ turns_min: 10, turns_max: 3, turns_mean: 5 }),
      ),
    ).toThrow(/1 ≤ min ≤ max ≤ 30/);
  });

  it('截断区间覆盖不足 5% 正态概率会抛错（拒绝采样必然失败）', () => {
    // 固定 4 轮却给了 stddev=2 → [4,4] 的概率质量为 0
    expect(() =>
      toStressRunCreate(
        baseValues({
          turns_mean: 4,
          turns_stddev: 2,
          turns_min: 4,
          turns_max: 4,
        }),
      ),
    ).toThrow(/5%/);
  });

  it('warmup 必须小于 duration，否则整段都在预热窗口里', () => {
    expect(() =>
      toStressRunCreate(
        baseValues({ warmup_seconds: 60, duration_seconds: 60 }),
      ),
    ).toThrow(/warmup_seconds/);
  });

  it('rounding 会落进 session.turns', () => {
    const body = toStressRunCreate(baseValues({ turns_rounding: 'floor' }));
    expect(body.session.turns.rounding).toBe('floor');
  });
});

describe('parseInputTemplate', () => {
  it('空串 → undefined（沿用后端默认合成体）', () => {
    expect(parseInputTemplate('')).toBeUndefined();
    expect(parseInputTemplate('   ')).toBeUndefined();
  });

  it('数组 / 标量都不是合法输入模板', () => {
    expect(() => parseInputTemplate('[1,2]')).toThrow(/JSON 对象/);
    expect(() => parseInputTemplate('"text"')).toThrow(/JSON 对象/);
    expect(() => parseInputTemplate('null')).toThrow(/JSON 对象/);
  });

  it('语法错误给人话', () => {
    expect(() => parseInputTemplate('{oops}')).toThrow(/不是合法 JSON/);
  });
});

describe('状态与描述', () => {
  it('终态只有 completed / failed / cancelled', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
  });

  it('负载文案必须出现「会话」，别和 v1 的「请求并发」读成一件事', () => {
    expect(loadSummary({ mode: 'concurrency', concurrency: 100 })).toBe(
      '100 会话并发',
    );
    expect(loadSummary({ mode: 'session_rate', session_rate: 50 })).toBe(
      '50 会话/s',
    );
    expect(loadDetail({ mode: 'concurrency', concurrency: 100 })).toContain(
      '在途会话',
    );
    expect(loadDetail({ mode: 'session_rate', session_rate: 50 })).toContain(
      '每秒新建',
    );
  });

  it('turnCountLabel 描述 N 的分布', () => {
    expect(turnCountLabel({ mean: 4.5, stddev: 1.5, min: 1, max: 8 })).toBe(
      '4.5 ± 1.5 轮 · 范围 1~8',
    );
    expect(turnCountLabel({ mean: 6, stddev: 0 })).toContain('固定');
    expect(turnCountLabel(undefined)).toBe('—');
  });

  it('turnRateFromSessionRate：TPS = 新建会话速率 × E[N]', () => {
    // 想压 10 轮/s、E[N]=4.5 → 到达率要填 10/4.5 ≈ 2.2
    expect(turnRateFromSessionRate(2.2, 4.5)).toBeCloseTo(9.9);
    expect(turnRateFromSessionRate(2, 4.5)).toBe(9);
    // 缺任一参数就返回 null（不瞎估）
    expect(turnRateFromSessionRate(undefined, 4.5)).toBeNull();
    expect(turnRateFromSessionRate(2, undefined)).toBeNull();
    expect(turnRateFromSessionRate(Number.NaN, 4.5)).toBeNull();
  });

  it('expectedTurns = total_sessions × E[N]，缺参数不瞎估', () => {
    expect(
      expectedTurns({
        total_sessions: 12,
        session: { turns: { mean: 4.5, stddev: 1.5 } },
      }),
    ).toBe(54);
    expect(
      expectedTurns({ session: { turns: { mean: 4.5, stddev: 1 } } }),
    ).toBeNull();
    expect(expectedTurns({ total_sessions: 12 })).toBeNull();
  });
});

describe('数值格式化', () => {
  it('null / undefined 一律 —，不能变成 0', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatSeconds(null)).toBe('—');
    expect(formatTokens(null)).toBe('—');
    expect(formatRate(null)).toBe('—');
  });

  it('毫秒按量级换单位', () => {
    expect(formatMs(0.5)).toBe('500 µs');
    expect(formatMs(320)).toBe('320 ms');
    expect(formatMs(1500)).toBe('1.50 s');
    expect(formatMs(90_000)).toBe('1.50 min');
  });

  it('秒数的分/时进位', () => {
    expect(formatSeconds(45)).toBe('45 秒');
    expect(formatSeconds(60)).toBe('1 分钟');
    expect(formatSeconds(90)).toBe('1 分 30 秒');
    expect(formatSeconds(3600)).toBe('1 小时');
    expect(formatSeconds(3900)).toBe('1 小时 5 分');
    // 模拟执行器把 60s 压到几百毫秒，别显示成 "0 秒"
    expect(formatSeconds(0.2)).toBe('< 1 秒');
    expect(formatSeconds(0)).toBe('0 秒');
  });

  it('错误率小于 1% 时保留两位小数', () => {
    expect(formatPercent(0.0005)).toBe('0.05%');
    expect(formatPercent(0.0123)).toBe('1.2%');
    expect(formatPercent(0.18)).toBe('18.0%');
  });

  it('速率小于 1 时多给一位小数', () => {
    expect(formatRate(0.4234)).toBe('0.423');
    expect(formatRate(12.345)).toBe('12.35');
  });

  it('token 用 k / M 缩写', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(42_317)).toBe('42.3k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });

  it('distributionRows 只有 min（v2 没有 minimum）', () => {
    const rows = distributionRows({ count: 10, min: 3, p99: 20 });
    expect(rows.find((r) => r.key === 'min')?.value).toBe(3);
    expect(rows.find((r) => r.key === 'p99')?.value).toBe(20);
    expect(rows.find((r) => r.key === 'max')?.value).toBeNull();
  });

  it('turnIndexRows 按数值排序，不按字符串（否则 "10" < "2"）', () => {
    const rows = turnIndexRows({
      '10': { p50: 100 },
      '2': { p50: 20 },
      '1': { p50: 10 },
    });
    expect(rows.map((r) => r.index)).toEqual([1, 2, 10]);
  });
});

const run = (overrides: Partial<StressRun>): StressRun => ({
  run_id: 'r1',
  status: 'running',
  created_at: '2026-10-18T00:00:00.000Z',
  started_at: '2026-10-18T00:00:00.000Z',
  config: {
    target: { base_url: 'http://x' },
    session: {
      agent_id: 'a',
      turns: { mean: 1, stddev: 0 },
    },
    load: { mode: 'concurrency', concurrency: 1 },
    duration_seconds: 100,
    request_timeout_ms: 1000,
    mock_model: {
      base_latency_ms: 1,
      ttft_ms: 1,
      output_tokens_min: 1,
      output_tokens_max: 2,
      tokens_per_second: 1,
    },
  },
  ...overrides,
});

const at = Date.parse('2026-10-18T00:00:00.000Z');

describe('runProgress', () => {
  it('排队中为 0，终态为 100', () => {
    expect(runProgress(run({ status: 'queued' }), at + 50_000)).toBe(0);
    expect(runProgress(run({ status: 'completed' }), at)).toBe(100);
  });

  it('运行中按 started_at 与 duration 算，并夹在 0~100', () => {
    expect(runProgress(run({}), at + 25_000)).toBeCloseTo(25);
    expect(runProgress(run({}), at + 1_000_000)).toBe(100);
    expect(runProgress(run({}), at - 5_000)).toBe(0);
  });
});

describe('elapsedSeconds', () => {
  it('终态用 finished_at - started_at，不随 now 增长', () => {
    const finished = run({
      status: 'completed',
      started_at: '2026-10-18T00:00:00.000Z',
      finished_at: '2026-10-18T00:01:00.000Z',
    });
    // 页面停留 1 小时后仍然是 60 秒 —— 之前用 now 去减会显示 "1 小时"
    expect(elapsedSeconds(finished, at + 3_600_000)).toBe(60);
  });

  it('运行中从 started_at 算到此刻', () => {
    expect(elapsedSeconds(run({}), at + 12_000)).toBe(12);
  });

  it('排队中没有 started_at，从 created_at 算「已等待」', () => {
    expect(
      elapsedSeconds(run({ status: 'queued', started_at: null }), at + 5_000),
    ).toBe(5);
  });
});

describe('fromStressRunCreate · 「重新发起」把 config 反解回表单', () => {
  /**
   * 一份**字段全给满**的配置：只有全给满，往返比较才谈得上"一一对应"
   * （缺省字段在表单里会落到默认值，见 fromStressRunCreate 的注释）。
   */
  const FULL_CONFIG = {
    name: 'nightly · 到达率 0.5',
    target: {
      base_url: 'http://10.0.0.9:8080',
      create_session_path: '/api/v1/sessions',
      create_run_path: '/api/v1/sessions/{session_id}/runs',
      run_events_path: '/api/v1/runs/{run_id}/events',
      cancel_run_path: '/api/v1/runs/{run_id}/cancel',
      resume_run_path: '/api/v1/runs/{run_id}/resume',
      delete_session_path: '/api/v1/sessions/{session_id}',
    },
    auth: { type: 'bearer' as const, token_env: 'MY_STRESS_TOKEN' },
    session: {
      agent_id: 'stock_research',
      turns: {
        mean: 3,
        stddev: 0,
        min: 2,
        max: 4,
        rounding: 'floor' as const,
      },
      think_time_ms: 800,
      on_turn_failure: 'continue' as const,
      on_hitl: 'auto_approve' as const,
      cleanup: 'delete' as const,
    },
    turn: {
      streaming: true,
      input_template: { text: '压测一下' },
      input_size_chars: 900,
    },
    load: { mode: 'session_rate' as const, session_rate: 0.5 },
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

  it('嵌套 → 摊平：turns / load / input_template / auth 都按表单形状拆开', () => {
    const values = fromStressRunCreate(FULL_CONFIG);

    expect(values.name).toBe('nightly · 到达率 0.5');
    expect(values.base_url).toBe('http://10.0.0.9:8080');
    expect(values.token_env).toBe('MY_STRESS_TOKEN');
    expect(values.agent_id).toBe('stock_research');
    // turns 拆成摊平字段
    expect(values.turns_mean).toBe(3);
    expect(values.turns_stddev).toBe(0);
    expect(values.turns_min).toBe(2);
    expect(values.turns_max).toBe(4);
    expect(values.turns_rounding).toBe('floor');
    // load 三选一：到达率分支只给 session_rate，另一个不给（否则表单会同时显示两个）
    expect(values.load_mode).toBe('session_rate');
    expect(values.session_rate).toBe(0.5);
    expect(values.concurrency).toBeUndefined();
    // 对象 → JSON 文本（TextArea 里必须是可读的 JSON，不是 [object Object]）
    expect(values.input_template).toContain('"压测一下"');
    expect(JSON.parse(values.input_template ?? '{}')).toEqual({
      text: '压测一下',
    });
    // 只读项恒为 true（后端强制）
    expect(values.streaming).toBe(true);
    expect(values.paths?.run_events_path).toBe('/api/v1/runs/{run_id}/events');
  });

  it('⚠️ 往返：再转回请求体必须与原配置一致（映射写反会在这里爆）', () => {
    // fromStressRunCreate 返回的键覆盖了 StressRunFormValues 的全部字段，
    // 所以可以直接当表单值喂回去（缺省项由 toStressRunCreate 的默认值补齐）。
    const roundTrip = toStressRunCreate(
      fromStressRunCreate(FULL_CONFIG) as StressRunFormValues,
    );
    expect(roundTrip).toEqual(FULL_CONFIG);
  });

  it('最小配置（只有必填）也能回填，缺省项落到与后端一致的默认值', () => {
    const values = fromStressRunCreate({
      target: { base_url: 'http://127.0.0.1:8080' },
      session: { agent_id: 'general', turns: { mean: 2, stddev: 0 } },
      load: { mode: 'concurrency', concurrency: 4 },
      duration_seconds: 30,
      request_timeout_ms: 60000,
      mock_model: {
        base_latency_ms: 100,
        ttft_ms: 200,
        output_tokens_min: 10,
        output_tokens_max: 20,
        tokens_per_second: 50,
      },
    });

    expect(values.turns_min).toBe(1);
    expect(values.turns_max).toBe(30);
    expect(values.turns_rounding).toBe('round');
    expect(values.think_time_ms).toBe(0);
    expect(values.on_turn_failure).toBe('abort');
    expect(values.on_hitl).toBe('abort');
    expect(values.cleanup).toBe('keep');
    expect(values.input_template).toBeUndefined();
    // 不设上限的那两个保持空 —— 不能凭空变成 12 / 某个数
    expect(values.total_sessions).toBeUndefined();
    expect(values.max_turns).toBeUndefined();
    expect(values.mock_model?.error_rate).toBe(0);
  });
});
