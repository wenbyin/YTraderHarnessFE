// src/pages/tool/components/TaxonomyDrawer.test.tsx
//
// 分类体系抽屉的冒烟测试 —— 重点不是"能渲染"，而是把删除的三条契约约束钉住：
//
//   1. **有子分类的行不给删**（禁用）—— 契约里 force 也救不了，前端必须提前挡住，
//      不能让用户点一个注定 409 的按钮。
//   2. **删除是两段式**：先不带 force 试一次；409 才问要不要强制解绑。
//   3. **编辑走 PATCH 且只发变更字段** —— 改了 name 就只发 name，
//      不能把 description / parent_id 顺手清空（那是 PUT 的语义）。
//
// 不测的：Table 的展开/树形渲染（antd 自己的行为）、Modal 的动画。

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capability, CapabilityCreate, CapabilityUpdate } from '../data';

const TREE: Capability[] = [
  {
    id: 'c1',
    code: 'market',
    name: '行情',
    description: '行情类工具',
    parent_id: null,
    sort_order: 0,
    is_active: true,
  },
  {
    id: 'c2',
    code: 'us_stock',
    name: '美股行情',
    description: null,
    parent_id: 'c1',
    sort_order: 1,
    is_active: true,
  },
  {
    id: 'c3',
    code: 'news',
    name: '资讯',
    description: null,
    parent_id: null,
    sort_order: 2,
    is_active: false,
  },
];

// 给 vi.fn 显式写上参数类型 —— 否则 mock.calls[0] 被推成 []，
// 取 [0] / [1] 会报 "Tuple type '[]' has no element at index"。
const listCapabilities = vi.fn(async () => TREE);
const createCapability = vi.fn(async (_b?: CapabilityCreate) => TREE[0]);
const updateCapability = vi.fn(
  async (_id?: string, _b?: CapabilityUpdate) => TREE[0],
);
const deleteCapability = vi.fn(
  async (_id?: string, _force?: boolean) => undefined,
);

/** 让删除第几次失败由测试自己控制 */
let deleteShould409 = false;

vi.mock('@umijs/max', () => ({
  request: vi.fn(),
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage?: string }) =>
      defaultMessage ?? '',
  }),
}));

vi.mock('../service', () => ({
  listCapabilities: (...a: unknown[]) => listCapabilities(...(a as [])),
  createCapability: (...a: unknown[]) => createCapability(...(a as [])),
  updateCapability: (...a: unknown[]) => updateCapability(...(a as [])),
  deleteCapability: async (...a: unknown[]) => {
    // 先记账再决定成败 —— mock.calls 要能反映"一共发过几次请求"，
    // 否则失败的那次根本记不下来，就断言不出"重试了一次"。
    deleteCapability(...(a as []));
    if (deleteShould409) {
      const err = new Error('3 个工具仍在引用它') as Error & {
        response: { status: number };
      };
      err.response = { status: 409 };
      throw err;
    }
    return undefined;
  },
  httpStatus: (e: unknown) =>
    (e as { response?: { status?: number } } | null)?.response?.status,
}));

import TaxonomyDrawer from './TaxonomyDrawer';

const renderDrawer = (onReload = vi.fn()) =>
  render(
    <App>
      <TaxonomyDrawer
        open
        onClose={vi.fn()}
        classifications={TREE}
        onReload={onReload}
      />
    </App>,
  );

/**
 * antd v6 会给「两个汉字」的按钮自动插一个空格（`删 除`），
 * 所以比对前先把空白全部抹掉 —— 否则按 '删除' 永远找不到按钮。
 */
const normText = (s: string | null | undefined) =>
  (s ?? '').replace(/\s+/g, '');

/** 找到某一行里的按钮（行 = tr，用 code 定位行更稳） */
const btnInRow = (code: string, text: string) => {
  const cell = screen.getByText(code).closest('td') as HTMLElement;
  const row = cell.closest('tr') as HTMLElement;
  const btn = Array.from(row.querySelectorAll('button')).find(
    (b) => normText(b.textContent) === text,
  );
  if (!btn) throw new Error(`行 ${code} 里找不到按钮「${text}」`);
  return btn;
};

/** 某一行的「名称」格（第一列）。同样用 code 定位行。 */
const nameCellOf = (code: string) =>
  (screen.getByText(code).closest('tr') as HTMLElement).querySelector(
    'td',
  ) as HTMLElement;

/** 弹出层（Popconfirm / Modal）里的按钮同理 */
const btnIn = (root: ParentNode, text: string) => {
  const btn = Array.from(root.querySelectorAll('button')).find(
    (b) => normText(b.textContent) === text,
  );
  if (!btn) throw new Error(`找不到按钮「${text}」`);
  return btn as HTMLElement;
};

const modal = () => document.querySelector('.ant-modal') as ParentNode;
/** 弹窗里的字段输入框（Form.Item name=x 会渲染成 id=x） */
const field = (name: string) =>
  document.querySelector(`.ant-modal #${name}`) as HTMLInputElement | null;
/**
 * 工具栏的「新建分类」按钮。
 * 用 role+name 定位 —— 弹窗打开后标题也是「新建分类」，
 * 用 getByText 会撞成 "found multiple elements"。
 */
const openCreate = () =>
  fireEvent.click(screen.getByRole('button', { name: '新建分类' }));
const modalTitle = () =>
  document.querySelector('.ant-modal-title')?.textContent ?? '';

describe('TaxonomyDrawer', () => {
  beforeEach(() => {
    listCapabilities.mockClear();
    updateCapability.mockClear();
    deleteCapability.mockClear();
    deleteShould409 = false;
  });

  // 用 testing-library 的 cleanup 卸载，别直接 `document.body.innerHTML = ''`
  // —— 那会把 React 持有的节点从 DOM 里抹掉，下一次卸载时 removeChild 报
  // "node is not a child of this node"，把后面的用例全带崩。
  afterEach(() => {
    cleanup();
  });

  it('渲染分类树，停用态显示为「停用」标签', async () => {
    renderDrawer();
    expect(screen.getByText('market')).toBeTruthy();
    expect(screen.getByText('us_stock')).toBeTruthy();
    expect(screen.getAllByText('停用').length).toBeGreaterThan(0);
  });

  /*
   * 「文字错位」的回归 —— 这一条**只有 DOM 形状断言抓得到**：
   * 逻辑上什么都没错（名字对、路径对），错的是"用了一个原子盒子装它"。
   * 展开图标/缩进是 antd 用 `float: left` 摆的，原子盒子（inline-flex）不能跨行断开，
   * 宽度一超就从图标右边整块掉到下一行、图标独留上一行。
   */
  it('⭐ 名称格不许出现原子盒子（<Space> = inline-flex），否则会被浮动图标挤到下一行', () => {
    renderDrawer();
    expect(nameCellOf('us_stock').querySelector('.ant-space')).toBeNull();
    expect(nameCellOf('market').querySelector('.ant-space')).toBeNull();
  });

  /*
   * 「名称下面那行小字」的回归（2026-10-21）。
   *
   * 先是一句「名称折行了直接让两个 span 换行显示」（名字与祖先路径各占一行），
   * 紧接着又一句「直接去除下方的小字」—— 结论就是**这一格只剩名字**：
   * 层级关系由树形缩进表达，那行 11px 的灰色路径八成都被截断，只贡献行高。
   */
  it('⭐ 名称格只有节点自己的名字，没有祖先路径小字', () => {
    renderDrawer();

    const cell = nameCellOf('us_stock');
    // 子节点不再追加父级路径（旧实现是「美股行情行情」）
    expect(cell.textContent).toBe('美股行情');
    expect(cell.textContent).not.toContain('行情行情');
    // 这一格里只有一个有字的东西（名字），没有第二行
    const texts = Array.from(cell.querySelectorAll('span')).filter(
      (el) => (el.textContent ?? '').trim() !== '',
    );
    expect(texts.map((el) => el.textContent)).toEqual(['美股行情']);
    // 名字仍带自己的样式类（block + nowrap + 省略号，见 style.ts 的 cellName）
    expect(texts[0].className).not.toBe('');
  });

  it('名称列：根节点也只有一个名字（不重复自己）', () => {
    renderDrawer();
    expect(nameCellOf('market').textContent).toBe('行情');
  });

  it('有子分类的行，删除按钮是禁用的（force 也删不掉，提前挡住）', () => {
    renderDrawer();
    // c1 有子节点 c2 → 删不掉；c3 是叶子 → 能删
    expect(btnInRow('market', '删除').disabled).toBe(true);
    expect(btnInRow('news', '删除').disabled).toBe(false);
  });

  it('删除叶子节点：走 DELETE 且默认不带 force', async () => {
    renderDrawer();
    fireEvent.click(btnInRow('news', '删除'));

    // Popconfirm 的确认按钮 —— 文案同样是「删除」，取弹出层里的那个
    await waitFor(() =>
      expect(document.querySelector('.ant-popconfirm')).toBeTruthy(),
    );
    fireEvent.click(
      btnIn(document.querySelector('.ant-popconfirm') as ParentNode, '删除'),
    );

    await waitFor(() => expect(deleteCapability).toHaveBeenCalled());
    expect(deleteCapability.mock.calls[0][0]).toBe('c3');
    expect(deleteCapability.mock.calls[0][1]).toBe(false);
  });

  it('删除遇到 409 → 弹「强制删除」二次确认 → 再带 force=true 重试', async () => {
    deleteShould409 = true;
    renderDrawer();
    fireEvent.click(btnInRow('news', '删除'));

    await waitFor(() =>
      expect(document.querySelector('.ant-popconfirm')).toBeTruthy(),
    );
    fireEvent.click(
      btnIn(document.querySelector('.ant-popconfirm') as ParentNode, '删除'),
    );

    // 第一次失败 → 应该出现强制删除的确认框
    await waitFor(() => expect(screen.queryByText('强制删除')).toBeTruthy());
    fireEvent.click(screen.getByText('强制删除'));

    await waitFor(() => expect(deleteCapability).toHaveBeenCalledTimes(2));
    expect(deleteCapability.mock.calls[1][0]).toBe('c3');
    expect(deleteCapability.mock.calls[1][1]).toBe(true);
  });

  it('新建也在弹窗里 —— 抽屉里没有常驻表单（表单只在 .ant-modal 内）', async () => {
    renderDrawer();
    // 抽屉里不该有任何输入框：默认打开的是列表，没有选中的行
    expect(document.querySelector('#code')).toBeNull();
    expect(document.querySelector('.ant-drawer input#name')).toBeNull();

    openCreate();
    // 弹窗起来了，code 才出现 —— 且它在 modal 里、不在 drawer 里
    await waitFor(() => expect(field('code')).toBeTruthy());
    expect(document.querySelector('.ant-drawer #code')).toBeNull();
    expect(modalTitle()).toContain('新建分类');
  });

  it('新建弹窗：有 code 输入框与「创建」按钮，没有 is_active（契约里 CapabilityCreate 没这字段）', async () => {
    renderDrawer();
    openCreate();

    await waitFor(() => expect(field('code')).toBeTruthy());
    expect(field('name')).toBeTruthy();
    expect(field('sort_order')).toBeTruthy();
    // 新建时不给 is_active —— 新建的节点一律默认启用
    expect(field('is_active')).toBeNull();
    expect(btnIn(modal(), '创建')).toBeTruthy();
    // 编辑专用那句 code 只读警告不该出现
    expect(screen.queryByText(/code 不可修改/)).toBeNull();
  });

  it('新建提交：带上 code / name / parent_id / sort_order 调 POST', async () => {
    renderDrawer();
    openCreate();
    await waitFor(() => expect(field('code')).toBeTruthy());

    fireEvent.change(field('code') as HTMLInputElement, {
      target: { value: 'macro' },
    });
    fireEvent.change(field('name') as HTMLInputElement, {
      target: { value: '宏观' },
    });
    fireEvent.click(btnIn(modal(), '创建'));

    await waitFor(() => expect(createCapability).toHaveBeenCalled());
    expect(createCapability.mock.calls[0][0]).toMatchObject({
      code: 'macro',
      name: '宏观',
      sort_order: 0,
    });
  });

  it('编辑弹窗里没有 code 输入框，改成只读提示', async () => {
    renderDrawer();
    fireEvent.click(btnInRow('us_stock', '编辑'));
    await waitFor(() => expect(screen.getByText('编辑分类')).toBeTruthy());

    expect(field('code')).toBeNull();
    // 用 textContent 而不是 getByText —— 这句被 <span class="mono">code</span>
    // 拆成了多个元素，文本匹配器找不到完整串
    expect(modal().textContent).toContain('不可修改');
    // is_active 只在编辑里出现
    expect(field('is_active')).toBeTruthy();
  });

  it('编辑：打开后回填原值，保存只发变更字段（PATCH 语义）', async () => {
    renderDrawer();
    fireEvent.click(btnInRow('us_stock', '编辑'));

    // 回填：name 输入框里应该是原名称
    await waitFor(() => expect(screen.getByText('编辑分类')).toBeTruthy());
    const nameInput = document.querySelector(
      '.ant-modal #name',
    ) as HTMLInputElement | null;
    await waitFor(() => expect(nameInput?.value).toBe('美股行情'));

    // 只改 name
    fireEvent.change(nameInput as HTMLInputElement, {
      target: { value: '美股行情（改）' },
    });
    fireEvent.click(
      btnIn(document.querySelector('.ant-modal') as ParentNode, '保存'),
    );

    await waitFor(() => expect(updateCapability).toHaveBeenCalled());
    const [id, body] = updateCapability.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe('c2');
    // 只发 name —— description / parent_id / sort_order / is_active 都不该被带上
    expect(body).toEqual({ name: '美股行情（改）' });
  });

  it('没有任何改动时提示「没有任何改动」且不发请求', async () => {
    renderDrawer();
    fireEvent.click(btnInRow('news', '编辑'));
    await waitFor(() => expect(screen.getByText('编辑分类')).toBeTruthy());

    fireEvent.click(
      btnIn(document.querySelector('.ant-modal') as ParentNode, '保存'),
    );

    await waitFor(() => expect(screen.getByText('没有任何改动')).toBeTruthy());
    expect(updateCapability).not.toHaveBeenCalled();
  });
});
