// src/requestErrorConfig.auth.test.ts
//
// 401 → 刷新 → 重试这条链路，是这次接入里**唯一**一段"错了也不会报错、
// 只是界面行为诡异"的代码，所以逐条钉住。
//
// 最要命的一条是 `getResponse: true`：umi 的 `request()` 默认已经脱了一层
// `data`，重试若也用默认行为，外层 `.then((res) => res.data)` 会在同一层上
// 再脱一次 —— 页面拿到 `undefined`，不抛错、不告警。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  authHeaders: vi.fn(() => ({}) as Record<string, string>),
  isPublicAuthPath: vi.fn(),
  redirectToLogin: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('@umijs/max', () => ({
  request: requestMock,
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));

vi.mock('antd', () => ({
  message: { warning: vi.fn(), error: vi.fn() },
  notification: { open: vi.fn() },
}));

vi.mock('@/services/auth', () => ({
  ...auth,
  // 这几个路径的判断逻辑本身在 api.test.ts 里验过，这里给一个等价的实现，
  // 免得本文件里每个用例都要自己 mock 一次返回值。
  isPublicAuthPath: (url?: string) =>
    [
      '/api/v1/auth/login',
      '/api/v1/auth/callback',
      '/api/v1/auth/refresh',
    ].includes((url ?? '').split('?')[0]),
}));

import { errorConfig } from './requestErrorConfig';

type Reject = (error: unknown) => Promise<unknown>;
type Attach = (config: Record<string, unknown>) => Record<string, unknown>;

const tuples = errorConfig.responseInterceptors as unknown as [
  unknown,
  Reject,
][];
const onRejected = tuples[0][1];
const attachHeader = errorConfig.requestInterceptors?.[0] as unknown as Attach;

/** 造一个 axios 形状的 401（拦截器只认 error.response.status / error.config）。 */
const unauthorized = (
  over: Record<string, unknown> = {},
): { response: { status: number }; config: Record<string, unknown> } => ({
  response: { status: 401 },
  config: { url: '/api/v1/files', method: 'get', ...over },
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.authHeaders.mockReturnValue({});
  auth.refreshAccessToken.mockResolvedValue('fresh-token');
});

describe('响应拦截器：401 → 刷新 → 重试一次', () => {
  it('非 401 原样抛出，绝不碰刷新', async () => {
    const error = {
      response: { status: 500 },
      config: { url: '/api/v1/files' },
    };
    await expect(onRejected(error)).rejects.toBe(error);
    expect(auth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('401 → 刷新 → 重试，重试带上新 token', async () => {
    requestMock.mockResolvedValue({ data: { ok: true } });

    await onRejected(unauthorized());

    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const [url, opts] = requestMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe('/api/v1/files');
    expect(opts.headers).toMatchObject({ Authorization: 'Bearer fresh-token' });
  });

  it('⚠️ 重试必须带 getResponse: true —— 否则外层会再脱一层 data，静默变成 undefined', async () => {
    requestMock.mockResolvedValue({ data: { ok: true } });
    await onRejected(unauthorized());

    const opts = requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.getResponse).toBe(true);
  });

  it('重试标记 __authRetried 必须带上（下一次 401 才能识别成"已经刷过了"）', async () => {
    requestMock.mockResolvedValue({ data: {} });
    await onRejected(unauthorized());
    expect(requestMock.mock.calls[0]?.[1]).toMatchObject({
      __authRetried: true,
    });
  });

  it('原请求的 method / data / params / responseType / skipErrorHandler 都要带过去', async () => {
    requestMock.mockResolvedValue({ data: {} });
    await onRejected(
      unauthorized({
        method: 'post',
        data: '{"a":1}',
        params: { page: 2 },
        responseType: 'blob',
        skipErrorHandler: true,
      }),
    );

    expect(requestMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'post',
      data: '{"a":1}',
      params: { page: 2 },
      responseType: 'blob',
      skipErrorHandler: true,
    });
  });

  it('重试仍然 401（已带 __authRetried）→ 不再刷新，跳登录并打"已处理"标记', async () => {
    const error = unauthorized({ __authRetried: true });

    await expect(onRejected(error)).rejects.toBe(error);
    expect(auth.refreshAccessToken).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(auth.redirectToLogin).toHaveBeenCalledTimes(1);
    // 打了标记 errorHandler 才不会再弹一条 `Response status:401`
    expect(
      (error as unknown as { __authHandled?: boolean }).__authHandled,
    ).toBe(true);
  });

  it('公开的 auth 接口 401 不参与刷新（/auth/refresh 自己 401 时刷新是自指）', async () => {
    for (const url of [
      '/api/v1/auth/login',
      '/api/v1/auth/callback',
      '/api/v1/auth/refresh',
    ]) {
      const error = unauthorized({ url });
      await expect(onRejected(error)).rejects.toBe(error);
    }
    expect(auth.refreshAccessToken).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('⚠️ /auth/me 的 401 **要**走刷新（它受保护，是最该被刷新救回来的那一类）', async () => {
    requestMock.mockResolvedValue({ data: { subject: 'u' } });
    await onRejected(unauthorized({ url: '/api/v1/auth/me' }));
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('刷新失败 → 跳登录、打标记、不重试', async () => {
    auth.refreshAccessToken.mockRejectedValue(new Error('refresh 被拒'));
    const error = unauthorized();

    await expect(onRejected(error)).rejects.toBe(error);
    expect(requestMock).not.toHaveBeenCalled();
    expect(auth.redirectToLogin).toHaveBeenCalledTimes(1);
    expect(
      (error as unknown as { __authHandled?: boolean }).__authHandled,
    ).toBe(true);
  });

  it('没有 url 的畸形错误原样抛出，不崩', async () => {
    const error = { response: { status: 401 }, config: {} };
    await expect(onRejected(error)).rejects.toBe(error);
    expect(auth.refreshAccessToken).not.toHaveBeenCalled();
  });
});

describe('请求拦截器：挂 Authorization', () => {
  it('有 token 时挂上 Bearer，且保留原有头', () => {
    auth.authHeaders.mockReturnValue({ Authorization: 'Bearer abc' });
    const result = attachHeader({
      url: '/api/v1/files',
      headers: { 'X-Trace': 't1' },
    });
    expect(result.headers).toEqual({
      'X-Trace': 't1',
      Authorization: 'Bearer abc',
    });
  });

  it('没有 token 时不加 Authorization（照发，401 交给响应拦截器）', () => {
    const result = attachHeader({ url: '/api/v1/files', method: 'get' });
    expect(result.headers).toBeUndefined();
  });

  it('公开的 auth 接口不挂（拿 token 之前就调的那些）', () => {
    auth.authHeaders.mockReturnValue({ Authorization: 'Bearer stale' });
    for (const url of [
      '/api/v1/auth/login',
      '/api/v1/auth/callback',
      '/api/v1/auth/refresh',
    ]) {
      const result = attachHeader({ url });
      expect(result.headers).toBeUndefined();
    }
  });

  it('/auth/me 要挂上 token —— 它是受保护接口', () => {
    auth.authHeaders.mockReturnValue({ Authorization: 'Bearer abc' });
    const result = attachHeader({ url: '/api/v1/auth/me' });
    expect(result.headers).toMatchObject({ Authorization: 'Bearer abc' });
  });
});
