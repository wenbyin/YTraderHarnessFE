// src/services/auth/index.ts
//
// 认证模块的公开出口。外面**只从这里 import** —— 内部拆了
// types / tokenStore / api / session 四层，但那是实现细节：
// 想换掉存 token 的地方（比如改成配合服务端会话），只该动 tokenStore.ts。
//
// 分层（从下到上）：
//   types.ts       契约类型（对齐 user.yaml v1.0.0）
//   tokenStore.ts  存取 + 过期判断（纯逻辑，可单测）
//   api.ts         四个端点（纯传输，不碰存储）
//   session.ts     编排：登录 / 刷新（单飞）/ 登出 / 请求头 / 回跳安全

export {
  AUTH_BASE,
  USERS_BASE,
  beginLogin,
  completeLogin,
  fetchCurrentUser,
  isPublicAuthPath,
  refreshTokens,
  searchUsers,
} from './api';
export {
  AuthRequiredError,
  CALLBACK_PATH,
  LOGIN_PATH,
  authHeaders,
  completeCasdoorLogin,
  consumeRedirect,
  describeAuthError,
  describeCurrentUser,
  ensureAccessToken,
  getSafeRedirectUrl,
  logout,
  redirectToLogin,
  refreshAccessToken,
  startCasdoorLogin,
  toProCurrentUser,
} from './session';
export {
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
export type {
  CurrentUser,
  LoginCallbackRequest,
  LoginUrlResponse,
  RefreshTokenRequest,
  TokenSet,
  UserOption,
  UserSearchParams,
} from './types';
export type { StoredTokens } from './tokenStore';
