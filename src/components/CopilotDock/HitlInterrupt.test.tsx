// src/components/CopilotDock/HitlInterrupt.test.tsx
//
// 审批卡片的两层分开测：
//   ① **纯函数**（resolveVariant / readOptions / optionLabel / formatArguments）
//      —— 它们决定"这批中断按哪种形状渲染"，是唯一的分叉逻辑，值得逐条钉；
//   ② **卡片本体**（HitlCard）—— 喂中断数据进去，断言界面上该有的按钮
//      （以及**不该有**的按钮）与点下去回传的形状。
//
// HitlInterrupt 那个外壳（真正调 useInterrupt 的那层）在本文件里用 mock 覆盖：
// 真 hook 要一个真的 CopilotKit provider，而它内部还会去连 runtime ——
// 对一个"渲染位置对不对"的问题，那个代价不值得。它要钉的两条（没有待办就不渲染、
// 卡片由我们自己挂）在下面用假 hook 就能测到。

import type {
  Interrupt,
  InterruptRenderProps,
  UseInterruptConfig,
} from '@copilotkit/react-core/v2/headless';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { createIntl, IntlContext } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhToolCall from '../../locales/zh-CN/toolCall';
import HitlInterrupt, {
  approvalDeadline,
  formatArguments,
  formatRemaining,
  HitlCard,
  optionLabel,
  readOptions,
  resolveVariant,
} from './HitlInterrupt';
import { setHitlPending, useHitlPending } from './hitlSignal';

/**
 * 跨 mock 边界共享的把手（vi.mock 会被提升到 import 之上，必须走 vi.hoisted）。
 */
const runtime = vi.hoisted(() => ({
  /** useInterrupt 返回给我们的元素（renderInChat: false 时的返回值）。 */
  element: null as ReactNode,
  /** useInterrupt 收到的配置，用来断言 renderInChat 是 false。 */
  config: null as {
    renderInChat?: boolean;
    render?: (props: InterruptRenderProps) => ReactNode;
  } | null,
}));

vi.mock('@copilotkit/react-core/v2/headless', () => ({
  useInterrupt: (config: UseInterruptConfig) => {
    runtime.config = config as NonNullable<typeof runtime.config>;
    return runtime.element;
  },
}));

const APPROVAL_OPTIONS = ['approve', 'reject', 'always'];

/** 造一个中断。默认是"审批"，over 用来换成别的形状。 */
const makeInterrupt = (over: Partial<Interrupt> = {}): Interrupt => ({
  id: 'int-1',
  reason: 'tool_approval',
  message: '是否允许执行该工具调用？',
  responseSchema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: APPROVAL_OPTIONS },
    },
    required: ['decision'],
  },
  metadata: {
    toolKey: 'agent.platform.describe_platform',
    arguments: { tool_limit: 20 },
    options: APPROVAL_OPTIONS,
    runId: 'run-1',
  },
  ...over,
});

/** 渲染卡片，返回两个回传口的桩。 */
const renderCard = ({
  interrupt = makeInterrupt(),
  interrupts = [] as Interrupt[],
  resolve = vi.fn(),
} = {}) => {
  const cancel = vi.fn();
  const card = (
    <HitlCard
      event={{ name: 'on_interrupt', value: interrupt }}
      interrupt={interrupt}
      interrupts={interrupts}
      result={undefined}
      resolve={resolve as InterruptRenderProps['resolve']}
      cancel={cancel as InterruptRenderProps['cancel']}
    />
  );
  /*
   * ⚠️ 挂**真的那份中文语言包**，不裸渲染
   * ------------------------------------
   *   标题行印的是工具名的人话（toolLabels → toolCall.*），
   *   裸渲染时（没有 Provider）名字回落到**原值** —— 那正好与卡片正文里
   *   那个原值 Tag 撞成两份同样的文字（`getByText` 直接报 multiple elements）。
   *   这里要测的是产品真实渲染，所以挂上语言包。
   *   ⚠️ 用 `IntlContext.Provider` 而不是 `<IntlProvider>`：后者在 React 18 的
   *   JSX 类型里不接受 children（同 toolLabels.test.tsx）。
   */
  const view = render(
    <IntlContext.Provider
      value={createIntl({ locale: 'zh-CN', messages: zhToolCall })}
    >
      {card}
    </IntlContext.Provider>,
  );
  return { ...view, resolve, cancel };
};

/**
 * 按**可见文字**找按钮（比对了文字，不看无障碍名）。
 *
 * ⚠️ 为什么不直接用 `getByRole('button', { name: '允许' })` —— 两个 antd 行为
 *    都会改写无障碍名称，实测（把按钮 DOM 打出来看过）：
 *
 *      · 空闲态：`允 许` —— antd Button 默认 `autoInsertSpace: true`，会给
 *        **正好两个汉字**的 label 中间插一个空格（项目 src 里没有任何地方关过它，
 *        生产环境渲染出来就是这样）。testing-library 只折叠首尾与连续空白，
 *        **不会**删掉中间那个空格，所以严格匹配不上；
 *      · loading 态：`loading 允 许` —— 提交中 antd 会插一个
 *        `<span role="img" aria-label="loading">` 转圈图标，把 "loading"
 *        也拼进了无障碍名称。
 *
 *    这两件事都不该由组件来改（前者是中文排版的既定行为，后者是 antd 的加载反馈），
 *    所以改的是断言口径：**比用户眼睛看到的那段文字**，两边都抹掉空白再比。
 *    4 字的「始终允许」、6 字的「取消这次操作」不受第一个行为影响，但走同一条路径
 *    更省心。
 *
 * ⚠️ 还有一条（2026-10-23）：**直接查 DOM，不走 a11y 过滤**
 * ------------------------------------------------------
 *   卡片提交后会把内容折进标题行（`visibility: hidden`），那一刻按钮**退出
 *   无障碍树**—— `queryAllByRole` 就再也找不到它们了。但"折叠后别的按钮是不是
 *   置灰/转圈"仍然要断言（DOM 里的事实）。a11y 那件事单独钉，见
 *   「折叠后控件退出无障碍树」那条用例 —— 两者混在一个选择器里只会互相干扰。
 */
const allButtons = () => Array.from(document.querySelectorAll('button'));

const byLabel = (name: string) =>
  allButtons().find(
    (el) => (el.textContent ?? '').replace(/\s+/g, '') === name,
  );

const button = (name: string) => {
  const el = byLabel(name);
  if (!el) {
    const seen = allButtons()
      .map((b) => (b.textContent ?? '').trim() || '(空)')
      .join(' / ');
    throw new Error(`找不到可见文字为「${name}」的按钮。当前有：${seen}`);
  }
  return el as HTMLButtonElement;
};

/**
 * 「这个按钮**不该**在」也要走同一套匹配。
 * 裸写 `queryByRole('button', { name: '允许' })` 匹配不上 `允 许`，永远返回 null ——
 * 一条本意是"别多画按钮"的断言会变成永远通过的摆设。假绿比红更危险。
 */
const noButton = (name: string) => byLabel(name) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  runtime.element = null;
  runtime.config = null;
  // hitlSignal 是**模块级**状态（见它的文件头），不主动复位会串到下一个用例
  setHitlPending(false);
});

afterEach(() => {
  cleanup();
  // 倒计时那组用例会开**假时钟**。不复位就会串到后面 —— 假时钟下 `Date.now()`
  // 停在设的那个时刻，别的用例会莫名其妙地看到"已超过"。
  vi.useRealTimers();
});

// ============================================================
// 纯函数：形状判定
// ============================================================

describe('readOptions', () => {
  it('优先读 responseSchema 里的枚举 —— 那是协议里唯一有约束力的位置', () => {
    expect(readOptions(makeInterrupt())).toEqual(APPROVAL_OPTIONS);
  });

  it('schema 缺了退到 metadata.options（两个来源都不该让按钮消失）', () => {
    const interrupt = makeInterrupt({
      responseSchema: undefined,
      metadata: { options: ['approve', 'reject'] },
    });
    expect(readOptions(interrupt)).toEqual(['approve', 'reject']);
  });

  it('两边都没有就是空 —— 不是"默认给三个按钮"', () => {
    expect(
      readOptions(makeInterrupt({ responseSchema: undefined, metadata: {} })),
    ).toEqual([]);
    expect(readOptions(null)).toEqual([]);
  });

  it('枚举里的非字符串一律滤掉，不让它变成一个渲染不出来的按钮', () => {
    const interrupt = makeInterrupt({
      responseSchema: {
        properties: { decision: { enum: ['approve', 42, null, 'reject'] } },
      },
    });
    expect(readOptions(interrupt)).toEqual(['approve', 'reject']);
  });
});

describe('resolveVariant（唯一的分叉点）', () => {
  it('值域就是审批那三个 → approval', () => {
    expect(resolveVariant(makeInterrupt())).toBe('approval');
  });

  it('只有两项也是 approval（工具没开 always_allowed 的情况）', () => {
    const interrupt = makeInterrupt({
      metadata: { options: ['approve', 'reject'] },
      responseSchema: {
        properties: { decision: { enum: ['approve', 'reject'] } },
      },
    });
    expect(resolveVariant(interrupt)).toBe('approval');
  });

  it('有枚举但不是审批那三个 → options（"具体的问题选项"那一类）', () => {
    const interrupt = makeInterrupt({
      reason: 'question',
      metadata: {},
      responseSchema: {
        properties: { decision: { enum: ['股票', '基金', '债券'] } },
      },
    });
    expect(resolveVariant(interrupt)).toBe('options');
  });

  it('读不出值域 → unknown（宁可露出原始信息，也不要白屏）', () => {
    expect(
      resolveVariant(
        makeInterrupt({ responseSchema: undefined, metadata: {} }),
      ),
    ).toBe('unknown');
    expect(resolveVariant(null)).toBe('unknown');
  });
});

describe('optionLabel', () => {
  it('审批那三个用固定词表', () => {
    expect(optionLabel('approve')).toBe('允许');
    expect(optionLabel('reject')).toBe('拒绝');
    expect(optionLabel('always')).toBe('始终允许');
  });

  it('别的值原样显示 —— 不知道语义就翻译，等于编', () => {
    expect(optionLabel('股票')).toBe('股票');
    expect(optionLabel('parent_child')).toBe('parent_child');
  });
});

describe('formatArguments', () => {
  it('对象渲染成缩进 JSON', () => {
    expect(formatArguments({ tool_limit: 20 })).toContain('"tool_limit": 20');
  });

  it('空的 / 非对象的不算"有参数"（免得画一个空框）', () => {
    expect(formatArguments({})).toBe('');
    expect(formatArguments(null)).toBe('');
    expect(formatArguments('nope')).toBe('');
    expect(formatArguments(undefined)).toBe('');
  });
});

// ============================================================
// 卡片本体
// ============================================================

describe('审批形状的卡片', () => {
  it('按 options 画按钮，文字用审批词表', () => {
    renderCard();

    expect(button('允许')).toBeTruthy();
    expect(button('拒绝')).toBeTruthy();
    expect(button('始终允许')).toBeTruthy();
    // 后端给的那句话要出现（它是这张卡的主语）
    expect(screen.getByText('是否允许执行该工具调用？')).toBeTruthy();
  });

  it('⭐ 没有 always 就不画「始终允许」—— 按钮列表由**后端配置**决定，不由前端猜', () => {
    // 这是本节最要紧的一条：多画一个就等于多开一条绕过工具风险策略的路。
    const interrupt = makeInterrupt({
      responseSchema: {
        properties: { decision: { enum: ['approve', 'reject'] } },
      },
      metadata: {
        toolKey: 'a.b',
        options: ['approve', 'reject'],
      },
    });
    renderCard({ interrupt });

    expect(button('允许')).toBeTruthy();
    expect(button('拒绝')).toBeTruthy();
    expect(noButton('始终允许')).toBeNull();
    // 而且要说清"这个工具每次都问"，不是静默少一个按钮
    expect(screen.getByText(/没有开启「始终允许」/)).toBeTruthy();
  });

  it('把"批的是什么"摊开：工具名与参数（不给参数就是让人盲批）', () => {
    renderCard();

    expect(screen.getByText('agent.platform.describe_platform')).toBeTruthy();
    expect(screen.getByText(/"tool_limit": 20/)).toBeTruthy();
  });

  it('点「允许」→ resolve({ decision: "approve" }, interruptId)', async () => {
    // ⚠️ 第二个参数是**目标中断的 id**，不是可有可无的装饰：库的 resolve 不传 id 时
    //   会警告并默认第一条（headless.cjs 949 行）—— 一组里有两条时，第二条就永远
    //   答不上（整组卡在 waiting，最后一条答不完，永远不会上报）。
    const { resolve } = renderCard();

    fireEvent.click(button('允许'));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ decision: 'approve' }, 'int-1'),
    );
  });

  it('点「始终允许」→ resolve({ decision: "always" })（原值，不翻译成中文再传）', async () => {
    const { resolve } = renderCard();

    fireEvent.click(button('始终允许'));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ decision: 'always' }, 'int-1'),
    );
  });

  it('⭐ 提交期间连点不会提交两次（第二个请求会撞 409，用户看到一条莫名其妙的报错）', async () => {
    // 故意返回一个永不 settle 的 promise，模拟"请求在飞"
    const resolve = vi.fn().mockReturnValue(new Promise(() => {}));
    renderCard({ resolve });

    fireEvent.click(button('允许'));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

    fireEvent.click(button('拒绝'));
    fireEvent.click(button('允许'));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ decision: 'approve' }, 'int-1');
  });

  it('⭐ 只有被点的那颗转圈，其余只置灰 —— 两颗一起转看着像两个请求都在飞', async () => {
    // 这条照着实测的 DOM 写：antd 的 loading 会给按钮插一个
    // `role="img" aria-label="loading"` 的图标，所以"谁在转圈"直接看 antd 的
    // loading class，不去解析（已经被改写的）无障碍名称。
    const resolve = vi.fn().mockReturnValue(new Promise(() => {}));
    renderCard({ resolve });

    fireEvent.click(button('允许'));

    await waitFor(() =>
      expect(button('允许').classList.contains('ant-btn-loading')).toBe(true),
    );
    expect(button('拒绝').classList.contains('ant-btn-loading')).toBe(false);
    expect(button('始终允许').classList.contains('ant-btn-loading')).toBe(
      false,
    );
    // 锁住但看得见：另一颗是"变灰"，不是"也转圈"也不是消失
    expect(button('拒绝').disabled).toBe(true);
    expect(button('始终允许').disabled).toBe(true);
  });

  it('提交失败后按钮能再点 —— 让人能重试或改选', async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    renderCard({ resolve });

    fireEvent.click(button('允许'));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

    // 失败后放开；再点一次要真的再发一次
    await waitFor(() => expect(button('允许').disabled).toBe(false));
    fireEvent.click(button('拒绝'));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(resolve).toHaveBeenLastCalledWith({ decision: 'reject' }, 'int-1');
  });

  it('说明「始终允许」只在本轮运行内生效 —— 不说清会以为是永久设置', () => {
    renderCard();
    expect(screen.getByText(/只在本次对话的这一轮运行内/)).toBeTruthy();
  });

  it('⭐ 一组两条：一次只显示一条，答完翻下一条，位次跟着走', async () => {
    // 后端并行两个工具 → 一个 RUN_FINISHED 里带两条中断 → 库只把
    // interrupts[0] 当 interrupt，分页是**我们**的事（见 HitlInterrupt.tsx 头）。
    const a = makeInterrupt();
    const b = makeInterrupt({
      id: 'int-2',
      message: '另一个工具也要审批。',
      metadata: {
        toolKey: 'agent.platform.list_documents',
        options: APPROVAL_OPTIONS,
      },
    });
    const { resolve } = renderCard({ interrupt: a, interrupts: [a, b] });

    // 位次在"审批框上方"（头部那一行），而且主语是**第一条**
    expect(screen.getByText('当前第 1 条 / 总计 2 条')).toBeTruthy();
    expect(screen.getByText('是否允许执行该工具调用？')).toBeTruthy();

    fireEvent.click(button('允许'));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ decision: 'approve' }, 'int-1'),
    );

    // 翻到第二条：位次变了、主语换成第二条
    await waitFor(() =>
      expect(screen.getByText('当前第 2 条 / 总计 2 条')).toBeTruthy(),
    );
    expect(screen.getByText('另一个工具也要审批。')).toBeTruthy();

    // ⭐ 按钮必须**重新可点** —— 不复位 pending 的话下一条一直是灰的，
    //   用户就卡在这一组里出不去了
    expect(button('拒绝').disabled).toBe(false);

    fireEvent.click(button('拒绝'));
    await waitFor(() =>
      expect(resolve).toHaveBeenLastCalledWith({ decision: 'reject' }, 'int-2'),
    );
  });

  it('只有一条时不显示位次 —— "总计 1 条"是纯噪音', () => {
    renderCard();
    expect(screen.queryByText(/总计 \d 条/)).toBeNull();
  });
});

describe('读不出值域的卡片（unknown）', () => {
  it('把原始载荷摊开，且只留一个出口 —— 不假装知道怎么回答', () => {
    const interrupt = makeInterrupt({
      responseSchema: undefined,
      metadata: { weird: 'payload' },
    });
    renderCard({ interrupt });

    // 原始信息可见（排查得出来是什么东西）
    expect(screen.getByText(/weird/)).toBeTruthy();
    // 不画审批按钮（这里必须用 noButton：裸的 queryByRole 匹配不上 `允 许`，
    // 一条本意是"别多画按钮"的断言会变成永远通过的摆设）
    expect(noButton('允许')).toBeNull();
    expect(noButton('拒绝')).toBeNull();
    expect(noButton('始终允许')).toBeNull();
    expect(button('取消这次操作')).toBeTruthy();
  });

  it('取消**也要把回答送回去**（落成拒绝）—— 什么都不发会把会话锁死', async () => {
    const { resolve } = renderCard({
      interrupt: makeInterrupt({
        responseSchema: undefined,
        metadata: {},
      }),
    });

    fireEvent.click(button('取消这次操作'));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ decision: 'reject' }, 'int-1'),
    );
  });
});

describe('选项形状的卡片（非审批枚举）', () => {
  it('按钮文字用后端给的原值，不编中文标签', () => {
    const interrupt = makeInterrupt({
      reason: 'question',
      responseSchema: {
        properties: { decision: { enum: ['股票', '基金'] } },
      },
      metadata: {},
    });
    renderCard({ interrupt });

    expect(button('股票')).toBeTruthy();
    expect(button('基金')).toBeTruthy();
    // 这类不该出现审批专属的措辞
    expect(screen.queryByText('需要你的审批')).toBeNull();
    expect(screen.getByText('请选择')).toBeTruthy();
  });

  it('选中的原值原样回传', async () => {
    const { resolve } = renderCard({
      interrupt: makeInterrupt({
        reason: 'question',
        responseSchema: {
          properties: { decision: { enum: ['股票', '基金'] } },
        },
        metadata: {},
      }),
    });

    fireEvent.click(button('基金'));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ decision: '基金' }, 'int-1'),
    );
  });
});

/** 一个只显示"输入框会不会被锁"的探针 —— 用来观察 hitlSignal 发布出去的值。 */
const PendingProbe: React.FC = () => (
  <span data-testid="pending">{String(useHitlPending())}</span>
);

describe('HitlInterrupt（挂在对话区里的那一层）', () => {
  it('没有待办中断时整层不渲染 —— 不占位、不抢点击', () => {
    runtime.element = null;
    const { container } = render(<HitlInterrupt />);
    expect(container.firstChild).toBeNull();
  });

  it('有中断时把卡片放进一个带标的层里（位置由 CSS 定，这里钉住结构）', () => {
    const card: ReactElement = <span data-testid="card">CARD</span>;
    runtime.element = card;

    const { container } = render(<HitlInterrupt />);

    expect(screen.getByTestId('card')).toBeTruthy();
    expect(container.querySelector('[data-hitl-layer="1"]')).toBeTruthy();
  });

  it('⭐ renderInChat 必须是 false —— 否则库里会在对话流里再画一张（两张卡片）', () => {
    // `@copilotkit/react-ui/dist/index.cjs` 的 Messages：第 1703 行读
    // `useCopilotChatInternal().interrupt`、第 1756 行直接把它渲染进
    // `.copilotKitMessagesContainer`。也就是说 renderInChat 为 true（默认）时，
    // 同一个元素被画两次：对话流里一张 + 我们这一层一张，而且各有各的
    // deciding 状态。实测截图确认过。
    // 所以这里钉死 false —— 元素由 hook 返回、由我们挂。
    render(<HitlInterrupt />);

    expect(runtime.config?.renderInChat).toBe(false);
    expect(typeof runtime.config?.render).toBe('function');
  });

  it('元素是**返回值**给的（不再是读 copilotkit 发布出来的那份）', () => {
    const card: ReactElement = <span data-testid="card">CARD</span>;
    runtime.element = card;

    render(<HitlInterrupt />);

    // 返回什么就挂什么：这是 renderInChat: false 的整个意义
    expect(screen.getByTestId('card')).toBeTruthy();
  });

  it('⭐ 有待办时把「锁输入框」那个布尔发布出去', () => {
    runtime.element = <span>CARD</span>;

    render(
      <>
        <HitlInterrupt />
        <PendingProbe />
      </>,
    );

    expect(screen.getByTestId('pending').textContent).toBe('true');
  });

  it('中断被清掉后布尔跟着收回 —— 不收回的话输入框永远解不开', () => {
    runtime.element = <span>CARD</span>;
    const view = render(
      <>
        <HitlInterrupt />
        <PendingProbe />
      </>,
    );
    expect(screen.getByTestId('pending').textContent).toBe('true');

    // 点了按钮 / 中断被处理完 → hook 不再返回元素
    runtime.element = null;
    view.rerender(
      <>
        <HitlInterrupt />
        <PendingProbe />
      </>,
    );

    expect(screen.getByTestId('pending').textContent).toBe('false');
  });

  it('这一层卸载时也要收回 —— 它没了，锁着输入框就没道理了', () => {
    runtime.element = <span>CARD</span>;
    const view = render(
      <>
        <HitlInterrupt />
        <PendingProbe />
      </>,
    );
    expect(screen.getByTestId('pending').textContent).toBe('true');

    view.unmount();

    // 探针也一起卸载了，所以直接看模块状态（下一个订阅者读到的值）
    let seen = false;
    const ProbeAfter: React.FC = () => {
      seen = useHitlPending();
      return null;
    };
    render(<ProbeAfter />);
    expect(seen).toBe(false);
  });
});

// ============================================================
// 审批窗口的倒计时
// ============================================================
//
// ⚠️ 这一组要钉的是一句**产品决定**，不是像素：
//   窗口与锚点都来自**后端**（`wait_seconds` + 这一帧的 `occurred_at`），
//   到点**什么都不做**（不自动拒绝、不设 AG-UI 的 `expiresAt`）。
//   理由在 HitlInterrupt.tsx 的文件头与 runEventStream.ts 的注释里 ——
//   这里只把结论钉住，免得下一个人"顺手"改成自动提交。

const AT = '2026-10-06T10:00:00Z';
const AT_MS = Date.parse(AT);

/** 一块倒计时药丸。没有就返回 null —— "该不该画"也是断言的一部分。 */
const countdownEl = () => document.querySelector('[data-hitl-countdown]');

/** 一张"有窗口"的审批卡：300 秒窗口，锚点是 AT。 */
const interruptWithWindow = (over: Partial<Interrupt> = {}): Interrupt =>
  makeInterrupt({
    metadata: {
      toolKey: 'agent.platform.describe_platform',
      options: APPROVAL_OPTIONS,
      waitSeconds: 300,
      requestedAt: AT,
    },
    ...over,
  });

describe('approvalDeadline / formatRemaining（纯函数）', () => {
  it('窗口 + 锚点 → 截止时刻', () => {
    expect(approvalDeadline(300, AT)).toBe(AT_MS + 300_000);
  });

  it('窗口形状不对一律 null —— 宁可不画倒计时，也不画一个假的', () => {
    for (const bad of [undefined, null, 0, -1, '300', Number.NaN, {}]) {
      expect(approvalDeadline(bad, AT)).toBeNull();
    }
  });

  it('锚点读不出来也是 null（窗口在、时刻不在，就算不出剩余）', () => {
    for (const bad of [undefined, null, '', '刚才', 12345, {}]) {
      expect(approvalDeadline(300, bad)).toBeNull();
    }
  });

  it('剩余时间显示到秒，超过一小时才带小时位', () => {
    expect(formatRemaining(300_000)).toBe('05:00');
    expect(formatRemaining(90_000)).toBe('01:30');
    // ⚠️ **向上**取整：还剩 59.4 秒时显示 01:00 是对的（时间确实还没走完），
    //   显示 00:59 反而会让人以为少了一秒。
    expect(formatRemaining(59_400)).toBe('01:00');
    expect(formatRemaining(1)).toBe('00:01');
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(-5_000)).toBe('00:00'); // 负数不显示成 -00:05
    expect(formatRemaining(3_600_000)).toBe('1:00:00');
    expect(formatRemaining(86_400_000)).toBe('24:00:00'); // 后端上限一天
  });
});

describe('卡片上的倒计时（纯显示）', () => {
  beforeEach(() => {
    // 假时钟：真等一秒会让这组用例慢好几秒，而且断言随机器快慢抖。
    // ⚠️ `setSystemTime` 把"现在"钉在锚点上 —— 首屏就一定是满格的 05:00，
    //   否则"剩余 05:00"这种断言会看运气（取决于测试跑得多快）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT_MS));
  });

  it('⭐ 有窗口就画出来，并且每秒往下走', () => {
    renderCard({ interrupt: interruptWithWindow() });

    expect(countdownEl()?.textContent).toBe('剩余 05:00');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(countdownEl()?.textContent).toBe('剩余 04:59');
  });

  it('⭐ 锚点是**这一帧的 occurred_at**，不是"卡片挂载的那一刻"', () => {
    // 这一帧是 2 分钟前产生的 —— 刷新后续订、重放出来的中断就长这样。
    vi.setSystemTime(new Date(AT_MS + 120_000));

    renderCard({ interrupt: interruptWithWindow() });

    // 300 秒的窗口已经走掉 120 秒 → 剩 03:00。
    // 若改用"挂载时刻"当锚点，这里会是 05:00 —— 每次刷新都满格，倒计时就是装饰。
    expect(countdownEl()?.textContent).toBe('剩余 03:00');
  });

  it('药丸的 title 说清窗口是哪来的、以及到点不会自动提交', () => {
    renderCard({ interrupt: interruptWithWindow() });

    const title = countdownEl()?.getAttribute('title') ?? '';
    expect(title).toContain('后端声明的等待时长');
    expect(title).toContain('不会自动提交');
  });

  it('后端没给窗口 → 整块不出现（退化成没有倒计时，而不是画个假的）', () => {
    // 默认的 makeInterrupt() 里没有 waitSeconds —— 老后端的形状
    renderCard();

    expect(countdownEl()).toBeNull();
    // 卡片该有的东西一个都不能少，缺的只是倒计时
    expect(button('允许')).toBeTruthy();
    expect(screen.getByText('agent.platform.describe_platform')).toBeTruthy();
  });

  it('只有窗口没有锚点（或反过来）也一律不画 —— 缺一样就算不出剩余', () => {
    renderCard({
      interrupt: makeInterrupt({
        metadata: { options: APPROVAL_OPTIONS, waitSeconds: 300 },
      }),
    });
    expect(countdownEl()).toBeNull();

    cleanup();

    renderCard({
      interrupt: makeInterrupt({
        metadata: { options: APPROVAL_OPTIONS, requestedAt: AT },
      }),
    });
    expect(countdownEl()).toBeNull();
  });

  it('⭐ 到点之后：药丸改成「已超过等待时长」，而且**一个字节都没提交**', async () => {
    const { resolve } = renderCard({ interrupt: interruptWithWindow() });

    act(() => {
      vi.advanceTimersByTime(300_000); // 把窗口走完
    });

    expect(countdownEl()?.getAttribute('data-hitl-countdown')).toBe('overdue');
    expect(countdownEl()?.textContent).toBe('已超过等待时长');

    // ⚠️⚠️ 这是本组的核心：界面**不替用户做决定**。
    //   自动拒绝 = 前端发明一条审批策略（真判超时的是后端的清理任务），
    //   而且审批拦着的就是工具调用本身 —— 误拒会真的拒掉一个动作。
    //   任何"到点自己 resolve 一下"的改动都必须在这里红。
    await act(async () => {});
    expect(resolve).not.toHaveBeenCalled();

    // 按钮照旧等人点 —— "超时"不等于"不能答了"
    expect(button('允许').disabled).toBe(false);
    expect(button('拒绝').disabled).toBe(false);
  });

  it('一组两条：倒计时跟着**正在显示的那一条**走（各条各有各的时刻）', async () => {
    const first = interruptWithWindow();
    // 第二条晚 60 秒产生。
    // ⚠️ 所以**同一时刻**看，它反而还剩得更多（06:00 > 05:00）—— 这正好是
    //   "没共用第一条时钟"的证据：共用的话两条都会显示 05:00。
    const second = interruptWithWindow({
      id: 'int-2',
      metadata: {
        options: APPROVAL_OPTIONS,
        waitSeconds: 300,
        requestedAt: new Date(AT_MS + 60_000).toISOString(),
      },
    });
    renderCard({ interrupt: first, interrupts: [first, second] });

    expect(countdownEl()?.textContent).toBe('剩余 05:00');

    fireEvent.click(button('允许'));
    await act(async () => {});

    // 翻到第二条：主语、位次、倒计时一起换
    expect(screen.getByText('当前第 2 条 / 总计 2 条')).toBeTruthy();
    expect(countdownEl()?.textContent).toBe('剩余 06:00');
  });
});

// ============================================================
// 提问形状（agent.ask_user_question）
// ============================================================
//
// 它和审批**共用**同一条中断通道、同一个外壳，只有中间那段不同。这里钉的是
// 分叉有没有分对（别把提问渲染成三个审批按钮）以及回传的形状
// （`{ answers }` 而不是 `{ decision }`）。
//
// ⚠️ 「问题控件」本身的交互在 AskUserQuestionBody.test.tsx 里，这里不重复 ——
//   这里只管"外壳有没有把正确的数据交给它、有没有把答案原样交回去"。

const ASK_QUESTIONS = [
  {
    question: '用哪个数据源？',
    header: '数据源',
    options: [
      { label: '实时行情', description: 'T+0 的报价', preview: null },
      { label: '历史库', description: '含复权因子' },
    ],
    multiSelect: false,
  },
];

/** 一个提问中断（形状就是后端 `interrupt()` 的载荷 + interrupt_id）。 */
const askInterrupt = (over: Partial<Interrupt> = {}) =>
  makeInterrupt({
    // 提问帧**没有** options、也没有审批那三个值 —— responseSchema 照样是
    // decision，但枚举为空（见 runEventStream 的 hitlInterrupt）
    responseSchema: {
      type: 'object',
      properties: { decision: { type: 'string' } },
      required: ['decision'],
    },
    message: undefined,
    metadata: {
      hitlType: 'ask_user_question',
      questions: ASK_QUESTIONS,
      toolCallId: 'call-1',
    },
    ...over,
  });

describe('提问形状的卡片', () => {
  it('⭐ type + 题面 → variant 是 question（不能被判成 unknown）', () => {
    expect(resolveVariant(askInterrupt())).toBe('question');
  });

  it('⭐ 只认提问的字段，不认 tool_key：审批帧照旧判 approval', () => {
    // 同样的 tool_key，只要没有 type/questions，就不该变成提问
    const approval = makeInterrupt({
      metadata: {
        toolKey: 'agent.ask_user_question',
        options: APPROVAL_OPTIONS,
      },
    });

    expect(resolveVariant(approval)).toBe('approval');
  });

  it('渲染成问题控件：有题面与选项，没有审批按钮', () => {
    renderCard({ interrupt: askInterrupt() });

    expect(screen.getByText('需要你的回答')).toBeTruthy();
    expect(screen.getByText('用哪个数据源？')).toBeTruthy();
    expect(screen.getByText('T+0 的报价')).toBeTruthy();

    // 审批那三个按钮一个都不该出现（它们对提问没有任何意义）
    expect(noButton('允许')).toBeNull();
    expect(noButton('拒绝')).toBeNull();
    expect(noButton('始终允许')).toBeNull();
  });

  it('⭐ 提交 → resolve({ answers: { 问题原文: 答案 } }, interruptId)', async () => {
    const { resolve } = renderCard({ interrupt: askInterrupt() });

    fireEvent.click(screen.getByRole('radio', { name: /历史库/ }));
    fireEvent.click(button('提交'));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        { answers: { '用哪个数据源？': '历史库' } },
        'int-1',
      ),
    );
  });

  it('⭐ 「跳过」也发一次（空集）—— 不发的话后端永远停在 waiting_input', async () => {
    const { resolve } = renderCard({ interrupt: askInterrupt() });

    fireEvent.click(button('跳过'));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ answers: {} }, 'int-1'),
    );
  });

  it('提问帧没有 window / 锚点 → 不画倒计时（那条只属于审批）', () => {
    renderCard({ interrupt: askInterrupt() });

    expect(countdownEl()).toBeNull();
  });
});

// ============================================================
// 表面语言：一条**不透明**的状态栏 + 一排靠右的按钮
// ============================================================
//
// 2026-10-21 用户：「风格和 chat 对话框对齐」「按钮都右对齐」。
// 2026-10-23 用户截图：「审批框 approve 事件是透明的」—— 这一层是**压在消息
// 文本上面**的浮层，半透明底色会让下面的字透上来，整张卡读不清。
// 判据一律读**计算值**（emotion 的类名是哈希，写死类名一改就假绿）：
// 样式表一注入就能抓到，不必靠截图。
//
// ⚠️ 为什么值得钉：这几条没有任何交互逻辑兜底 —— 背景换成半透明、边框去掉、
//    按钮回到左对齐，测试全绿、功能全好，只有眼睛能看出来。回归只能靠这里。

describe('卡片表面：不透明、有边界、按钮靠右', () => {
  /** 卡本体（<fieldset>）—— 见 HitlInterrupt.tsx 里那段为什么是 fieldset。 */
  const cardOf = (container: HTMLElement) =>
    container.querySelector('fieldset') as HTMLElement;

  /**
   * 底部按钮排：从某颗审批按钮往上找它的父容器。
   * ⚠️ 不能再写 `querySelector('button').parentElement` —— 卡片里第一颗按钮
   *    现在是**标题行**（折叠开关），它的父级是 fieldset 本身。
   */
  const actionsOf = () => button('允许').parentElement as HTMLElement;

  /**
   * 一个元素上**我们自己写的**样式类。
   *
   * antd-style 输出的前缀是 `acss-<hash>`（emotion 的 `css-` 换了个前缀），
   * 而 antd 组件自己挂的那两个是 `css-dev-only-do-not-override-*` 与
   * `css-var-root` —— 前缀不同，所以按 `acss-` 筛就已经干净了，不必再排除。
   */
  const ownClasses = (el: Element) =>
    Array.from(el.classList).filter((name) => name.startsWith('acss-'));

  it('⭐ 没有投影 —— 有阴影就是"浮在最上层的弹窗"，不是输入区的一部分', () => {
    const { container } = renderCard();

    expect(getComputedStyle(cardOf(container)).boxShadow).toBe('none');
  });

  it('⭐ 底色**不透明** —— 半透明会让下面那条消息的字透上来（截图报过的 bug）', () => {
    const { container } = renderCard();

    // colorBgContainer 是实色。⚠️ 只判"不带 alpha"：
    //   把具体色值钉死会让每次调色都红，而这里要防的是"又换成半透明"。
    const bg = getComputedStyle(cardOf(container)).backgroundColor;
    expect(bg).not.toBe('');
    expect(bg).not.toMatch(/rgba\(|transparent/);
  });

  it('画一条可见的边 —— 不透明之后卡片与消息区同色，边界只能靠边框给', () => {
    const { container } = renderCard();

    const style = getComputedStyle(cardOf(container));
    expect(style.borderTopColor).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    expect(style.borderTopWidth).toBe('1px');
  });

  it('⭐ 按钮整排靠右（不再靠左、也不靠某一颗自己推过去）', () => {
    renderCard();

    expect(getComputedStyle(actionsOf()).justifyContent).toBe('flex-end');
  });

  it('⭐ 「跳过」身上**不挂任何自定义类** —— 对齐一律交给父容器', () => {
    // 曾经的写法：跳过按钮自己挂一个类（里面是 margin-inline-start:auto），
    // 于是「提交」贴左、它贴右，中间一条大空白 —— 正是要修的那个观感。
    //
    // ⚠️ 为什么查"有没有 acss- 类"而不是查计算值 margin-inline-start：
    //   jsdom 不解析逻辑属性，`marginInlineStart` 恒为空串，断言 `!== 'auto'`
    //   会变成永远通过的摆设（本文件开头那段"假绿比红更危险"）。
    const { container } = renderCard({ interrupt: askInterrupt() });
    expect(ownClasses(button('跳过'))).toEqual([]);

    // ⚠️ 反向控制：**证明上面那条不是永远为空的摆设**。
    //   卡片本体挂着 styles.hitlCard（emotion 类），它必须被同一套过滤抓到 ——
    //   抓不到就说明过滤器写错了，那条"没有自定义类"的断言是假绿。
    expect(ownClasses(cardOf(container)).length).toBeGreaterThan(0);
  });
});

// ============================================================
// 标题行 + 内容：审批控件当 content，工具调用状态栏当 title
// ============================================================
//
// 2026-10-23 用户原话：「直接把审批控件作为 content，工具调用状态栏作为 title
// / 审批完成之后就融合进 title 栏即可」。
// 所以这一节钉三件事：标题长什么样、能不能折、提交时是不是**立刻**折。

describe('标题行（工具调用状态栏）+ 内容（审批控件）', () => {
  /** 标题行那颗 button。 */
  const titleOf = () =>
    document.querySelector('[data-hitl-title]') as HTMLButtonElement;

  /** 内容壳（由 data-open 决定展开/折起）。 */
  const bodyOf = () =>
    document.querySelector('[data-hitl-body]') as HTMLElement;

  it('⭐ 主语是工具名（人话），「需要你的审批」退成旁注', () => {
    renderCard();

    const title = titleOf();
    // 工具名来自 i18n（agent.platform.describe_platform → 查看平台能力）
    expect(title.textContent).toContain('查看平台能力');
    // 旁注还在 —— 只说工具名，用户不知道"这是要我干什么"
    expect(title.textContent).toContain('需要你的审批');
  });

  it('读不出 toolKey 的中断才把那句话当主语（不能同一句画两遍）', () => {
    const interrupt = makeInterrupt({
      metadata: { options: APPROVAL_OPTIONS },
    });
    renderCard({ interrupt });

    const text = titleOf().textContent ?? '';
    expect(text).toContain('需要你的审批');
    expect(text.match(/需要你的审批/g)).toHaveLength(1);
  });

  it('标题是**真 button**：aria-expanded 跟着展开态走', () => {
    renderCard();

    expect(titleOf().tagName).toBe('BUTTON');
    expect(titleOf().getAttribute('aria-expanded')).toBe('true');
  });

  it('⭐ 默认**展开** —— 不展开的话用户根本不知道在等什么', () => {
    renderCard();

    expect(bodyOf().getAttribute('data-open')).toBe('true');
  });

  it('点标题可以折起来，再点一次展开（人能自己腾出视野看上文）', () => {
    renderCard();

    fireEvent.click(titleOf());
    expect(titleOf().getAttribute('aria-expanded')).toBe('false');
    expect(bodyOf().getAttribute('data-open')).toBe('false');

    fireEvent.click(titleOf());
    expect(titleOf().getAttribute('aria-expanded')).toBe('true');
    expect(bodyOf().getAttribute('data-open')).toBe('true');
  });

  it('⭐ 点「允许」之后**立刻**折进标题行（这就是"融合进 title 栏"）', async () => {
    // 永不 settle：模拟"请求在飞"。此刻卡片应当已经收成一行——
    // 收的是高度，请求是并行的，用户不用等网络回来才看到反馈。
    const resolve = vi.fn().mockReturnValue(new Promise(() => {}));
    renderCard({ resolve });

    expect(bodyOf().getAttribute('data-open')).toBe('true');

    fireEvent.click(button('允许'));

    await waitFor(() =>
      expect(bodyOf().getAttribute('data-open')).toBe('false'),
    );
    expect(titleOf().getAttribute('aria-expanded')).toBe('false');
    // 标题仍在（折起来的是内容，不是整张卡）
    expect(titleOf().textContent).toContain('查看平台能力');
  });

  it('⭐ 提交失败要**重新展开** —— 否则只剩一行标题，用户看不到报错也点不了', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('boom'));
    renderCard({ resolve });

    fireEvent.click(button('允许'));

    await waitFor(() =>
      expect(bodyOf().getAttribute('data-open')).toBe('true'),
    );
    expect(button('允许').disabled).toBe(false);
  });

  it('⭐ 折叠后内容退出**无障碍树**（Tab 不能落到看不见的「允许」上）', () => {
    renderCard();

    // 展开时按钮在无障碍树里
    expect(
      screen.queryAllByRole('button', { name: /允\s*许/ }),
    ).not.toHaveLength(0);

    fireEvent.click(titleOf());

    // 折起来之后按角色查不到（visibility: hidden 的子树被剔除）
    expect(screen.queryAllByRole('button', { name: /允\s*许/ })).toHaveLength(
      0,
    );
    // 但 DOM 里还在（折的是视觉，不是卸载 —— 再展开要能原样回来）
    expect(button('允许')).toBeTruthy();
  });

  it('一组多条翻页时，下一条要重新展开（折叠态不该被继承）', async () => {
    const a = makeInterrupt();
    const b = makeInterrupt({
      id: 'int-2',
      message: '另一个工具也要审批。',
      metadata: {
        toolKey: 'agent.platform.list_documents',
        options: APPROVAL_OPTIONS,
      },
    });
    const { resolve } = renderCard({ interrupt: a, interrupts: [a, b] });

    fireEvent.click(button('允许'));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({ decision: 'approve' }, 'int-1'),
    );

    await waitFor(() =>
      expect(bodyOf().getAttribute('data-open')).toBe('true'),
    );
    expect(screen.getByText('当前第 2 条 / 总计 2 条')).toBeTruthy();
  });
});
