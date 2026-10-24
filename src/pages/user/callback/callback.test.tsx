import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  completeCasdoorLogin: vi.fn(),
  consumeRedirect: vi.fn(() => '/files'),
  describeCurrentUser: vi.fn(),
}));

// 只替换网络/跳转相关的，`describeAuthError` 用真的（错误文案是这一页的输出之一）
vi.mock('@/services/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/auth')>();
  return { ...actual, ...auth };
});

vi.mock('@umijs/max', () => ({
  Helmet: ({ children }: { children?: React.ReactNode }) => children ?? null,
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));

vi.mock('@/components', () => ({ Footer: () => null }));

// 样式不是这一页要测的东西，绕开 antd-style 的主题依赖
vi.mock('../styles', () => ({ useStyles: () => ({ styles: {} }) }));

import Callback from './index';

/**
 * ⚠️ 不要用 `window.happyDOM.setURL()` 改地址，也不要**整个替换** `window.location`
 * ----------------------------------------------------------------------------
 *   两者只能选一个，混用就会得到"地址永远是空的"这种诡异结果（第一版就这么踩了）：
 *   替换 `window.location` 之后，`setURL` 改的是那个**已经被换掉的真对象**，
 *   而页面读的是我们的替身 —— search 恒为空，所有分支都走"缺少 code"。
 *   这里统一用替身，用例直接改 `locationStub.search`。
 */
const locationStub = {
  origin: 'http://localhost:8000',
  pathname: '/user/callback',
  search: '',
  hash: '',
  href: 'http://localhost:8000/user/callback',
  replace: vi.fn(),
  assign: vi.fn(),
};

const setSearch = (search: string) => {
  locationStub.search = search;
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.consumeRedirect.mockReturnValue('/files');
  auth.completeCasdoorLogin.mockResolvedValue({ access_token: 'a' });
  auth.describeCurrentUser.mockResolvedValue({ subject: 'u-1' });

  locationStub.search = '';
  locationStub.replace = vi.fn();

  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: locationStub,
  });
});

afterEach(() => {
  cleanup();
});

describe('Casdoor 回调页', () => {
  it('用 code/state 换 token → 验一次 /auth/me → 回跳', async () => {
    setSearch('?code=THE-CODE&state=THE-STATE');
    render(<Callback />);

    await waitFor(() => {
      expect(locationStub.replace).toHaveBeenCalledWith('/files');
    });

    expect(auth.completeCasdoorLogin).toHaveBeenCalledWith(
      'THE-CODE',
      'THE-STATE',
    );
    expect(auth.describeCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 重复挂载也只兑换一次 —— 授权码是一次性的', async () => {
    // React 18 的 StrictMode 会把 effect 跑两遍（dev 下必现）。
    // 不挡住的话第二次会拿着已经用过的 code 去换，拿到 401，
    // 表现成"登录成功却报错了"。
    setSearch('?code=ONE-SHOT&state=S');
    render(
      <StrictMode>
        <Callback />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(auth.completeCasdoorLogin).toHaveBeenCalled();
    });

    expect(auth.completeCasdoorLogin).toHaveBeenCalledTimes(1);
    expect(auth.completeCasdoorLogin).toHaveBeenCalledWith('ONE-SHOT', 'S');
  });

  it('Casdoor 拒绝授权（?error=）→ 不兑换，把 error_description 显示出来', async () => {
    setSearch('?error=access_denied&error_description=user%20denied');
    render(<Callback />);

    expect(await screen.findByText(/user denied/)).toBeTruthy();
    expect(auth.completeCasdoorLogin).not.toHaveBeenCalled();
    expect(locationStub.replace).not.toHaveBeenCalled();
  });

  it('地址上没有 code/state → 报错，不兑换', async () => {
    setSearch('?foo=bar');
    render(<Callback />);

    expect(await screen.findByText(/缺少 code 或 state/)).toBeTruthy();
    expect(auth.completeCasdoorLogin).not.toHaveBeenCalled();
  });

  it('兑换失败 → 显示原因，且不跳转', async () => {
    setSearch('?code=c&state=s');
    auth.completeCasdoorLogin.mockRejectedValue({
      response: { status: 401, data: { detail: 'state 已过期' } },
    });
    render(<Callback />);

    expect(await screen.findByText(/state 已过期/)).toBeTruthy();
    expect(locationStub.replace).not.toHaveBeenCalled();
  });

  it('⚠️ token 换到了但 /auth/me 403（不在 required_groups）→ 就地报出来，不跳转', async () => {
    setSearch('?code=c&state=s');
    auth.describeCurrentUser.mockRejectedValue({
      response: { status: 403, data: { detail: 'not in required groups' } },
    });
    render(<Callback />);

    // 在这里报出来，用户看到的是「你不在允许的群组里」；
    // 直接跳走的话他会在目标页被弹回登录页，而且没有任何解释。
    expect(await screen.findByText(/不在允许的群组里/)).toBeTruthy();
    expect(locationStub.replace).not.toHaveBeenCalled();
  });
});
