// src/components/CopilotDock/askUserQuestion.test.ts
//
// 提问控件的**判据**都在这几个纯函数里（组件只管画）：
//   ① 载荷 → 前端模型（parseQuestions / readQuestions）—— 读不出来的部分必须滤掉，
//      因为答案是按**问题原文**做 key 的，脏数据会让某一题永远答不上；
//   ② 草稿 → 答案（isAnswered / draftAnswer / buildAnswers）—— 形状必须与后端
//      `_parse_resume` 对齐：key 是问题原文、多选拼成 ", "、空的不发。
//
// ⚠️ 这里刻意不测组件：AskUserQuestionBody.test.tsx 管画和交互，
//   两边分开才能让"判据错了"和"画错了"一眼分得清。
import { describe, expect, it } from 'vitest';
import {
  ASK_USER_QUESTION_TYPE,
  allAnswered,
  buildAnswers,
  draftAnswer,
  emptyDraft,
  isAnswered,
  OTHER_OPTION,
  parseQuestions,
  type QuestionDraft,
  readQuestions,
} from './askUserQuestion';

const RAW_QUESTION = {
  question: '用哪个数据源？',
  header: '数据源',
  options: [
    { label: '实时行情', description: 'T+0 的报价', preview: 'GET /quote' },
    { label: '历史库', description: '含复权因子' },
  ],
  multiSelect: false,
};

describe('parseQuestions：后端载荷 → 前端模型', () => {
  it('正常形态逐字段读出来，缺省项补成空串 / false', () => {
    expect(parseQuestions([RAW_QUESTION])).toEqual([
      {
        question: '用哪个数据源？',
        header: '数据源',
        options: [
          {
            label: '实时行情',
            description: 'T+0 的报价',
            preview: 'GET /quote',
          },
          { label: '历史库', description: '含复权因子', preview: '' },
        ],
        multiSelect: false,
      },
    ]);
  });

  it('⭐ 没有题面的丢掉整题 —— 答案是按题面做 key 的，空 key 等于答了一个不存在的问题', () => {
    expect(
      parseQuestions([
        { options: [{ label: 'a' }] },
        { question: '   ', options: [{ label: 'a' }] },
      ]),
    ).toEqual([]);
  });

  it('没有 label 的选项丢掉（画出来是一行点不动的空白），但题目本身还在', () => {
    const [question] = parseQuestions([
      {
        question: 'q',
        header: 'h',
        options: [{ label: '' }, { description: '没标签' }, { label: 'ok' }],
      },
    ]);

    expect(question.options).toEqual([
      { label: 'ok', description: '', preview: '' },
    ]);
  });

  it('⭐ 题面重复只留第一条 —— 协议里两条同题面就是同一个 key，后一条会覆盖前一条', () => {
    const parsed = parseQuestions([
      { question: '一样', options: [{ label: 'a' }] },
      { question: '一样', options: [{ label: 'b' }] },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].options[0].label).toBe('a');
  });

  it('multiSelect 只认真正的 true —— 字符串 "false" 不算多选', () => {
    const [question] = parseQuestions([
      { question: 'q', options: [{ label: 'a' }], multiSelect: 'false' },
    ]);

    expect(question.multiSelect).toBe(false);
  });

  it('不是数组 / 一堆非对象 → 空清单（不是"给一个空题"）', () => {
    expect(parseQuestions(undefined)).toEqual([]);
    expect(parseQuestions('[]')).toEqual([]);
    expect(parseQuestions([null, 1, 'x'])).toEqual([]);
  });
});

describe('readQuestions：这批中断到底是不是"提问"', () => {
  it('type 是 ask_user_question → 认', () => {
    const questions = readQuestions({
      metadata: { hitlType: ASK_USER_QUESTION_TYPE, questions: [RAW_QUESTION] },
    });

    expect(questions).toHaveLength(1);
  });

  it('⭐ type 是别的值 → 一律不认（那不归这个控件管，交回 unknown 兜底更诚实）', () => {
    expect(
      readQuestions({
        metadata: { hitlType: 'ask_user_confirm', questions: [RAW_QUESTION] },
      }),
    ).toEqual([]);
  });

  it('type 缺失但题面读得出来 → 认（老后端 / 载荷被裁剪时不该白丢一张卡）', () => {
    expect(
      readQuestions({ metadata: { questions: [RAW_QUESTION] } }),
    ).toHaveLength(1);
  });

  it('没有 metadata / metadata 不是对象 → 空', () => {
    expect(readQuestions(null)).toEqual([]);
    expect(readQuestions({})).toEqual([]);
    expect(readQuestions({ metadata: 'x' })).toEqual([]);
  });

  it('⭐ 审批帧（有 options、没有 questions）不会被误认成提问', () => {
    expect(
      readQuestions({
        metadata: { options: ['approve', 'reject'], toolKey: 'agent.x' },
      }),
    ).toEqual([]);
  });
});

describe('作答判据', () => {
  const single = { ...parseQuestions([RAW_QUESTION])[0] };

  it('没选任何一项 → 没答完', () => {
    expect(isAnswered(emptyDraft())).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
  });

  it('选了普通选项 → 答完', () => {
    expect(isAnswered({ selected: ['实时行情'], other: '' })).toBe(true);
  });

  it('⭐ 只勾了「其他」但没填字 → 没答完（送回去是空串，等于没答）', () => {
    expect(isAnswered({ selected: [OTHER_OPTION], other: '   ' })).toBe(false);
    expect(isAnswered({ selected: [OTHER_OPTION], other: '按分钟线' })).toBe(
      true,
    );
  });

  it('单选只取第一项 —— 多选了也全拼上是"宽容"，会把前端 bug 变成一个别的问题的答案', () => {
    expect(
      draftAnswer(single, { selected: ['实时行情', '历史库'], other: '' }),
    ).toBe('实时行情');
  });

  it('多选按后端的规则用 ", " 连接（`_answer_text` 就是 join ", "）', () => {
    const multi = { ...single, multiSelect: true };
    expect(
      draftAnswer(multi, { selected: ['实时行情', '历史库'], other: '' }),
    ).toBe('实时行情, 历史库');
  });

  it('「其他」用的是**手填的内容**，不是那个哨兵值', () => {
    const multi = { ...single, multiSelect: true };
    const draft: QuestionDraft = {
      selected: ['实时行情', OTHER_OPTION],
      other: '  按分钟线  ',
    };

    expect(draftAnswer(multi, draft)).toBe('实时行情, 按分钟线');
  });
});

describe('buildAnswers：草稿 → resolve 的载荷', () => {
  const questions = parseQuestions([
    RAW_QUESTION,
    {
      question: '要哪些字段？',
      header: '字段',
      options: [{ label: '收盘价' }, { label: '成交量' }],
      multiSelect: true,
    },
  ]);

  it('key 是问题原文，多选拼成逗号分隔', () => {
    expect(
      buildAnswers(questions, [
        { selected: ['实时行情'], other: '' },
        { selected: ['收盘价', '成交量'], other: '' },
      ]),
    ).toEqual({
      '用哪个数据源？': '实时行情',
      '要哪些字段？': '收盘价, 成交量',
    });
  });

  it('⭐ 没答完的题**不出现在** answers 里 —— 空串会被模型当成"用户说空"', () => {
    expect(
      buildAnswers(questions, [
        { selected: ['实时行情'], other: '' },
        emptyDraft(),
      ]),
    ).toEqual({ '用哪个数据源？': '实时行情' });
  });

  it('一道都没答 → 空对象（「跳过」发的就是它，后端认这个形状）', () => {
    expect(buildAnswers(questions, [emptyDraft(), emptyDraft()])).toEqual({});
  });

  it('allAnswered 要求每一题都答完', () => {
    expect(
      allAnswered(questions, [
        { selected: ['实时行情'], other: '' },
        emptyDraft(),
      ]),
    ).toBe(false);
    expect(
      allAnswered(questions, [
        { selected: ['实时行情'], other: '' },
        { selected: ['收盘价'], other: '' },
      ]),
    ).toBe(true);
  });
});
