// src/components/CopilotDock/AskUserQuestionBody.test.tsx
//
// 问题控件（画 + 交互）。判据在 askUserQuestion.test.ts 里，这里只钉三件事：
//   ① 一次显示一道题，没答完不能翻页（翻了就再也回不来补）；
//   ② 底部按钮回传的**形状**：`{ answers: { 问题原文: 答案 } }`，多选 ", " 连接；
//   ③ 「其他」的输入框、示例预览这两个会展开的东西，别顺手把选项选上。
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AskUserQuestionBody from './AskUserQuestionBody';
import { parseQuestions } from './askUserQuestion';

const QUESTIONS = parseQuestions([
  {
    question: '用哪个数据源？',
    header: '数据源',
    options: [
      { label: '实时行情', description: 'T+0 的报价', preview: 'GET /quote' },
      { label: '历史库', description: '含复权因子' },
    ],
    multiSelect: false,
  },
  {
    question: '要哪些字段？',
    header: '字段',
    options: [{ label: '收盘价' }, { label: '成交量' }],
    multiSelect: true,
  },
]);

const renderBody = (
  over: Partial<React.ComponentProps<typeof AskUserQuestionBody>> = {},
) => {
  const onResolve = vi.fn();
  const props = {
    questions: QUESTIONS,
    pending: null,
    onResolve,
    ...over,
  };
  const view = render(<AskUserQuestionBody {...props} />);
  return { ...view, onResolve, props };
};

// ⚠️ 名字一律用正则：antd 会给**两个汉字**的按钮中间插一个空格
//   （`提 交`），按字面串查会找不到 —— 审批卡那两个「允 许」「拒 绝」同理。
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const radio = (name: RegExp) => screen.getByRole('radio', { name });
const checkbox = (name: RegExp) => screen.getByRole('checkbox', { name });

describe('一屏一道题', () => {
  it('题面、短标题、选项与说明都在；单题时不显示"第 1 / 1 题"', () => {
    renderBody({ questions: [QUESTIONS[0]] });

    expect(screen.getByText('用哪个数据源？')).toBeTruthy();
    expect(screen.getByText('数据源')).toBeTruthy();
    expect(screen.getByText('T+0 的报价')).toBeTruthy();
    expect(screen.queryByText(/第 1 \/ 1 题/)).toBeNull();
  });

  it('多题时显示进度，多选那题带「可多选」提示', () => {
    renderBody();
    expect(screen.getByText('第 1 / 2 题')).toBeTruthy();

    fireEvent.click(radio(/实时行情/));
    fireEvent.click(button(/下一题/));

    expect(screen.getByText('第 2 / 2 题')).toBeTruthy();
    expect(screen.getByText('可多选')).toBeTruthy();
  });

  it('⭐ 没答完就不能翻页 —— 翻过去之后这一题没有任何入口能回来补', () => {
    renderBody();
    expect(button(/下一题/)).toBeDisabled();

    fireEvent.click(radio(/实时行情/));
    expect(button(/下一题/)).not.toBeDisabled();
  });
});

describe('回传的形状', () => {
  it('单选：一题答完点「提交」→ { answers: { 问题原文: label } }', () => {
    const { onResolve } = renderBody({ questions: [QUESTIONS[0]] });

    fireEvent.click(radio(/历史库/));
    fireEvent.click(button(/提\s*交/));

    expect(onResolve).toHaveBeenCalledWith(
      { '用哪个数据源？': '历史库' },
      'submit',
    );
  });

  it('多选：两项用 ", " 连接（后端 `_answer_text` 就是这么 join 的）', () => {
    const { onResolve } = renderBody({ questions: [QUESTIONS[1]] });

    fireEvent.click(checkbox(/收盘价/));
    fireEvent.click(checkbox(/成交量/));
    fireEvent.click(button(/提\s*交/));

    expect(onResolve).toHaveBeenCalledWith(
      { '要哪些字段？': '收盘价, 成交量' },
      'submit',
    );
  });

  it('两道题：逐题作答后一次提交，两题都在 answers 里', () => {
    const { onResolve } = renderBody();

    fireEvent.click(radio(/实时行情/));
    fireEvent.click(button(/下一题/));
    fireEvent.click(checkbox(/成交量/));
    fireEvent.click(button(/提\s*交/));

    expect(onResolve).toHaveBeenCalledWith(
      { '用哪个数据源？': '实时行情', '要哪些字段？': '成交量' },
      'submit',
    );
  });

  it('⭐ 「跳过」把**已填的**答案照样交回去（空集也合法：不发才会把会话锁死）', () => {
    const empty = renderBody({ questions: [QUESTIONS[0]] });
    fireEvent.click(button(/跳过/));
    expect(empty.onResolve).toHaveBeenCalledWith({}, 'skip');

    empty.unmount();
    const half = renderBody();
    fireEvent.click(radio(/实时行情/));
    fireEvent.click(button(/跳过/));
    expect(half.onResolve).toHaveBeenCalledWith(
      { '用哪个数据源？': '实时行情' },
      'skip',
    );
  });
});

describe('「其他（自己填）」', () => {
  it('没选中时不占地方；选中后才出现输入框', () => {
    renderBody({ questions: [QUESTIONS[0]] });
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(radio(/其他/));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('⭐ 只勾「其他」不填字 → 提交仍然是灰的（送回去是个空串，等于没答）', () => {
    const { onResolve } = renderBody({ questions: [QUESTIONS[0]] });

    fireEvent.click(radio(/其他/));
    expect(button(/提\s*交/)).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '按分钟线' },
    });
    expect(button(/提\s*交/)).not.toBeDisabled();

    fireEvent.click(button(/提\s*交/));
    expect(onResolve).toHaveBeenCalledWith(
      { '用哪个数据源？': '按分钟线' },
      'submit',
    );
  });
});

describe('会被展开的两样东西', () => {
  it('⭐ 点「查看示例」只展开预览，不会顺手把那一项选上', () => {
    renderBody({ questions: [QUESTIONS[0]] });

    fireEvent.click(button(/查看示例/));

    expect(screen.getByText('GET /quote')).toBeTruthy();
    expect(radio(/实时行情/)).not.toBeChecked();
    expect(button(/收起示例/)).toBeTruthy();
  });
});

describe('提交期间（pending）', () => {
  it('⭐ 提交中：其余按钮全部置灰 —— 两颗一起转看着像两个请求都在飞', () => {
    renderBody({ questions: [QUESTIONS[0]], pending: 'submit' });

    expect(button(/跳过/)).toBeDisabled();
  });

  it('跳过中：提交按钮置灰，不能换成"提交一次"', () => {
    renderBody({ questions: [QUESTIONS[0]], pending: 'skip' });

    expect(button(/提\s*交/)).toBeDisabled();
  });
});
