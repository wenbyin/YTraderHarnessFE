// src/components/CopilotDock/messageActionIcons.tsx
//
// 消息卡片下方那行操作图标的**唯一来源** —— 我的消息（复制 / 编辑）与助手消息
// （重新生成 / 复制 / 赞 / 踩）共用这一份节点。
//
// 为什么必须集中（2026-10-21 用户要求）
// ---------------------------------
//   「双方消息卡片下方 icon 统一来源和效果样式大小，相同功能要用相同 icon」。
//   之前两边各用各的：我的消息用 antd 的 CopyOutlined / EditOutlined，
//   助手消息用库自带的 SVG（细线、20px 按钮、最浅一档灰）——
//   同一个「复制」在两条消息下面长得不一样。
//
// 用法（两处，别新增第三处）
// ----------------------
//   · 我的消息：`<UserMessageActions>` 直接用 MESSAGE_ACTION_ICONS.copy / copied / edit；
//   · 助手消息：把 CHAT_ACTION_ICONS 整个交给 CopilotChat 的 icons prop
//     （见 index.tsx）。库是 `{...默认图标, ...icons}` 合并的，所以只覆盖这四个
//     不会影响发送 / 停止 / 转圈那几个（Composer 还要用它们）。
//
// ⚠️ 这里只放**图标节点**，不放尺寸和颜色：大小 / 颜色 / 热区由 style.ts 的
//    userAction 与 .copilotKitMessageControlButton 两条样式对齐到同一组 token
//    （controlHeightSM = 24、fontSizeLG = 16、colorTextTertiary → hover colorText）。
// ⚠️ 导出的是**模块级常量**（不是每次渲染新建）：CopilotChat 内部
//    useMemo([icons])，每次渲染都传一个新对象会让它把整套图标重算一遍。
import {
  CopyOutlined,
  DislikeOutlined,
  EditOutlined,
  LikeOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type React from 'react';

/** 「这个功能长什么样」—— 功能相同就必须是同一个节点。 */
export const MESSAGE_ACTION_ICONS: Record<
  'copy' | 'copied' | 'edit' | 'regenerate' | 'thumbsUp' | 'thumbsDown',
  React.ReactNode
> = {
  /** 复制：两边共用（我的消息 / 助手消息）。 */
  copy: <CopyOutlined />,
  /**
   * 复制成功的瞬时反馈：**和库那条一模一样的节点**。
   *
   * ⚠️ 为什么不是 CheckOutlined —— 库（react-ui 的 AssistantMessage）把复制
   *    成功态**写死**了：
   *
   *       copied ? <span style={{fontSize:'10px',fontWeight:'bold'}}>✓</span>
   *              : icons.copyIcon
   *
   *    没有任何 prop 能换掉它：`icons` 只认 copyIcon 这一个口，成功态不走
   *    icons。用户 2026-10-21：我的消息和 AI 回复点完复制，显示的图标要
   *    一样 —— 那就两边都渲染库这一份（同一个字、同字号、同粗细），
   *    肉眼无法分辨。哪天库把成功态开放成 prop，再统一换成对勾图标。
   */
  copied: <span style={{ fontSize: '10px', fontWeight: 'bold' }}>✓</span>,
  /** 编辑：把我的消息填回输入框（助手消息没有这个动作）。 */
  edit: <EditOutlined />,
  /** 重新生成：和「编辑」是两件事，所以不是铅笔。 */
  regenerate: <ReloadOutlined />,
  thumbsUp: <LikeOutlined />,
  thumbsDown: <DislikeOutlined />,
};

/**
 * 交给 CopilotChat 的 `icons`：只覆盖消息操作行用得上的四个。
 *
 * 键名由库的 Icons 接口决定（copyIcon / regenerateIcon / thumbsUpIcon /
 * thumbsDownIcon），别改名 —— 改了就静默退回库的默认 SVG。
 */
export const CHAT_ACTION_ICONS = {
  copyIcon: MESSAGE_ACTION_ICONS.copy,
  regenerateIcon: MESSAGE_ACTION_ICONS.regenerate,
  thumbsUpIcon: MESSAGE_ACTION_ICONS.thumbsUp,
  thumbsDownIcon: MESSAGE_ACTION_ICONS.thumbsDown,
};
