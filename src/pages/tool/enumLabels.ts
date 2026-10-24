// src/pages/tool/enumLabels.ts
//
// 契约枚举值 → 展示文案。
//
// 为什么单独一层，而不是在每个组件里写死中文映射：
//   - 这几个值散落在列表卡、详情头、概览表、处理器库、时间轴、配置抽屉六处，
//     写死就是六份会各自漂移的副本；
//   - 语言切换要走 i18n，写死就切不了。
//
// **回落策略是这个文件的核心**：`formatMessage` 一律带 `defaultMessage: value`，
// 没配的 key 就显示契约原值。source_type 是开放字符串（tool.yaml 里是裸 string，
// 注释写着 "local_method / mcp / openapi / ..."），必然有新值进来 ——
// 漏翻不能显示成 undefined / key 名，那就成了报错而不是"还没翻译"。
//
// 展示上还要求**原值仍然可见**（tag 的 title、字段说明里），中文只是给人扫读，
// 对接口时得按原值说话。

import { useIntl } from '@umijs/max';

import type {
  ExecutionMode,
  ProcessorHook,
  ProcessorType,
} from './processorChain';

type Group =
  | 'source_type'
  | 'source_state'
  | 'hook'
  | 'execution_mode'
  | 'processor_type';

export interface EnumLabels {
  sourceType: (value: string) => string;
  sourceState: (value: string) => string;
  hook: (value: ProcessorHook) => string;
  mode: (value: ExecutionMode) => string;
  processorType: (value: ProcessorType) => string;
  /** 原值 + 译文，用在「既要看懂又要能对接口」的地方（下拉选项说明之类） */
  hookBoth: (value: ProcessorHook) => string;
  modeBoth: (value: ExecutionMode) => string;
}

export function useEnumLabels(): EnumLabels {
  const intl = useIntl();

  const label = (group: Group, value: string): string =>
    intl.formatMessage({
      id: `tool.${group}.${value}`,
      defaultMessage: value,
    }) || value;

  const both = (group: Group, value: string): string =>
    label(group, value) === value ? value : `${value} ${label(group, value)}`;

  return {
    sourceType: (v) => label('source_type', v),
    sourceState: (v) => label('source_state', v),
    hook: (v) => label('hook', v),
    mode: (v) => label('execution_mode', v),
    processorType: (v) => label('processor_type', v),
    hookBoth: (v) => both('hook', v),
    modeBoth: (v) => both('execution_mode', v),
  };
}
