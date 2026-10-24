// src/pages/retrieval_eval/components/StageTraceTimeline.test.tsx
//
// trace 时间线的阶段顺序回归。
//
// 这是一条「时间线」，顺序错了比数字错了更误导：后端按 `stage_key` 字母序返回，
// 直接渲染会把流水线读成 cutter → filter → fusioner → … → reranker。
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CaseTraceStage } from '../data';
import StageTraceTimeline from './StageTraceTimeline';

const stage = (stage_key: string, source_key = ''): CaseTraceStage => ({
  stage_key,
  source_key,
  input_count: 10,
  output_count: 10,
  gold_present_before: true,
  gold_present_after: true,
  drop_reason: null,
  top_candidates: [],
});

/** 后端 `order_by stage_key` 的真实产物（字母序）。 */
const ALPHABETICAL: CaseTraceStage[] = [
  stage('cutter'),
  stage('filter'),
  stage('fusioner'),
  stage('recall'),
  stage('recall.dense_vector', 'dense_vector'),
  stage('recall.keyword', 'keyword'),
  stage('reranker'),
];

describe('StageTraceTimeline · 阶段顺序', () => {
  it('按真实执行顺序渲染，而不是后端给的字母序', () => {
    const { container } = render(
      <StageTraceTimeline stages={ALPHABETICAL} goldChunkIds={[]} />,
    );

    const titles = Array.from(
      container.querySelectorAll('.ant-card-head-title'),
    ).map((el) => el.textContent ?? '');

    expect(titles).toHaveLength(ALPHABETICAL.length);

    // 卡头里除 stage_key 外还有分支标签和判定语，所以按位置断言「包含」哪个 stage_key
    const expectedOrder = [
      'recall.dense_vector',
      'recall.keyword',
      'recall',
      'fusioner',
      'filter',
      'reranker',
      'cutter',
    ];
    expectedOrder.forEach((key, i) => {
      expect(titles[i]).toContain(key);
    });
  });

  it('空 stages 时给 Empty 而不是崩', () => {
    const { container } = render(
      <StageTraceTimeline stages={[]} goldChunkIds={[]} />,
    );
    expect(container.querySelector('.ant-empty')).not.toBeNull();
  });
});
