// src/components/CopilotDock/useInputRegionHeight.test.tsx
//
// `--dock-input-h` 的**实测**逻辑。钉三件事：
//
//   ① 间距 = 对话区底边 − 输入框上沿（不是任何常数）；
//   ② 量不出几何时（jsdom / 首帧 / 没有输入框）**不写**这个变量，
//      CSS 里的 186px 兜底值继续生效；
//   ③ 输入框长高之后要跟着更新（用户写满一屏，输入框会长到 240 上限）。
//
// 为什么值得单独测：这个值是"任务 dock 贴在输入框上方"的唯一依据，
// 写死常数时实测差了 40px（用户 2026-10-22 的截图），而单测里没有任何断言
// 拦得住 —— 因为它错得很安静，只是"离得远一点"。

import { act, render } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useInputRegionHeight } from './useInputRegionHeight';

const PANE_BOTTOM = 800;

/** 造一个 rect：只填这个 hook 用到的两个字段，其余给 0。 */
const rect = (top: number, bottom: number) =>
  ({
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/**
 * 给 pane 与 .copilotKitInput 分别造几何。
 * `inputTop` 变一下就是"输入框长高了"。
 */
function stubGeometry(getInputTop: () => number) {
  return vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      const isInput = this.classList?.contains('copilotKitInput');
      return isInput
        ? rect(getInputTop(), PANE_BOTTOM - 40)
        : rect(0, PANE_BOTTOM);
    });
}

const Probe: React.FC<{ withInput?: boolean }> = ({ withInput = true }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  useInputRegionHeight(ref, 'conv-1');
  return (
    <div ref={ref} data-pane="true">
      {withInput ? <div className="copilotKitInput" /> : null}
    </div>
  );
};

const pane = () => document.querySelector('[data-pane]') as HTMLElement;
/** 读那个变量（jsdom 里读 inline style 属性即可）。 */
const gapText = () => pane().style.getPropertyValue('--dock-input-h');

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('useInputRegionHeight', () => {
  it('⭐ 间距取"对话区底边 − 输入框上沿"的实测值', () => {
    stubGeometry(() => 610);
    render(<Probe />);

    expect(gapText()).toBe('190px');
  });

  it('输入框变高（写满一屏）→ 间距跟着变，dock 不会被输入框顶住', () => {
    let inputTop = 610;
    stubGeometry(() => inputTop);
    render(<Probe />);
    expect(gapText()).toBe('190px');

    // 拖一下：输入框上沿往上走了 100px
    inputTop = 510;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(gapText()).toBe('290px');
  });

  it('量不出几何（全 0）→ 不写变量，CSS 兜底值继续生效', () => {
    // jsdom / happy-dom 的真实行为：所有 rect 都是 0
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      rect(0, 0),
    );
    render(<Probe />);

    expect(gapText()).toBe('');
  });

  it('没有输入框（还没渲染出来）→ 不写变量，也不抛', () => {
    stubGeometry(() => 610);
    expect(() => render(<Probe withInput={false} />)).not.toThrow();
    expect(gapText()).toBe('');
  });
});
