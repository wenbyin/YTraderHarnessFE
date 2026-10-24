// src/pages/memory_retrieval/utils.test.ts
// 纯函数层的边界（memory_api_v2.yaml v2.1.0）。
//
// 这一层值得单独测的原因：契约里几个最容易读错的点全在这里被解释 ——
// target 恰一个 + agent_id 必填、**可选字段为空就整个不传**、团队 scope 下
// L0/L1 查询是 400、游标是**不透明的**、"还有下一页"看 `has_more` 而不是
// `next_cursor`、`heat: null` 不是 0、`session_id` 不存在是 404 而不是空列表。
// 读错**不会报错**，只会显示一个看着合理的错值。
//
// ⚠️ v2.0.0 重写：`buildL0/L1/L2Request` -> `buildL0/L1/L2QueryRequest`、
//    新增 `buildL2DetailRequest` / `canLoadMore` / `listSignature` /
//    `validatePriority` / `validateLimit` / `orderWarning`；
//    删掉 mode / score / matched_by / degraded_routes / include_content 那批断言。
//
// ⚠️ v2.1.0 又把 L0/L1 放回了**汇总**端点（打开时以 `input` 为查询串真跑召回）→
//    `input` 变必填、`retrieve`/`limits` 各多两个键、界面顺序改成 L0 -> L3。
//    注意这批改动**只落在汇总**：三个 `/query` 端点的断言一条都没变（它们仍然是
//    "浏览不是检索"）。
import { describe, expect, it } from 'vitest';

import type { Pagination, PromptSection } from './data';
import {
  AGENT_ID_OPTIONS,
  activePreviewLayers,
  anyRecallLayerOn,
  BLOCK_LAYER,
  buildAggregateRequest,
  buildL0QueryRequest,
  buildL1QueryRequest,
  buildL2DetailRequest,
  buildL2QueryRequest,
  buildL3Request,
  canLoadMore,
  compactTarget,
  DEFAULT_L0_INPUT,
  DEFAULT_L1_INPUT,
  DEFAULT_L2_INPUT,
  DEFAULT_PREVIEW_LAYERS,
  DEFAULT_PREVIEW_LIMITS,
  DEFAULT_TARGET_INPUT,
  describeDegraded,
  describeRequestError,
  EMPTY_TARGET_INPUT,
  factTypeLabel,
  formatTime,
  fromNow,
  heatText,
  isHardRule,
  isTeamTarget,
  L0_ORDERS,
  type L0Input,
  L1_ORDERS,
  L2_ORDERS,
  LAYER_META,
  LAYER_ORDER_L0_TO_L3,
  layerLabel,
  layerUnavailableForTarget,
  listSignature,
  orderWarning,
  PREVIEW_LAYER_ORDER,
  PREVIEW_LIMIT_META,
  PREVIEW_SWITCH_META,
  pageSummaryText,
  personaMissing,
  priorityText,
  QUERY_LIMITS,
  resolveScopeKind,
  roleLabel,
  type ScopeInput,
  sceneSummaryText,
  seqText,
  shortId,
  sortSectionsByLayer,
  switchScopeTarget,
  systemPromptState,
  targetProblem,
  targetProblemText,
  truncatedText,
  validateAggregateInput,
  validateLimit,
  validatePriority,
  validateRequiredText,
  validateTarget,
} from './utils';

/** 个人 + agent —— 合法且是最常用的那一档。 */
const SCOPE: ScopeInput = {
  target: { user_id: 'u-1', team_id: '', agent_id: 'duty-1' },
  session_id: '',
};

const TARGET = { user_id: 'u-1', team_id: '', agent_id: 'duty-1' };

const L0_BASE: L0Input = { ...DEFAULT_L0_INPUT, roles: [] };

/** 造一个翻页信息 —— 三个字段都要给，别只给 next_cursor。 */
const page = (
  next: string | null,
  hasMore: boolean,
  limit = 20,
): Pagination => ({ limit, next_cursor: next, has_more: hasMore });

describe('四层的展示元信息', () => {
  it('界面顺序是 L0 -> L3 升序（用户 2026-10-12 要求："检索条件也是排序"）', () => {
    expect(PREVIEW_LAYER_ORDER).toEqual(['l0', 'l1', 'l2', 'l3']);
    expect(LAYER_ORDER_L0_TO_L3).toEqual(['l0', 'l1', 'l2', 'l3']);
  });

  it('⚠️ 它与**后端拼 prompt 的顺序相反** —— 别把两者对齐', () => {
    // 契约里 sections 的原始顺序是 L3 -> L2 -> L0 -> L1（"先给结论再给原始材料"），
    // 而本页展示与这四个开关都要 L0 -> L3。这条断言是防"顺手对齐"的。
    expect(PREVIEW_LAYER_ORDER[0]).toBe('l0');
    expect(PREVIEW_LAYER_ORDER[3]).toBe('l3');
  });

  it('四层都进汇总，所以 block 映射不再有 null', () => {
    expect(LAYER_META.l0.block).toBe('conversations');
    expect(LAYER_META.l1.block).toBe('facts');
    expect(LAYER_META.l2.block).toBe('scenes');
    expect(LAYER_META.l3.block).toBe('persona');
    // BLOCK_LAYER 是它的反向映射，两边必须互逆
    for (const layer of LAYER_ORDER_L0_TO_L3) {
      expect(BLOCK_LAYER[LAYER_META[layer].block]).toBe(layer);
    }
  });

  it('layerLabel / roleLabel', () => {
    expect(layerLabel('l3')).toBe('L3 画像');
    expect(layerLabel('l2')).toBe('L2 场景');
    expect(layerLabel('l0')).toBe('L0 原始对话');
    expect(roleLabel('user')).toBe('用户');
    expect(roleLabel('assistant')).toBe('助手');
  });
});

describe('sortSectionsByLayer（汇总的召回记忆顺序）', () => {
  /** 只做排序，不渲染 —— 所以 items / title 给空壳就够。 */
  const s = (block: PromptSection['block']): PromptSection =>
    ({
      block,
      title: block,
      returned: 0,
      items: [],
    }) as unknown as PromptSection;

  it('把后端的 prompt 顺序（L3,L2,L0,L1）重排成 L0 -> L3', () => {
    const out = sortSectionsByLayer([
      s('persona'),
      s('scenes'),
      s('conversations'),
      s('facts'),
    ]);
    expect(out.map((x) => x.block)).toEqual([
      'conversations',
      'facts',
      'scenes',
      'persona',
    ]);
  });

  it('⚠️ 不就地改原数组（那是响应对象的一部分，改了"原始顺序"就拿不回来了）', () => {
    const input = [s('persona'), s('conversations')];
    const out = sortSectionsByLayer(input);
    expect(input.map((x) => x.block)).toEqual(['persona', 'conversations']);
    expect(out).not.toBe(input);
  });

  it('缺段（只开了一部分）时也是升序，不会把没出现的层插进去', () => {
    expect(sortSectionsByLayer([s('scenes')]).map((x) => x.block)).toEqual([
      'scenes',
    ]);
    expect(
      sortSectionsByLayer([s('facts'), s('scenes')]).map((x) => x.block),
    ).toEqual(['facts', 'scenes']);
    expect(sortSectionsByLayer([])).toEqual([]);
  });
});

describe('compactTarget', () => {
  it('去掉首尾空白，并且**恒带 agent_id**（契约把它列为 required）', () => {
    expect(
      compactTarget({ user_id: ' u-1 ', team_id: ' ', agent_id: ' a-1 ' }),
    ).toEqual({ user_id: 'u-1', agent_id: 'a-1' });
  });

  it('空值整个丢掉 —— 空串在后端是合法字符串，会变成"查一个空 id 的人"', () => {
    expect(
      compactTarget({ user_id: '   ', team_id: '', agent_id: 'a-1' }),
    ).toEqual({ agent_id: 'a-1' });
  });

  it('还没填 agent_id 时它是个空串（预览里要看得见，而不是被省略掉）', () => {
    const target = compactTarget({ user_id: 'u', team_id: '', agent_id: '' });
    expect('agent_id' in target).toBe(true);
    expect(target.agent_id).toBe('');
  });

  it('两个归属都给时**两个都留着**（判重是后端的事，前端不替它取舍）', () => {
    expect(
      compactTarget({ user_id: 'u-1', team_id: 't-1', agent_id: 'a' }),
    ).toEqual({ user_id: 'u-1', team_id: 't-1', agent_id: 'a' });
  });
});

describe('resolveScopeKind / isTeamTarget', () => {
  it('只给 user_id -> user；只给 team_id -> team', () => {
    expect(resolveScopeKind({ user_id: 'u-1' })).toBe('user');
    expect(resolveScopeKind({ team_id: 't-1' })).toBe('team');
  });

  it('两个都给 / 都没给 -> null（都是 400，谈"解析成哪种"没有意义）', () => {
    expect(resolveScopeKind({ user_id: 'u-1', team_id: 't-1' })).toBeNull();
    expect(resolveScopeKind({})).toBeNull();
    expect(resolveScopeKind({ user_id: '  ', team_id: '' })).toBeNull();
  });

  it('isTeamTarget：两个都给（= 400）时不算 team', () => {
    expect(isTeamTarget({ team_id: 't-1' })).toBe(true);
    expect(isTeamTarget({ user_id: 'u-1' })).toBe(false);
    expect(isTeamTarget({ user_id: 'u', team_id: 't' })).toBe(false);
  });
});

describe('switchScopeTarget（切换即清另一侧，"恰有一个"靠结构保证）', () => {
  const filled = { user_id: 'u-1', team_id: 't-1', agent_id: 'duty' };

  it('切到 team -> user_id 清空，team_id 与 agent_id 原样保留', () => {
    expect(switchScopeTarget({ ...filled, user_id: '' }, 'team')).toEqual({
      user_id: '',
      team_id: 't-1',
      agent_id: 'duty',
    });
  });

  it('切回 user -> team_id 清空', () => {
    expect(switchScopeTarget({ ...filled, team_id: '' }, 'user')).toEqual({
      user_id: 'u-1',
      team_id: '',
      agent_id: 'duty',
    });
  });

  it('⚠️ 从"两个都有"的脏 state 切哪边都只剩一个（兜底：脏 state 也清得干净）', () => {
    expect(resolveScopeKind(switchScopeTarget(filled, 'user'))).toBe('user');
    expect(resolveScopeKind(switchScopeTarget(filled, 'team'))).toBe('team');
  });
});

describe('targetProblem / validateTarget', () => {
  it('三种不合法形态分得开：都没给 / 都给 / 缺 agent_id', () => {
    expect(targetProblem({ user_id: '', team_id: '', agent_id: 'a' })).toBe(
      'none',
    );
    expect(targetProblem({ user_id: 'u', team_id: 't', agent_id: 'a' })).toBe(
      'both',
    );
    expect(targetProblem({ user_id: 'u', team_id: '', agent_id: '' })).toBe(
      'agent',
    );
    expect(
      targetProblem({ user_id: 'u', team_id: '', agent_id: 'a' }),
    ).toBeNull();
    expect(
      targetProblem({ user_id: '', team_id: 't', agent_id: 'a' }),
    ).toBeNull();
  });

  it('"两个都给"的文案要点明与写入侧"org 赢"的差别', () => {
    expect(targetProblemText('both')).toContain('不能同时给');
    expect(targetProblemText('both')).toContain('org 赢');
  });

  it('validateTarget 给的是**纯文本**（告警块不渲染 markdown，星号会露出来）', () => {
    const text = validateTarget({ user_id: '', team_id: '', agent_id: 'a' });
    expect(text).toContain('恰有一个');
    expect(text).not.toContain('**');
    expect(validateTarget(TARGET)).toBeNull();
  });

  it('minLength: 1 的文本字段：只有空白也算空', () => {
    expect(validateRequiredText('  ', '场景文件名')).toBe(
      '场景文件名不能为空。',
    );
    expect(validateRequiredText('x', '场景文件名')).toBeNull();
  });
});

describe('汇总的四个开关（L0 / L1 默认关，L2 / L3 默认开）', () => {
  it('契约默认：l2 / l3 开，l0 / l1 关 —— 这不是"省事"，是成本分界', () => {
    expect(DEFAULT_PREVIEW_LAYERS).toEqual({
      l0: false,
      l1: false,
      l2: true,
      l3: true,
    });
    // ⚠️ L0/L1 的**起步值**是 5（不是契约默认 10）—— 2026-10-12 用户指定：
    //    召回是真花钱的动作，预览默认取小。别"顺手改成 10"。
    expect(DEFAULT_PREVIEW_LIMITS).toEqual({ l0: 5, l1: 5, l2: 12 });
  });

  it('四层都有开关元信息，且**顺序就是渲染顺序**（L0 -> L3）', () => {
    expect(Object.keys(PREVIEW_SWITCH_META)).toEqual(['l0', 'l1', 'l2', 'l3']);
    expect(PREVIEW_SWITCH_META.l3.limitKey).toBeNull(); // 一个 scope 只有一篇
    expect(PREVIEW_SWITCH_META.l2.limitKey).toBe('l2');
    expect(PREVIEW_SWITCH_META.l1.limitKey).toBe('l1');
    expect(PREVIEW_SWITCH_META.l0.limitKey).toBe('l0');
  });

  it('⚠️ recalls 这一档把"真的去召回"与"多带一段现成内容"分开', () => {
    expect(PREVIEW_SWITCH_META.l0.recalls).toBe(true);
    expect(PREVIEW_SWITCH_META.l1.recalls).toBe(true);
    expect(PREVIEW_SWITCH_META.l2.recalls).toBe(false);
    expect(PREVIEW_SWITCH_META.l3.recalls).toBe(false);
  });

  it('⚠️ l0/l1 的条数区间是 1..50（跟着召回端点），l2 是 1..100', () => {
    // `default` = **契约默认**（yaml / 后端都是这个事实值），提示文案报的是它
    expect(PREVIEW_LIMIT_META.l0).toEqual({
      min: 1,
      max: 50,
      default: 10,
      prefill: 5,
    });
    expect(PREVIEW_LIMIT_META.l1).toEqual({
      min: 1,
      max: 50,
      default: 10,
      prefill: 5,
    });
    expect(PREVIEW_LIMIT_META.l2).toEqual({
      min: 1,
      max: 100,
      default: 12,
      prefill: 12,
    });
    // 三个 limitKey 都能在表里查到 —— 组件靠这个查表，漏一个就是 undefined 参与渲染
    for (const layer of PREVIEW_LAYER_ORDER) {
      const key = PREVIEW_SWITCH_META[layer].limitKey;
      if (key) expect(PREVIEW_LIMIT_META[key]).toBeTruthy();
    }
  });

  it('⚠️ 起步值必须落在区间内；且"起步值 ≠ 契约默认"只允许出现在召回层', () => {
    for (const key of ['l0', 'l1', 'l2'] as const) {
      const m = PREVIEW_LIMIT_META[key];
      expect(m.prefill).toBeGreaterThanOrEqual(m.min);
      expect(m.prefill).toBeLessThanOrEqual(m.max);
      expect(Number.isInteger(m.prefill)).toBe(true);
    }
    // 界面按"两者是否相等"决定要不要同时报两个数（见 Fields.tsx 的提示文案），
    // 所以这条不对称关系是有意的：只有召回层起步值比契约默认小。
    const differing = (['l0', 'l1', 'l2'] as const).filter(
      (k) => PREVIEW_LIMIT_META[k].prefill !== PREVIEW_LIMIT_META[k].default,
    );
    expect(differing).toEqual(['l0', 'l1']);
    for (const k of differing) {
      expect(PREVIEW_LIMIT_META[k].prefill).toBeLessThan(
        PREVIEW_LIMIT_META[k].default,
      );
    }
    // 而"这一层真的会召回"必须与"起步值≠契约默认"同一组 —— 不是就说明配错了
    for (const layer of PREVIEW_LAYER_ORDER) {
      const key = PREVIEW_SWITCH_META[layer].limitKey;
      if (!key) continue;
      expect(
        PREVIEW_LIMIT_META[key].prefill !== PREVIEW_LIMIT_META[key].default,
      ).toBe(PREVIEW_SWITCH_META[layer].recalls);
    }
  });

  it('activePreviewLayers 只留打开的层，顺序是 L0 -> L3', () => {
    expect(activePreviewLayers({ ...DEFAULT_PREVIEW_LAYERS })).toEqual([
      'l2',
      'l3',
    ]);
    expect(
      activePreviewLayers({ l0: true, l1: true, l2: true, l3: true }),
    ).toEqual(['l0', 'l1', 'l2', 'l3']);
    expect(
      activePreviewLayers({ l0: false, l1: true, l2: false, l3: true }),
    ).toEqual(['l1', 'l3']);
    expect(
      activePreviewLayers({ l0: false, l1: false, l2: false, l3: false }),
    ).toEqual([]);
  });

  it('anyRecallLayerOn：只有 L0/L1 算"会真的召回"', () => {
    expect(anyRecallLayerOn({ ...DEFAULT_PREVIEW_LAYERS })).toBe(false);
    expect(anyRecallLayerOn({ ...DEFAULT_PREVIEW_LAYERS, l1: true })).toBe(
      true,
    );
    expect(anyRecallLayerOn({ ...DEFAULT_PREVIEW_LAYERS, l0: true })).toBe(
      true,
    );
    // l2/l3 打开不算 —— 那两层不花检索的代价
    expect(anyRecallLayerOn({ l0: false, l1: false, l2: true, l3: true })).toBe(
      false,
    );
  });
});

describe('agent_id 的候选集（暂时前端写死）', () => {
  it('只有一个 general —— 界面做成只有一项的下拉框', () => {
    expect(AGENT_ID_OPTIONS).toEqual(['general']);
  });

  it('⚠️ DEFAULT_TARGET_INPUT ≠ EMPTY_TARGET_INPUT：前者是"刚打开的样子"', () => {
    expect(EMPTY_TARGET_INPUT).toEqual({
      user_id: '',
      team_id: '',
      agent_id: '',
    });
    expect(DEFAULT_TARGET_INPUT).toEqual({
      user_id: '',
      team_id: '',
      agent_id: 'general',
    });
  });
});

describe('limit / priority 的边界（越界后端是 400）', () => {
  it('三个浏览端点的 limit 默认值来自契约', () => {
    expect(QUERY_LIMITS.l0.default).toBe(20);
    expect(QUERY_LIMITS.l1.default).toBe(20);
    expect(QUERY_LIMITS.l2.default).toBe(50);
    for (const kind of ['l0', 'l1', 'l2'] as const) {
      expect(QUERY_LIMITS[kind].min).toBe(1);
      expect(QUERY_LIMITS[kind].max).toBe(100);
    }
  });

  it('validateLimit：越界 / 非整数都拦，边界值放行', () => {
    expect(validateLimit(20, 'l0')).toBeNull();
    expect(validateLimit(1, 'l0')).toBeNull();
    expect(validateLimit(100, 'l0')).toBeNull();
    expect(validateLimit(0, 'l0')).toContain('1..100');
    expect(validateLimit(101, 'l0')).toContain('1..100');
    expect(validateLimit(1.5, 'l0')).toContain('1..100');
  });

  it('validatePriority：null = 不筛；-1 合法（全局死命令）', () => {
    expect(validatePriority(null)).toBeNull();
    expect(validatePriority(-1)).toBeNull();
    expect(validatePriority(0)).toBeNull();
    expect(validatePriority(100)).toBeNull();
    expect(validatePriority(-2)).toContain('-1..100');
    expect(validatePriority(101)).toContain('-1..100');
    expect(validatePriority(1.5)).toContain('整数');
  });
});

describe('orderWarning（建议，不是错误）', () => {
  it('session_seq_* 在没给 session_id 时给出提醒', () => {
    expect(orderWarning('session_seq_asc', false)).toContain('session_seq');
    expect(orderWarning('session_seq_desc', false)).toContain('session_id');
  });

  it('给了 session_id、或者本来就不是会话内序 -> 不提醒', () => {
    expect(orderWarning('session_seq_asc', true)).toBeNull();
    expect(orderWarning('created_at_desc', false)).toBeNull();
  });

  it('三个端点的 order 枚举各不相同（写死一份就会造出契约里没有的取值）', () => {
    expect(L0_ORDERS.map((item) => item.value)).toEqual([
      'created_at_desc',
      'created_at_asc',
      'session_seq_asc',
      'session_seq_desc',
    ]);
    expect(L1_ORDERS.map((item) => item.value)).toEqual([
      'updated_at_desc',
      'updated_at_asc',
      'priority_desc',
      'priority_asc',
    ]);
    expect(L2_ORDERS.map((item) => item.value)).toEqual([
      'updated_at_desc',
      'updated_at_asc',
      'filename_asc',
    ]);
    // L0 没有 priority 序、L2 没有会话内序 —— 这两个键就是"按层写死"会犯的错
    expect(L0_ORDERS.some((item) => item.value.startsWith('priority'))).toBe(
      false,
    );
    expect(L2_ORDERS.some((item) => item.value.startsWith('session_seq'))).toBe(
      false,
    );
  });
});

describe('buildAggregateRequest', () => {
  const agg = {
    input: '  今天几号  ',
    retrieve: { ...DEFAULT_PREVIEW_LAYERS },
    limits: { ...DEFAULT_PREVIEW_LIMITS },
  };

  it('retrieve / limits **永远显式带上**（关掉的层省略会回落成默认的"开"）', () => {
    const body = buildAggregateRequest(TARGET, {
      ...agg,
      retrieve: { l0: false, l1: false, l2: false, l3: false },
      limits: { l0: 5, l1: 5, l2: 3 },
    });
    expect(body.retrieve).toEqual({
      l0: false,
      l1: false,
      l2: false,
      l3: false,
    });
    expect(body.limits).toEqual({ l0: 5, l1: 5, l2: 3 });
    // 四个键一个都不能少 —— "我关了它它还在"就是这个键被省略的症状
    expect(Object.keys(body.retrieve ?? {})).toEqual(['l0', 'l1', 'l2', 'l3']);
    expect(Object.keys(body.limits ?? {})).toEqual(['l0', 'l1', 'l2']);
  });

  it('⚠️ v2 没有 session_id / mode / budget 这几个字段', () => {
    const body = buildAggregateRequest(TARGET, agg) as unknown as Record<
      string,
      unknown
    >;
    expect('session_id' in body).toBe(false);
    expect('mode' in body).toBe(false);
    expect('budget' in body).toBe(false);
  });

  it('⚠️ v2.1.0 起 input **必填**：去空白，而且空 input 也照样出现在请求体里', () => {
    expect(buildAggregateRequest(TARGET, agg).input).toBe('今天几号');
    // ⚠️ 与其它可选字段相反：**不能**因为空就不传。构造请求是纯函数，它没资格替用户
    //    改主意 —— 空串要由 preflight（validateAggregateInput）拦在发起处。
    expect(buildAggregateRequest(TARGET, { ...agg, input: '   ' }).input).toBe(
      '',
    );
    expect(
      'input' in buildAggregateRequest(TARGET, { ...agg, input: '' }),
    ).toBe(true);
  });

  it('retrieve / limits 是拷贝而不是同一个引用（改表单不该动到已发出的请求快照）', () => {
    const body = buildAggregateRequest(TARGET, agg);
    expect(body.retrieve).not.toBe(agg.retrieve);
    expect(body.limits).not.toBe(agg.limits);
  });

  it('target 用**新版**的 team_id，且带上 agent_id', () => {
    const body = buildAggregateRequest(
      { user_id: '', team_id: 't-9', agent_id: 'duty-9' },
      agg,
    );
    expect(body.target).toEqual({ team_id: 't-9', agent_id: 'duty-9' });
  });
});

describe('validateAggregateInput（拦在发起处，而不是构造请求时兜底）', () => {
  it('空 / 纯空白都拦，文案说清"为什么"（L0/L1 拿它当查询串）', () => {
    expect(validateAggregateInput('')).toContain('input 必填');
    expect(validateAggregateInput('   ')).toContain('召回');
    expect(validateAggregateInput('\n\t ')).not.toBeNull();
  });

  it('有内容就放行（前后空白不算问题 —— build 里会 trim）', () => {
    expect(validateAggregateInput('今天几号')).toBeNull();
    expect(validateAggregateInput('  今天几号  ')).toBeNull();
  });
});

describe('buildL0QueryRequest', () => {
  it('limit 与 order **总是带上**（order 是用户选过的意图，省略会让界面与请求悄悄不一致）', () => {
    const body = buildL0QueryRequest(SCOPE, L0_BASE, null);
    expect(body.limit).toBe(20);
    expect(body.order).toBe('created_at_desc');
  });

  it('roles 为空 -> **不传**（契约：不传 = 两种角色都要；`[]` 没有定义）', () => {
    expect('roles' in buildL0QueryRequest(SCOPE, L0_BASE, null)).toBe(false);
  });

  it('roles 非空 -> 原样带上，且是拷贝', () => {
    const roles: Array<'user' | 'assistant'> = ['user'];
    const body = buildL0QueryRequest(SCOPE, { ...L0_BASE, roles }, null);
    expect(body.roles).toEqual(['user']);
    expect(body.roles).not.toBe(roles);
  });

  it('时间不给就不传（null 不是合法取值）；给了就带上', () => {
    const bare = buildL0QueryRequest(SCOPE, L0_BASE, null);
    expect('time_from' in bare).toBe(false);
    expect('time_to' in bare).toBe(false);

    const ranged = buildL0QueryRequest(
      SCOPE,
      {
        ...L0_BASE,
        time_from: '2026-10-01T00:00:00.000Z',
        time_to: '2026-10-06T00:00:00.000Z',
      },
      null,
    );
    expect(ranged.time_from).toBe('2026-10-01T00:00:00.000Z');
    expect(ranged.time_to).toBe('2026-10-06T00:00:00.000Z');
  });

  it('text_contains 空 -> 不传；有值 -> 去空白后带上', () => {
    expect('text_contains' in buildL0QueryRequest(SCOPE, L0_BASE, null)).toBe(
      false,
    );
    const body = buildL0QueryRequest(
      SCOPE,
      { ...L0_BASE, text_contains: '  上次说的报告  ' },
      null,
    );
    expect(body.text_contains).toBe('上次说的报告');
  });

  it('session_id 空 -> 不传；有值 -> 去空白带上', () => {
    expect('session_id' in buildL0QueryRequest(SCOPE, L0_BASE, null)).toBe(
      false,
    );
    const body = buildL0QueryRequest(
      { ...SCOPE, session_id: ' s-1 ' },
      L0_BASE,
      null,
    );
    expect(body.session_id).toBe('s-1');
  });

  it('游标：首页不传，翻页原样带上（不透明，前端不许动它）', () => {
    expect('cursor' in buildL0QueryRequest(SCOPE, L0_BASE, null)).toBe(false);
    expect(buildL0QueryRequest(SCOPE, L0_BASE, 'opaque-1').cursor).toBe(
      'opaque-1',
    );
  });

  it('target 里带上 agent_id（必填，漏了后端会 400）', () => {
    expect(buildL0QueryRequest(SCOPE, L0_BASE, null).target).toEqual({
      user_id: 'u-1',
      agent_id: 'duty-1',
    });
  });
});

describe('buildL1QueryRequest', () => {
  const base = { ...DEFAULT_L1_INPUT };

  it('type / priority / scene_name 为空就整个不传', () => {
    const body = buildL1QueryRequest(TARGET, base, null);
    expect('type' in body).toBe(false);
    expect('priority' in body).toBe(false);
    expect('scene_name' in body).toBe(false);
    expect('text_contains' in body).toBe(false);
    expect('updated_from' in body).toBe(false);
    expect('updated_to' in body).toBe(false);
  });

  it('priority = -1 是**有值**（全局死命令），不能当成"没填"丢掉', () => {
    const body = buildL1QueryRequest(TARGET, { ...base, priority: -1 }, null);
    expect(body.priority).toBe(-1);
  });

  it('priority = 0 也是有效值', () => {
    expect(
      buildL1QueryRequest(TARGET, { ...base, priority: 0 }, null).priority,
    ).toBe(0);
  });

  it('给满参数时逐项带上，且文本去空白', () => {
    const body = buildL1QueryRequest(
      TARGET,
      {
        type: ' instruction ',
        priority: 80,
        scene_name: ' 对账 ',
        updated_from: '2026-10-01T00:00:00.000Z',
        updated_to: '2026-10-06T00:00:00.000Z',
        text_contains: ' 报销 ',
        limit: 30,
        order: 'priority_desc',
      },
      'c1',
    );
    expect(body).toEqual({
      target: { user_id: 'u-1', agent_id: 'duty-1' },
      limit: 30,
      order: 'priority_desc',
      type: 'instruction',
      priority: 80,
      scene_name: '对账',
      updated_from: '2026-10-01T00:00:00.000Z',
      updated_to: '2026-10-06T00:00:00.000Z',
      text_contains: '报销',
      cursor: 'c1',
    });
  });

  it('L1 **不吃 session_id**（v2 起这一层没有会话过滤）', () => {
    const body = buildL1QueryRequest(TARGET, base, null);
    expect('session_id' in body).toBe(false);
  });
});

describe('buildL2QueryRequest / buildL2DetailRequest / buildL3Request', () => {
  it('L2 只筛**文件名**：空不传，有值去空白', () => {
    const bare = buildL2QueryRequest(TARGET, { ...DEFAULT_L2_INPUT }, null);
    expect('filename_contains' in bare).toBe(false);
    expect('query' in bare).toBe(false); // 上一版的字段，v2 已删
    expect('include_content' in bare).toBe(false);

    const body = buildL2QueryRequest(
      TARGET,
      { filename_contains: '  对账 ', limit: 50, order: 'updated_at_desc' },
      'c1',
    );
    expect(body.filename_contains).toBe('对账');
    expect(body.limit).toBe(50);
    expect(body.cursor).toBe('c1');
  });

  it('L2 详情：filename 必填且去空白（精确匹配，不是包含）', () => {
    expect(buildL2DetailRequest(TARGET, '  2026-10-01-对账.md  ')).toEqual({
      target: { user_id: 'u-1', agent_id: 'duty-1' },
      filename: '2026-10-01-对账.md',
    });
  });

  it('L3 只有一个 target（一个 scope 只有一篇画像，这是"取"）', () => {
    expect(buildL3Request(TARGET)).toEqual({
      target: { user_id: 'u-1', agent_id: 'duty-1' },
    });
  });
});

describe('翻页：canLoadMore / listSignature', () => {
  it('"还有下一页"看 has_more，**不是** next_cursor', () => {
    // 有下一页：两个字段都给了
    expect(canLoadMore(page('c1', true))).toBe(true);
    // 最后一页：next_cursor 是 null、has_more 是 false
    expect(canLoadMore(page(null, false))).toBe(false);
    // 这两条就是"拿 next_cursor 当判据"会读错的地方：
    expect(canLoadMore(page('c1', false))).toBe(false);
    expect(canLoadMore(page(null, true))).toBe(true);
  });

  it('没有 page（还没执行 / 不是列表 tab）时不显示加载更多', () => {
    expect(canLoadMore(null)).toBe(false);
    expect(canLoadMore(undefined)).toBe(false);
  });

  it('listSignature **剔除游标** —— 否则"加载下一页"会把自己判成"筛选变了"', () => {
    const first = buildL0QueryRequest(SCOPE, L0_BASE, null);
    const next = buildL0QueryRequest(SCOPE, L0_BASE, 'opaque-1');
    expect(listSignature(first)).toBe(listSignature(next));
  });

  it('listSignature 认得出筛选的变化（改 limit / order / text / target 都会变）', () => {
    const base = buildL0QueryRequest(SCOPE, L0_BASE, null);
    expect(
      listSignature(
        buildL0QueryRequest(SCOPE, { ...L0_BASE, limit: 30 }, null),
      ),
    ).not.toBe(listSignature(base));
    expect(
      listSignature(
        buildL0QueryRequest(
          SCOPE,
          { ...L0_BASE, order: 'created_at_asc' },
          null,
        ),
      ),
    ).not.toBe(listSignature(base));
    expect(
      listSignature(
        buildL0QueryRequest(SCOPE, { ...L0_BASE, text_contains: 'x' }, null),
      ),
    ).not.toBe(listSignature(base));
    expect(
      listSignature(
        buildL0QueryRequest(
          { ...SCOPE, target: { ...TARGET, agent_id: 'duty-2' } },
          L0_BASE,
          null,
        ),
      ),
    ).not.toBe(listSignature(base));
  });
});

describe('团队 target 下 L0/L1 查不了（契约的能力缺口）', () => {
  it('只对 l0 / l1 成立 —— l2/l3 两种 target 都行', () => {
    expect(layerUnavailableForTarget('l0', { team_id: 't' })).toBe(true);
    expect(layerUnavailableForTarget('l1', { team_id: 't' })).toBe(true);
    expect(layerUnavailableForTarget('l2', { team_id: 't' })).toBe(false);
    expect(layerUnavailableForTarget('l3', { team_id: 't' })).toBe(false);
    expect(layerUnavailableForTarget('l0', { user_id: 'u' })).toBe(false);
    // 两个都给（= 400）时不该当成 team
    expect(
      layerUnavailableForTarget('l0', { user_id: 'u', team_id: 't' }),
    ).toBe(false);
  });
});

describe('systemPromptState', () => {
  it('null = 那份提示词**还没写**，与"写了但是空的"必须分开', () => {
    expect(systemPromptState(null)).toEqual({ kind: 'missing' });
    expect(systemPromptState(undefined)).toEqual({ kind: 'missing' });
    expect(systemPromptState('   ')).toEqual({ kind: 'empty' });
    expect(systemPromptState('你是助手')).toEqual({
      kind: 'text',
      text: '你是助手',
    });
  });
});

describe('格式化与文案', () => {
  it('heatText：null 是"没写/解析不出"，与 0 说不同的话', () => {
    expect(heatText(null)).toBe('热度未知');
    expect(heatText(undefined)).toBe('热度未知');
    expect(heatText(0)).toBe('热度 0');
    expect(heatText(7)).toBe('热度 7');
  });

  it('sceneSummaryText：空串是"存量场景没写 META"这个事实', () => {
    expect(sceneSummaryText('')).toContain('没有摘要');
    expect(sceneSummaryText('对账习惯')).toBe('对账习惯');
  });

  it('priorityText：-1 是全局死命令，不是"最低优先级"', () => {
    expect(priorityText(-1)).toBe('全局死命令 (-1)');
    expect(priorityText(80)).toBe('优先级 80');
  });

  it('isHardRule', () => {
    expect(isHardRule({ priority: -1 })).toBe(true);
    expect(isHardRule({ priority: 0 })).toBe(false);
  });

  it('factTypeLabel：契约说 type 不是枚举 -> 认不出的值**原样显示**', () => {
    expect(factTypeLabel('persona')).toBe('画像');
    expect(factTypeLabel('episodic')).toBe('情景');
    expect(factTypeLabel('work_preference')).toBe('work_preference');
  });

  it('formatTime：空 / 坏值回落破折号，不回落到 1970', () => {
    expect(formatTime('')).toBe('—');
    expect(formatTime(null)).toBe('—');
    expect(formatTime('not-a-date')).toBe('—');
    expect(formatTime('2026-10-06T13:45:12Z')).toMatch(
      /^2026-10-06 \d{2}:\d{2}:12$/,
    );
  });

  it('fromNow：固定"现在"，断言与机器时钟无关', () => {
    const NOW = Date.parse('2026-10-06T12:00:00Z');
    expect(fromNow('2026-10-06T11:59:30Z', NOW)).toBe('刚刚');
    expect(fromNow('2026-10-06T11:55:00Z', NOW)).toBe('5 分钟前');
    expect(fromNow('2026-10-06T09:00:00Z', NOW)).toBe('3 小时前');
    expect(fromNow('2026-10-05T12:00:00Z', NOW)).toBe('1 天前');
    expect(fromNow(null, NOW)).toBe('—');
  });

  it('shortId：短的不截，长的截成 8 位加省略号', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('')).toBe('—');
    expect(shortId('0197f3a1-1111-2222-3333-444455556666')).toBe('0197f3a1…');
  });

  it('personaMissing：null 是"还没生成过"，不是错误', () => {
    expect(personaMissing({ persona: null })).toBe(true);
    expect(personaMissing({ persona: { content: 'x' } })).toBe(false);
  });

  it('seqText：会话内序号（不是全局序号）', () => {
    expect(seqText({ seq: 12 })).toBe('seq 12');
  });

  it('truncatedText：v2 的截断只与**段条数上限**有关，不是句子被切了', () => {
    expect(truncatedText(true)).toContain('条数上限');
    expect(truncatedText(false)).toBe('未截断。');
  });

  it('pageSummaryText：也拿 has_more 说事，不拿 next_cursor', () => {
    expect(pageSummaryText(20, page('c1', true))).toBe(
      '本页 20 条 · 还有下一页',
    );
    expect(pageSummaryText(7, page(null, false))).toBe(
      '本页 7 条 · 已到最后一页',
    );
    expect(pageSummaryText(5, null)).toBe('本页 5 条');
  });

  it('describeDegraded：空数组给空串（界面上据此不画那块）', () => {
    expect(describeDegraded([])).toBe('');
    expect(describeDegraded(undefined)).toBe('');
    expect(describeDegraded([{ layer: 'l3', reason: '还没接线' }])).toBe(
      'L3 画像：还没接线',
    );
  });
});

describe('describeRequestError', () => {
  it('axios 形状：detail 在 response.data —— 不能只看 err.data', () => {
    expect(
      describeRequestError({
        response: { status: 404, data: { detail: '会话不存在：s-1' } },
      }),
    ).toBe('会话不存在：s-1');
  });

  it('也认自研 fetch 那种把 detail 放在 err.data 的形状', () => {
    expect(describeRequestError({ data: { detail: '错误原因' } })).toBe(
      '错误原因',
    );
  });

  it('422 的 detail 是数组 —— 逐个取 msg 拼起来', () => {
    expect(
      describeRequestError({
        response: {
          status: 422,
          data: {
            detail: [{ msg: 'limit 必须 <= 100' }, { msg: 'order 非法' }],
          },
        },
      }),
    ).toBe('limit 必须 <= 100；order 非法');
  });

  it('v2 契约的 ErrorResponse {code, message} 也要读出来（并带上 code）', () => {
    expect(
      describeRequestError({
        response: {
          status: 400,
          data: { code: 'invalid_target', message: 'target 必须恰好一个归属' },
        },
      }),
    ).toBe('target 必须恰好一个归属（invalid_target）');
  });

  it('没有 code 时只给 message', () => {
    expect(
      describeRequestError({
        response: { status: 400, data: { message: '坏了' } },
      }),
    ).toBe('坏了');
  });

  it('403 没有 detail 时给出角色门槛的完整解释（本地能跑不代表能通）', () => {
    const text = describeRequestError({ response: { status: 403 } });
    expect(text).toContain('Y-Trader-Admin');
    expect(text).toContain('roles');
  });

  it('404 说的是"session_id 或场景 filename 给错了"', () => {
    const text = describeRequestError({ response: { status: 404 } });
    expect(text).toContain('session_id');
    expect(text).toContain('filename');
  });

  it('400 的兜底文案覆盖 v2 的全部成因，且不含 markdown 星号', () => {
    const text = describeRequestError({ response: { status: 400 } });
    expect(text).toContain('team_id');
    expect(text).toContain('都没给');
    expect(text).toContain('都给了');
    expect(text).toContain('agent_id');
    expect(text).toContain('L0/L1');
    expect(text).not.toContain('**');
  });

  it('什么都不认识时回落 message，再不行才是一句兜底', () => {
    expect(describeRequestError(new Error('boom'))).toBe('boom');
    expect(describeRequestError(undefined)).toBe('请求失败');
  });
});
