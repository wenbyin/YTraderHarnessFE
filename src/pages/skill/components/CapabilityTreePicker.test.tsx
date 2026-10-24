// src/pages/skill/components/CapabilityTreePicker.test.tsx
//
// 绑定控件是**树**，那就必须钉住树的语义，否则很容易被"默认行为"改回去：
//
//   1. `checkStrictly`：勾父**不会**勾子、勾子也**不会**勾父。
//      这是契约里的"精确匹配、不沿 parent_id 递归"在界面上的唯一体现；
//      antd 的默认是父子联动，一旦漏了那个 prop，界面就会替用户多绑一堆能力。
//   2. 已停用的能力仍在树里，但带「已停用」标记（勾了也等于没绑）。
//   3. 父能力本身可以勾（它的 code 也可能直接挂着工具）。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Capability } from '../data';
import CapabilityTreePicker from './CapabilityTreePicker';

const CAPS: Capability[] = [
  {
    id: 'c1',
    code: 'retrieval',
    name: '检索',
    parent_id: null,
    is_active: true,
    sort_order: 0,
  },
  {
    id: 'c11',
    code: 'retrieval.search',
    name: '全文召回',
    parent_id: 'c1',
    is_active: true,
    sort_order: 1,
  },
  {
    id: 'c12',
    code: 'retrieval.rerank',
    name: '结果重排',
    parent_id: 'c1',
    is_active: true,
    sort_order: 2,
  },
  {
    id: 'c2',
    code: 'ocr.text',
    name: '文字识别',
    parent_id: null,
    is_active: false,
    sort_order: 3,
  },
];

/** 找到某个节点标题所在的 .ant-tree-treenode，返回它的勾选框。 */
function checkboxOf(title: string): HTMLElement {
  const titleNode = screen.getByText(title);
  const treenode = titleNode.closest('.ant-tree-treenode');
  if (!treenode) throw new Error(`找不到节点「${title}」`);
  const box = treenode.querySelector('.ant-tree-checkbox');
  if (!box) throw new Error(`节点「${title}」没有勾选框`);
  return box as HTMLElement;
}

/** 某个节点当前是否被勾选（antd 会给 checkbox 加 -checked 类）。 */
function isChecked(title: string): boolean {
  return checkboxOf(title).classList.contains('ant-tree-checkbox-checked');
}

afterEach(() => {
  cleanup();
});

describe('CapabilityTreePicker', () => {
  it('树里显示名称、code，停用项带「已停用」标记', () => {
    render(
      <CapabilityTreePicker
        capabilities={CAPS}
        value={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('检索')).toBeTruthy();
    expect(screen.getByText('retrieval.search')).toBeTruthy();
    expect(screen.getByText('全文召回')).toBeTruthy();
    expect(screen.getByText('已停用')).toBeTruthy();
  });

  it('⭐ 勾父节点不会连带勾子节点（checkStrictly）', () => {
    const onChange = vi.fn();
    render(
      <CapabilityTreePicker
        capabilities={CAPS}
        value={[]}
        onChange={onChange}
      />,
    );

    fireEvent.click(checkboxOf('检索'));

    expect(onChange).toHaveBeenCalledTimes(1);
    // 只提交父节点自己；联动的话这里会多出 c11 / c12
    expect(onChange.mock.calls[0][0]).toEqual(['c1']);
  });

  it('⭐ 勾子节点也不会把父节点带上', () => {
    const onChange = vi.fn();
    render(
      <CapabilityTreePicker
        capabilities={CAPS}
        value={[]}
        onChange={onChange}
      />,
    );

    fireEvent.click(checkboxOf('结果重排'));

    expect(onChange.mock.calls[0][0]).toEqual(['c12']);
  });

  it('受控值会反映到勾选状态（父子各勾一个）', () => {
    render(
      <CapabilityTreePicker
        capabilities={CAPS}
        value={['c1', 'c11']}
        onChange={() => {}}
      />,
    );

    expect(isChecked('检索')).toBe(true);
    expect(isChecked('全文召回')).toBe(true);
    // 没勾的兄弟节点必须是未选中 —— 否则就是联动漏了
    expect(isChecked('结果重排')).toBe(false);
  });

  it('取消勾选只去掉自己', () => {
    const onChange = vi.fn();
    render(
      <CapabilityTreePicker
        capabilities={CAPS}
        value={['c1', 'c11']}
        onChange={onChange}
      />,
    );

    fireEvent.click(checkboxOf('检索'));

    expect(onChange.mock.calls[0][0]).toEqual(['c11']);
  });

  it('停用的能力也能勾（它只是"勾了没用"，不是不可选）', () => {
    const onChange = vi.fn();
    render(
      <CapabilityTreePicker
        capabilities={CAPS}
        value={[]}
        onChange={onChange}
      />,
    );

    fireEvent.click(checkboxOf('文字识别'));
    expect(onChange.mock.calls[0][0]).toEqual(['c2']);
  });

  it('一个能力都没有时给出可执行的下一步', () => {
    render(
      <CapabilityTreePicker capabilities={[]} value={[]} onChange={() => {}} />,
    );
    expect(screen.getByText(/还没有任何能力/)).toBeTruthy();
  });
});
