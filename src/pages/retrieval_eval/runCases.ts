// src/pages/retrieval_eval/runCases.ts
// 逐题结果的「代表行」规则 —— 与后端 `collapse_by_case` 同一条。
//
// 为什么前端还要有一份
// --------------------
// 后端 `GET /runs/{id}/cases` 的契约是**一条 case 一行**（代表行：命中优先、
// 再比名次），折叠在服务端做。但这条契约是后加的：旧版后端按「结果行」分页，
// 一条 case 会出现 2~3 次（逐轮放宽，一轮一行），而响应里没有轮次字段能把
// 它们分开 —— 前端看到的就是几条一模一样的行，`total` 也是行数。
//
// 用户撞到的正是这个：页面上同一道题重复三遍、其中两行整行是空的。
// 所以这里留一份**防御性**折叠：后端已经是新契约时它是恒等变换（零副作用），
// 后端是旧版时至少让页面可读，并由页面显式提示「你这边的后端还没重启」。
//
// ⚠️ 规则必须与后端一致，不能各写一套
// ----------------------------------
// `app/services/document/application/retrieval_eval_evaluation.py` 里
// `_better()` 的排序键是：
//
//     (tier, -(gold_rank or 0), attempt_no)
//
//   tier：命中(2) > 没命中(1) > 执行失败(0)
//   -(gold_rank or 0)：名次越小越好；没名次的算 0（同一 tier 里排最后）
//   attempt_no：**取更晚的一轮** —— 三轮都没命中的 case 两两同级，不加这
//               一位就取决于数据库返回顺序，同一份数据两次查询会给出不同
//               的代表行（乃至不同的 latency 分位）
//
// 取键值**最大**的那一行。

import type { EvalRunCase } from './data';

/** 与后端 `_better()` 等价的排序键；越大越能代表这条 case 的最终结果。 */
export function representativeKey(r: EvalRunCase): [number, number, number] {
  // 三值语义：gold_hit=null 是「检索执行失败」，既不属于命中也不属于未命中。
  // 用 `=== true/false` 而不是真值判断，否则 null 会被并进「未命中」。
  const tier = r.gold_hit === true ? 2 : r.gold_hit === false ? 1 : 0;
  // 名次越小越好 → 取负。没有名次（null/0）统一落在 0，与后端
  // `-(item.gold_rank or 0)` 等价；写成 `rank > 0 ? -rank : 0` 是为了不留
  // 一个 `-0` 在键里（比较上等价，但读的人会以为这里有符号语义）。
  const rank = r.gold_rank ?? 0;
  return [tier, rank > 0 ? -rank : 0, r.attempt_no ?? 0];
}

function isBetter(a: EvalRunCase, b: EvalRunCase): boolean {
  const ka = representativeKey(a);
  const kb = representativeKey(b);
  for (let i = 0; i < 3; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] > kb[i];
  }
  return false;
}

/** 同一条 case 的多行里挑出代表行（`rows` 为空时返回 null）。 */
export function pickRepresentative(rows: EvalRunCase[]): EvalRunCase | null {
  let best: EvalRunCase | null = null;
  for (const r of rows) {
    if (best === null || isBetter(r, best)) best = r;
  }
  return best;
}

export interface DedupeResult {
  /**
   * 折叠后的行。后端已是新契约时与入参**逐项相同**（含顺序），
   * 所以调用方可以无条件用它的返回值。
   */
  rows: EvalRunCase[];
  /** 折叠掉的行数。> 0 说明后端还是「一轮一行」的旧行为。 */
  collapsed: number;
}

/**
 * 按 `eval_case_id` 折叠，输出顺序取每一条 case **首次出现**的位置
 * （服务端已按 DTD / 源 chunk / 题号排好，这里不能打乱）。
 */
export function dedupeByCase(items: EvalRunCase[]): DedupeResult {
  const byCase = new Map<string, EvalRunCase[]>();
  const order: string[] = [];

  for (const r of items) {
    const key = r.eval_case_id;
    const bucket = byCase.get(key);
    if (bucket) {
      bucket.push(r);
    } else {
      byCase.set(key, [r]);
      order.push(key);
    }
  }

  const rows: EvalRunCase[] = [];
  let collapsed = 0;

  for (const key of order) {
    const bucket = byCase.get(key) ?? [];
    const best = pickRepresentative(bucket);
    if (best) rows.push(best);
    collapsed += Math.max(0, bucket.length - 1);
  }

  return { rows, collapsed };
}
