// src/components/SchemaForm/schema.ts
// config_schema → 表单控件所需的纯数据处理（不依赖 React / antd，可单测）。
//
// ⚠️ 文件名故意叫 schema.ts 而不是 schemaForm.ts：同目录还有组件 SchemaForm.tsx，
// 两者只差大小写会让 TS 报 TS1149（Windows 文件系统不区分大小写，但 TS 会认成两个文件）。
//
// ⚠️ 2026-10-05 从 pages/document_type_definition/ 提到公共层。原因：
// 「处理链」(pages/tool) 与「能力配置」(pages/document_type_definition) 两处
// 本来各写了一份字段渲染逻辑，tool 那份只有 enum / boolean / number 三个分支 +
// 兜底 Input，**没有 array / object / $ref** —— `list[str]` 字段于是在那边
// 渲染成一个单行输入框，用户填完提交上去是字符串，后端 pydantic 直接 422。
// 现在两边共用这一套；**任何页面都不要再内联写字段分支判断**。
//
// config_schema 是 pydantic v2 model_json_schema() 的原生输出（JSON Schema draft 2020-12），
// 因此会有这几个必须处理的形态：
//   - enum                                    → 下拉
//   - integer/number + minimum/maximum        → 数字输入 + 区间校验
//   - boolean                                 → 开关
//   - array + items                           → 动态增删
//   - anyOf: [T, {type:'null'}]               → 可置空的输入
//   - 嵌套 BaseModel                          → **不会内联**，输出 $defs + { $ref: '#/$defs/X' }
//   - 在 $ref 上再挂 title/description        → { allOf: [ { $ref } ] }
//   - Dict[str, T]                            → { type:'object', additionalProperties:{...} }（无 properties）
//
// 迁移自离线 demo：processor-capability-form-demo.html（逻辑一致，只换了语言）。

/** 递归渲染层数上限：超过就退化为 JSON 文本域，防止自引用模型把栈打爆。 */
export const MAX_DEPTH = 3;

export interface JsonSchemaProp {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProp;
  anyOf?: JsonSchemaProp[];
  allOf?: JsonSchemaProp[];
  $ref?: string;
  properties?: Record<string, JsonSchemaProp>;
  additionalProperties?: JsonSchemaProp | boolean;
  /** 非标准字段：deref 解引用时回填的子模型名，仅供 UI 显示。 */
  _refName?: string;
}

export interface JsonSchema {
  title?: string;
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  $defs?: Record<string, JsonSchemaProp>;
  definitions?: Record<string, JsonSchemaProp>;
  required?: string[];
}

export type ConfigObject = Record<string, unknown>;

/**
 * 解引用：$ref / allOf[$ref] → 真实子 schema。
 * root 必须是带 $defs 的「顶层」config_schema —— $defs 只在顶层出现，
 * 递归时一路把 root 传下去，否则子模型解不开（会静默退化成字符串输入）。
 */
export function deref(
  prop: JsonSchemaProp,
  root?: JsonSchema,
  depth = 0,
): JsonSchemaProp {
  if (!prop || typeof prop !== 'object' || depth > 8) return prop;
  if (prop.$ref) {
    const name = String(prop.$ref).split('/').pop() ?? '';
    const target = root?.$defs?.[name] ?? root?.definitions?.[name];
    return target ? { ...target, _refName: name } : prop;
  }
  if (Array.isArray(prop.allOf) && prop.allOf.length === 1) {
    const inner = deref(prop.allOf[0], root, depth + 1);
    const over: JsonSchemaProp = {};
    if (prop.title) over.title = prop.title;
    if (prop.description) over.description = prop.description;
    if (prop.default !== undefined) over.default = prop.default;
    return { ...inner, ...over };
  }
  if (Array.isArray(prop.anyOf)) {
    const parts = prop.anyOf.map((s) => deref(s, root, depth + 1));
    const over: JsonSchemaProp = {};
    const nn = parts.find((s) => s.type !== 'null');
    if (nn?._refName) over._refName = nn._refName; // 让 UI 能显示子模型名
    return { ...prop, anyOf: parts, ...over };
  }
  return prop;
}

/**
 * 取「有效子 schema」：anyOf 包装时真正的 BaseModel / Dict 在非 null 分支上。
 * 递归渲染、递归对齐、递归清 null 都必须用它 —— 直接读 prop.properties 会拿到 undefined，
 * 表现是「整层不递归」，非常隐蔽。
 */
export function effective(prop: JsonSchemaProp): JsonSchemaProp {
  if (Array.isArray(prop.anyOf)) {
    const nn = prop.anyOf.find((s) => s.type !== 'null');
    if (nn) return nn;
  }
  return prop;
}

/** 有效类型：anyOf 取非 null 分支；$ref 解开后 object 自带 type。 */
export function baseType(prop: JsonSchemaProp): string {
  if (Array.isArray(prop.anyOf)) {
    const nonNull = prop.anyOf.find((s) => s.type !== 'null');
    return typeName(nonNull?.type) ?? 'string';
  }
  if (typeof prop.type === 'string') return prop.type;
  // 少数情况下 pydantic 会输出 type: ['string', 'null'] 这样的联合
  if (Array.isArray(prop.type))
    return prop.type.find((x) => x !== 'null') ?? 'string';
  return prop.properties ? 'object' : 'string';
}

/** JSON Schema 的 type 可能是联合数组，取标量名供 UI 展示/分支用。 */
export function typeName(t?: string | string[]): string | undefined {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.find((x) => x !== 'null');
  return undefined;
}

/** 是否允许 null。 */
export function isNullable(prop: JsonSchemaProp): boolean {
  return (
    (Array.isArray(prop.anyOf) && prop.anyOf.some((s) => s.type === 'null')) ||
    (Array.isArray(prop.type) && prop.type.includes('null'))
  );
}

/** 有 properties 的是嵌套 BaseModel，只有 additionalProperties 的是 Dict。 */
export function isDict(prop: JsonSchemaProp): boolean {
  return (
    baseType(prop) === 'object' &&
    !prop.properties &&
    !!prop.additionalProperties
  );
}

/**
 * 按 schema 造默认值。
 *
 * ⚠️ 注意 pydantic 的 `default_factory=list` **不产出 default 键**，
 * 所以「没有 default」不等于「这个字段没有默认值」—— 必须再按类型补：
 * array → []（写成 '' 的话提交上去后端必 422），object → 递归，数字 → minimum ?? 0。
 */
export function buildDefaults(
  schema: JsonSchema | undefined,
  root?: JsonSchema,
  depth = 0,
): ConfigObject {
  const r = root ?? schema;
  const out: ConfigObject = {};
  for (const [key, raw] of Object.entries(schema?.properties ?? {})) {
    const prop = deref(raw, r);
    const hasDef =
      raw.default !== undefined && !(raw.default === null && !isNullable(prop));
    if (hasDef) {
      out[key] = raw.default;
      continue;
    }
    const t = baseType(prop);
    if (t === 'object') {
      const eff = effective(prop);
      out[key] =
        eff.properties && depth < MAX_DEPTH
          ? buildDefaults(eff as JsonSchema, r, depth + 1)
          : {};
    } else if (t === 'array') out[key] = [];
    else if (t === 'boolean') out[key] = false;
    else if (t === 'integer' || t === 'number') out[key] = prop.minimum ?? 0;
    else out[key] = isNullable(prop) ? null : '';
  }
  return out;
}

/**
 * 切换能力时把旧配置与新 schema 对齐：同名字段类型相符则保留，否则丢弃；
 * 缺失补默认值；多余丢弃。嵌套对象递归对齐，内层丢弃的字段用 `父.子` 路径报出。
 *
 * 注意：可空字段的 null 是合法值，不能被当成「类型不符」丢掉。
 */
export function reconcile(
  oldCfg: ConfigObject | undefined,
  schema: JsonSchema | undefined,
  root?: JsonSchema,
  depth = 0,
): { value: ConfigObject; dropped: string[] } {
  const r = root ?? schema;
  const props = schema?.properties ?? {};
  const kept: ConfigObject = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(oldCfg ?? {})) {
    if (!(k in props)) {
      dropped.push(k);
      continue;
    }
    const prop = deref(props[k], r);
    const t = baseType(prop);
    const ok =
      t === 'object'
        ? v === null
          ? isNullable(prop)
          : typeof v === 'object' && !Array.isArray(v)
        : t === 'array'
          ? Array.isArray(v)
          : t === 'boolean'
            ? typeof v === 'boolean'
            : t === 'integer' || t === 'number'
              ? typeof v === 'number'
              : v === null
                ? isNullable(prop)
                : typeof v === 'string';
    if (!ok) {
      dropped.push(k);
      continue;
    }
    const eff = effective(prop);
    if (t === 'object' && eff.properties && v !== null && depth < MAX_DEPTH) {
      const sub = reconcile(v as ConfigObject, eff as JsonSchema, r, depth + 1);
      kept[k] = sub.value;
      sub.dropped.forEach((d) => {
        dropped.push(`${k}.${d}`);
      });
    } else kept[k] = v;
  }
  return { value: { ...buildDefaults(schema, r), ...kept }, dropped };
}

/** 数字被清空时回退默认值（避免写出 null 被后端拒）；嵌套对象递归处理。 */
export function sanitize(
  value: ConfigObject,
  schema: JsonSchema | undefined,
  root?: JsonSchema,
  depth = 0,
): ConfigObject {
  const r = root ?? schema;
  for (const [k, raw] of Object.entries(schema?.properties ?? {})) {
    const prop = deref(raw, r);
    const t = baseType(prop);
    if (t === 'object') {
      const eff = effective(prop);
      const v = value[k];
      if (v === null || v === undefined) {
        if (!isNullable(prop))
          value[k] = buildDefaults(eff as JsonSchema, r, depth + 1);
      } else if (eff.properties && depth < MAX_DEPTH) {
        value[k] = sanitize(v as ConfigObject, eff as JsonSchema, r, depth + 1);
      }
    } else if (t === 'integer' || t === 'number') {
      const cur = value[k];
      if (cur === null || cur === undefined || Number.isNaN(cur)) {
        value[k] =
          raw.default !== undefined ? raw.default : (prop.minimum ?? 0);
      }
    }
  }
  return value;
}

/** JSON 文本 → 对象。空串视为 {}；非法 JSON 返回 null（调用方据此提示）。 */
export function parseConfigText(text?: string): ConfigObject | null {
  const t = (text ?? '').trim();
  if (!t) return {};
  try {
    const v: unknown = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as ConfigObject)
      : null;
  } catch {
    return null;
  }
}
