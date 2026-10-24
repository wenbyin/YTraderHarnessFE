// src/components/CopilotDock/useSmoothFollow.test.tsx
//
// 「对话框在最下方时，新内容产生新行要**滑动上移**」。
//
// 这里钉的不是"滚动到不到底"，而是**怎么到底**：
//   · 库（@copilotkit/react-ui 的 useScrollToBottom）每个 delta 都 `scrollTop =
//     scrollHeight` 瞬跳一次，我们要把它变成一段补间；
//   · 而且不能因此把用户"往上滚"的意图吃掉（他在读上文时不许被拽回底部）。
//
// happy-dom 没有布局，scrollHeight / clientHeight 恒为 0 —— 所以这里**显式**把它们
// 桩掉，rAF 也换成一个手动队列，这样"某一次回调之后到了第几像素"是可断言的。
import { fireEvent, render } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSmoothFollow } from './useSmoothFollow';

/** 复刻 CopilotKit 的 DOM：对话区 → .copilotKitMessages → 容器 → 文字。 */
function Harness() {
  const paneRef = useRef<HTMLDivElement | null>(null);
  useSmoothFollow(paneRef);

  return (
    <div ref={paneRef}>
      <div className="copilotKitMessages">
        <div className="copilotKitMessagesContainer">
          <span data-testid="text">正文</span>
        </div>
      </div>
    </div>
  );
}

interface Setup {
  container: HTMLElement;
  scroller: HTMLElement;
  /** 手动跑一帧（返回是不是还有下一帧）。 */
  frame: () => boolean;
  /** 改内容，触发 MutationObserver（= 来了一次 delta）。 */
  push: (text: string) => Promise<void>;
  /** 改内容高度（= 新行把内容顶长了）。 */
  resize: (scrollHeight: number) => void;
}

function setup(options: {
  scrollHeight: number;
  clientHeight?: number;
}): Setup {
  const { container } = render(<Harness />);
  const scroller = container.querySelector(
    '.copilotKitMessages',
  ) as HTMLElement;
  const clientHeight = options.clientHeight ?? 300;

  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    // 每次读都取 options 上的当前值 —— resize() 才能生效
    get: () => options.scrollHeight,
  });
  Object.defineProperty(scroller, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });

  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

  return {
    container,
    scroller,
    frame: () => {
      const [callback] = frames.splice(0, 1);
      if (!callback) return false;
      callback(0);
      return frames.length > 0;
    },
    push: async (text: string) => {
      const node = container.querySelector('[data-testid="text"]');
      if (node) node.textContent = text;
      // MutationObserver 是微任务，等一个宏任务确保回调已经跑过
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    resize: (scrollHeight: number) => {
      options.scrollHeight = scrollHeight;
    },
  };
}

describe('useSmoothFollow：贴底时新内容滑上去', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('⭐ 来了新内容不瞬跳：一帧只走 22%，几帧之后才到底', async () => {
    const { scroller, frame, push } = setup({ scrollHeight: 500 });

    await push('正文加了一行');
    // 先跑一帧：0 → 200 × 0.22 = 44
    expect(frame()).toBe(true);
    expect(scroller.scrollTop).toBeCloseTo(44, 5);

    // 再跑一帧：44 → 44 + 156 × 0.22 = 78.32
    frame();
    expect(scroller.scrollTop).toBeGreaterThan(44);
    expect(scroller.scrollTop).toBeLessThan(200);

    // 一直跑到收敛（最多 40 帧，远超 100px 需要的帧数）
    for (let i = 0; i < 40; i += 1) frame();
    expect(scroller.scrollTop).toBe(200);
  });

  it('一次差太多（切会话 / 整份替换历史）就直接到位，不做长距离补间', async () => {
    const { scroller, frame, push } = setup({ scrollHeight: 5000 });

    await push('换了一条会话');
    frame();

    expect(scroller.scrollTop).toBe(4700);
  });

  it('⭐ 用户往上滚之后不再拽他回底部（读上文时不能被抢控制权）', async () => {
    const { scroller, container, frame, push } = setup({ scrollHeight: 500 });

    fireEvent.wheel(container.querySelector('.copilotKitMessages') as Element, {
      deltaY: -120,
    });

    await push('又来了新内容');
    // 没有排任何一帧
    expect(frame()).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it('用户自己滚回底部之后，跟随重新开始', async () => {
    const { scroller, container, frame, push, resize } = setup({
      scrollHeight: 500,
    });
    const scrollerEl = container.querySelector(
      '.copilotKitMessages',
    ) as Element;

    // 先上滚（关掉跟随）
    fireEvent.wheel(scrollerEl, { deltaY: -120 });
    // 再手动滚到底（用户意图：滚轮向下 + scroll 事件）
    scroller.scrollTop = 200;
    fireEvent.wheel(scrollerEl, { deltaY: 120 });
    fireEvent.scroll(scrollerEl);

    // 内容被顶长：从"正好贴底"变成"底下多出 140px"
    resize(640);
    await push('继续输出');

    // ⚠️ 这里断言的是**行为**（位置真的往上追了），不是"排没排帧"。
    //    用户滚回底部那一刻 onScroll 本身就会 kick 一帧，很可能已经收敛完，
    //    再去数帧数就会把"不需要动画"误判成"没有恢复跟随"。
    expect(frame()).toBe(true);
    expect(scroller.scrollTop).toBeGreaterThan(200);
    expect(scroller.scrollTop).toBeLessThan(340);

    // 一直跑到收敛：贴回新的底部（640 - 300 = 340）
    for (let i = 0; i < 40; i += 1) frame();
    expect(scroller.scrollTop).toBe(340);
  });
});
