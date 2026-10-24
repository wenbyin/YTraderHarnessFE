// src/services/auth/api.test.ts
//
// 只证明"路径 / 方法 / 请求体形状"与 user.yaml 对得上，不证明浏览器里通了
// （那条链路靠 CDP / curl 验，见 skill 的 3e 节）。
//
// 但其中有一条**必须**在这里钉住：这几个请求都带 skipErrorHandler ——
// 少一个，登录失败时会在全站弹一条没人看得懂的 toast。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('@umijs/max', () => ({ request: requestMock }));

import {
  AUTH_BASE,
  USERS_BASE,
  beginLogin,
  completeLogin,
  fetchCurrentUser,
  isPublicAuthPath,
  refreshTokens,
  searchUsers,
} from './api';

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({});
});

describe('路径与服务器前缀', () => {
  it('前缀与契约的 servers.url 对齐', () => {
    expect(AUTH_BASE).toBe('/api/v1/auth');
  });

  it('四个端点各自的路径与方法', async () => {
    await beginLogin();
    expect(requestMock).toHaveBeenLastCalledWith('/api/v1/auth/login', {
      method: 'POST',
      skipErrorHandler: true,
    });

    await completeLogin({ code: 'c', state: 's' });
    expect(requestMock).toHaveBeenLastCalledWith('/api/v1/auth/callback', {
      method: 'POST',
      data: { code: 'c', state: 's' },
      skipErrorHandler: true,
    });

    await refreshTokens('r-1');
    expect(requestMock).toHaveBeenLastCalledWith('/api/v1/auth/refresh', {
      method: 'POST',
      data: { refresh_token: 'r-1' },
      skipErrorHandler: true,
    });

    await fetchCurrentUser();
    expect(requestMock).toHaveBeenLastCalledWith('/api/v1/auth/me', {
      method: 'GET',
      skipErrorHandler: true,
    });
  });

  it('全部带 skipErrorHandler（失败由调用方表现，不弹全局 toast）', async () => {
    await beginLogin();
    await completeLogin({ code: 'c', state: 's' });
    await refreshTokens('r');
    await fetchCurrentUser();

    expect(requestMock).toHaveBeenCalledTimes(4);
    for (const call of requestMock.mock.calls) {
      expect(call[1]).toMatchObject({ skipErrorHandler: true });
    }
  });
});

describe('isPublicAuthPath', () => {
  it('login / callback / refresh 是公开的', () => {
    expect(isPublicAuthPath('/api/v1/auth/login')).toBe(true);
    expect(isPublicAuthPath('/api/v1/auth/callback')).toBe(true);
    expect(isPublicAuthPath('/api/v1/auth/refresh')).toBe(true);
  });

  it('带 query 也能认出来', () => {
    expect(isPublicAuthPath('/api/v1/auth/callback?code=x&state=y')).toBe(true);
  });

  it('⚠️ /auth/me **不是**公开路径 —— 它要 token，也该享受 401 刷新重试', () => {
    expect(isPublicAuthPath('/api/v1/auth/me')).toBe(false);
  });

  it('业务接口都不算公开', () => {
    expect(isPublicAuthPath('/api/v1/files')).toBe(false);
    expect(isPublicAuthPath('/api/v1/documents/retrieve')).toBe(false);
    expect(isPublicAuthPath('/api/v1/runs/x/events')).toBe(false);
  });

  it('前缀相同但不是同一个路径的挡掉（用整段相等，不是 includes）', () => {
    expect(isPublicAuthPath('/api/v1/auth/login/extra')).toBe(false);
    expect(isPublicAuthPath('/x/api/v1/auth/login')).toBe(false);
  });

  it('空值 → false（不敢当成公开）', () => {
    expect(isPublicAuthPath(undefined)).toBe(false);
    expect(isPublicAuthPath('')).toBe(false);
  });

  it('⚠️ /users/search **不是**公开路径 —— 它要 token，也要吃 401 刷新重试', () => {
    expect(isPublicAuthPath(`${USERS_BASE}/search`)).toBe(false);
  });
});

describe('searchUsers（选人下拉的数据源）', () => {
  it('路径在 /users 下，不是 /auth 下', async () => {
    expect(USERS_BASE).toBe('/api/v1/users');
    await searchUsers();
    expect(requestMock).toHaveBeenLastCalledWith('/api/v1/users/search', {
      method: 'GET',
      params: {},
      skipErrorHandler: true,
    });
  });

  it('关键字与条数走 query 参数（GET，不是请求体）', async () => {
    await searchUsers({ keyword: 'yin', limit: 5 });
    expect(requestMock).toHaveBeenLastCalledWith('/api/v1/users/search', {
      method: 'GET',
      params: { keyword: 'yin', limit: 5 },
      skipErrorHandler: true,
    });
  });

  it('⚠️ 带 skipErrorHandler：失败要在下拉里说（403 是最常见的一种），不弹全局 toast', async () => {
    await searchUsers({ keyword: 'x' });
    expect(requestMock.mock.calls[0][1]).toMatchObject({
      skipErrorHandler: true,
    });
  });
});
