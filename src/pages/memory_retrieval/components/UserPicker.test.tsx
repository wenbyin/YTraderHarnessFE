// src/pages/memory_retrieval/components/UserPicker.test.tsx
//
// 选人控件的行为钉桩。这里测的是**我们这个组件**，不是 antd 的 Select ——
// `searchUsers` 被换掉（真实现会走 axios 打网络，happy-dom 里必然失败）。
//
// 最要紧的两条：
//   ① **敲进去的文字永远进不了值**（本页要的就是"只能选、不能填"）；
//   ② 选中之后回调拿到的 `id` 是**用户的 UUID** —— 那是 target 里唯一该传的东西。
// 其余是口径类断言（空关键字也列、防抖、403 说清楚），它们错了不会报错，
// 只会安静地显示一个看着合理的结果。
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/auth', () => ({ searchUsers: searchMock }));

import type { UserOption } from '@/services/auth';
import {
  describeUserSearchError,
  SEARCH_DEBOUNCE_MS,
  USER_PICKER_LIMIT,
  UserPicker,
  userOptionLabel,
  userPrimary,
} from './UserPicker';

/** 两个形状不同的行：一个字段齐全，一个只有登录名（契约允许 display_name / email 为空）。 */
const FULL: UserOption = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'zhangsan',
  display_name: '张三',
  email: 'zhangsan@example.com',
};
const BARE: UserOption = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'lisi',
};

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([FULL, BARE]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- 取 DOM 的小工具

/** 打开下拉（antd 的 Select 是 mousedown 打开，再点一次就关）。 */
function openDropdown() {
  // ⚠️ antd v6 换了 Select 的语义化类名：选择区从 .ant-select-selector 变成
  //    .ant-select-content，搜索框从 .ant-select-selection-search-input 变成
  //    .ant-select-input。直接 mousedown 根节点最省事（rc-select 挂在根上）。
  const root = document.querySelector('.ant-select');
  if (!root) throw new Error('没有 .ant-select');
  fireEvent.mouseDown(root);
}

/** 关上下拉：按 Esc（rc-select 认这个），比再点一次选择区可靠。 */
function closeDropdown() {
  const input = document.querySelector('.ant-select-input');
  if (!input) throw new Error('没有搜索输入框');
  fireEvent.keyDown(input, { key: 'Escape', keyCode: 27, which: 27 });
}

/** 下拉现在是不是开着（v6 的根节点上带 ant-select-open）。 */
function dropdownOpen(): boolean {
  return !!document.querySelector('.ant-select-open');
}

/** 选择区当前显示的文字（placeholder 或选中项）。 */
function selectedText(): string {
  return document.querySelector('.ant-select-content')?.textContent ?? '';
}

/**
 * 真实的受控父组件：**只持有选中的 id**，跟本页的用法一致。
 * 用它才能测"选中之后显示什么"—— 本组件是完全受控的，不给回值就看不到选中态。
 */
const Harness: React.FC = () => {
  const [value, setValue] = useState('');
  return <UserPicker value={value} onChange={(u) => setValue(u?.id ?? '')} />;
};

function searchInput(): HTMLInputElement {
  const input = document.querySelector('.ant-select-input');
  if (!input) throw new Error('没有搜索输入框（下拉没打开？）');
  return input as HTMLInputElement;
}

function optionTexts(): string[] {
  return Array.from(document.querySelectorAll('.ant-select-item-option')).map(
    (el) => el.textContent ?? '',
  );
}

/**
 * 每一行的**字符串 label**。
 *
 * antd 把它写进 `title` 属性（因为 label 是字符串）。用它而不是 textContent：
 * textContent 会把 antd 自己加的辅助节点也算进来，分不清"人名退让链"到底走没走对。
 */
function optionTitles(): string[] {
  return Array.from(document.querySelectorAll('.ant-select-item-option')).map(
    (el) => el.getAttribute('title') ?? '',
  );
}

async function mountAndOpen(onChange = vi.fn()) {
  render(<UserPicker value="" onChange={onChange} />);
  await waitFor(() => expect(searchMock).toHaveBeenCalled());
  await act(async () => {});
  openDropdown();
  await act(async () => {});
  return onChange;
}

// ---------------------------------------------------------------- 挂载与取数

describe('取数与下拉内容', () => {
  it('挂载就空关键字拉一次 —— 契约明说这是给选择器的用法（打开时不该是空的）', async () => {
    render(<UserPicker value="" onChange={vi.fn()} />);

    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    expect(searchMock).toHaveBeenCalledWith({
      keyword: undefined,
      limit: USER_PICKER_LIMIT,
    });
    expect(USER_PICKER_LIMIT).toBe(20);
  });

  it('下拉里每一行只显示人名，且退让链走对（不退化成一串 UUID）', async () => {
    await mountAndOpen();

    expect(optionTitles()).toEqual([
      '张三',
      // 没有 display_name / email 的那条退到登录名 —— 而不是拿 id 当名字
      'lisi',
    ]);
  });

  it('⚠️ 下拉里**不显示 UUID**（用户要求：显示 user_name 即可）', async () => {
    await mountAndOpen();

    // 看得见的两处：下拉里的每一行、以及选中项所在的选择区
    const visibleText = [
      ...optionTexts(),
      ...optionTitles(),
      selectedText(),
    ].join(' | ');

    expect(visibleText).toContain('张三');
    expect(visibleText).not.toContain(FULL.id);
    expect(visibleText).not.toContain(BARE.id);

    // ⚠️ 别把这条写成"整个 body 的 textContent 不含 id"：rc-select 会在下拉里
    //    额外渲染一份**看不见的** a11y listbox（`height:0;width:0;overflow:hidden`），
    //    它的文本节点是 option 的 value（= id），而 `aria-label` 是人名 ——
    //    读屏软件念的是人名。那份结构本来就该在，钉它等于钉错东西。
  });
});

// ---------------------------------------------------------------- 只选不填

describe('只能选，不能填', () => {
  it('选一个选项 → 回调拿到的是整个选项，id 就是 UUID', async () => {
    const onChange = await mountAndOpen();

    const first = document.querySelectorAll('.ant-select-item-option')[0];
    fireEvent.click(first);

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(FULL);
  });

  it('⚠️ 敲进去的文字**不会**变成值：输入 + 失焦，onChange 一次都不该被调', async () => {
    const onChange = await mountAndOpen();

    const input = searchInput();
    fireEvent.change(input, { target: { value: 'zhangsan' } });
    fireEvent.blur(input);

    // 关键字只用来查，不进 value —— 手打 UUID 打错一位看不出来，所以不给手打
    expect(onChange).not.toHaveBeenCalled();
  });

  it('清空（allowClear）→ 回调 null', async () => {
    const onChange = vi.fn();
    render(<UserPicker value={FULL.id} onChange={onChange} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    await act(async () => {});

    const clear = document.querySelector('.ant-select-clear');
    if (!clear) throw new Error('没有清空按钮（allowClear 没生效？）');
    fireEvent.mouseDown(clear);
    fireEvent.click(clear);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it('⚠️ 选中之后列表被后来的搜索换掉/清空，选中项显示的名字也不退化成一串 UUID', async () => {
    // 用真实的受控父组件（本页就是这么用的：只持有 id）
    render(<Harness />);
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    await act(async () => {});
    openDropdown();
    await act(async () => {});

    fireEvent.click(document.querySelectorAll('.ant-select-item-option')[0]);
    await act(async () => {});
    expect(selectedText()).toContain('张三');

    // 再搜一个搜不到的词 → 列表清空
    searchMock.mockResolvedValueOnce([]);
    fireEvent.change(searchInput(), { target: { value: 'nobody' } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(optionTexts()).toHaveLength(0);
    expect(selectedText()).toContain('张三');
    expect(selectedText()).not.toContain(FULL.id);
  });
});

// ---------------------------------------------------------------- 防抖与竞态

describe('搜索的节奏', () => {
  it('连敲三次只发一次请求，且用的是最后一次的关键字（300ms 防抖）', async () => {
    render(<UserPicker value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    openDropdown();
    await act(async () => {});

    vi.useFakeTimers();
    const input = searchInput();
    fireEvent.change(input, { target: { value: 'z' } });
    fireEvent.change(input, { target: { value: 'zh' } });
    fireEvent.change(input, { target: { value: 'zha' } });
    // 还没到点：一次都不该发
    expect(searchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
    });
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock).toHaveBeenLastCalledWith({ keyword: 'zha', limit: 20 });
  });

  it('关键字两边的空白被去掉；纯空白等于"不给"（契约里两者是同一件事）', async () => {
    render(<UserPicker value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    openDropdown();
    await act(async () => {});

    const input = searchInput();
    fireEvent.change(input, { target: { value: '  yin  ' } });
    await waitFor(() =>
      expect(searchMock).toHaveBeenLastCalledWith({
        keyword: 'yin',
        limit: 20,
      }),
    );
  });
});

// ---------------------------------------------------------------- 失败态

describe('失败态', () => {
  it('403 时下拉里如实说"缺 Y-Trader-Admin"，不弹全局 toast', async () => {
    searchMock.mockRejectedValue({ response: { status: 403 } });
    render(<UserPicker value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    await act(async () => {});
    openDropdown();
    await act(async () => {});

    await waitFor(() =>
      expect(document.body.textContent).toContain('没有 Y-Trader-Admin 角色'),
    );
  });

  it('失败之后重新打开下拉会重试一次（免得死在下拉里出不来）', async () => {
    searchMock.mockRejectedValueOnce({ response: { status: 403 } });
    searchMock.mockResolvedValue([FULL]);
    render(<UserPicker value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(optionTexts()).toHaveLength(0);

    openDropdown();
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(optionTexts()).toHaveLength(1);
  });

  it('⚠️ 搜索失败时**不保留**上一次的选项（留着旧结果等于把失败吞掉）', async () => {
    render(<UserPicker value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    openDropdown();
    await act(async () => {});
    expect(optionTexts()).toHaveLength(2);

    searchMock.mockRejectedValueOnce({ response: { status: 403 } });
    fireEvent.change(searchInput(), { target: { value: 'zhang' } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});

    // 旧列表必须消失：它跟当前关键字毫无关系，而且 antd 只在"没有选项"时
    // 才渲染 notFoundContent —— 留着旧结果，403 就永远露不出来
    expect(optionTexts()).toHaveLength(0);
    expect(document.body.textContent).toContain('没有 Y-Trader-Admin 角色');
  });

  it('⚠️ 搜空了之后重新打开下拉会**重新列一遍**（否则看起来像"一个人都没有"）', async () => {
    render(<UserPicker value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    openDropdown();
    await act(async () => {});

    // 搜一个搜不到的词 → 下拉空
    searchMock.mockResolvedValueOnce([]);
    fireEvent.change(searchInput(), { target: { value: 'nobody' } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(optionTexts()).toHaveLength(0);
    expect(document.body.textContent).toContain('区分大小写');

    // 关掉再打开：手里一条都没有 → 当没有筛选、重新列
    closeDropdown();
    await act(async () => {});
    expect(dropdownOpen()).toBe(false);
    searchMock.mockResolvedValue([FULL]);
    openDropdown();
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(dropdownOpen()).toBe(true);

    expect(searchMock).toHaveBeenLastCalledWith({
      keyword: undefined,
      limit: 20,
    });
    expect(optionTexts()).toHaveLength(1);
  });

  it('手里还有选项时重新打开**不**重取（用户搜完再打开，该保持他那把筛选）', async () => {
    render(<UserPicker value="" onChange={vi.fn()} />);
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    openDropdown();
    await act(async () => {});
    expect(optionTexts()).toHaveLength(2);

    closeDropdown();
    await act(async () => {});
    expect(dropdownOpen()).toBe(false);
    openDropdown();
    await act(async () => {});

    // 手里还有选项 → 不重取
    expect(searchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- 纯函数

describe('纯函数（文案与拼接，错了不会报错的那一类）', () => {
  it('userPrimary 的退让链：display_name > name > email > id', () => {
    expect(userPrimary(FULL)).toBe('张三');
    expect(userPrimary(BARE)).toBe('lisi');
    expect(
      userPrimary({ id: 'x', email: 'a@b.c', display_name: '   ', name: '  ' }),
    ).toBe('a@b.c');
    expect(userPrimary({ id: 'only-id' })).toBe('only-id');
  });

  it('userOptionLabel 就是人名本身 —— 不带"· 次要信息"、更不带 id', () => {
    expect(userOptionLabel(FULL)).toBe('张三');
    expect(userOptionLabel(BARE)).toBe('lisi');
    // 连 display_name / name / email 都没有时只剩 id 可显示（契约只有 id 必填）——
    // 那是唯一能认出这一行的东西，不是"把 uuid 又露出来了"
    expect(userOptionLabel({ id: 'only-id' })).toBe('only-id');
  });

  it('describeUserSearchError：后端中文原因优先于状态码兜底', () => {
    expect(
      describeUserSearchError({
        response: {
          status: 400,
          data: { detail: '目录查询失败：Casdoor 拒绝' },
        },
      }),
    ).toBe('目录查询失败：Casdoor 拒绝');
  });

  it('describeUserSearchError：422 的数组形状也要能读出来', () => {
    expect(
      describeUserSearchError({
        response: { status: 422, data: { detail: [{ msg: 'limit 越界' }] } },
      }),
    ).toBe('limit 越界');
  });

  it('describeUserSearchError：403 必须点明"不是你搜错了"（本地最常看到的一种）', () => {
    const text = describeUserSearchError({ response: { status: 403 } });
    expect(text).toContain('Y-Trader-Admin');
    expect(text).toContain('不是');
  });

  it('describeUserSearchError：401 / 500 / 兜底', () => {
    expect(describeUserSearchError({ response: { status: 401 } })).toContain(
      '401',
    );
    expect(describeUserSearchError({ response: { status: 500 } })).toContain(
      'Casdoor',
    );
    expect(describeUserSearchError({ message: 'Network Error' })).toBe(
      'Network Error',
    );
    expect(describeUserSearchError(null)).toBe('搜索用户失败。');
  });
});
