// src/services/auth/api.ts
//
// 四个端点的**纯传输层** —— 不碰存储、不做跳转、不吞错误。
// 契约：app/services/user/user.yaml v1.0.0，实现：app/api/v1/users.py。
//
// 全部带 `skipErrorHandler: true`
// -----------------------------
//   这几个接口的失败要由**调用方**决定怎么表现，而不是弹一条全局 toast：
//     · 登录页失败 → 页面上的 Alert + 可重试按钮；
//     · 回调页失败 → 显示原因并给「重新登录」；
//     · /auth/me 失败 → getInitialState 自己跳登录。
//   这与项目里轮询类请求的口径一致（见 pages/document 的 progress 轮询）。
//
// ⚠️ 三个"公开"接口 vs 一个"受保护"接口
// ------------------------------------
//   公开：/auth/login、/auth/callback、/auth/refresh（各在 users.py 里注明了原因）
//   受保护：/auth/me —— **它要带 token**，别把它也算进公开集合里，
//           否则 401 自动刷新那条链路会跳过它（那是我们最想覆盖的路径之一）。

import { request } from '@umijs/max';

import type {
  CurrentUser,
  LoginCallbackRequest,
  LoginUrlResponse,
  TokenSet,
  UserOption,
  UserSearchParams,
} from './types';

/** 与 user.yaml 的 `servers: - url: /api/v1` 对齐。 */
export const AUTH_BASE = '/api/v1/auth';

/**
 * 用户目录查询。**不在 `/auth` 下** —— 契约把原因写在了路径前缀说明里：
 * `/users/search` 的主语**是**用户资源（一次只读查找，由 Casdoor 回答），
 * 而 `/auth/*` 的主语是一次**登录动作**。
 */
export const USERS_BASE = '/api/v1/users';

/**
 * 公开的 auth 路径（不需要 token 就能调，也**不应该**为它们触发刷新重试）。
 *
 * `/auth/me` **故意不在**这个列表里：它需要 token，也应该享受
 * 「401 → 刷新 → 重试一次」的待遇。
 */
const PUBLIC_AUTH_PATHS: readonly string[] = [
  `${AUTH_BASE}/login`,
  `${AUTH_BASE}/callback`,
  `${AUTH_BASE}/refresh`,
];

/**
 * 这个 URL 是不是"公开的 auth 接口"。
 *
 * 判断只看**路径**，把 query 剥掉（request 里 url 可能带 `?a=b`），
 * 且用整段相等而不是 includes —— `/auth/me` 是 `/auth/m` 的合法前缀那种事
 * 就不必操心了，但 `includes` 会让 `/x/auth/login/y` 也命中，没必要留这个口子。
 */
export function isPublicAuthPath(url?: string): boolean {
  if (!url) return false;
  const [path] = url.split('?');
  return PUBLIC_AUTH_PATHS.includes(path);
}

/**
 * 发起登录：拿 Casdoor 授权页地址。
 *
 * **不直接 302**（后端刻意如此，好让接口脱离浏览器可测）：返回地址由前端决定
 * 怎么用 —— 正常是 `window.location.assign(authorize_url)`。
 *
 * ⚠️ 必须用**收到本响应的同一个浏览器**打开那个地址：响应同时下发了一个
 *    HttpOnly 的 state cookie，回调时要对得上。换个浏览器（或复制链接到别处）
 *    一定失败，这不是 bug。
 *
 * '500' = 后端 Casdoor 鉴权被关掉（`enabled: false`），没有凭据走不下去。
 */
export async function beginLogin(): Promise<LoginUrlResponse> {
  return request<LoginUrlResponse>(`${AUTH_BASE}/login`, {
    method: 'POST',
    skipErrorHandler: true,
  });
}

/**
 * 用授权码换 token。
 *
 * 前端从 redirect_uri 上读到的 `?code=&state=` 原样转发过来；state cookie
 * 由浏览器自动带上，前端不用操心。
 *
 * ⚠️ code 是**一次性**的：同一个 code 调第二次必然失败（401）。
 *    所以调用点必须保证"只调一次"—— React 18 的重复挂载会踩到这条
 *    （见 pages/user/callback 里的 ref 守卫）。
 */
export async function completeLogin(body: LoginCallbackRequest): Promise<TokenSet> {
  return request<TokenSet>(`${AUTH_BASE}/callback`, {
    method: 'POST',
    data: body,
    skipErrorHandler: true,
  });
}

/**
 * 用 refresh token 换一套新令牌。
 *
 * 这个接口**刻意公开**：它的用处正是 access token 已经失效之后，
 * 要求它有效就没有存在意义了（users.py 的模块 docstring）。
 */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return request<TokenSet>(`${AUTH_BASE}/refresh`, {
    method: 'POST',
    data: { refresh_token: refreshToken },
    skipErrorHandler: true,
  });
}

/**
 * 当前调用者。
 *
 * 需要 `Authorization: Bearer <access_token>` —— 由 requestErrorConfig 的
 * 请求拦截器统一挂上，这里不用手写。
 *
 * 可能的失败：401（token 缺失/畸形/过期/audience 不对）、
 * 403（token 有效但不在 `casdoor.yaml: required_groups` 里）。
 * 两者要分开提示 —— 403 是"你登录了但没权限"，重登一万次也没用。
 */
export async function fetchCurrentUser(): Promise<CurrentUser> {
  return request<CurrentUser>(`${AUTH_BASE}/me`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

/**
 * 在 Casdoor 目录里找人 —— 给选择器填选项用。
 *
 * 只读，不写任何东西；后端**没有本地用户表**，每次都是当场问 Casdoor。
 *
 * ⚠️ 返回的是**选项**（只有 id / name / display_name / email 四个字段），
 *    不是完整用户对象 —— 别指望从这里拿角色或群组。
 *
 * ⚠️ 响应是**顶层数组**，没有 success/data 包裹（与 files / documents 那批
 *    ListResponse 不一样）。空数组 = 没人匹配，**不是 404**。
 *
 * ⚠️ **大小写敏感**（`yin` 命中、`YIN` 不命中）—— Casdoor 自己的比较方式。
 *    界面上要照实说，否则「搜了没结果」会被误读成「这个人不存在」。
 *
 * `keyword` 不给（或给空串）= 列出该组织的前 `limit` 个用户、不做筛选：
 * 契约明说这是为了让选择器在用户还没打字时就有东西可选，所以
 * 「先空着调一次」是**设计好的用法**，不是浪费。
 *
 * 失败语义：
 *   401 没 token / token 过期
 *   403 **缺 `Y-Trader-Admin` 角色**（本地开发关了鉴权也照 403 ——
 *       bypass 身份里的 roles 是刻意留空的）
 *   500 Casdoor 够不着，或者应用凭据没有读用户的权限
 *
 * `skipErrorHandler: true`：这是一个"边打字边跑"的接口，失败要由选择器
 * 自己在下拉里说清楚（尤其是 403 —— 那是最可能发生的一种），
 * 而不是每敲一个字弹一条全局 toast。
 */
export async function searchUsers(
  params: UserSearchParams = {},
): Promise<UserOption[]> {
  return request<UserOption[]>(`${USERS_BASE}/search`, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}
