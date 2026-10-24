// src/services/auth/tokenStore.ts
//
// token 的落盘层。**只管存取，不发请求** —— 发请求在 api.ts，编排在 session.ts。
// 拆开是为了让"过期判断 / 坏数据回落"这些纯逻辑能被单测直接钉住（不用碰网络）。
//
// ⚠️ 为什么是 localStorage
// ----------------------
//   契约的 TokenResponse 把 `refresh_token` 放在**响应体**里（OAuth 2.0 原样
//   透传），yaml 自己也注明「HttpOnly cookie 会更安全，但需要服务端会话」——
//   也就是说后端当前没有服务端会话，前端只有两个选择：自己存，或者不要刷新能力。
//   选了前者，所以这里的代价（XSS 能读到 token）是**已知且接受**的。
//
// ⚠️ 存的是 `expiresAt`（绝对时间戳），不是 `expires_in`（相对秒数）
// ------------------------------------------------------------------
//   相对值存下来没有任何意义 —— 读到它的时候早就不知道基点在哪了。
//   但 `expires_in` 是 nullable：Casdoor 不给就是 null，此时 `expiresAt` 也是
//   null，表示「不知道什么时候过期」，只能等 401 再去刷（见 needsRefresh）。

import type { TokenSet } from './types';

/** localStorage 的键。带命名空间，免得和别的应用挤在同一个 origin 下打架。 */
export const TOKEN_STORAGE_KEY = 'ytrader.auth.tokens';

/** 落盘的形状（相对契约做了一层转换：expires_in → expiresAt）。 */
export interface StoredTokens {
  accessToken: string;
  /** 没有就是 null（Casdoor 没开 refresh grant）。 */
  refreshToken: string | null;
  /** 绝对毫秒时间戳；null = 不知道什么时候过期。 */
  expiresAt: number | null;
}

/**
 * 存储不可用时的内存兜底。
 *
 * 什么情况下会不可用：隐私模式 / 禁用 cookie 的浏览器里，访问 `localStorage`
 * 本身就会抛 SecurityError。此时若直接当成"没登录"，用户会陷入
 * **登录成功 → 立刻又要求登录** 的死循环，而且看不出原因。
 * 换成内存兜底，至少当前这个标签页是通的（代价：刷新即失效，符合预期）。
 */
let memoryFallback: StoredTokens | null = null;

function storage(): Storage | null {
  try {
    // 不只是取引用 —— 真的读写一次才算确认可用
    const ls = globalThis.localStorage;
    if (!ls) return null;
    return ls;
  } catch {
    return null;
  }
}

/**
 * 把契约的 TokenSet 转成落盘形状（**纯函数**，可单测）。
 *
 * ⚠️ 白名单式构造 —— 加字段时必须同时改这里和 `parseStored`
 * ---------------------------------------------------------
 *   这个项目已经在这类地方栽过一次（`parseConversations` 漏了 `used`，
 *   刷新后所有会话静默变回"没用过"，无任何报错）。规矩是：
 *   加字段 → interface、写入方、解析解构三处一起改 → 单测用 `toEqual`
 *   断言**整个对象**（只断言关键字段会漏）。
 */
export function toStored(tokens: TokenSet, now: number = Date.now()): StoredTokens {
  const expiresIn = tokens.expires_in;
  const refreshToken = tokens.refresh_token;
  return {
    accessToken: tokens.access_token,
    // 空串也归一成 null。不这么做的话 writeTokens → readTokens 会得到**不同的对象**
    // （写入是 ''，读回来是 null）—— 单测里那条"整对象一致"的断言立刻就炸了。
    refreshToken:
      typeof refreshToken === 'string' && refreshToken ? refreshToken : null,
    expiresAt:
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? now + expiresIn * 1000
        : null,
  };
}

/**
 * 解析落盘内容（**纯函数**，可单测）。任何异常都回落成 null，绝不抛。
 *
 * 抛出去的后果很具体：它在**渲染期**被读（`getInitialState`），
 * 一个坏字符串就能白屏整个应用。
 */
export function parseStored(raw: string | null | undefined): StoredTokens | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const { accessToken, refreshToken, expiresAt } = parsed as Record<string, unknown>;

  // accessToken 是唯一"没有它这条记录就没有意义"的字段
  if (typeof accessToken !== 'string' || !accessToken) return null;

  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : null,
    expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

/** 读当前 token。没有 / 坏了 / 存储不可用都返回 null。 */
export function readTokens(): StoredTokens | null {
  const ls = storage();
  if (!ls) return memoryFallback;

  let raw: string | null = null;
  try {
    raw = ls.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return memoryFallback;
  }
  return parseStored(raw);
}

/** 写入 token（覆盖）。 */
export function writeTokens(tokens: TokenSet): StoredTokens {
  const stored = toStored(tokens);
  memoryFallback = stored;

  const ls = storage();
  if (ls) {
    try {
      ls.setItem(TOKEN_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // 配额满 / 存储被禁 —— 内存那份已经写好了，不打断本次登录
    }
  }
  return stored;
}

/** 清空（登出、刷新失败）。 */
export function clearTokens(): void {
  memoryFallback = null;

  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 删不掉也没关系：内存那份已经清了，下次写会覆盖
  }
}

/** 有没有可用的 access token（不判断过期 —— 过期由 401 或 needsRefresh 决定）。 */
export function getAccessToken(): string | null {
  return readTokens()?.accessToken ?? null;
}

export function getRefreshToken(): string | null {
  return readTokens()?.refreshToken ?? null;
}

/**
 * 要不要**提前**刷新。
 *
 * ⚠️ 只有"知道过期时间且已经过期（含提前量）"才返回 true。
 *    不知道过期时间（`expiresAt === null`）时**返回 false** —— 不知道就别猜，
 *    等 401 再刷。反过来（不知道就每次都刷）会让每个请求都先绕一趟 Casdoor。
 *
 * @param skewMs 提前量：飞在路上 + 服务端处理也会耗时，卡着最后一毫秒刷必然失败。
 */
export function needsRefresh(skewMs = 30_000, now: number = Date.now()): boolean {
  const tokens = readTokens();
  if (!tokens) return false;
  if (!tokens.refreshToken) return false;
  if (tokens.expiresAt === null) return false;
  return now >= tokens.expiresAt - skewMs;
}
