// src/components/CopilotDock/InteractionMessage.tsx
//
// 一条 HITL 问答记录 —— 渲染成**我发出的那条消息**。
//
// 为什么要有它
// -----------
//   用户回答 `ask_user_question` 是通过 `Command(resume=…)` 回去的，不走普通
//   发消息那条路。后端 2026-10-20 起把这次问答落成一条 `role=user`、
//   `kind=interaction` 的消息（`message_recorder.record_interaction`），
//   否则刷新之后历史里只剩模型的 `tool_activity` —— 那段对话读起来像
//   "模型自问自答"，用户完全看不到自己答了什么。
//
// 为什么长得像用户气泡
// ----------------
//   语义上它就是用户说的话（role=user），只是带了"回答哪一问"的结构。
//   所以沿用用户气泡的**形态**（右对齐、主色淡底、圆角），内容做成
//   微信「回复某条消息」那样：先一条**引用**（灰底小字 + 左侧竖线，写清
//   我在回答什么），下面是我说的话。直接塞一段 `Q: … A: …` 的机读文本会让人
//   以为那是模型写的（后端确实也存了那么一份 text 块，见 InteractionView）。
//
// ⚠️ 不复用库的 `UserMessage`
// -----------------------
//   库那个组件只认 `message.content` 字符串（markdown + 图片渲染），
//   拿不到 `meta.interaction` 里的结构化问答；而且它会挂上"编辑"入口 ——
//   对一条已经回给模型的历史回答做编辑没有语义（改不了已经发生的事）。
//   这里自己画一张只读卡片，样式与用户气泡对齐（style.ts 的 interactionCard）。
//
// ⚠️ 答案可能为空
// ------------
//   用户点了「跳过」时后端仍会写这条记录（questions 在、answers 里少那一项）。
//   空答案画一条灰色「（未填写）」—— 留白会让人以为渲染坏了。

import React from 'react';

import type { InteractionView } from './history';
import { useStyles } from './style';

/** 一条问答记录 —— "我发出的那条消息"。 */
const InteractionMessage: React.FC<{ view: InteractionView }> = ({ view }) => {
  const { styles } = useStyles();

  return (
    <div className={styles.interactionCard} data-kind="interaction">
      {view.questions.map((question) => {
        const answer = view.answers[question.question] ?? '';
        return (
          <div key={question.question} className={styles.interactionItem}>
            {/*
              引用块 —— 仿微信「回复某条消息」：被回答的那一问缩成一条淡底、
              左侧带竖线的小字，我自己的回答在它下面。

              ⚠️ 为什么不再把问题画成"和答案同级的第二行"
              --------------------------------------------------
                同字号上下两行会被读成"两句话都是我发的"（用户反馈），
                而且看不出"这一问是我回应的对象"。引用块把层级一次讲清：
                灰底小字 = 别人问的，正文 = 我说的。

              ⚠️ 标签必须有（header 为空时用「问题」兜底）：微信那条引用
                上面永远有一行来源，没有它就像一段散落的灰字。
            */}
            <div className={styles.interactionQuote}>
              <span className={styles.interactionQuoteLabel}>
                {question.header !== '' ? question.header : '问题'}
              </span>
              <span className={styles.interactionQuoteText}>
                {question.question}
              </span>
            </div>
            <div
              className={
                answer === ''
                  ? styles.interactionAnswerEmpty
                  : styles.interactionAnswer
              }
            >
              {answer === '' ? '（未填写）' : answer}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default InteractionMessage;
