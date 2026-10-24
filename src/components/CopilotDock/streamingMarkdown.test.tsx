// src/components/CopilotDock/streamingMarkdown.test.tsx
//
// 「一次 delta 里的 N 个字要一个一个淡入」—— 这里钉三件事：
//   1. 新字确实被切成了独立的 span，且延迟是递增的（0 / 28 / 56 …）；
//   2. 水位线（from）之前的老字**不切**，也不重新淡入；
//   3. 代码块整块出现，一个字都不切（否则等宽排版与复制都会变形）。
import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  commitRevealCount,
  makeStreamingRenderers,
  resetStreamingChars,
  revealFromOf,
} from './streamingMarkdown';

const CLASS = 'fade';

/** 用 p 容器渲染一段文本（真的走一遍 components → 切字）。 */
function renderParagraph(
  text: React.ReactNode,
  options: { from: number; as?: 'p' | 'pre' } = { from: 0 },
) {
  const { components, readCount } = makeStreamingRenderers({
    className: CLASS,
    from: options.from,
  });
  const Tag = components[options.as ?? 'p'];
  const view = render(React.createElement(Tag, null, text));
  return { ...view, readCount };
}

describe('streamingMarkdown：逐字淡入', () => {
  beforeEach(() => {
    resetStreamingChars();
  });

  it('⭐ 一次 7 个字 → 7 个 span，延迟 0/28/56…/168ms（一个一个出现）', () => {
    const { container, readCount } = renderParagraph('一二三四五六七');

    const spans = Array.from(container.querySelectorAll(`.${CLASS}`));
    expect(spans).toHaveLength(7);
    expect(
      spans.map((span) => (span as HTMLElement).style.animationDelay),
    ).toEqual(['0ms', '28ms', '56ms', '84ms', '112ms', '140ms', '168ms']);
    expect(readCount()).toBe(7);
  });

  it('⭐ 水位线之前的字不切（老字不重新淡入）', () => {
    const { container } = renderParagraph('一二三四五六七八', { from: 7 });

    // 前 7 个是纯文本，只有"八"是带动画的 span
    const spans = Array.from(container.querySelectorAll(`.${CLASS}`));
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe('八');
    // 老字仍然在（没有被吞掉）
    expect(container.textContent).toBe('一二三四五六七八');
  });

  it('延迟只在新字**第一次出现**时定 —— 水位线推进后不会重新排队', () => {
    renderParagraph('一二三四五六七');

    // 第二次渲染：7 个字都成了老字，再来 2 个新字
    const { container } = renderParagraph('一二三四五六七八九', { from: 7 });
    const spans = Array.from(container.querySelectorAll(`.${CLASS}`));

    expect(
      spans.map((span) => (span as HTMLElement).style.animationDelay),
    ).toEqual(['0ms', '28ms']);
  });

  it('窗口内的老字留成 span 但**不带**动画类（否则会淡入第二次）', () => {
    // from = 10：前 10 个字是老的（但它们都还在 KEEP 窗口内，要留着 span 给动画收尾）
    const text = '零一二三四五六七八九末尾';
    const { container } = renderParagraph(text, { from: 10 });

    const spans = Array.from(container.querySelectorAll('span'));
    const animated = Array.from(container.querySelectorAll(`.${CLASS}`));
    // 10 个老字各留一个"无动画"的 span，最后 2 个新字带动画
    expect(spans).toHaveLength(12);
    expect(animated).toHaveLength(2);
    expect(container.textContent).toBe(text);
  });

  it('超出 KEEP 窗口的老字退回纯文本（长回答不会堆出几千个 span）', () => {
    const text = '字'.repeat(260);
    const { container } = renderParagraph(text, { from: 250 });

    const animated = Array.from(container.querySelectorAll(`.${CLASS}`));
    const spans = Array.from(container.querySelectorAll('span'));
    expect(animated).toHaveLength(10);
    // 窗口内 200 个 + 新来的 10 个；其余 50 个是纯文本
    expect(spans).toHaveLength(210);
    expect(container.textContent).toBe(text);
  });

  it('代码块整块出现：pre / code 里面的文字一个字都不切', () => {
    const { container } = renderParagraph(
      React.createElement(
        'pre',
        null,
        React.createElement('code', null, 'a=1'),
      ),
    );

    expect(container.querySelectorAll(`.${CLASS}`)).toHaveLength(0);
    expect(container.textContent).toBe('a=1');
  });

  it('保留库的类名（p 是 div + copilotKitParagraph，样式全靠它）', () => {
    const { container } = renderParagraph('正文');

    const block = container.firstElementChild as HTMLElement;
    expect(block.tagName).toBe('DIV');
    expect(block.className).toContain('copilotKitMarkdownElement');
    expect(block.className).toContain('copilotKitParagraph');
  });

  it('水位线按 message.id 存取（换消息不会串）', () => {
    commitRevealCount('m1', 42);
    commitRevealCount('m2', 7);

    expect(revealFromOf('m1')).toBe(42);
    expect(revealFromOf('m2')).toBe(7);
    expect(revealFromOf('never')).toBeUndefined();
  });
});
