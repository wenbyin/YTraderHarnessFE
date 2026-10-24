// src/components/CopilotDock/Composer.test.tsx
//
// 输入框（DeepSeek 风）的行为契约。**这个文件最重要的作用是钉住"没有弄丢
// 库默认实现的功能"** —— 我们为了把「深度思考 + 附件」塞进控件行，整个换掉了
// CopilotKit 的默认 Input，那些行为就得由我们自己保证：
//   · Enter 发送 / Shift+Enter 换行
//   · **IME 组合期间的 Enter 不下发**（中文输入法选词会带 Enter）
//   · inProgress → 停止按钮（不是发送）；未就绪 → 转圈且不可发
//   · 空文本不能发
//
// 另外钉住两条**刻意的取舍**（见 Composer.tsx 文件头）：
//   · 附件与深度思考今天只是 UI，都不进 onSend；
//   · 发送后附件芯片**不清空** —— 它没被提交，清空会让人以为发出去了。
//
// CopilotKit 的两个包在这里被换成只有取值的桩：本文件测的是我们的 DOM 与回调，
// 不是它的上下文实现。
import type { Message } from '@ag-ui/client';
import type { InputProps } from '@copilotkit/react-ui';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Composer, { fileKey } from './Composer';
import { requestComposerDraft, resetComposerDraft } from './composerDraft';
import { DEEP_THINK_KEY } from './composerPrefs';
import { setHitlPending } from './hitlSignal';

vi.mock('@copilotkit/react-ui', () => ({
  useChatContext: () => ({
    labels: { placeholder: '发消息给 AI 助手…' },
    // 用文字当图标，省得在 vi.mock 工厂里写 JSX
    icons: {
      sendIcon: 'SEND',
      stopIcon: 'STOP',
      spinnerIcon: 'SPINNER',
    },
    open: true,
    setOpen: () => {},
  }),
}));

vi.mock('@copilotkit/react-core', () => ({
  useCopilotContext: () => ({ copilotApiConfig: {} }),
}));

/** 一个发送用的假文件（lastModified 显式给值，fileKey 要用）。 */
const makeFile = (name: string, lastModified = 1) =>
  new File(['x'], name, {
    type: 'application/pdf',
    lastModified,
  });

const reply = () => ({ id: 'a-1', role: 'assistant', content: '' }) as Message;

const setup = (props: Partial<InputProps> = {}) => {
  const onSend = vi.fn().mockResolvedValue(reply());
  const onStop = vi.fn();
  const utils = render(
    <Composer
      inProgress={false}
      chatReady
      onSend={onSend as unknown as InputProps['onSend']}
      onStop={onStop}
      {...props}
    />,
  );
  return { ...utils, onSend, onStop };
};

const textarea = () => screen.getByTestId('copilot-chat-textarea');
const sendButton = () => screen.getByTestId('copilot-send-button');
const deepThink = () => screen.getByTestId('copilot-deep-think');
const attachButton = () => screen.getByTestId('copilot-attach');
const fileInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"]') as HTMLInputElement;

/** 选一批文件（走真正的 change 事件，不是直接改 state）。 */
const pick = (container: HTMLElement, files: File[]) =>
  fireEvent.change(fileInput(container), { target: { files } });

/** 输入文字并回车。 */
const typeAndEnter = (text: string) => {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter' });
};

beforeEach(() => {
  localStorage.clear();
  // hitlSignal 是模块级状态，不复位会串到下一个用例
  setHitlPending(false);
});

afterEach(cleanup);

describe('Composer：基础行为（对齐库默认实现）', () => {
  it('placeholder 用 CopilotChat 传下来的文案', () => {
    setup();
    expect(textarea()).toHaveAttribute('placeholder', '发消息给 AI 助手…');
  });

  it('空文本时发送按钮禁用；输入后启用', () => {
    setup();
    expect(sendButton()).toBeDisabled();

    fireEvent.change(textarea(), { target: { value: '你好' } });
    expect(sendButton()).toBeEnabled();
  });

  it('只输入空白也不算能发', () => {
    setup();
    fireEvent.change(textarea(), { target: { value: '   ' } });
    expect(sendButton()).toBeDisabled();
  });

  it('Enter 发送，并清空输入框', () => {
    const { onSend } = setup();
    typeAndEnter('第一条消息');

    expect(onSend).toHaveBeenCalledWith('第一条消息');
    expect(textarea()).toHaveValue('');
  });

  it('Shift+Enter 是换行，不发送', () => {
    const { onSend } = setup();
    fireEvent.change(textarea(), { target: { value: '第一行' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea()).toHaveValue('第一行');
  });

  it('⭐ 输入法组合期间的 Enter 不下发（否则选词就把半句话发出去）', () => {
    const { onSend } = setup();
    fireEvent.change(textarea(), { target: { value: '你好' } });

    fireEvent.compositionStart(textarea());
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();

    // 组合结束后 Enter 才恢复成"发送"
    fireEvent.compositionEnd(textarea());
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('你好');
  });

  it('Enter 在空文本时不发送', () => {
    const { onSend } = setup();
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('点输入框空白处会把焦点给 textarea，点按钮不抢', () => {
    const { container } = setup();
    const bubble = container.querySelector('.copilotKitInput') as HTMLElement;

    fireEvent.click(bubble);
    expect(document.activeElement).toBe(textarea());

    textarea().blur();
    fireEvent.click(attachButton());
    expect(document.activeElement).not.toBe(textarea());
  });
});

describe('Composer：发送 / 停止 / 未就绪', () => {
  it('点发送按钮等价于回车', () => {
    const { onSend } = setup();
    fireEvent.change(textarea(), { target: { value: '点按钮发' } });
    fireEvent.click(sendButton());

    expect(onSend).toHaveBeenCalledWith('点按钮发');
    expect(textarea()).toHaveValue('');
  });

  it('inProgress 时按钮变成停止，点击走 onStop 而不是 onSend', () => {
    const { onSend, onStop } = setup({ inProgress: true });

    // 停止态：图标来自库的 stopIcon
    expect(sendButton()).toHaveTextContent('STOP');
    expect(sendButton()).toHaveAttribute('aria-label', '停止生成');

    fireEvent.change(textarea(), { target: { value: '生成中写的字' } });
    fireEvent.click(sendButton());

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('⭐ 停止态打 data-stop（红色由 style.ts 的 [data-stop="true"] 负责）', () => {
    // 为什么用 data 属性而不是多一个类名：两个类名会同元素共存、按特异性打架，
    // hover 时主色的蓝会赢。详见 style.ts sendButton 那段注释。
    setup({ inProgress: true });
    expect(sendButton()).toHaveAttribute('data-stop', 'true');

    // 空闲时是发送按钮，不能带这个标记 —— 否则红色会漏到发送态上
    cleanup();
    setup({ inProgress: false, chatReady: true });
    expect(sendButton()).toHaveAttribute('data-stop', 'false');
  });

  it('⭐ 隐藏停止按钮时（hideStopButton）不算停止态，别变红', () => {
    // 生成中但明确不显示停止按钮 —— 此时按钮是禁用态（素圆灰箭头），
    // 红底会让它看着像"可点"，所以 data-stop 必须为 false。
    setup({ inProgress: true, hideStopButton: true });
    expect(sendButton()).toHaveAttribute('data-stop', 'false');
  });

  it('⭐ 样式表里停止态是红的，且 hover 也要跟着红', () => {
    setup({ inProgress: true });

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');

    // 基础态
    const base = css.split('}').find((c) => c.includes("[data-stop='true']{"));
    expect(base).toBeDefined();
    // 只断言"确实换了色"而不钉死具体色值：色值来自 antd 主题 token，
    // 主题一改这里就红，测试不该跟着红。hover 那条才是真正要防的
    //（蓝底赢回主色 = 鼠标一放上去就变回"可发"，看着像点不动）。
    expect(base).toContain('background:');
    expect(base).not.toContain('colorPrimary');

    // hover：停止态的 hover 必须比主色的 hover 更具体（否则蓝底赢）
    const hover = css
      .split('}')
      .find((c) => c.includes("[data-stop='true']:hover:not(:disabled)"));
    expect(hover).toBeDefined();
    expect(hover).toContain('background:');
  });

  it('未就绪（chatReady=false）时转圈且不可发', () => {
    const { onSend } = setup({ chatReady: false });

    expect(sendButton()).toHaveTextContent('SPINNER');
    expect(sendButton()).toBeDisabled();

    fireEvent.change(textarea(), { target: { value: '你好' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('⭐ 有待办审批时不许发 —— 等人工输入期间后端建不了新运行（409）', () => {
    // 这个布尔原来读 `useCopilotChatInternal().interrupt`，现在由 HitlInterrupt
    // 通过 hitlSignal 发布（原因见 hitlSignal.ts 文件头：那个值来自
    // `interruptElement`，而发布它需要的 renderInChat: true 会让库在对话流里
    // 再画一张卡片）。所以这里直接改模块状态，验的是消费侧的行为。
    // ⚠️ 得包在 act 里：那是 React 之外的状态变更，直接调用会让订阅者
    //    在 act 之外重渲染（warning + 断言可能读到旧 DOM）。
    const { onSend } = setup({ chatReady: true });
    act(() => setHitlPending(true));

    fireEvent.change(textarea(), { target: { value: '你好' } });
    expect(sendButton()).toBeDisabled();

    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('审批处理完之后要能再发（布尔跟着收回）', () => {
    const { onSend } = setup({ chatReady: true });
    act(() => setHitlPending(true));
    act(() => setHitlPending(false));

    typeAndEnter('你好');

    expect(onSend).toHaveBeenCalledWith('你好');
  });

  it('hideStopButton 时生成中也不显示停止（沿用按钮禁用）', () => {
    setup({ inProgress: true, hideStopButton: true });
    expect(sendButton()).toHaveTextContent('SEND');
    expect(sendButton()).toBeDisabled();
  });
});

describe('Composer：深度思考（今天只是 UI 切换态）', () => {
  it('默认关；点一下变开并落盘；再点回关', () => {
    setup();

    expect(deepThink()).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem(DEEP_THINK_KEY)).toBe('0');

    fireEvent.click(deepThink());
    expect(deepThink()).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem(DEEP_THINK_KEY)).toBe('1');

    fireEvent.click(deepThink());
    expect(deepThink()).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem(DEEP_THINK_KEY)).toBe('0');
  });

  it('记住选择：存储里是开的时候，下次渲染就是开的', () => {
    localStorage.setItem(DEEP_THINK_KEY, '1');
    setup();
    expect(deepThink()).toHaveAttribute('aria-pressed', 'true');
  });

  it('⭐ 开关不进 onSend（后端 input 只收 text，没有通道能送它）', () => {
    const { onSend } = setup();
    fireEvent.click(deepThink());
    typeAndEnter('帮我看看这只票');

    expect(onSend).toHaveBeenCalledWith('帮我看看这只票');
    // 开着深度思考，但发出去的文本原样、不带任何标记
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('Composer：附件（今天只是 UI）', () => {
  it('⭐ 点「添加附件」不发送任何东西，也不触发 onSend（也不该去点库的 onUpload）', () => {
    const onUpload = vi.fn();
    const { onSend } = setup({ onUpload });

    fireEvent.click(attachButton());

    expect(onSend).not.toHaveBeenCalled();
    // 我们用自己的 file input，没走库的附件管线
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('选中文件后出现芯片（带文件名），可以单个移除', () => {
    const { container } = setup();

    pick(container, [makeFile('年报.pdf'), makeFile('截图.png')]);
    expect(screen.getByText('年报.pdf')).toBeInTheDocument();
    expect(screen.getByText('截图.png')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移除附件 年报.pdf' }));
    expect(screen.queryByText('年报.pdf')).toBeNull();
    expect(screen.getByText('截图.png')).toBeInTheDocument();
  });

  it('重复选同一个文件不会出现两个芯片', () => {
    const { container } = setup();

    pick(container, [makeFile('年报.pdf', 111)]);
    pick(container, [makeFile('年报.pdf', 111)]);

    expect(screen.getAllByText('年报.pdf')).toHaveLength(1);
  });

  it('同名但确实是两个文件（大小/时间不同）算两个', () => {
    const { container } = setup();

    pick(container, [makeFile('report.pdf', 1)]);
    pick(container, [makeFile('report.pdf', 2)]);

    expect(screen.getAllByText('report.pdf')).toHaveLength(2);
  });

  it('⭐ 发送后芯片不清空（附件没被提交，清空等于骗人）', () => {
    const { container, onSend } = setup();

    pick(container, [makeFile('年报.pdf')]);
    typeAndEnter('这是正文');

    expect(onSend).toHaveBeenCalledWith('这是正文');
    expect(screen.getByText('年报.pdf')).toBeInTheDocument();
  });

  it('选完文件能接着选（清空了 input.value，同一个文件才还能再触发）', () => {
    const { container } = setup();
    pick(container, [makeFile('a.pdf')]);
    expect(fileInput(container).value).toBe('');
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
  });
});

describe('fileKey', () => {
  it('同名不同大小 / 不同修改时间都算不同的文件', () => {
    expect(fileKey(makeFile('a.pdf', 1))).not.toBe(
      fileKey(makeFile('a.pdf', 2)),
    );
    expect(fileKey(makeFile('a.pdf', 1))).not.toBe(
      fileKey(makeFile('b.pdf', 1)),
    );
    expect(fileKey(makeFile('a.pdf', 1))).toBe(fileKey(makeFile('a.pdf', 1)));
  });
});

/**
 * 「编辑」按钮的落点（用户消息卡片下方那两枚按钮之一）。
 *
 * 指令从消息列表发过来（composerDraft 是模块级 store），这里钉住输入框**收到
 * 之后真的改了**：文本进来、焦点进来、光标在末尾。
 */
describe('Composer：编辑 -> 原文回到输入框', () => {
  afterEach(() => {
    resetComposerDraft();
  });

  it('⭐ 文本填进 textarea，并且拿到焦点、光标落在末尾', () => {
    setup();

    act(() => requestComposerDraft('把这三条日志按时间排序'));

    expect(textarea()).toHaveValue('把这三条日志按时间排序');
    expect(document.activeElement).toBe(textarea());
    const element = textarea() as HTMLTextAreaElement;
    expect(element.selectionStart).toBe('把这三条日志按时间排序'.length);
  });

  it('⭐ 连续编辑同一段文本：即使输入框被改乱了，也会重新填回原文', () => {
    setup();
    act(() => requestComposerDraft('原来的问题'));
    // 用户把输入框清掉，又点了同一条消息的「编辑」
    fireEvent.change(textarea(), { target: { value: '' } });
    act(() => requestComposerDraft('原来的问题'));

    expect(textarea()).toHaveValue('原来的问题');
  });
});
