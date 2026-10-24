// src/components/CopilotDock/askUserQuestion.ts
//
// 后端 `agent.ask_user_question`（HITL 提问）的**载荷解析**与**答案组装**。
// 纯函数、不碰 React —— 组件只管画，判据全在这里，单测直接钉这些函数。
//
// 数据从哪来
// ---------
//   `hitl.requested` 的 `data`。后端的 `_publish_hitl_requested` 把 `interrupt()`
//   的字典**原样透传**、再补一个 `interrupt_id`（派发层不解释内容），所以形状是：
//
//       { "type": "ask_user_question",
//         "questions": [ { "question": "...", "header": "...",
//                          "options": [{"label","description","preview"}],
//                          "multiSelect": false } ],
//         "metadata": {"source": "planner"},
//         "tool_call_id": "...", "interrupt_id": "..." }
//
//   同一份 `questions` 在 `tool.called` 的 `input` 里也有一份（那是模型的参数），
//   两者**逐字相同**。前端取前者：它跟 `interrupt_id` 绑在一起，只有它能答回去。
//   后者只在载荷缺字段时兜底（见 runEventStream.ts 里 `askQuestions` 那段）。
//
// 答案怎么回去
// -----------
//   `resolve({ answers: { <问题原文>: <答案> } }, interruptId)`
//     → agent.ts `resumeDecision`（dict 原样过）
//     → `POST /runs/{run_id}/resume` 的 `data`。
//
//   后端 `_parse_resume` 认两种形状，这里用带 `answers` 的那种；key 必须是
//   **问题原文**（它也接受 `"0"` 这种下标，但原文更稳 —— 下标会随题目顺序变）。
//   多选的答案**拼成逗号分隔的字符串**：后端契约里 answer 就是 `string`
//   （`_answer_text` 用 `", "` 连接）。这里跟着用 `", "`，别用中文顿号 ——
//   模型拿到的是同一份字符串，两种写法它会当成两个答案。

/** 后端 `ask_user_question` 的 `type` 值。前端**只**靠它认这类中断。 */
export const ASK_USER_QUESTION_TYPE = 'ask_user_question';

/**
 * 后端那个工具的 tool_key（`agent.` + 函数名，见 hitl_tool.py 末尾）。
 *
 * ⚠️ 只在 `tool.called` 里认名字用（stash 兜底）。**不要**拿它当"要不要弹卡片"
 *   的判据 —— 那等于把"哪些工具会提问"这份配置抄到前端来。真正的判据是载荷里的
 *   `type`（见 `readQuestions`），它才是回答要用的那份数据的自述。
 */
export const ASK_USER_QUESTION_TOOL_KEY = 'agent.ask_user_question';

/** 一个选项。`preview` 后端可空，这里统一成空串（少一层 null 判断）。 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview: string;
}

/** 一个问题（后端 `Question` 模型的前端镜像）。 */
export interface AskUserQuestion {
  question: string;
  /** 短标题，后端限 12 字。可能为空 —— 那就不画标题。 */
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/**
 * 「其他（自己填）」在选中集合里的哨兵值。
 *
 * ⚠️ 用 `\u0000` 开头而不是 `"other"`：选项 label 是人写的短文本，
 *   理论上可能真叫 "other"。NUL 不可能出现在任何可显示文本里，撞不上。
 *   代价是这个值只在本文件内出现 —— 组装答案时一定要换成人填的内容。
 */
export const OTHER_OPTION = '\u0000other';

/** 一题的作答草稿。 */
export interface QuestionDraft {
  /** 选中的选项 label；含 `OTHER_OPTION` 表示选了"其他"。 */
  selected: string[];
  /** "其他"里手填的内容。只有选中 `OTHER_OPTION` 时才有意义。 */
  other: string;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 一个问题的载荷 → 前端模型。读不出来的部分**滤掉**，不猜。
 *
 * 三条过滤各有理由：
 *   · 没题面（`question` 为空）→ 丢弃整题：答回去的 key 就是题面，
 *     空 key 等于答了一个不存在的问题；
 *   · 没 label 的选项 → 丢弃：画出来是一行点不动的空白；
 *   · 题面**重复** → 只留第一条：答案按题面做 key（后端也是这么归一的），
 *     两条同题面在协议里就是同一个 key，后一条的答案会覆盖前一条 ——
 *     与其让用户答两遍只生效一遍，不如只问一遍。
 */
export function parseQuestions(value: unknown): AskUserQuestion[] {
  if (!Array.isArray(value)) return [];

  const questions: AskUserQuestion[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;

    const question = textOf(record.question).trim();
    if (!question || seen.has(question)) continue;
    seen.add(question);

    const options: AskUserQuestionOption[] = [];
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    for (const raw of rawOptions) {
      if (typeof raw !== 'object' || raw === null) continue;
      const option = raw as Record<string, unknown>;
      const label = textOf(option.label).trim();
      if (!label) continue;
      options.push({
        label,
        description: textOf(option.description).trim(),
        preview: textOf(option.preview),
      });
    }

    questions.push({
      question,
      header: textOf(record.header).trim(),
      options,
      multiSelect: record.multiSelect === true,
    });
  }

  return questions;
}

/**
 * 这批中断该不该按"提问"渲染 —— 读得出问题就按提问渲染。
 *
 * ⚠️ 判据用**载荷里的 `type`**，不用 tool_key / options 形状
 * -----------------------------------------------------
 *   · 认 tool_key 等于把"哪些工具会提问"抄进前端，配置一改前端就错；
 *   · 认 options 形状更糟：提问的选项是任意文本，审批的 options 恰好也是，
 *     两者在形状上分不开。
 *   `type` 是后端**为这件事专门加的那个字段**（hitl_tool.py 的 payload 第一行
 *   就是它），语义上没有歧义。
 *
 * ⚠️ `type` 缺失时**不**一票否决：那时只要 `questions` 读得出问题就认。
 *   反过来说，`type` 明确是**别的值**（比如将来的 `ask_user_confirm`）时
 *   一律不认 —— 那不归这个控件管，交回 `unknown` 兜底更诚实。
 */
export function readQuestions(
  interrupt: { metadata?: unknown } | null | undefined,
): AskUserQuestion[] {
  const meta = interrupt?.metadata;
  if (typeof meta !== 'object' || meta === null) return [];

  const record = meta as Record<string, unknown>;
  const type = textOf(record.hitlType);
  if (type !== '' && type !== ASK_USER_QUESTION_TYPE) return [];

  return parseQuestions(record.questions);
}

/** 空草稿。 */
export function emptyDraft(): QuestionDraft {
  return { selected: [], other: '' };
}

/**
 * 这一题答完了没有。
 *
 * 单选/多选都要求**至少选了一项**；选了"其他"还要求**真填了字** ——
 * 只勾一个空的"其他"送回去，后端拿到的是空串，等于没答。
 *
 * 不收 `question`：单选与多选在这条判据上没有区别（都是"选了 + 填了"），
 * 收了也只能闲置 —— 一个用不上的参数会让人以为这里还藏着别的规则。
 */
export function isAnswered(draft: QuestionDraft | undefined): boolean {
  if (!draft || draft.selected.length === 0) return false;
  if (!draft.selected.includes(OTHER_OPTION)) return true;
  return draft.other.trim() !== '';
}

/**
 * 一题的答案文本。多选按后端 `_answer_text` 的规则用 `", "` 连接。
 *
 * ⚠️ 单选只取**第一项**：协议里单选的 `selected` 本来就只有一项，这里不做出
 *   "多选了就全拼上"的宽容 —— 那会让前端的 bug 静默变成一个别的问题的答案。
 */
export function draftAnswer(
  question: AskUserQuestion,
  draft: QuestionDraft,
): string {
  const values = question.multiSelect
    ? draft.selected
    : draft.selected.slice(0, 1);

  const parts = values
    .map((value) => (value === OTHER_OPTION ? draft.other.trim() : value))
    .filter((value) => value !== '');

  return parts.join(', ');
}

/**
 * 草稿 → `resolve` 的载荷正文（`{ answers }` 里那部分）。
 *
 * 只收**答完的**题：没答的题不出现在 answers 里 —— 后端 `_parse_resume`
 * 只保留它问过的 key，少一个不会报错；反过来，送一个空串等于告诉模型
 * "用户说空"，那和"没答"是两件事。
 */
export function buildAnswers(
  questions: AskUserQuestion[],
  drafts: QuestionDraft[],
): Record<string, string> {
  const answers: Record<string, string> = {};

  questions.forEach((question, index) => {
    const draft = drafts[index];
    if (!isAnswered(draft)) return;
    const text = draftAnswer(question, draft as QuestionDraft);
    if (text !== '') answers[question.question] = text;
  });

  return answers;
}

/** 是不是每一题都答完了（提交按钮的可用条件）。 */
export function allAnswered(
  questions: AskUserQuestion[],
  drafts: QuestionDraft[],
): boolean {
  // 按下标走而不是 `questions.every((q, i) => ...)`：题面不参与判据，
  // 收一个用不上的参数（`_q`）只会让读的人以为这里还藏着别的规则。
  for (let index = 0; index < questions.length; index += 1) {
    if (!isAnswered(drafts[index])) return false;
  }
  return true;
}
