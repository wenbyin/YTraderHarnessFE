// src/pages/tool/components/ToolList.test.tsx
//
// 列表项的冒烟测试。只钉三件**看起来无关紧要、实际会误导人**的事：
//
//   1. 业务标签**不能是默认灰** —— 它的底色与列表项底几乎同色，
//      未选中时整块看不见（2026-10-21 用户截图："当前颜色重复不选中看不见"）。
//      这是纯视觉问题，没有任何交互逻辑兜底，回归只能靠这里。
//   2. 分类显示**全路径**（父 / 子），不是 code，不是叶子名 ——
//      不同业务线下可能有同名叶子（「智能体HITL」），只看叶子分不清归属。
//   3. 没有分类的工具**不渲染空的标签容器** —— 空 Space 会撑出一行空白，
//      让"有分类"和"没分类"两种卡片高度不一样，滚动时整列都在跳。
//
// 不测的：筛选框（那是 antd 自己的受控行为）、键盘可达性（<button> 白拿）。
//
// ⚠️ 颜色一律按**类名**判（`ant-tag-purple`），不要读 `getComputedStyle` 的颜色。
//   jsdom 的层叠是残的：实测把一个 `color="purple"` 的标签读出来是
//   `#d48806`（gold 的色值）+ `#fffbe6`（gold 的底），类名却是对的。
//   照计算值写断言，等于写一条**永远绿**的摆设 —— 本文件第一版就是这么废掉的。
//   （jsdom 能用的只有本项目 emotion 自己注入的那几条，比如 padding —— 见
//    CopilotDock/toolActivity.test.tsx；antd 的 CSS-in-JS 预设色不在此列。）

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Capability, MCPProviderSummary, ToolSummary } from '../data';
import ToolList, { emptyFilters } from './ToolList';

// useEnumLabels 走 umi 的 useIntl —— 没有 IntlProvider 会直接抛。
// 这里只要"原值回落"这一条行为（没配译文就显示契约原值），mock 掉最省事。
vi.mock('@umijs/max', () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));

/** 两层分类：运行时 → HITL / 任务，用来验证"显示的是全路径"。 */
const TREE: Capability[] = [
  {
    id: 'c1',
    code: 'runtime',
    name: '智能体运行时',
    description: null,
    parent_id: null,
    sort_order: 0,
    is_active: true,
  },
  {
    id: 'c2',
    code: 'runtime_hitl',
    name: '智能体HITL',
    description: null,
    parent_id: 'c1',
    sort_order: 1,
    is_active: true,
  },
  {
    id: 'c3',
    code: 'runtime_task',
    name: '智能体任务',
    description: null,
    parent_id: 'c1',
    sort_order: 2,
    is_active: true,
  },
];

const TOOLS: ToolSummary[] = [
  {
    id: 't1',
    tool_key: 'agent.ask_user_question',
    name: 'ask_user_question',
    source_type: 'local_method',
    source_state: 'ACTIVE',
    description: '执行中向用户提问',
    classifications: [TREE[1]],
  },
  {
    id: 't2',
    tool_key: 'agent.no_class',
    name: 'no_class',
    source_type: 'local_method',
    source_state: 'ACTIVE',
    description: '没挂分类的工具',
    classifications: [],
  },
];

/** 一个连得上、且有 9 条已同步工具的 provider（形如后端实测返回的 tdx）。 */
const PROVIDERS: MCPProviderSummary[] = [
  {
    name: 'tdx',
    enabled: true,
    transport: 'stdio',
    connected: true,
    exposed_tool_count: 9,
    tools_mode: 'allowlist',
    tool_count: 9,
    active_tool_count: 9,
    missing_tool_count: 0,
  },
];

const renderList = (
  over: {
    selectedId?: string | null;
    filters?: Partial<ReturnType<typeof emptyFilters>>;
    providers?: MCPProviderSummary[];
  } = {},
) =>
  render(
    <App>
      <ToolList
        items={TOOLS}
        loading={false}
        total={TOOLS.length}
        selectedId={over.selectedId ?? null}
        onSelect={vi.fn()}
        sourceTypes={['local_method', 'mcp']}
        providers={over.providers ?? PROVIDERS}
        classifications={TREE}
        filters={{ ...emptyFilters(), ...over.filters }}
        onFiltersChange={vi.fn()}
      />
    </App>,
  );

/** 按可见文字找那个业务标签（它是列表项里的 `.ant-tag`）。 */
const tagOf = (text: string) =>
  screen.getByText(text).closest('.ant-tag') as HTMLElement;

afterEach(() => cleanup());

describe('业务标签', () => {
  it('⭐ 带预设色（purple），不是 antd 默认灰', () => {
    renderList();

    const tag = tagOf('智能体运行时 / 智能体HITL');
    expect(tag.className).toContain('ant-tag-purple');
  });

  it('⭐ 颜色不与状态标签（ACTIVE 绿）重复 —— 两个维度各自一色', () => {
    renderList();

    const presetOf = (el: HTMLElement) =>
      /ant-tag-(?!filled|borderless|hidden|rtl)([a-z]+)/.exec(
        el.className,
      )?.[1];

    const business = presetOf(tagOf('智能体运行时 / 智能体HITL'));
    // 两张卡都是 ACTIVE，取第一张就够（同一个映射表出来的，颜色不会各写各的）
    const state = presetOf(
      screen.getAllByText('ACTIVE')[0].closest('.ant-tag') as HTMLElement,
    );

    expect(business).toBeTruthy(); // 有预设色（默认灰不会有这一节）
    expect(business).not.toBe(state);
  });

  it('显示的是**全路径**，不是 code、也不是叶子名', () => {
    renderList();

    expect(tagOf('智能体运行时 / 智能体HITL').textContent).toBe(
      '智能体运行时 / 智能体HITL',
    );
    // code 挂在 title 上（对接口时按原值说话），不占可见位置
    expect(tagOf('智能体运行时 / 智能体HITL').getAttribute('title')).toBe(
      'runtime_hitl',
    );
  });

  it('没有分类的工具**整行都不出现**（空 Space 会撑出一行空白）', () => {
    renderList();

    const item = (text: string) =>
      screen.getByText(text).closest('button') as HTMLElement;

    // 有分类：名称行 / tool_key / 描述 / 标签行 = 4 个子块
    expect(item('agent.ask_user_question').children.length).toBe(4);
    // 没分类：3 个 —— 多出来的那个就是"空标签行"（它里面一个 tag 都没有，
    // 但会实实在在占掉一行高度，于是两种卡片不等高、滚动时整列在跳）
    expect(item('agent.no_class').children.length).toBe(3);
  });
});

describe('列表项本体', () => {
  it('点一下把 id 回传给父级（选中态由父级决定）', () => {
    const onSelect = vi.fn();
    render(
      <App>
        <ToolList
          items={TOOLS}
          loading={false}
          total={TOOLS.length}
          selectedId={null}
          onSelect={onSelect}
          sourceTypes={[]}
          providers={[]}
          classifications={TREE}
          filters={emptyFilters()}
          onFiltersChange={vi.fn()}
        />
      </App>,
    );

    fireEvent.click(screen.getByText('agent.ask_user_question'));
    expect(onSelect).toHaveBeenCalledWith('t1');
  });
});

/**
 * provider 过滤框。这里测的三条都是"错了不报错、只会静默返回空列表"的
 * 联动语义（规则本体在 mcpProvider.test.ts，这里只证明它真的接到了界面上）。
 */
describe('MCP provider 过滤', () => {
  /** 用 placeholder 定位那个 Select（它没有可依赖的 data-* 标记）。 */
  const providerSelect = () =>
    screen.getByText(/MCP provider/).closest('.ant-select') as HTMLElement;

  it('选项里带条数，用的是 tool_count', () => {
    renderList();
    fireEvent.mouseDown(providerSelect());

    expect(screen.getByText('tdx · 9 个工具')).toBeInTheDocument();
  });

  it('⭐ 类型不是 mcp 时禁用，并说明原因', () => {
    renderList({ filters: { source_type: 'local_method' } });

    const select = providerSelect();
    expect(select.className).toContain('ant-select-disabled');
    // 光禁用不说原因，用户会以为"这个来源没有 provider"
    expect(
      screen.getByText('MCP provider（先把 source_type 选成 mcp）'),
    ).toBeInTheDocument();
  });

  it('类型不限时**不**禁用（source_ref 单独就成立）', () => {
    renderList();

    expect(providerSelect().className).not.toContain('ant-select-disabled');
  });

  it('选中 provider 后把三组数字摊开（暴露 / 已同步 / ACTIVE·MISSING）', () => {
    renderList({ filters: { source_type: 'mcp', source_ref: 'tdx' } });

    expect(
      screen.getByText('已连接 · 暴露 9 · 已同步 9（ACTIVE 9 / MISSING 0）'),
    ).toBeInTheDocument();
    // 选中值：antd v6 把它渲染成 `.ant-select-content`，文字也挂在 title 上
    // （v5 的 .ant-select-selection-item 已经没有了 —— 别照旧版本写选择器）
    expect(screen.getByTitle('tdx · 9 个工具')).toBeInTheDocument();
  });

  it('没选中时不显示明细行（不留空占位）', () => {
    renderList({ filters: { source_type: 'mcp' } });

    expect(screen.queryByText(/已同步 \d+（ACTIVE/)).toBeNull();
  });
});
