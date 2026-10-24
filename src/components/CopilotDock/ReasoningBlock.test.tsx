// src/components/CopilotDock/ReasoningBlock.test.tsx
//
// 需求原话：「所有推理内容隐藏在 content 正上方默认灰色隐藏，点击展开显示
// 推理内容」+ 后补的两条：「展开添加动画效果」「不要同时存在两个 loading」。
// 这里钉四件事：
//   ① **默认折叠**（需求本身，也是最容易被"顺手改成默认展开"的一条）；
//   ② 点一下展开、再点一下收回去；
//   ③ 展开/收起是**真的走动画**（内容在收起动画播完之前不许消失）；
//   ④ 流式与收尾说的是两句不同的话。
//
// ⚠️ 展开状态**不跨消息共享** —— 每条消息一个组件实例、自己的 state，
//    这是刻意的（每条消息的推理长度差得远，"上次展开了"不是一种偏好）。
//
// ⚠️ happy-dom **不做排版**：量的到属性、量不到高度。所以动画那两条只能断言
//    "驱动动画的那个开关 / 内容在不在 DOM 里"，不能断言"高度真的从 0 长到 120"。
//    要量几何得用 CDP 探针（见 SKILL 里那套 esbuild 静态页的手法）。
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReasoningBlock, { reasoningLabel } from './ReasoningBlock';
import type { ReasoningEntry } from './reasoningStream';
import { REASONING_ANIM_MS } from './style';

const entry = (over: Partial<ReasoningEntry> = {}): ReasoningEntry => ({
  text: '先看要不要查工具，再答。',
  streaming: false,
  ...over,
});

const block = (container: HTMLElement) =>
  container.querySelector('[data-reasoning-block]');
const toggle = (container: HTMLElement) =>
  container.querySelector('[data-reasoning-toggle]');
const wrap = (container: HTMLElement) =>
  container.querySelector('[data-reasoning-body-wrap]');
const body = (container: HTMLElement) =>
  container.querySelector('[data-reasoning-body]');

/** 动画壳上的开关值 —— CSS 里 0fr ↔ 1fr 全靠它。 */
const wrapFlag = (container: HTMLElement) =>
  wrap(container)?.getAttribute('data-reasoning-open');

describe('reasoningLabel', () => {
  it('还在流 -> 正在思考；已收尾 -> 思考过程', () => {
    expect(reasoningLabel(entry({ streaming: true }))).toBe('正在思考');
    expect(reasoningLabel(entry({ streaming: false }))).toBe('思考过程');
  });
});

describe('ReasoningBlock', () => {
  it('⭐ 默认**折叠**：推理原文不在 DOM 里', () => {
    const { container } = render(<ReasoningBlock reasoning={entry()} />);

    expect(body(container)).toBeNull();
    expect(toggle(container)?.getAttribute('aria-expanded')).toBe('false');
    expect(wrapFlag(container)).toBe('false');
  });

  it('把手本身要看得见（它是"这里有推理"的唯一提示）', () => {
    const { container } = render(<ReasoningBlock reasoning={entry()} />);

    expect(block(container)).not.toBeNull();
    expect(toggle(container)?.textContent).toContain('思考过程');
  });

  it('⭐ 点一下展开，推理原文出现', () => {
    const { container } = render(<ReasoningBlock reasoning={entry()} />);

    fireEvent.click(toggle(container) as HTMLElement);

    expect(body(container)?.textContent).toBe('先看要不要查工具，再答。');
    expect(toggle(container)?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle(container)?.getAttribute('data-reasoning-open')).toBe('true');
  });

  it('⭐ 展开时"动画开关"同一帧就翻成 true（否则过渡不会跑）', () => {
    // 动画壳是**常驻**节点、靠 data-reasoning-open 切 0fr/1fr。
    // 它必须在点下去的那一刻（同一帧）就变 —— 和内容一起进 DOM。
    // 要是内容晚一帧才来，行高比例这一帧没有再变，transition 直接不触发。
    const { container } = render(<ReasoningBlock reasoning={entry()} />);

    fireEvent.click(toggle(container) as HTMLElement);

    expect(wrapFlag(container)).toBe('true');
    expect(body(container)).not.toBeNull();
  });

  it('箭头展开时转 90°（用我们自己的类，不依赖库的 rotate 属性）', () => {
    const { container } = render(<ReasoningBlock reasoning={entry()} />);
    const caretOf = () => container.querySelector('.anticon-right');
    const before = caretOf()?.className ?? '';

    fireEvent.click(toggle(container) as HTMLElement);

    expect(caretOf()?.className).not.toBe(before);
  });

  it('⭐ 收起是"先播动画、再卸载"：动画期间原文还在，播完才消失', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<ReasoningBlock reasoning={entry()} />);
      const button = toggle(container) as HTMLElement;

      fireEvent.click(button);
      fireEvent.click(button);

      // 这一刻：意图已经关掉（开关翻回 false、按钮报 false），但原文**还在** ——
      // 它正是被压缩的那部分，提前卸载就没有高度动画了。
      expect(wrapFlag(container)).toBe('false');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(body(container)).not.toBeNull();
      // 而且不再留在无障碍树里
      expect(body(container)?.getAttribute('aria-hidden')).toBe('true');

      act(() => {
        vi.advanceTimersByTime(REASONING_ANIM_MS);
      });

      expect(body(container)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('收起动画播到一半又点开：原文不会被中途卸掉', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<ReasoningBlock reasoning={entry()} />);
      const button = toggle(container) as HTMLElement;

      fireEvent.click(button); // 展开
      fireEvent.click(button); // 收起
      act(() => {
        vi.advanceTimersByTime(REASONING_ANIM_MS / 2); // 收到一半
      });
      fireEvent.click(button); // 又展开

      act(() => {
        vi.advanceTimersByTime(REASONING_ANIM_MS * 2); // 就算把"卸载定时器"的时间跑完
      });

      expect(body(container)).not.toBeNull();
      expect(wrapFlag(container)).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ 流式时那一行说"正在思考"，但**不**挂转圈图标（2026-10-21 用户要求删掉）', () => {
    const { container } = render(
      <ReasoningBlock reasoning={entry({ streaming: true })} />,
    );

    expect(toggle(container)?.textContent).toContain('正在思考');
    // 「正在思考」四个字就是加载信号；再挂一枚转圈，会和输入框上沿那枚
    // 「正在组织回答…」胶囊变成两个 loading 同时在动。
    expect(container.querySelector('.anticon-loading')).toBeNull();
  });

  it('收尾态同样没有转圈图标', () => {
    const { container } = render(<ReasoningBlock reasoning={entry()} />);
    expect(container.querySelector('.anticon-loading')).toBeNull();
  });

  it('⭐ 把手是真正的 <button>（键盘可达由元素类型保证）', () => {
    const { container } = render(<ReasoningBlock reasoning={entry()} />);
    expect(toggle(container)?.tagName).toBe('BUTTON');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
