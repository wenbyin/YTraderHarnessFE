// src/pages/memory_retrieval/components/ResultViews.test.tsx
//
// v2 三个「浏览」视图 + L3 + 汇总 + md 阅读器的钉桩。
//
// 这里守的是 v2 改版之后最容易悄悄退化的几件事（都是"读错不报错"型）：
//
//   1. **L2 列表恒为索引**：卡片里**不许**出现正文，正文只有「点开某张卡」一个入口
//      —— 点了要把 filename 原样交给上层的抽屉。
//   2. **「加载更多」看 `has_more`，不看 `next_cursor`**：契约把两个字段都列了，
//      拿后者当判据在两者不一致时会显示错（这里专门造了"不一致"的两条数据）。
//   3. **筛选改过之后不许再追加**：游标绑死在旧筛选上，按钮要灰掉并说清原因 ——
//      否则会把两套筛选的页拼成一条流，界面上完全看不出来。
//   4. **`/query/l0|l1` 是浏览不是检索**：正文直接显示，**没有** score / matched_by
//      那类召回产物。
//      ⚠️ 但**汇总**的 conversations / facts 两段**是召回命中**（有 score 与
//      matched_by，L0 那边还是截断片段）—— 同一个 "L0" 在两处含义不同，
//      所以两套断言必须分开写，别互相"纠正"。
//   5. **md 文档默认走阅读器**（persona.md / 场景 .md），右上角的切换器**是两个图标**
//      （图片 = 阅读器 / 文本 = 原文，2026-10-12 用户要求），切到「原文」才看得到
//      META 块与源码里的星号 —— 两个方向都要钉住，只钉一边会悄悄退化。
//   6. ⚠️ **汇总的 sections 按 L0 -> L3 升序渲染**（用户 2026-10-12 要求），
//      而 fixture 故意按**后端顺序**（L3 -> L2 -> L0 -> L1）喂进去 —— 不这样造数据，
//      把 `data.sections` 直接 map 出来也会"通过"。
//   7. ⚠️ **L1 / L2 的列表是「卡片网格」**（2026-10-12 用户要求，仿 file 页的网格
//      视图）：一张卡一条记录，卡上缩略、**整张卡可点**把整条记录交给上层。
//      ⚠️ 这里钉的是"卡里有缩略、DOM 里仍是**完整正文**" —— 夹子只影响视觉，
//      把 `content` 先截成半句再渲染是错的（抽屉要的全文就在同一份数据里）。
//      ⚠️ **L0 保持一条一条的消息**（不是网格）：那一层的用途是核对会话原文，
//      切卡片会把"第几条 / 谁说的"挤没。这条是被混一起改坏过的地方。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ConversationHit,
  ConversationRecord,
  FactHit,
  FactRecord,
  L3QueryResponse,
  MemoryRetrievalPrompt,
  Pagination,
  PersonaRecord,
  SceneDetail,
  SceneSummary,
} from '../data';
import type { DocViewMode } from './MarkdownDoc';
import {
  FactDetailBody,
  L0View,
  L1View,
  L2View,
  L3View,
  PromptView,
  SceneDetailBody,
} from './ResultViews';

afterEach(() => {
  cleanup();
});

/**
 * md 阅读器右上角那个切换器（两个**图标**，没有可见文字）。
 *
 * ⚠️ 按文案找元素的写法在这里全部失效（切换器只剩图标，rc-segmented 的 radio 上
 *    也没有 value 属性）。所以只能点挂在图标外面的 `data-doc-mode` 那个 span ——
 *    点它里面的 radio 等效于用户点 label。
 */
const docMode = (mode: DocViewMode): HTMLElement => {
  const icon = document.querySelector(`[data-doc-mode="${mode}"]`);
  if (!icon) throw new Error(`没有切换器图标: ${mode}`);
  return icon.closest('.ant-segmented-item') as HTMLElement;
};

const clickDocMode = (mode: DocViewMode) => {
  const input = docMode(mode).querySelector('input');
  if (!input) throw new Error(`切换项里没有 radio: ${mode}`);
  fireEvent.click(input);
};

const page = (
  next: string | null,
  hasMore: boolean,
  limit = 20,
): Pagination => ({ limit, next_cursor: next, has_more: hasMore });

const SCENE: SceneSummary = {
  filename: '2026-10-01-对账习惯.md',
  summary: '他每个月 1 号对账',
  heat: 7,
  version: 3,
  updated_at: '2026-10-01T09:00:00Z',
};

const SCENE_NO_META: SceneSummary = {
  filename: '2026-09-01-旧场景.md',
  summary: '',
  heat: null,
  version: 1,
  updated_at: '2026-09-01T09:00:00Z',
};

const MESSAGE: ConversationRecord = {
  message_id: 'msg-0000000001',
  session_id: 'sess-000000001',
  seq: 12,
  role: 'user',
  text: '帮我把上季度的对账单整理一下',
  created_at: '2026-10-01T09:00:00Z',
};

const FACT: FactRecord = {
  record_id: 'rec-0000000001',
  content: '喜欢用表格对账，但不能接受自动改数',
  type: 'episodic',
  priority: -1,
  scene_name: '对账习惯',
  version: 2,
  timestamp_str: '2026 年',
  updated_at: '2026-10-02T09:00:00Z',
};

const noop = () => {};

/**
 * 一张卡（按 `data-record-card` 找，**别按文案** —— 卡上的标题/正文都是数据，
 * fixture 一改就找不到）。
 */
const cards = (layer: 'l1' | 'l2'): HTMLElement[] =>
  Array.from(document.querySelectorAll(`[data-record-card="${layer}"]`));

describe('L1 / L2 是卡片网格（仿 file 页的网格视图，不是表格条目）', () => {
  it('L1：每条记忆一张卡，卡上是缩略但 DOM 里仍是**完整正文**', () => {
    render(
      <L1View
        items={[FACT]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    const grid = document.querySelector('[data-memory-grid="l1"]');
    expect(grid).toBeTruthy();
    expect(cards('l1')).toHaveLength(1);
    // ⚠️ 网格之所以要配腔屉，是因为卡里只放得下前几行 —— 但数据不能被真的裁掉
    expect(screen.getByText(FACT.content)).toBeTruthy();
    // 卡上有 type / priority / scene_name 三件事（不全塞进抽屉才叫缩略）
    expect(document.body.textContent).toContain('情景');
    expect(document.body.textContent).toContain('全局死命令 (-1)');
    expect(document.body.textContent).toContain('对账习惯');
  });

  it('L2：每条场景一张卡，卡上只有索引（没有正文）', () => {
    render(
      <L2View
        items={[SCENE, SCENE_NO_META]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(document.querySelector('[data-memory-grid="l2"]')).toBeTruthy();
    expect(cards('l2')).toHaveLength(2);
    // 索引三件套都在
    expect(screen.getByText(SCENE.filename)).toBeTruthy();
    expect(screen.getByText('他每个月 1 号对账')).toBeTruthy();
    expect(screen.getByText('热度 7')).toBeTruthy();
    // ⚠️ 卡里**不许**出现"场景全文"那种像是有正文的说法
    expect(document.body.textContent).not.toContain('场景全文');
  });

  it('⚠️ 卡内是「标题 / 缩略 / 卡脚」三格，标签在**卡脚里**（不再压在标题那一行）', () => {
    render(
      <L1View
        items={[FACT]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    const card = cards('l1')[0];
    // ⚠️ 判"标签挪走了"只能按**结构**判：type / priority 必须是**卡脚的后代**，
    //    而不是卡片的第一格。2026-10-12 之前它们在右上角绝对定位，标题为了避让
    //    写了 padding-right —— 结果标题只剩半行（用户拿截图指出）。
    const title = card.children[0];
    const footer = card.lastElementChild as HTMLElement;
    expect(card.children).toHaveLength(3);
    expect(title.querySelector('.ant-tag')).toBeNull();
    expect(footer.querySelector('.ant-tag')).not.toBeNull();
    expect(
      Array.from(footer.querySelectorAll('.ant-tag')).map((t) => t.textContent),
    ).toEqual(['情景', '全局死命令 (-1)']);
    // 标识那组还在卡脚左侧（record_id + 版本号）
    expect(footer.textContent).toContain('v2');
  });

  it('⚠️ L2 同构：filename 标题 + summary 缩略 + 卡脚（时间在左、heat/v 在右）', () => {
    render(
      <L2View
        items={[SCENE]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    const card = cards('l2')[0];
    const footer = card.lastElementChild as HTMLElement;
    expect(card.children).toHaveLength(3);
    expect(card.children[0].textContent).toContain(SCENE.filename);
    expect(card.children[0].querySelector('.ant-tag')).toBeNull();
    expect(
      Array.from(footer.querySelectorAll('.ant-tag')).map((t) => t.textContent),
    ).toEqual(['热度 7', 'v3']);
    // 整卡可点的语义没丢：button + 说清点它会怎样
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('aria-label')).toContain(SCENE.filename);
  });

  it('⚠️ 点整张卡把**整条记录**交给上层（抽屉要它拉全文 / 直接显示）', () => {
    const onOpenFull = vi.fn();
    render(
      <L2View
        items={[SCENE, SCENE_NO_META]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={onOpenFull}
      />,
    );

    fireEvent.click(cards('l2')[0]);
    expect(onOpenFull).toHaveBeenCalledWith(SCENE);
  });

  /*
   * ⚠️ 断言的是"它真的就是 button"，**不是**模拟按键 —— happy-dom 不会像真浏览器那样
   *    在 Enter / 空格上合成 click，`fireEvent.keyDown` 打了也是 0 次回调。
   *    键盘能用这件事实由 **元素类型** 保证（原生 button 才免费拿到 Enter/空格与读屏
   *    语义；`div + role` 那条路要自己补 onKeyDown，漏一次就是"只能鼠标点"）。
   */
  it('⚠️ 卡本身是 `<button>`（键盘与读屏是原生拿到的，不是 div+role 手搓）', () => {
    render(
      <L1View
        items={[FACT]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    const card = cards('l1')[0];
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('type')).toBe('button');
  });

  it('⚠️ L0 **没有**被改成网格（那一层的用途是按时间核对原文）', () => {
    render(
      <L0View
        items={[MESSAGE]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
      />,
    );

    expect(document.querySelector('[data-memory-grid]')).toBeNull();
    expect(document.querySelectorAll('[data-record-card]')).toHaveLength(0);
    expect(screen.getByText(MESSAGE.text)).toBeTruthy();
  });
});

describe('L2View（列表恒为索引）', () => {
  it('渲染 filename / summary / heat，并**不出正文**（正文只有点开卡看的抽屉）', () => {
    render(
      <L2View
        items={[SCENE]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(screen.getByText(SCENE.filename)).toBeTruthy();
    expect(screen.getByText('他每个月 1 号对账')).toBeTruthy();
    expect(screen.getByText('热度 7')).toBeTruthy();
    // 这段正文只存在于 SceneDetail 里；列表不该有任何"场景全文"的字样
    expect(document.body.textContent).not.toContain('场景全文');
  });

  it('summary 是空串时说的是"没写 META"，heat 是 null 时说的是"未知"（都不是 0）', () => {
    render(
      <L2View
        items={[SCENE_NO_META]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(document.body.textContent).toContain('没有摘要');
    expect(screen.getByText('热度未知')).toBeTruthy();
  });
});

describe('加载更多（看 has_more，不看 next_cursor）', () => {
  it('has_more 为真 -> 有按钮；点了会回调，并显示"还有下一页"', () => {
    const onLoadMore = vi.fn();
    render(
      <L2View
        items={[SCENE]}
        page={page('cursor-2', true)}
        loadingMore={false}
        onLoadMore={onLoadMore}
        onOpenFull={noop}
      />,
    );

    expect(screen.getByText('本页 1 条 · 还有下一页')).toBeTruthy();
    fireEvent.click(screen.getByText('加载更多'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('has_more 为假 -> 没有按钮，并说"已到最后一页"', () => {
    render(
      <L2View
        items={[SCENE]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(screen.getByText('本页 1 条 · 已到最后一页')).toBeTruthy();
    expect(screen.queryByText('加载更多')).toBeNull();
  });

  it('⚠️ next_cursor 还在、但 has_more 已经为假 -> **不显示**按钮（反过来的判据会显示错）', () => {
    render(
      <L2View
        items={[SCENE]}
        page={page('cursor-2', false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(screen.queryByText('加载更多')).toBeNull();
    expect(screen.getByText('本页 1 条 · 已到最后一页')).toBeTruthy();
  });

  it('⚠️ has_more 为真但 next_cursor 是 null -> 仍然显示按钮（判据是 has_more）', () => {
    render(
      <L2View
        items={[SCENE]}
        page={page(null, true)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(screen.getByText('加载更多')).toBeTruthy();
  });

  it('⚠️ 筛选改过（stale）-> 按钮禁用，并写清"先重新执行"', () => {
    const onLoadMore = vi.fn();
    render(
      <L2View
        items={[SCENE]}
        page={page('cursor-2', true)}
        loadingMore={false}
        onLoadMore={onLoadMore}
        onOpenFull={noop}
        stale
      />,
    );

    const button = screen.getByText('加载更多').closest('button');
    expect(button?.disabled).toBe(true);
    expect(document.body.textContent).toContain('筛选改过了');
    fireEvent.click(screen.getByText('加载更多'));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('还没执行（page 是 null）-> 一条流都没有，也不画页脚', () => {
    render(
      <L2View
        items={[]}
        page={null}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(screen.queryByText('加载更多')).toBeNull();
    expect(document.body.textContent).not.toContain('本页');
  });
});

describe('L0View / L1View（浏览，不是检索）', () => {
  it('L0 显示完整正文与 message_id / session_id / 角色 / seq', () => {
    render(
      <L0View
        items={[MESSAGE]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
      />,
    );

    expect(screen.getByText(MESSAGE.text)).toBeTruthy();
    expect(screen.getByText('用户')).toBeTruthy();
    expect(screen.getByText('seq 12')).toBeTruthy();
    expect(document.body.textContent).toContain('message_id');
    expect(document.body.textContent).toContain('session_id');
    // v2 没有召回产物 —— 界面上不该再出现"命中片段 / score"那套说法
    expect(document.body.textContent).not.toContain('命中的是');
  });

  /*
   * ⚠️ 「不参与排序」那句解释跟着 full body 走了 —— 卡上放不下（也不能每��卡都挂
   *    一个 tooltip），它现在只出现在点开之后那个抽屉里，见下面 FactDetailBody 的用例。
   */
  it('L1：priority = -1 的"全局死命令"在卡上就看得到', () => {
    render(
      <L1View
        items={[FACT]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(screen.getByText('全局死命令 (-1)')).toBeTruthy();
    expect(screen.getByText(FACT.content)).toBeTruthy();
    expect(document.body.textContent).toContain('对账习惯');
  });

  it('空列表说的是"没有记录"（正常结果），不是错误', () => {
    render(
      <L1View
        items={[]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(document.body.textContent).toContain('正常结果');
  });

  it('⚠️ FactDetailBody（抽屉里的全文）才解释"为什么不参与排序"', () => {
    render(<FactDetailBody record={FACT} />);

    expect(screen.getByText(FACT.content)).toBeTruthy();
    expect(document.body.textContent).toContain('不参与排序');
    expect(document.body.textContent).toContain('2026 年');
    // 浏览端点没有召回产物 —— 抽屉里也不许出现 score
    expect(document.body.textContent).not.toContain('score');
  });
});

describe('L0 消息正文：默认只显示 3 行，点「展开全部」看全文', () => {
  /*
   * ⚠️ happy-dom **不做真实排版**，`scrollHeight` / `clientHeight` 恒为 0 →
   *    组件里那句"要不要给开关"永远量不出来，两个分支都测不到。
   *    所以这里**替身这两个高度**，把两个分支都覆盖到；
   *    「真实三行到底是几像素、夹子有没有真的生效」交给浏览器探针量（量几何，别猜）。
   */
  const realScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight',
  );
  const realClient = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight',
  );

  const stubHeights = (scroll: number, client: number) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => scroll,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => client,
    });
  };

  afterEach(() => {
    if (realScroll) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', realScroll);
    }
    if (realClient) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', realClient);
    }
  });

  /** 那个「展开全部 / 收起」的开关（按 data 属性找，别按文案 —— 文案会变）。 */
  const toggle = (): HTMLElement | null =>
    document.querySelector('[data-clamp-toggle]');
  /** 被夹住的正文壳体。 */
  const box = (): HTMLElement => {
    const el = document.querySelector('[data-clamped]');
    if (!el) throw new Error('没有正文壳体');
    return el as HTMLElement;
  };

  const renderL0 = (item: ConversationRecord) =>
    render(
      <L0View
        items={[item]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
      />,
    );

  it('⚠️ 超 3 行才有开关；点开是全文、再点收回（开关不会自己消失）', () => {
    stubHeights(240, 66); // 240 > 66 + 1 → 溢出
    renderL0(MESSAGE);

    expect(toggle()).toBeTruthy();
    expect(toggle()?.textContent).toContain('展开全部');
    expect(toggle()?.getAttribute('data-clamp-toggle')).toBe('expand');
    expect(box().getAttribute('data-clamped')).toBe('clamped');
    // 收起态：3 行的夹子真的挂在元素上
    // ⚠️ 只能断言这个 data 属性 —— happy-dom 不序列化 `-webkit-line-clamp`
    //    （`style` 属性里读不到）。"真的夹成 3 行高"由探针在真浏览器里量几何来证。
    expect(box().getAttribute('data-clamp-lines')).toBe('3');

    fireEvent.click(toggle() as HTMLElement);
    expect(box().getAttribute('data-clamped')).toBe('open');
    expect(toggle()?.textContent).toContain('收起');
    expect(toggle()?.getAttribute('data-clamp-toggle')).toBe('collapse');
    // ⚠️ 展开后**不许**重新量：一量就是"不溢出" → 开关自己消失、再也收不回去
    expect(toggle()).toBeTruthy();
    // 夹子必须整组撤掉（含 display 从 -webkit-box 还原）
    expect(box().getAttribute('data-clamp-lines')).toBeNull();

    fireEvent.click(toggle() as HTMLElement);
    expect(box().getAttribute('data-clamped')).toBe('clamped');
    expect(toggle()?.textContent).toContain('展开全部');
  });

  it('短消息（量出来不溢出）**不给**开关 —— 免得每条都挂个没用的按钮', () => {
    stubHeights(60, 66); // 不溢出
    renderL0(MESSAGE);

    expect(toggle()).toBeNull();
    // 正文照样完整在 DOM 里（夹子只影响视觉，不影响取到的文本）
    expect(screen.getByText(MESSAGE.text)).toBeTruthy();
  });

  /*
   * ⚠️ 那个「展开全部 / 收起」的开关只有 L0 有：用户只要求 L0 消息原文默认三行。
   *    L1 的卡是被 CSS 夹成 3 行的，**没有**开关 —— 要多看就点开抽屉。
   */
  it('⚠️ L1 与召回命中的正文**没有展开开关**（只有 L0 消息原文有）', () => {
    stubHeights(240, 66); // 就算量出来溢出，L1 也不该有开关
    render(
      <L1View
        items={[FACT]}
        page={page(null, false)}
        loadingMore={false}
        onLoadMore={noop}
        onOpenFull={noop}
      />,
    );

    expect(toggle()).toBeNull();
    expect(document.querySelector('[data-clamped]')).toBeNull();
    expect(screen.getByText(FACT.content)).toBeTruthy();
  });
});

describe('md 阅读器（persona.md / 场景 .md 的正文）', () => {
  const scene: SceneDetail = {
    ...SCENE,
    content:
      '<!-- META heat: 7 -->\n# 对账习惯\n\n他**每个月 1 号**对账。\n\n- 只用表格\n- 不接受自动改数',
  };

  it('默认阅读器模式：解析 md（星号不露出来、META 注释看不到）', () => {
    render(<SceneDetailBody scene={scene} />);

    expect(document.body.textContent).toContain('对账习惯');
    expect(document.body.textContent).toContain('不接受自动改数');
    // 解析过 → 源码里的 ** 不该出现在页面上（JSX 星号那个坑的反向）
    expect(document.body.textContent).not.toContain('**');
    // META 是 HTML 注释：阅读器模式下它被吃掉，只有原文看得到
    expect(document.body.textContent).not.toContain('META');
  });

  it('切「原文」→ 回到 pre-wrap 原样：META 块与星号都看得见', () => {
    render(<SceneDetailBody scene={scene} />);

    clickDocMode('raw');

    expect(document.body.textContent).toContain('META');
    expect(document.body.textContent).toContain('**每个月 1 号**');
  });

  it('⚠️ 切换器是**图标**（没有可见文字），两个档位各带一个 aria-label', () => {
    render(<SceneDetailBody scene={scene} />);

    // 图标模式：item 里只有 svg，没有文字 —— 这是用户要的"改图图标"
    for (const mode of ['reader', 'raw'] as DocViewMode[]) {
      const item = docMode(mode);
      expect(item.textContent).toBe('');
      expect(item.querySelector('.anticon')).toBeTruthy();
    }
    // 没有可见文字就不能连名字也丢掉：读屏只读得到 aria-label
    expect(
      docMode('reader').querySelector('[aria-label="阅读器模式"]'),
    ).toBeTruthy();
    expect(docMode('raw').querySelector('[aria-label="原文"]')).toBeTruthy();
  });

  it('切换是双向的：原文 → 阅读器，META 又被吃掉', () => {
    render(<SceneDetailBody scene={scene} />);

    clickDocMode('raw');
    expect(document.body.textContent).toContain('META');
    clickDocMode('reader');
    expect(document.body.textContent).not.toContain('META');
    expect(document.body.textContent).not.toContain('**');
  });
});

describe('L3View', () => {
  it('L3：persona 为 null 是"还没生成过"（正常状态，不是 404）', () => {
    const data: L3QueryResponse = { scope_kind: 'user', persona: null };
    render(<L3View data={data} />);

    expect(document.body.textContent).toContain('正常状态');
    expect(document.body.textContent).toContain('不是 404');
  });

  it('L3：有画像时渲染整篇（不截断），并把 persona.md 交给阅读器', () => {
    const data: L3QueryResponse = {
      scope_kind: 'user',
      persona: {
        content: '<!-- META -->\n# 画像\n他是一个谨慎的人',
        filename: 'persona.md',
        version: 4,
        updated_at: '2026-10-03T09:00:00Z',
      },
    };
    render(<L3View data={data} />);

    expect(document.body.textContent).toContain('他是一个谨慎的人');
    expect(document.body.textContent).toContain('version 4');
    // 这份正文是 md 文档 → 走阅读器（右上角那个图标切换器在），不是裸的 pre-wrap
    expect(docMode('reader')).toBeTruthy();
    expect(docMode('raw')).toBeTruthy();
  });

  /*
   * 2026-10-17 用户：「去掉 md 编辑器嵌套，只留内层编辑器」。
   *
   * 原来的形态是：灰底 `recordItem` 卡 → 一条「persona.md + version + 时间」的头
   * → 里面才是编辑器（它自己那条栏又写了一遍 persona.md）。所以这里钉三件事：
   *   1. 文件名只出现**一次**（两次就是"套娃"回来了）；
   *   2. 整块只有**一层**面板，且它就是渲染树的第一层（外面不能再包壳）；
   *   3. 版本号不能被顺手删掉 —— 去嵌套不等于丢信息。
   */
  it('⚠️ 只有一层编辑器：文件名只出现一次，外面不再套卡片', () => {
    const data: L3QueryResponse = {
      scope_kind: 'user',
      persona: {
        content: '<!-- META -->\n# 画像\n他是一个谨慎的人',
        filename: 'persona.md',
        version: 4,
        updated_at: '2026-10-03T09:00:00Z',
      },
    };
    const { container } = render(<L3View data={data} />);

    expect(screen.getAllByText('persona.md')).toHaveLength(1);
    expect(container.querySelectorAll('[data-md-doc]')).toHaveLength(1);
    // 那唯一一层就是根节点本身 → 没有外层 recordItem 包着
    expect(container.firstElementChild?.hasAttribute('data-md-doc')).toBe(true);
    expect(document.body.textContent).toContain('version 4');
  });
});

describe('PromptView（汇总）', () => {
  const base: MemoryRetrievalPrompt = {
    retrieval_id: 'ret-0000000001',
    input: '帮我把上季度的对账单整理一下',
    target: { user_id: 'u-1', agent_id: 'duty-1' },
    scope_kind: 'user',
    sections: [],
    degraded: [],
    prompt: { system: null, user: '拼好的用户消息' },
    generated_at: '2026-10-05T09:00:00Z',
  };

  /** L0 命中（`text` 是**截断片段**，带 score 与 matched_by）。 */
  const CONV_HIT: ConversationHit = {
    message_id: 'm-0001',
    session_id: 's-0001',
    seq: 12,
    role: 'user',
    text: '我每个月一号都要把上个月的对账单收一遍…',
    created_at: '2026-10-01T09:00:00Z',
    score: 0.8412,
    matched_by: ['keyword', 'vector'],
  };

  /** L1 命中（`content` **不截断**）。 */
  const FACT_HIT: FactHit = {
    record_id: 'r-0001',
    content: '他偏好每月 1 号对账，且不接受跨月补记。',
    type: 'episodic',
    priority: 3,
    scene_name: '对账习惯',
    score: 0.7123,
    matched_by: ['vector'],
  };

  const PERSONA_ITEM: PersonaRecord = {
    content: '# 画像\n他是一个谨慎的人',
    filename: 'persona.md',
    version: 4,
    updated_at: '2026-10-03T09:00:00Z',
  };

  it('input 是必填的，直接显示本轮输入（不再是 v2.0.0 的 null 回显）', () => {
    render(<PromptView data={base} />);
    expect(document.body.textContent).toContain('帮我把上季度的对账单整理一下');
    expect(document.body.textContent).not.toContain('null · 本次没给');
  });

  it('degraded 里的层必须如实报出来（静默少一段会被读成"这个人没有画像"）', () => {
    render(
      <PromptView
        data={{
          ...base,
          degraded: [{ layer: 'l3', reason: 'persona 表还没接线' }],
        }}
      />,
    );

    expect(document.body.textContent).toContain('1 层未参与本次组装');
    expect(document.body.textContent).toContain('persona 表还没接线');
  });

  it('sections 为空时说清两种可能（一段都没要 / 都取不到）', () => {
    render(<PromptView data={base} />);
    expect(document.body.textContent).toContain('一段都没要');
  });

  it('⚠️ 段落按 L0 -> L3 升序渲染（后端给的是 prompt 顺序，前端必须重排）', () => {
    render(
      <PromptView
        data={{
          ...base,
          // ⚠️ 故意按**后端顺序**给（L3 -> L2 -> L0 -> L1）
          sections: [
            {
              block: 'persona',
              layer: 'l3',
              title: '画像',
              returned: 1,
              truncated: false,
              items: [PERSONA_ITEM],
            },
            {
              block: 'scenes',
              layer: 'l2',
              title: '场景索引',
              returned: 1,
              truncated: false,
              items: [SCENE],
            },
            {
              block: 'conversations',
              layer: 'l0',
              title: 'L0 命中',
              returned: 1,
              degraded_routes: [],
              items: [CONV_HIT],
            },
            {
              block: 'facts',
              layer: 'l1',
              title: 'L1 命中',
              returned: 1,
              degraded_routes: [],
              items: [FACT_HIT],
            },
          ],
        }}
      />,
    );

    // 四个 block 的 Tag 在 DOM 里出现的先后 = 渲染顺序。它必须是 L0 -> L3。
    const order = Array.from(document.querySelectorAll('.ant-tag'))
      .map((el) => el.textContent ?? '')
      .filter((t) =>
        ['conversations', 'facts', 'scenes', 'persona'].includes(t),
      );
    expect(order).toEqual(['conversations', 'facts', 'scenes', 'persona']);
    // 层号也一并显示，让升序这件事在界面上一眼可读
    expect(document.body.textContent).toContain('L0');
    expect(document.body.textContent).toContain('L3');
  });

  it('⚠️ conversations 段是**召回命中**：要显示 score 与 matched_by（与浏览视图不同）', () => {
    render(
      <PromptView
        data={{
          ...base,
          sections: [
            {
              block: 'conversations',
              layer: 'l0',
              title: 'L0 命中',
              returned: 1,
              degraded_routes: [],
              items: [CONV_HIT],
            },
          ],
        }}
      />,
    );

    expect(document.body.textContent).toContain('score 0.8412');
    expect(document.body.textContent).toContain('关键词路');
    expect(document.body.textContent).toContain('向量路');
    expect(screen.getByText(CONV_HIT.text)).toBeTruthy();
    // 召回段没有 truncated 字段 —— 不许显示"未截断"那枚 Tag
    expect(document.body.textContent).not.toContain('未截断');
  });

  it('⚠️ facts 段同样带 score / matched_by，且正文不截断', () => {
    render(
      <PromptView
        data={{
          ...base,
          sections: [
            {
              block: 'facts',
              layer: 'l1',
              title: 'L1 命中',
              returned: 1,
              degraded_routes: [],
              items: [FACT_HIT],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(FACT_HIT.content)).toBeTruthy();
    expect(document.body.textContent).toContain('score 0.7123');
    expect(document.body.textContent).toContain('场景 对账习惯');
  });

  it('⚠️ persona / scenes 段仍然显示"截断"状态（它们才有 truncated）', () => {
    render(
      <PromptView
        data={{
          ...base,
          sections: [
            {
              block: 'scenes',
              layer: 'l2',
              title: '场景索引',
              returned: 1,
              truncated: true,
              items: [SCENE],
            },
          ],
        }}
      />,
    );

    expect(document.body.textContent).toContain('已截断');
  });

  it('⚠️ 段内的 degraded_routes（某一路没跑成）要显示，且与顶层 degraded 分开说', () => {
    render(
      <PromptView
        data={{
          ...base,
          sections: [
            {
              block: 'facts',
              layer: 'l1',
              title: 'L1 命中',
              returned: 0,
              degraded_routes: [{ route: 'vector', reason: 'Milvus 超时' }],
              items: [],
            },
          ],
        }}
      />,
    );

    expect(document.body.textContent).toContain('向量路没跑成');
    expect(document.body.textContent).toContain('Milvus 超时');
    // 顶层 degraded 是空的 —— 界面上不该把它说成"整层没跑成"
    expect(document.body.textContent).toContain('不是整层缺失');
  });

  it('召回段"要了但没命中"的文案与浏览段分开（那是"这次没命中"）', () => {
    render(
      <PromptView
        data={{
          ...base,
          sections: [
            {
              block: 'conversations',
              layer: 'l0',
              title: 'L0 命中',
              returned: 0,
              degraded_routes: [],
              items: [],
            },
          ],
        }}
      />,
    );

    expect(document.body.textContent).toContain('召回真跑了');
  });
});
