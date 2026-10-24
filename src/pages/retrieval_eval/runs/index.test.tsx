// src/pages/retrieval_eval/runs/index.test.tsx
//
// 「发起跑测」抽屉的**接线条**测试。专盯多轮阶梯这一条线，因为它的错误
// 全是静默的：
//
//   1. 发了 `query_processor_override` 而不是 `attempts` → 后端用内置阶梯跑，
//      用户在抽屉里改的三个数**一个都不生效**，且不报错；
//   2. `attempts` 的字段名/嵌套写错（比如把 `retrieve_processor` 写成
//      `query_processor`）→ 契约会 422 或被当成"没给"，参数静默丢失；
//   3. 「裁剪条数 < max_k」不提示 → Hit@K 的分母与实际返回条数不一致，
//      数字偏低却看着像召回变差。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createRetrievalEvalRun = vi.fn();
const listEvalRunHistory = vi.fn();
const listRetrievalEvalBundles = vi.fn();
const rememberEvalRun = vi.fn();
const push = vi.fn();

vi.mock('@umijs/max', () => ({
  history: { push: (...args: unknown[]) => push(...args) },
  // 带 bundle 参数进来 → 抽屉自动开、bundle 预选，省掉 Select 交互
  useSearchParams: () => [new URLSearchParams('bundle=bundle-1')],
}));

/**
 * ⚠️ 必须挡掉 pro-components，不能在单测里真加载它。
 *
 * `@ant-design/pro-components` 的 provider 会 `import zh_CN from
 * 'antd/es/locale/zh_CN'`，而 antd v6 那个文件内部用的是**不带扩展名**的
 * 相对导入；在 vitest 里这条链交给 Node 的 ESM 解析器，直接
 * `Cannot find module '...antd/es/calendar/locale/zh_CN'`，
 * **整个测试文件都起不来**（试过 resolve.alias 与 server.deps.inline，
 * 都拦不住被外部化的依赖内部的相对导入）。
 *
 * 本用例只关心表单值与提交负载，不关心页面骨架，所以换成最薄的替身。
 */
vi.mock('@ant-design/pro-components', () => ({
  PageContainer: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ProTable: () => <div data-testid="pro-table" />,
}));

vi.mock('../service', () => ({
  createRetrievalEvalRun: (...args: unknown[]) =>
    createRetrievalEvalRun(...args),
  listEvalRunHistory: (...args: unknown[]) => listEvalRunHistory(...args),
  listRetrievalEvalBundles: (...args: unknown[]) =>
    listRetrievalEvalBundles(...args),
}));

vi.mock('../runRegistry', () => ({
  rememberEvalRun: (...args: unknown[]) => rememberEvalRun(...args),
}));

import RetrievalEvalRunsPage from './index';

// 调用计数跨用例累积（vi.fn 是模块级的），不清就会把上一个用例的次数算进来
beforeEach(() => {
  vi.clearAllMocks();
});

function setup() {
  createRetrievalEvalRun.mockResolvedValue({
    eval_run_id: 'run-new',
    bundle_id: 'bundle-1',
    status: 'queued',
  });
  listEvalRunHistory.mockResolvedValue([]);
  listRetrievalEvalBundles.mockResolvedValue({ items: [] });

  render(
    <App>
      <RetrievalEvalRunsPage />
    </App>,
  );
}

async function openDrawerAndSubmit() {
  setup();
  // 抽屉由 ?bundle= 自动打开并预选 bundle
  const submit = await screen.findByRole('button', { name: /开始跑测/ });
  fireEvent.click(submit);
  await waitFor(() => expect(createRetrievalEvalRun).toHaveBeenCalledTimes(1));
  return createRetrievalEvalRun.mock.calls[0][0];
}

describe('发起跑测 · 多轮阶梯', () => {
  it('默认提交内置三档阶梯：3 轮，召回/融合/裁剪逐轮放宽', async () => {
    const body = await openDrawerAndSubmit();

    expect(body.bundle_id).toBe('bundle-1');
    expect(body.attempts).toHaveLength(3);

    expect(body.attempts.map((a: any) => a.recall_top_k)).toEqual([
      200, 400, 500,
    ]);
    expect(
      body.attempts.map((a: any) => a.retrieve_processor?.fusioner?.top_k),
    ).toEqual([50, 100, 200]);
    expect(
      body.attempts.map((a: any) => a.retrieve_processor?.cutter?.top_k),
    ).toEqual([10, 20, 30]);
    expect(body.attempts.map((a: any) => a.name)).toEqual([
      'round1',
      'round2',
      'round3',
    ]);
  });

  it('只有第 3 轮带精排（贵，只让前两轮没找到的那批去付）', async () => {
    const body = await openDrawerAndSubmit();

    expect(body.attempts[0].retrieve_processor?.reranker).toBeUndefined();
    expect(body.attempts[1].retrieve_processor?.reranker).toBeUndefined();
    expect(body.attempts[2].retrieve_processor?.reranker).toEqual({
      enabled: true,
      type: 'cross_encoder',
      top_n: 10,
    });
  });

  it('**不发** query_processor_override —— 发了会被 attempts 盖过，是静默不生效', async () => {
    const body = await openDrawerAndSubmit();
    expect(body.query_processor_override).toBeUndefined();
    expect('query_processor_override' in body).toBe(false);
  });

  it('默认逐轮改写档：common / llm / 不改写（第 3 轮整段不发）', async () => {
    const body = await openDrawerAndSubmit();

    expect(body.attempts.map((a: any) => a.query_rewriter)).toEqual([
      { kind: 'common' },
      { kind: 'llm' },
      undefined,
    ]);
    // ⚠️ 「不改写」必须是**字段不存在**，不能是 `{enabled:false}`：
    // 后端快照按 exclude_unset 存，多发一个默认值就会在快照里留下一个
    // 恒为 true 的键，让"这一轮为什么改写"读起来像是有个开关被动过。
    expect('query_rewriter' in body.attempts[2]).toBe(false);
  });

  it('改写器是 `retrieve_processor` 的**兄弟**，不是第五段', async () => {
    const body = await openDrawerAndSubmit();
    // 只有前两轮要求改写（第 3 轮刻意不改 —— 它要读精排的增量）
    expect(body.attempts.filter((a: any) => a.query_rewriter)).toHaveLength(2);
    for (const round of body.attempts) {
      // 塞进 processor 里后端会 422 / 静默忽略 —— 那一层没有改写的位置
      expect(Object.keys(round.retrieve_processor ?? {})).not.toContain(
        'query_rewriter',
      );
    }
  });

  it('逐轮换了改写器时提示「增量不只是那一个变量的贡献」', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    // 内置阶梯就是逐轮换档的（第 3 轮要读精排增量、不改写）→ 默认即提示。
    // 「改到全同后提示消失」由 attemptLadder.test.ts 的 rewriteKindsDiffer
    // 覆盖 —— 那条是纯函数，比驱动 antd Select 的浮层稳。
    expect(screen.getByText('逐轮用了不同的查询改写器')).toBeTruthy();
  });

  it('未开启的段整段省略（= 继承 DTD），不是发 false', async () => {
    const body = await openDrawerAndSubmit();
    // 过滤段三轮都没开覆盖 → 一个都不该出现
    for (const round of body.attempts) {
      expect(round.retrieve_processor?.filter).toBeUndefined();
    }
  });

  it('抽屉里列出了三轮，并说明后两轮只跑上一轮未命中的 case', async () => {
    await openDrawerAndSubmit();
    expect(screen.getByText('多轮召回阶梯')).toBeTruthy();
    // 阶梯语义落在**每轮的副标题**上，比一句总说明更难写错：第 1 轮是全体，
    // 之后每轮只跑上一轮没命中的 —— 这样「每轮分母不同」才是看得见的。
    expect(screen.getByText('全部 case')).toBeTruthy();
    expect(screen.getByText('只跑第 1 轮未命中的 case')).toBeTruthy();
    expect(screen.getByText('只跑第 2 轮未命中的 case')).toBeTruthy();
  });

  it('裁剪条数小于 max_k 时给出警告（Hit@K 会偏低）', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    // 默认 max_k=10，三轮裁剪 10/20/30 → 无警告
    expect(
      screen.queryByText('裁剪条数小于 max_k，命中口径会对不上'),
    ).toBeNull();

    // 把 max_k 提到 50 → 第 1 轮裁剪 10 < 50，必须提示
    const spin = screen.getAllByRole('spinbutton')[0];
    fireEvent.change(spin, { target: { value: '50' } });

    await waitFor(() => {
      expect(
        screen.getByText('裁剪条数小于 max_k，命中口径会对不上'),
      ).toBeTruthy();
    });
  });
});

describe('轮次卡片 · 一步一行，顺序 = 检索顺序', () => {
  /**
   * 第 1 轮卡片里的「步」：`[data-round-stages]` 的直接子元素。
   *
   * ⚠️ 别按类名找 —— antd-style 的类名是哈希的（`acss-xxxx`）。
   * 语义顺序靠 `data-stage` 读，不靠文本 `indexOf`：页面上「裁剪」这类词
   * 在别处也会出现（例如列宽提示、指标名），扫全页文本会把顺序读错。
   */
  function stagesOfFirstRound(): HTMLElement[] {
    const card = Array.from(document.querySelectorAll('.ant-card')).find(
      (c) =>
        (c.textContent ?? '').includes('第 1 轮') &&
        (c.textContent ?? '').includes('轮次名'),
    );
    if (!card) throw new Error('第 1 轮卡片没渲染出来');
    const list = card.querySelector('[data-round-stages]');
    if (!list) throw new Error('轮次卡片没有阶段列表容器');
    return Array.from(list.children) as HTMLElement[];
  }

  const stageKeys = (rows: HTMLElement[]) =>
    rows.map((r) => r.dataset.stage ?? '');

  /** 一步里的控件标签（`Form.Item label`），按 DOM 顺序。 */
  function labelsOf(row: HTMLElement): string[] {
    return Array.from(row.querySelectorAll('.ant-form-item-label label')).map(
      (l) => (l.textContent ?? '').replace(/\*/g, '').trim(),
    );
  }

  function stageOf(rows: HTMLElement[], key: string): HTMLElement {
    const row = rows.find((r) => r.dataset.stage === key);
    if (!row) throw new Error(`没找到阶段 ${key}`);
    return row;
  }

  it('行的顺序就是后端执行顺序：改写 → 召回 → 融合过滤 → 精排 → 裁剪', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    // identity 是轮次名（这轮的标识，不是流水线的一步），之后才是五个阶段。
    // 依据后端 `RetrieveProcessor.run`：改写在前，然后 recall → fusioner →
    // filter → reranker → cutter。**这个数组就是本次改动的核心断言**：
    // 之前「裁剪」排在「融合」前面、还和「查询改写」挤同一行。
    expect(stageKeys(stagesOfFirstRound())).toEqual([
      'identity',
      'rewrite',
      'recall',
      'fusion',
      'rerank',
      'cut',
    ]);
  });

  it('每一步只放自己那一步的控件（一步一行）', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    const rows = stagesOfFirstRound();
    expect(labelsOf(stageOf(rows, 'rewrite'))).toEqual(['改写档位']);
    expect(labelsOf(stageOf(rows, 'recall'))).toEqual(['每路条数']);
    // 融合与过滤是同一行（用户读这张卡时把它们当一个步骤），顺序仍是先融合后过滤
    // 过滤只有**一个**控件（三态下拉）—— 原来这里并排两颗开关，
    // 都默认打开，看着像同一个东西放了两遍（用户原话："为什么同时存在两个按钮"）。
    expect(labelsOf(stageOf(rows, 'fusion'))).toEqual(['融合 top_k', '过滤']);
    expect(labelsOf(stageOf(rows, 'rerank'))).toEqual(['覆盖精排']);
    expect(labelsOf(stageOf(rows, 'cut'))).toEqual(['裁剪 top_k']);
  });

  it('「过滤」排在「覆盖精排」之前（先过滤再重排）', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    const all = Array.from(
      document.querySelectorAll('.ant-form-item-label label'),
    ).map((l) => (l.textContent ?? '').replace(/\*/g, '').trim());
    // 反了的话，读的人会以为过滤发生在重排之后 —— 而 filter 在 reranker 之前跑，
    // 顺序写错时"为什么阈值一改命中就掉"这种问题根本没人答得出来。
    expect(all.indexOf('过滤')).toBeLessThan(all.indexOf('覆盖精排'));
    // 裁剪必须是最后一屏能看到的阶段
    expect(all.indexOf('裁剪 top_k')).toBeGreaterThan(all.indexOf('覆盖精排'));
  });

  it('轮次名不走 Form.Item label（它就是那一行的名字，重复一遍是废话）', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    const rows = stagesOfFirstRound();
    expect(labelsOf(stageOf(rows, 'identity'))).toEqual([]);
    expect(
      stageOf(rows, 'identity')
        .querySelector('input')
        ?.getAttribute('aria-label'),
    ).toBe('轮次名');
  });

  it('过滤只有一个控件（三态下拉），默认停在「默认」且不出阈值', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    const fusion = stageOf(stagesOfFirstRound(), 'fusion');
    // 原来这里并排两颗开关（覆盖过滤 / 过滤状态），都默认打开 ——
    // 用户的原话是"为什么同时存在两个按钮"。现在只剩一颗下拉。
    expect(labelsOf(fusion)).toEqual(['融合 top_k', '过滤']);

    const combo = fusion.querySelector('[role="combobox"]');
    expect(combo).not.toBeNull();
    // 默认档的文案是「默认」而不是「启用」—— 写成「启用」又会和「按阈值」撞车
    expect(fusion.textContent).toContain('默认');
    // 阈值只在「按阈值」档才出现，默认不占位
    expect(fusion.textContent).not.toContain('score_threshold');
    // 三态里的另外两个选项确实在（下拉未展开时它们只在 options 里）
    expect(fusion.querySelectorAll('[role="combobox"]').length).toBe(1);
  });

  it('开启覆盖精排后，类型 / top_n 落在精排这一步里', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    // 过滤改成下拉之后，开关只剩：包含阶段 trace（卡外）→ 每轮「覆盖精排」
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[1]); // 第 1 轮的「覆盖精排」

    await waitFor(() => {
      const rows = stagesOfFirstRound();
      expect(labelsOf(stageOf(rows, 'rerank'))).toEqual([
        '覆盖精排',
        '类型',
        'top_n',
      ]);
      expect(labelsOf(stageOf(rows, 'fusion'))).toEqual(['融合 top_k', '过滤']);
    });
  });

  it('同一行的控件给定宽，跨行才对得齐', async () => {
    setup();
    await screen.findByRole('button', { name: /开始跑测/ });

    const rows = stagesOfFirstRound();
    const scalarWidths = (key: string) =>
      Array.from(
        stageOf(rows, key).querySelectorAll<HTMLElement>('.ant-form-item'),
      )
        .filter((el) => !el.classList.contains('ant-form-item-has-error'))
        .map((el) => el.style.width);

    expect(scalarWidths('recall')).toEqual(['132px']);
    // 融合 top_k 是标量（132），过滤是三态下拉（140，`按阈值` 才不会被箭头挤）
    expect(scalarWidths('fusion')).toEqual(['132px', '140px']);
    expect(scalarWidths('rerank')).toEqual(['132px']);
    expect(scalarWidths('cut')).toEqual(['132px']);
    // 改写控件比标量宽：选项文案是 `common · 日期展开`，132px 下会被截成 `common · 日期…`
    expect(scalarWidths('rewrite')).toEqual(['200px']);
  });
});
