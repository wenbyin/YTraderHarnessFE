// src/components/CopilotDock/useSmoothFollow.ts
//
// 「已经在最底下看」时，新内容把旧内容顶上去 —— 要**滑**上去，不要瞬跳。
//
// 需求原话：「对话框在最下方时，新内容产生新行，要滑动上移」。
//
// 为什么不能只写一句 scroll-behavior: smooth
// ---------------------------------------
//   库自己（@copilotkit/react-ui 的 useScrollToBottom）挂了个 MutationObserver
//   监听 `.copilotKitMessages` 的 childList / subtree / **characterData**，每来
//   一个 delta 就 `container.scrollTop = container.scrollHeight`。那是**瞬跳**。
//   我们能改的只有 CSS，而 `scroll-behavior: smooth` 会把这次赋值变成一段
//   动画 —— 但下一次 delta（40~80ms 后）又赋一次，动画被反复打断重定向；
//   更要命的是库的 handleScroll 会把"动画途中 scrollTop+clientHeight <
//   scrollHeight"当成**用户往上滚了**（`isUserScrollUpRef = true`），
//   于是它从此不再自动滚 —— 面板会在流式中途**停住不动**。
//
// 所以这里自己接管滚动：
//   · 保留一个自己的 `pos`（我们每帧写进去的可视位置）；
//   · MutationObserver 一变就起 rAF，每帧 `pos += (target - pos) * LERP`，
//     然后写回 scrollTop —— 位置是"追"上去的，视觉上就是内容向上滑动；
//   · 库那次瞬跳会被我们**同一帧**（rAF 在微任务之后、绘制之前）覆盖掉，
//     所以用户看不到中间那一跳。
//
// ⚠️ 别把这套写成 setInterval：帧率/掉帧时位置会抖，而且后台标签页还在跑。
// ⚠️ 用户一往上滚就**必须**立刻停 —— 否则他在读上文，我们每帧把他拽回底部。
//    判据用 wheel/touch/keydown 的时间戳（400ms 内算"用户意图"），
//    没有用户意图的跳变一律当成"库的 scrollToBottom"，不更新 pos。

import type React from 'react';
import { useEffect } from 'react';

/** 每帧向目标靠近的比例。0.22 → 100px 的位移约 10 帧（160ms）走完 90%。 */
const LERP = 0.22;
/** 差这么少就认为到位了（亚像素级，继续追没有意义）。 */
const SETTLED = 0.5;
/** 离底部这么近就算"在最底下"。 */
const NEAR = 24;
/** 一次追超过这么多像素就不做补间（切会话 / 整份替换历史时的长距离跳）。 */
const MAX_JUMP = 600;
/** 用户操作之后的这段窗口里，scroll 事件才算"他在滚"。 */
const INTENT_MS = 400;

/**
 * 让对话区在"已经贴底"时平滑跟随新内容。
 *
 * @param paneRef 对话区的容器（我们会找它下面的 `.copilotKitMessages`）。
 */
export function useSmoothFollow(
  paneRef: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    const container = pane.querySelector<HTMLElement>('.copilotKitMessages');
    if (!container) return;

    /** 我们认定的"当前应显示的位置"。库的瞬跳不会改它。 */
    let pos = container.scrollTop;
    let raf = 0;
    let running = false;
    /** 是否处于"跟随底部"状态。用户上滚即关，滚回底部或发新消息再开。 */
    let following = true;
    /** 最近一次我们自己写进去的值 —— 用来认出"这条 scroll 不是用户滚的"。 */
    let written = Number.NaN;
    /** 最近一次用户操作（滚轮 / 触摸 / 按键）的时间戳。 */
    let lastIntent = 0;

    const max = () =>
      Math.max(0, container.scrollHeight - container.clientHeight);

    const write = (value: number) => {
      written = value;
      container.scrollTop = value;
    };

    const step = () => {
      raf = 0;
      if (!following) {
        running = false;
        return;
      }

      const target = max();
      const diff = target - pos;

      if (Math.abs(diff) <= SETTLED) {
        if (diff !== 0) write(target);
        pos = target;
        running = false;
        return;
      }

      // 往回（内容变短了）或者一次差太多 → 不补间，直接到位。
      if (diff < 0 || diff > MAX_JUMP) {
        pos = target;
        write(target);
        running = false;
        return;
      }

      pos += diff * LERP;
      write(pos);
      raf = requestAnimationFrame(step);
    };

    const kick = () => {
      if (!following || running) return;
      running = true;
      raf = requestAnimationFrame(step);
    };

    const markIntent = () => {
      lastIntent = Date.now();
    };

    const onWheel = (event: WheelEvent) => {
      markIntent();
      // 往上滚 = 他要读上文，立刻交还控制权。
      if (event.deltaY < 0) following = false;
    };

    const onScroll = () => {
      // 这一帧的位置就是我们自己写进去的 → 不是用户滚的。
      if (Math.abs(container.scrollTop - written) < 2) return;

      if (Date.now() - lastIntent > INTENT_MS) {
        // 没有用户意图的跳变 = 库的 scrollToBottom（每个 delta 都来一次）。
        // ⚠️ 这里**不能**把 pos 改成底部：改了就没有"从旧位置滑上去"这段了，
        //    等于回到瞬跳。让它留着，下一帧 rAF 会覆盖掉这次跳变（绘制之前）。
        return;
      }

      pos = container.scrollTop;
      following = max() - pos <= NEAR;
      if (following) kick();
    };

    const observer = new MutationObserver((records) => {
      // 用户刚发了一条消息 → 无条件回到跟随。
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const isUserMessage =
            node.matches('.copilotKitUserMessage') ||
            node.querySelector('.copilotKitUserMessage') !== null;
          if (isUserMessage) following = true;
        }
      }
      kick();
    });

    /**
     * ⚠️⚠️ 必须盯**容器自身的尺寸**
     * -------------------------
     *   消息区的底部留白（`.copilotKitMessages` 的 padding-bottom）读的是
     *   `--dock-tool-feed-h` —— 输入框上方那摞状态层（任务 dock / 胶囊）
     *   有多高，它就多高（见 LiveActivityOverlay 的 useReservedSpace）。
     *
     *   那是**样式变量**的变化，DOM 一个节点都没动 —— MutationObserver 完全
     *   看不见。于是任务 dock 出现（或展开）的那一瞬间：底部留白凭空多出
     *   60~300px，滚动位置却纹丝不动，**最后一条消息直接被 dock 盖住**。
     *   用户 2026-10-22 的截图就是这个：任务 2 的标题卡在最底下，正文被
     *   状态条压着。
     *
     *   盯容器自己就够：ResizeObserver 默认看 content-box，底部内边距变大
     *   → 内容盒变小 → 一次通知；`max()` 随之变大，kick 之后就是"内容平滑
     *   上移、让出位置"。
     *   ⚠️ 只在 `following` 时跟着走 —— 用户正在上面读历史，不能把他拽回来。
     */
    const resize = new ResizeObserver(() => {
      if (following) kick();
    });
    resize.observe(container);

    container.addEventListener('wheel', onWheel, { passive: true });
    // touchstart 只标意图；手机上真正要停的时候 scroll 那一路会接手。
    container.addEventListener('touchstart', markIntent, { passive: true });
    container.addEventListener('keydown', markIntent);
    container.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      resize.disconnect();
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', markIntent);
      container.removeEventListener('keydown', markIntent);
      container.removeEventListener('scroll', onScroll);
    };
  }, [paneRef]);
}
