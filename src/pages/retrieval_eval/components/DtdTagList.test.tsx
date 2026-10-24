// src/pages/retrieval_eval/components/DtdTagList.test.tsx
//
// 「覆盖 DTD」列的**行高**是这一列唯一会伤到排版的地方：一条 bundle 可能覆盖
// 8 个 DTD，8 个标签平铺就把整行撑到 150px（别的列都是一个短值），标签还会撑破
// 列宽溢到邻列。所以这里钉住三条：
//   1. 表格里只平铺 1 个，其余折成 `+N`；
//   2. 全量在 `+N` 的浮层里，一个都不丢；
//   3. 空数组显示 `—`，不显示空标签（空标签看着像一个真实取值）。

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../dtdOptions', () => ({
  dtdLabel: (id: string) => id.toUpperCase(),
}));

import DtdTagList, { DtdTag } from './DtdTagList';

const IDS = [
  'company_event_risk_compliance',
  'company_event_business_development',
  'company_event_market_activity',
  'company_event_capital_operations',
];

describe('DtdTagList', () => {
  it('默认只平铺 1 个，其余折成 +N', () => {
    render(<DtdTagList ids={IDS} />);

    expect(screen.getByText('COMPANY_EVENT_RISK_COMPLIANCE')).toBeTruthy();
    expect(screen.queryByText('COMPANY_EVENT_MARKET_ACTIVITY')).toBeNull();
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('全部展开时不留 +N 标签', () => {
    render(<DtdTagList ids={IDS.slice(0, 2)} max={2} />);

    expect(screen.getByText('COMPANY_EVENT_RISK_COMPLIANCE')).toBeTruthy();
    expect(screen.getByText('COMPANY_EVENT_BUSINESS_DEVELOPMENT')).toBeTruthy();
    expect(screen.queryByText(/^\+\d/)).toBeNull();
  });

  it('被折叠的那些在 +N 的浮层里能看全（信息一点没丢）', async () => {
    render(<DtdTagList ids={IDS} />);

    // ⚠️ hover 类浮层在 jsdom 里打不开（rc-trigger 的 mouseenter 拿不到），
    //    本仓也没装 `@testing-library/user-event`。所以组件把 trigger 配成
    //    `['click','hover']`：点一下同样能开，对表格里的小 chip 也更确定。
    fireEvent.click(screen.getByText('+3'));

    // 浮层里是全部 4 个（含被折叠掉的 3 个）
    const shown = await screen.findAllByText(/^COMPANY_EVENT_/);
    expect(shown.length).toBeGreaterThanOrEqual(IDS.length);
  });

  it('没有 DTD 时显示 —，不是空标签', () => {
    render(<DtdTagList ids={[]} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('DtdTag', () => {
  it('DOM 里保留全称，靠样式截断（否则长标识会把列撑破）', () => {
    render(<DtdTag id={IDS[0]} maxWidth={80} />);

    const tag = screen.getByText('COMPANY_EVENT_RISK_COMPLIANCE');
    expect(tag).toBeTruthy();
    // 截断只发生在视觉上：样式负责省略号。DOM 里丢字的话，复制/搜索都拿不到
    // 真名字，而 tooltip 也没法把它显示出来。
    expect(tag.style.textOverflow).toBe('ellipsis');
    expect(tag.style.maxWidth).toBe('80px');
  });
});
