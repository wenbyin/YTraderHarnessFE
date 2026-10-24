// src/pages/retrieval_eval/components/AttemptLadder.test.tsx
//
// 多轮召回阶梯的读数回归测试。
//
// 这一层最容易犯的错不是"渲染崩了"，而是**把口径读错一个量级**：
// 第 2 轮的 Hit@K 是「上一轮漏网那批里又救回几成」（分母 22），
// 累计召回率才是「N 轮下来一共找到多少」（分母 84）。
// 所以这里同时钉住两个数 —— 谁把分母搞混，测试立刻红。
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EvalAttemptMetrics, EvalAttemptSpec, EvalMetrics } from '../data';
import AttemptLadder from './AttemptLadder';

/**
 * 造一轮指标。后端 `by_attempt["N"]` 就是一份完整的 `compute_metrics` 输出
 * 再加上 `cases` / `input_share`，所以计数字段一个都不能少。
 */
function round(
  cases: number,
  hitCount: number,
  rest: Partial<EvalAttemptMetrics> & { input_share: number },
): EvalAttemptMetrics {
  return {
    total_cases: cases,
    completed_cases: cases,
    failed_cases: 0,
    cases,
    hit_count: hitCount,
    miss_count: cases - hitCount,
    max_k: 10,
    ...rest,
  };
}

/** 三轮跑测：84 → 22 → 14，各轮新增 62 / 8 / 6，累加 = 顶层 76。 */
const THREE_ROUNDS: EvalMetrics = {
  total_cases: 84,
  completed_cases: 84,
  failed_cases: 0,
  hit_count: 76,
  miss_count: 8,
  hit_rate_at_1: 0.7262,
  hit_rate_at_5: 0.8571,
  hit_rate_at_k: 0.9048,
  mrr_at_k: 0.7963,
  hit_rate_curve: {
    '1': 0.5357,
    '5': 0.75,
    '10': 0.9048,
    '20': 0.9048,
    '50': 0.9048,
  },
  retrieved_max: 50,
  by_attempt: {
    '1': round(84, 62, {
      input_share: 1,
      hit_rate_at_1: 0.4524,
      hit_rate_at_5: 0.6429,
      hit_rate_at_k: 0.7381,
      mrr_at_k: 0.6131,
      p50_latency_ms: 214,
      p95_latency_ms: 683,
    }),
    '2': round(22, 8, {
      input_share: 0.261905,
      hit_rate_at_1: 0.1818,
      hit_rate_at_5: 0.2727,
      hit_rate_at_k: 0.3636,
      mrr_at_k: 0.2424,
      p50_latency_ms: 268,
      p95_latency_ms: 742,
    }),
    '3': round(14, 6, {
      input_share: 0.166667,
      hit_rate_at_1: 0.2143,
      hit_rate_at_5: 0.3571,
      hit_rate_at_k: 0.4286,
      mrr_at_k: 0.2857,
      p50_latency_ms: 7310,
      p95_latency_ms: 9480,
    }),
  },
  p50_latency_ms: 214,
  p95_latency_ms: 683,
  max_k: 10,
};

/** 单轮跑测：只取回 10 条 → 曲线的 20/50 两个点恒为 0（无意义）。 */
const ONE_ROUND: EvalMetrics = {
  total_cases: 84,
  completed_cases: 84,
  failed_cases: 0,
  hit_count: 71,
  miss_count: 13,
  hit_rate_at_1: 0.5833,
  hit_rate_at_5: 0.7381,
  hit_rate_at_k: 0.8452,
  mrr_at_k: 0.6804,
  hit_rate_curve: { '1': 0.4881, '5': 0.6905, '10': 0.8452, '20': 0, '50': 0 },
  retrieved_max: 10,
  by_attempt: {
    '1': round(84, 71, {
      input_share: 1,
      hit_rate_at_1: 0.5833,
      hit_rate_at_5: 0.7381,
      hit_rate_at_k: 0.8452,
      mrr_at_k: 0.6804,
      p50_latency_ms: 138,
      p95_latency_ms: 402,
    }),
  },
  p50_latency_ms: 138,
  p95_latency_ms: 402,
  max_k: 10,
};

describe('AttemptLadder · 逐轮表', () => {
  it('三轮各占一行，分母逐轮缩小（84 → 22 → 14）', () => {
    const { container } = render(<AttemptLadder metrics={THREE_ROUNDS} />);
    const text = container.textContent ?? '';

    expect(text).toContain('第 1 轮');
    expect(text).toContain('第 2 轮');
    expect(text).toContain('第 3 轮');

    // 每轮的实际 case 数就是分母，必须露出来
    expect(text).toContain('84');
    expect(text).toContain('22');
    expect(text).toContain('14');
    // 各轮新增命中
    expect(text).toContain('+62');
    expect(text).toContain('+8');
    expect(text).toContain('+6');
  });

  it('「本轮 Hit@K」与「累计召回率」两个口径同时存在且数值不同', () => {
    const { container } = render(<AttemptLadder metrics={THREE_ROUNDS} />);
    const text = container.textContent ?? '';

    // 本轮口径：第 2 轮在 22 条里命中 8 条 = 36.4%
    expect(text).toContain('36.4%');
    // 累计口径：2 轮共找到 70 / 84 = 83.3%
    expect(text).toContain('83.3%');

    // 3 轮累计 = 76 / 84
    expect(text).toContain('73.8%');
    expect(text).toContain('90.5%');

    // 若有人把「累计」错写成「本轮」，两者会相等 —— 这里明确要求不等
    expect(text).not.toContain('22.6%');
  });

  it('表头把「累计召回率」标出来，避免与本题命中率混淆', () => {
    const { container } = render(<AttemptLadder metrics={THREE_ROUNDS} />);
    const text = container.textContent ?? '';
    expect(text).toContain('累计召回率');
    expect(text).toContain('本轮 Hit@K');
    expect(text).toContain('输入 case（分母）');
  });

  it('没有 by_attempt（旧结果 / 单轮未记录）时给空态而不是空白', () => {
    const { container } = render(
      <AttemptLadder metrics={{ ...ONE_ROUND, by_attempt: {} }} />,
    );
    expect(container.textContent).toContain('没有逐轮指标');
  });

  it('单轮跑测只渲染一行', () => {
    const { container } = render(<AttemptLadder metrics={ONE_ROUND} />);
    const text = container.textContent ?? '';
    expect(text).toContain('第 1 轮');
    expect(text).not.toContain('第 2 轮');
  });
});

describe('AttemptLadder · 每轮的查询改写（2026-10-16 新增）', () => {
  /** 阶梯快照：前两轮改写、第 3 轮不改 —— 与后端内置阶梯一致。 */
  const LADDER: EvalAttemptSpec[] = [
    { name: 'round1', query_rewriter: { kind: 'common' } },
    { name: 'round2', query_rewriter: { kind: 'llm' } },
    { name: 'round3' },
  ];

  it('按轮次显示档位：日期展开 / 大模型改写 / 不改写', () => {
    const { container } = render(
      <AttemptLadder metrics={THREE_ROUNDS} attempts={LADDER} />,
    );
    // ⚠️ 用 `tr.ant-table-row`：antd 会在 tbody 里额外插一行隐藏的
    // `ant-table-measure-row`（量列宽用），按 `tr` 数会平白多一行。
    const rows = Array.from(
      container.querySelectorAll('tbody tr.ant-table-row'),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('日期展开');
    expect(rows[1].textContent).toContain('大模型改写');
    expect(rows[2].textContent).toContain('不改写');
  });

  it('多出一列「查询改写」，列数从 9 变 10', () => {
    const { container } = render(
      <AttemptLadder metrics={THREE_ROUNDS} attempts={LADDER} />,
    );
    const headers = Array.from(container.querySelectorAll('thead th')).map(
      (th) => (th.textContent ?? '').trim(),
    );
    expect(headers).toHaveLength(10);
    expect(headers[1]).toBe('查询改写');
  });

  it('快照里没有 attempts（旧结果）时显示「未记录」，不猜成「不改写」', () => {
    // ⚠️ 这两件事必须分开：「没记录」= 这份结果里没这个信息，「不改写」=
    // 跑了且明确没要求改写。混起来会把旧结果读成"当时没改写"，而它可能
    // 正好用的是 llm 改写。
    const { container } = render(<AttemptLadder metrics={ONE_ROUND} />);
    expect(container.textContent).toContain('未记录');
    expect(container.textContent).not.toContain('不改写');
  });

  it('快照里明确不写 rewrites 时显示「不改写」', () => {
    const { container } = render(
      <AttemptLadder metrics={ONE_ROUND} attempts={[{ name: 'round1' }]} />,
    );
    expect(container.textContent).toContain('不改写');
    expect(container.textContent).not.toContain('未记录');
  });

  it('快照轮数少于指标轮数时，多出来的那轮按「不改写」显示（不崩）', () => {
    const { container } = render(
      <AttemptLadder metrics={THREE_ROUNDS} attempts={[LADDER[0]]} />,
    );
    const rows = Array.from(
      container.querySelectorAll('tbody tr.ant-table-row'),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('日期展开');
    expect(rows[2].textContent).toContain('不改写');
  });
});

describe('AttemptLadder · 召回率曲线', () => {
  it('按 k 升序渲染 1/5/10/20/50 五个点', () => {
    const { container } = render(<AttemptLadder metrics={THREE_ROUNDS} />);
    const text = container.textContent ?? '';
    for (const k of [1, 5, 10, 20, 50]) {
      expect(text).toContain(`k = ${k}`);
    }
    expect(text).not.toContain('无意义');
  });

  it('k 超过 retrieved_max 的点被标成「无意义」而不是当成 0% 召回', () => {
    const { container } = render(<AttemptLadder metrics={ONE_ROUND} />);
    const text = container.textContent ?? '';

    // retrieved_max=10 → 20 与 50 两个点是"根本没取回来"。
    // 只数真标签（`.ant-tag`）：说明文案里也提到这个词，按全元素数会重复计。
    const marks = Array.from(container.querySelectorAll('.ant-tag')).filter(
      (el) => el.textContent === '无意义',
    );
    expect(marks).toHaveLength(2);
    expect(text).toContain('本次单条最多取回');
  });
});
