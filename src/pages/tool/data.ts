// src/pages/tool/data.ts
// 对齐 YTraderHarness 后端两份契约：
//   - tool.yaml（Tool Definition Management API v1.0.0）—— 表结构见
//     app/services/tool/models.sql
//   - capability.yaml（Capability Management API v1.0.0）—— 能力树
//
// **同一个业务对象在两个服务里有两个名字**（这点最容易搞混）：
//
//   | | 能力树本身 | 工具挂了哪些能力 |
//   | --- | --- | --- |
//   | 契约 | capability.yaml | tool.yaml |
//   | 路径 | `/capabilities` | `/tools/{tool_id}/classifications` |
//   | schema | `Capability` | `Classification` |
//
// 字段完全一致，**前端统一用 `Capability` 建模**（能力树是它的主场）。
// 工具关联那两个接口故意保留原路径与原 operationId（getTool / replace Tool
// Classifications），因为主语是 Tool 而不是 Capability。
//
// 几条决定 UI 形态的契约事实，改这个文件时务必保持：
//
//  1. **ToolManifest 全字段 readOnly**。 Tool 定义是**代码注册得到的**，
//     前端只能看。真要改请改代码再 sync —— 改了也会被服务端丢弃。
//     所以概览页是纯展示，没有一处输入框。
//
//  2. **人只能改三样**：description_override / return_description_override /
//     parameter_descriptions[].description_override / 业务分类。
//     其余全是灰的。这条边界来自 yaml 的 info.description（Non-responsibilities
//     明确写了不做分组 / 权限 / 标签 / processor chain）。
//
//  3. **effective_* = override ?? source**，而 **LLM / JEV 消费的是 effective**。
//     所以界面必须让人分清「这段描述是代码写的还是我写的」—— 这是这个页面
//     存在的唯一理由，比 CRUD 本身重要。
//
//  4. **PUT documentation / tool classifications 是全量替换**（operationId 就叫
//     replaceToolDocumentation / replaceToolClassifications），不是 merge。
//     请求体里没带的 parameter_path = 那条覆盖被删掉了。
//     注意这是「工具挂了哪些能力」的那条路径，与能力树自身的 CRUD 无关。
//
//  5. **「不覆盖」要发 null，不是空串**。空串会让 effective 变成空描述 ——
//     比没有更糟：LLM 拿到一段空白而不是代码原文。
//
//  6. **parameter_path 是 JSON Pointer**（/query、/filters/date_from），
//     从 input_schema 派生，不让用户手打。
//
//  7. **source_state = MISSING 是正常状态，不是错误**：上次 discovery 没在代码里
//     找到它，但记录**保留**（sync 的 remove_missing 默认 false，契约原文
//     "Recommended to keep false"）。MISSING 的 Tool 文档覆盖也还在。
//
//  8. GET /tools 的 classification_code 筛选是**精确匹配一个节点**，
//     不含子分类 —— 想含子分类要前端自己展开 descendantsOf。
//
//  9. **`enabled` 是运行时开关，不是代码侧事实**（2026-10-25 新增）。
//     它来自 `tool_definition_state`（有行 = 显式下线，无行 = 正常），
//     所以契约把它放在 `manifest` **外面**，也**不参与** sync：
//     改代码再同步不会冲掉人工设的开关，只有 PATCH /tools/{id}/enabled 能改。
//     语义是「从下一轮工具解析起不再下发给 LLM」—— 这一轮正在跑的不管。
//     注意它**不能**当成 source_state 用：MISSING 说的是代码里找不到，
//     enabled=false 说的是代码里有、但被人在运行时掐掉了。

export type ToolSourceState = 'ACTIVE' | 'MISSING';

/** 任意 JSON Schema / docstring 结构。契约里是裸 JSONB，没有二级 schema。 */
export type JsonValue = Record<string, any>;

/**
 * `source_docstring` 的**预期**形态。
 *
 * 它是 JSONB，契约**没有**约束内部结构（不像 input_schema 那样写了 type: object）。
 * 所以这里只是「我们期待的样子」，取值一律走 parseSourceDocstring 层层回落 ——
 * 后端换了结构不能让整页打崩，最多是「代码侧描述取不到」。
 */
export interface SourceDocstring {
  /** docstring 原文 */
  raw?: string | null;
  /** 解析出的工具整体描述 */
  description?: string | null;
  /** 解析出的返回值描述 */
  returns?: string | null;
  /** JSON Pointer → 该参数的描述 */
  params?: Record<string, string> | null;
}

export interface ToolManifest {
  id: string;
  tool_key: string;
  name: string;
  source_type: string;
  source_ref: string | null;
  entrypoint: string | null;
  input_schema: JsonValue;
  output_schema: JsonValue | null;
  source_docstring: SourceDocstring | null;
  manifest_hash: string;
  source_state: ToolSourceState;
  discovered_at: string;
  last_synced_at: string;
}

export interface ParameterDocumentation {
  parameter_path: string;
  source_description?: string | null;
  description_override?: string | null;
  effective_description?: string | null;
}

export interface ToolDocumentation {
  tool_id: string;
  description_override: string | null;
  return_description_override: string | null;
  parameter_descriptions?: ParameterDocumentation[] | null;
  /** override ?? source。只读 —— 服务端算好的权威值。 */
  effective_description: string | null;
  effective_return_description: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/**
 * 能力节点（capability.yaml 的 `Capability`）。
 *
 * tool.yaml 里「工具挂了哪些能力」返回的 `Classification` 字段与它**完全一致**，
 * 前端共用这一个模型 —— 从工具详情拿到的能力，可以直接丢给能力树的
 * buildTree / classPath 用。
 *
 * `code` 在两份契约里都是**稳定标识**：PATCH / PUT 都不收它，改了会让已有绑定
 * 失去参照。`sort_order` / `is_active` 在 `Capability` 里没标 required，
 * 但 `CapabilityReplace`（PUT）是必填的 —— PUT 只想改名时不该顺手把它们重置。
 */
export interface Capability {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  sort_order?: number;
  is_active?: boolean;
}

export interface ToolSummary {
  id: string;
  tool_key: string;
  name: string;
  source_type: string;
  source_state: ToolSourceState;
  /**
   * 运行时开关。`false` = 被 PATCH /enabled 显式下线，下一轮工具解析会跳过它。
   *
   * 契约里是 required，但**旧后端不返回这个字段** —— 取值一律走
   * `isToolEnabled()`，它把 undefined 当"启用"，别直接 `if (tool.enabled)`。
   */
  enabled: boolean;
  /** 服务端算好的生效描述。列表页直接展示，不要再自己拼一遍。 */
  description?: string | null;
  classifications?: Capability[] | null;
}

export interface ToolDefinitionDetail {
  /** 运行时开关。契约刻意放在 manifest 之外 —— manifest 是代码侧事实，这个是库里的行。 */
  enabled: boolean;
  manifest: ToolManifest;
  documentation: ToolDocumentation;
  classifications: Capability[];
}

/**
 * `enabled` 的**展示口径**：只有 `false` 才算下线。
 *
 * undefined / null 一律当启用 —— 旧后端没有这个字段，把它当"下线"会让
 * 整页工具凭空变成不可用，比不显示严重得多。
 */
export function isToolEnabled(tool: { enabled?: boolean | null }): boolean {
  return tool.enabled !== false;
}

export interface PagedToolSummaryResponse {
  items: ToolSummary[];
  page: number;
  page_size: number;
  total: number;
}

// ============================================================
// 请求体
// ============================================================

export interface ListToolsParams {
  keyword?: string;
  source_type?: string;
  /**
   * 来源对象过滤。MCP 场景下是 **provider 名**（见 GET /mcp/providers 的 `name`）。
   *
   * ⚠️ 与 source_type 是**两个独立条件**，后端会 AND 在一起：
   *    `?source_type=mcp&source_ref=tdx`   -> tdx 的 mcp 工具
   *    `?source_ref=tdx`                   -> 同样是 tdx（它本来就只有 mcp 行）
   *    `?source_type=local_method&source_ref=tdx` -> **恒为空集**
   * 第三条就是界面必须做联动的原因：类型一改成非 mcp，provider 必须清掉。
   */
  source_ref?: string;
  classification_code?: string;
  source_state?: ToolSourceState;
  page?: number;
  page_size?: number;
}

/**
 * 一个 MCP provider 的配置 + 运行状态 + 已同步工具数（GET /mcp/providers）。
 *
 * 三组数字**不要混着用**，后端是刻意分开给的：
 *
 *   enabled / connected         配置开关、本进程是否已建立会话
 *   exposed_tool_count          已注册进本进程、且通过 allowlist 的工具数
 *   tool_count = active + missing  库里已同步的行数
 *
 * 常见的不一致（都是正常状态，不是 bug）：
 *   连接成功但还没 sync  -> connected=true, exposed=9, tool_count=0
 *   provider 已停用但库里有历史行 -> enabled=false, tool_count=9
 *
 * 所以**过滤下拉里显示的是 `tool_count`**（下拉过滤的是库里的行），
 * connected 只作为状态提示 —— 拿 exposed 当条数会和列表结果对不上。
 */
export interface MCPProviderSummary {
  name: string;
  enabled: boolean;
  /** 目前只有 stdio。 */
  transport: string;
  connected: boolean;
  exposed_tool_count: number;
  /** all / allowlist / denylist */
  tools_mode: string;
  tool_count: number;
  active_tool_count: number;
  missing_tool_count: number;
}

export interface MCPProviderListResponse {
  items: MCPProviderSummary[];
}

export interface ListCapabilitiesParams {
  parent_id?: string | null;
  keyword?: string;
  is_active?: boolean;
}

export interface ToolDocumentationUpdate {
  description_override?: string | null;
  return_description_override?: string | null;
  parameter_descriptions?: ParameterDocumentationUpdate[];
}

export interface ParameterDocumentationUpdate {
  parameter_path: string;
  description_override: string | null;
}

export interface ToolClassificationUpdate {
  classification_ids: string[];
}

// ============================================================
// 运行时开关（PATCH /tools/{tool_id}/enabled）
// ============================================================

/**
 * `PATCH /tools/{tool_id}/enabled` 的请求体。
 *
 * 语义是**幂等的状态设置**，不是"取反"：
 *   enabled=false -> 写入（或刷新）一行禁用记录
 *   enabled=true  -> 删掉那一行
 * 所以重复点同一个方向不会翻来覆去，也不需要先读回当前值。
 */
export interface ToolEnabledUpdate {
  enabled: boolean;
}

/** 响应只回 tool_key + 生效后的 enabled，不回完整详情。 */
export interface ToolEnabledState {
  tool_key: string;
  enabled: boolean;
}

export interface ToolSyncRequest {
  source_types?: string[];
  source_refs?: string[];
  remove_missing?: boolean;
}

export interface ToolSyncResult {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  missing: number;
  orphaned_documentations?: number;
}

export interface CapabilityCreate {
  code: string;
  name: string;
  description?: string | null;
  parent_id?: string | null;
  sort_order?: number;
}

export interface CapabilityUpdate {
  name?: string;
  description?: string | null;
  parent_id?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

/**
 * PUT /capabilities/{capability_id} 的请求体 —— 与 Update 字段相同，但**语义是全量替换**：
 * 省略的 description / parent_id 表示「清空 / 移到顶级」，不是「保持原样」。
 * 所以 sort_order 与 is_active 是必填 —— 一个只想改名的 PUT 不该顺手把排序归零、
 * 把停用的节点重新启用。契约原文说明了这是**故意**不设默认值。
 *
 * 前端编辑走 PATCH（只发变更字段），这份类型只在确实需要"整体覆盖"时才用。
 */
export interface CapabilityReplace {
  name: string;
  description?: string | null;
  parent_id?: string | null;
  sort_order: number;
  is_active: boolean;
}

// ============================================================
// 展示用常量
// ============================================================

/**
 * source_type 的色值身份。
 *
 * 契约刻意没把它定成枚举（注释写的是 "local_method / mcp / openapi / ..."，
 * 那个省略号是认真的），所以没收录的类型**原样显示走中性色**，
 * 不要显示成「未知」把信息吃掉。
 */
export const SOURCE_TYPE_COLOR: Record<string, string> = {
  local_method: 'blue',
  mcp: 'purple',
  openapi: 'default',
};

/** 不在上表里的类型给个中性色空串 —— antd Tag 的 color='' 会渲染成默认灰。 */
export function sourceTypeColor(sourceType: string): string {
  return SOURCE_TYPE_COLOR[sourceType] ?? '';
}

export const SOURCE_STATE_COLOR: Record<ToolSourceState, string> = {
  ACTIVE: 'success',
  MISSING: 'error',
};

/**
 * 下线标只用一个颜色：warning。
 *
 * 语义色位在这页已经被占满了（见 ToolList 文件头）：success/error = source_state、
 * purple = 业务分类、blue = 选中态与主色。**这一页里"要注意但没坏"的事情用 warning**，
 * 而 enabled=false 恰好就是这个味道 —— 代码里还有这个工具，只是被人掐掉了。
 */
export const TOOL_DISABLED_COLOR = 'warning';

// ============================================================
// 纯函数：把结构抖动的 JSONB 收敛成稳定的形状
// ============================================================

/**
 * source_docstring 的容错解析。
 *
 * 契约没约束它的结构，所以这里**逐字段**取值并对类型做校验：
 * 某个字段是意外类型就当它没有，而不是让 `.description` 炸在渲染里。
 */
export function parseSourceDocstring(value: unknown): SourceDocstring {
  if (!value || typeof value !== 'object') return {};
  const raw = value as JsonValue;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null;

  const paramsIn = raw.params;
  const params: Record<string, string> = {};
  if (paramsIn && typeof paramsIn === 'object') {
    for (const [k, v] of Object.entries(paramsIn as JsonValue)) {
      if (typeof v === 'string' && v.trim()) params[k] = v;
    }
  }
  return {
    raw: str(raw.raw),
    description: str(raw.description),
    returns: str(raw.returns),
    params: Object.keys(params).length ? params : null,
  };
}

/** 从 manifest 取解析好的 docstring —— 所有地方都走这里，别直接摸 JSONB。 */
export function toolDocstring(manifest: ToolManifest): SourceDocstring {
  return parseSourceDocstring(manifest.source_docstring);
}

// ============================================================
// 纯函数：JSON Pointer 路径派生
// ============================================================

export interface SchemaNode {
  /** JSON Pointer，例如 /filters/date_from */
  path: string;
  /** 'object' = 还有子属性，本身不是叶子参数 */
  kind: 'object' | 'leaf';
  schema: JsonValue;
}

/**
 * 递归展开 input_schema，产出全部 JSON Pointer 路径。
 *
 * 为什么要自己走一遍而不是手填：parameter_path 的值域就是 input_schema 的形状，
 * 手填迟早和 schema 对不上，到时候 effective_description 取到的是空气。
 *
 * 只处理 `type: object` 的嵌套 —— 契约给的例子（/filters/date_from）就是这种；
 * 数组不做展开（array 的 items 拆成/item/xxx 没有意义）。
 */
export function schemaPaths(
  schema: JsonValue | null | undefined,
  prefix = '',
  out: SchemaNode[] = [],
): SchemaNode[] {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as JsonValue;
    for (const key of Object.keys(props)) {
      const value = props[key] as JsonValue | undefined;
      const path = `${prefix}/${key}`;
      if (value && typeof value === 'object' && value.type === 'object') {
        out.push({ path, kind: 'object', schema: value });
        schemaPaths(value, path, out);
      } else {
        out.push({ path, kind: 'leaf', schema: value ?? {} });
      }
    }
  }
  return out;
}

/** 某个路径节点；拿不到返回 undefined。 */
export function schemaNodeAt(
  manifest: ToolManifest,
  path: string,
): SchemaNode | undefined {
  return schemaPaths(manifest.input_schema).find((n) => n.path === path);
}

/**
 * 代码侧给某个参数的描述：docstring 优先，回落到 input_schema.description。
 *
 * 顺序是刻意的：docstring 是**写给人看的**，schema.description 经常是英文的
 * 字段枚举串（"stock code" 这种），拿它当正文会很怪。
 */
export function sourceParamDesc(
  manifest: ToolManifest,
  path: string,
): string | null {
  const fromDoc = toolDocstring(manifest).params?.[path];
  if (fromDoc) return fromDoc;
  const desc = schemaNodeAt(manifest, path)?.schema?.description;
  return typeof desc === 'string' && desc.trim() ? desc : null;
}

/**
 * 一条 Tool 的**全部**参数路径 = schema 派生 ∪ docstring ∪ 已存覆盖。
 *
 * 必须取并集而不是只取 schema：代码删掉了某个参数但覆盖还在时（孤儿覆盖），
 * 只渲染 schema 派生的路径，那条覆盖就成了**存得进去、看得见却删不掉**的死角。
 */
export function paramPaths(
  manifest: ToolManifest,
  documentation?: ToolDocumentation | null,
): string[] {
  const paths: string[] = [];
  const add = (p: string) => {
    if (p && !paths.includes(p)) paths.push(p);
  };
  schemaPaths(manifest.input_schema).forEach((n) => {
    add(n.path);
  });
  Object.keys(toolDocstring(manifest).params ?? {}).forEach((key) => {
    add(key);
  });
  (documentation?.parameter_descriptions ?? []).forEach((p) => {
    add(p.parameter_path);
  });
  return paths;
}

/**
 * 孤儿覆盖：覆盖还在，但 input_schema 里已经没有这个参数了。
 * sync 结果的 orphaned_documentations 说的就是这个。
 */
export function isOrphanPath(manifest: ToolManifest, path: string): boolean {
  return !schemaPaths(manifest.input_schema).some((n) => n.path === path);
}

// ============================================================
// 纯函数：覆盖值
// ============================================================

/**
 * 规范化：trim 后空串 → null。
 *
 * 「不覆盖」在契约里是 **null**，不是 ''。空串提交上去会让 effective 变成
 * 一段空白描述 —— LLM 拿到「什么都没有」而不是代码原文，比不覆盖更糟。
 */
export function normalizeOverride(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

/** 某一路径已有的覆盖原文（未 trim）。用于回填编辑框。 */
export function overrideAt(
  documentation: ToolDocumentation | null | undefined,
  path: string,
): string {
  return (
    documentation?.parameter_descriptions?.find(
      (p) => p.parameter_path === path,
    )?.description_override ?? ''
  );
}

export interface EffectiveText {
  text: string | null;
  /** true = 来自人工覆盖；false = 回落代码原文 */
  fromOverride: boolean;
}

/**
 * 生效文本 = override ?? source。
 *
 * 服务端也返回 effective_*，但那是**保存后**的权威值；编辑过程中要靠这个
 * 函数在前端实时算出来 —— 用户打字的每一帧都要能看到「生效」格跟着变。
 */
export function effectiveText(
  override: string | null | undefined,
  source: string | null | undefined,
): EffectiveText {
  const normalized = normalizeOverride(override);
  if (normalized) return { text: normalized, fromOverride: true };
  const src = (source ?? '').trim();
  return { text: src ? src : null, fromOverride: false };
}

// ============================================================
// 纯函数：分类树
// ============================================================

export function classificationMap(
  list: Capability[],
): Record<string, Capability> {
  return Object.fromEntries(list.map((c) => [c.id, c]));
}

/** 「行情数据 / A股行情」这样的全路径名。树深有限，循环引用时到此为止。 */
export function classPath(id: string, map: Record<string, Capability>): string {
  const parts: string[] = [];
  let cur: Capability | undefined = map[id];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parent_id ? map[cur.parent_id] : undefined;
  }
  return parts.join(' / ');
}

/** 自己 + 全部后代。列表筛选要「含子分类」时用它展开。 */
export function descendantsOf(id: string, list: Capability[]): string[] {
  const out = [id];
  const walk = (parent: string) => {
    for (const c of list) {
      if (c.parent_id === parent) {
        out.push(c.id);
        walk(c.id);
      }
    }
  };
  walk(id);
  return out;
}

export interface TreeNode<T> {
  node: T;
  children: TreeNode<T>[];
}

/**
 * 扁平列表 → 树。孤儿 parent（父被删了）当顶级处理，不能让它整棵消失。
 *
 * 排序用 sort_order → code，保证两次渲染顺序一致（Object 顺序不稳定会抖动）。
 */
export function buildTree(list: Capability[]): TreeNode<Capability>[] {
  const sort = (nodes: TreeNode<Capability>[]) => {
    nodes.sort(
      (a, b) =>
        (a.node.sort_order ?? 0) - (b.node.sort_order ?? 0) ||
        a.node.code.localeCompare(b.node.code),
    );
    nodes.forEach((n) => {
      sort(n.children);
    });
    return nodes;
  };

  const map = classificationMap(list);
  const nodes = new Map<string, TreeNode<Capability>>(
    list.map((c) => [c.id, { node: c, children: [] }]),
  );
  const roots: TreeNode<Capability>[] = [];
  for (const c of list) {
    const self = nodes.get(c.id) as TreeNode<Capability>;
    const parent = c.parent_id ? nodes.get(c.parent_id) : undefined;
    if (parent && map[c.parent_id as string]) parent.children.push(self);
    else roots.push(self);
  }
  return sort(roots);
}

/** 全部叶子/节点 id 的深度优先序 —— Taxonomy 表格展示用。 */
export function flattenTree<T>(nodes: TreeNode<T>[]): T[] {
  const out: T[] = [];
  const walk = (ns: TreeNode<T>[]) => {
    for (const n of ns) {
      out.push(n.node);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// ============================================================
// 纯函数：请求体构造
// ============================================================

export interface DocDraft {
  descriptionOverride: string;
  returnDescriptionOverride: string;
  /** JSON Pointer → 草稿文本（未 trim） */
  params: Record<string, string>;
}

/** 打开详情时把服务端的值拷进草稿 —— 之后所有编辑只动草稿。 */
export function openDocDraft(
  manifest: ToolManifest,
  documentation: ToolDocumentation | null | undefined,
): DocDraft {
  const params: Record<string, string> = {};
  for (const path of paramPaths(manifest, documentation)) {
    params[path] = overrideAt(documentation, path);
  }
  return {
    descriptionOverride: documentation?.description_override ?? '',
    returnDescriptionOverride: documentation?.return_description_override ?? '',
    params,
  };
}

/**
 * 草稿 → PUT /tools/{id}/documentation 请求体。
 *
 * **整张表提交**，不是 diff： operationId 就叫 replaceToolDocumentation，
 * 请求体里没带的 parameter_path 服务端会当成「这条覆盖被删掉了」。
 */
export function buildDocPutBody(draft: DocDraft): ToolDocumentationUpdate {
  return {
    description_override: normalizeOverride(draft.descriptionOverride),
    return_description_override: normalizeOverride(
      draft.returnDescriptionOverride,
    ),
    parameter_descriptions: Object.entries(draft.params).map(
      ([parameter_path, value]) => ({
        parameter_path,
        description_override: normalizeOverride(value),
      }),
    ),
  };
}

/** 草稿与服务端值是否不同。控制保存按钮的可用态与 Tab 上的脏标记。 */
export function isDocDirty(
  draft: DocDraft,
  documentation: ToolDocumentation | null | undefined,
): boolean {
  if (
    normalizeOverride(draft.descriptionOverride) !==
    (documentation?.description_override ?? null)
  ) {
    return true;
  }
  if (
    normalizeOverride(draft.returnDescriptionOverride) !==
    (documentation?.return_description_override ?? null)
  ) {
    return true;
  }
  const saved: Record<string, string | null> = {};
  (documentation?.parameter_descriptions ?? []).forEach((p) => {
    saved[p.parameter_path] = p.description_override ?? null;
  });
  const next = buildDocPutBody(draft).parameter_descriptions ?? [];
  const keys = new Set([
    ...Object.keys(saved),
    ...next.map((p) => p.parameter_path),
  ]);
  for (const k of keys) {
    if (
      (saved[k] ?? null) !==
      (next.find((p) => p.parameter_path === k)?.description_override ?? null)
    ) {
      return true;
    }
  }
  return false;
}
