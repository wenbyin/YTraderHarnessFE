// src/components/CopilotDock/ReasoningBlock.tsx
//
// 助手气泡**正上方**那块推理区：默认灰色折叠，点一下展开。
//
// 为什么它要在气泡外面、而不是塞进正文
// ----------------------------------
//   推理是模型的草稿纸 —— 里面有内部判据、被丢弃的分支、有时还有原始输入。
//   它与"给用户的答复"是两样东西，混进正文只有两种结局：要么草稿纸原样占
//   半屏（默认就是这么显示的，用户被迫读一段不是写给他的文字），要么得让
//   渲染层去猜"哪一段是草稿纸"。后端也正是这么分的：`content` 只放可见块、
//   推理单独走 `reasoning_content` 那一列（见 history.ts 的 reasoningOf）。
//
// ⚠️ 默认**折叠**
// --------------
//   需求原话是"默认灰色隐藏，点击展开显示推理内容"。展开态不是这个组件的
//   默认状态，也**不要**记住上一条的展开状态 —— 那会让"这次到底看不看"
//   变成一种跨消息的全局偏好，而每条消息的推理长度差得远。
//
// ⚠️ 这里**不渲染 markdown**
// -----------------------
//   与 ToolActivityRow 同一条理由：推理是模型流式吐出来的原文，不是排版好的
//   正文。按 markdown 渲染会把 `_`、`*`、缩进改掉 —— 那比不渲染更糟。
//   `white-space: pre-wrap` 原样保留换行。
//
// ⚠️ 展开/收起是**带动画**的，而"有没有动画"取决于内容当时在不在 DOM 里
// ------------------------------------------------------------------
//   收起那一瞬间就把原文卸掉的话，容器里当场没有可压缩的内容，高度动画无
//   从谈起 —— 视觉上就是"啪一下没了"。所以：
//     · 展开：`mounted` 与 `open` **在同一个事件里一起置位** → 同一帧里
//       "内容进场 + 容器 0fr → 1fr"，过渡才会真的跑（详见下面 toggle）；
//     · 收起：先只翻 `open`（内容留着让动画压），动画播完再卸载。
//   而**静置的折叠态里原文不在 DOM 里**（这条有单测钉着）：草稿纸默认就不该
//   出现在页面上，多留一份"看不见的原文"既是无谓节点、也让 DOM 检查失真。

import { BulbOutlined, RightOutlined } from '@ant-design/icons';
import React, { useEffect, useState } from 'react';

import type { ReasoningEntry } from './reasoningStream';
import { REASONING_ANIM_MS, useStyles } from './style';

/** 折叠时那一行说什么。流式与收尾是两种状态，别只用一句。 */
export function reasoningLabel(entry: ReasoningEntry): string {
  return entry.streaming ? '正在思考' : '思考过程';
}

const ReasoningBlock: React.FC<{ reasoning: ReasoningEntry }> = ({
  reasoning,
}) => {
  const { styles, cx } = useStyles();
  /** 用户的意图（也是按钮语义、`aria-expanded` 的来源）。 */
  const [open, setOpen] = useState(false);
  /**
   * 推理原文**此刻在不在 DOM 里**。
   *
   * ⚠️ 刻意与 `open` 分开：收起时它要**留到动画播完**才翻下去，否则内容当场
   *    消失、高度无处可压（见文件头那条）。
   */
  const [mounted, setMounted] = useState(false);

  // 只有"收起"这条路需要等：让高度动画播完再卸载原文。
  // 展开那条不等 —— 它由 toggle 同步置位（理由见下）。
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), REASONING_ANIM_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  const toggle = () => {
    if (open) {
      // 收起：**只**翻 open。原文留着，让动画把它压回去（卸载交给上面那个 effect）。
      setOpen(false);
      return;
    }
    // ⚠️ 两件事必须在**同一次事件**里做（React 会把它们批成同一帧）：
    //    先挂载、再置 open，于是这一帧里同时出现"新内容"和"0fr → 1fr"。
    //    要是把 `setMounted(true)` 挪进 effect（effect 在绘制之后才跑），就会
    //    变成"先把容器撑到 1fr（此时还没内容，高度 0）→ 下一帧内容才进来"，
    //    而行高比例这一帧并没有再变 —— 过渡压根不触发，内容直接蹦出来。
    setMounted(true);
    setOpen(true);
  };

  return (
    <div className={styles.reasoningBlock} data-reasoning-block="true">
      {/*
        ⚠️ 真正的 <button>：键盘可达、读屏能报出展开状态。
        折叠态也保留按钮 —— 它同时是"这里有推理"的唯一提示。
      */}
      <button
        type="button"
        className={styles.reasoningToggle}
        data-reasoning-toggle="true"
        data-reasoning-open={open ? 'true' : 'false'}
        aria-expanded={open}
        onClick={toggle}
      >
        <BulbOutlined aria-hidden />
        <span>{reasoningLabel(reasoning)}</span>
        {/*
          ⚠️ 这里**不画** loading 图标（2026-10-21 用户：「删除上方那个蓝色
          loading icon」）。
          「正在思考」这四个字本身就是状态；再加一枚转圈，会和输入框上沿那枚
          「正在组织回答…」胶囊变成**两个 loading** 同时在动 —— 而且这一行
          会随每一段推理重新出现，闪得比胶囊频繁。
          标签仍然区分"流式 / 收尾"两种文案（见 reasoningLabel），信号没丢。
        */}
        <RightOutlined
          className={cx(
            styles.reasoningCaret,
            open && styles.reasoningCaretOpen,
          )}
          aria-hidden
        />
      </button>

      {/*
        高度动画的壳：**常驻**。`data-reasoning-open` 既是 CSS 里 0fr ↔ 1fr 的
        开关，也是探针/单测判断"此刻展开还是收起"的钩子。
      */}
      <div
        className={styles.reasoningBodyWrap}
        data-reasoning-body-wrap="true"
        data-reasoning-open={open ? 'true' : 'false'}
      >
        <div className={styles.reasoningBodyClip}>
          {mounted && (
            <div
              className={styles.reasoningBody}
              data-reasoning-body="true"
              // 收起动画播放期间这条已经"名义上关掉"了，别让它留在无障碍树里。
              aria-hidden={!open}
            >
              {reasoning.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReasoningBlock;
