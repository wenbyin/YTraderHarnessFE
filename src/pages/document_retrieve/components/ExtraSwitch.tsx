// src/pages/document_retrieve/components/ExtraSwitch.tsx
// 折叠标题栏右侧的开关。
//
// 为什么要单独包一层：rc-collapse 把 extra 渲染成 header div 的**子节点**
// （@rc-component/collapse/es/Panel.js：headerProps 上挂着 onClick，
// extra 是它的第三个 children），所以点开关时事件会冒泡到 header，
// 结果是「切开关」和「展开/折叠当前段」同时发生。
//
// 这里在 extra 内部就把 click / keydown 截断，两个动作互不干扰。
// 键盘也要拦：header 是 role=button，键盘操作同样会冒泡上去。
import { Switch } from 'antd';
import React from 'react';

interface ExtraSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const ExtraSwitch: React.FC<ExtraSwitchProps> = ({ checked, onChange }) => (
  <span
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
  >
    <Switch size="small" checked={checked} onChange={onChange} />
  </span>
);

export default ExtraSwitch;
