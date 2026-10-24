// src/pages/agent_stress/service.test.ts
//
// 错误归一层的单测。为什么要单独测：这组请求都 `skipErrorHandler`，
// 页面上给用户看的那句话**完全**由 `stressErrorMessage` 决定 ——
// FastAPI 的 422 detail 是数组，处理错了就只剩 "Response status:422"。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@umijs/max', () => ({ request: vi.fn() }));

import { stressErrorMessage, stressErrorStatus } from './service';

function httpError(status: number, data?: unknown, message = ''): unknown {
  return Object.assign(new Error(message), {
    response: { status, data },
  });
}

describe('stressErrorStatus', () => {
  it('取 axios 风格 error.response.status', () => {
    expect(stressErrorStatus(httpError(409))).toBe(409);
    expect(stressErrorStatus(new Error('boom'))).toBeUndefined();
  });
});

describe('stressErrorMessage', () => {
  it('字符串 detail 原样用（后端业务错误）', () => {
    expect(
      stressErrorMessage(httpError(409, { detail: '跑测已结束，不能取消' })),
    ).toBe('跑测已结束，不能取消');
  });

  it('422 数组 detail 拍平成「字段: 原因」', () => {
    const error = httpError(422, {
      detail: [
        {
          type: 'value_error',
          loc: ['body', 'target'],
          msg: 'Value error, target 必须是 http/https 绝对地址',
        },
        {
          type: 'value_error',
          loc: ['body', 'mock_model', 'output_tokens_max'],
          msg: 'Value error, output_tokens_max 不能小于 output_tokens_min',
        },
      ],
    });

    const text = stressErrorMessage(error);
    expect(text).toContain('target: target 必须是 http/https 绝对地址');
    expect(text).toContain(
      'mock_model.output_tokens_max: output_tokens_max 不能小于 output_tokens_min',
    );
    expect(text).not.toContain('Value error');
    expect(text).toContain('；');
  });

  it('没有 detail 时退回 Error.message，再退回兜底文案', () => {
    expect(stressErrorMessage(httpError(500, undefined, '网关 502'))).toBe(
      '网关 502',
    );
    expect(stressErrorMessage({})).toBe('请求失败');
  });

  it('空数组 / 空字符串不吞掉兜底', () => {
    expect(stressErrorMessage(httpError(422, { detail: [] }))).toBe('请求失败');
    expect(stressErrorMessage(httpError(400, { detail: '   ' }))).toBe(
      '请求失败',
    );
  });
});
