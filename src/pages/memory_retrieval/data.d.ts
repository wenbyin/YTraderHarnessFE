// src/pages/memory_retrieval/data.d.ts
//
// 严格对齐 YTraderHarness 的 app/services/memory/memory_api_v2.yaml（**v2.1.0**）。
//
// ⚠️ 2026-10-12 的 v2.0.0 把这一组端点**从「检索」改成了「浏览」**，是破坏性的：
//
//   1. 路径：`/memory/retrieval/l0|l1|l2|l3` -> **`/memory/query/l0|l1|l2|l3`**，
//      并新增 **`/memory/query/l2/detail`**（按 filename 取场景全文）。汇总端点
//      `/memory/retrieval` 路径不变，但请求体变小了。
//   2. **L0/L1 不再召回**：没有 `mode`（hybrid/keyword/vector）、没有 `query`、
//      没有 `score` / `matched_by` / `degraded_routes`。它们是**分页浏览已经保存的
//      记录**：`query` -> `text_contains`（**字面包含，契约明说不是语义检索**）。
//      L0 返回**完整消息正文**（不再是"命中片段"）。
//   3. **列表接口全部改成不透明游标分页**：`{items, page: {limit, next_cursor,
//      has_more}}`，另有每层不同的 `order` 枚举。`limit` 上限 100。
//   4. **`session_id` 从汇总端点移除**，而且只有 L0 查询还吃它（L1 不再吃）。
//
// ⚠️⚠️ 同日晚些时候契约升到 **v2.1.0**，把 L0/L1 **重新放回了汇总端点** —— 但语义
//     与 v1 相反，这是这一版最容易读错的地方：
//
//   5. `retrieve` 又是四层了（`l0` / `l1` 默认 **false**，`l2` / `l3` 默认 true）。
//      它们**不是** v1 那种"要不要把自动召回的结果也带上"—— 打开 `retrieve.l0` /
//      `retrieve.l1` 时，服务端会**以 `input` 为查询串真的跑一轮混合召回**
//      （两路召回 + 融合 + 截断，与 Agent 调 `memory.search` 同一条实现）。
//      所以 `input` 因此变成**必填**（`minLength: 1`，请求体 required）：
//      「开了 L0 却没输入」只剩"静默不召回"或"报一个与原因无关的错"两种坏选择。
//   6. 因此汇总的 `sections` 又可能带 **`conversations`（L0）/ `facts`（L1）** 两段，
//      它们的条目是**召回命中**（`score` + `matched_by`），不是浏览记录 ——
//      与 `/query/l0` 返回的 `ConversationRecord` 是**两个 schema**（`text` 在命中的
//      那边是**截断片段**，在浏览那边是整条正文）。`limits` 也多了 `l0` / `l1`
//      （1..50，默认 10，跟着召回端点走）。
//   7. ⚠️ 这两段**没有 `truncated`** —— 召回是 top-K 不是分页，"还有没有更多"没有
//      定义（`limit` 就是答案的边界）；反过来它们有 `degraded_routes`（层内某一路
//      挂了），那是 persona / scenes 没有的。见 `SectionBase` 的两个子形状。
//   8. 团队 target 下这两层**开不起来**（`agent_message` 没有 org 列、
//      `memory_atom` 的 org_id 不参与过滤）。契约刻意不让汇总整单 400：此时它们
//      **不出现在 `sections` 里，而是进顶层 `degraded`** 并说明原因。
//
// 字段名**逐字照抄契约的 snake_case**。类型也照抄契约的 required / oneOf：
//   format: date-time  -> string（ISO 8601）
//   type: [X, 'null']  -> X | null（**不是可选**：后端会显式返回 null）
//
// 本文只管类型。运行时常量（枚举清单、默认值、上下限）在 utils.ts ——
// .d.ts 里写不了运行时值。

/** 由 `target` 解析出来的归属类型。 */
export type ScopeKind = 'user' | 'team';

/** 四层记忆（只用于"这一层叫什么"的文案与团队 scope 的能力边界判断）。 */
export type MemoryLayer = 'l3' | 'l2' | 'l1' | 'l0';

/**
 * 汇总响应里 sections 的四种可能取值（契约里 `PromptSection` 的 discriminator）。
 *
 * ⚠️ v2.0.0 一度只剩 persona / scenes（`conversations` / `facts` 连同 L0/L1 的召回
 *    一起被砍掉）；**v2.1.0 又加回来了** —— 打开 `retrieve.l0` / `retrieve.l1` 时
 *    这两段会出现（见文件头第 6 条）。
 */
export type SectionBlock = 'persona' | 'scenes' | 'conversations' | 'facts';

/** 汇总预览里可选的四种 layer 开关（`l0` / `l1` 默认关，`l2` / `l3` 默认开）。 */
export type PreviewLayer = 'l0' | 'l1' | 'l2' | 'l3';

/**
 * 查询条件：**(user_id / team_id 恰好一个) + agent_id**。
 *
 * 契约这次把它写成了正经的 `oneOf: [required(user_id), required(team_id)]` ——
 * "两个都给"与"两个都没给"一样不合法（`oneOf` 要**恰好**满足一个）。界面上用一个
 * 开关从结构上保证这件事（见 components/Fields.tsx 的 ScopeFields）。
 */
export interface RetrievalTarget {
  /** 个人记忆的归属用户（Casdoor 的 sub）。与 team_id **恰好一个**。 */
  user_id?: string;
  /**
   * 团队记忆的归属组织。与 user_id **恰好一个**。
   *
   * ⚠️ **库里那一列叫 `org_id`**（JWT 的 org claim 写进 `agent_session.org_id`）
   *    —— 同一个东西两个名字。契约与前端统一叫 team。
   */
  team_id?: string;
  /**
   * 归属的 agent。写入侧取的是 L1 记忆上的 `business_agent_id`（duty_key）。
   *
   * **必填**：它的缺省值 `default` 是个兜底，不该出现在查询入口。传错的表现是
   * **空结果**而不是报错（一个 scope 下没有数据，与"scope 写错了"长得一样），
   * 所以必须显式给。
   */
  agent_id: string;
}

// ---------------------------------------------------------------- 分页

/**
 * 不透明游标分页。
 *
 * ⚠️ `next_cursor` 是**不透明**的：前端不要解析它、不要自己造、也不要拿它当
 *    排序键的替身（契约说服务端用稳定排序键 + 唯一键做边界）。唯一正确的用法
 *    是原样回传。
 *
 * ⚠️ `has_more` 与 `next_cursor !== null` 说的**不是**同一件事 —— 两个字段都在，
 *    且 `next_cursor` 允许为 null。显示"还有下一页"看 `has_more`，发下一页请求
 *    用它给的 `next_cursor`。
 */
export interface Pagination {
  limit: number;
  next_cursor: string | null;
  has_more: boolean;
}

// ---------------------------------------------------------------- 记录形状

export interface PersonaRecord {
  /** 整篇 persona.md（含 META 块），**不截断**。 */
  content: string;
  /** 恒为 `persona.md`。带上是为了让渲染方不用知道这个约定。 */
  filename: string;
  /** 乐观锁基线（写入侧每次改写 +1）。对读方是"改过几次"。 */
  version: number;
  updated_at: string;
}

/**
 * 场景**索引**（列表接口只给这个）。
 *
 * ⚠️ v2 把"摘要"与"全文"拆成了两个类型、两个接口：列表恒为 `SceneSummary`
 *    （没有 content），要全文走 `/memory/query/l2/detail`。上一版那个
 *    `include_content` 开关**没有了** —— 正文现在只有一个入口。
 */
export interface SceneSummary {
  /** 场景文件名。**它是这一段的身份** —— L1 记忆上的 scene_name 与它同源。 */
  filename: string;
  /**
   * META 块里的摘要。可能为空（存量场景没写 META）——
   * **空串是"没有摘要"这个事实，不是"没取到"**。
   */
  summary: string;
  /**
   * 热度（新建 1 / 更新 旧+1 / 合并 sum+1）。
   * 没写或解析不出整数时为 **null —— 不是 0**（0 是一个有意义的取值）。
   */
  heat: number | null;
  version: number;
  updated_at: string;
}

/** 场景全文（`/memory/query/l2/detail` 的返回）。 */
export interface SceneDetail extends SceneSummary {
  /** 场景全文（含 META 块）。 */
  content: string;
}

export interface FactRecord {
  /**
   * ⚠️ 只在**一次写入内**稳定：merge 保留存活行的 id、删掉被它吃掉的那几条。
   * 持有长期引用的调用方要接受这件事。
   */
  record_id: string;
  /** 记忆陈述，整条返回，不截断。 */
  content: string;
  /** persona / episodic / instruction（work_* 四类还没做）。词表会长，刻意**不是**枚举。 */
  type: string;
  /**
   * 0-100，**-1 = 全局死命令**。
   * ⚠️ **不参与排序与过滤** —— 返回它是让调用方（尤其是模型）自己权衡。
   */
  priority: number;
  /** 这条记忆所属的情境名（与 L2 的场景文件名同源，自由文本）。可能为 null。 */
  scene_name?: string | null;
  version: number;
  /**
   * 提示词推出来的时间线主值（TEXT，可能是「2018 年」这类半成品）。
   * ⚠️ **不要拿它做范围过滤** —— 要么报错要么静默错。
   */
  timestamp_str?: string | null;
  /** 最后一次被写入 / 合并的时间（增量对账也是按它）。 */
  updated_at: string;
}

export interface ConversationRecord {
  message_id: string;
  session_id: string;
  /** 会话内序号（取邻居、翻页都用它；允许有空洞）。 */
  seq: number;
  role: 'user' | 'assistant';
  /**
   * ⚠️ v2 返回的是**完整消息正文**（不是召回命中的片段）。
   *    上一版那套"命中片段 + score + matched_by"是检索接口的产物，浏览接口没有。
   */
  text: string;
  created_at: string;
}

// ---------------------------------------------------------------- 汇总请求 / 响应

export interface MemoryPreviewLayers {
  /** 是否真的跑一轮 L0 原始消息召回。默认关闭。 */
  l0?: boolean;
  /** 是否真的跑一轮 L1 原子记忆召回。默认关闭。 */
  l1?: boolean;
  /** 是否包含 L2 场景索引，默认开启。 */
  l2?: boolean;
  /** 是否包含 L3 画像，默认开启。 */
  l3?: boolean;
}

/**
 * 各层的数量上限。
 *
 * ⚠️ `l0` / `l1` 的取值范围（1..50，默认 10）**跟着召回端点走** —— 契约原话：
 *    "同一次召回的条数在预览与工具里必须是同一套口径，否则「预览里看到 5 条」与
 *    「Agent 拿到 10 条」会被当成两个答案"。所以别照 L2 的 1..100 去套。
 *    **没有 `l3`**：一个 scope 只有一篇画像。
 */
export interface MemoryPreviewLimits {
  /** L0 召回最多返回几条（融合之后截断）。1..50，默认 10。 */
  l0?: number;
  /** L1 召回最多返回几条（融合之后截断）。1..50，默认 10。 */
  l1?: number;
  /** 最多返回的场景索引数量。1..100，默认 12。 */
  l2?: number;
}

export interface MemoryRetrievalRequest {
  target: RetrievalTarget;
  /**
   * 本轮的用户输入。**必填**（`minLength: 1`）。
   *
   * ⚠️ v2.0.0 里它是可选的（"只用于回显"），v2.1.0 **变回必填** —— 因为
   *    `retrieve.l0` / `retrieve.l1` 打开时要拿它当**召回查询串**。契约原话：
   *    缺了它「开了 L0 却没输入」就只剩"静默不召回"或"报一个与原因无关的错"
   *    两种坏选择。所以前端**必须拦在发起处**，不能构造请求时兜底。
   */
  input: string;
  retrieve?: MemoryPreviewLayers;
  limits?: MemoryPreviewLimits;
}

/** 各段共有的形状。`title` 是**建议**的小节标题，渲染方可以不用。 */
export interface SectionBase {
  title: string;
  returned: number;
}

/**
 * `persona` / `scenes` 这两段多一个 `truncated`。
 *
 * ⚠️ 「截断」只对**分页式**的两层有意义（L2 条数上限、L3 虽然恒 ≤1 条但契约仍给了
 *    这个字段）。召回式的两层**没有**这个字段 —— 见 `RecallHitSection` 的注释。
 */
export interface TruncatableSection extends SectionBase {
  truncated: boolean;
}

/**
 * `conversations` / `facts` 这两段（**召回命中的结果**）多一个 `degraded_routes`
 * 而且**没有 `truncated`**。
 *
 * ⚠️ 两层都不能只看"有没有这段话"：
 *   · `degraded_routes` 与顶层 `degraded` **不是一回事** —— 顶层说的是"这一层整体
 *     没查成"（那一层就没有 section），这个说的是"这一层查成了、但其中一路挂了"
 *     （有 section，带着另一路的结果）。契约特地分开是刻意的。
 *   · 没有 `truncated` 是因为召回是 top-K：融合分是**相对**的，`limit` 就是答案的
 *     边界，"还有没有更多"没有定义。要更多就调大 `limits.l0` / `limits.l1`。
 */
export interface RecallHitSection extends SectionBase {
  degraded_routes: DegradedHitRoute[];
}

export interface PersonaSection extends TruncatableSection {
  block: 'persona';
  layer: 'l3';
  /** 0 或 1 条 —— 一个 scope 只有一篇画像。 */
  items: PersonaRecord[];
}

export interface SceneSection extends TruncatableSection {
  block: 'scenes';
  layer: 'l2';
  /** 只有索引字段（filename + summary + heat），**没有 content**。 */
  items: SceneSummary[];
}

export interface ConversationHitSection extends RecallHitSection {
  block: 'conversations';
  layer: 'l0';
  /** 按融合分降序。 */
  items: ConversationHit[];
}

export interface FactHitSection extends RecallHitSection {
  block: 'facts';
  layer: 'l1';
  /** 按融合分降序。 */
  items: FactHit[];
}

export type PromptSection =
  | PersonaSection
  | SceneSection
  | ConversationHitSection
  | FactHitSection;

/** 一路召回。两层的取值域相同。 */
export type RecallRoute = 'keyword' | 'vector';

/**
 * L0 召回的一条命中。
 *
 * ⚠️ `text` 是**截断后的片段**（400 字符，因为它的消费者是模型），与
 *    `ConversationRecord.text`（`/query/l0` 的整条消息）**不是一回事** ——
 *    契约里是两个独立 schema，就是因为这个差别。
 */
export interface ConversationHit {
  message_id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant';
  /** 命中的**片段**（截断过），不是整条消息。 */
  text: string;
  created_at: string;
  /** 融合分，越大越相关。**只在本次响应内可比**。 */
  score: number;
  /** 这条被哪几路召回到。 */
  matched_by: RecallRoute[];
}

/**
 * L1 召回的一条命中。
 *
 * ⚠️ `content` **不截断**（与 L0 的片段相反）：这边已经是提炼过的陈述，
 *    截断可能把「用户喜欢 X，但不能 Y」切掉后半句。
 */
export interface FactHit {
  /** 记忆身份。合并会改写它保活的那条、删掉被吃掉的。 */
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** 融合分。**只在本次响应内可比**。 */
  score: number;
  matched_by: RecallRoute[];
}

/** 这一层里**某一路**召回没跑成（关键词路或向量路）。 */
export interface DegradedHitRoute {
  route: RecallRoute;
  reason: string;
}

/**
 * 某一层没能参与这次组装。**必须如实汇报** —— 静默少一段会被读成
 * 「这个人没有画像 / 没有场景」，而那是另一个事实。
 *
 * ⚠️ 团队 target 下开了 `retrieve.l0` / `retrieve.l1` 也走这里（那两层没有团队
 *    维度，而汇总端点不能整单 400）—— 所以四种 layer 都可能出现。
 */
export interface DegradedLayer {
  layer: PreviewLayer;
  reason: string;
}

/**
 * 分段结构与 `memory_retrieval` 的 system_prompt **拼装之后**的预览。
 *
 * ⚠️ 它是**展示**用的，不是注入路径的产物：真正注入由调用方按同一份提示词
 *    模块渲染（排版只住在那儿）。
 */
export interface MemoryRetrievalPromptText {
  /**
   * `memory_retrieval` 那段系统提示词。**每次调用都一样**（常量，只随配置变）。
   *
   * ⚠️ `null` = 那份提示词**还没写**（模块还没落地）—— 与"提示词是空的"
   *    （空串）区分开。
   */
  system: string | null;
  /** 由 `sections` 渲染出来的用户消息 —— **预览的主体**。 */
  user: string;
}

export interface MemoryRetrievalPrompt {
  /** 标识这次调用，用于对日志与轨迹。 */
  retrieval_id: string;
  /**
   * 请求里 `input` 的回显。**必填所以不是 null**（v2.0.0 一度是 `string | null`，
   * v2.1.0 随"L0/L1 真的召回"一起变回必填）。
   */
  input: string;
  /** 回显**实际生效**的 target（`agent_id` 缺省时这里会被补上）。 */
  target: RetrievalTarget;
  scope_kind: ScopeKind;
  /**
   * **按 prompt 顺序**返回：画像(L3) -> 场景(L2) -> L0 命中 -> L1 命中
   * （后两段只在 `retrieve.l0` / `retrieve.l1` 为 true 时出现）。
   *
   * ⚠️ 这是**后端拼 prompt 的顺序**，不是本页展示的顺序 —— 页面上要按 L0 -> L3
   *    升序重排（见 utils 的 `sortSectionsByLayer`）。两者刻意不一致：prompt 要
   *    "先给结论再给原始材料"，而人查预览是"从原始材料往上看到结论"。
   *
   * ⚠️ **没打开的层不出现在这里**（不是给一段空的）—— 一段空的 `items`
   *    与"这一层压根没要"对渲染方是两件事。
   */
  sections: PromptSection[];
  degraded: DegradedLayer[];
  /**
   * 拼装好的预览。
   * ⚠️ v2 把它列进了 `required`（上一版是可选）—— 所以它应该恒在。
   */
  prompt: MemoryRetrievalPromptText;
  generated_at: string;
}

// ---------------------------------------------------------------- L0 查询

/** L0 的排序。`session_seq_*` 建议只与 session_id 一起用。 */
export type L0Order =
  | 'created_at_desc'
  | 'created_at_asc'
  | 'session_seq_asc'
  | 'session_seq_desc';

export interface L0QueryRequest {
  target: RetrievalTarget;
  /**
   * 可选；限定单个会话。不传则跨该个人 scope 的会话查询。
   * ⚠️ **会话不存在时是 404**（不是空列表）—— 与"会话存在但没有符合的消息"区分开。
   */
  session_id?: string;
  /** 限定消息角色。**不传 = 两种都要**（"我说过什么"与"你说过什么"都是正当问题）。 */
  roles?: Array<'user' | 'assistant'>;
  /** created_at 下界（含）。按**记录时间**，不是正文里提到的时间。 */
  time_from?: string;
  /** created_at 上界（含）。 */
  time_to?: string;
  /**
   * **字面**文本包含过滤。
   * ⚠️ 契约明说：不代表语义检索或向量相似度检索。想要"找意思相近的话"，
   *    这一层给不了（那是 Agent 工具的活）。
   */
  text_contains?: string;
  /** 1..100，默认 20。 */
  limit?: number;
  /** 上一页返回的 `next_cursor`；第一页不传。 */
  cursor?: string | null;
  order?: L0Order;
}

export interface L0QueryResponse {
  scope_kind: ScopeKind;
  items: ConversationRecord[];
  page: Pagination;
}

// ---------------------------------------------------------------- L1 查询

export type L1Order =
  | 'updated_at_desc'
  | 'updated_at_asc'
  | 'priority_desc'
  | 'priority_asc';

export interface L1QueryRequest {
  target: RetrievalTarget;
  /** 精确匹配记忆类型（persona / episodic / instruction …）；不传表示全部类型。 */
  type?: string;
  /** 精确匹配 priority；**-1 表示全局指令**。 */
  priority?: number;
  /** 精确匹配所属场景名。 */
  scene_name?: string;
  /** updated_at 下界（含）。 */
  updated_from?: string;
  /** updated_at 上界（含）。 */
  updated_to?: string;
  /** 记忆正文字面包含过滤（不是语义召回）。 */
  text_contains?: string;
  /** 1..100，默认 20。 */
  limit?: number;
  cursor?: string | null;
  order?: L1Order;
}

export interface L1QueryResponse {
  scope_kind: ScopeKind;
  items: FactRecord[];
  page: Pagination;
}

// ---------------------------------------------------------------- L2 查询 / 详情

export type L2Order = 'updated_at_desc' | 'updated_at_asc' | 'filename_asc';

export interface L2QueryRequest {
  target: RetrievalTarget;
  /** **文件名字面包含**过滤（不是内容过滤 —— 内容过滤在 v2 里已经不提供）。 */
  filename_contains?: string;
  /** 1..100，默认 50。 */
  limit?: number;
  cursor?: string | null;
  order?: L2Order;
}

export interface L2QueryResponse {
  scope_kind: ScopeKind;
  items: SceneSummary[];
  page: Pagination;
}

export interface L2DetailRequest {
  target: RetrievalTarget;
  /** 精确场景文件名，来自 L2 列表返回的 filename。 */
  filename: string;
}

export interface L2DetailResponse {
  scope_kind: ScopeKind;
  scene: SceneDetail;
}

// ---------------------------------------------------------------- L3 查询 / 通用

/** 只需要 target 的请求（L3）。 */
export interface TargetRequest {
  target: RetrievalTarget;
}

export interface L3QueryResponse {
  scope_kind: ScopeKind;
  /** 这个 scope 的画像；**null = 还没生成过**（正常状态，**不是 404**）。 */
  persona: PersonaRecord | null;
}
