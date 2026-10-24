// src/pages/retrieval_eval/stageOrder.test.ts
//
// 阶段展示顺序的回归测试。
//
// 背景：后端是按 `stage_key` **字母序**返回的（repository 里 order_by stage_key），
// 页面若原样渲染，流水线会被读成 cutter → filter → fusioner → … → reranker。
// 曾有人据此以为真实执行顺序是「cutter → filter → fusioner」。
// 这个文件把「真实执行顺序」钉死。
import { describe, expect, it } from 'vitest';
import {
  QUERY_PROCESSOR_ORDER,
  sortStagesByExecution,
  stageRank,
} from './stageOrder';

const s = (stage_key: string, source_key = '') => ({ stage_key, source_key });

describe('stageRank', () => {
  it('执行顺序：召回分支 < 合成 recall < fusioner < filter < reranker < cutter', () => {
    const order = [
      'recall.dense_vector',
      'recall',
      'fusioner',
      'filter',
      'reranker',
      'cutter',
    ];
    const ranks = order.map(stageRank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  it('认不出的 stage_key 排到最后，不插队', () => {
    expect(stageRank('some_new_stage')).toBeGreaterThan(stageRank('cutter'));
  });
});

describe('sortStagesByExecution', () => {
  it('把后端给的字母序改写成真实执行顺序', () => {
    // 后端 order_by stage_key 的真实产物
    const fromBackend = [
      s('cutter'),
      s('filter'),
      s('fusioner'),
      s('recall'),
      s('recall.dense_vector', 'dense_vector'),
      s('recall.keyword', 'keyword'),
      s('reranker'),
    ];

    expect(sortStagesByExecution(fromBackend).map((x) => x.stage_key)).toEqual([
      'recall.dense_vector',
      'recall.keyword',
      'recall',
      'fusioner',
      'filter',
      'reranker',
      'cutter',
    ]);
  });

  it('合成 recall（全路都没召回到）排在召回分支之后 —— 它要等所有路跑完才能判', () => {
    const out = sortStagesByExecution([
      s('recall'),
      s('recall.keyword', 'keyword'),
    ]);
    expect(out.map((x) => x.stage_key)).toEqual(['recall.keyword', 'recall']);
  });

  it('同组内保持后端给的相对顺序（稳定排序），不额外按字母重排', () => {
    const out = sortStagesByExecution([
      s('recall.keyword', 'keyword'),
      s('recall.dense_vector', 'dense_vector'),
    ]);
    expect(out.map((x) => x.source_key)).toEqual(['keyword', 'dense_vector']);
  });

  it('不改动入参（返回新数组）', () => {
    const input = [s('cutter'), s('fusioner')];
    const out = sortStagesByExecution(input);
    expect(input.map((x) => x.stage_key)).toEqual(['cutter', 'fusioner']);
    expect(out).not.toBe(input);
  });

  it('空 / null 输入返回空数组（不抛）', () => {
    expect(sortStagesByExecution([])).toEqual([]);
    expect(sortStagesByExecution(undefined)).toEqual([]);
    expect(sortStagesByExecution(null)).toEqual([]);
  });
});

describe('QUERY_PROCESSOR_ORDER', () => {
  it('就是「发起跑测」抽屉里四张覆盖卡片的顺序，且与 stageRank 一致', () => {
    expect([...QUERY_PROCESSOR_ORDER]).toEqual([
      'fusioner',
      'filter',
      'reranker',
      'cutter',
    ]);
    const ranks = QUERY_PROCESSOR_ORDER.map(stageRank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });
});
