// src/pages/tool/components/ChainOrderHint.test.tsx
//
// 这条提示是**纯文案**，但文案写反了比不写更糟 —— 用户会照着错的顺序去挂链。
// 所以用测试钉住三件事：
//   1. 六个层级的次序就是 外 → 内（retry 最外、⟦Tool⟧ 最内）；
//   2. guard / timeout 都带「每次尝试」这个限定（这是它们与 retry 的分工）；
//   3. 缩进随层数递增（视觉上的「包裹」关系与数据一致）。
//
// 另外三条钉「形态」：它是可关闭的 Alert、20 秒自动收起、收起后还能点回来
// （口径只在这里写了一份，把入口做没了等于把说明删了）。

import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ChainOrderHint from './ChainOrderHint';

const rows = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[data-chain-order] [data-depth]'),
  );

describe('ChainOrderHint', () => {
  it('retry / guard / timeout / cache 由外到内，工具本体在最里层', () => {
    render(
      <App>
        <ChainOrderHint />
      </App>,
    );

    const list = rows();
    expect(list.map((el) => el.dataset.depth)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(list[0].textContent).toContain('retry_interceptor');
    expect(list[1].textContent).toContain('execution_guard_interceptor');
    expect(list[2].textContent).toContain('timeout_interceptor');
    expect(list[3].textContent).toContain('cache_interceptor');
    expect(list[5].textContent).toContain('⟦Tool⟧');
  });

  it('guard 与 timeout 都标成「每次尝试」，retry 是「最外层」', () => {
    render(
      <App>
        <ChainOrderHint />
      </App>,
    );

    const list = rows();
    expect(list[0].textContent).toContain('最外层');
    expect(list[1].textContent).toContain('每次尝试');
    expect(list[2].textContent).toContain('每次尝试');
  });

  it('缩进逐层 +18px —— 视觉上的包裹关系要和数据一致', () => {
    render(
      <App>
        <ChainOrderHint />
      </App>,
    );

    const list = rows();
    expect(list[0].style.marginLeft).toBe('0px');
    expect(list[3].style.marginLeft).toBe('54px');
    expect(list[5].style.marginLeft).toBe('90px');
  });
});

// ============================================================
// 形态：Alert / 可关闭 / 20 秒自动收起 / 能点回来 / 收起带动画
// ============================================================

const renderHint = () =>
  render(
    <App>
      <ChainOrderHint />
    </App>,
  );

const shell = () => document.querySelector('[data-order-shell]');

/** 关闭按钮（data-* 钩子，不按类名找 —— antd-style 的类名是哈希）。 */
const closeBtn = () => {
  const el = document.querySelector<HTMLElement>('[data-order-close]');
  if (!el) throw new Error('没找到关闭按钮');
  return el;
};
const collapsed = () =>
  document.querySelector('[data-order-shell]')?.getAttribute('data-collapsed');

describe('ChainOrderHint · 形态', () => {
  it('是一条 info Alert（不是常驻面板），带关闭按钮', () => {
    renderHint();

    const alert = document.querySelector('.ant-alert');
    expect(alert).toBeTruthy();
    expect(alert?.className).toContain('ant-alert-info');
    expect(document.querySelector('[data-order-close]')).toBeTruthy();
    // 内容仍挂在 [data-chain-order] 下，测试抓手不变
    expect(document.querySelector('[data-chain-order]')).toBeTruthy();
  });

  it('20 秒后开始收起：先塌缩（节点还在），260ms 后才卸载', () => {
    vi.useFakeTimers();
    try {
      renderHint();
      expect(rows().length).toBe(6);
      expect(collapsed()).toBe('false');

      act(() => {
        vi.advanceTimersByTime(19_000);
      });
      expect(collapsed()).toBe('false'); // 还没到点

      // ⚠️ 到点这一帧不能直接消失 —— 那是"瞬切"，下面两栏会硬跳
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(collapsed()).toBe('true');
      expect(shell()).toBeTruthy(); // 动画载体还在，正在往 0 压
      expect(rows().length).toBe(6);

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(shell()).toBeNull();
      expect(rows().length).toBe(0);
      expect(screen.getByText('执行顺序说明')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('点 × 同样走动画，收起后还能点回来，并且**重新**计时', () => {
    vi.useFakeTimers();
    try {
      renderHint();

      act(() => {
        fireEvent.click(closeBtn());
      });
      // 立刻进入收起态，但节点还在（动画正在跑）
      expect(collapsed()).toBe('true');
      expect(shell()).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(shell()).toBeNull();
      expect(rows().length).toBe(0);

      act(() => {
        fireEvent.click(screen.getByText('执行顺序说明'));
      });
      expect(rows().length).toBe(6);
      expect(collapsed()).toBe('false');

      // ⚠️ 关键：重开要重新计时。若 effect 依赖写错，上一个定时器会立刻关掉它，
      // 用户看到的是"点了没反应"。
      act(() => {
        vi.advanceTimersByTime(19_000);
      });
      expect(rows().length).toBe(6);

      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(shell()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('卸载时清掉收起定时器（别在组件没了之后 setState）', () => {
    vi.useFakeTimers();
    try {
      const view = renderHint();
      act(() => {
        fireEvent.click(closeBtn());
      });
      view.unmount();
      // 不该抛 "update on unmounted component"，也不该有残留定时器
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(document.querySelector('[data-order-shell]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
