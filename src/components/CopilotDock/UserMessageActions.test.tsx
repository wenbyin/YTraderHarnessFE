// src/components/CopilotDock/UserMessageActions.test.tsx
//
// 我的消息卡片下方那两个按钮（复制 / 编辑）。
//
// 要钉住的三件事：
//   ① 复制**真的**把这条消息的文本送进剪贴板（不是只弹个"已复制"）；
//   ② 剪贴板不可用时要**说失败**，不能假装成功（非安全上下文里很常见）；
//   ③ 「编辑」把原文交给 composerDraft —— 输入框那边怎么接，
//      由 Composer.test.tsx 负责，这里只管"指令发出去了、文本是对的"。
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./composerDraft', () => ({
  requestComposerDraft: vi.fn(),
}));

import { requestComposerDraft } from './composerDraft';
import UserMessageActions, { userMessageText } from './UserMessageActions';

/** 造一个可用的 `navigator.clipboard`（jsdom 默认没有）。 */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  vi.mocked(requestComposerDraft).mockClear();
});

afterEach(() => {
  // 还原成 jsdom 的"没有 clipboard"
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('userMessageText：这条消息的可读文本', () => {
  it('字符串（常见形态）原样取出，去掉首尾空白', () => {
    expect(userMessageText('  你好  ')).toBe('你好');
  });

  it('内容块数组 -> 只拼文本块（多模态的附件没有可编辑的字）', () => {
    expect(
      userMessageText([
        { type: 'text', text: '看一下这张图' },
        { type: 'image', source: { value: 'x' } },
        { type: 'text', text: '谢谢' },
      ]),
    ).toBe('看一下这张图\n谢谢');
  });

  it('空 / 非法输入 -> 空串（调用方据此不画按钮）', () => {
    expect(userMessageText('')).toBe('');
    expect(userMessageText(null)).toBe('');
    expect(userMessageText([{ type: 'image' }])).toBe('');
  });
});

describe('UserMessageActions', () => {
  it('两个按钮都在：复制、编辑（**只有图标、没有文字**）', () => {
    render(<UserMessageActions text="你好" />);

    const copy = screen.getByRole('button', { name: /复制/ });
    const edit = screen.getByRole('button', { name: /编辑/ });

    // 仿 DeepSeek：按钮里一个字的正文都没有，只有 svg 图标
    expect(copy.textContent).toBe('');
    expect(edit.textContent).toBe('');
    expect(copy.querySelector('.anticon')).not.toBeNull();
    expect(edit.querySelector('.anticon')).not.toBeNull();
  });

  it('⭐ 复制：把原文写进剪贴板，图标从"两页纸"变成"✓"（不弹字、不变色）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<UserMessageActions text="把这三条日志按时间排序" />);

    const button = screen.getByRole('button', { name: /复制/ });
    expect(button.querySelector('.anticon-copy')).not.toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeText).toHaveBeenCalledWith('把这三条日志按时间排序');
    // 只换图标：anticon-copy -> 库那份加粗的「✓」（与 AI 回复点完复制
    // 显示的是**同一个节点**，用户 2026-10-21：两边要一样）
    const after = screen.getByRole('button', { name: /已复制/ });
    expect(after.querySelector('.anticon-copy')).toBeNull();
    expect(after.textContent).toBe('✓');
    // antd Button 会给图标再套一层 span（ant-btn-icon）—— 它的文本同样是「✓」；
    // 真正那份镜像节点是**带内联 style** 的最里层（和库的写死节点同款）
    const mark = after.querySelector<HTMLElement>('span[style]');
    expect(mark?.style.fontWeight).toBe('bold');
    expect(mark?.style.fontSize).toBe('10px');
  });

  it('⭐ 剪贴板不可用 -> 图标**不**变 ✓（不假装成功），但 aria-label 说失败', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));

    render(<UserMessageActions text="你好" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    });

    const button = screen.getByRole('button', { name: /复制失败/ });
    expect(button.querySelector('.anticon-copy')).not.toBeNull();
    expect(button.textContent).not.toBe('✓');
    expect(screen.queryByRole('button', { name: /已复制/ })).toBeNull();
  });

  it('⭐ 编辑：把原文交给输入框（composerDraft），不在这里改消息本身', () => {
    render(<UserMessageActions text="原来的问题" />);

    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));

    expect(requestComposerDraft).toHaveBeenCalledWith('原来的问题');
  });
});
