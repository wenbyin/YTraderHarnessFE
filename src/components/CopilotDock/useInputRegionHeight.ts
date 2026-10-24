// src/components/CopilotDock/useInputRegionHeight.ts
//
// 把「对话区底边 → 输入框上沿」的**实测**距离写进 `--dock-input-h`。
//
// ⚠️ 为什么不能再写一个常数
// ----------------------
//   style.ts 的 chatPane 里原来是 `--dock-input-h: 186px`，算法是
//   「输入框 146 + Powered by 24 + 下外边距 16」。问题是这三截里有两截
//   **不由我们决定**：Powered by 在接了 Copilot Cloud 时根本不渲染，
//   输入框自身的高度还会随正文行数长到 240。
//   一旦实际值比常数小，dock 就被顶到输入框上方几十像素 —— 用户 2026-10-22
//   报的"下方和 input 框间距太大"就是这么来的（实测差了 40px 左右）。
//
//   所以这里量**几何**而不是算常数：
//     gap = 对话区底边 - 输入框上沿
//   它天然把 Powered by、外边距、内边距、输入框自身高度全算进去，
//   中间任何一处变了都跟着对。
//
// ⚠️ 谁在用这个变量
//   · hiddenWorkLayer / hitlLayer 的 `inset-block-end`（贴输入框上沿的那两层）
//   · emptyHint 的垂直居中（要压在**消息区**中心，不是整个对话区）
//   所以这个 hook 挂在 index.tsx（对话区常驻），**不能**挂在会卸载的浮层里 ——
//   浮层一卸载变量就跟着失效，那几处的定位会跳一下。
//
// ⚠️ jsdom / happy-dom 里没有布局，两个 rect 都是 0 → gap 为 0 → 直接跳过，
//    CSS 里的 186px 兜底值留着，测试不受影响。

import { type RefObject, useLayoutEffect } from 'react';

/** 输入框的稳定选择器（我们自己的 Composer 渲染的就是这个类）。 */
const INPUT_SELECTOR = '.copilotKitInput';

export function useInputRegionHeight(
  paneRef: RefObject<HTMLDivElement | null>,
  /**
   * 切会话时 CopilotKit 整棵重挂（`key={activeId}`），输入框是**新节点** ——
   * 老的 ResizeObserver 盯着一个已经脱离文档的元素，永远不会再触发。
   * 用会话 id 当依赖，换会话就重新找、重新盯。
   */
  sessionKey: string,
): void {
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    const measure = () => {
      // 每次现查：会话切换后旧节点已经不在文档里了。
      const input = pane.querySelector<HTMLElement>(INPUT_SELECTOR);
      if (!input) return;
      const gap =
        pane.getBoundingClientRect().bottom - input.getBoundingClientRect().top;
      if (gap > 0) {
        pane.style.setProperty('--dock-input-h', `${Math.round(gap)}px`);
      }
    };

    measure();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measure);
    // 对话区自身缩放（拖面板宽度 / 换窗口大小）
    observer.observe(pane);
    // 输入框长高（正文写超一屏 → textarea 到 240 上限）：对话区尺寸不变，
    // 只有它变，所以必须单独盯。
    const input = pane.querySelector<HTMLElement>(INPUT_SELECTOR);
    if (input) observer.observe(input);

    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [paneRef, sessionKey]);
}
