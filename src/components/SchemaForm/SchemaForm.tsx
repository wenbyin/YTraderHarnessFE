// src/components/SchemaForm/SchemaForm.tsx
// 由 config_schema（pydantic v2 model_json_schema()）动态生成表单控件。
//
// ⚠️ 公共组件 —— 两处消费方共用同一份，**不要在任何页面里内联写字段分支**：
//   - pages/document_type_definition → 能力配置弹窗（CapabilityConfigModal）
//   - pages/tool                     → 处理器配置抽屉（ProcessorConfigDrawer）
// 2026-10-05 之前后者自己写了一份只有 enum / boolean / number 的简化版，
// `list[str]` 字段被渲染成单行输入框，用户填完提交上去是字符串 → 后端 pydantic 422。
//
// React 化的要点：
//  - 表单是「受控递归树」：每个字段拿到自己的 value + onChange，父级用不可变更新回写整棵对象。
//  - 嵌套 BaseModel 靠 deref($ref/$defs) + effective(anyOf 非 null 分支) 递归展开，最多 MAX_DEPTH 层。
//  - 可空（anyOf 含 null）字段提供「空值 (null)」开关：对象整组置空，标量置 null。

import { DownOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
} from 'antd';
import { useRef, useState } from 'react';

import {
  baseType,
  buildDefaults,
  type ConfigObject,
  deref,
  effective,
  isDict,
  isNullable,
  type JsonSchema,
  type JsonSchemaProp,
  MAX_DEPTH,
  typeName,
} from './schema';
import { useStyles } from './style';

/** enum 下拉里表示 null 的哨兵值（option.value 只能是 string）。 */
const NULL_SENTINEL = '__NULL__';

// ---------------- 复合控件 ----------------

let uidSeq = 0;
const nextUid = () => `arr-${++uidSeq}`;

/** 数组：字符串/数字项用行编辑，其他类型退回 JSON 文本。 */
export const ArrayEditor: React.FC<{
  itemsType?: string;
  value: unknown[];
  onChange: (next: unknown[]) => void;
}> = ({ itemsType, value, onChange }) => {
  const { styles } = useStyles();
  const list = Array.isArray(value) ? value : [];
  // 数组项是标量，没有天然 key；用并行 id 列表代替下标，
  // 否则删除中间项后 React 会复用错误的输入框状态。
  const idsRef = useRef<string[]>([]);
  if (idsRef.current.length !== list.length) {
    const next = idsRef.current.slice(0, list.length);
    while (next.length < list.length) next.push(nextUid());
    idsRef.current = next;
  }
  const ids = idsRef.current;
  const numeric = itemsType === 'integer' || itemsType === 'number';
  const setAt = (i: number, v: unknown) => {
    const next = [...list];
    next[i] = v;
    onChange(next);
  };
  return (
    <div>
      {list.length === 0 && <div className={styles.placeholder}>暂无条目</div>}
      {list.map((v, i) => (
        <div className={styles.row} key={ids[i]}>
          {numeric ? (
            <InputNumber
              size="small"
              style={{ width: '100%' }}
              value={v == null ? undefined : Number(v)}
              onChange={(n) => setAt(i, n == null ? null : Number(n))}
            />
          ) : (
            <Input
              size="small"
              value={v == null ? '' : String(v)}
              onChange={(e) => setAt(i, e.target.value)}
            />
          )}
          <Button
            size="small"
            type="link"
            danger
            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
          >
            删除
          </Button>
        </div>
      ))}
      <Button
        size="small"
        type="dashed"
        block
        onClick={() => onChange([...list, numeric ? 0 : ''])}
      >
        + 添加一项
      </Button>
    </div>
  );
};

/** Dict[str, T]：键值行编辑器（JSON Schema 里只有 additionalProperties、没有 properties）。 */
export const DictEditor: React.FC<{
  value: ConfigObject;
  onChange: (next: ConfigObject) => void;
  valueType?: string;
}> = ({ value, onChange, valueType }) => {
  const { styles } = useStyles();
  const entries = Object.entries(value ?? {});
  const rename = (oldKey: string, newKey: string) => {
    const next: ConfigObject = {};
    for (const [k, v] of entries) next[k === oldKey ? newKey : k] = v;
    onChange(next);
  };
  const add = () => {
    let k = 'key';
    let n = 1;
    while (k in (value ?? {})) k = `key_${n++}`;
    onChange({ ...value, [k]: '' });
  };
  const numeric = valueType === 'integer' || valueType === 'number';
  return (
    <div>
      {entries.length === 0 && (
        <div className={styles.placeholder}>暂无键值</div>
      )}
      {entries.map(([k, v]) => (
        <div className={styles.row} key={`kv-${k}`}>
          <Input
            size="small"
            style={{ flex: 1 }}
            value={k}
            onChange={(e) => rename(k, e.target.value)}
          />
          {numeric ? (
            <InputNumber
              size="small"
              style={{ flex: 1 }}
              value={v == null ? undefined : Number(v)}
              onChange={(n) =>
                onChange({ ...value, [k]: n == null ? null : Number(n) })
              }
            />
          ) : (
            <Input
              size="small"
              style={{ flex: 1 }}
              value={v == null ? '' : String(v)}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            />
          )}
          <Button
            size="small"
            type="link"
            danger
            onClick={() => {
              const next: ConfigObject = {};
              for (const [k2, v2] of entries) if (k2 !== k) next[k2] = v2;
              onChange(next);
            }}
          >
            删除
          </Button>
        </div>
      ))}
      <Button size="small" type="dashed" block onClick={add}>
        + 添加键值
      </Button>
    </div>
  );
};

// ---------------- 递归字段 ----------------

/**
 * 嵌套对象 / Dict 字段（独立组件，因为要用 useState 控制折叠）。
 *
 * 父级 label 的取值顺序：**$ref 指向的子模型的 description** → 字段 title → 字段名。
 * pydantic 模型的 docstring 会落到子 schema 的 description 上，比裸 key（如 `ocr`）可读得多；
 * 只有字段名时用户根本看不出这一组是什么。
 */
export const ObjectField: React.FC<{
  root: JsonSchema;
  prop: JsonSchemaProp;
  name: string;
  value: unknown;
  depth: number;
  onChange: (next: unknown) => void;
}> = ({ root, prop: p, name, value, depth, onChange }) => {
  const { styles } = useStyles();
  const eff = effective(p);
  const dict = isDict(eff);
  const nullable = isNullable(p);
  const isNull = value == null;
  /** 子节点默认展开；折叠后只留子卡片头部（含空值开关，避免置空后无法恢复）。 */
  const [open, setOpen] = useState(true);

  const valueType =
    typeof eff.additionalProperties === 'object'
      ? typeName(eff.additionalProperties?.type)
      : undefined;
  const depthCls =
    depth === 1 ? styles.subCardD1 : depth >= 2 ? styles.subCardD2 : '';

  const subLabel = eff.description ?? p.title ?? name;
  const descText =
    subLabel === eff.description
      ? p.description
      : (p.description ?? eff.description);
  const typeTag = dict ? 'Dict' : (p._refName ?? 'object');

  return (
    <div className={styles.field}>
      <div className={styles.fieldTop}>
        <span className={styles.label}>{subLabel}</span>
        <span className={styles.keyName}> {name} </span>
        <Tag>{nullable ? `${typeTag} | null` : typeTag}</Tag>
      </div>
      {descText && <div className={styles.desc}>{descText}</div>}
      <div
        className={`${styles.subCard} ${depthCls} ${
          isNull ? styles.disabledArea : ''
        }`}
      >
        <div className={styles.subHead}>
          <span
            className={styles.collapseBtn}
            onClick={() => setOpen((v) => !v)}
          >
            <DownOutlined
              style={{
                fontSize: 10,
                transition: 'transform .25s ease',
                transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
              }}
            />
          </span>
          <span className={styles.subName}>
            {eff.title ?? eff._refName ?? name}
          </span>
          <Tag color="purple">{eff._refName ?? 'object'}</Tag>
          {dict && <Tag>{`Dict[str, ${valueType ?? 'any'}]`}</Tag>}
          {nullable && (
            <Checkbox
              checked={isNull}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? null
                    : buildDefaults(eff as JsonSchema, root, depth + 1),
                )
              }
            >
              空值 (null)
            </Checkbox>
          )}
        </div>
        {!open ? null : isNull ? (
          <div className={styles.placeholder}>已置空（null）</div>
        ) : dict ? (
          <DictEditor
            value={(value as ConfigObject) ?? {}}
            valueType={valueType}
            onChange={onChange}
          />
        ) : depth >= MAX_DEPTH ? (
          <>
            <div className={styles.placeholder}>
              嵌套超过 {MAX_DEPTH} 层，已退化为 JSON 文本（防自引用）
            </div>
            <Input.TextArea
              rows={4}
              value={JSON.stringify(value ?? {}, null, 2)}
              onChange={(e) => {
                try {
                  onChange(JSON.parse(e.target.value || '{}'));
                } catch {
                  /* 输入中途可能不合法，保持上一次的值 */
                }
              }}
            />
          </>
        ) : (
          <SchemaForm
            root={root}
            schema={eff as JsonSchema}
            value={(value as ConfigObject) ?? {}}
            depth={depth + 1}
            onChange={onChange}
          />
        )}
      </div>
    </div>
  );
};

export interface SchemaFieldProps {
  /** 顶层 schema（含 $defs），解 $ref 用。 */
  root: JsonSchema;
  rawProp: JsonSchemaProp;
  name: string;
  value: unknown;
  depth: number;
  onChange: (next: unknown) => void;
}

export const SchemaField: React.FC<SchemaFieldProps> = ({
  root,
  rawProp,
  name,
  value,
  depth,
  onChange,
}) => {
  const { styles } = useStyles();
  const p = deref(rawProp, root);
  const t = baseType(p);
  const nullable = isNullable(p);

  const typeTag =
    t === 'array'
      ? 'array[]'
      : t === 'object'
        ? isDict(p)
          ? 'Dict'
          : (p._refName ?? 'object')
        : t;

  const header = (
    <div className={styles.fieldTop}>
      <span className={styles.label}>{p.title ?? name}</span>
      {/* 英文 key 两侧留空格：中英混排时更好读 */}
      <span className={styles.keyName}> {name} </span>
      <Tag>{nullable ? `${typeTag} | null` : typeTag}</Tag>
    </div>
  );
  const desc = p.description ? (
    <div className={styles.desc}>{p.description}</div>
  ) : null;

  // ---- 枚举 → 下拉（可空时多一个 null 选项）
  if (p.enum) {
    const options = p.enum.map((v) => ({ label: String(v), value: String(v) }));
    if (nullable)
      options.push({ label: '（空值 null）', value: NULL_SENTINEL });
    return (
      <div className={styles.field}>
        {header}
        {desc}
        <Select
          size="small"
          style={{ width: '100%' }}
          value={value == null ? NULL_SENTINEL : String(value)}
          options={options}
          onChange={(sv) => {
            if (sv === NULL_SENTINEL) {
              onChange(null);
              return;
            }
            const raw = p.enum?.find((e) => String(e) === sv);
            onChange(raw ?? sv);
          }}
        />
      </div>
    );
  }

  // ---- 布尔：三态（可空）用下拉，否则开关
  if (t === 'boolean') {
    if (nullable) {
      return (
        <div className={styles.field}>
          {header}
          {desc}
          <Select
            size="small"
            style={{ width: '100%' }}
            value={value == null ? NULL_SENTINEL : String(value)}
            options={[
              { label: 'true', value: 'true' },
              { label: 'false', value: 'false' },
              { label: '（空值 null）', value: NULL_SENTINEL },
            ]}
            onChange={(sv) =>
              onChange(sv === NULL_SENTINEL ? null : sv === 'true')
            }
          />
        </div>
      );
    }
    return (
      <div className={styles.field}>
        {header}
        {desc}
        <Switch
          size="small"
          checked={!!value}
          onChange={(c) => onChange(c)}
          checkedChildren="开"
          unCheckedChildren="关"
        />
      </div>
    );
  }

  // ---- 数字
  if (t === 'integer' || t === 'number') {
    return (
      <div className={styles.field}>
        {header}
        {desc}
        <InputNumber
          size="small"
          style={{ width: '100%' }}
          min={p.minimum}
          max={p.maximum}
          step={t === 'integer' ? 1 : 0.01}
          value={value == null ? undefined : Number(value)}
          onChange={(n) => onChange(n == null ? null : Number(n))}
        />
        {(p.minimum !== undefined || p.maximum !== undefined) && (
          <div className={styles.placeholder}>
            {p.minimum ?? '-∞'} ~ {p.maximum ?? '+∞'}
          </div>
        )}
      </div>
    );
  }

  // ---- 数组
  if (t === 'array') {
    return (
      <div className={styles.field}>
        {header}
        {desc}
        <ArrayEditor
          itemsType={typeName(p.items?.type)}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      </div>
    );
  }

  // ---- 嵌套对象 / Dict（含折叠，抽成独立组件）
  if (t === 'object') {
    return (
      <ObjectField
        root={root}
        prop={p}
        name={name}
        value={value}
        depth={depth}
        onChange={onChange}
      />
    );
  }

  // ---- 字符串（可空时带置空开关）
  return (
    <div className={styles.field}>
      {header}
      {desc}
      {nullable ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            size="small"
            style={{ flex: 1 }}
            disabled={value == null}
            value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
          <Checkbox
            checked={value == null}
            onChange={(e) => onChange(e.target.checked ? null : '')}
          >
            空值
          </Checkbox>
        </div>
      ) : (
        <Input
          size="small"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
};

export interface SchemaFormProps {
  root: JsonSchema;
  schema: JsonSchema;
  value: ConfigObject;
  depth: number;
  onChange: (next: ConfigObject) => void;
  /**
   * properties 为空时的空态文案。默认文案说的是「能力」，
   * 处理器配置那条路径措辞不同，由调用方覆盖。
   */
  emptyText?: React.ReactNode;
}

export const SchemaForm: React.FC<SchemaFormProps> = ({
  root,
  schema,
  value,
  depth,
  onChange,
  emptyText,
}) => {
  const { styles } = useStyles();
  const props = schema?.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return (
      <div className={styles.emptyCfg}>
        {emptyText ?? '该能力没有可配置参数（config_schema.properties 为空）'}
      </div>
    );
  }
  return (
    <>
      {keys.map((k) => (
        <SchemaField
          key={k}
          root={root}
          rawProp={props[k]}
          name={k}
          value={value?.[k]}
          depth={depth}
          onChange={(v) => onChange({ ...value, [k]: v })}
        />
      ))}
    </>
  );
};

export default SchemaForm;
