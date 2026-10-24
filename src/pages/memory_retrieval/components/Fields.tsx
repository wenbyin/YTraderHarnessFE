// src/pages/memory_retrieval/components/Fields.tsx
//
// 这一组是"表单控件"，五个接口共用 —— target 三件套（查谁的记忆）在五个 tab 上
// 是同一份语义，各写一遍一定会分叉（比如某个 tab 忘了把空串丢掉）。
//
// ⚠️ 2026-10-11 契约重写后这里也变了三处：
//   `org_id` -> `team_id`（库里那一列还叫 org_id）、`agent_id` 变**必填**、
//   上一版的 `budget`（四个条数）拆成了 `retrieve`（开不开）+ `limits`（几条）
//   两个旋钮 —— 所以这一版把它们做成了**一片里的两列**，让"两个旋钮"这件事
//   在界面上自己说出来。
//
// ⚠️ target 的"二选一"由**一个开关**表达（同上 2026-10-11）：user_id 与 team_id
//    恰有一个 —— 这是**结构上保证**的（切过去就把另一侧清掉），不是靠事后校验。
//    所以界面上只渲染当前那一侧的控件，另一侧根本不出现。
//    ⚠️ 2026-10-12：这个开关**搬到了左侧那张卡的卡头左边**（与右上角的端点 Tag
//       同一行），所以它和参数控件不再在同一个 DOM 位置 —— 状态上提到页面，
//       由 `useScopeSwitch` 驱动，这里只负责渲染（ScopeSwitch / ScopeFields）。
//
// ⚠️ 这里不用 antd Form：本页是"查询台"（每个 tab 一组独立参数、随时改随时发），
//    受控 state 比 Form 直白，也避开了 Form.Item 只往**直接子节点**注入
//    value/onChange 那个坑（包一层 div 字段就静默脱离表单，tsc / biome /
//    antd lint 全抓不到，只有浏览器里看到 value 是空的才发现）。
//
// 子组件各自 useStyles()（与 document_retrieve 下的组件同一写法），不从上往下传 styles。
import { InfoCircleOutlined } from '@ant-design/icons';
import {
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ReactNode } from 'react';
import React, { useEffect, useState } from 'react';

import type { ScopeKind } from '../data';
import { useStyles } from '../style';
import {
  AGENT_ID_OPTIONS,
  type OrderOption,
  PREVIEW_LAYER_ORDER,
  PREVIEW_LIMIT_META,
  PREVIEW_SWITCH_META,
  type PreviewLayersInput,
  type PreviewLimitsInput,
  resolveScopeKind,
  switchScopeTarget,
  type TargetInput,
  targetProblem,
  targetProblemText,
} from '../utils';
import { UserPicker } from './UserPicker';

export interface FieldRowProps {
  label: ReactNode;
  /** 参数下方的说明。这一列是"填错也不会报错"的地方，必须留位置。 */
  hint?: ReactNode;
  children: ReactNode;
}

/** 一行 = 一个参数：左侧定宽标签，右侧控件 + 说明。 */
export const FieldRow: React.FC<FieldRowProps> = ({
  label,
  hint,
  children,
}) => {
  const { styles } = useStyles();
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldLabel}>{label}</div>
      <div className={styles.fieldControl}>
        {children}
        {hint ? <div className={styles.fieldHint}>{hint}</div> : null}
      </div>
    </div>
  );
};

/** 带 tooltip 的字段名 —— 括号里的口径说明太长，正文放结论、原因挂 tooltip。 */
export const LabelWithTip: React.FC<{ text: string; tip: string }> = ({
  text,
  tip,
}) => (
  <span>
    {text}
    <Tooltip title={tip}>
      <InfoCircleOutlined style={{ marginLeft: 4, opacity: 0.5 }} />
    </Tooltip>
  </span>
);

export interface ScopeFieldsProps {
  target: TargetInput;
  /**
   * 这一格查谁的记忆 —— **由页面持有**。
   *
   * 2026-10-12：开关从参数区挪到了左侧那张卡的**卡头左边**（与右上角的端点 Tag
   * 同一行），于是它和这片参数控件不再在同一个 DOM 位置，内部 state 就没法把
   * "切了哪一侧"传给参数区 —— 只能上提到页面（见 `useScopeSwitch`）。
   */
  scope: ScopeKind;
  sessionId: string;
  onTargetChange: (next: TargetInput) => void;
  onSessionChange: (next: string) => void;
  /**
   * 这个接口吃不吃 session_id。
   * ⚠️ L2/L3 **不受 session_id 影响**（它们的粒度是 scope，不是会话）——
   *    契约明说，所以它们不画这个输入框，而不是画一个"填了没用"的。
   */
  showSession?: boolean;
  disabled?: boolean;
}

/**
 * 「个人 / 团队」开关本身 —— 渲染在左侧那张卡的**卡头左边**。
 *
 * ⚠️ 它是**受控**的（state 在页面上，见 `useScopeSwitch`）：开关与参数控件不在同一
 *    个 DOM 位置，组件内部藏 state 就没法把"切哪一侧"这件事告诉参数区。
 *
 * 为什么不加文字标签：开关自己带着 `个人 / 团队` 两个档位文字，再加一行标签就是重复。
 */
export const ScopeSwitch: React.FC<{
  scope: ScopeKind;
  onChange: (team: boolean) => void;
  disabled?: boolean;
}> = ({ scope, onChange, disabled }) => (
  <Switch
    checked={scope === 'team'}
    disabled={disabled}
    checkedChildren="团队"
    unCheckedChildren="个人"
    onChange={onChange}
  />
);

/**
 * 「个人 / 团队」开关的状态机 —— **页面与单测共用这一份**。
 *
 * ⚠️ 不能只靠 `resolveScopeKind(target)` 推 —— 它只在**恰有一个归属有值**时才给
 *    结论，而"选了团队、组织名还没填"的那一瞬间 target 是空的。那一刻推出来的
 *    会是 null，开关就自己弹回「个人」，看起来像点了没反应。
 *    所以：**有值时跟着 target 走，没值时保持用户最后点的那个**。
 *
 * 抽成 hook 是为了让单测跑的就是页面那套逻辑 —— 在测试里再抄一遍的话，
 * 抄错了单测照样绿。
 */
export function useScopeSwitch(
  target: TargetInput,
  onTargetChange: (next: TargetInput) => void,
) {
  const resolved = resolveScopeKind(target);
  const [scope, setScope] = useState<ScopeKind>(() => resolved ?? 'user');
  useEffect(() => {
    if (resolved) setScope(resolved);
  }, [resolved]);

  /** 切过去 = 把**另一侧**清掉。"恰有一个"就是这么来的，不靠事后校验。 */
  const change = (team: boolean) => {
    const next: ScopeKind = team ? 'team' : 'user';
    setScope(next);
    onTargetChange(switchScopeTarget(target, next));
  };

  /** 页面级「重置」要连它一起清 —— 否则重置完开关还停在「团队」档上。 */
  const reset = () => setScope('user');

  return { scope, change, reset };
}

/**
 * target 三件套 + 会话。
 *
 * 查谁的记忆（个人 / 团队）由**卡头上那个开关**决定，state 在页面上
 * （`useScopeSwitch`）。契约要求"恰有一个"，这里靠结构保证 —— 开关切过去就
 * **把另一侧清掉**，界面上只渲染当前那一侧的控件。于是三种不合法形态里，
 * "两个都给"从 UI 上根本发不出来；剩下的两种（一个都没给、agent_id 为空）
 * 在下面实时标出来。
 *
 * 界面上实时回显两件事，都是"不看就一定会踩"的：
 *   1. **会被解析成哪种 scope**（user / team）—— 两种查询在数据上都是合法的
 *      空结果，"查错了人"事后没有任何办法发现；
 *   2. **agent_id 必填** —— 它传错的表现是空结果而不是报错。
 *
 * ⚠️ `user_id` 是**选**出来的，不是填出来的（UserPicker，接 /users/search）。
 *    原因就是上面第 1 条：让手打 36 位的 UUID，等于把"查错了人发现不了"
 *    这件事做到极致。
 *    `agent_id` 同样改成**选**（只有一个候选 `general`，见 AGENT_ID_OPTIONS）——
 *    它传错的表现是**空结果而不是报错**，所以手打这件事的风险与 user_id 一样高。
 *    只有 `team_id` 仍是文本：它是组织名，没有可查的地方。
 */
export const ScopeFields: React.FC<ScopeFieldsProps> = ({
  target,
  scope,
  sessionId,
  onTargetChange,
  onSessionChange,
  showSession = false,
  disabled,
}) => {
  const { styles } = useStyles();
  const problem = targetProblem(target);
  const patch = (part: Partial<TargetInput>) =>
    onTargetChange({ ...target, ...part });

  const team = scope === 'team';

  // 归属这一栏的说明：没填/双填时如实说一句，填好了就只留档位标识。
  const scopeHint = (
    <>
      {problem ? <div>{targetProblemText(problem)}</div> : null}
      <span className={styles.scopeCaption}>
        {team ? 'team · 团队记忆' : 'personal · 个人记忆'}
      </span>
    </>
  );

  return (
    <div className={styles.column}>
      {team ? (
        <FieldRow label="org_id" hint={scopeHint}>
          <Input
            value={target.team_id}
            disabled={disabled}
            allowClear
            placeholder="团队记忆的归属组织"
            onChange={(e) => patch({ team_id: e.target.value })}
          />
        </FieldRow>
      ) : (
        <FieldRow label="user_id" hint={scopeHint}>
          <UserPicker
            value={target.user_id}
            disabled={disabled}
            onChange={(user) => patch({ user_id: user?.id ?? '' })}
          />
        </FieldRow>
      )}

      <FieldRow label="agent_id">
        <Select
          data-agent-picker="true"
          value={target.agent_id || undefined}
          disabled={disabled}
          placeholder="选择一个 agent"
          options={AGENT_ID_OPTIONS.map((id) => ({ value: id, label: id }))}
          onChange={(next) => patch({ agent_id: next ?? '' })}
        />
      </FieldRow>

      {showSession ? (
        <FieldRow
          label="session_id"
          hint={
            <>
              可选。<b>不给就是跨会话召回（默认）</b>
            </>
          }
        >
          <Input
            value={sessionId}
            disabled={disabled}
            allowClear
            placeholder="留空 = 跨会话召回"
            onChange={(e) => onSessionChange(e.target.value)}
          />
        </FieldRow>
      ) : null}
    </div>
  );
};

export interface OrderFieldProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: Array<OrderOption<T>>;
  disabled?: boolean;
}

/**
 * 排序选择。
 *
 * ⚠️ 三个浏览端点的 order 枚举**各不相同**（L0 有会话内序、L1 有优先级序、
 *    L2 只有文件名），所以这里收一个 options 数组，而不是内部写死一份 ——
 *    写死就会让某一层出现契约里根本不存在的取值。
 */
export function OrderField<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: OrderFieldProps<T>) {
  return (
    <Select<T>
      value={value}
      disabled={disabled}
      style={{ width: '100%' }}
      onChange={onChange}
      options={options}
    />
  );
}

/** 行内一个小数字输入（limit），右边跟一句量纲说明。 */
export const LimitField: React.FC<{
  value: number;
  onChange: (next: number) => void;
  min: number;
  max?: number;
  disabled?: boolean;
  suffix?: ReactNode;
}> = ({ value, onChange, min, max, disabled, suffix }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <InputNumber
      value={value}
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      style={{ width: 108 }}
      onChange={(next) => {
        if (next === null) return;
        onChange(Number(next));
      }}
    />
    {suffix ? (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {suffix}
      </Typography.Text>
    ) : null}
  </div>
);

export interface PreviewLayersFieldsProps {
  retrieve: PreviewLayersInput;
  limits: PreviewLimitsInput;
  onRetrieveChange: (next: PreviewLayersInput) => void;
  onLimitsChange: (next: PreviewLimitsInput) => void;
  disabled?: boolean;
}

/**
 * 汇总预览的**四个开关 + 三层的条数**。
 *
 * ⚠️ 顺序是 **L0 -> L3 升序**（用户 2026-10-12 要求"检索条件也是排序"）——
 *    直接遍历 `PREVIEW_LAYER_ORDER`，别在这里再写一遍字面量数组，否则它和
 *    "召回记忆的顺序"迟早会走散。
 *
 * ⚠️ 四层**不是一类东西**，界面上必须说清（`meta.recalls`）：
 *    · `l0` / `l1` 打开 = 以 `input` 为查询串**真的跑一轮混合召回**；
 *    · `l2` / `l3` 打开 = 多带一段"每轮都有的现成内容"。
 *    把两者说成同一件事，用户会以为四个开关一样便宜。
 *
 * 条数与开关是**两个旋钮**（"要不要"与"几条"），所以做成一片里的两列，关掉的层
 * 条数直接禁用 —— "关了它条数还有意义吗"这个疑问在界面上自己就答了。
 */
export const PreviewLayersFields: React.FC<PreviewLayersFieldsProps> = ({
  retrieve,
  limits,
  onRetrieveChange,
  onLimitsChange,
  disabled,
}) => {
  const { styles } = useStyles();

  return (
    <div className={styles.column}>
      {PREVIEW_LAYER_ORDER.map((layer) => {
        const meta = PREVIEW_SWITCH_META[layer];
        const on = retrieve[layer];
        const limitKey = meta.limitKey;
        const limit = limitKey ? PREVIEW_LIMIT_META[limitKey] : null;
        return (
          <FieldRow
            key={layer}
            label={
              <>
                {meta.label}
                <div className={styles.fieldHint} style={{ marginTop: 0 }}>
                  默认{meta.defaultOn ? '开' : '关'}
                </div>
              </>
            }
          >
            <div className={styles.inlineRow}>
              <Switch
                data-preview-layer={layer}
                size="small"
                checked={on}
                disabled={disabled}
                onChange={(next) =>
                  onRetrieveChange({ ...retrieve, [layer]: next })
                }
              />
              {limit && limitKey ? (
                <InputNumber
                  value={limits[limitKey]}
                  min={limit.min}
                  max={limit.max}
                  step={1}
                  style={{ width: 92 }}
                  disabled={disabled || !on}
                  onChange={(next) => {
                    if (next === null) return;
                    onLimitsChange({
                      ...limits,
                      [limitKey]: Math.floor(Number(next)),
                    });
                  }}
                />
              ) : (
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12 }}
                ></Typography.Text>
              )}
              {/*
                关掉的层，条数是禁用的 —— 用一枚 tag 说清"为什么灰着"。
                打开召回层 = 这次预览会多花一轮检索的代价 —— 让它显形。
                ⚠️ 这两枚 Tag 曾经被格式化工具吃掉过一次（只剩注释）→ 有单测/探针钉着。
              */}
              {limitKey && !on ? <Tag>已关闭，条数不生效</Tag> : null}
              {meta.recalls && on ? (
                <Tag color="warning">这次会跑一轮召回</Tag>
              ) : null}
            </div>
          </FieldRow>
        );
      })}
    </div>
  );
};

export interface SwitchRowProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  text: ReactNode;
  hint?: ReactNode;
}

export const SwitchRow: React.FC<SwitchRowProps> = ({
  checked,
  onChange,
  disabled,
  text,
  hint,
}) => {
  const { styles } = useStyles();
  return (
    <div className={styles.switchRow}>
      <Switch
        size="small"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <div className={styles.switchBody}>
        <div>{text}</div>
        {hint ? <div className={styles.fieldHint}>{hint}</div> : null}
      </div>
    </div>
  );
};
