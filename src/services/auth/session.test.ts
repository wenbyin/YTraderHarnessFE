// src/services/auth/session.test.ts
//
// 编排层里最容易错的四件事，逐条钉住：
//   ① 并发 401 只能刷**一次**（refresh_token 可能是轮换的，刷多次会自毁会话）
//   ② 刷新失败只在**认证类**错误上清 token（Casdoor 抖一下不该把所有人踢下线）
//   ③ 回跳地址必须挡开放重定向
//   ④ `access` 不能凭空填 —— 填了就是提权

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  beginLogin: vi.fn(),
  completeLogin: vi.fn(),
  fetchCurrentUser: vi.fn(),
  isPublicAuthPath: vi.fn(() => false),
  refreshTokens: vi.fn(),
}));

vi.mock('./api', () => api);

import {
  AuthRequiredError,
  authHeaders,
  ensureAccessToken,
  getSafeRedirectUrl,
  refreshAccessToken,
  toProCurrentUser,
} from './session';
import { clearTokens, getAccessToken, writeTokens } from './tokenStore';
import type { TokenSet } from './types';

const realLocalStorage = globalThis.localStorage;

/** 造一个 axios 形状的错误（session.ts 的 statusOf 就认这个形状）。 */
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

const tokens = (access: string, over: Partial<TokenSet> = {}): TokenSet => ({
  access_token: access,
  token_type: 'Bearer',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearTokens();
  localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: realLocalStorage,
  });
});

describe('getSafeRedirectUrl（挡开放重定向）', () => {
  it('只放行本站相对路径', () => {
    expect(getSafeRedirectUrl('/documents?x=1#y')).toBe('/documents?x=1#y');
    expect(getSafeRedirectUrl('/')).toBe('/');
  });

  it('协议相对 //evil.com 挡掉', () => {
    expect(getSafeRedirectUrl('//evil.com')).toBe('/');
    expect(getSafeRedirectUrl('//evil.com/x')).toBe('/');
  });

  it('绝对外站挡掉', () => {
    expect(getSafeRedirectUrl('https://evil.com/x')).toBe('/');
    expect(getSafeRedirectUrl('http://evil.com')).toBe('/');
  });

  it('不是以 / 开头的挡掉；空值也回落首页', () => {
    expect(getSafeRedirectUrl('documents')).toBe('/');
    expect(getSafeRedirectUrl('')).toBe('/');
    expect(getSafeRedirectUrl(null)).toBe('/');
    expect(getSafeRedirectUrl(undefined)).toBe('/');
  });

  it('用 origin 真解析一次，反斜杠之类的花招也挡掉', () => {
    // `/\evil.com` 在部分浏览器里会被规范化成 `//evil.com`
    expect(getSafeRedirectUrl('/\\evil.com')).toBe('/');
  });
});

describe('refreshAccessToken（单飞）', () => {
  it('没有 refresh token → AuthRequiredError，且不发请求', async () => {
    await expect(refreshAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(api.refreshTokens).not.toHaveBeenCalled();
  });

  it('并发调用只发一次 /auth/refresh', async () => {
    writeTokens(tokens('old', { expires_in: 1 }));

    let resolveRefresh: ((v: TokenSet) => void) | undefined;
    api.refreshTokens.mockReturnValue(
      new Promise<TokenSet>((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const all = Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);
    resolveRefresh?.(tokens('new'));

    expect(await all).toEqual(['new', 'new', 'new']);
    expect(api.refreshTokens).toHaveBeenCalledTimes(1);
    expect(api.refreshTokens).toHaveBeenCalledWith('refresh-1');
  });

  it('刷新成功后新 token 落盘，且下一次调用会重新发请求（单飞不能变成缓存）', async () => {
    writeTokens(tokens('old', { expires_in: 1 }));
    api.refreshTokens.mockResolvedValue(tokens('new'));

    await expect(refreshAccessToken()).resolves.toBe('new');
    expect(getAccessToken()).toBe('new');

    api.refreshTokens.mockResolvedValue(tokens('newer'));
    await expect(refreshAccessToken()).resolves.toBe('newer');
    expect(api.refreshTokens).toHaveBeenCalledTimes(2);
  });

  it('refresh_token 被拒（401/403/422）→ 清 token 并抛 AuthRequiredError', async () => {
    for (const status of [401, 403, 422]) {
      clearTokens();
      localStorage.clear();
      writeTokens(tokens('old', { expires_in: 1 }));
      api.refreshTokens.mockRejectedValue(httpError(status));

      await expect(refreshAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
      expect(getAccessToken()).toBeNull();
    }
  });

  it('Casdoor 500 / 网络错误 → **保留** token，原样抛出', async () => {
    writeTokens(tokens('old', { expires_in: 1 }));
    api.refreshTokens.mockRejectedValue(httpError(500));
    await expect(refreshAccessToken()).rejects.toMatchObject({
      response: { status: 500 },
    });
    // 关键：token 不能被清掉 —— 否则一次 Casdoor 抖动会把所有人踢下线
    expect(getAccessToken()).toBe('old');

    api.refreshTokens.mockRejectedValue(new Error('Network Error'));
    await expect(refreshAccessToken()).rejects.toThrow('Network Error');
    expect(getAccessToken()).toBe('old');
  });

  it('失败之后单飞锁要释放，否则后续永远拿不到 token', async () => {
    writeTokens(tokens('old', { expires_in: 1 }));
    api.refreshTokens.mockRejectedValueOnce(httpError(500));
    await expect(refreshAccessToken()).rejects.toBeTruthy();

    api.refreshTokens.mockResolvedValue(tokens('new'));
    await expect(refreshAccessToken()).resolves.toBe('new');
  });
});

describe('ensureAccessToken', () => {
  it('本地 token 还没到期 → 直接用，不发刷新请求', async () => {
    writeTokens(tokens('good'));
    await expect(ensureAccessToken()).resolves.toBe('good');
    expect(api.refreshTokens).not.toHaveBeenCalled();
  });

  it('不知道过期时间（expires_in 为 null）→ 直接用，不刷', () => {
    // Casdoor 没给 expires_in 时我们无法预判过期，只能等 401 ——
    // 反过来（不知道就每次都刷）会让每个请求都先绕一趟 Casdoor。
    writeTokens(tokens('unknown', { expires_in: null }));
    return expect(ensureAccessToken()).resolves.toBe('unknown').then(() => {
      expect(api.refreshTokens).not.toHaveBeenCalled();
    });
  });

  it('临近过期 → 先刷再用', async () => {
    writeTokens(tokens('stale', { expires_in: -1 }));
    api.refreshTokens.mockResolvedValue(tokens('fresh'));
    await expect(ensureAccessToken()).resolves.toBe('fresh');
    expect(api.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('彻底没有 → AuthRequiredError', async () => {
    await expect(ensureAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('authHeaders', () => {
  it('有 token 时给出 Bearer 头', () => {
    writeTokens(tokens('abc'));
    expect(authHeaders()).toEqual({ Authorization: 'Bearer abc' });
  });

  it('没有 token 时给空对象（调用方照发，401 由拦截器统一处理）', () => {
    expect(authHeaders()).toEqual({});
  });
});

describe('toProCurrentUser', () => {
  it('name 依次回落 display_name → name → email → subject', () => {
    expect(toProCurrentUser({ subject: 's', display_name: '显示名' }).name).toBe('显示名');
    expect(toProCurrentUser({ subject: 's', name: '登录名' }).name).toBe('登录名');
    expect(toProCurrentUser({ subject: 's', email: 'a@b.c' }).name).toBe('a@b.c');
    expect(toProCurrentUser({ subject: 's' }).name).toBe('s');
  });

  it('映射 subject / email / groups，且**不编造 access**', () => {
    const mapped = toProCurrentUser({
      subject: 'u-1',
      display_name: '张三',
      email: 'z@x.com',
      groups: ['Y-Trader-User', 'admin'],
    });
    expect(mapped.userid).toBe('u-1');
    expect(mapped.email).toBe('z@x.com');
    expect(mapped.group).toBe('Y-Trader-User');
    // ⚠️ access.ts 的 canAdmin 直接读它。后端 /auth/me 没有这个概念，
    //    填 'admin' 就是凭空提权。
    expect(mapped.access).toBeUndefined();
  });
});
