// src/pages/task/components/TaskActions.test.tsx
//
// 钉住「确认面是全局 modal，不是挂在按钮上的 Popconfirm」这条交互约定：
//   1. 点「立即执行」只开弹窗，**不发请求**（确认前的点击不能有副作用）；
//   2. 弹窗里再点「立即执行」才真的 invoke —— 且弹窗里那句关键前提
//      （仍是同一轮、attempt 不变）在 DOM 里读得到；
//   3. 点「再等等」什么都不发生；
//   4. 取消 / 重试同属一个确认面，取消按钮按 danger 语义画。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { App } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TaskActions from './TaskActions';

const invokeTask = vi.fn();
const cancelTask = vi.fn();
const retryTask = vi.fn();

vi.mock('../service', () => ({
  invokeTask: (...args: unknown[]) => invokeTask(...args),
  cancelTask: (...args: unknown[]) => cancelTask(...args),
  retryTask: (...args: unknown[]) => retryTask(...args),
}));

const FUTURE = '2999-01-01T09:00:00+08:00';

function mount(ui: React.ReactNode) {
  return render(<App>{ui}</App>);
}

/** 弹窗本体（antd 把它 portal 到 body，所以只能从 role 找）。 */
function dialog() {
  return screen.getByRole('dialog');
}

beforeEach(() => {
  invokeTask.mockReset().mockResolvedValue(undefined);
  cancelTask.mockReset().mockResolvedValue({ status: 'cancelled' });
  retryTask.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('TaskActions 的确认面', () => {
  it('点「立即执行」只开全局弹窗，确认后才发请求', async () => {
    mount(<TaskActions taskId="t1" status="pending" executeAt={FUTURE} />);

    // 触发按钮自己就是一个普通按钮：点它不该有副作用
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }));

    const box = await waitFor(() => dialog());
    // 弹窗标题与正文都断言 textContent：antd 的 title 节点在 v6 里不止一份，
    // 按文本查元素会撞「multiple elements」。
    expect(box.textContent).toContain('提前执行这条任务？');
    // 「仍是同一轮执行，attempt 不变」是用户最容易误解的一条，必须在弹窗里能读到
    expect(box.textContent).toContain('仍是同一轮执行，attempt 不变');
    // 弹窗里的两个动作
    expect(within(box).getByRole('button', { name: '再等等' })).toBeTruthy();

    expect(invokeTask).not.toHaveBeenCalled();

    fireEvent.click(within(box).getByRole('button', { name: '立即执行' }));

    await waitFor(() => expect(invokeTask).toHaveBeenCalledWith('t1'));
  });

  it('点「再等等」不发请求', async () => {
    mount(<TaskActions taskId="t1" status="pending" executeAt={FUTURE} />);

    fireEvent.click(screen.getByRole('button', { name: '立即执行' }));
    const box = await waitFor(() => dialog());

    fireEvent.click(within(box).getByRole('button', { name: '再等等' }));

    // ⚠️ 不断言"弹窗已从 DOM 消失"：退场靠 transitionend，happy-dom 里不会触发，
    //    节点会一直挂着 leave 类（真浏览器里正常）。这里只钉"没有副作用"。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole('dialog').className).toContain('leave');
    expect(invokeTask).not.toHaveBeenCalled();
  });

  it('execute_at 为空时不画「立即执行」（点了也是空动作）', () => {
    mount(<TaskActions taskId="t1" status="pending" executeAt={null} />);
    expect(screen.queryByRole('button', { name: '立即执行' })).toBeNull();
  });

  it('取消同样走全局弹窗，且 OK 是 danger 语义', async () => {
    mount(<TaskActions taskId="t1" status="running" />);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const box = await waitFor(() => dialog());
    expect(box.textContent).toContain(
      '协作式取消：正在跑的 Handler 不会被强杀',
    );

    const ok = within(box).getByRole('button', { name: '取消任务' });
    // 破坏性动作的 OK 必须是红的
    expect(ok.className).toContain('ant-btn-dangerous');

    fireEvent.click(ok);
    await waitFor(() => expect(cancelTask).toHaveBeenCalledWith('t1'));
  });

  it('retry 只对 failed / cancelled 出现', async () => {
    const { unmount } = mount(<TaskActions taskId="t1" status="success" />);
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    unmount();

    mount(<TaskActions taskId="t1" status="failed" />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    const box = await waitFor(() => dialog());
    // antd 给 primary 上的两字中文自动插空格（"重 跑"），所以用正则
    fireEvent.click(within(box).getByRole('button', { name: /重\s跑/ }));
    await waitFor(() => expect(retryTask).toHaveBeenCalledWith('t1'));
  });
});
