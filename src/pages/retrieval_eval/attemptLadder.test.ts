// src/pages/retrieval_eval/attemptLadder.test.ts
import { describe, expect, it } from 'vitest';
import {
  type AttemptRoundForm,
  attemptsToRounds,
  computeLadderSummary,
  curvePoints,
  DEFAULT_ATTEMPT_ROUNDS,
  defaultRounds,
  MAX_ATTEMPTS,
  rewriteByAttempt,
  rewriteKindOf,
  rewriteKindsDiffer,
  rewriteLabel,
  roundsToAttempts,
  roundToAttempt,
} from './attemptLadder';
import type { EvalMetrics } from './data';

describe('DEFAULT_ATTEMPT_ROUNDS', () => {
  it('复刻后端内置三档阶梯：召回/融合/裁剪逐轮放宽，只有第 3 轮开精排', () => {
    const [r1, r2, r3] = DEFAULT_ATTEMPT_ROUNDS;

    expect([r1.recall_top_k, r2.recall_top_k, r3.recall_top_k]).toEqual([
      200, 400, 500,
    ]);
    expect([r1.fusioner_top_k, r2.fusioner_top_k, r3.fusioner_top_k]).toEqual([
      50, 100, 200,
    ]);
    expect([r1.cutter_top_k, r2.cutter_top_k, r3.cutter_top_k]).toEqual([
      10, 20, 30,
    ]);

    expect(r1.override_reranker).toBe(false);
    expect(r2.override_reranker).toBe(false);
    expect(r3.override_reranker).toBe(true);
    expect(r3.reranker_top_n).toBe(10);
  });

  it('复刻后端新加的逐轮改写档：第 1 轮 common、第 2 轮 llm、第 3 轮不改写', () => {
    // ⚠️ 这三档必须与 `retrieval_eval.py` 的 DEFAULT_ATTEMPT_LADDER 一致。
    // 这里是**预填**值：对不上不会报错，只会让"我预填的和后端不传时跑的"
    // 悄悄是两套阶梯 —— 那种偏差无人能看出来。
    expect(DEFAULT_ATTEMPT_ROUNDS.map((r) => r.rewrite_kind)).toEqual([
      'common',
      'llm',
      'none',
    ]);
  });

  it('defaultRounds() 返回副本，改它不污染常量', () => {
    const copy = defaultRounds();
    copy[0].recall_top_k = 1;
    expect(DEFAULT_ATTEMPT_ROUNDS[0].recall_top_k).toBe(200);
  });
});

describe('roundToAttempt / roundsToAttempts', () => {
  it('把三个数映射到 recall_top_k 与 fusioner/cutter，且不带 filter/reranker', () => {
    const spec = roundToAttempt(defaultRounds()[0], 0);

    expect(spec.name).toBe('round1');
    expect(spec.recall_top_k).toBe(200);
    expect(spec.retrieve_processor?.fusioner).toEqual({ top_k: 50 });
    expect(spec.retrieve_processor?.cutter).toEqual({ top_k: 10 });
    // 未覆盖的整段必须**省略**（= 继承 DTD），不能发 false —— 语义不同
    expect(spec.retrieve_processor?.reranker).toBeUndefined();
    expect(spec.retrieve_processor?.filter).toBeUndefined();
  });

  it('第 3 轮的精排被写进 retrieve_processor', () => {
    const spec = roundToAttempt(defaultRounds()[2], 2);
    expect(spec.retrieve_processor?.reranker).toEqual({
      enabled: true,
      type: 'cross_encoder',
      top_n: 10,
    });
    expect(spec.retrieve_processor?.fusioner).toEqual({ top_k: 200 });
  });

  it('过滤三态：默认不发 / 按阈值发分数 / 关闭只发 enabled:false', () => {
    const base = defaultRounds()[0];

    // 默认 = 不覆盖：整段不发（后端默认 enabled=true、不设阈值）
    expect(
      roundToAttempt({ ...base, filter_mode: 'inherit' }, 0).retrieve_processor
        ?.filter,
    ).toBeUndefined();

    // 按阈值：发 enabled + 阈值
    expect(
      roundToAttempt({ ...base, filter_mode: 'on', score_threshold: 0.45 }, 0)
        .retrieve_processor?.filter,
    ).toEqual({ enabled: true, score_threshold: 0.45 });

    // 关闭：只发 enabled:false —— 阈值此时没有意义，别把它一起发出去
    // （快照按 exclude_unset 存，多一个数就会让人以为"关闭但阈值 0.45"是个状态）
    expect(
      roundToAttempt({ ...base, filter_mode: 'off', score_threshold: 0.45 }, 0)
        .retrieve_processor?.filter,
    ).toEqual({ enabled: false });
  });

  it('没名字时回落到 roundN', () => {
    const round = { ...defaultRounds()[0], name: '   ' };
    expect(roundToAttempt(round, 1).name).toBe('round2');
  });

  it('去掉尾部的空轮次，最多 3 轮', () => {
    const empty: AttemptRoundForm = {
      name: 'x',
      recall_top_k: undefined as unknown as number,
      fusioner_top_k: undefined as unknown as number,
      cutter_top_k: undefined as unknown as number,
      override_reranker: false,
      reranker_type: 'cross_encoder',
      reranker_top_n: 10,
      filter_mode: 'inherit',
      score_threshold: 0.3,
      rewrite_kind: 'none',
    };

    expect(roundsToAttempts([defaultRounds()[0], empty, empty])).toHaveLength(
      1,
    );
    expect(
      roundsToAttempts([...defaultRounds(), ...defaultRounds()]),
    ).toHaveLength(MAX_ATTEMPTS);
  });

  it('发了改写器的一轮**不算**空壳（只配了改写也要留下）', () => {
    const onlyRewrite: AttemptRoundForm = {
      name: 'rewrite-only',
      recall_top_k: undefined as unknown as number,
      fusioner_top_k: undefined as unknown as number,
      cutter_top_k: undefined as unknown as number,
      override_reranker: false,
      reranker_type: 'cross_encoder',
      reranker_top_n: 10,
      filter_mode: 'inherit',
      score_threshold: 0.3,
      rewrite_kind: 'llm',
    };

    const kept = roundsToAttempts([onlyRewrite]);
    expect(kept).toHaveLength(1);
    expect(kept[0].query_rewriter).toEqual({ kind: 'llm' });
  });
});

describe('query_rewriter 映射（2026-10-16 后端新增）', () => {
  it('非 none 的档位下发 `{ enabled: true, kind }`，且**与 retrieve_processor 并列**', () => {
    const spec = roundToAttempt(
      { ...defaultRounds()[0], rewrite_kind: 'llm' },
      0,
    );
    expect(spec.query_rewriter).toEqual({ kind: 'llm' });
    // 它不是 processor 里的第五段 —— 那一层没有改写的位置
    expect(Object.keys(spec.retrieve_processor ?? {})).not.toContain(
      'query_rewriter',
    );
  });

  it('`none` 时**整个字段省略**（不传 = 不改写），不发 enabled:false 那种噪声', () => {
    const spec = roundToAttempt(
      { ...defaultRounds()[2], rewrite_kind: 'none' },
      2,
    );
    expect(spec.query_rewriter).toBeUndefined();
    expect('query_rewriter' in spec).toBe(false);
  });

  it('rewriteKindOf：不传 / kind 为 null / enabled:false 一律读成「不改写」', () => {
    expect(rewriteKindOf(undefined)).toBe('none');
    expect(rewriteKindOf(null)).toBe('none');
    expect(rewriteKindOf({})).toBe('none');
    expect(rewriteKindOf({ kind: null })).toBe('none');
    expect(rewriteKindOf({ kind: 'common' })).toBe('common');
    expect(rewriteKindOf({ enabled: true, kind: 'llm' })).toBe('llm');
    expect(rewriteKindOf({ enabled: false, kind: 'llm' })).toBe('none');
  });

  it('回填时**不**用表单默认档兜底 —— 否则再提交一次会悄悄给第 3 轮加上改写', () => {
    const back = attemptsToRounds(roundsToAttempts(DEFAULT_ATTEMPT_ROUNDS));
    expect(back.map((r) => r.rewrite_kind)).toEqual(['common', 'llm', 'none']);
    // 第 3 轮快照里没有 query_rewriter → 必须回到 none，而不是默认的 common
    expect(back[2].rewrite_kind).not.toBe(
      DEFAULT_ATTEMPT_ROUNDS[0].rewrite_kind,
    );
  });

  it('rewriteByAttempt：按轮次号给出档位（详情页的阶梯表按它取）', () => {
    const map = rewriteByAttempt([
      { name: 'r1', query_rewriter: { kind: 'common' } },
      { name: 'r2', query_rewriter: { kind: 'llm' } },
      { name: 'r3' },
    ]);
    expect(map).toEqual({ 1: 'common', 2: 'llm', 3: 'none' });
    expect(rewriteByAttempt(undefined)).toEqual({});
  });

  it('rewriteKindsDiffer：逐轮换了改写器才提示（全同 = 增量干净，不提示）', () => {
    expect(rewriteKindsDiffer(DEFAULT_ATTEMPT_ROUNDS)).toBe(true);
    expect(
      rewriteKindsDiffer([
        { ...defaultRounds()[0], rewrite_kind: 'llm' },
        { ...defaultRounds()[1], rewrite_kind: 'llm' },
      ]),
    ).toBe(false);
    expect(
      rewriteKindsDiffer([
        { ...defaultRounds()[0], rewrite_kind: 'none' },
        { ...defaultRounds()[1], rewrite_kind: 'none' },
      ]),
    ).toBe(false);
  });

  it('rewriteLabel：档位 → 短文案', () => {
    expect(rewriteLabel('common')).toBe('日期展开');
    expect(rewriteLabel('llm')).toBe('大模型改写');
    expect(rewriteLabel('none')).toBe('不改写');
    expect(rewriteLabel(null)).toBe('不改写');
    expect(rewriteLabel(undefined)).toBe('不改写');
  });
});

describe('attemptsToRounds', () => {
  it('默认阶梯往返不变', () => {
    const specs = roundsToAttempts(DEFAULT_ATTEMPT_ROUNDS);
    const back = attemptsToRounds(specs);

    expect(back.map((r) => r.recall_top_k)).toEqual([200, 400, 500]);
    expect(back.map((r) => r.fusioner_top_k)).toEqual([50, 100, 200]);
    expect(back.map((r) => r.cutter_top_k)).toEqual([10, 20, 30]);
    expect(back.map((r) => r.override_reranker)).toEqual([false, false, true]);
    // 默认阶梯三轮都没覆盖过滤
    expect(back.map((r) => r.filter_mode)).toEqual([
      'inherit',
      'inherit',
      'inherit',
    ]);
  });

  it('⭐ 过滤三态往返：`enabled:false` 回填成「关闭」，不能塌回「默认」', () => {
    // 塌回去的后果很实际：用户看到的是一份"没动过过滤"的表单，
    // 再点提交就悄悄把"这一轮不过滤"改成了"用默认过滤"，消融实验的结论直接反了。
    const back = attemptsToRounds([
      { name: 'r1', retrieve_processor: { filter: { enabled: false } } },
      {
        name: 'r2',
        retrieve_processor: {
          filter: { enabled: true, score_threshold: 0.42 },
        },
      },
      { name: 'r3' },
    ]);
    expect(back.map((r) => r.filter_mode)).toEqual(['off', 'on', 'inherit']);
    expect(back[1].score_threshold).toBe(0.42);
  });

  it('没有 attempts 时给默认阶梯（表单要能渲染）', () => {
    expect(attemptsToRounds(undefined)).toHaveLength(3);
    expect(attemptsToRounds(null)[0].recall_top_k).toBe(200);
    expect(attemptsToRounds([])[0].recall_top_k).toBe(200);
  });

  it('只传一轮时只回填一轮', () => {
    const rounds = attemptsToRounds([{ name: 'only', recall_top_k: 300 }]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].name).toBe('only');
    expect(rounds[0].recall_top_k).toBe(300);
    // 没给的段用默认值兜底，避免表单出现 undefined
    expect(rounds[0].fusioner_top_k).toBe(50);
  });
});

describe('computeLadderSummary', () => {
  const metrics = {
    total_cases: 40,
    by_attempt: {
      '1': {
        cases: 40,
        input_share: 1,
        hit_count: 15,
        hit_rate_at_1: 0.2,
        hit_rate_at_5: 0.3,
        hit_rate_at_k: 0.375,
        mrr_at_k: 0.25,
        p95_latency_ms: 400,
      },
      '2': {
        cases: 25,
        input_share: 0.625,
        hit_count: 5,
        hit_rate_at_1: 0.12,
        hit_rate_at_5: 0.16,
        hit_rate_at_k: 0.2,
        mrr_at_k: 0.14,
        p95_latency_ms: 650,
      },
      '3': {
        cases: 20,
        input_share: 0.5,
        hit_count: 4,
        hit_rate_at_1: 0.1,
        hit_rate_at_5: 0.15,
        hit_rate_at_k: 0.2,
        mrr_at_k: 0.12,
        p95_latency_ms: 900,
      },
    },
  } as unknown as Pick<EvalMetrics, 'by_attempt' | 'total_cases'>;

  it('逐轮行按轮次号升序，带上各轮分母', () => {
    const rows = computeLadderSummary(metrics);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.cases)).toEqual([40, 25, 20]);
    expect(rows.map((r) => r.inputShare)).toEqual([1, 0.625, 0.5]);
  });

  it('累计召回率用全体 case 当分母 —— 「2 轮找到」= 20/40 而不是 5/25', () => {
    const rows = computeLadderSummary(metrics);
    expect(rows.map((r) => r.hitCount)).toEqual([15, 5, 4]);
    expect(rows.map((r) => r.cumulativeHitCount)).toEqual([15, 20, 24]);
    expect(rows.map((r) => r.cumulativeRate)).toEqual([0.375, 0.5, 0.6]);

    // 本轮口径仍然是缩小后的分母
    expect(rows[1].hitRateAtK).toBe(0.2);
  });

  it('total_cases 为 0 时不除零，累计率给 null', () => {
    const rows = computeLadderSummary({
      total_cases: 0,
      by_attempt: { '1': { cases: 0, hit_count: 0, input_share: null } },
    } as unknown as Pick<EvalMetrics, 'by_attempt' | 'total_cases'>);
    expect(rows[0].cumulativeRate).toBeNull();
    expect(rows[0].inputShare).toBeNull();
  });

  it('by_attempt 缺失或为空时返回空数组', () => {
    expect(computeLadderSummary(undefined)).toEqual([]);
    expect(computeLadderSummary({ total_cases: 10, by_attempt: {} })).toEqual(
      [],
    );
  });

  it('input_share 缺失时用 cases / total_cases 兜底', () => {
    const rows = computeLadderSummary({
      total_cases: 80,
      by_attempt: { '1': { cases: 20, hit_count: 5 } },
    } as unknown as Pick<EvalMetrics, 'by_attempt' | 'total_cases'>);
    expect(rows[0].inputShare).toBe(0.25);
  });
});

describe('curvePoints', () => {
  it('按数值排序（不是「1,10,20,5,50」的字母序）', () => {
    const points = curvePoints({
      hit_rate_curve: {
        '50': 0.7,
        '1': 0.05,
        '10': 0.375,
        '5': 0.2,
        '20': 0.5,
      },
      retrieved_max: 50,
    });
    expect(points.map((p) => p.k)).toEqual([1, 5, 10, 20, 50]);
  });

  it('k 超过 retrieved_max 的点标为无意义', () => {
    const points = curvePoints({
      hit_rate_curve: { '1': 0.05, '10': 0.375, '50': 0 },
      retrieved_max: 10,
    });
    expect(points.find((p) => p.k === 10)?.meaningless).toBe(false);
    expect(points.find((p) => p.k === 50)?.meaningless).toBe(true);
  });

  it('retrieved_max 为 null 时不臆断无意义', () => {
    const points = curvePoints({
      hit_rate_curve: { '50': 0.1 },
      retrieved_max: null,
    });
    expect(points[0].meaningless).toBe(false);
  });

  it('没有曲线时回落到后端固定取的 5 个 k', () => {
    expect(curvePoints(undefined).map((p) => p.k)).toEqual([1, 5, 10, 20, 50]);
  });
});
