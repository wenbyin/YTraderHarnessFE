// src/pages/skill/components/CapabilitySelect.tsx
//
// 列表页的「按能力筛选」。
//
// ⚠️ 这里只做**筛选**，不做绑定 —— 绑定在 SkillDrawer 里用树形多选
//    （CapabilityTreePicker，与工具页「业务分类」同款）。两处控件不一样是
//    故意的：
//      · 绑定要看清层级、"父子互不联动"，树是对的形状；
//      · 筛选是一次性的定位动作，输入 "ocr" 就命中，比在树里翻快得多。
//
// 标签用完整路径（「检索 / 全文召回」），code 显示在右侧 —— 能力 code 是
// dotted path，同名能力靠它区分。
import type { SelectProps } from 'antd';
import { Select } from 'antd';
import React, { useMemo } from 'react';
import type { Capability } from '../data';
import { capabilityPath } from '../data';
import { useStyles } from '../style';

interface CapabilityOption {
  value: string;
  /** 展示用：带层级路径，避免同名能力分不清 */
  label: string;
  name: string;
  code: string;
  isActive: boolean;
}

interface Props {
  capabilities: readonly Capability[];
  className?: string;
  disabled?: boolean;
  value?: string;
  onChange?: (value: string | undefined) => void;
  placeholder?: string;
}

/** 把扁平的 capability 列表摊成 Select 的 options（按路径排序，便于扫读）。 */
function buildOptions(capabilities: readonly Capability[]): CapabilityOption[] {
  return capabilities
    .map((item) => ({
      value: item.id,
      label: capabilityPath(capabilities, item.id) || item.name,
      name: item.name,
      code: item.code,
      isActive: item.is_active !== false,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

const CapabilitySelect: React.FC<Props> = ({
  capabilities,
  className,
  disabled,
  value,
  onChange,
  placeholder,
}) => {
  const { styles } = useStyles();
  const options = useMemo(() => buildOptions(capabilities), [capabilities]);

  const optionRender: SelectProps['optionRender'] = (option) => {
    const item = option.data as unknown as CapabilityOption | undefined;
    // 兜底：antd 升级后如果不再把原始 option 挂到 data 上，至少别白屏
    if (!item) return <span>{option.label as React.ReactNode}</span>;
    return (
      <span className={styles.option}>
        <span>
          {item.label}
          {item.isActive ? null : (
            <span className={styles.optionCode}>（已停用）</span>
          )}
        </span>
        <span className={styles.optionCode}>{item.code}</span>
      </span>
    );
  };

  const filterOption: SelectProps['filterOption'] = (input, option) => {
    const item = option?.data as unknown as CapabilityOption | undefined;
    if (!item) return true;
    const haystack = `${item.label} ${item.name} ${item.code}`.toLowerCase();
    return haystack.includes(input.trim().toLowerCase());
  };

  return (
    <Select<string>
      className={className}
      allowClear
      disabled={disabled}
      value={value}
      onChange={(next) => onChange?.(next)}
      options={options}
      placeholder={placeholder ?? '按能力筛选'}
      // v6 里 filterOption 挪到 showSearch 对象上（顶层那个已 deprecated）
      showSearch={{ filterOption }}
      optionRender={optionRender}
    />
  );
};

export default CapabilitySelect;
