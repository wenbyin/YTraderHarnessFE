// src/components/CopilotDock/ToolActivityCards.test.tsx
//
// 工具活动记录（tool_activity）的渲染 —— **一次调用一张卡**。
//
// 需求（2026-10-13 二次收敛 + 2026-10-20 补口 + 2026-10-21 拆卡）：「仅仅展示
// 名字即可，无需列出参数和结果」；「终态就是一次 tool 调用一行数据」；
// 「工具调用卡片被合并了」。所以这组用例的重点
// **从"有没有漏掉东西"翻成了"有没有多出东西 / 有没有把两次调用挤成一张卡"**：
//   ① 一次调用 = 一张卡「<状态词>：<人话名>」；
//   ② 一条记录里有几个调用就画几张卡（并行调用不再用「、」连在一张卡里）；
//   ③ 同一个工具的**两种落库写法**（`agent_current_time` / `agent.current_time`）
//      仍然只画一张卡 —— 那是同一次调用；
//   ④ ⛔ 参数 JSON 不出现；
//   ⑤ ⛔ 模型旁白不出现；
//   ⑥ ⛔ 工具产出不出现 —— 于是"工具结果"那一条**整条不渲染**；
//   ⑦ ⭐ 每张卡各自包一层 `data-section-view="tool"`，且**不套壳** ——
//      卡与卡之间要吃到"卡片 = 最大档"那条相邻规则（2026-10-21 报的
//      「卡片被合并」就是套壳导致的：它们变成了"一张卡里的两段"）。
// 前六条里有三条是**负向断言**，这正是本次改动最容易悄悄回退的地方。
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createIntl, IntlContext } from 'react-intl';
import { describe, expect, it } from 'vitest';

import zhToolCall from '../../locales/zh-CN/toolCall';
import type { ToolActivityView, ToolCallView } from './history';
import ToolActivityCards, {
  mergeToolCalls,
  ToolActivityCard,
} from './ToolActivityRow';
import type { ToolCallStatus } from './useToolActivity';

const view = (over: Partial<ToolActivityView> = {}): ToolActivityView => ({
  calls: [],
  text: '',
  ...over,
});

const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-kind="tool_activity"]'));

const rowTexts = (container: HTMLElement) =>
  rows(container).map((row) => row.textContent ?? '');

const firstRow = (container: HTMLElement) => rows(container)[0] ?? null;

/** 一次调用的最简形状。 */
const call = (name: string, args: unknown = null): ToolCallView => ({
  id: `c-${name}`,
  name,
  args: args as never,
});

describe('mergeToolCalls：先把"同一次调用的两种写法"归并掉', () => {
  it('两种写法（点分 / 下划线）只留一条，名字保留先到的那个', () => {
    const merged = mergeToolCalls([
      call('agent_current_time'),
      call('agent.current_time'),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('agent_current_time');
  });

  it('⭐ 名字相近但不是同一个工具：不合并（web.search ≠ doc.search）', () => {
    const merged = mergeToolCalls([call('web.search'), call('doc.search')]);

    expect(merged.map((item) => item.name)).toEqual([
      'web.search',
      'doc.search',
    ]);
  });

  it('合并时状态取**更坏**的那个（失败不能被成功盖掉）', () => {
    const merged = mergeToolCalls([
      { ...call('web.search'), status: 'done' },
      { ...call('web.search'), status: 'error', error: 'boom' },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('error');
  });

  it('没有名字的一条降级成占位文案（不给 undefined）', () => {
    expect(mergeToolCalls([call('')])[0].name).toBe('(未命名工具)');
  });
});

describe('ToolActivityCards：一次调用一行', () => {
  it('⭐ 一行「<状态词>：<人话名>」，仅此而已', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({ calls: [call('agent.platform.list')] })}
      />,
    );

    expect(rowTexts(container)).toEqual(['agent.platform.list']);
  });

  it('⭐ 一条记录里两个调用 -> 两行（并行调用不再挤在同一行里）', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({ calls: [call('a.read'), call('b.write')] })}
      />,
    );

    expect(rowTexts(container)).toEqual(['a.read', 'b.write']);
  });

  it('⭐ 同一次调用被落库两遍 -> 仍然只有一张卡（刷新后那条「x、x」的来源）', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({
          calls: [
            call('agent_current_time'),
            call('web_search'),
            // 两条通道的两种写法：都是同一次调用
            call('agent.current_time'),
            call('web.search'),
          ],
        })}
      />,
    );

    expect(rowTexts(container)).toEqual(['agent_current_time', 'web_search']);
  });

  it('⭐ 不显示参数（原来那个封顶可滚的 JSON 框已删）', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({ calls: [call('search', { q: '年报', limit: 3 })] })}
      />,
    );

    const text = firstRow(container)?.textContent ?? '';
    expect(text).toContain('search');
    // 参数的一个字都不许进来 —— 键名与值各钉一次
    expect(text).not.toContain('limit');
    expect(text).not.toContain('年报');
    expect(text).not.toContain('{');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('⭐ 不显示模型旁白（旁白与调用同属一条消息，留下的只有名字）', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({
          calls: [call('search')],
          text: '我先查一下平台有哪些工具。',
        })}
      />,
    );

    const text = firstRow(container)?.textContent ?? '';
    expect(text).toContain('search');
    expect(text).not.toContain('我先查一下平台有哪些工具。');
  });

  it('⭐ 工具结果（calls 为空）-> 整条都不渲染', () => {
    const { container } = render(
      // 就算它带着很长的产出，也不该在界面上留下任何痕迹
      <ToolActivityCards view={view({ text: '{\n  "ok": true\n}' })} />,
    );

    expect(rows(container)).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('没名字的工具降级成占位文案，不显示 undefined', () => {
    const { container } = render(
      <ToolActivityCards view={view({ calls: [call('')] })} />,
    );

    const text = firstRow(container)?.textContent ?? '';
    // 渲染层会把占位换成译文（`toolCall.unnamed`）；没 Provider 时用兜底那份，
    // 总之**不带括号的原文案不该漏到界面上**，更不能是 undefined。
    expect(text).toContain('未命名工具');
    expect(text).not.toContain('(未命名工具)');
    expect(text).not.toContain('undefined');
  });
});

/**
 * ⭐ 每张卡必须是**独立的一张** —— 用户 2026-10-21 报的「工具调用卡片被合并了」
 *    正是这里退化的结果：卡片一旦被套进一个共同的壳里，它们就都变成"一张卡
 *    里的两段"，间距从「卡与卡 = 最大档」掉成「段与段 = 最小档」，看上去就是
 *    一坨粘在正文卡片下面的工具行。所以这里钉的是**结构**（不套壳），
 *    而不是"看起来分开了"。
 */
describe('每张卡各自独立（不套壳）', () => {
  const sections = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll(':scope > [data-section-view="tool"]'),
    );

  it('⭐ 每个调用各包一层 data-section-view="tool"，层里只放一张卡', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({ calls: [call('a.read'), call('b.write')] })}
      />,
    );

    expect(sections(container)).toHaveLength(2);
    // 一层一张卡 —— 不是"一张卡里两行"
    for (const section of sections(container)) {
      expect(
        section.querySelectorAll('[data-kind="tool_activity"]'),
      ).toHaveLength(1);
    }
  });

  it('⭐ 卡片是容器的**直接**子级（返回 Fragment，中间没有壳）', () => {
    const { container } = render(
      <ToolActivityCards view={view({ calls: [call('a.read')] })} />,
    );

    expect(container.children).toHaveLength(1);
    expect(container.children[0].getAttribute('data-section-view')).toBe(
      'tool',
    );
  });

  /**
   * 组首 / 组尾两个标记 —— CSS 只看相邻，分不出"这两张卡是不是同一条消息"，
   * 所以"最小档（同一步）/ 最大档（下一步）"的判据由这里标出来
   * （见 ToolActivityCards 的注释与 style.ts 的第 ⑤ 条）。
   */
  it('⭐ 组尾那张卡带 data-section-step-end（它后面是另一条消息 -> 最大档）', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({ calls: [call('a.read'), call('b.write')] })}
      />,
    );

    const [first, last] = Array.from(container.children);
    expect(first.getAttribute('data-section-step-end')).toBeNull();
    expect(last.getAttribute('data-section-step-end')).toBe('true');
  });

  it('⭐ 只有 attached（紧跟自己那条消息的正文卡）时组首才带标记', () => {
    const view2 = view({ calls: [call('a.read'), call('b.write')] });

    const detached = render(<ToolActivityCards view={view2} />);
    expect(
      detached.container.children[0].getAttribute('data-section-step-attached'),
    ).toBeNull();
    detached.unmount();

    // 上一条消息的正文卡 + 这一组 = 两条消息之间 -> 不给最小档
    const attached = render(<ToolActivityCards view={view2} attached />);
    expect(
      attached.container.children[0].getAttribute('data-section-step-attached'),
    ).toBe('true');
    expect(
      attached.container.children[1].getAttribute('data-section-step-attached'),
    ).toBeNull();
  });
});

describe('状态图标', () => {
  const iconOf = (container: HTMLElement, index = 0) =>
    rows(container)[index]?.querySelector('.anticon') ?? null;

  it('running → 转圈的图标（文字部分仍然只有「工具名字」）', () => {
    const { container } = render(
      <ToolActivityCard name="web.search" status="running" />,
    );

    expect(firstRow(container)?.getAttribute('data-status')).toBe('running');
    expect(iconOf(container)).not.toBeNull();
    expect(firstRow(container)?.textContent).toBe('web.search');
  });

  it('done / error 是两个不同的图标（绿勾 / 红叉的语义靠它区分）', () => {
    const { container, rerender } = render(
      <ToolActivityCard name="web.search" status="done" />,
    );
    const doneIcon = iconOf(container)?.innerHTML;

    rerender(
      <ToolActivityCard
        name="web.search"
        status="error"
        error="TimeoutError: 30s"
      />,
    );
    const errorIcon = iconOf(container)?.innerHTML;

    expect(firstRow(container)?.getAttribute('data-status')).toBe('error');
    expect(doneIcon).toBeTruthy();
    expect(errorIcon).toBeTruthy();
    expect(errorIcon).not.toBe(doneIcon);
  });

  it('没有状态 -> 一个图标都不画（不替后端编一个绿勾）', () => {
    const { container } = render(<ToolActivityCard name="web.search" />);

    expect(firstRow(container)?.getAttribute('data-status')).toBe('none');
    expect(iconOf(container)).toBeNull();
  });

  it('⭐ 历史那一份：每个调用用自己的状态（同一批里可以一张有一张没有）', () => {
    const { container } = render(
      <ToolActivityCards
        view={view({
          calls: [
            { ...call('a.read'), status: 'done' },
            { ...call('b.write'), status: 'error', error: '写入被拒绝' },
            call('c.list'),
          ],
        })}
      />,
    );

    expect(
      rows(container).map((row) => row.getAttribute('data-status')),
    ).toEqual(['done', 'error', 'none']);
    // 第三张没有状态 -> 一个图标都不画（不替后端编）
    expect(iconOf(container, 2)).toBeNull();
  });

  it('失败原因挂在红叉的悬停提示上', async () => {
    const { container } = render(
      <ToolActivityCard
        name="web.search"
        status="error"
        error="TimeoutError: 30s"
      />,
    );

    const icon = iconOf(container);
    expect(icon).not.toBeNull();
    fireEvent.mouseEnter(icon as Element);

    expect(await screen.findByText('TimeoutError: 30s')).toBeTruthy();
  });
});

/**
 * 工具名走 i18n、状态**只留图标**（2026-10-22 起，10-23 收敛）。
 *
 * 上面那批用例都是**裸渲染**（不挂 Provider），读到的是 toolLabels 里兜底的
 * 那份中文 —— 它们钉的是"一张卡一次调用"这类结构，不是文案。
 * 这一组挂真实语言包，钉两件事：
 *   ① 名字真的翻了（`document.retrieve_documents` -> 检索文档）；
 *   ② 三种状态的**行内文字完全一样**，差别只在图标 + 图标的 aria-label
 *      （用户 2026-10-23："正在调用、调用成功、调用失败 文字不用显示了，
 *      只要 icon 即可"）。
 */
describe('i18n：人话工具名 + 状态只由图标表达', () => {
  // 同 toolLabels.test.tsx：走 `IntlContext.Provider`（`<IntlProvider>` 的
  // 类型在 React 18 下不接受 children），挂的就是真实那份中文语言包。
  const withIntl = (ui: ReactElement) =>
    render(
      <IntlContext.Provider
        value={createIntl({ locale: 'zh-CN', messages: zhToolCall })}
      >
        {ui}
      </IntlContext.Provider>,
    );

  /** 图标的无障碍名 —— 状态词现在只住在这里。 */
  const statusLabel = (container: HTMLElement) =>
    rows(container)[0]
      ?.querySelector('[role="img"][aria-label]')
      ?.getAttribute('aria-label') ?? null;

  it('⭐ 行内只有工具名：检索文档（原标识符不再出现在正文里）', () => {
    const { container } = withIntl(
      <ToolActivityCard name="document.retrieve_documents" status="running" />,
    );

    const row = firstRow(container);
    expect(row?.textContent).toBe('检索文档');
    // 原始标识符不再出现在正文里（只留在 data-tool / 悬停提示上）
    expect(row?.textContent).not.toContain('retrieve_documents');
  });

  it('⭐ 三种状态都不印字：正文一模一样，状态词退到 aria-label', () => {
    const rowOf = (status?: ToolCallStatus) =>
      withIntl(<ToolActivityCard name="web.search" status={status} />)
        .container;

    // 正文：三态完全一致（如果谁把状态词又加回可见文本，这里立刻红）
    for (const status of ['running', 'done', 'error'] as const) {
      expect(firstRow(rowOf(status))?.textContent).toBe('搜索网页');
    }

    // 状态词没丢，只是搬到读屏那一层
    expect(statusLabel(rowOf('running'))).toBe('正在调用');
    expect(statusLabel(rowOf('done'))).toBe('调用成功');
    expect(statusLabel(rowOf('error'))).toBe('调用失败');
    // 没有状态的那张：连图标都没有，自然也没有 aria-label
    expect(statusLabel(rowOf())).toBeNull();
  });

  it('⭐ 契约原值留在 data-tool 上（排障按原值对齐后端日志）', () => {
    const { container } = withIntl(
      <ToolActivityCard name="agent_current_time" />,
    );

    const row = firstRow(container);
    // wire 写法归一成契约正名后留痕
    expect(row?.getAttribute('data-tool')).toBe('agent.current_time');
    expect(row?.textContent).toBe('查询当前时间');
  });

  it('⭐ MCP 工具（tdx）也翻了：tdx_get_market_info -> 查询市场信息', () => {
    const { container } = withIntl(
      <ToolActivityCard name="tdx_get_market_info" status="done" />,
    );

    const row = firstRow(container);
    // 链路上报的是 wire 写法（下划线），data-tool 归一成 <provider>.<tool>
    expect(row?.getAttribute('data-tool')).toBe('tdx.get_market_info');
    expect(row?.textContent).toBe('查询市场信息');
  });

  it('没登记的 MCP 工具：显示原值，不显示 undefined', () => {
    const { container } = withIntl(
      <ToolActivityCard name="acme.do_thing" status="done" />,
    );

    const row = firstRow(container);
    expect(row?.textContent).toBe('acme.do_thing');
    expect(row?.textContent).not.toContain('undefined');
  });
});
