// src/components/CopilotDock/composerPrefs.test.ts
//
// 「深度思考」这个偏好的读写。存储不可用 / 脏数据时**必须回落成「关」**，
// 不能抛 —— 它会在渲染期被读（useState 的初始值），抛出去整个面板就白屏了。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_THINK_KEY,
  parseDeepThink,
  readDeepThink,
  writeDeepThink,
} from './composerPrefs';

/** 真的那个，用例结束要装回去（见 afterEach）。 */
const realLocalStorage = window.localStorage;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  // 把被换掉的 localStorage 装回去 —— 否则下一个用例的 beforeEach
  // 里那句 localStorage.clear() 就会踩到"坏存储"上抛出来
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: realLocalStorage,
  });
  vi.restoreAllMocks();
});

/**
 * 换成一个"一用就抛"的 localStorage。
 *
 * ⚠️ 不能用 `vi.spyOn(Storage.prototype, 'getItem')`
 * ------------------------------------------------
 *   happy-dom 的 window.localStorage 上 getItem 不是走原型链取的，
 *   spy 打上去完全不生效 —— 用例会"通过"，但通过的是真存储
 *   （实测：读回来是 true，因为 setItem 也压根没被拦）。
 *   直接把整个 localStorage 换掉才靠得住。
 */
const useBrokenStorage = () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
    },
  });
};

describe('parseDeepThink', () => {
  it("只认 '1' 是开", () => {
    expect(parseDeepThink('1')).toBe(true);
  });

  it('其余一律是关（含 null / 空串 / 脏数据）', () => {
    for (const raw of [null, '', '0', 'true', 'yes', '{}', ' 1']) {
      expect(parseDeepThink(raw)).toBe(false);
    }
  });
});

describe('readDeepThink / writeDeepThink', () => {
  it('默认是关，写进去之后读得出来', () => {
    expect(readDeepThink()).toBe(false);

    writeDeepThink(true);
    expect(localStorage.getItem(DEEP_THINK_KEY)).toBe('1');
    expect(readDeepThink()).toBe(true);

    writeDeepThink(false);
    expect(readDeepThink()).toBe(false);
  });

  it('存储里是脏数据时回落成关，不抛', () => {
    localStorage.setItem(DEEP_THINK_KEY, '是的');
    expect(readDeepThink()).toBe(false);
  });

  it('存储不可用（隐私模式）时不抛，读回落成关', () => {
    useBrokenStorage();

    expect(() => writeDeepThink(true)).not.toThrow();
    expect(readDeepThink()).toBe(false);
  });
});
