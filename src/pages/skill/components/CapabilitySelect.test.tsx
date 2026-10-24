// src/pages/skill/components/CapabilitySelect.test.tsx
//
// 这是**筛选**控件（不是绑定控件，绑定见 CapabilityTreePicker.test.tsx）。
// 需要钉住的是"能不能快速找到那一项"：
//   · 选项显示层级路径 + capability code —— 同名能力靠 code 区分；
//   · 已停用的能力仍可筛（历史技能可能还绑着它）。
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Capability } from '../data';
import CapabilitySelect from './CapabilitySelect';

const CAPS: Capability[] = [
  {
    id: 'c1',
    code: 'retrieval',
    name: '检索',
    parent_id: null,
    is_active: true,
  },
  {
    id: 'c11',
    code: 'retrieval.search',
    name: '全文召回',
    parent_id: 'c1',
    is_active: true,
  },
  {
    id: 'c51',
    code: 'ocr.text',
    name: '文字识别',
    parent_id: null,
    is_active: false,
  },
];

/**
 * 点开下拉（antd 的展开是 mouseDown）。
 *
 * ⚠️ antd v6 换了 Select 的内部结构：`.ant-select-selector` 已经不存在，
 *    现在是 `.ant-select-content` + `.ant-select-input`。
 */
const openDropdown = (root: HTMLElement) => {
  const trigger =
    root.querySelector('.ant-select-content') ??
    root.querySelector('.ant-select');
  if (!trigger) throw new Error('找不到 select 触发器');
  fireEvent.mouseDown(trigger);
};

afterEach(() => {
  cleanup();
});

describe('CapabilitySelect（按能力筛选）', () => {
  it('下拉里显示层级路径 + capability code', async () => {
    const { container } = render(
      <CapabilitySelect capabilities={CAPS} onChange={() => {}} />,
    );
    openDropdown(container);

    await waitFor(() => {
      expect(document.querySelector('.ant-select-dropdown')).toBeTruthy();
    });

    const dropdown = document.querySelector(
      '.ant-select-dropdown',
    ) as HTMLElement;
    expect(dropdown.textContent).toContain('检索 / 全文召回');
    expect(dropdown.textContent).toContain('retrieval.search');
  });

  it('停用的能力在下拉里标注（仍可筛）', async () => {
    const { container } = render(
      <CapabilitySelect capabilities={CAPS} onChange={() => {}} />,
    );
    openDropdown(container);

    await waitFor(() => {
      expect(
        document.querySelector('.ant-select-dropdown')?.textContent,
      ).toContain('已停用');
    });
  });

  it('能显示当前值（受控）', () => {
    const { container } = render(
      <CapabilitySelect capabilities={CAPS} value="c11" onChange={() => {}} />,
    );
    expect(container.textContent).toContain('全文召回');
  });
});
