// src/services/auth/types.ts
//
// 契约类型 —— 逐条对齐 YTraderHarness 的 app/services/user/user.yaml v1.0.0
// （openapi 3.1.0，title: User & Authentication API）。
//
// ⚠️ 字段名是 **snake_case**，且**不要**改成 camelCase
// --------------------------------------------------
//   后端在 TokenResponse 的 docstring 里写明了理由：
//   "Passed through from Casdoor unchanged — the field names are OAuth 2.0's,
//    and remapping them would only add a place to lose information."
//   access_token / refresh_token / expires_in 是 RFC 6749 的名字，
//   前端转一道手不会让谁更舒服，只会多一处对不上的可能。
//
// ⚠️ 可空字段真的会返回 null
// -------------------------
//   `refresh_token` / `expires_in` / `id_token` / `scope` 在契约里是
//   `nullable: true` 且**不在 required 里** —— Casdoor 给不给取决于应用上
//   开没开对应的 grant。所以类型是 `X | null | undefined`，两种都要接住：
//   后端自己也只写了 `raw.get(...)`（缺了就是 None，不是错误）。

/** POST /auth/login 的响应。同时会下发一个 HttpOnly 的 state cookie。 */
export interface LoginUrlResponse {
  /** Casdoor 授权页地址。**必须由收到本响应的同一个浏览器打开**，否则回调带不上 cookie。 */
  authorize_url: string;
  /** CSRF state，HMAC 签名 + 自带过期，原样回传即可（服务端不存）。 */
  state: string;
}

/** POST /auth/callback 的请求体。 */
export interface LoginCallbackRequest {
  /** 授权码，**一次性**：同一个 code 第二次换 token 必然失败。 */
  code: string;
  state: string;
}

/** POST /auth/refresh 的请求体。 */
export interface RefreshTokenRequest {
  refresh_token: string;
}

/** 三个接口共用的 token 集合（OAuth 2.0 原样透传）。 */
export interface TokenSet {
  access_token: string;
  token_type?: string;
  /**
   * ⚠️ 敏感：有效期内等同于密码。契约把它放在**响应体**里
   * （yaml 自己注明「HttpOnly cookie 会更安全，但需要服务端会话」），
   * 所以前端只能自己存 —— 这是留 localStorage 的根据，不是偷懒。
   */
  refresh_token?: string | null;
  /** 秒。**可能没有** —— 没有时无法预判过期，只能等 401 再刷。 */
  expires_in?: number | null;
  id_token?: string | null;
  scope?: string | null;
}

/**
 * GET /auth/me 的响应。
 *
 * 全部来自 access token 的 claims，**没有数据库查询**（后端没有本地用户表）。
 *
 * ⚠️ `groups` 反映的是 **token 里写的**，不是 Casdoor 的实时状态：
 *    把人移出群组要等他的 token 过期或重新登录才生效。
 */
export interface CurrentUser {
  /** Casdoor 用户 id（JWT `sub`）。只有它是 required。 */
  subject: string;
  name?: string;
  display_name?: string;
  email?: string;
  /** 已归一化（数组 / 对象 / owner 限定名都拍平成裸名字）。 */
  groups?: string[];
}

/**
 * GET /users/search 的一行 —— 用户选择器要的四个字段。
 *
 * ⚠️ 它**不是** user *record*：Casdoor 的 user 对象有一百多个字段
 *    （含 accessToken 与第三方凭据），后端刻意一个都不透传。
 *    所以别指望这里能拿到角色、群组、头像 —— 需要就别用这个接口。
 */
export interface UserOption {
  /**
   * Casdoor 用户 id（UUID）。
   *
   * **这是要提交给别的接口的那个值** —— 它正是 /auth/me 给同一个人报的
   * `subject`。选择器选完人之后，往下传的就是它，不是 `name`。
   */
  id: string;
  /** 登录名（Casdoor 的 `name`）。 */
  name?: string;
  /** 展示名（Casdoor 的 `displayName`）。**可能为空**。 */
  display_name?: string;
  /** 邮箱。**可能为空**。 */
  email?: string;
}

/**
 * GET /users/search 的查询参数。
 *
 * ⚠️ 三个字段的匹配是**大小写敏感**的（`yin` 命中，`YIN` 不命中）——
 *    那是 Casdoor 自己的比较方式，不是后端的选择。界面上要照实提示，
 *    否则「我搜了却没结果」会被当成"这个人不存在"。
 */
export interface UserSearchParams {
  /**
   * 找什么。按子串（`LIKE %keyword%`）分别匹配 `name` / `email` / `id`
   * 三个字段，再按 id 去重、截到 `limit`。
   *
   * **可以不给**（或给空串）：那就列出该组织的前 `limit` 个用户、不做筛选
   * —— 契约明说这是为了让选择器在用户还没打字时就有东西可选。
   */
  keyword?: string;
  /** 1..50，默认 20。上限 50 是刻意的：喂选择器的接口，不是搜索结果页。 */
  limit?: number;
}

/** FastAPI 的错误体（detail 是字符串；422 时是数组）。 */
export interface ApiError {
  detail?: unknown;
}
