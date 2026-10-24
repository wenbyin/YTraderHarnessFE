// 文件名故意不叫 login.test.tsx —— vitest.config.ts 的 exclude 里那条
// `src/pages/user/login/login.test.tsx` 是模板留下的 umi-jest 集成测试，
// 用同名文件会把这份也一起排除掉。

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  startCasdoorLogin: vi.fn(),
}));

const state = vi.hoisted(() => ({
  currentUser: undefined as unknown,
}));

vi.mock('@/services/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/auth')>();
  return { ...actual, startCasdoorLogin: auth.startCasdoorLogin };
});

vi.mock('@umijs/max', () => ({
  Helmet: ({ children }: { children?: React.ReactNode }) => children ?? null,
  SelectLang: () => null,
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
  useModel: () => ({ initialState: { currentUser: state.currentUser } }),
}));

vi.mock('@/components', () => ({ Footer: () => null }));

vi.mock('../styles', () => ({ useStyles: () => ({ styles: {} }) }));

import Login from './index';

const locationStub = {
  origin: 'http://localhost:8000',
  pathname: '/user/login',
  search: '',
  hash: '',
  href: 'http://localhost:8000/user/login',
  replace: vi.fn(),
  assign: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  state.currentUser = undefined;
  locationStub.search = '';
  locationStub.replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: locationStub,
  });
});

afterEach(cleanup);

describe('Casdoor 登录页', () => {
  it('点按钮 → 带上 ?redirect= 发起 Casdoor 登录', async () => {
    locationStub.search = '?redirect=%2Fdocuments%3Fpage%3D2';
    auth.startCasdoorLogin.mockResolvedValue(undefined);

    render(<Login />);
    fireEvent.click(screen.getByTestId('casdoor-login-button'));

    await waitFor(() => {
      expect(auth.startCasdoorLogin).toHaveBeenCalledWith('/documents?page=2');
    });
  });

  it('⚠️ redirect 只认本站相对路径（open redirect 挡在这里）', async () => {
    locationStub.search = '?redirect=https%3A%2F%2Fevil.com%2Fsteal';
    auth.startCasdoorLogin.mockResolvedValue(undefined);

    render(<Login />);
    fireEvent.click(screen.getByTestId('casdoor-login-button'));

    await waitFor(() => {
      expect(auth.startCasdoorLogin).toHaveBeenCalledWith('/');
    });
  });

  it('发起失败 → 页面上显示原因，不静默', async () => {
    auth.startCasdoorLogin.mockRejectedValue({
      response: { status: 500, data: { detail: 'casdoor disabled' } },
    });

    render(<Login />);
    fireEvent.click(screen.getByTestId('casdoor-login-button'));

    // Alert 里要带上服务端给的原因（不能只丢一个状态码）
    expect(await screen.findByText(/casdoor disabled/)).toBeTruthy();
    // 500 的文案要能指向"服务端没配好"。⚠️ 提示区里也写了同一句话，
    // 所以这里有**多个**匹配元素，用 findAllByText（踩过：单个会直接报错）。
    expect(
      (await screen.findAllByText(/没能联系上 Casdoor/)).length,
    ).toBeGreaterThan(0);
  });

  it('已经登录的人不该卡在登录页 —— 直接去目标页', async () => {
    state.currentUser = { name: '张三' };
    locationStub.search = '?redirect=%2Ffiles';

    render(<Login />);

    await waitFor(() => {
      expect(locationStub.replace).toHaveBeenCalledWith('/files');
    });
  });

  it('页面上给出服务端没配好时的线索（redirect_uri）', async () => {
    auth.startCasdoorLogin.mockRejectedValue(new Error('boom'));
    render(<Login />);
    fireEvent.click(screen.getByTestId('casdoor-login-button'));

    expect(
      await screen.findByText(
        /CASDOOR_REDIRECT_URI=http:\/\/localhost:8000\/user\/callback/,
      ),
    ).toBeTruthy();
  });
});
