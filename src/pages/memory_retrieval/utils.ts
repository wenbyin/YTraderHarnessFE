// src/pages/memory_retrieval/utils.ts
// 纯函数层：入参整形 / 校验、枚举文案、游标翻页的状态机、格式化。
// 不碰 DOM、不碰 React，可以直接在 node 里跑断言（见 utils.test.ts）。
//
// 为什么单独一层：这里集中了「读契约最容易读错」的几处 ——
//   target 恰好一个 + agent_id 必填、**可选字段为空就整个不传**、
//   团队 scope 下 L0/L1 查不了、游标是不透明的、
//   `heat: null` 不是 0、`session_id` 不存在是 404 而不是空列表。
//   做成纯函数才钉得住；写错了不会报错，只会显示一个看着合理的错值。
//
// ⚠️ 2026-10-12 契约升到 v2.0.0：这一组端点从「检索」变成「浏览」。
//    本层随之删掉了 mode / score / matched_by / degraded_routes / include_content，
//    并把"翻页"从"条数上限"改成了**不透明游标**（见 CursorTrail）。
//
// ⚠️⚠️ 同日 v2.1.0 又把 L0/L1 放回了**汇总**端点（`retrieve.l0` / `retrieve.l1`
//    打开时以 `input` 为查询串真跑一轮召回）→ 本层因此：
//      · `input` 变回**必填**（那两层要拿它当召回查询串）；
//      · `DEFAULT_PREVIEW_LAYERS` / `DEFAULT_PREVIEW_LIMITS` 各多两个键；
//      · 新增 `PREVIEW_LAYER_ORDER` 与 `sortSectionsByLayer` —— 界面按 **L0 -> L3**
//        升序展示（后端返回的是 prompt 顺序，两者刻意相反）。
//    注意：这只影响**汇总预览**；三个 `/query/*` 浏览端点仍然是"浏览不是检索"，
//    它们的 `mode` / `score` 那套并没有回来。
import dayjs from 'dayjs';

import type {
  ConversationRecord,
  FactRecord,
  L0Order,
  L0QueryRequest,
  L1Order,
  L1QueryRequest,
  L2DetailRequest,
  L2Order,
  L2QueryRequest,
  MemoryLayer,
  MemoryPreviewLayers,
  MemoryPreviewLimits,
  MemoryRetrievalRequest,
  Pagination,
  PreviewLayer,
  PromptSection,
  RetrievalTarget,
  ScopeKind,
  SectionBlock,
  TargetRequest,
} from './data';

/** 契约里的时间都是 ISO 8601 字符串；null 表示"还没发生"。 */
export type TimeValue = string | null | undefined;

// ---------------------------------------------------------------- 枚举与文案

/**
 * 四层在**界面上**的顺序：**L0 -> L3 升序**。
 *
 * 用户 2026-10-12 明确要求两处都用它：
 *   · 汇总组装的「召回记忆的顺序」（`PromptView` 的 sections）；
 *   · 「检索条件的顺序」（汇总参数卡里那四个开关）。
 *
 * ⚠️ 它与**后端拼 prompt 的顺序相反**（那是 L3 -> L2 -> L0 -> L1，先给结论再给原始
 *    材料）。两者刻意不一致，别"顺手对齐"：人查这个页面是**从原始材料往上看到
 *    结论**。契约里 `sections` 那段描述写的是后端顺序，前端必须自己重排。
 */
export const PREVIEW_LAYER_ORDER: PreviewLayer[] = ['l0', 'l1', 'l2', 'l3'];

/** 同样的升序，只是元素类型是 `MemoryLayer`（给只认四层的通用工具用）。 */
export const LAYER_ORDER_L0_TO_L3: MemoryLayer[] = ['l0', 'l1', 'l2', 'l3'];

export interface LayerMeta {
  label: string;
  /** 这一层在汇总 sections 里对应哪个 block。 */
  block: SectionBlock;
  /** 一句话说明这一层是什么。 */
  short: string;
}

/**
 * 四层的展示元信息。
 *
 * ⚠️ 从 v2.1.0 起**四层都进汇总**（`retrieve.l0` / `retrieve.l1` 打开时
 *    `conversations` / `facts` 两段会出现），所以 `block` 不再是 null。
 */
export const LAYER_META: Record<MemoryLayer, LayerMeta> = {
  l0: {
    label: 'L0 原始对话',
    block: 'conversations',
    short: '原始消息，按需召回（命中的是截断片段）',
  },
  l1: {
    label: 'L1 原子记忆',
    block: 'facts',
    short: '提炼过的陈述，按需召回（正文不截断）',
  },
  l2: { label: 'L2 场景', block: 'scenes', short: '十几篇，列表只给索引' },
  l3: { label: 'L3 画像', block: 'persona', short: '最稳定，且永远只有一篇' },
};

/** block -> layer。给"这一段是哪一层"的文案用（也是排序的判据）。 */
export const BLOCK_LAYER: Record<SectionBlock, MemoryLayer> = {
  conversations: 'l0',
  facts: 'l1',
  scenes: 'l2',
  persona: 'l3',
};

/**
 * 把汇总的 `sections` 按 **L0 -> L3** 重排（用户 2026-10-12 要求）。
 *
 * ⚠️ 用 `slice()` 复制再排 —— 直接 `sort` 会就地改掉传进来的数组（那是
 *    响应对象的一部分，改了之后"原始顺序"就再也拿不回来了）。
 * ⚠️ 用 `indexOf(...)` 而不是查表：认不出的 block 会拿到 -1（排最前），比
 *    `undefined` 参与减法得到 `NaN`（排序结果**取决于引擎**）可控得多。
 */
export function sortSectionsByLayer(
  sections: PromptSection[],
): PromptSection[] {
  const order: SectionBlock[] = ['conversations', 'facts', 'scenes', 'persona'];
  return sections
    .slice()
    .sort((a, b) => order.indexOf(a.block) - order.indexOf(b.block));
}

export function layerLabel(layer: MemoryLayer): string {
  return LAYER_META[layer]?.label ?? layer;
}

export function roleLabel(role: 'user' | 'assistant'): string {
  return role === 'user' ? '用户' : '助手';
}

/**
 * L1 记忆的 type 文案。
 *
 * ⚠️ 契约明说它不是枚举（"词表会长"）→ 认不出的值**原样显示**，
 *    不要回落成「未知」：原值本身就是唯一的线索。
 */
const FACT_TYPE_LABEL: Record<string, string> = {
  persona: '画像',
  episodic: '情景',
  instruction: '指令',
};

export function factTypeLabel(type: string): string {
  return FACT_TYPE_LABEL[type] ?? type;
}

/**
 * priority 的文案。
 * **-1 是特殊值**：全局死命令（不是"最低优先级"）。其余照抄数字。
 */
export function priorityText(priority: number): string {
  return priority === -1 ? '全局死命令 (-1)' : `优先级 ${priority}`;
}

/** L1 type 的几个常见取值（给下拉用，但契约允许自由输入 —— 所以是 AutoComplete 不是 Select）。 */
export const FACT_TYPE_OPTIONS = ['persona', 'episodic', 'instruction'];

// ---------------------------------------------------------------- 排序枚举

export interface OrderOption<T extends string> {
  value: T;
  label: string;
}

export const L0_ORDERS: OrderOption<L0Order>[] = [
  { value: 'created_at_desc', label: 'created_at_desc · 新消息在前（默认）' },
  { value: 'created_at_asc', label: 'created_at_asc · 旧消息在前' },
  { value: 'session_seq_asc', label: 'session_seq_asc · 会话内正序' },
  { value: 'session_seq_desc', label: 'session_seq_desc · 会话内倒序' },
];

export const L1_ORDERS: OrderOption<L1Order>[] = [
  { value: 'updated_at_desc', label: 'updated_at_desc · 最近更新在前（默认）' },
  { value: 'updated_at_asc', label: 'updated_at_asc · 最早更新在前' },
  { value: 'priority_desc', label: 'priority_desc · 优先级高的在前' },
  { value: 'priority_asc', label: 'priority_asc · 优先级低的在前' },
];

export const L2_ORDERS: OrderOption<L2Order>[] = [
  { value: 'updated_at_desc', label: 'updated_at_desc · 最近更新在前（默认）' },
  { value: 'updated_at_asc', label: 'updated_at_asc · 最早更新在前' },
  { value: 'filename_asc', label: 'filename_asc · 按文件名' },
];

/**
 * `session_seq_*` 的排序只在给了 session_id 时才有意义（契约原话是"建议"）。
 * 拿它跨会话排，出来的顺序是"每个会话各自的序号混在一起"，读起来像乱的。
 */
export function orderWarning(
  order: string,
  hasSessionId: boolean,
): string | null {
  if (!hasSessionId && order.startsWith('session_seq')) {
    return 'session_seq_* 建议只与 session_id 一起用 —— 跨会话用它排序，看到的是各会话的 seq 混在一起。';
  }
  return null;
}

// ---------------------------------------------------------------- 条数

/**
 * 三个浏览端点的 limit 取值范围与默认值（抄契约的 minimum / maximum / default）。
 *
 * ⚠️ 与上一版最大的区别：v1 的 limit 是"召回几条"，v2 的 limit 是**一页几条**
 *    —— 它决定的是翻页的粒度，不再是"要不要多要一点"。
 */
export const QUERY_LIMITS: Record<
  'l0' | 'l1' | 'l2',
  { min: number; max: number; default: number; note: string }
> = {
  l0: {
    min: 1,
    max: 100,
    default: 20,
    note: '一页几条消息。原文一条可能很长（几百到几千字符），20 条已经不少了。',
  },
  l1: {
    min: 1,
    max: 100,
    default: 20,
    note: '一页几条原子记忆。一次写入/合并可以产出较多条，默认 20 够看一轮。',
  },
  l2: {
    min: 1,
    max: 100,
    default: 50,
    note: '一页几篇场景。一个 scope 的场景本来也就十几篇，默认 50 基本一页看完。',
  },
};

/**
 * 汇总预览里三层的条数上限（只有 l0/l1/l2 有 —— L3 一个 scope 只有一篇画像）。
 *
 * ⚠️ `l0` / `l1` 的区间是 **1..50**、契约默认 **10**，跟着**召回端点**走；`l2` 是
 *    **1..100**、默认 **12**。别把三行看成一类抄成同一组数字 —— 契约原话是
 *    "同一次召回的条数在预览与工具里必须是同一套口径"。
 *
 * ⚠️ `prefill` 与 `default` 是**两个概念**，别合成一个：
 *    · `default` = **契约默认**（yaml 与后端 `MemoryPreviewLimits` 都写 10），是**事实**，写进提示文案；
 *    · `prefill` = **本页表单里的起步值**（2026-10-12 用户指定 L0/L1 从 **5** 起步）——
 *      一次召回是真花钱的动作，预览默认取小一点，想多要自己调大（上限仍是 50）。
 *    发出去的就是表单里那个数，所以「预览里 5 条」与「Agent 不填时拿到的 10 条」
 *    **不是同一个答案** —— 这件事必须在界面上说出来，否则 5 会被读成"Agent 的默认条数"。
 */
export const PREVIEW_LIMIT_L0 = { min: 1, max: 50, default: 10, prefill: 5 };
export const PREVIEW_LIMIT_L1 = { min: 1, max: 50, default: 10, prefill: 5 };
/** 汇总预览里 L2 的条数（契约：1..100，默认 12）—— 它的 prefill 就等于契约默认。 */
export const PREVIEW_LIMIT_L2 = { min: 1, max: 100, default: 12, prefill: 12 };

/** 按 `PreviewSwitchMeta.limitKey` 查上/下限 —— 组件的通用查表入口。 */
export const PREVIEW_LIMIT_META: Record<
  'l0' | 'l1' | 'l2',
  { min: number; max: number; default: number; prefill: number }
> = {
  l0: PREVIEW_LIMIT_L0,
  l1: PREVIEW_LIMIT_L1,
  l2: PREVIEW_LIMIT_L2,
};

// ---------------------------------------------------------------- 汇总的两个旋钮

export type PreviewLayersInput = Required<MemoryPreviewLayers>;
export type PreviewLimitsInput = Required<MemoryPreviewLimits>;

/**
 * 契约默认：**L2/L3 开、L0/L1 关**。
 *
 * 这不是"省事"，是**成本的分界**：画像 + 场景索引是几句话的量级、每一轮都负担得起
 * （它们本来就是每轮都进上下文的）；L0/L1 是一次**真正的检索**（两路召回 + 融合 +
 * 条数），所以是按需的动作。默认关是刻意的，别"顺手全开"。
 */
export const DEFAULT_PREVIEW_LAYERS: PreviewLayersInput = {
  l0: false,
  l1: false,
  l2: true,
  l3: true,
};

export const DEFAULT_PREVIEW_LIMITS: PreviewLimitsInput = {
  l0: PREVIEW_LIMIT_L0.prefill,
  l1: PREVIEW_LIMIT_L1.prefill,
  l2: PREVIEW_LIMIT_L2.prefill,
};

export interface PreviewSwitchMeta {
  label: string;
  defaultOn: boolean;
  onNote: string;
  offNote: string;
  /** 这一层的条数上限键。L3 没有 —— 一个 scope 只有一篇画像。 */
  limitKey: 'l0' | 'l1' | 'l2' | null;
  /** 打开它意味着**真的跑一轮召回**（L0/L1），还是只是"多带一段现成内容"。 */
  recalls: boolean;
}

/**
 * 四个开关的文案。**顺序就是渲染顺序**（L0 -> L3，同 `PREVIEW_LAYER_ORDER`）。
 *
 * ⚠️ 界面上必须写清 `recalls` 这一档的区别：L0/L1 是"真的去召回"（花一次检索的
 *    代价，多一次 I/O），L2/L3 是"每轮都带的现成内容"。把两者说成同一件事，
 *    用户会以为四个开关一样便宜。
 */
export const PREVIEW_SWITCH_META: Record<PreviewLayer, PreviewSwitchMeta> = {
  l0: {
    label: LAYER_META.l0.label,
    defaultOn: false,
    onNote: '',
    offNote: '',
    limitKey: 'l0',
    recalls: true,
  },
  l1: {
    label: LAYER_META.l1.label,
    defaultOn: false,
    onNote: '',
    offNote: '',
    limitKey: 'l1',
    recalls: true,
  },
  l2: {
    label: LAYER_META.l2.label,
    defaultOn: true,
    onNote: '',
    offNote: '',
    limitKey: 'l2',
    recalls: false,
  },
  l3: {
    label: LAYER_META.l3.label,
    defaultOn: true,
    onNote: '',
    offNote: '',
    limitKey: null,
    recalls: false,
  },
};

/**
 * 预览要展示的层，按 **L0 -> L3 升序**（用户 2026-10-12 要求"检索条件也是排序"）。
 */
export function activePreviewLayers(
  layers: PreviewLayersInput,
): PreviewLayer[] {
  return PREVIEW_LAYER_ORDER.filter((layer) => layers[layer]);
}

/** 有没有开着一层"真的会召回"的（L0/L1）—— 决定 `input` 是否必须给。 */
export function anyRecallLayerOn(layers: PreviewLayersInput): boolean {
  return PREVIEW_LAYER_ORDER.some(
    (layer) => PREVIEW_SWITCH_META[layer].recalls && layers[layer],
  );
}

// ---------------------------------------------------------------- target

/** 界面上 target 的原始输入（都是字符串，可能是空串）。 */
export interface TargetInput {
  user_id: string;
  team_id: string;
  agent_id: string;
}

export const EMPTY_TARGET_INPUT: TargetInput = {
  user_id: '',
  team_id: '',
  agent_id: '',
};

/**
 * `agent_id` 的候选集 —— **暂时前端写死**（用户 2026-10-12 明确要求）。
 *
 * 为什么写死：契约里 `agent_id` 是**必填**的业务键（写入侧存的是 L1 记忆上的
 * `business_agent_id`，即 duty_key），但**没有任何接口能把可选 agent 列出来**
 * （Casdoor 目录里也没有它们）。当前实际在用的只有 `general` 一个，所以先做成
 * 只有一个选项的下拉框：手打 typo 从结构上消失，而传错的表现（**空结果**、
 * 不是报错）也就不会再无声发生。
 *
 * 后端能列出候选之后，把这一路换成那路数据即可 —— 组件不用改。
 */
export const AGENT_ID_OPTIONS: readonly string[] = ['general'];

/**
 * 打开页面时的默认 target：归属留空（**必须由用户明确选**），`agent_id` 给上
 * 唯一那个候选。
 *
 * ⚠️ 与 `EMPTY_TARGET_INPUT` 的区别是刻意的：那个是"什么都没选"的**语义**（测试
 *    与三种不合法形态的判断都靠它），这个是"**刚打开的样子**"（重置按钮要恢复
 *    的就是它）。两者混成一个就会要么让重置丢一个默认值、要么让"缺 agent_id"
 *    这一档永远测不到。
 */
export const DEFAULT_TARGET_INPUT: TargetInput = {
  ...EMPTY_TARGET_INPUT,
  agent_id: AGENT_ID_OPTIONS[0],
};

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : undefined;
}

/** 只看归属，不看 agent —— 预览"会被解析成哪种 scope"用这个就够。 */
export interface ScopeLike {
  user_id?: string;
  team_id?: string;
}

/**
 * 把界面上的输入整成契约要的 `RetrievalTarget`：**去空白 + 丢空值**。
 *
 * 为什么要丢空串而不是原样发：`user_id: ""` 在后端是一个**合法字符串**，
 * 会被当成"要查一个 user_id 为空串的人" —— 结果是空结果（或者直接被判成
 * "都没给"），而不是一条能读的报错。那种"静默查了个不存在的人"比参数错误
 * 难查得多。
 *
 * ⚠️ `agent_id` **恒出现**（哪怕还是空串）：契约把它列为 required，所以它在
 *    请求体里必须有位置。空串只可能出现在"还没填完"的**预览**里 ——
 *    发起前 `validateTarget` 会拦住（空串在后端也是"缺 agent_id"）。
 */
export function compactTarget(input: TargetInput): RetrievalTarget {
  const target: Partial<RetrievalTarget> = {
    agent_id: input.agent_id.trim(),
  };
  const userId = trimOrUndefined(input.user_id);
  const teamId = trimOrUndefined(input.team_id);
  if (userId) target.user_id = userId;
  if (teamId) target.team_id = teamId;
  return target as RetrievalTarget;
}

/**
 * 预览这个 target 会被解析成哪种 scope。
 *
 * ⚠️ 只在**恰好一个**归属时给值：两个都没给、两个都给，都返回 `null` ——
 *    契约的 `oneOf` 对这两种都不成立（都是 400），此时谈"解析成 user 还是 team"
 *    没有意义。
 */
export function resolveScopeKind(target: ScopeLike): ScopeKind | null {
  const userId = trimOrUndefined(target.user_id);
  const teamId = trimOrUndefined(target.team_id);
  if (userId && !teamId) return 'user';
  if (teamId && !userId) return 'team';
  return null;
}

/** 只问"是不是团队 scope" —— 团队下 L0/L1 查不了，界面上要据此提示。 */
export function isTeamTarget(target: ScopeLike): boolean {
  return resolveScopeKind(target) === 'team';
}

/**
 * 把 target 切到另一侧 —— **顺手把另一侧清掉**。
 *
 * ⚠️ "恰有一个"是**结构上保证**的（切换即清空），不是靠事后校验：所以界面上发不出
 *    "两个都给"这个必然 400 的形态。`validateTarget` 里那条 `both` 只是纯函数层兜底。
 *
 * 2026-10-12：开关从参数区挪到了左侧那张卡的**卡头**，与 ScopeFields 不在一处，
 * 所以这段"切换 + 清另一侧"抽成纯函数，由页面的 state 驱动（见 `useScopeSwitch`）。
 */
export function switchScopeTarget(
  target: TargetInput,
  next: ScopeKind,
): TargetInput {
  return next === 'team'
    ? { ...target, user_id: '' }
    : { ...target, team_id: '' };
}

/**
 * 团队 scope 下这一层**今天查不了**（契约"当前能力边界"明写）。
 *
 *     当前 L0/L1 查询路径不能按 team_id 过滤团队全部消息/原子记忆
 *
 * 契约里三条都写了：汇总端点**不组装** L0/L1（所以它不受影响）、
 * L0/L1 查询**返回 400**、L2/L3 两种 scope 都行。所以这条判断只用于
 * **拦在发起处**（不发那个必然 400 的请求）。
 */
export function layerUnavailableForTarget(
  layer: MemoryLayer,
  target: ScopeLike,
): boolean {
  return isTeamTarget(target) && (layer === 'l0' || layer === 'l1');
}

/**
 * target 三种不合法形态的文案。
 *
 * ⚠️ 界面上有「个人 / 团队」开关（左侧卡头那个 ScopeSwitch），它**切走时会清掉另一侧**
 *    —— 所以 `both`（两个都给）在 UI 上发不出来，这一条是给纯函数层兜底的
 *    （直接构造 state、或者以后有别的入口时才用得上）。`none` 则很常见：
 *    开关选了「个人」但还没从目录里选人。
 */
export type TargetProblem = 'none' | 'both' | 'agent';

export const TARGET_PROBLEM_TEXT: Record<TargetProblem, string> = {
  none: 'user_id 与 team_id「恰有一个」，当前这一侧还是空的',
  both: 'user_id 与 team_id「不能同时给」（写入侧两个都在时 org 赢）',
  agent: 'agent_id 必填',
};

/** 判定 target 能不能发出去。合法返回 null。 */
export function targetProblem(input: TargetInput): TargetProblem | null {
  const userId = trimOrUndefined(input.user_id);
  const teamId = trimOrUndefined(input.team_id);
  if (!userId && !teamId) return 'none';
  if (userId && teamId) return 'both';
  if (!trimOrUndefined(input.agent_id)) return 'agent';
  return null;
}

/** 纯文本版（界面上的告警块不渲染 markdown，星号会原样露出来）。 */
export function targetProblemText(problem: TargetProblem): string {
  return TARGET_PROBLEM_TEXT[problem].replace(/\*\*/g, '');
}

/** 发起前拦住不合法的 target —— 它必然 400，与其发一个必错的请求不如不发。 */
export function validateTarget(input: TargetInput): string | null {
  const problem = targetProblem(input);
  return problem ? targetProblemText(problem) : null;
}

/** 必填文本（L2 详情的 filename）。契约里它是 minLength: 1。 */
export function validateRequiredText(
  value: string,
  label: string,
): string | null {
  return value.trim() ? null : `${label}不能为空。`;
}

/** L1 的 priority：契约 minimum -1 / maximum 100。null = 不筛。 */
export function validatePriority(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return 'priority 必须是整数（-1 表示全局指令，普通优先级 0-100）。';
  }
  if (value < -1 || value > 100) {
    return `priority 超出契约范围：-1..100（当前 ${value}）。`;
  }
  return null;
}

/** 一页几条：越界就拦在发起处（后端会 400）。 */
export function validateLimit(
  value: number,
  kind: 'l0' | 'l1' | 'l2',
): string | null {
  const meta = QUERY_LIMITS[kind];
  if (!Number.isInteger(value) || value < meta.min || value > meta.max) {
    return `limit 需要在 ${meta.min}..${meta.max} 之间（当前 ${value}）。`;
  }
  return null;
}

// ---------------------------------------------------------------- 翻页（累积式）

/**
 * 列表端点是不透明游标分页：响应给 `{items, page: {limit, next_cursor, has_more}}`，
 * 下一页要把这一页的 `next_cursor` 原样带回。
 *
 * 界面用的是「卡片流 + 加载更多」（用户选定的形态）：翻页**只往前走、条目累积**，
 * 所以这里不需要"上一页"那套状态机 —— 只要回答两个问题：
 *
 *   1. **还能不能往下加载**（`canLoadMore`）；
 *   2. **现在手里这个游标是不是还属于当前这套筛选**（`listSignature`）。
 *
 * ⚠️ "还有下一页"必须看 `has_more`，**不是** `next_cursor !== null` —— 契约把两个
 *    字段都列了，拿后者当判据在两者不一致时（服务端实现细节）会显示错。
 */
export function canLoadMore(page: Pagination | null | undefined): boolean {
  return Boolean(page?.has_more);
}

/**
 * 一次列表请求里"筛选项"的签名（**剔除游标**）。
 *
 * 为什么要它：游标是**不透明**的，它绑死在"服务端当时那套排序键 + 筛选"上。用户
 * 改了筛选却还能点"加载更多"，就会把 **A 筛选的第 1 页** 和 **B 筛选的第 2 页**
 * 拼成一条流 —— 中间那一段谁也没见过，界面上还完全看不出来。
 *
 * 所以发起时把签名连同结果一起存下来，之后拿当下的签名去比：不一致 → 按钮灰掉
 * （要接着往下看，就重新"执行"一次，从第一页重新累积）。
 *
 * ⚠️ 依赖 `JSON.stringify` 的键顺序 —— 请求体都是 `buildXxxQueryRequest` 造的，
 *    同一份输入键序恒定，所以这个签名是稳的。
 */
export function listSignature(body: object): string {
  const copy: Record<string, unknown> = {
    ...(body as Record<string, unknown>),
  };
  delete copy.cursor;
  return JSON.stringify(copy);
}

// ---------------------------------------------------------------- 请求构造

export interface ScopeInput {
  target: TargetInput;
  session_id: string;
}

export interface AggregateInput {
  /** 本轮用户输入。**必填**，而且打开 L0/L1 时它就是召回查询串。 */
  input: string;
  retrieve: PreviewLayersInput;
  limits: PreviewLimitsInput;
}

export interface L0Input {
  roles: Array<'user' | 'assistant'>;
  time_from: string | null;
  time_to: string | null;
  text_contains: string;
  limit: number;
  order: L0Order;
}

export interface L1Input {
  type: string;
  priority: number | null;
  scene_name: string;
  updated_from: string | null;
  updated_to: string | null;
  text_contains: string;
  limit: number;
  order: L1Order;
}

export interface L2Input {
  filename_contains: string;
  limit: number;
  order: L2Order;
}

export const DEFAULT_L0_INPUT: L0Input = {
  roles: [],
  time_from: null,
  time_to: null,
  text_contains: '',
  limit: QUERY_LIMITS.l0.default,
  order: 'created_at_desc',
};

export const DEFAULT_L1_INPUT: L1Input = {
  type: '',
  priority: null,
  scene_name: '',
  updated_from: null,
  updated_to: null,
  text_contains: '',
  limit: QUERY_LIMITS.l1.default,
  order: 'updated_at_desc',
};

export const DEFAULT_L2_INPUT: L2Input = {
  filename_contains: '',
  limit: QUERY_LIMITS.l2.default,
  order: 'updated_at_desc',
};

/**
 * 汇总请求。
 *
 * ⚠️ `input` **必填且无条件带上**（v2.1.0 起；v2.0.0 一度可选）。它是 L0/L1 召回
 *    的查询串，所以绝不能像其它可选字段那样"空就不传" —— 空串由 `preflight` 拦在
 *    发起处，这里不做兜底（构造请求是纯函数，它没资格替用户改主意）。`trim` 之后
 *    仍可能是空串，那是"还没填完"的预览态，不是一份能发出去的请求。
 *
 * ⚠️ `retrieve` / `limits` **每次都显式带上**（含 `false` 与默认条数）：
 *    契约的默认是 l2/l3 开、l0/l1 关，用户一旦把某层**关掉**，省略这个键就会让
 *    后端回落成默认 —— 症状是"我关了它，它还在"。这两个键是"显式表达意图"的载体。
 */
export function buildAggregateRequest(
  target: TargetInput,
  agg: AggregateInput,
): MemoryRetrievalRequest {
  return {
    target: compactTarget(target),
    input: agg.input.trim(),
    retrieve: { ...agg.retrieve },
    limits: { ...agg.limits },
  };
}

/**
 * 汇总的 `input` 校验（拦在发起处）。
 *
 * 空 input 在契约里是 `minLength: 1` 违规 → **必然 400**。为什么这条不能省：
 * 打开 L0/L1 之后这个请求是"要拿它去真召回"的，一个空查询串发出去要么静默不召回
 * （用户看到"这一段是空的"，以为这个人没有原始对话），要么报一个与原因无关的错。
 */
export function validateAggregateInput(input: string): string | null {
  if (!input.trim()) {
    return 'input 必填 —— 汇总端点会用它在 L0/L1 上真跑一轮召回（开了这两层却没给查询串，服务端只能二选一：静默不召回，或报一个与原因无关的错）。';
  }
  return null;
}

/**
 * 三个浏览请求的共同省略规则：**可选字段为空就整个不传**。
 *   - `text_contains` 空 = 不筛；传空串违反 minLength: 1。
 *   - L0 的 `roles` 空 = 两种角色都要；传 `[]` 在契约里没有定义（别去试）。
 *   - `cursor` 首页传 null（＝不传），契约允许 null，但我统一**不传**，免得
 *     多一个"空游标"的语义要靠后端兜。
 *   - `order` 不传 = 契约默认，但我**总是显式带上**：它与 limit 一样属于
 *     "用户明确选过的意图"，省略会让界面显示的顺序与请求的顺序悄悄不一致。
 */
export function buildL0QueryRequest(
  scope: ScopeInput,
  input: L0Input,
  cursor: string | null,
): L0QueryRequest {
  const body: L0QueryRequest = {
    target: compactTarget(scope.target),
    limit: input.limit,
    order: input.order,
  };
  const sessionId = trimOrUndefined(scope.session_id);
  if (sessionId) body.session_id = sessionId;
  if (input.roles.length) body.roles = [...input.roles];
  if (input.time_from) body.time_from = input.time_from;
  if (input.time_to) body.time_to = input.time_to;
  const text = trimOrUndefined(input.text_contains);
  if (text) body.text_contains = text;
  if (cursor) body.cursor = cursor;
  return body;
}

export function buildL1QueryRequest(
  target: TargetInput,
  input: L1Input,
  cursor: string | null,
): L1QueryRequest {
  const body: L1QueryRequest = {
    target: compactTarget(target),
    limit: input.limit,
    order: input.order,
  };
  const type = trimOrUndefined(input.type);
  if (type) body.type = type;
  if (input.priority !== null) body.priority = input.priority;
  const sceneName = trimOrUndefined(input.scene_name);
  if (sceneName) body.scene_name = sceneName;
  if (input.updated_from) body.updated_from = input.updated_from;
  if (input.updated_to) body.updated_to = input.updated_to;
  const text = trimOrUndefined(input.text_contains);
  if (text) body.text_contains = text;
  if (cursor) body.cursor = cursor;
  return body;
}

export function buildL2QueryRequest(
  target: TargetInput,
  input: L2Input,
  cursor: string | null,
): L2QueryRequest {
  const body: L2QueryRequest = {
    target: compactTarget(target),
    limit: input.limit,
    order: input.order,
  };
  const filename = trimOrUndefined(input.filename_contains);
  if (filename) body.filename_contains = filename;
  if (cursor) body.cursor = cursor;
  return body;
}

/** L2 详情：filename 是**必填**（minLength 1），且是精确匹配（不是包含）。 */
export function buildL2DetailRequest(
  target: TargetInput,
  filename: string,
): L2DetailRequest {
  return {
    target: compactTarget(target),
    filename: filename.trim(),
  };
}

/** L3：只有 target —— 一个 scope 只有一篇画像，这是"取"而不是"查"。 */
export function buildL3Request(target: TargetInput): TargetRequest {
  return { target: compactTarget(target) };
}

// ---------------------------------------------------------------- 降级与提示词

/**
 * 把 degraded 说成一句人话。
 *
 * 契约要求"必须如实汇报"—— 这块**不能**在界面上被吞掉：静默少一段会被
 * 读成"这个人没有画像 / 没有场景"，而那是另一个事实。
 */
export function describeDegraded(
  layers: Array<{ layer: PreviewLayer; reason: string }> | undefined,
): string {
  if (!layers?.length) return '';
  return layers
    .map((item) => `${layerLabel(item.layer)}：${item.reason}`)
    .join('；');
}

/**
 * 汇总响应里 `prompt.system` 的三态。
 *
 * ⚠️ 三态必须分开：`null` = 那份提示词**还没写**（模块还没落地）；空串 = 写了
 *    但是空的。把前者显示成一个空框，会被读成"提示词是空的"。
 */
export type SystemPromptState =
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'text'; text: string };

export function systemPromptState(
  system: string | null | undefined,
): SystemPromptState {
  if (system === null || system === undefined) return { kind: 'missing' };
  if (!system.trim()) return { kind: 'empty' };
  return { kind: 'text', text: system };
}

// ---------------------------------------------------------------- 格式化

/**
 * 把契约里的 datetime 字符串格式化成人看的时刻。
 *
 * ⚠️ 无效值一律回落 `'—'`，**绝不回落到 0 / 1970** —— 那会让"没有这个时间"
 *    看起来像"发生在一九七零年"。
 */
export function formatTime(value: TimeValue): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm:ss') : '—';
}

/**
 * 相对时间。
 *
 * ⚠️ 自己算，不用 dayjs 的 fromNow()：那个方法要 dayjs.extend(relativeTime)，
 *    而项目只在 umi 的运行时插件里注册过它 —— 单测里没有那一层，会直接
 *    `TypeError: fromNow is not a function`；而且它的文案跟 dayjs 的 locale 走，
 *    项目没设 zh-cn，渲染出来是 "3 minutes ago"。
 */
export function fromNow(value: TimeValue, now: number = Date.now()): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  if (!parsed.isValid()) return '—';

  const diff = now - parsed.valueOf();
  const ahead = diff < 0;
  const abs = Math.abs(diff);
  const unit = (n: number, name: string) =>
    ahead ? `${n} ${name}后` : `${n} ${name}前`;

  if (abs < 60_000) return '刚刚';
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return unit(minutes, '分钟');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, '小时');
  const days = Math.floor(hours / 24);
  return unit(days, '天');
}

/** UUID 短码：一行 36 个字符太占地方。 */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * 场景热度文案。
 * ⚠️ null 是"没写 / 解析不出整数"，**不是 0** —— 两者要说不同的话。
 */
export function heatText(heat: number | null | undefined): string {
  if (heat === null || heat === undefined) return '热度未知';
  return `热度 ${heat}`;
}

/** L2 的 summary 为空串是"存量场景没写 META"这个事实，不是"没取到"。 */
export function sceneSummaryText(summary: string): string {
  return summary ? summary : '（该场景没写 META，没有摘要）';
}

/**
 * 分段里 `truncated` 的说明。
 *
 * ⚠️ v2 的截断只可能与**这一段的条数上限**有关，不是内容被切了半个句子 ——
 *    L1 正文整条返回、不截断（契约明说）。
 */
export function truncatedText(truncated: boolean | undefined): string {
  return truncated
    ? '已达本次条数上限，还有更多没有返回 —— 调大 limits 或换更精确的筛选。'
    : '未截断。';
}

/**
 * 游标分页里"这一页是不是最后一页"的说明。
 * 拿 `has_more` 说事，不拿 `next_cursor`（见 canFetchNextPage）。
 */
export function pageSummaryText(
  returned: number,
  page: { has_more: boolean } | null | undefined,
): string {
  if (!page) return `本页 ${returned} 条`;
  return page.has_more
    ? `本页 ${returned} 条 · 还有下一页`
    : `本页 ${returned} 条 · 已到最后一页`;
}

/** L3 的 persona 是否"还没生成过"（正常状态，不是错误）。 */
export function personaMissing(response: {
  persona: { content: string } | null;
}): boolean {
  return response.persona === null;
}

/** 一条 L1 记忆是否承载"全局死命令"。 */
export function isHardRule(fact: Pick<FactRecord, 'priority'>): boolean {
  return fact.priority === -1;
}

/** L0 记录在列表里的展示序号（配合会话内 seq 用 —— 两者不是一回事）。 */
export function seqText(item: Pick<ConversationRecord, 'seq'>): string {
  return `seq ${item.seq}`;
}

// ---------------------------------------------------------------- 错误解析

/** 错误体的两种可能形状：契约的 {code, message} 与 FastAPI 的 {detail}。 */
export interface RequestErrorShape {
  response?: {
    status?: number;
    data?: { detail?: unknown; code?: unknown; message?: unknown };
  };
  data?: { detail?: unknown; code?: unknown; message?: unknown };
  status?: number;
  message?: string;
}

/**
 * 把 request 抛出来的错误说成一句人话。
 *
 * ⚠️ 两个位置都要看：@umijs/max 的 request 就是 axios，**错误体在
 *    `error.response.data`**，不是 `error.data`。只写一个的后果是后端给的中文原因
 *    被丢掉，界面上只剩一句「HTTP 403」——完全没法排查。
 *
 * ⚠️ v2 的契约把错误体定义成了 `ErrorResponse {code, message}`
 *    （"align code and message with the application's common error response"），
 *    而上一版后端实际给的是 FastAPI 的 `detail`（string 或 422 的数组）。
 *    两种都读 —— 契约换壳的时候前端不该跟着聋。
 */
export function describeRequestError(error: unknown): string {
  const err = (error ?? {}) as RequestErrorShape;
  const body = err.response?.data ?? err.data;
  const detail = body?.detail;
  const status = err.response?.status ?? err.status;

  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      const msg = (item as { msg?: unknown } | null)?.msg;
      return typeof msg === 'string' ? msg : JSON.stringify(item);
    });
    if (parts.length) return parts.join('；');
  }
  if (typeof body?.message === 'string' && body.message.trim()) {
    const code =
      typeof body.code === 'string' && body.code ? `（${body.code}）` : '';
    return `${body.message}${code}`;
  }

  if (status === 400) {
    return '400：入参不成立 —— target 里 user_id 与 team_id 都没给、或者都给了（契约的 oneOf 要求恰好一个）；target 缺 agent_id；limit 越界；priority 越界；或者团队 scope 调了 L0/L1 查询（这两层没有按 team 过滤的路径）。';
  }
  if (status === 403) {
    return '403：调用者没有 Y-Trader-Admin 角色（契约要求 roles 里精确包含它）。注意本地开发时鉴权开关关掉、bypass 身份里的 roles 是刻意留空的 —— 所以「本地能跑」不代表这些端点能通，要调它得走真 token。后端对 403 的文案刻意含糊，线索在服务端日志。';
  }
  if (status === 404) {
    return '404：指定的 session_id 或场景 filename 不存在。注意「这次没筛到东西」是 200 + 空列表，不是 404 —— 见到它就是 id / 文件名真的给错了。';
  }
  if (typeof err.message === 'string' && err.message) return err.message;
  return '请求失败';
}

/** 供外部按需引用的契约类型别名（页面与组件都用得到）。 */
export type { MemoryLayer, MemoryPreviewLayers, MemoryPreviewLimits };
