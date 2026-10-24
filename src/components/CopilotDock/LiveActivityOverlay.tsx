// src/components/CopilotDock/LiveActivityOverlay.tsx
//
// 输入框上方那一层「正在干什么」：一枚胶囊（「正在调用工具…」/看不见正文的
// 模型调用那几种文案）。
//
// ⚠️ 工具记录那一摞**已经搬走**（2026-10-18）
// ----------------------------------------
//   原先这一层还画"已经跑完的工具，各占一行「工具调用：<名字>」"，靠
//   `justify-content: flex-end` 贴输入框上沿。问题是它的位置**恒在正文下方**：
//   模型还在流式写、工具已经跑完时，那一摞就挂在正文末尾，看起来像
//   "工具调用跑到了回答下面"（用户原话）。而真实顺序是先工具、后回答。
//
//   现在改由 DockRenderMessage 画在**最后一条正文之上**（消息流里，见
//   liveToolFeed.ts 的文件头）：实时与刷新后的历史终于在同一位置，
//   也不再需要给消息区预留"工具记录的高度"这块额外留白。
//
//   这一层于是只剩胶囊 —— 它是"此刻正在发生的事"，本来就该浮在输入框上沿
//   （用户滚到上面读历史时也能看见它）。
//
// ⚠️ 为什么不是一条消息
// ------------------
//   实时这一侧**塞不进 messages**：`@ag-ui/client` 的 `defaultApplyEvents`
//   在流开始时就把 `agent.messages` 克隆成局部数组，之后每帧基于同一份克隆重算
//   并整份回写；中途插进去的消息下一帧就被覆盖（详见 runEventStream.ts 的
//   文件头）。所以走平行通道 —— 渲染在 CopilotChat 之外、贴输入框上沿。
//
// ⚠️ 位置与遮挡
// -----------
//   这一层是 absolute、`pointer-events: none`（不挡输入框与消息里的链接）。
//
//   ⚠️ 外框（hiddenWorkLayer）是**铺满整块消息区**的（inset-block: 0 …），
//   内容单独在 hiddenWorkStack 里、高度自适应。给消息区预留的底部留白
//   （--dock-tool-feed-h）**只能量内容那一层** —— 量外框会得到"整个消息区
//   有多高"，消息会被整片空白顶出可视区（用户报的"发完消息全变空"）。
//
// ⚠️ 「正在调用工具」不说工具名
// ------------------------
//   需求原话："loading 可以显示，正在调用工具，但是不用说是什么工具"。
//   所以 `running > 0` 时固定这一句。
//   同理，这时**不再**显示节点那一侧的「正在执行工具」—— 同一件事的两种说法
//   叠在一起只会看起来像两个 loading。

import { LoadingOutlined } from '@ant-design/icons';
import React, { useLayoutEffect, useRef } from 'react';

import PlanStatusBars from './PlanStatusBars';
import type { PlanView } from './planTasks';
import { progressLabel } from './runEventStream';
import { useStyles } from './style';
import type { HiddenWork } from './useHiddenWork';
import type { LiveToolActivity } from './useToolActivity';

/** 正在调用工具时那行字 —— 不带工具名（见文件头）。 */
export const TOOL_RUNNING_LABEL = '正在调用工具';

/**
 * 把**这一层里的内容**有多高告诉对话区 —— 它读 `--dock-tool-feed-h`
 * 给消息区加底部留白。
 *
 * ⚠️ 为什么必须同步这个值
 * -------------------
 *   这一层是 absolute、贴输入框上沿的。不预留空间的话，它会**盖住最后一条
 *   消息的末尾**：消息区滚到底时，最后一行正好落在这块底下，用户得往上
 *   滚一点才看得见 —— 而"最新的一条被自己的状态条挡住"是很典型的差体验。
 *
 * ⚠️⚠️ 必须量**内容**（hiddenWorkStack），不能量这一层的外框（layer）
 * ---------------------------------------------------------------
 *   外框是 `inset-block: 0 var(--dock-input-h)` —— 它**铺满整块消息区**，
 *   只是为了 justify-content: flex-end 把内容压到输入框上沿。量它得到的是
 *   "消息区有多高"（实测 663px），而这个值被写进 `.copilotKitMessages` 的
 *   padding-bottom：
 *
 *     padding-bottom = 8px + 663px = 666px（消息区自己也才 679px）
 *
 *   于是消息区里多出**一整屏的空白**，而 CopilotKit 在用户消息进来那一刻
 *   会 `scrollTop = scrollHeight`（useScrollToBottom）—— 直接滚到那片空白上，
 *   已有消息被顶到可视区之外，面板看上去**全白**，只剩输入框上沿那枚
 *   「正在整理上下文…」胶囊（它是 absolute，不受 padding 影响）。
 *   用户截图就是这个：发完消息一瞬间对话区全空，回答开始流（胶囊消失、
 *   留白归零）才又看得见。
 *
 *   同一个原因还会让空态问候语看起来"没了"：它靠 `--dock-input-h` 居中，
 *   但消息区底下被撑出 666px，视觉重心整个跑掉。
 *
 *   所以量的是内容那一层（高度自适应）。它变了（多一行工具、胶囊出现 /
 *   消失、文案换行）靠 ResizeObserver 跟；jsdom / happy-dom 里没有布局、
 *   `offsetHeight` 恒为 0，于是测试环境里这个值恒为 0，不影响任何断言。
 */
function useReservedSpace(
  layerRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>,
  deps: readonly unknown[],
) {
  useLayoutEffect(() => {
    const layer = layerRef.current;
    // 变量写在对话区上 —— 层是它的直属子元素，别顺着内容层往上找（那会落到层自己身上）。
    const pane = layer?.parentElement;
    const content = contentRef.current;
    if (!pane) return;

    const apply = () => {
      pane.style.setProperty(
        '--dock-tool-feed-h',
        `${content?.offsetHeight ?? 0}px`,
      );
    };
    apply();

    const reset = () => pane.style.setProperty('--dock-tool-feed-h', '0px');

    if (typeof ResizeObserver === 'undefined' || !content) return reset;

    const observer = new ResizeObserver(apply);
    observer.observe(content);
    return () => {
      observer.disconnect();
      reset();
    };
    // 依赖由调用点给：高度只由"有几行 + 有没有胶囊 + 什么文案"决定，
    // 那三样变了重新量一次就够（不是每次渲染都量）。
  }, deps);
}

const LiveActivityOverlay: React.FC<{
  /** 看不见正文的模型调用 / 节点进度（`useHiddenWork`）。 */
  work: HiddenWork | null;
  /** 本轮的工具调用（`useToolActivity`）。 */
  tools: LiveToolActivity;
  /**
   * 这一轮的任务计划（`usePlanFeed`）；`null` / 不传 = 没有计划。
   *
   * ⚠️ 可选而不是必填：这一层的主职仍是那枚胶囊，任务栏是后加的乘客。
   *   调用点（index.tsx）永远会传；但让它是必填会把一堆"只测胶囊"的用例
   *   逼着编一份假计划出来 —— 那些用例关心的根本不是这件事。
   */
  plan?: PlanView | null;
}> = ({ work, tools, plan = null }) => {
  const { styles } = useStyles();
  const layerRef = useRef<HTMLDivElement | null>(null);
  /** 内容那一层 —— **预留高度量的是它**（不能量外框，见 useReservedSpace）。 */
  const contentRef = useRef<HTMLDivElement | null>(null);

  // ⚠️ hook 必须在 early return **之前**调。
  //    依赖里必须带 `plan`：任务栏出现/展开/收起都会改变内容高度，
  //    不带的话"消息区底部留白"会停在旧值上 —— 展开的任务列表会盖住最后一条消息。
  useReservedSpace(layerRef, contentRef, [work, tools.running, plan]);

  // 工具在跑时以它为准：节点那侧的「正在执行工具」是同一件事的另一种说法。
  const label =
    tools.running > 0 ? TOOL_RUNNING_LABEL : work ? progressLabel(work) : '';

  /*
   * ⚠️ 判据从"有没有胶囊"改成"有没有东西要显示"
   * ----------------------------------------
   *   这一层原先会在 `label === ''` 时整块返回 null。现在它还驮着任务计划
   *   那两条状态栏 —— 计划在跑、但模型正在出字（胶囊已经让位）是最常见的
   *   一种情形，按胶囊判会让任务栏在回答一开始就消失。
   */
  if (label === '' && !plan) return null;

  return (
    <div
      ref={layerRef}
      className={styles.hiddenWorkLayer}
      data-live-activity-layer="true"
    >
      {/*
        内容层：外层是铺满消息区的定位层（justify-content: flex-end 把内容压到
        输入框上沿），**只有这一层的高度才是该预留的高度** —— 见 useReservedSpace。
      */}
      <div
        ref={contentRef}
        className={styles.hiddenWorkStack}
        data-live-activity-stack="true"
      >
        {/* 胶囊在上、任务 dock 在下：dock 是"输入框的第二行"，该贴着输入框。 */}
        {label === '' ? null : (
          <div
            className={styles.hiddenWorkChip}
            data-hidden-work="true"
            data-work-kind={tools.running > 0 ? 'tool' : 'work'}
            data-work-node={work?.node ?? 'none'}
            data-work-role={work?.role ?? 'none'}
            role="status"
          >
            {/* ⚠️ `spin` 必须写：antd 的 LoadingOutlined 默认**不转**，
                少这一个属性就成了个静止的圆圈。 */}
            <LoadingOutlined spin aria-hidden />
            <span>{label}…</span>
          </div>
        )}
        <PlanStatusBars plan={plan} />
      </div>
    </div>
  );
};

export default LiveActivityOverlay;
