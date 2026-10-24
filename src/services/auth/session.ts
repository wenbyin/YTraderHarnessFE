// src/services/auth/session.ts
//
// 编排层：把 api.ts（纯传输）与 tokenStore.ts（纯存取）拼成"一次登录会话"。
//
// 谁在用它
// --------
//   · src/requestErrorConfig.ts —— 挂 Authorization、401 刷新重试、跳登录
//   · src/app.tsx               —— getInitialState 取当前用户
//   · pages/user/login          —— 发起登录
//   · pages/user/callback       —— 用 code 换 token
//   · components/RightContent   —— 退出登录
//   · pages/file/service.ts、CopilotDock/agentRuntime.ts —— 这两处不走 umi request，
//     只来取一个请求头

import {
  beginLogin,
  completeLogin,
  fetchCurrentUser,
  isPublicAuthPath,
  refreshTokens,
} from './api';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  needsRefresh,
  writeTokens,
} from './tokenStore';
import type { CurrentUser, TokenSet } from './types';

export { isPublicAuthPath };

/** 登录页路径。必须与 config/routes.ts 里的一致。 */
export const LOGIN_PATH = '/user/login';
/** 回调页路径。**必须与 Casdoor 应用登记的 Redirect URL 同源同路径**
 *  （后端 `CASDOOR_REDIRECT_URI` 也要指到这里）。 */
export const CALLBACK_PATH = '/user/callback';

/** 登录前想去的地方，跨 Casdoor 跳转期间寄存在这里。 */
const REDIRECT_STORAGE_KEY = 'ytrader.auth.redirect';

/**
 * 会话不可继续的错误（没有 token / 刷新被拒）。
 *
 * 单独一个类是为了让上层能区分"要重新登录"与"网络抖了一下"：
 * 前者跳登录页，后者应该原样把错误抛给用户看（重登也没用）。
 */
export class AuthRequiredError extends Error {
  constructor(message = '需要重新登录') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** 从任意错误里读 HTTP 状态码（axios 在 error.response.status，自己 fetch 的也照这个形状放）。 */
function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

function readRedirect(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(REDIRECT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeRedirect(value: string): void {
  try {
    globalThis.sessionStorage?.setItem(REDIRECT_STORAGE_KEY, value);
  } catch {
    // 存不了就算了：回跳会退化成首页，不该因此让登录失败
  }
}

function clearRedirect(): void {
  try {
    globalThis.sessionStorage?.removeItem(REDIRECT_STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}

/**
 * 把 `?redirect=` 收敛成一个**本站相对路径**，挡开放重定向。
 *
 * 只接受以 `/` 开头的同源相对路径：
 *   · `//evil.com` 会被当成协议相对 URL 跳到外站 → 挡掉；
 *   · `https://evil.com` 同理 → 挡掉；
 *   · `/a/b?c=d#e` 保留完整（路径 + query + hash）。
 *
 * 登录页和回调页都要用它 —— 一处漏了就是一个可被钓鱼利用的跳转。
 */
export function getSafeRedirectUrl(redirect: string | null | undefined): string {
  if (!redirect?.startsWith('/')) return '/';
  if (redirect.startsWith('//')) return '/';

  try {
    const parsed = new URL(redirect, window.location.origin);
    if (parsed.origin !== window.location.origin) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

/**
 * 跳登录页（带上回跳地址）。已经登录页 / 回调页则不动。
 *
 * ⚠️ 用 `location.replace` 而不是 push：这是"当前页已经不可用"的替换，
 *    留在历史里只会让用户按返回键又回到一个必然再次 401 的页面。
 */
export function redirectToLogin(): void {
  const { pathname, search, hash } = window.location;
  if (pathname === LOGIN_PATH || pathname === CALLBACK_PATH) return;

  const target = `${LOGIN_PATH}?redirect=${encodeURIComponent(pathname + search + hash)}`;
  window.location.replace(target);
}

/**
 * 发起 Casdoor 登录：拿授权地址 → 记下回跳目标 → 跳过去。
 *
 * 回跳目标存在 sessionStorage：Casdoor 的 `redirect_uri` 是**后端配置里写死的**
 * （不让调用方传，否则就是开放重定向），所以没有地方能塞一个自定义参数过去，
 * 只能在离开前自己记一笔。
 *
 * @param redirectPath 登录成功后要回的路径（一般是当前页）。
 */
export async function startCasdoorLogin(redirectPath?: string): Promise<void> {
  const target = getSafeRedirectUrl(
    redirectPath ?? `${window.location.pathname}${window.location.search}`,
  );
  if (target !== '/') writeRedirect(target);

  const { authorize_url: authorizeUrl } = await beginLogin();
  // ⚠️ assign 而不是 open：必须让**当前浏览器**去，state cookie 才在
  window.location.assign(authorizeUrl);
}

/** 登录成功后该回哪儿（读不到就首页）。 */
export function consumeRedirect(): string {
  const target = getSafeRedirectUrl(readRedirect());
  clearRedirect();
  return target;
}

/** 用回调带回来的 code/state 换 token 并落盘。 */
export async function completeCasdoorLogin(code: string, state: string): Promise<TokenSet> {
  const tokens = await completeLogin({ code, state });
  writeTokens(tokens);
  return tokens;
}

/**
 * 刷新 access token —— **单飞**：并发调用共用同一个请求。
 *
 * ⚠️ 为什么必须单飞
 * ----------------
 *   打开一个列表页可能有 5~6 个请求同时 401。不做单飞就会**同时**发 5 次
 *   /auth/refresh，而 refresh_token 在部分实现里是一次性的（轮换）：
 *   第 2~5 次会拿着已经被换掉的旧 refresh_token 去刷 → 401 → 把刚建立的新会话
 *   一起清掉，用户表现为"刚登录就被登出"。
 *
 * ⚠️ 刷新失败时**只对"认证类"错误清 token**
 * -----------------------------------------
 *   401/403/422 = refresh_token 真的不认了 → 清掉，去登录。
 *   500 / 网络错误 = Casdoor 挂了或网断了 → **保留 token**。
 *   后者如果也清，就会因为一次 Casdoor 抖动把所有人踢下线，而且刷新页面也回不来。
 */
let inflightRefresh: Promise<string> | null = null;

export function refreshAccessToken(): Promise<string> {
  if (inflightRefresh) return inflightRefresh;

  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return Promise.reject(new AuthRequiredError('本地没有 refresh token'));
  }

  inflightRefresh = (async () => {
    try {
      const tokens = await refreshTokens(refreshToken);
      writeTokens(tokens);
      return tokens.access_token;
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403 || status === 422) {
        clearTokens();
        throw new AuthRequiredError('刷新令牌被拒绝，需要重新登录');
      }
      throw error;
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

/**
 * 拿一个"现在可用"的 access token。
 *
 * 两种情况会先刷再给：
 *   ① 本地根本没有 token（但可能有 refresh token）；
 *   ② `expiresAt` 已知且已经进入提前量窗口（见 tokenStore.needsRefresh）。
 *
 * 拿不到就抛 `AuthRequiredError` —— 调用方（拦截器）据此跳登录。
 */
export async function ensureAccessToken(): Promise<string> {
  const existing = getAccessToken();
  if (existing && !needsRefresh()) return existing;
  return refreshAccessToken();
}

/**
 * 给**不走 umi request** 的调用（XHR 上传、文件下载、SSE）取请求头。
 *
 * 这些地方没有拦截器可挂，必须自己带。返回空对象表示"当前没有 token" ——
 * 调用方照发即可。
 *
 * ⚠️ 但**不要**以为"照发就有人管"（2026-10-17 更正）
 * ------------------------------------------------
 *   这里的早期注释写着"401 的处理逻辑仍然只有一处（拦截器）"—— 对**普通接口**
 *   成立，对**自己 fetch 的端点不成立**：拦截器挂在 axios 实例上，根本看不见
 *   那些请求。令牌过期时，umi 的请求会被 `retryAfterRefresh` 自动刷回来（用户
 *   无感），而 SSE 直接吃一个 401 → 界面报"登录状态已失效"，刷新页面才恢复。
 *   所以这类调用方要自己续期（正例：`CopilotDock/agentRuntime.ts` 的 `runEvents`，
 *   订阅前按 `needsRefresh()` 预刷 + 401 时刷一次重试一次）。
 */
export function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 退出登录：只清本地。 */
export function logout(): void {
  clearTokens();
}

/** 取当前调用者（已带 token，失败原样抛出）。 */
export async function describeCurrentUser(): Promise<CurrentUser> {
  return fetchCurrentUser();
}

/**
 * 把认证相关的失败翻成一句能读的话。
 *
 * ⚠️ 步骤名 + 后端 detail 都要带上
 * ------------------------------
 *   同一个 401 有三种完全不同的修法（前端没带 token / token 过期 /
 *   audience 配错），只显示状态码等于没说。这与 CopilotDock 里
 *   `describeRuntimeError` 的口径一致：**先说清哪一步，再说服务端给的原因**。
 *
 * 契约（user.yaml）里各状态码的含义：
 *   500  /auth/*  —— Casdoor 鉴权被关掉（`enabled: false`）或 Casdoor 不可达
 *   401  /auth/callback —— state 缺失/伪造/过期/来自另一个浏览器，或 code 被拒
 *   403  /auth/me —— token 有效但不在 `casdoor.yaml: required_groups` 里
 */
export function describeAuthError(error: unknown): string {
  const err = error as {
    response?: { status?: number; data?: { detail?: unknown } };
    data?: { detail?: unknown };
    message?: string;
  };

  const status = statusOf(error);
  // axios 的响应体在 error.response.data；自己 fetch 抛的习惯放 error.data
  const { detail } = err?.response?.data ?? err?.data ?? {};
  const reason =
    typeof detail === 'string' && detail
      ? detail
      : Array.isArray(detail)
        ? String(
            (detail[0] as { msg?: string } | undefined)?.msg ?? '请求参数不合法',
          )
        : undefined;

  const byStatus: Record<number, string> = {
    401: '登录状态已失效或授权码不可用，请重新登录',
    403: '这个账号不在允许的群组里（后端 required_groups 没有放行）',
    422: '服务端拒绝了这次请求的参数',
    500: '后端没能联系上 Casdoor（或鉴权被关闭），请找管理员确认服务端配置',
  };

  if (status && byStatus[status]) {
    return reason ? `${byStatus[status]}：${reason}` : byStatus[status];
  }
  if (reason) return reason;
  return err?.message || '登录失败，请重试';
}

/**
 * 把契约的 `CurrentUser` 映射成 Pro 布局用的 `API.CurrentUser`。
 *
 * ⚠️ 只做**展示所需**的映射，不编造字段
 * ------------------------------------
 *   后端 `/auth/me` 只给 subject / name / display_name / email / groups
 *   （没有 avatar、没有 access、没有 title）。所以这里：
 *     · `name` 取 display_name → name → email 的第一个非空值，
 *       纯为了头像旁那行字别是空的；
 *     · `access` **不填** —— 它是 Pro 模板的演示字段，我们不知道也没有来源，
 *       填 'admin' 就是凭空提权（access.ts 的 canAdmin 会直接认它）。
 */
export function toProCurrentUser(me: CurrentUser): API.CurrentUser {
  const display = me.display_name || me.name || me.email || me.subject;
  return {
    name: display,
    userid: me.subject,
    email: me.email,
    group: me.groups?.[0],
  };
}
