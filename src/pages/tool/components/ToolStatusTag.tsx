// src/pages/tool/components/ToolStatusTag.tsx
//
// 「这个工具现在是什么状态」—— 列表卡与详情头共用**同一个槽位**。
//
// ⚠️ 契约里 `enabled` 与 `source_state` 是两个**正交字段**（tool.yaml 分开定义，
//    注释也写明 enabled 不属于 manifest）。但产品口径只要**一个**状态：
//    2026-10-25 用户明确要求「已下线 要覆盖 生效中 TAG」——
//    下线了还显示"生效中"，两个标签并排，读起来像是两件独立的事。
//    所以这里是**展示层合并**，数据模型不动：请求里两个字段照旧分别读。
//
// 优先级：MISSING > 已下线 > ACTIVE
//   已下线只覆盖 ACTIVE。MISSING 是"代码里已经找不到它"（同步的结果），比
//   "被人从运行时掐掉"更根本；而且 MISSING 的工具本来就不参与下发，
//   这时候再标一个下线没有信息量，反而把更要紧的事实盖掉了。

import { Tag } from 'antd';
import type React from 'react';
import {
  isToolEnabled,
  SOURCE_STATE_COLOR,
  TOOL_DISABLED_COLOR,
  type ToolSourceState,
} from '../data';
import { useEnumLabels } from '../enumLabels';

interface ToolStatusTagProps {
  sourceState: ToolSourceState;
  /** 老后端没有这个字段时是 undefined —— 与 `isToolEnabled` 的 fail-open 口径一致。 */
  enabled?: boolean | null;
  style?: React.CSSProperties;
}

const ToolStatusTag: React.FC<ToolStatusTagProps> = ({
  sourceState,
  enabled,
  style,
}) => {
  const labels = useEnumLabels();

  if (sourceState === 'MISSING') {
    return (
      <Tag
        color={SOURCE_STATE_COLOR.MISSING}
        style={style}
        title="source_state = MISSING：代码里已找不到这个工具"
      >
        {labels.sourceState('MISSING')}
      </Tag>
    );
  }

  if (!isToolEnabled({ enabled })) {
    return (
      <Tag
        color={TOOL_DISABLED_COLOR}
        style={style}
        title="enabled = false：运行时已下线，下一轮工具解析不再下发给 LLM"
      >
        {labels.enabled(false)}
      </Tag>
    );
  }

  return (
    <Tag
      color={SOURCE_STATE_COLOR.ACTIVE}
      style={style}
      title="source_state = ACTIVE：代码里有、运行时也开着"
    >
      {labels.sourceState('ACTIVE')}
    </Tag>
  );
};

export default ToolStatusTag;
