// src/services/auth/tokenStore.test.ts
//
// 这一层是**纯逻辑 + 存储**，所以能直接钉住，不用碰网络。
//
// ⚠️ 两个已知的环境坑（见项目 skill / MEMORY）
//  1. `vi.spyOn(Storage.prototype, 'getItem')` 在 happy-dom 里**不生效** ——
//     storage 上的方法不走原型链。要模拟"存储不可用"就**整个换掉
//     `window.localStorage`**，并在 afterEach 里装回去。
//  2. setupTests.ts 已经把 `globalThis.localStorage` 换成了一个 mock，
//     所以这里必须先把它存下来，测完还原 —— 否则后面的用例
//     `localStorage.clear()` 会打到坏存储上抛出来。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOKEN_STORAGE_KEY,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  needsRefresh,
  parseStored,
  readTokens,
  toStored,
  writeTokens,
} from './tokenStore';
import type { TokenSet } from './types';

const realLocalStorage = globalThis.localStorage;

const tokenSet = (over: Partial<TokenSet> = {}): TokenSet => ({
  access_token: 'access-1',
  token_type: 'Bearer',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  ...over,
});

beforeEach(() => {
  clearTokens();
  globalThis.localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: realLocalStorage,
  });
});

describe('toStored', () => {
  it('expires_in 是秒，落盘时换算成绝对时间戳', () => {
    expect(toStored(tokenSet({ expires_in: 60 }), 1_000_000)).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_000_000 + 60_000,
    });
  });

  it('expires_in 缺失/非数字 → expiresAt 为 null（表示"不知道什么时候过期"）', () => {
    for (const bad of [undefined, null, Number.NaN]) {
      const stored = toStored(tokenSet({ expires_in: bad as number }), 1000);
      expect(stored.expiresAt).toBeNull();
    }
  });

  it('refresh_token 缺失 → null，不是 undefined', () => {
    // 契约里 refresh_token 是 nullable 且不在 required：Casdoor 没开 refresh
    // grant 时就是 null。留成 undefined 会让 JSON.stringify 把它整个丢掉，
    // 读回来就分不清"没有"和"没写"。
    const stored = toStored(tokenSet({ refresh_token: null }));
    expect(stored.refreshToken).toBeNull();
    expect(JSON.parse(JSON.stringify(stored))).toHaveProperty('refreshToken', null);
  });

  it('空字符串的 refresh_token 归一成 null', () => {
    expect(toStored(tokenSet({ refresh_token: '' })).refreshToken).toBeNull();
  });
});

describe('parseStored', () => {
  it('坏数据一律回落成 null，绝不抛（它在渲染期被读，抛出去就是白屏）', () => {
    const bad: unknown[] = [
      null,
      undefined,
      '',
      'not json',
      '[]',
      '"a string"',
      '123',
      '{}',
      '{"accessToken":""}',
      '{"accessToken":123}',
      '{"refreshToken":"r"}',
    ];
    for (const raw of bad) {
      expect(parseStored(raw as string | null)).toBeNull();
    }
  });

  it('读回来的整个对象与写进去的一致（白名单解析漏字段必须在这里暴露）', () => {
    // ⚠️ 用 toEqual 断言**整个对象**，不要只断言 accessToken。
    //    这个项目在 parseConversations 上栽过：白名单解构漏了一个新字段，
    //    刷新后字段静默消失、没有任何报错，只有整对象断言能抓到。
    writeTokens(tokenSet({ expires_in: 120 }));
    const parsed = parseStored(localStorage.getItem(TOKEN_STORAGE_KEY));
    expect(parsed).toHaveProperty('accessToken', 'access-1');
    expect(parsed).toHaveProperty('refreshToken', 'refresh-1');
    expect(typeof parsed?.expiresAt).toBe('number');
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'accessToken',
      'expiresAt',
      'refreshToken',
    ]);
  });
});

describe('read / write / clear', () => {
  it('写进去能读出来', () => {
    writeTokens(tokenSet());
    expect(getAccessToken()).toBe('access-1');
    expect(getRefreshToken()).toBe('refresh-1');
  });

  it('clear 之后全空', () => {
    writeTokens(tokenSet());
    clearTokens();
    expect(readTokens()).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('存储不可用时用内存兜底 —— 不能退化成"没登录"', () => {
    // 隐私模式 / 禁 cookie：读 localStorage 本身就抛 SecurityError。
    // 若当成"没登录"，用户会陷入 登录成功 → 立刻又要求登录 的死循环。
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
      clear: () => {
        throw new Error('SecurityError');
      },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: throwing,
    });

    expect(() => writeTokens(tokenSet())).not.toThrow();
    expect(getAccessToken()).toBe('access-1');
    expect(getRefreshToken()).toBe('refresh-1');

    clearTokens();
    expect(readTokens()).toBeNull();
  });
});

describe('needsRefresh', () => {
  it('没有 token → false（没得刷）', () => {
    expect(needsRefresh()).toBe(false);
  });

  it('没有 refresh_token → false（刷了也没用）', () => {
    writeTokens(tokenSet({ refresh_token: null, expires_in: 1 }));
    expect(needsRefresh(0, Date.now() + 10_000)).toBe(false);
  });

  it('不知道过期时间 → false（不知道就别猜，等 401）', () => {
    writeTokens(tokenSet({ expires_in: null }));
    expect(needsRefresh(0, Date.now() + 10_000_000)).toBe(false);
  });

  it('还在有效期内 → false；进入提前量窗口 → true', () => {
    writeTokens(tokenSet({ expires_in: 100 }));
    // ⚠️ 必须用**真实写入后的** expiresAt 当基点：toStored 内部用的是真
    //    Date.now()，测试里另造一个 `now` 常量会和它对不上（踩过）。
    const expiresAt = readTokens()?.expiresAt;
    expect(typeof expiresAt).toBe('number');
    const base = expiresAt as number;

    expect(needsRefresh(30_000, base - 40_000)).toBe(false);
    // 距过期只剩 29s，提前量是 30s → 该刷了
    expect(needsRefresh(30_000, base - 29_000)).toBe(true);
    expect(needsRefresh(30_000, base)).toBe(true);
  });

  it('提前量默认为 30 秒', () => {
    writeTokens(tokenSet({ expires_in: 100 }));
    const base = readTokens()?.expiresAt as number;
    expect(needsRefresh(undefined, base - 31_000)).toBe(false);
    expect(needsRefresh(undefined, base - 29_000)).toBe(true);
  });
});

describe('存储键', () => {
  it('用命名空间，且写入的键就是导出的那个常量', () => {
    writeTokens(tokenSet());
    expect(TOKEN_STORAGE_KEY).toBe('ytrader.auth.tokens');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeTruthy();
    expect(vi.isMockFunction(localStorage.setItem)).toBe(true);
  });
});
