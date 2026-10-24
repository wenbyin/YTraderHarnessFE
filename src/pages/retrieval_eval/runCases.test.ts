// src/pages/retrieval_eval/runCases.test.ts
//
// 「代表行」规则必须与后端 `collapse_by_case` / `_better()` **逐位一致**。
// 各写一套的代价很具体：同一次评测在三个页面上给出三种「这条 case 的结果」，
// 而且三处单看都说得通，排查时无从下手。
//
// 起因：旧后端按「结果行」分页，一条 case 返回 2~3 行（逐轮放宽，一轮一行），
// 列表里同一道题重复出现且其中两行整行是空的。这里折叠用的键就是后端那一份。

import { describe, expect, it } from 'vitest';
import type { EvalRunCase } from './data';
import {
  dedupeByCase,
  pickRepresentative,
  representativeKey,
} from './runCases';

function row(
  over: Partial<EvalRunCase> & { eval_case_id: string },
): EvalRunCase {
  return {
    question: 'q',
    chunk_id: 'c',
    document_type_definition_id: 'd',
    status: 'completed',
    attempt_no: 1,
    gold_hit: false,
    gold_rank: null,
    gold_chunk_ids: [],
    retrieved_chunk_ids: [],
    ...over,
  };
}

describe('representativeKey · 与后端 _better() 同一条', () => {
  it('命中(2) > 没命中(1) > 执行失败(0)', () => {
    const hit = representativeKey(
      row({ eval_case_id: 'a', gold_hit: true, gold_rank: 30, attempt_no: 3 }),
    );
    const miss = representativeKey(
      row({ eval_case_id: 'a', gold_hit: false, attempt_no: 1 }),
    );
    // gold_hit=null 是「检索执行失败」，**不属于**未命中
    const failed = representativeKey(
      row({ eval_case_id: 'a', gold_hit: null, attempt_no: 1 }),
    );

    expect(hit[0]).toBe(2);
    expect(miss[0]).toBe(1);
    expect(failed[0]).toBe(0);
  });

  it('同为未命中：轮次更晚的更代表（决定权在最后一位，否则取哪行看库的顺序）', () => {
    const r1 = representativeKey(
      row({ eval_case_id: 'a', gold_hit: false, attempt_no: 1 }),
    );
    const r3 = representativeKey(
      row({ eval_case_id: 'a', gold_hit: false, attempt_no: 3 }),
    );
    expect(r3[2]).toBeGreaterThan(r1[2]);
  });

  it('同为命中：名次小的更好（第 2 位取负，越大越小）', () => {
    const k3 = representativeKey(
      row({ eval_case_id: 'a', gold_hit: true, gold_rank: 3 }),
    );
    const k12 = representativeKey(
      row({ eval_case_id: 'a', gold_hit: true, gold_rank: 12 }),
    );
    expect(k3[1]).toBeGreaterThan(k12[1]);
  });

  it('gold_rank=null 与 0 都算「没名次」→ 键值 0；有名次的一律为负', () => {
    // ⚠️ 这里锁的是后端 `-(item.gold_rank or 0)` 的**原样**行为：键越大越
    // 优先，于是「没名次」(0) 在数值上排在「有名次」(-rank) 之前 ——
    // 与后端那句注释「None 排在最后」正好相反。
    //
    // 不去"修"它，因为取不到这种组合：tier=2（命中）的行必定带名次；
    // 真正没名次的是 tier=1（未命中），它们两两都是 0，改由末位轮次定序。
    // 前端这份规则的全部价值在于与后端逐位一致，一旦在这里"顺手改对"，
    // 两边就会在那组输入上给出不同的代表行。
    const none = representativeKey(
      row({ eval_case_id: 'a', gold_hit: true, gold_rank: null }),
    );
    const zero = representativeKey(
      row({ eval_case_id: 'a', gold_hit: true, gold_rank: 0 }),
    );
    const five = representativeKey(
      row({ eval_case_id: 'a', gold_hit: true, gold_rank: 5 }),
    );

    expect(none[1]).toBe(0);
    expect(zero[1]).toBe(0);
    expect(five[1]).toBe(-5);
  });
});

describe('pickRepresentative', () => {
  it('命中优先于名次：第 3 轮命中(#30) 打败第 1 轮 未命中', () => {
    const best = pickRepresentative([
      row({ eval_case_id: 'a', gold_hit: false, attempt_no: 1 }),
      row({ eval_case_id: 'a', gold_hit: true, gold_rank: 30, attempt_no: 3 }),
      row({ eval_case_id: 'a', gold_hit: false, attempt_no: 2 }),
    ]);
    expect(best?.gold_hit).toBe(true);
    expect(best?.attempt_no).toBe(3);
  });

  it('空列表返回 null，不编一行出来', () => {
    expect(pickRepresentative([])).toBeNull();
  });
});

describe('dedupeByCase', () => {
  it('一条 case 一行，且保留首次出现的位置（服务端已按 DTD/源 chunk/题号排好）', () => {
    const { rows, collapsed } = dedupeByCase([
      row({ eval_case_id: 'case-1', gold_hit: false, attempt_no: 1 }),
      row({
        eval_case_id: 'case-2',
        gold_hit: true,
        gold_rank: 4,
        attempt_no: 1,
      }),
      row({
        eval_case_id: 'case-1',
        gold_hit: true,
        gold_rank: 9,
        attempt_no: 3,
      }),
      row({ eval_case_id: 'case-2', gold_hit: false, attempt_no: 2 }),
    ]);

    expect(rows.map((r) => r.eval_case_id)).toEqual(['case-1', 'case-2']);
    expect(rows[0].gold_hit).toBe(true);
    expect(rows[0].attempt_no).toBe(3);
    expect(rows[1].gold_rank).toBe(4);
    expect(collapsed).toBe(2);
  });

  it('后端已是新契约时是恒等变换（同一批对象、同一顺序、collapsed=0）', () => {
    const items = [
      row({ eval_case_id: 'case-1' }),
      row({ eval_case_id: 'case-2' }),
    ];
    const { rows, collapsed } = dedupeByCase(items);
    expect(rows).toEqual(items);
    expect(collapsed).toBe(0);
  });
});
