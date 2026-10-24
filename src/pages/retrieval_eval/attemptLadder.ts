// src/pages/retrieval_eval/attemptLadder.ts
// 多轮召回阶梯：表单 ↔ 契约的映射，以及逐轮指标的读法。
//
// 后端契约（`retrieval_eval.py` + `retrieval_eval_evaluation.py`）：
//   - `CreateEvalRunRequest.attempts`：最多 3 轮；不传 = 内置三档阶梯；
//   - 第 N 轮**只跑第 N-1 轮没命中的 case** —— 每轮分母不同；
//   - `metrics.by_attempt["N"]` = 那一轮的完整指标 + `cases` / `input_share`；
//   - 顶层 `metrics` 是**按 case 折叠**（每条取最好的一轮）后的最终口径；
//   - `EvalAttemptSpec.query_rewriter`（2026-10-16 新增）：这一轮**查什么**。
//     与另外两项的分工是 `recall_top_k` 管召回多少、`retrieve_processor` 管
//     召回之后怎么处理、它管**改写**（发生在召回之前）。**不传 = 不改写**，
//     且**没有**「继承 DTD」的回落（见 data.d.ts 的 QueryRewriterConfig）。
//
// 这里只放纯粹的换算与聚合，不放 React —— 好单测。

import type {
  EvalAttemptSpec,
  EvalMetrics,
  QueryProcessorOverride,
  QueryRewriterConfig,
  QueryRewriterKind,
  RerankerConfig,
} from './data';

type RerankerType = NonNullable<RerankerConfig['type']>;

/**
 * 一轮的改写选择 =**三态**（不是两态）。
 *
 * `none` 必须和「有改写器但没改动」分开：契约里「不传 = 不改写」，而
 * `kind` 恰好也只能是 `common` / `llm` —— 所以三态正好一一对应，不需要
 * 再引一个 `enabled: false` 的第四态（那只是同一个意思的另一种写法）。
 */
export type RewriteKind = 'none' | QueryRewriterKind;

/**
 * 一轮的过滤选择 = **三态**（不是「要不要覆盖」+「覆盖后开不开」两个开关）。
 *
 * 为什么必须并成一个：`filter` 这一段**没有 DTD 级配置**（后端
 * `FilterConfig` 的 docstring 明写"过滤能力本身没有 DTD 级配置，
 * 默认值由 RetrieveProcessor 的类默认值给出"：enabled=true、threshold=None）。
 * 于是「不覆盖」与「覆盖 + 启用」在默认阈值下结果完全一样 —— 两个开关并排
 * 摆着、又都默认打开，看的人只会问"这俩不是一件事吗"。
 *
 * 真正有意义的只有三种状态，一一对应三态：
 *   inherit → 不发 `filter` 段，用后端默认（启用、不设阈值）
 *   on      → 发 `{ enabled: true, score_threshold }`
 *   off     → 发 `{ enabled: false }`（这一轮跳过过滤，用来做消融）
 */
export type FilterMode = 'inherit' | 'on' | 'off';

/**
 * 表单里一轮的字段。
 *
 * 三个数（召回 / 融合 / 裁剪）就是内置阶梯之间**唯一**的差别，所以平铺出来；
 * 精排整段是否覆盖用开关表达 —— 因为契约里「未出现的段 = 继承该 DTD
 * 的生效配置」，而不是「关闭」。把这两种语义混成一个开关会静默改错配置。
 * 过滤这边不是"开/关"两态，见 `FilterMode`。
 */
export interface AttemptRoundForm {
  name: string;
  /** 每一路召回多少条 */
  recall_top_k: number;
  /** 融合后保留多少条 */
  fusioner_top_k: number;
  /** 最终保留多少条（命中判定的截断位置） */
  cutter_top_k: number;
  /** 是否覆盖精排段（关 = 继承该 DTD 的精排配置） */
  override_reranker: boolean;
  reranker_type: RerankerType;
  reranker_top_n: number;
  /** 过滤这一段怎么取值 —— 三态，别拆回两个开关（见 FilterMode） */
  filter_mode: FilterMode;
  score_threshold: number;
  /**
   * 这一轮的查询改写。
   *
   * ⚠️ 它**不是**「覆盖 / 继承」里的一个 —— 这一层没有 DTD 回落，
   * `'none'` 的含义就是**不改写**（见 data.d.ts 的 `QueryRewriterConfig`）。
   */
  rewrite_kind: RewriteKind;
}

/** 最多几轮 —— 与后端 `attempts` 的 `max_length=3` 对齐。 */
export const MAX_ATTEMPTS = 3;

/**
 * 内置三档阶梯的**前端副本**（`DEFAULT_ATTEMPT_LADDER`）。
 *
 * 它只用于**表单预填**。不传 `attempts` 时后端用自己那份，所以这里改了
 * 不会静默改变「不配置」的语义 —— 但预填值会变，于是改了要同步更新注释。
 *
 * 三档是按实测失败分布定标的：
 *   21 条死于 fusioner top_k=50（进融合时金标平均排 65.5）
 *   39 条死于 cutter top_k=10（进 cutter 时金标平均排 14.3）
 *   15 条两路都没碰到
 * 所以每档都瞄准上一档暴露的缺口；第 3 轮**才开精排**（贵，只让前两轮都没
 * 找到的那批去付）。
 *
 * ⚠️ 查询改写是**逐轮换档**的（2026-10-16 后端新增），这不是随手配的：
 *   第 1 轮 `common`  —— 只展开日期的两种写法，**不调模型所以免费**，
 *                       拿它当"白送的基线"；
 *   第 2 轮 `llm`     —— 换一种说法再查一次（顺带把公司名这个**错锚**
 *                       去掉），这是"换说法"最便宜的实现；
 *   第 3 轮 **不改**   —— 第 3 轮要读的是**精排的增量**，而它的输入已经
 *                       是前两轮都没找到的最难那批，凭改写救回来的希望
 *                       最小。代价是 `round3 - round2` 里混着"少了一次
 *                       改写"的损失 —— 要干净的精排 delta 就得给第 3 轮
 *                       也配同一个改写器。
 */
export const DEFAULT_ATTEMPT_ROUNDS: AttemptRoundForm[] = [
  {
    name: 'round1',
    recall_top_k: 200,
    fusioner_top_k: 50,
    cutter_top_k: 10,
    override_reranker: false,
    reranker_type: 'cross_encoder',
    reranker_top_n: 10,
    filter_mode: 'inherit',
    score_threshold: 0.3,
    rewrite_kind: 'common',
  },
  {
    name: 'round2',
    recall_top_k: 400,
    fusioner_top_k: 100,
    cutter_top_k: 20,
    override_reranker: false,
    reranker_type: 'cross_encoder',
    reranker_top_n: 10,
    filter_mode: 'inherit',
    score_threshold: 0.3,
    rewrite_kind: 'llm',
  },
  {
    name: 'round3',
    recall_top_k: 500,
    fusioner_top_k: 200,
    cutter_top_k: 30,
    override_reranker: true,
    reranker_type: 'cross_encoder',
    reranker_top_n: 10,
    filter_mode: 'inherit',
    score_threshold: 0.3,
    rewrite_kind: 'none',
  },
];

/** 深拷贝一份默认阶梯 —— 表单要用，不能把常量数组交给 antd 改。 */
export function defaultRounds(): AttemptRoundForm[] {
  return DEFAULT_ATTEMPT_ROUNDS.map((r) => ({ ...r }));
}

/**
 * 改写档位的文案 —— 抽屉里的下拉、详情页的阶梯表共用同一份。
 *
 * `none` 的文案是「不改写」而不是「继承 DTD」：这一层**没有**回落，
 * 写成「继承」会让人以为改不改由文档类型决定（见 data.d.ts）。
 */
export const REWRITE_OPTIONS: { value: RewriteKind; label: string }[] = [
  { value: 'none', label: '不改写' },
  { value: 'common', label: 'common · 日期展开' },
  { value: 'llm', label: 'llm · 大模型改写' },
];

/**
 * 过滤三态的文案。
 *
 * ⚠️ `inherit` 的文案是「默认」而**不是**「启用」：后端默认就是 enabled=true、
 * 只是不设阈值（`FilterConfig`），写成「启用」会和「按阈值」撞成一个意思 ——
 * 而这两个开关并排摆着的年代，用户问的第一句就是"这不重复了吗"。
 */
export const FILTER_MODE_OPTIONS: { value: FilterMode; label: string }[] = [
  { value: 'inherit', label: '默认' },
  { value: 'on', label: '按阈值' },
  { value: 'off', label: '关闭' },
];

/** 契约里的 `QueryRewriterConfig` → 档位（`enabled: false` 也算不改写）。 */
export function rewriteKindOf(cfg?: QueryRewriterConfig | null): RewriteKind {
  if (!cfg || cfg.enabled === false) return 'none';
  return cfg.kind ?? 'none';
}

/** 档位（或契约里的 kind）→ 短文案。详情页与抽屉都用它，别各写一份。 */
export function rewriteLabel(
  kind?: QueryRewriterKind | RewriteKind | null,
): string {
  switch (kind) {
    case 'common':
      return '日期展开';
    case 'llm':
      return '大模型改写';
    default:
      return '不改写';
  }
}

/**
 * 各轮的改写器是否**不一致**（用于给"轮的增量怎么读"的提示）。
 *
 * 只要有两轮的档位不同就得提示：逐轮换改写器时，相邻两轮的差里混进了
 * "改写器换了"这个变量，不再是单一变量的贡献。全部相同（含全都不改写）
 * 时不提示 —— 那种情况增量是干净的。
 */
export function rewriteKindsDiffer(rounds: AttemptRoundForm[]): boolean {
  const kinds = new Set(rounds.map((r) => r.rewrite_kind));
  return kinds.size > 1;
}

/**
 * 阶梯快照（`effective_config_snapshot.attempts`）→ 每轮（1 起）的改写档位。
 *
 * 详情页的阶梯表只有 `metrics.by_attempt`，而**指标里没有参数** ——
 * "这一轮改了什么"只能从快照读。键用轮次号，与 `by_attempt` 的字符串键
 * 一一对应（后端快照的数组顺序就是轮次顺序）。
 */
export function rewriteByAttempt(
  attempts?: EvalAttemptSpec[] | null,
): Record<number, RewriteKind> {
  const out: Record<number, RewriteKind> = {};
  (attempts ?? []).forEach((spec, i) => {
    out[i + 1] = rewriteKindOf(spec.query_rewriter);
  });
  return out;
}

/**
 * 从 run 的 `effective_config_snapshot` 里**安全**取出阶梯。
 *
 * 快照在后端是自由 JSON（前端类型是 `Record<string, unknown>`），所以不能
 * 直接断言成 `EvalAttemptSpec[]`：旧结果里可能压根没有 `attempts`，将来也可
 * 能换形状。**只认「是数组、元素是对象」**，其余一律返回 `[]`（页面上那一列
 * 显示「未记录」）—— 不去猜、也不抛。
 *
 * ⚠️ 返回 `[]` 与「返回 3 轮全不改写」是**两件不同的事**：前者是"这份结果里
 * 没这个信息"，后者是"跑了但没要求改写"。页面上必须能分开，否则会把旧结果
 * 读成"这轮没改写"，而它可能当时用的是 llm。
 */
export function attemptsFromSnapshot(
  snapshot?: Record<string, unknown> | null,
): EvalAttemptSpec[] {
  const raw = snapshot?.attempts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is EvalAttemptSpec => typeof x === 'object' && x !== null,
  );
}

/** 一轮表单 → 一轮契约。未开启的整段**省略**（= 继承 DTD），不是置 false。 */
export function roundToAttempt(
  round: AttemptRoundForm,
  index: number,
): EvalAttemptSpec {
  const processor: QueryProcessorOverride = {};

  if (round.fusioner_top_k != null) {
    processor.fusioner = { top_k: round.fusioner_top_k };
  }
  if (round.cutter_top_k != null) {
    processor.cutter = { top_k: round.cutter_top_k };
  }
  if (round.override_reranker) {
    processor.reranker = {
      enabled: true,
      type: round.reranker_type,
      top_n: round.reranker_top_n,
    };
  }
  // 三态各自对应的 payload（见 FilterMode）：关闭时**只发 enabled:false**，
  // 不带一个用不上的阈值 —— 快照按 exclude_unset 存，多发一个数就会让人
  // 以为"关闭但阈值 0.3"是个有意义的状态。
  if (round.filter_mode === 'on') {
    processor.filter = {
      enabled: true,
      score_threshold: round.score_threshold,
    };
  } else if (round.filter_mode === 'off') {
    processor.filter = { enabled: false };
  }

  const spec: EvalAttemptSpec = {
    name: round.name?.trim() || `round${index + 1}`,
  };
  if (round.recall_top_k != null) spec.recall_top_k = round.recall_top_k;
  if (Object.keys(processor).length > 0) {
    spec.retrieve_processor = processor;
  }
  // ⚠️ 不改写就**整个字段省略** —— 与后端内置阶梯第 3 轮、与契约的
  // 「不传 = 不改写」三处一致。发 `{ enabled: false }` 效果相同但多一层
  // 噪声，而且会让"这一轮到底要求改写没有"在读快照时要多绕一步。
  // 它也与 `retrieve_processor` **并列**，不塞进 processor 里（那一层没有
  // 改写段，见 data.d.ts）。
  //
  // 只发 `kind` 不发 `enabled`：`enabled` 默认就是 true，而快照是按
  // `exclude_unset` 存的（后端 `create_eval_run`）—— 多发一个默认值就会在
  // 快照里多一个恒为 true 的键，让"这一轮为什么改写"读起来像是有个开关被
  // 动过。真要停用就整段不发，比发个 false 更直白。
  if (round.rewrite_kind !== 'none') {
    spec.query_rewriter = { kind: round.rewrite_kind };
  }
  return spec;
}

/**
 * 表单 → `attempts`。空的尾轮会被去掉，最多 `MAX_ATTEMPTS` 轮。
 *
 * 「空」的判定：这一轮什么都没配（没有召回条数、也没有任何段覆盖、也不
 * 改写）就当作用户删不动留下的残壳。硬发一个空 spec 会让后端多跑一轮
 * **与上一轮完全相同**的检索，白花钱且把分母搅乱。
 *
 * ⚠️ 改写也要计入（`rewrite_kind !== 'none'`）：改了 query 的一轮**不是**
 * 空壳 —— 漏掉它会把用户真配过的改写器静默丢掉。
 */
export function roundsToAttempts(
  rounds: AttemptRoundForm[],
): EvalAttemptSpec[] {
  const kept = rounds.filter(
    (r) =>
      r.recall_top_k != null ||
      r.fusioner_top_k != null ||
      r.cutter_top_k != null ||
      r.override_reranker ||
      r.filter_mode !== 'inherit' ||
      r.rewrite_kind !== 'none',
  );
  return kept.slice(0, MAX_ATTEMPTS).map(roundToAttempt);
}

/** 契约 → 表单（把某次跑测用的阶梯回填进编辑框）。 */
export function attemptsToRounds(
  attempts?: EvalAttemptSpec[] | null,
): AttemptRoundForm[] {
  const base = defaultRounds();
  if (!attempts || attempts.length === 0) return base;
  return attempts.slice(0, MAX_ATTEMPTS).map((spec, i) => {
    const proc = spec.retrieve_processor ?? {};
    return {
      ...base[i],
      name: spec.name?.trim() || `round${i + 1}`,
      recall_top_k: spec.recall_top_k ?? base[i].recall_top_k,
      fusioner_top_k: proc.fusioner?.top_k ?? base[i].fusioner_top_k,
      cutter_top_k: proc.cutter?.top_k ?? base[i].cutter_top_k,
      override_reranker: proc.reranker != null,
      reranker_type: proc.reranker?.type ?? base[i].reranker_type,
      reranker_top_n: proc.reranker?.top_n ?? base[i].reranker_top_n,
      // 快照里没有 filter 段 = 没覆盖；`enabled:false` = 这一轮关掉了过滤
      // （和"没覆盖"不是一回事，别回落成 'inherit'）。
      filter_mode:
        proc.filter == null
          ? 'inherit'
          : proc.filter.enabled === false
            ? 'off'
            : 'on',
      score_threshold: proc.filter?.score_threshold ?? base[i].score_threshold,
      // 快照里没写 query_rewriter = 那一轮没要求改写（**不是**继承）；
      // 所以这里不做 base 回落 —— 那会把"第 3 轮不改写"回填成编辑器的
      // 默认档，用户再点一次提交就悄悄给它加上改写了。
      rewrite_kind: rewriteKindOf(spec.query_rewriter),
    };
  });
}

/** 一行阶梯的读数（已把「分母」与「累计」算好）。 */
export interface LadderRow {
  /** 轮次号（1 起） */
  attempt: number;
  /** by_attempt 的键 */
  key: string;
  /** 这一轮的输入 case 数 = **分母** */
  cases: number;
  /** 这一轮占全部 case 的比例（0–1） */
  inputShare: number | null;
  /** 这一轮的命中数（= 本轮**新增**救回的 case） */
  hitCount: number;
  hitRateAt1: number | null;
  hitRateAt5: number | null;
  hitRateAtK: number | null;
  mrrAtK: number | null;
  p95LatencyMs: number | null;
  /** 到这一轮为止累计找到多少条 */
  cumulativeHitCount: number;
  /** 累计召回率（分母 = 全体 case，即顶层 total_cases） */
  cumulativeRate: number | null;
}

/**
 * `metrics.by_attempt` → 有序的阶梯读数。
 *
 * 累计口径：三轮是**逐轮放宽**（第 N 轮只跑上一轮没命中的），所以各轮
 * `hit_count` 互不重叠，累加即为「N 轮内找到多少」—— 这正是用户要的
 * 「二次 / 三次召回率」，而**分母始终是全体 case**。
 *
 * 若把某一轮的 `hit_rate_at_k` 直接当「召回率」读，会拿缩小的分母当全体，
 * 于是数字被放大 —— 所以这里两个率都算：`hitRateAtK`（本轮口径）与
 * `cumulativeRate`（全体口径）。
 */
export function computeLadderSummary(
  metrics?: Pick<EvalMetrics, 'by_attempt' | 'total_cases'> | null,
): LadderRow[] {
  const byAttempt = metrics?.by_attempt ?? {};
  const total = metrics?.total_cases ?? 0;

  const keys = Object.keys(byAttempt)
    .map((k) => ({ key: k, n: Number(k) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n);

  let cumulative = 0;

  return keys.map(({ key, n }) => {
    const m = byAttempt[key];
    const cases = m.cases ?? 0;
    cumulative += m.hit_count ?? 0;
    return {
      attempt: n,
      key,
      cases,
      inputShare: m.input_share ?? (total > 0 ? round6(cases / total) : null),
      hitCount: m.hit_count ?? 0,
      hitRateAt1: m.hit_rate_at_1 ?? null,
      hitRateAt5: m.hit_rate_at_5 ?? null,
      hitRateAtK: m.hit_rate_at_k ?? null,
      mrrAtK: m.mrr_at_k ?? null,
      p95LatencyMs: m.p95_latency_ms ?? null,
      cumulativeHitCount: cumulative,
      cumulativeRate: total > 0 ? round6(cumulative / total) : null,
    };
  });
}

/** 召回率曲线上的一个点。 */
export interface CurvePoint {
  k: number;
  rate: number | null;
  /**
   * k 超过实际返回条数 —— 这个点的 0 只说明「没取回来」，
   * 不说明「召回差」。渲染时要弱化并加说明。
   */
  meaningless: boolean;
}

/** 后端取的点；曲线里出现别的 k 时以曲线为准。 */
export const CURVE_KS: readonly number[] = [1, 5, 10, 20, 50];

/**
 * `hit_rate_curve` → 有序的点。
 *
 * 关键字是字符串（JSON 的键只能是字符串），要按**数值**排序，否则会排成
 * 「1, 10, 20, 5, 50」那种字母序。
 */
export function curvePoints(
  metrics?: Pick<EvalMetrics, 'hit_rate_curve' | 'retrieved_max'> | null,
): CurvePoint[] {
  const curve = metrics?.hit_rate_curve ?? {};
  const retrievedMax = metrics?.retrieved_max ?? null;

  const fromCurve = Object.keys(curve)
    .map(Number)
    .filter((k) => Number.isFinite(k) && k > 0)
    .sort((a, b) => a - b);

  const ks = fromCurve.length > 0 ? fromCurve : [...CURVE_KS];

  return ks.map((k) => ({
    k,
    rate: curve[String(k)] ?? null,
    meaningless: retrievedMax != null && k > retrievedMax,
  }));
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
