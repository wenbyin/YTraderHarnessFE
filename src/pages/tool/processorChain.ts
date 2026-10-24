// src/pages/tool/processorChain.ts
//
// 对齐 YTraderHarness：
//   - app/services/tool/tool_processor.yaml（Tool Processor Management API v1.0.0）
//   - app/services/tool/application/tool_processor_service_impl.py（校验的实际实现）
//
// 读代码比读契约多拿到四条**决定 UI 形态**的事实，改这里前务必先看：
//
//  1. **链是一条扁平有序表，数组顺序 = 执行顺序**。
//     AROUND 处理器在链上是**两条记录**（先进 + 后出，各带自己那份 config），
//     所以「一条链」在库里其实是「一次调用的执行时序」平铺开。
//     → 结论：时间轴上的行序**就是**落库顺序，serialize 可以直接按行序吐。
//
//  2. **洋葱校验以 processor_key 作为区间标识**（validate_onion 的 spans 字典
//     以 key 为键）—— 但**只有 AROUND 记录参与**。所以：
//       - 同一个 key 挂多个 AROUND → 两条记录被折叠成一个区间，必坏 → 前端直接禁；
//       - 同一个 key 挂多个 BEFORE / AFTER → 完全合法（比如「隐私过滤」前置滤一遍、
//         后置再滤一遍），UI 不拦。
//     见 validateChain：重复检查只针对 AROUND。
//
//  3. **AROUND 必须 SYNC** —— 服务层先拦一道（为了落 409 而不是 500），
//     DB 还有 ck_tool_processor_around_sync。UI 里 ASYNC 选项要 disabled。
//
//  4. **PUT /tools/{id}/processors 是全量替换且会重建 processor_id**
//     （"行是全删重建的 —— processor_id 会全部重新生成，前端提交后需要重新 GET"）。
//     → 所以本地 draft 只能用**本地 uid**，绝不能拿后端 id 当 React key 复用。
//
// 还有一条**前端自己定的语义**（契约没写，后端当前也没约束）：
//   本页只表达「所有 AROUND 互相嵌套」的链。并列（不相交）的 AROUND 区间
//   后端 validate_onion 是放行的，但对一次 Tool 调用讲不通 —— 工具调用必须
//   落在**所有** AROUND 区间之内，不相交就意味着没有这样的落点。
//   所以 parseChain 遇到表达不出来的形状会报 unsupported，页面降级成只读 + 告警。

import { buildDefaults } from '@/components/SchemaForm';
import type { JsonValue } from './data';

export type ProcessorType = 'INTERCEPTOR' | 'TRANSFORMER' | 'OBSERVER';
export type ProcessorHook = 'BEFORE' | 'AFTER' | 'AROUND';
export type ExecutionMode = 'SYNC' | 'ASYNC';

export const PROCESSOR_TYPES: ProcessorType[] = [
  'INTERCEPTOR',
  'TRANSFORMER',
  'OBSERVER',
];
export const PROCESSOR_HOOKS: ProcessorHook[] = ['BEFORE', 'AFTER', 'AROUND'];
export const EXECUTION_MODES: ExecutionMode[] = ['SYNC', 'ASYNC'];

/** JSON Schema：契约里是裸 object，结构完全由注册表的实现决定。 */
export type JsonSchema = Record<string, any>;

export interface ProcessorDefinition {
  key: string;
  name: string;
  description?: string | null;
  processor_type: ProcessorType;
  supported_hooks: ProcessorHook[];
  supported_execution_modes: ExecutionMode[];
  config_schema: JsonSchema;
  registry_available: boolean;
}

/** 链上的一条**记录**（后端视角）。AROUND 占两条。 */
export interface ToolProcessor {
  id: string;
  tool_id: string;
  processor_key: string;
  sequence: number;
  execution_mode: ExecutionMode;
  hook: ProcessorHook;
  config: JsonValue;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
  /** 实现已从注册表消失时为 undefined —— 后端省掉整个字段而不是塞个假的 */
  processor?: ProcessorDefinition | null;
}

export interface ToolProcessorChain {
  tool_id: string;
  processors: ToolProcessor[];
}

export interface PagedProcessorDefinitionResponse {
  items: ProcessorDefinition[];
  page: number;
  page_size: number;
  total: number;
}

export interface ReplaceToolProcessorItem {
  processor_key: string;
  execution_mode: ExecutionMode;
  hook: ProcessorHook;
  config?: JsonValue;
  enabled?: boolean;
}

export interface ReplaceToolProcessorChainRequest {
  items: ReplaceToolProcessorItem[];
}

/** PUT /tools/{tool_id}/processors/order */
export interface ReorderToolProcessorsRequest {
  processor_ids: string[];
}

/**
 * 链上的一个**处理器实例**（前端视角）。
 *
 * 与后端的 ToolProcessor 不是一一对应：AROUND 在前端是一条实例，
 * 落库是两条记录。uid 只在前端存在 —— PUT 会重建后端 id，
 * 所以 draft 期间必须用 uid 当 key，不能用后端 id。
 */
export interface ChainItem {
  uid: string;
  processor_key: string;
  hook: ProcessorHook;
  execution_mode: ExecutionMode;
  config: JsonValue;
  enabled: boolean;
}

export type RowKind = 'enter' | 'exit' | 'single' | 'tool';

export interface TimelineRow {
  kind: RowKind;
  /** 被几层 AROUND 包着 —— 缩进的依据 */
  depth: number;
  item?: ChainItem;
}

export interface OnionResult {
  ok: boolean;
  /** 已成对的 AROUND 数量 */
  aroundCount: number;
  /** 只有一条记录、缺配对的 key（后端视作合法中间态） */
  unpaired?: string[];
  badKey?: string;
  outerKey?: string;
}

export interface CheckResult {
  level: 'ok' | 'warn' | 'bad';
  text: string;
}

/* ==========================================================================
 * 时间轴
 * ========================================================================== */

/**
 * 展开成执行时间轴 —— **行序 = 执行顺序 = 落库顺序**。
 *
 *   进入段：正序遍历 items → BEFORE 行 + AROUND「进入」行
 *   中段  ：⟦Tool⟧
 *   退出段：逆序遍历 items → AFTER 行 + AROUND「退出」行   ← 两者交错
 *
 * 退出段必须**逆序**且交错，否则 AFTER 在 items 里的位置对渲染不可见
 * （改了顺序看不出变化，拖了像没反应）；而且只有交错之后行序才等于
 * 后端那条扁平表的顺序。
 *
 * depth = 该项「前面有几个 AROUND」：进入/退出/TOOL 三处统一这一个算法。
 */
export function buildTimeline(items: ChainItem[]): TimelineRow[] {
  const aroundBefore: number[] = [];
  let opened = 0;
  items.forEach((it, k) => {
    aroundBefore[k] = opened;
    if (it.hook === 'AROUND') opened += 1;
  });

  const rows: TimelineRow[] = [];
  items.forEach((it, k) => {
    if (it.hook === 'BEFORE') {
      rows.push({ kind: 'single', depth: aroundBefore[k], item: it });
    } else if (it.hook === 'AROUND') {
      rows.push({ kind: 'enter', depth: aroundBefore[k], item: it });
    }
  });
  rows.push({ kind: 'tool', depth: opened });

  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k];
    if (it.hook === 'AROUND') {
      rows.push({ kind: 'exit', depth: aroundBefore[k], item: it });
    } else if (it.hook === 'AFTER') {
      rows.push({ kind: 'single', depth: aroundBefore[k], item: it });
    }
  }
  return rows;
}

/** 这一行属于哪一段：退出段（AROUND 退出行 / AFTER 行）还是进入段。 */
export function rowRegion(
  kind: RowKind,
  hook: ProcessorHook | undefined,
): 'enter' | 'exit' {
  if (kind === 'exit') return 'exit';
  if (kind === 'single' && hook === 'AFTER') return 'exit';
  return 'enter';
}

/* ==========================================================================
 * 序列化 / 反序列化
 * ========================================================================== */

/** 单个 uid 生成器。后端 id 会被 PUT 重建，uid 只活在前端这一屏里。 */
let uidSeq = 0;
export function newUid(): string {
  uidSeq += 1;
  return `u${Date.now().toString(36)}_${uidSeq}`;
}

/**
 * 前端 items → PUT /tools/{tool_id}/processors 的 items。
 *
 * 直接按时间轴行序吐即可：AROUND 在时间轴上出现两次（进 / 出），
 * 于是自动落成后端要的**两条记录**；BEFORE / AFTER 各一条。
 */
export function serializeChain(items: ChainItem[]): ReplaceToolProcessorItem[] {
  return buildTimeline(items)
    .filter((r): r is TimelineRow & { item: ChainItem } => Boolean(r.item))
    .map((r) => ({
      processor_key: r.item.processor_key,
      execution_mode: r.item.execution_mode,
      hook: r.item.hook,
      config: { ...r.item.config },
      enabled: r.item.enabled,
    }));
}

export interface ParseResult {
  items: ChainItem[];
  ok: boolean;
  /** 表达不出来时的原因 —— 页面据此降级成只读 */
  reason?: string;
}

/**
 * 后端扁平记录 → 前端 items。
 *
 * 进入段长度恒为 |BEFORE| + |AROUND|（AROUND 按 key 去重，一条实例算一次），
 * 退出段长度恒为 |AFTER| + |AROUND|。据此把链劈成两段：
 *   - 进入段正着读 → {BEFORE, AROUND} 的相对次序
 *   - 退出段反着读 → {AFTER, AROUND} 的相对次序
 * 再以 AROUND 为锚点把两个偏序合成一个全序，最后**往返校验一遍** ——
 * 合成出来的 items 重新序列化必须逐项等于原链，否则说明这条链的形状
 * 本页表达不了（典型就是并列的 AROUND 区间）。
 */
export function parseChain(processors: ToolProcessor[]): ParseResult {
  if (!processors.length) return { items: [], ok: true };

  const aroundKeys = new Set<string>();
  processors.forEach((p) => {
    if (p.hook === 'AROUND') aroundKeys.add(p.processor_key);
  });
  const nBefore = processors.filter((p) => p.hook === 'BEFORE').length;
  const split = nBefore + aroundKeys.size;

  if (split > processors.length) {
    return { items: [], ok: false, reason: '链的形状无法解析（记录数对不上）' };
  }

  const enter = processors.slice(0, split);
  const exit = processors.slice(split);

  // 进入段只允许 BEFORE 和 AROUND 的**第一次**出现
  const enterItems: ChainItem[] = [];
  const seen = new Set<string>();
  for (const p of enter) {
    if (p.hook === 'BEFORE') {
      enterItems.push(toChainItem(p));
      continue;
    }
    if (p.hook === 'AROUND') {
      if (seen.has(p.processor_key)) {
        return {
          items: [],
          ok: false,
          reason: `AROUND 处理器 ${p.processor_key} 的两条记录都落在 ⟦Tool⟧ 之前`,
        };
      }
      seen.add(p.processor_key);
      enterItems.push(toChainItem(p));
      continue;
    }
    return {
      items: [],
      ok: false,
      reason: `AFTER 记录 ${p.processor_key} 落在了 ⟦Tool⟧ 之前`,
    };
  }

  // 退出段反着读 → {AFTER, AROUND} 的升序
  const exitAsc: ChainItem[] = [];
  const closed = new Set<string>();
  for (let i = exit.length - 1; i >= 0; i -= 1) {
    const p = exit[i];
    if (p.hook === 'AFTER') {
      exitAsc.push(toChainItem(p));
      continue;
    }
    if (p.hook === 'AROUND') {
      const anchor = enterItems.find(
        (x) => x.processor_key === p.processor_key,
      );
      if (!anchor) {
        return {
          items: [],
          ok: false,
          reason: `AROUND 处理器 ${p.processor_key} 缺「进入」那一条记录`,
        };
      }
      closed.add(p.processor_key);
      // 后出那条记录自己带一份 config，这里沿用进入那条（UI 只有一个 config）
      exitAsc.push(anchor);
      continue;
    }
    return {
      items: [],
      ok: false,
      reason: `BEFORE 记录 ${p.processor_key} 落在了 ⟦Tool⟧ 之后`,
    };
  }

  // 以 AROUND 为锚点合并两个偏序
  const merged: ChainItem[] = [];
  let j = 0;
  for (const e of enterItems) {
    if (e.hook !== 'AROUND') {
      merged.push(e);
      continue;
    }
    while (j < exitAsc.length && exitAsc[j].uid !== e.uid) {
      if (exitAsc[j].hook === 'AROUND') {
        return {
          items: [],
          ok: false,
          reason: `AROUND 区间并列（${exitAsc[j].processor_key} 与 ${e.processor_key} 不相交），本页无法表达`,
        };
      }
      merged.push(exitAsc[j]);
      j += 1;
    }
    if (j >= exitAsc.length) {
      return {
        items: [],
        ok: false,
        reason: `AROUND 处理器 ${e.processor_key} 的进入/退出顺序对不上`,
      };
    }
    merged.push(exitAsc[j]);
    j += 1;
  }
  while (j < exitAsc.length) {
    merged.push(exitAsc[j]);
    j += 1;
  }

  // 往返校验：合成结果重新序列化必须与原链逐项一致
  const back = serializeChain(merged);
  const sig = (list: { processor_key: string; hook: ProcessorHook }[]) =>
    list.map((x) => `${x.processor_key}:${x.hook}`).join('|');
  if (sig(back) !== sig(processors)) {
    return {
      items: [],
      ok: false,
      reason:
        '链的形状无法用「全部 AROUND 互相嵌套」表达（可能存在并列的 AROUND 区间）',
    };
  }

  return { items: merged, ok: true };
}

function toChainItem(p: ToolProcessor): ChainItem {
  return {
    uid: newUid(),
    processor_key: p.processor_key,
    hook: p.hook,
    execution_mode: p.execution_mode,
    config: { ...(p.config ?? {}) },
    enabled: p.enabled,
  };
}

/* ==========================================================================
 * 洋葱校验 —— 照搬后端 validate_onion 的栈算法，保证前后端判一致
 * ========================================================================== */

/**
 * 后端实现见 tool_processor_service_impl.validate_onion：
 * 以 processor_key 为键收区间，按左端点升序扫，栈里留着"还没结束的区间"，
 * 新区间越过栈顶右端就是交叉。只比较相邻两个区间不够（A-C 交叉时 A-B、
 * B-C 都不交叉），所以必须用栈。
 */
export function validateOnionFlat(
  flat: { processor_key: string; hook: ProcessorHook }[],
): OnionResult {
  const spans = new Map<string, [number, number]>();
  flat.forEach((r, i) => {
    if (r.hook !== 'AROUND') return;
    const s = spans.get(r.processor_key);
    if (s) s[1] = i;
    else spans.set(r.processor_key, [i, i]);
  });

  const unpaired = [...spans.entries()]
    .filter(([, [lo, hi]]) => hi === lo)
    .map(([key]) => key);

  const intervals = [...spans.entries()]
    .map(([key, [lo, hi]]) => ({ lo, hi, key }))
    .filter((x) => x.hi > x.lo)
    .sort((a, b) => a.lo - b.lo);

  const stack: { lo: number; hi: number; key: string }[] = [];
  for (const iv of intervals) {
    while (stack.length && stack[stack.length - 1].hi < iv.lo) stack.pop();
    if (stack.length && iv.hi > stack[stack.length - 1].hi) {
      return {
        ok: false,
        aroundCount: intervals.length,
        badKey: iv.key,
        outerKey: stack[stack.length - 1].key,
        unpaired,
      };
    }
    stack.push(iv);
  }
  return { ok: true, aroundCount: intervals.length, unpaired };
}

export function validateOnion(items: ChainItem[]): OnionResult {
  return validateOnionFlat(serializeChain(items));
}

/* ==========================================================================
 * 拖拽：一条轴、一条规则
 * ========================================================================== */

export interface DropResult {
  items: ChainItem[];
  ok: boolean;
  hook?: ProcessorHook;
  changed?: boolean;
  side?: 'before' | 'after';
  region?: 'enter' | 'exit';
  reason?: 'not-found' | 'unsupported-hook';
}

/**
 * 自由拖拽 —— 只有一条规则：AROUND 必须保持洋葱。
 *
 * 洋葱由「退出 = 进入的逆序」构造性保证，所以只要只重排 items，
 * 任意两个 AROUND 区间必然互相包含，物理上拖不出交叉。除此之外不设任何
 * 位置限制：落点不分段，拖过 ⟦Tool⟧ 时 hook 自动跟着落点侧切换。
 *
 * @param targetKind 落点那一行的类型（enter / exit / single）—— AROUND 有两条行，
 *                   拖的是哪一条决定了「段」，进而决定插入方向。
 */
export function resolveDrop(
  items: ChainItem[],
  dragUid: string,
  targetUid: string,
  after: boolean,
  targetKind: RowKind,
  defs?: Map<string, ProcessorDefinition>,
): DropResult {
  const from = items.findIndex((i) => i.uid === dragUid);
  const targetIdx = items.findIndex((i) => i.uid === targetUid);
  if (from < 0 || targetIdx < 0) {
    return { items, ok: false, reason: 'not-found' };
  }
  const dragged = items[from];
  const target = items[targetIdx];

  const region = rowRegion(targetKind, target.hook);
  const side: 'before' | 'after' = region === 'exit' ? 'after' : 'before';

  let hook = dragged.hook;
  if (dragged.hook !== 'AROUND') {
    hook = side === 'after' ? 'AFTER' : 'BEFORE';
    const def = defs?.get(dragged.processor_key);
    if (def && !def.supported_hooks.includes(hook)) {
      return {
        items,
        ok: false,
        reason: 'unsupported-hook',
        hook,
        side,
        region,
      };
    }
  }

  // 退出段是逆序渲染的：渲染上排在 T 后面 == 数组里排在 T 前面
  const insertBefore = region === 'exit' ? after : !after;

  const next = items.slice();
  next.splice(from, 1);
  let to = targetIdx + (insertBefore ? 0 : 1);
  if (from < targetIdx) to -= 1;
  next.splice(to, 0, { ...dragged, hook });

  return {
    items: next,
    ok: true,
    hook,
    changed: hook !== dragged.hook,
    side,
    region,
  };
}

/** 这个落点对被拖的实例合法吗（只看目标 hook 在不在 supported_hooks 里）。 */
export function canDrop(
  item: ChainItem,
  side: 'before' | 'after',
  def?: ProcessorDefinition,
): boolean {
  if (item.hook === 'AROUND') return true; // 横跨两侧，随便放
  const want: ProcessorHook = side === 'after' ? 'AFTER' : 'BEFORE';
  return !def || def.supported_hooks.includes(want);
}

/* ==========================================================================
 * 默认值
 * ========================================================================== */

/** 新增实例时默认挂哪：AROUND 优先（更能体现洋葱），AROUND 强制 SYNC。 */
export function defaultBind(def: ProcessorDefinition): {
  hook: ProcessorHook;
  execution_mode: ExecutionMode;
} {
  const hook: ProcessorHook = def.supported_hooks.includes('AROUND')
    ? 'AROUND'
    : (def.supported_hooks[0] ?? 'BEFORE');
  const execution_mode: ExecutionMode =
    hook === 'AROUND' ? 'SYNC' : (def.supported_execution_modes[0] ?? 'SYNC');
  return { hook, execution_mode };
}

/**
 * 按 config_schema 生成 config 初值。
 *
 * ⚠️ 走公共的 buildDefaults，别再自己写一份。这里原本有一份等价的 if 链，
 * 漏了 array 和 object 两支，也不认 $ref / anyOf —— 后果是 `list[str]` 字段
 * （例如 auth_interceptor 的 `require_roles`）被初始化成**空字符串**而不是 `[]`，
 * 提交上去后端 pydantic 校验必 422。
 *
 * 关键点：pydantic 的 `default_factory=list` **不产出 default 键**，
 * 所以「没有 default」不等于「没有默认值」，必须由 buildDefaults 按类型补。
 */
export function defaultConfig(def: ProcessorDefinition): JsonValue {
  return buildDefaults(def.config_schema);
}

/* ==========================================================================
 * 硬约束校验
 * ========================================================================== */

export function validateChain(
  items: ChainItem[],
  defs: Map<string, ProcessorDefinition>,
): CheckResult[] {
  const out: CheckResult[] = [];

  const aroundAsync = items.filter(
    (i) => i.hook === 'AROUND' && i.execution_mode !== 'SYNC',
  );
  out.push(
    aroundAsync.length
      ? {
          level: 'bad',
          text: `AROUND 必须是 SYNC（ck_tool_processor_around_sync）：${aroundAsync
            .map((i) => i.processor_key)
            .join('、')}`,
        }
      : { level: 'ok', text: 'AROUND 全部配 SYNC' },
  );

  const onion = validateOnion(items);
  out.push(
    onion.ok
      ? {
          level: 'ok',
          text: `洋葱模型成立：${onion.aroundCount} 个 AROUND，先进后出，无交叉`,
        }
      : {
          level: 'bad',
          text: `洋葱模型被破坏：${onion.badKey} 与 ${onion.outerKey} 的区间交叉`,
        },
  );

  // 重复检查**只针对 AROUND**：洋葱校验以 processor_key 作为区间标识，
  // 同 key 两个 AROUND 会折叠成一个区间；BEFORE / AFTER 不参与洋葱，
  // 同一个 key 挂 N 次（前置 + 后置各一遍）是合法且常见的用法。
  const aroundCount = new Map<string, number>();
  items.forEach((i) => {
    if (i.hook !== 'AROUND') return;
    aroundCount.set(
      i.processor_key,
      (aroundCount.get(i.processor_key) ?? 0) + 1,
    );
  });
  const dups = [...aroundCount.entries()]
    .filter(([, n]) => n > 1)
    .map(([k]) => k);
  out.push(
    dups.length
      ? {
          level: 'bad',
          text: `同一个 processor_key 挂了多个 AROUND：${dups.join('、')} —— 洋葱校验以 processor_key 作为区间标识，重复会折叠成一个区间`,
        }
      : {
          level: 'ok',
          text: 'AROUND 的 processor_key 无重复（BEFORE / AFTER 允许同一 key 挂多次）',
        },
  );

  const mismatch: string[] = [];
  const missing: string[] = [];
  items.forEach((i) => {
    const def = defs.get(i.processor_key);
    if (!def) {
      missing.push(i.processor_key);
      return;
    }
    if (!def.supported_hooks.includes(i.hook)) {
      mismatch.push(`${i.processor_key} 不支持 ${i.hook}`);
    }
    if (!def.supported_execution_modes.includes(i.execution_mode)) {
      mismatch.push(`${i.processor_key} 不支持 ${i.execution_mode}`);
    }
  });
  if (missing.length) {
    out.push({
      level: 'warn',
      text: `注册表中已不存在：${missing.join('、')} —— 保存会被 404 拒绝，请先摘掉`,
    });
  }
  out.push(
    mismatch.length
      ? { level: 'bad', text: `能力不符：${mismatch.join('；')}` }
      : {
          level: 'ok',
          text: 'hook / execution_mode 都在注册表的 supported_* 之内',
        },
  );

  const off = items.filter((i) => !i.enabled);
  if (off.length) {
    out.push({
      level: 'warn',
      text: `${off.length} 个处理器已停用（时间轴里灰显）`,
    });
  }
  return out;
}
