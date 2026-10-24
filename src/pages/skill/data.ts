// src/pages/skill/data.ts
//
// 「技能」页的模型层 —— 与 design_skills/skill_management_openapi.yaml（v1.0.0）对齐。
//
// ⚠️ 这一版契约**刻意很小**（2026-10-20 重写）：只保留 skill 定义 + 它和
//    capability 树的绑定。上一版里的 executor/runtime、双 JSON Schema、分类
//    （taxonomy）绑定、token、A2A Agent Card / tags / examples / input_modes
//    已经**全部删除** —— 所以这里一个字段都不要"顺手留着"，否则后端 PATCH
//    会直接 422（契约是 additionalProperties: false）。
//
// 语义上最容易被误解的两条（README 里写死了，UI 也必须照着表达）：
//   1. 绑定 capability **不是授权**，它只决定"子 agent 能看到哪些工具"；
//   2. `instructions` 是注入**子 agent** 的行为提示词，不是给主 agent 看的
//      （主 agent 读的是 `description`）。所以 instructions 只在详情/编辑里出现，
//      绝不进列表卡片 —— 它可能很长，也可能包含内部判据。
import type { BadgeProps } from 'antd';

/** 技能状态。只有 ACTIVE 会被主 agent 看见、允许 spawn。 */
export type SkillStatus = 'DRAFT' | 'ACTIVE' | 'DISABLED';

/** 能力的三要素 —— 契约里 `CapabilityRef` 只有这三个字段。 */
export interface CapabilityRef {
  id: string;
  code: string;
  name: string;
}

/**
 * 能力树节点（`GET /api/v1/capabilities` 的返回项）。
 *
 * ⚠️ 这是**另一个模块**的实体（capability.yaml），这里只取前端用得上的字段：
 *    `parent_id` 用来建树，`is_active` 用来提示"停用的能力等于是没绑"。
 */
export interface Capability extends CapabilityRef {
  parent_id: string | null;
  is_active?: boolean;
  sort_order?: number;
}

/**
 * 列表项。
 *
 * `SkillSummary` 里**有** `tags`（2026-10-20 后端补的，给发布/发现用），
 * 但**没有** instructions / examples / capabilities —— 这三个只在详情里。
 */
export interface SkillSummary {
  id: string;
  skill_key: string;
  name: string;
  description: string;
  /** A2A AgentSkill.tags：标准必填，允许空数组；主 agent 选技能**不读**它。 */
  tags: string[];
  status: SkillStatus;
  created_at: string;
  updated_at: string;
}

/** 详情 = 摘要 + A2A examples + 行为提示词 + 当前绑定。 */
export interface SkillDetail extends SkillSummary {
  /** A2A AgentSkill.examples（可选，字符串数组）。 */
  examples: string[];
  instructions: string;
  capabilities: CapabilityRef[];
}

export interface SkillListResponse {
  items: SkillSummary[];
  page: number;
  page_size: number;
  total: number;
}

/**
 * 详情 → 摘要。
 *
 * 保存成功后要把刚保存的那条塞回列表，但列表里只能有 SkillSummary 的字段；
 * 直接把 detail 放进 rows 会让"列表项带着 instructions"这种假象渗进后续代码
 * （真实接口是按 schema 序列化的，多出来的字段不会存在）。所以显式挑字段。
 */
export function toSummary(detail: SkillDetail): SkillSummary {
  return {
    id: detail.id,
    skill_key: detail.skill_key,
    name: detail.name,
    description: detail.description,
    tags: detail.tags,
    status: detail.status,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  };
}

/** POST /skills */
export interface SkillCreate {
  skill_key: string;
  name: string;
  description: string;
  /** 省略等于空数组（后端 default_factory=list）。 */
  tags?: string[];
  examples?: string[];
  instructions: string;
  status?: SkillStatus;
}

/**
 * PATCH /skills/{id} —— 只发要改的字段。
 *
 * ⚠️ 没有 `skill_key`：契约明确"创建后不可改"，改名只能改 `name`。
 *    表单里那个输入框在编辑态是 disabled 的，别让它发出一个后端会 422 的字段。
 */
export interface SkillPatch {
  name?: string;
  description?: string;
  /**
   * A2A tags。**不传 = 不改**；要清空必须显式传 `[]`
   * （后端拒绝显式 null —— 这几列在库里是 NOT NULL）。
   */
  tags?: string[];
  /** 同上：不传 = 不改，清空传 `[]`。 */
  examples?: string[];
  instructions?: string;
  status?: SkillStatus;
}

/** PUT /skills/{id}/capabilities —— **全量替换**，空数组 = 清空。 */
export interface SkillCapabilityUpdate {
  capability_ids: string[];
}

export interface SkillListParams {
  status?: SkillStatus;
  q?: string;
  capability_id?: string;
  page?: number;
  page_size?: number;
}

/** 状态展示口径。`badge` 用 antd Badge 的语义色，`tag` 用 Tag 的预设色。 */
export const SKILL_STATUS_META: Record<
  SkillStatus,
  { label: string; badge: BadgeProps['status']; tag: string; hint: string }
> = {
  ACTIVE: {
    label: '已启用',
    badge: 'success',
    tag: 'green',
    hint: '主 agent 可见，允许 spawn',
  },
  DRAFT: {
    label: '草稿',
    badge: 'warning',
    tag: 'gold',
    hint: '主 agent 看不见，补完后启用',
  },
  DISABLED: {
    label: '已停用',
    badge: 'default',
    tag: 'default',
    hint: '保留配置但不再被选中',
  },
};

export const SKILL_STATUS_ORDER: SkillStatus[] = [
  'ACTIVE',
  'DRAFT',
  'DISABLED',
];

/**
 * `skill_key` 的格式约束 —— 与后端 CHECK 约束逐字一致：
 *
 *     ^[a-z][a-z0-9_]{1,119}$
 *
 * 2~120 个字符、小写字母开头、只允许小写字母 / 数字 / 下划线。
 * 先在前端挡住是最省事的：后端 422 只会给一个 loc/message，用户还得自己猜。
 */
export const SKILL_KEY_PATTERN = /^[a-z][a-z0-9_]{1,119}$/;

/** 返回校验错误文案；合法时返回 `null`。 */
export function skillKeyError(value: string): string | null {
  const key = value.trim();
  if (key === '') return '请填写 skill_key';
  if (!SKILL_KEY_PATTERN.test(key)) {
    return '小写字母开头，只能用小写字母 / 数字 / 下划线，2~120 个字符';
  }
  return null;
}

/** 能力树节点。形状与 `pages/tool/data.ts` 的 `TreeNode` 一致（同一棵树）。 */
export interface TreeNode<T> {
  node: T;
  children: TreeNode<T>[];
}

/**
 * 扁平能力列表 → 树。
 *
 * 两条与 tool 页保持一致的规则：
 *   · 父节点缺失（脏数据 / 越权看不见父级）时当**顶级**处理 —— 丢掉它会让
 *     一个其实已绑定的能力在编辑界面里凭空消失；
 *   · 兄弟之间按 `sort_order` 再按 `code` 排序，保证两次渲染顺序一致
 *     （否则勾选后重渲染会跳行）。
 */
export function buildTree(list: readonly Capability[]): TreeNode<Capability>[] {
  const nodes = new Map<string, TreeNode<Capability>>(
    list.map((item) => [item.id, { node: item, children: [] }]),
  );

  const roots: TreeNode<Capability>[] = [];
  for (const item of list) {
    const self = nodes.get(item.id);
    if (!self) continue;
    const parent = item.parent_id ? nodes.get(item.parent_id) : undefined;
    if (parent) parent.children.push(self);
    else roots.push(self);
  }

  const sort = (siblings: TreeNode<Capability>[]) => {
    siblings.sort(
      (a, b) =>
        (a.node.sort_order ?? 0) - (b.node.sort_order ?? 0) ||
        a.node.code.localeCompare(b.node.code),
    );
    for (const sibling of siblings) sort(sibling.children);
    return siblings;
  };

  return sort(roots);
}

/** 能力 id → 「一级 / 二级」这样的可读路径（卡片标签、详情里标位置用）。 */
export function capabilityPath(
  list: readonly Capability[],
  capabilityId: string,
): string {
  const byId = new Map(list.map((item) => [item.id, item]));
  const parts: string[] = [];
  let cursor = byId.get(capabilityId);
  // 最多走 16 层：脏数据里出现环也不会把页面卡死。
  for (let depth = 0; cursor && depth < 16; depth += 1) {
    parts.unshift(cursor.name);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return parts.join(' / ');
}

/**
 * 「x 分钟前 / x 小时前」。
 *
 * 只用于卡片页脚那种"最近动过没有"的粗粒度判断 —— 精确时间在详情里给全。
 * 传进来的 `iso` 是后端 UTC 时间（带 Z 或 +08:00），直接 `new Date` 就能算。
 */
export function formatUpdatedAt(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '—';
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(time).toLocaleDateString('zh-CN');
}

/** 精确时间（详情抽屉里用），本地时区。 */
export function formatDateTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '—';
  return time.toLocaleString('zh-CN', { hour12: false });
}

// ---------------- 表单 ↔ 契约 的转换 ----------------

/**
 * `examples` 在表单里是一行一条的文本，提交前拆成数组。
 *
 * 为什么用 textarea 而不是 Tags 输入框：A2A 的 example 通常是一整句用户会怎么问
 * （"这份合同里的违约金上限是多少？"），塞进 tag 里每一行都挤成一小块，
 * 长句既看不清也没法换行。
 *
 * 空行直接丢掉 —— 用户敲完一句习惯性回车，不该多出一个空字符串。
 */
export function parseExamples(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 反过来：数组 → 一行一条（灌进表单）。 */
export function formatExamples(list: readonly string[]): string {
  return list.join('\n');
}

/**
 * 两个字符串数组是否**完全一致**（顺序也算）。
 *
 * 用于 PATCH 前判断 tags / examples 要不要发。做成顺序敏感是刻意的：
 * 用户在表单里调整了顺序，就该原样提交他的顺序，而不是悄悄归一化。
 */
export function sameStringList(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * tags 输入的整理：去空白、去空项、去重（保序）。
 *
 * 后端只保证是字符串数组，不管重复；但同一张卡片上出现两个一样的 tag
 * 纯属噪音，而且 A2A 卡片里重复 tag 没有意义。
 */
export function normalizeTags(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const tag = raw.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
