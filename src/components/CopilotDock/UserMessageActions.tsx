// src/components/CopilotDock/UserMessageActions.tsx
//
// 我的消息卡片**下方**那两个按钮：复制、编辑。
//
// 需求原话：「message 列表中，我的消息卡片下方添加，复制和编辑按钮」。
//
// 为什么画在气泡外面（而不是塞进气泡里）
// --------------------------------
//   气泡是库的 `UserMessage` 画的（`.copilotKitMessage.copilotKitUserMessage`），
//   它的 DOM 只有一层 div + 文本 —— 往里面插按钮要改库的渲染，而那个组件的
//   结构是 style.ts 里十几条对齐规则的目标。这里改成**兄弟节点**：气泡保持
//   原样（右对齐、主色底），按钮行紧贴在它下面、同样右对齐。
//
//   代价：CopilotKit 的消息序列里每一条用户消息后面多了一个 div。
//   已有规则里只有「工具记录 → 用户气泡」（`[data-kind='tool_activity'] +
//   .copilotKitUserMessage`）依赖相邻关系，那是**气泡之前**的兄弟，不受影响。
//
// 「编辑」的真实语义
// --------------
//   把这条消息的原文填回输入框、光标落到末尾，用户改完自己发。
//   **不删原消息、不自动重发**：后端一次运行是条不可变记录（thread checkpoint
//   在服务端），没有"撤回重跑"的接口，伪造一个只会让界面与后端不一致，
//   而那种不一致要到下次刷新才暴露。见 composerDraft.ts 的文件头。
//
// 为什么复制要有"已复制 / 复制失败"两态（但**都不显示文字、都不变色**）
// -------------------------------------------------------------
//   剪贴板 API 在非安全上下文（内网 http）里是**没有**的（见 clipboard.ts）。
//   无条件打一个对勾等于骗用户 —— 他粘贴出来是空的才发现。
//   所以 ① 成功才换对勾（失败保持原图标）；② 状态只体现在**图标**与
//   `aria-label` 上 —— 仿 DeepSeek：两个 16px 的灰图标，点完只是变成 ✓，
//   不弹字、不转色（一条消息下面挂两个彩色控件会抢正文）。
//
//   ⚠️ 因此"有没有复制成功"在视觉上是**没有**告警的：失败就是没变化。
//   要更强的提示就得接受彩色/文案，那是另一套取舍，别在这里midway 折中。

import { Button } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { copyToClipboard } from './clipboard';
import { requestComposerDraft } from './composerDraft';
import { MESSAGE_ACTION_ICONS } from './messageActionIcons';
import { useStyles } from './style';

/**
 * 一条消息的可读文本（用户消息的 content 可能是字符串，也可能是内容块数组）。
 *
 * 数组形态只在多模态（图片 / 音视频）时出现。这里取**文本部分**：
 * 复制要的是能读的字，编辑要的是能改的字 —— 附件没有可编辑的形态。
 */
export function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '';
    })
    .filter((text) => text !== '')
    .join('\n')
    .trim();
}

/** 复制按钮的瞬时反馈。 */
type CopyState = 'idle' | 'copied' | 'failed';

/** 反馈停留多久（毫秒）。太长会一直挂在那儿，太短来不及看见。 */
const FEEDBACK_MS = 1600;

const UserMessageActions: React.FC<{ text: string }> = ({ text }) => {
  const { styles } = useStyles();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 卸载时清掉计时器：不清的话组件走了还会 setState（React 会警告，
  // 而在长会话里这些计时器会攒着 —— 每条用户消息一个）。
  useEffect(() => clearTimer, [clearTimer]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(text);
    setCopyState(ok ? 'copied' : 'failed');
    clearTimer();
    timerRef.current = setTimeout(() => {
      setCopyState('idle');
      timerRef.current = null;
    }, FEEDBACK_MS);
  }, [clearTimer, text]);

  const handleEdit = useCallback(() => {
    requestComposerDraft(text);
  }, [text]);

  return (
    <div className={styles.userMessageActions} data-user-actions="true">
      {/*
        ⚠️ 纯图标、无文字、**不变色**（2026-10-20 用户第二版：仿 DeepSeek）
        -----------------------------------------------------------------
         · 不写 children —— 文案会把按钮撑宽，DeepSeek 那两枚就是两个 16px 的图标；
         · 成功**只换图标**（复制的两页纸 → 加粗「✓」），颜色仍是那一档灰：
           绿/红的语义色在这里太重，一条消息下面就挂了两个彩色控件会抢正文；
           那份「✓」与 AI 回复点完复制显示的是**同一个节点**
           （库把成功态写死了，见 messageActionIcons.copied 的注释）；
         · 失败**不换图标也不变色**（对勾只代表"真的复制成功了"），
           但 aria-label 会变成「复制失败」—— 读屏能听到，视觉上不打扰。
      */}
      <Button
        type="text"
        size="small"
        className={styles.userAction}
        aria-label={
          copyState === 'copied'
            ? '已复制'
            : copyState === 'failed'
              ? '复制失败'
              : '复制'
        }
        icon={
          copyState === 'copied'
            ? MESSAGE_ACTION_ICONS.copied
            : MESSAGE_ACTION_ICONS.copy
        }
        onClick={() => void handleCopy()}
      />
      <Button
        type="text"
        size="small"
        className={styles.userAction}
        aria-label="编辑"
        icon={MESSAGE_ACTION_ICONS.edit}
        onClick={handleEdit}
      />
    </div>
  );
};

export default UserMessageActions;
