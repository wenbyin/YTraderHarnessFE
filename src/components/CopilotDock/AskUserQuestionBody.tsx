// src/components/CopilotDock/AskUserQuestionBody.tsx
//
// `agent.ask_user_question` 的**问题控件**：1–4 道题，一次显示一道，答完提交。
//
// 为什么是"一道一道"而不是把 4 道摊在一张卡里
// ------------------------------------
//   这张卡是**贴底浮层**（跟审批卡同一个壳，见 HitlInterrupt.tsx 的文件头）：
//   它只能用对话区下方那一段高度。一道题最多 4 个选项 + 每项一行说明，
//   四道题摊开就是二十来行 —— 必然滚出可视区，而浮层一旦高过对话区，
//   上面压住的是用户正想读的上文。一次一道还有个附带好处：卡片高度稳定，
//   点「下一题」不会让整块跳一下。
//
// 为什么控件自己管草稿、提交时才组装
// ----------------------------
//   `resolve` 的载荷是"整组答案"（`{ answers: { <问题原文>: <答案> } }`），
//   而用户是一题一题答的。草稿留在本地、**提交那一刻**才组装，
//   中途每一题都不产生任何请求 —— 后端的 resume 是"一次回答当前所有待答项"，
//   答一半送上去只会 409（见 HitlInterrupt.tsx 文件头那段）。
//
// 与审批卡的分工
// ------------
//   外壳（贴底层、图标、位次、锁输入框、多中断翻页、重复提交去重）全部复用
//   HitlInterrupt 的 HitlCard；这里只画"中间那段"和它自己的按钮。
//   所以本文件**不认识** resolve / interrupt —— 只往上报 `{ answers }`。
import {
  Button,
  Checkbox,
  Input,
  Radio,
  type RadioChangeEvent,
  Tag,
} from 'antd';
import React, { useState } from 'react';
import {
  type AskUserQuestion,
  allAnswered,
  buildAnswers,
  emptyDraft,
  isAnswered,
  OTHER_OPTION,
  type QuestionDraft,
} from './askUserQuestion';
import { useStyles } from './style';

export interface AskUserQuestionBodyProps {
  questions: AskUserQuestion[];
  /**
   * 正在提交的按钮（`'submit'` / `'skip'`），`null` = 空闲。
   * 与审批卡一样存"哪一颗"而不是布尔量：只让被点的那颗转圈。
   */
  pending: string | null;
  /** 提交（或跳过）。`answers` 已经按后端契约组装好，可能是空集。 */
  onResolve: (
    answers: Record<string, string>,
    action: 'submit' | 'skip',
  ) => void;
}

export const AskUserQuestionBody: React.FC<AskUserQuestionBodyProps> = ({
  questions,
  pending,
  onResolve,
}) => {
  const { styles } = useStyles();

  /** 正在答第几题（0 基）。 */
  const [index, setIndex] = useState(0);
  /** 每题一份草稿。与 `questions` 同长、同序。 */
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    questions.map(() => emptyDraft()),
  );
  /** 展开了哪些"示例预览"。key 是 `题号|选项label`，翻页回来还记得。 */
  const [previews, setPreviews] = useState<string[]>([]);

  const question = questions[index];
  // 空题组不该走到这里（HitlCard 只在读得出问题时才渲染本组件），
  // 但渲染期返回 null 比抛错好 —— 一张空白卡总比整块对话区崩掉强。
  if (!question) return null;

  const draft = drafts[index] ?? emptyDraft();
  const busy = pending !== null;

  const patch = (next: Partial<QuestionDraft>) => {
    setDrafts((prev) =>
      prev.map((item, at) => (at === index ? { ...item, ...next } : item)),
    );
  };

  const togglePreview = (key: string) => {
    setPreviews((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  };

  /**
   * 一个选项行：指示器 + 文字（选项 + 说明）。
   *
   * ⚠️ 单选/多选在这里分叉，但**只有这一处** —— 外面的行结构、预览、
   *   按钮全部共用。
   *
   * ⚠️ 为什么多选不用 `<Checkbox.Group>`（看着才对称）
   * ---------------------------------------------
   *   Group 的 `value` / `onChange` 跟我们逐项受控是同一件事（都是"选中集合"），
   *   但一旦包上 Group，`Checkbox` 的 `value` 就成了必填项 —— 而这个仓库必跑
   *   的 `npx antd lint` 在静态分析里**只认 JSX 字面嵌套**，看不到这个
   *   `choice()` 最终会被渲染进 Group 里，于是误报
   *   `Checkbox value is not a valid prop outside Checkbox.Group`。
   *   逐项受控既避开这条误报，也少一层受控转发；代价是 `disabled` 要自己传。
   *
   *   单选那边保持 `<Radio.Group>`：它给的是原生 `radiogroup` 语义与方向键
   *   在选项间移动的能力，这两样自己实现不划算（而且 `Radio` 的 `value`
   *   本来就是个合法独立属性，不会被 lint 盯上）。
   */
  const choice = (value: string, body: React.ReactNode) =>
    question.multiSelect ? (
      <Checkbox
        className={styles.auqChoice}
        checked={draft.selected.includes(value)}
        disabled={busy}
        onChange={(event) =>
          patch({
            selected: event.target.checked
              ? [...draft.selected, value]
              : draft.selected.filter((item) => item !== value),
          })
        }
      >
        {body}
      </Checkbox>
    ) : (
      <Radio value={value} className={styles.auqChoice}>
        {body}
      </Radio>
    );

  const rows = [
    ...question.options.map((option) => {
      const key = `${index}|${option.label}`;
      const open = previews.includes(key);
      return (
        <div key={option.label} className={styles.auqOption}>
          {choice(
            option.label,
            <span className={styles.auqOptionText}>
              <span className={styles.auqOptionLabel}>{option.label}</span>
              {option.description ? (
                <span className={styles.auqOptionDesc}>
                  {option.description}
                </span>
              ) : null}
            </span>,
          )}
          {/* 预览的开关**在 label 外面**：放进 Radio 的 children 里，
              点它会连带激活那个 label（等于顺手选了这一项）。 */}
          {option.preview ? (
            <button
              type="button"
              className={styles.auqPreviewToggle}
              disabled={busy}
              onClick={() => togglePreview(key)}
            >
              {open ? '收起示例' : '查看示例'}
            </button>
          ) : null}
          {option.preview && open ? (
            <pre className={styles.auqPreview}>{option.preview}</pre>
          ) : null}
        </div>
      );
    }),
    // 「其他」永远最后一行：后端明确说不要在自己的 options 里给"其他"，
    // 用户可以用它自由输入（hitl_tool.py 的 Question.options 说明）。
    <div key={OTHER_OPTION} className={styles.auqOption}>
      {choice(
        OTHER_OPTION,
        <span className={styles.auqOptionText}>
          <span className={styles.auqOptionLabel}>其他（自己填）</span>
        </span>,
      )}
      {draft.selected.includes(OTHER_OPTION) ? (
        <Input.TextArea
          className={styles.auqOtherInput}
          value={draft.other}
          onChange={(event) => patch({ other: event.target.value })}
          placeholder="填上你想说的，它会原样作为这一题的答案"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={busy}
        />
      ) : null}
    </div>,
  ];

  const answered = isAnswered(draft);
  const last = index === questions.length - 1;

  return (
    <>
      <div className={styles.auqHead}>
        {question.header ? (
          <Tag className={styles.auqHeader}>{question.header}</Tag>
        ) : null}
        {/* 只有一道题时不显示"第 1/1 题" —— 那是纯噪音（与多中断位次同一条理由）。 */}
        {questions.length > 1 ? (
          <span className={styles.auqProgress}>
            第 {index + 1} / {questions.length} 题
          </span>
        ) : null}
        {question.multiSelect ? (
          <span className={styles.auqHint}>可多选</span>
        ) : null}
      </div>

      <div className={styles.auqBody}>
        <p className={styles.auqQuestion}>{question.question}</p>

        {question.multiSelect ? (
          // 逐项受控，不套 Checkbox.Group —— 理由见 choice() 上面那段。
          // <fieldset> 而不是 div + role="group"：这里就是"一组相关控件 + 一个组名"，
          // fieldset 是它的原生语义（biome 的 useSemanticElements 也只认这个）。
          // 浏览器默认样式已在 auqGroup 里清掉。
          <fieldset className={styles.auqGroup} aria-label={question.question}>
            {rows}
          </fieldset>
        ) : (
          <Radio.Group
            className={styles.auqGroup}
            value={draft.selected[0]}
            disabled={busy}
            onChange={(event: RadioChangeEvent) =>
              patch({ selected: [String(event.target.value)] })
            }
          >
            {rows}
          </Radio.Group>
        )}
      </div>

      <div className={styles.hitlActions}>
        {index > 0 ? (
          <Button
            size="small"
            disabled={busy}
            onClick={() => setIndex(index - 1)}
          >
            上一题
          </Button>
        ) : null}

        {last ? (
          <Button
            size="small"
            type="primary"
            loading={pending === 'submit'}
            disabled={
              (busy && pending !== 'submit') || !allAnswered(questions, drafts)
            }
            onClick={() => onResolve(buildAnswers(questions, drafts), 'submit')}
          >
            提交
          </Button>
        ) : (
          <Button
            size="small"
            type="primary"
            // ⚠️ 没答完就不能翻页：翻过去之后这一题没有任何入口能回来补
            //   （只有"上一题"能回，而用户未必想得到）。
            disabled={busy || !answered}
            onClick={() => setIndex(index + 1)}
          >
            下一题
          </Button>
        )}

        {/*
          「跳过」= 把**已经填好的**答案交回去（可能一道都没填 = 空集）。
          它必须存在：这个控件不答，后端就一直停在 waiting_input，整个会话
          连新运行都建不了（409）。空集是后端认的合法恢复值 —— `_parse_resume`
          对 `{"answers": {}}` 返回空答案，工具正常返回，模型据此继续。
        */}
        <Button
          size="small"
          type="text"
          loading={pending === 'skip'}
          disabled={busy && pending !== 'skip'}
          onClick={() => onResolve(buildAnswers(questions, drafts), 'skip')}
        >
          跳过
        </Button>
      </div>
    </>
  );
};

export default AskUserQuestionBody;
