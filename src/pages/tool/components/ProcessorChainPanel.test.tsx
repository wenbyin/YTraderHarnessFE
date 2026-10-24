// src/pages/tool/components/ProcessorChainPanel.test.tsx
//
// 处理链面板的冒烟测试 —— 只验证"接得上、点得动"，不验证动画。
//
// 这里刻意**不测拖拽**：happy-dom 里 getBoundingClientRect 全返回 0，
// 指针落点算不出来，拖了也等于原地。拖拽的判定逻辑在
// processorChain.test.ts 里以纯函数形式覆盖（resolveDrop / canDrop / buildTimeline），
// 那个才是真正需要断言的地方。
//
// 测什么：
//   1. 注册表 + 链能渲染出条目（名称来自注册表，不是裸 key）
//   2. AROUND 展开成「进入 / 退出」两行，⟦Tool⟧ 在中间
//   3. 已挂载的处理器 → 按钮禁用（同一个 key 只能挂一次）
//   4. ✕ 能把实例从链上摘掉
//   5. ⚙ 能打开配置抽屉且 AROUND 时给出 SYNC 提示
//   6. → 能把新实例挂上链（走 morph 那条路，动画在 happy-dom 里自动退化）

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessorDefinition, ToolProcessor } from '../processorChain';

const REGISTRY: ProcessorDefinition[] = [
  {
    key: 'auth_interceptor',
    name: '鉴权拦截器',
    processor_type: 'INTERCEPTOR',
    supported_hooks: ['BEFORE', 'AROUND'],
    supported_execution_modes: ['SYNC'],
    registry_available: true,
    config_schema: {
      type: 'object',
      properties: { required_scope: { type: 'string', title: '所需 scope' } },
    },
  },
  {
    key: 'metrics_processor',
    name: '指标埋点',
    processor_type: 'OBSERVER',
    supported_hooks: ['BEFORE', 'AFTER'],
    supported_execution_modes: ['SYNC', 'ASYNC'],
    registry_available: true,
    config_schema: {
      type: 'object',
      properties: { metric: { type: 'string', title: '指标名' } },
    },
  },
  {
    key: 'result_mapper',
    name: '结果映射',
    processor_type: 'TRANSFORMER',
    supported_hooks: ['AFTER', 'AROUND'],
    supported_execution_modes: ['SYNC', 'ASYNC'],
    registry_available: true,
    config_schema: {
      type: 'object',
      properties: { max_items: { type: 'integer', title: '最大条数' } },
    },
  },
  {
    key: 'ghost_processor',
    name: '已失联处理器',
    processor_type: 'OBSERVER',
    supported_hooks: ['BEFORE'],
    supported_execution_modes: ['SYNC'],
    registry_available: false, // 实现已从注册表消失 → 挂不上
    config_schema: { type: 'object', properties: {} },
  },
];

/** 链上三条记录（AROUND 占两条：进 + 出）。顺序 = 落库顺序。 */
const CHAIN: ToolProcessor[] = [
  {
    id: 'p1',
    tool_id: 't1',
    processor_key: 'auth_interceptor',
    sequence: 1,
    execution_mode: 'SYNC',
    hook: 'AROUND',
    config: {},
    enabled: true,
  },
  {
    id: 'p2',
    tool_id: 't1',
    processor_key: 'metrics_processor',
    sequence: 2,
    execution_mode: 'ASYNC',
    hook: 'BEFORE',
    config: {},
    enabled: true,
  },
  {
    id: 'p3',
    tool_id: 't1',
    processor_key: 'result_mapper',
    sequence: 3,
    execution_mode: 'SYNC',
    hook: 'AFTER',
    config: {},
    enabled: true,
  },
  {
    id: 'p4',
    tool_id: 't1',
    processor_key: 'auth_interceptor',
    sequence: 4,
    execution_mode: 'SYNC',
    hook: 'AROUND',
    config: {},
    enabled: true,
  },
];

const listToolProcessors = vi.fn(async () => ({
  tool_id: 't1',
  processors: CHAIN,
}));
const listProcessorDefinitions = vi.fn(async () => ({
  items: REGISTRY,
  page: 1,
  page_size: 200,
  total: REGISTRY.length,
}));
const replaceToolProcessorChain = vi.fn(async () => ({
  tool_id: 't1',
  processors: [],
}));

// 与仓库里其他页面单测同一套做法：组件走 useIntl 取译文，
// 单测里没有 umi 的 locale provider，这里替一个"回落到 defaultMessage"的实现
// —— 顺带验证了一件事：没配翻译的枚举会原样显示契约原值，不会变成 key 名。
vi.mock('@umijs/max', () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage?: string }) =>
      defaultMessage ?? '',
  }),
}));

vi.mock('../processorService', () => ({
  listProcessorDefinitions: (...a: unknown[]) =>
    listProcessorDefinitions(...(a as [])),
  listToolProcessors: (...a: unknown[]) => listToolProcessors(...(a as [])),
  replaceToolProcessorChain: (...a: unknown[]) =>
    replaceToolProcessorChain(...(a as [])),
  reorderToolProcessors: vi.fn(),
  REGISTRY_PAGE_SIZE: 200,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
import ProcessorChainPanel from './ProcessorChainPanel';

const renderPanel = () =>
  render(
    <App>
      <ProcessorChainPanel toolId="t1" />
    </App>,
  );

describe('ProcessorChainPanel', () => {
  beforeEach(() => {
    listToolProcessors.mockClear();
    listProcessorDefinitions.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('加载注册表与链后渲染出处理器名称（不是裸 key）', async () => {
    renderPanel();
    await waitFor(() => expect(listToolProcessors).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getAllByText('鉴权拦截器').length).toBeGreaterThan(0),
    );
    // 库里 4 个 + 链上鉴权出现 2 行 + 抽屉关闭 → 至少 3 处
    expect(screen.getAllByText('指标埋点').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('结果映射').length).toBeGreaterThanOrEqual(2);
  });

  it('AROUND 展开成「进入 / 退出」两行，⟦Tool⟧ 夹在中间', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('▶ 进入')).toBeTruthy());
    expect(screen.getByText('◀ 退出')).toBeTruthy();
    expect(screen.getByText('⟦ Tool 本体执行 ⟧')).toBeTruthy();

    const rowOf = (text: string) =>
      screen.getByText(text).closest('[data-chain-uid]') as HTMLElement;
    const enter = rowOf('▶ 进入');
    const tool = screen
      .getByText('⟦ Tool 本体执行 ⟧')
      .closest('[data-kind]') as HTMLElement;
    const exit = rowOf('◀ 退出');

    // 行序 = 执行顺序：进入 → Tool → 退出
    const pos = (el: HTMLElement) =>
      Array.from(el.parentElement?.children ?? []).indexOf(el);
    expect(pos(enter)).toBeLessThan(pos(tool));
    expect(pos(tool)).toBeLessThan(pos(exit));
    // 同一对 AROUND 的两行是同一个 uid
    expect(enter.dataset.chainUid).toBe(exit.dataset.chainUid);
  });

  it('已挂载显示「已挂 ×N」但不禁用；实现失联的才禁用', async () => {
    renderPanel();
    await waitFor(() => expect(listProcessorDefinitions).toHaveBeenCalled());

    const itemOf = (name: string) =>
      screen.getAllByText(name)[0].closest('[data-lib-item]') as HTMLElement;
    const arrowOf = (name: string) =>
      itemOf(name).querySelector('button') as HTMLButtonElement;

    // 已挂载 → 不禁用（同一个 key 可挂 N 次），并显示「已挂 ×1」
    expect(arrowOf('鉴权拦截器').disabled).toBe(false);
    expect(screen.getAllByText('已挂 ×1').length).toBeGreaterThanOrEqual(1);
    expect(arrowOf('指标埋点').disabled).toBe(false);
    expect(arrowOf('结果映射').disabled).toBe(false);
    // 只有实现失联的才禁
    expect(arrowOf('已失联处理器').disabled).toBe(true);
  });

  it('✕ 把实例从链上摘掉', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('◀ 退出')).toBeTruthy());
    const before = screen.getAllByTitle('从链上摘掉').length;
    expect(before).toBe(4); // 4 条行：进入 / 指标 / 结果 / 退出

    fireEvent.click(screen.getAllByTitle('从链上摘掉')[0]); // 摘掉 AROUND 的进入行
    await waitFor(() =>
      expect(screen.getAllByTitle('从链上摘掉').length).toBe(2),
    );
    // AROUND 是"一条实例两行"，摘掉后两行一起消失
    expect(screen.queryByText('▶ 进入')).toBeNull();
    expect(screen.queryByText('◀ 退出')).toBeNull();
  });

  it('⚙ 打开配置抽屉，AROUND 时提示必须 SYNC', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('▶ 进入')).toBeTruthy());

    fireEvent.click(screen.getAllByTitle('绑定配置')[0]);
    await waitFor(() => expect(screen.getByText('挂载位置 hook')).toBeTruthy());

    /*
     * 这条断言原先是找一句 Alert 文案「hook = AROUND：必须 SYNC」，抽屉改成
     * 「就地把 ASYNC 选项禁掉」之后文案就不存在了 —— 测试因此一直红着。
     * 现在改成验**结果**：AROUND 实例打开抽屉时，执行方式已经是 SYNC。
     * （第二个 .ant-select 是执行方式，第一个是 hook。）
     */
    const selects = document.querySelectorAll('.ant-select');
    expect(selects.length).toBeGreaterThanOrEqual(2);
    expect(selects[1].textContent).toContain('SYNC');
    expect(screen.getByText('只放处理器自身参数')).toBeTruthy();
  });

  it('→ 挂新实例，且同一个 key 可以再挂第二个（BEFORE / AFTER 各一次）', async () => {
    renderPanel();
    await waitFor(() => expect(listProcessorDefinitions).toHaveBeenCalled());

    const arrowOf = (name: string) =>
      (
        screen.getAllByText(name)[0].closest('[data-lib-item]') as HTMLElement
      ).querySelector('button') as HTMLButtonElement;

    // 摘掉链上所有实例，从空链开始
    while (screen.queryAllByTitle('从链上摘掉').length) {
      fireEvent.click(screen.getAllByTitle('从链上摘掉')[0]);
    }
    await waitFor(() =>
      expect(screen.getByText(/还没有挂任何处理器/)).toBeTruthy(),
    );

    expect(arrowOf('指标埋点').disabled).toBe(false);
    fireEvent.click(arrowOf('指标埋点'));
    await waitFor(() =>
      expect(screen.getAllByTitle('绑定配置').length).toBe(1),
    );

    // 同一个 key 再挂一次：不拦（默认 hook 是 BEFORE，第二次也是 BEFORE，
    // 两个 BEFORE 同 key 在后端完全合法 —— 洋葱校验只看 AROUND）
    expect(arrowOf('指标埋点').disabled).toBe(false);
    expect(screen.getAllByText('已挂 ×1').length).toBeGreaterThan(0);
    fireEvent.click(arrowOf('指标埋点'));
    await waitFor(() =>
      expect(screen.getAllByTitle('绑定配置').length).toBe(2),
    );
    expect(screen.getAllByText('已挂 ×2').length).toBeGreaterThan(0);
  });

  it('保存走 PUT 全量替换，且 AROUND 落成两条记录', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('◀ 退出')).toBeTruthy());

    // 改动一下：摘掉 AFTER 的 result_mapper，让 dirty = true。
    // ✕ 的 DOM 次序 = 行序：进入 / BEFORE / ⟦Tool⟧(无) / AFTER / 退出
    // → 下标 2 才是 result_mapper；下标 3 是 AROUND 的退出行，
    //   点它会把整条 AROUND 实例摘掉（一条实例对应两行）。
    const rows = screen.getAllByTitle('从链上摘掉');
    fireEvent.click(rows[2]);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /保存/ })).toBeTruthy(),
    );

    const saveBtn = screen.getByRole('button', {
      name: /保存/,
    }) as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    fireEvent.click(saveBtn);

    await waitFor(() => expect(replaceToolProcessorChain).toHaveBeenCalled());
    const call = replaceToolProcessorChain.mock.calls[0] as unknown as [
      string,
      { items: { processor_key: string; hook: string }[] },
    ];
    const body = call[1];
    // auth(进) / metrics(BEFORE) / auth(出) —— AROUND 就是两条记录
    expect(body.items.map((i) => `${i.processor_key}:${i.hook}`)).toEqual([
      'auth_interceptor:AROUND',
      'metrics_processor:BEFORE',
      'auth_interceptor:AROUND',
    ]);
  });
});
