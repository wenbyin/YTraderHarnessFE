// src/pages/retrieval_eval/components/TargetChunkText.test.tsx
//
// 「目标 chunk 原文」的两条**静默**失败：
//
//   1. 正文没渲染出来，卡上只有一串 UUID —— trace 面板看起来是完整的，
//      但"丢得冤不冤"这个判断根本做不了（这正是加这个组件的理由）；
//   2. 取不到时显示成"正文为空" —— 空正文与取不到是两种结论：
//      前者是数据问题（该去看分块 / 源文件），后者是这颗 id 已经不在库里了。
//
// 两条都不报错、界面也不残缺，所以各留一条断言钉住。
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentChunkText } from '../data';

const getChunk = vi.fn();

vi.mock('../service', () => ({
  getDocumentChunk: (...a: unknown[]) => getChunk(...a),
}));

import TargetChunkText from './TargetChunkText';

/** 超过折叠阈值（220）的正文，用来钉「展开全文」这条交互。 */
const LONG = '董'.repeat(300);

const chunk = (over: Partial<DocumentChunkText> = {}): DocumentChunkText => ({
  document_chunk_id: 'g1',
  chunk_index: 7,
  content: LONG,
  content_truncated: false,
  char_count: LONG.length,
  token_count: null,
  start_index: 0,
  end_index: LONG.length,
  locator: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TargetChunkText · 目标 chunk 原文', () => {
  it('按 chunk_id 取正文，并渲染卡头的 #index / 字符数 / 偏移区间', async () => {
    getChunk.mockResolvedValue(chunk());
    render(<TargetChunkText chunkIds={['g1']} />);

    // 只拿 chunk_id 取 —— 评测侧没有 (版本, retrieval) 那两个 id
    await waitFor(() => {
      expect(getChunk).toHaveBeenCalledWith('g1');
    });

    expect(await screen.findByText('#7')).toBeTruthy();
    // 「字符」用的是 char_count（截断**前**），不是 content.length
    expect(await screen.findByText('300 字符')).toBeTruthy();
    expect(await screen.findByText('[0, 300)')).toBeTruthy();
  });

  it('超阈值先折叠，点「展开全文」才铺全文', async () => {
    getChunk.mockResolvedValue(chunk());
    const { container } = render(<TargetChunkText chunkIds={['g1']} />);

    const link = await screen.findByText(`展开全文（共 ${LONG.length} 字符）`);
    const before = container.querySelector('pre')?.textContent ?? '';
    expect(before.endsWith('…')).toBe(true);
    expect(before.length).toBeLessThan(LONG.length);

    fireEvent.click(link);
    await waitFor(() => {
      expect(container.querySelector('pre')?.textContent).toBe(LONG);
    });
  });

  it('取不到时明说「取不到」，不显示成"正文为空"', async () => {
    getChunk.mockRejectedValue(new Error('DocumentChunk not found: g1'));
    render(<TargetChunkText chunkIds={['g1']} />);

    expect(await screen.findByText('取不到这块 chunk 的原文')).toBeTruthy();
    expect(await screen.findByText(/DocumentChunk not found/)).toBeTruthy();
  });

  it('没有目标 chunk 时整块不渲染，也不发请求', () => {
    const { container } = render(<TargetChunkText chunkIds={[]} />);
    expect(container.textContent).toBe('');
    expect(getChunk).not.toHaveBeenCalled();
  });
});
