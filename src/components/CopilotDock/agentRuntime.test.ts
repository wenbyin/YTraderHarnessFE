// src/components/CopilotDock/agentRuntime.test.ts
//
// 对接契约的冒烟：请求打到哪、带什么、怎么报错。
// 这里钉的是「路径 / 方法 / 请求体形状 / skipErrorHandler」——
// 改坏了后端会 404 或 422，而 422 那种（多给键）最难查，所以逐条断言。
import { request } from '@umijs/max';
import type { Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, needsRefresh, refreshAccessToken } from '@/services/auth';
import {
  API_BASE,
  cancelRun,
  createRun,
  createSession,
  DEFAULT_AGENT_ID,
  deleteSession,
  describeRuntimeError,
  getSession,
  isBenignCancelError,
  listSessionMessages,
  listSessions,
  parseSseBlock,
  type RunEventFrame,
  resumeRun,
  runEvents,
  SseDecoder,
  statusOf,
} from './agentRuntime';

vi.mock('@umijs/max', () => ({
  request: vi.fn(),
}));

/**
 * 鉴权那一层要能被驱动 —— 事件流现在会自己续期（见 runEvents 的 ①②）。
 * 只替换三个纯查/刷函数，其余（AuthRequiredError 等）保留真身。
 */
vi.mock('@/services/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth')>()),
  authHeaders: vi.fn(() => ({})),
  needsRefresh: vi.fn(() => false),
  refreshAccessToken: vi.fn(),
}));

const mocked = vi.mocked(request);
const mockedAuthHeaders = vi.mocked(authHeaders);
const mockedNeedsRefresh = vi.mocked(needsRefresh);
const mockedRefresh = vi.mocked(refreshAccessToken);

beforeEach(() => {
  vi.clearAllMocks();
  mocked.mockResolvedValue({});
});

describe('建会话', () => {
  it('POST /api/v1/sessions，body 只有 agent_id 与 metadata', async () => {
    await createSession({
      agent_id: DEFAULT_AGENT_ID,
      metadata: { conversation_id: 'conv-1' },
    });

    expect(request).toHaveBeenCalledWith(`${API_BASE}/sessions`, {
      method: 'POST',
      data: {
        agent_id: DEFAULT_AGENT_ID,
        metadata: { conversation_id: 'conv-1' },
      },
      skipErrorHandler: true,
    });
  });
});

describe('查会话', () => {
  it('GET /api/v1/sessions/{id}', async () => {
    await getSession('s-1');

    expect(request).toHaveBeenCalledWith(`${API_BASE}/sessions/s-1`, {
      method: 'GET',
      skipErrorHandler: true,
    });
  });
});

describe('列会话', () => {
  it('GET /api/v1/sessions，不带参数时 params 是空对象（不带 status）', async () => {
    mocked.mockResolvedValueOnce({ items: [], total: 0 });

    const page = await listSessions();

    expect(page).toEqual({ items: [], total: 0 });
    expect(request).toHaveBeenCalledWith(`${API_BASE}/sessions`, {
      method: 'GET',
      // ⚠️ 这里刻意不塞 status：契约里不传等价于 active，
      //   传个 undefined 反而会变成 `?status=`（后端 422）。
      params: {},
      skipErrorHandler: true,
    });
  });

  it('查询参数原样交给 request（status / 分页 / 时间区间）', async () => {
    mocked.mockResolvedValueOnce({ items: [], total: 3 });

    await listSessions({
      status: 'archived',
      page: 2,
      page_size: 100,
      updated_after: '2026-10-18T00:00:00Z',
    });

    const [url, options] = mocked.mock.calls[0] as unknown as [
      string,
      { params?: unknown },
    ];
    expect(url).toBe(`${API_BASE}/sessions`);
    expect(options.params).toEqual({
      status: 'archived',
      page: 2,
      page_size: 100,
      updated_after: '2026-10-18T00:00:00Z',
    });
  });
});

describe('删会话（后端是归档）', () => {
  it('DELETE /api/v1/sessions/{id}，无请求体、204 无 body 也解析成 void', async () => {
    // 204 没有响应体：request 解出来是 undefined，不是"接口没返回"的错
    mocked.mockResolvedValueOnce(undefined);

    await expect(deleteSession('s-1')).resolves.toBeUndefined();

    const [url, options] = mocked.mock.calls[0] as unknown as [
      string,
      { method: string; data?: unknown; skipErrorHandler?: boolean },
    ];
    expect(url).toBe(`${API_BASE}/sessions/s-1`);
    expect(options.method).toBe('DELETE');
    expect(options.data).toBeUndefined();
    expect('data' in options).toBe(false);
    expect(options.skipErrorHandler).toBe(true);
  });

  it('session_id 走 URL 编码', async () => {
    mocked.mockResolvedValueOnce(undefined);
    await deleteSession('s/1 2');
    expect(mocked.mock.calls[0][0]).toBe(
      `${API_BASE}/sessions/${encodeURIComponent('s/1 2')}`,
    );
  });

  it('404 会抛（调用方要先接口后本地，不能吞掉）', async () => {
    mocked.mockRejectedValueOnce(
      Object.assign(new Error('Request failed'), {
        response: { status: 404, data: { detail: '会话不存在' } },
      }),
    );

    await expect(deleteSession('gone')).rejects.toBeTruthy();
  });
});

describe('建运行', () => {
  it('POST /api/v1/sessions/{id}/runs，input 里只放 text', async () => {
    await createRun('s-1', { input: { text: '  帮我看看这只票  ' } });

    const [url, options] = mocked.mock.calls[0] as unknown as [
      string,
      { method: string; data: unknown },
    ];
    expect(url).toBe(`${API_BASE}/sessions/s-1/runs`);
    expect(options.method).toBe('POST');
    // 后端 DTO 是 extra="forbid"：多一个键就是 422，所以连 metadata 都不带
    expect(options.data).toEqual({ input: { text: '  帮我看看这只票  ' } });
  });

  it('给了 trace_id 就原样放进 body（后端不替我们生成，也不做去重）', async () => {
    const traceId = '8f14e45f-ceea-467f-a3f2-9c1b5a7d6e01';
    await createRun('s-1', { input: { text: 'x' }, trace_id: traceId });

    const [, options] = mocked.mock.calls[0] as unknown as [
      string,
      { data: unknown },
    ];
    // 顶层字段名必须正是 `trace_id`（不是 traceId）—— 后端 `extra="forbid"`，
    // 拼错一个字母不是"忽略"，是整条请求 422
    expect(options.data).toEqual({ input: { text: 'x' }, trace_id: traceId });
  });
});

describe('回答人工审批（resume）', () => {
  it('POST /api/v1/runs/{run_id}/resume，body 是 { answers: [{interrupt_id, data}] }', async () => {
    await resumeRun('run-7', {
      answers: [{ interrupt_id: 'int-1', data: { decision: 'approve' } }],
    });

    const [url, options] = mocked.mock.calls[0] as unknown as [
      string,
      { method: string; data: unknown; skipErrorHandler?: boolean },
    ];
    expect(url).toBe(`${API_BASE}/runs/run-7/resume`);
    expect(options.method).toBe('POST');
    // 形状就是后端 ResumeRequest：只有 `answers` 一个字段，**没有单条形状**
    //（run.py 的 `answers: list[ResumeAnswer]`，min_length=1）——
    // 答一个也要包成数组。data 是自由字典，形状由 ApprovalDecision 定。
    expect(options.data).toEqual({
      answers: [{ interrupt_id: 'int-1', data: { decision: 'approve' } }],
    });
    // 失败必须以"对话里的一条消息"出现（409 / 404 要能读到原因），
    // 不能弹一条全局 toast —— 与其它三个调用同款口径
    expect(options.skipErrorHandler).toBe(true);
  });

  it('并行工具：整组一次性带走（后端要求 answers 正好覆盖当前 pending 集合）', async () => {
    await resumeRun('run-7', {
      answers: [
        { interrupt_id: 'int-1', data: { decision: 'approve' } },
        { interrupt_id: 'int-2', data: { decision: 'reject' } },
      ],
    });

    const [, options] = mocked.mock.calls[0] as unknown as [
      string,
      { data: unknown },
    ];
    expect(options.data).toEqual({
      answers: [
        { interrupt_id: 'int-1', data: { decision: 'approve' } },
        { interrupt_id: 'int-2', data: { decision: 'reject' } },
      ],
    });
    // 只发一次 —— 循环发的话第二次起运行已经不在 waiting_input，全撞 409
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('run_id 走 URL 编码（它可能不是裸 uuid）', async () => {
    await resumeRun('run/with space', {
      answers: [{ interrupt_id: 'i', data: { decision: 'reject' } }],
    });

    expect(mocked.mock.calls[0][0]).toBe(
      `${API_BASE}/runs/run%2Fwith%20space/resume`,
    );
  });

  it('没有响应体也不能当成"没发生"：失败要往上抛（409 = 不在等待 / 集合对不上）', async () => {
    mocked.mockRejectedValue({
      response: { status: 409, data: { detail: '运行不在 waiting_input' } },
      message: 'Request failed with status code 409',
    });

    await expect(
      resumeRun('run-7', { answers: [{ interrupt_id: 'int-1', data: {} }] }),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });
});

/**
 * 取消一次正在跑的运行（cancel）。
 *
 * 与 resume 最大的不同：**既没有请求体，也没有响应体**。
 * 所以两条最容易写错的点都钉住：
 *   ① 不传 data（后端这个端点没声明 body，多余字段可能被拒）；
 *   ② 返回 Promise<void>，不读响应（200 的 body 是空的）。
 */
describe('取消运行（cancel）', () => {
  it('POST /api/v1/runs/{run_id}/cancel，**不带请求体**', async () => {
    await cancelRun('run-7');

    const [url, options] = mocked.mock.calls[0] as unknown as [
      string,
      { method: string; data?: unknown; skipErrorHandler?: boolean },
    ];
    expect(url).toBe(`${API_BASE}/runs/run-7/cancel`);
    expect(options.method).toBe('POST');
    // ⚠️ 不能有 data：cancelRun 没有请求体。
    //   "没有"和"传了个空对象"在断言里是两回事，所以断言 data 是 undefined。
    expect(options.data).toBeUndefined();
    expect('data' in options).toBe(false);
    // 失败不走全局 toast（这一条的失败处理见下面 isBenignCancelError）
    expect(options.skipErrorHandler).toBe(true);
  });

  it('run_id 走 URL 编码', async () => {
    await cancelRun('run/with space');

    expect(mocked.mock.calls[0][0]).toBe(
      `${API_BASE}/runs/run%2Fwith%20space/cancel`,
    );
  });

  it('失败要往上抛：由调用方决定静默还是留线索（这里不吞）', async () => {
    mocked.mockRejectedValue({
      response: { status: 409, data: { detail: '该运行停在人工审批上' } },
    });

    await expect(cancelRun('run-7')).rejects.toMatchObject({
      response: { status: 409 },
    });
  });
});

/**
 * 哪些 cancel 失败**不值得打扰用户**。
 *
 * 分界线是"用户的目标（别再跑了）多半已经达成"：
 *   · 404 —— 运行不存在 / 不归本用户：本来就没东西可取消；
 *   · 409 —— 状态不允许：已结束，或它停在审批上（那种情况该走 resume 回答 reject）。
 * 静默这两类，是为了不出现"我明明停了，它却报错"这种更让人困惑的界面。
 * ⚠️ 422 不算良性 —— 那是前端自己传错了 id，必须看得见。
 */
describe('isBenignCancelError', () => {
  const err = (status: number) => ({ response: { status } });

  it('404 / 409：良性，静默', () => {
    expect(isBenignCancelError(err(404))).toBe(true);
    expect(isBenignCancelError(err(409))).toBe(true);
  });

  it('422 / 5xx / 读不出状态码：都要留线索', () => {
    expect(isBenignCancelError(err(422))).toBe(false);
    expect(isBenignCancelError(err(500))).toBe(false);
    expect(isBenignCancelError(err(503))).toBe(false);
    // 网络异常之类根本没有 response —— 一律当成"要留线索"
    expect(isBenignCancelError(new Error('network down'))).toBe(false);
    expect(isBenignCancelError(undefined)).toBe(false);
  });

  it('⚠️ 读的是 error.response.status（umi request 的形状），不是 error.status', () => {
    // 这条是踩过的坑：把错误只写成 `{status:409}` 会读到 undefined，
    // 于是良性判断失效、良性场景也会打出 warn。
    expect(isBenignCancelError({ status: 409 })).toBe(false);
    expect(isBenignCancelError({ response: { status: 409 } })).toBe(true);
  });
});

// ============================================================
// 事件流（SSE）
// ============================================================

describe('解析一帧 SSE', () => {
  it('id / event / data 三行各自归位，data 取内层的业务字段', () => {
    const block = [
      'id: 1790942924262-0',
      'event: message.delta',
      'data: {"event":"message.delta","topic":"agent_run","topic_id":"r-1","node":"","occurred_at":"2026-10-01T05:00:00Z","data":{"delta":"你"}}',
    ].join('\n');

    expect(parseSseBlock(block)).toEqual({
      id: '1790942924262-0',
      event: 'message.delta',
      payload: expect.objectContaining({ topic: 'agent_run' }),
      data: { delta: '你' },
    });
  });

  it('心跳（只有注释行）不是事件', () => {
    expect(parseSseBlock(': ping')).toBeNull();
  });

  it('没有 data 行的块（空帧）不是事件', () => {
    expect(parseSseBlock('id: 1\nevent: run.started')).toBeNull();
  });

  it('缺 event 行时退回 payload 里的 event 字段', () => {
    expect(
      parseSseBlock('data: {"event":"run.started","data":{}}')?.event,
    ).toBe('run.started');
  });

  it('data 不是 JSON 对象时丢掉，不让上层崩', () => {
    expect(parseSseBlock('data: not-json')).toBeNull();
  });

  it('冒号后的一个空格要剥掉（"data: x" 与 "data:x" 等价）', () => {
    expect(
      parseSseBlock('event: message.delta\ndata: {"data":{"delta":"好"}}')
        ?.data,
    ).toEqual({ delta: '好' });
  });
});

describe('流式切帧', () => {
  it('一帧被切成两个 chunk 时要等齐了才产出', () => {
    const decoder = new SseDecoder();
    expect(decoder.push('event: message.delta\ndata: {"data"')).toEqual([]);
    expect(decoder.push(':{"delta":"你"}}\n\n')).toEqual([
      expect.objectContaining({
        event: 'message.delta',
        data: { delta: '你' },
      }),
    ]);
  });

  it('一个 chunk 里有多帧时全部产出', () => {
    const decoder = new SseDecoder();
    const frames = decoder.push(
      'event: a\ndata: {}\n\nevent: b\ndata: {}\n\nevent: c\ndata: {}\n\n',
    );
    expect(frames.map((f) => f.event)).toEqual(['a', 'b', 'c']);
  });

  it('CRLF 换行也能切（SSE 规范的行分隔符）', () => {
    const decoder = new SseDecoder();
    expect(
      decoder.push('event: run.completed\r\ndata: {"data":{}}\r\n\r\n').length,
    ).toBe(1);
  });

  it('心跳混在事件之间不影响事件本身', () => {
    const decoder = new SseDecoder();
    const frames = decoder.push(
      ': ping\n\nevent: a\ndata: {}\n\n: ping\n\nevent: b\ndata: {}\n\n',
    );
    expect(frames.map((f) => f.event)).toEqual(['a', 'b']);
  });
});

/** 一个假的流式响应：按 chunk 依次吐出字节。 */
const streamResponse = (
  chunks: string[],
  init: { ok?: boolean; status?: number } = {},
): Response => {
  let index = 0;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response;
};

/** 订阅一个 Observable，把帧收成数组。 */
const collectFrames = (source: Observable<RunEventFrame>) =>
  new Promise<RunEventFrame[]>((resolve, reject) => {
    const frames: RunEventFrame[] = [];
    source.subscribe({
      next: (frame) => frames.push(frame),
      error: reject,
      complete: () => resolve(frames),
    });
  });

describe('订阅事件流', () => {
  it('GET /api/v1/runs/{run_id}/events，要的是 text/event-stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(['']));

    await collectFrames(runEvents('r-1', { fetchImpl: fetchImpl as never }));

    const [url, options] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe(`${API_BASE}/runs/r-1/events`);
    expect(options.method).toBe('GET');
    expect(options.headers.Accept).toBe('text/event-stream');
    // 没有 lastEventId 就不带这个头 —— 带了后端会去解析一个空值
    expect(options.headers['Last-Event-ID']).toBeUndefined();
  });

  it('给了 lastEventId 就带上，后端从它之后开始补发', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(['']));

    await collectFrames(
      runEvents('r-1', {
        lastEventId: '1790942924262-0',
        fetchImpl: fetchImpl as never,
      }),
    );

    const [, options] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(options.headers['Last-Event-ID']).toBe('1790942924262-0');
  });

  it('令牌进了提前量窗口：订阅前先刷，用的必须是新 token', async () => {
    mockedNeedsRefresh.mockReturnValue(true);
    mockedAuthHeaders.mockReturnValue({ Authorization: 'Bearer old' });
    mockedRefresh.mockResolvedValue('new-token');

    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(['']));
    await collectFrames(runEvents('r-1', { fetchImpl: fetchImpl as never }));

    const [, options] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(options.headers.Authorization).toBe('Bearer new-token');
    // 预刷成功就不用再吃一次 401
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('⭐ 401 时自己刷一次再重试一次（umi 的拦截器看不见这条 fetch）', async () => {
    mockedNeedsRefresh.mockReturnValue(false);
    mockedAuthHeaders.mockReturnValue({ Authorization: 'Bearer dead' });
    mockedRefresh.mockResolvedValue('fresh-token');

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce(streamResponse(['']));

    await collectFrames(runEvents('r-1', { fetchImpl: fetchImpl as never }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, second] = fetchImpl.mock.calls[1] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(second.headers.Authorization).toBe('Bearer fresh-token');
  });

  it('刷不出来就只请求一次，报 401 而不是死循环', async () => {
    mockedNeedsRefresh.mockReturnValue(false);
    mockedAuthHeaders.mockReturnValue({ Authorization: 'Bearer dead' });
    mockedRefresh.mockRejectedValue(new Error('本地没有 refresh token'));

    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 } as Response);

    await expect(
      collectFrames(runEvents('r-1', { fetchImpl: fetchImpl as never })),
    ).rejects.toThrow(/401/);
    // 关键：没有 token 可换时**不许**再打第二次（否则就是死循环）
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('逐帧产出，流读完就 complete', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        streamResponse([
          'event: run.started\ndata: {"data":{"status":"running"}}\n\n',
          'event: message.delta\ndata: {"data":{"delta":"你"}}\n\nevent: run.completed',
          '\ndata: {"data":{"status":"completed"}}\n\n',
        ]),
      );

    const frames = await collectFrames(
      runEvents('r-1', { fetchImpl: fetchImpl as never }),
    );

    expect(frames.map((f) => f.event)).toEqual([
      'run.started',
      'message.delta',
      'run.completed',
    ]);
  });

  it('非 2xx 直接 error，且原因能读（503 有专门文案）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(streamResponse([], { ok: false, status: 503 }));

    await expect(
      collectFrames(runEvents('r-1', { fetchImpl: fetchImpl as never })),
    ).rejects.toThrow(/事件流不可用.*503/);

    // 503 不重试：Redis 没起来不是等 500ms 就能好的
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * ⭐ 真实踩过的那个 404：`POST /runs` 的响应是在事务提交**之前**发出去的
   * （FastAPI 的 `async with AsyncExitStack()` 里先 `await response(...)`，
   * 退出时才 COMMIT）。浏览器收到响应立刻订阅，另一条连接查库查不到 → 404。
   * 所以建流这一次必须容忍 404，而不是当成"运行没了"直接报错。
   */
  it('⭐ 刚建完运行就订阅：404 等一下再订就成功', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce(
        streamResponse([
          'event: run.started\ndata: {"data":{"status":"running"}}\n\n',
        ]),
      );

    const frames = await collectFrames(
      runEvents('r-1', {
        fetchImpl: fetchImpl as never,
        // 免等：真实间隔是 500ms，这里只验"会重试"
        notFoundRetry: { delayMs: 0 },
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(frames.map((f) => f.event)).toEqual(['run.started']);
  });

  it('连续 404：重试 3 次才报错，文案写明已经重试过', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404 } as Response);

    await expect(
      collectFrames(
        runEvents('r-1', {
          fetchImpl: fetchImpl as never,
          notFoundRetry: { delayMs: 0 },
        }),
      ),
    ).rejects.toThrow(/已经不在后端.*已自动重试 3 次.*重新发送/);

    // 首次 + 3 次重试 = 4 次。再多就是打后端了
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('退订会打断 404 的重试等待 —— 用户走了就别再打后端', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404 } as Response);

      const subscription = runEvents('r-1', {
        fetchImpl: fetchImpl as never,
      }).subscribe();

      // 让第一次 404 落地、进入 500ms 的等待
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      subscription.unsubscribe();
      await vi.advanceTimersByTimeAsync(5_000);

      // abort 把等待打断 → 后续的重试一次都没发出去
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('退订会 abort 掉请求 —— 切会话时不留悬挂连接', async () => {
    let aborted = false;
    const fetchImpl = vi
      .fn()
      .mockImplementation((_url: string, options: { signal: AbortSignal }) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
        });
        // 永不结束的流
        return Promise.resolve({
          ok: true,
          status: 200,
          body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
        });
      });

    const subscription = runEvents('r-1', {
      fetchImpl: fetchImpl as never,
    }).subscribe();
    subscription.unsubscribe();

    expect(aborted).toBe(true);
  });
});

describe('投递节奏：不能等整段收完才渲染', () => {
  /**
   * 记录每一帧到达时，事件循环已经转过几圈。
   *
   * 关键：0 表示"与订阅代码同一个 tick"（同步发出），>0 表示"至少让出过一次"。
   * React 18+ 会把同一个 tick 里的多次 setState 批成**一次**渲染 ——
   * 所以同一 chunk 里的几十帧如果同步倒出去，界面就看不到逐字增长。
   */
  const collectWithTurns = async (
    source: Observable<RunEventFrame>,
  ): Promise<number[]> => {
    let turn = 0;
    const turns: number[] = [];
    // 用 MessageChannel 宏任务推进（与实现里让出事件循环的方式一致）：
    // 每完成一个宏任务 turn +1，它就是"事件循环圈数"
    const channel = new MessageChannel();
    let running = true;
    channel.port1.onmessage = () => {
      if (!running) return;
      turn += 1;
      channel.port2.postMessage(undefined);
    };
    channel.port2.postMessage(undefined);

    await new Promise<void>((resolve, reject) => {
      source.subscribe({
        next: () => turns.push(turn),
        error: reject,
        complete: resolve,
      });
    });
    running = false;
    channel.port1.close();
    return turns;
  };

  /** 把 N 帧塞进**同一个 chunk** —— 复刻后端一次 TCP 送一大段的情况。 */
  const oneChunk = (count: number) => {
    const deltas = Array.from(
      { length: count },
      (_, i) => `event: message.delta\ndata: {"data":{"delta":"${i}"}}\n\n`,
    ).join('');
    return streamResponse([
      `${deltas}event: run.completed\ndata: {"data":{}}\n\n`,
    ]);
  };

  it('同一个 chunk 里的多帧之间要让出事件循环（否则 React 批成一次渲染）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(oneChunk(6));
    const turns = await collectWithTurns(
      runEvents('r-1', { fetchImpl: fetchImpl as never }),
    );

    expect(turns.length).toBe(7); // 6 个 delta + 1 个 run.completed
    // 第 1 帧同步发出（首字不能延迟），之后每一帧都必须比上一帧多转过至少一圈
    expect(turns[0]).toBe(0);
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]).toBeGreaterThan(turns[i - 1]);
    }
  });

  it('一帧一个 chunk 时零额外让出（不给正常流式增加任何延迟）', async () => {
    // 这里的假 read() 是**微任务** resolve（真实 ReadableStream 是宏任务），
    // 于是 turns 里的每一圈都只可能来自实现主动的 yieldToEventLoop ——
    // 正好用来断言"这种情况下一次都不该让"。
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        streamResponse([
          'event: message.delta\ndata: {"data":{"delta":"1"}}\n\n',
          'event: message.delta\ndata: {"data":{"delta":"2"}}\n\n',
          'event: run.completed\ndata: {"data":{}}\n\n',
        ]),
      );
    const turns = await collectWithTurns(
      runEvents('r-1', { fetchImpl: fetchImpl as never }),
    );

    expect(turns.length).toBe(3);
    expect(turns).toEqual([0, 0, 0]);
  });

  it('让出期间退订：不再发后面的帧，也不抛错', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(oneChunk(20));
    const seen: string[] = [];

    const subscription = runEvents('r-1', {
      fetchImpl: fetchImpl as never,
    }).subscribe((frame) => {
      seen.push(frame.event);
      if (seen.length === 2) subscription.unsubscribe();
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    // 最多收到触发退订的那两帧，不会继续把剩下的 18 帧倒出来
    expect(seen.length).toBeLessThanOrEqual(3);
  });
});

describe('会话历史', () => {
  it('GET /api/v1/sessions/{id}/messages，默认不带游标', async () => {
    await listSessionMessages('s-1');

    expect(request).toHaveBeenCalledWith(`${API_BASE}/sessions/s-1/messages`, {
      method: 'GET',
      // 空对象而不是 undefined：axios 两种都接受，但空对象不会拼出 "?"。
      params: {},
      skipErrorHandler: true,
    });
  });

  it('游标与 limit 原样透传（游标不透明，后端原样回传）', async () => {
    await listSessionMessages('s-1', {
      limit: 50,
      before: 'djE6MQ',
    });

    const [, options] = mocked.mock.calls[0] as unknown as [
      string,
      { params: Record<string, unknown> },
    ];
    expect(options.params).toEqual({ limit: 50, before: 'djE6MQ' });
  });

  it('响应原样返回（不解析游标、不重排）', async () => {
    const page = {
      session_id: 's-1',
      messages: [],
      pagination: {
        limit: 10,
        has_more_before: false,
        before_cursor: 'djE6MQ',
        has_more_after: false,
        after_cursor: null,
      },
    };
    mocked.mockResolvedValue(page);

    expect(await listSessionMessages('s-1')).toBe(page);
  });

  it('会话不存在是 404，能从错误里读出来（与"空数组"是两件事）', async () => {
    mocked.mockRejectedValue({
      response: { status: 404, data: { detail: '会话不存在：s-1' } },
    });

    await expect(listSessionMessages('s-1')).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});

describe('错误文案', () => {
  it('优先用 FastAPI 的 detail 字符串（404 就是这种）', () => {
    expect(
      describeRuntimeError({
        response: { status: 404 },
        data: { detail: '会话不存在：s-1' },
      }),
    ).toBe('会话不存在：s-1');
  });

  it('422 的 detail 是数组时拼出「字段: 原因」', () => {
    expect(
      describeRuntimeError({
        response: { status: 422 },
        data: {
          detail: [{ loc: ['body', 'input', 'text'], msg: 'Field required' }],
        },
      }),
    ).toBe('body.input.text: Field required');
  });

  it('没有 detail 时退到 HTTP 状态码', () => {
    expect(describeRuntimeError({ response: { status: 500 } })).toBe(
      'HTTP 500',
    );
  });

  it('连响应都没有（后端没起）时退到 message', () => {
    expect(describeRuntimeError(new Error('Network Error'))).toBe(
      'Network Error',
    );
  });

  it('什么都给不出来时也有兜底', () => {
    expect(describeRuntimeError(null)).toBe('未知错误');
  });

  it('⚠️ axios 的错误体在 response.data 上（不在 data 上）—— 必须读得到', () => {
    // @umijs/max 的 request 是 axios：只写 err.data 的话这句中文会被丢掉，
    // 界面上就只剩一个 "HTTP 404"（踩过）。
    const axiosError = {
      response: {
        status: 404,
        data: { detail: '会话不存在：3f2a…' },
      },
      message: 'Request failed with status code 404',
    };

    expect(describeRuntimeError(axiosError)).toBe('会话不存在：3f2a…');
  });

  it('自己 fetch 抛的错（detail 在 data 上）同样读得到', () => {
    expect(
      describeRuntimeError({
        data: { detail: '运行不存在' },
        response: { status: 404 },
      }),
    ).toBe('运行不存在');
  });

  it('没有 detail 时状态码与 message 一起给（别只留一个 HTTP 404）', () => {
    expect(
      describeRuntimeError({
        response: { status: 503 },
        message: '订阅事件流失败：事件流不可用',
      }),
    ).toBe('订阅事件流失败：事件流不可用（HTTP 503）');
  });

  it('422 的 detail 在 response.data 里也能拼出「字段: 原因」', () => {
    expect(
      describeRuntimeError({
        response: {
          status: 422,
          data: {
            detail: [{ loc: ['body', 'input', 'text'], msg: 'Field required' }],
          },
        },
      }),
    ).toBe('body.input.text: Field required');
  });
});

describe('statusOf', () => {
  it('认得出 axios 的状态码', () => {
    expect(statusOf({ response: { status: 404 } })).toBe(404);
  });

  it('没有 response 时是 undefined（不会被当成 404 去重试）', () => {
    expect(statusOf(new Error('Network Error'))).toBeUndefined();
  });
});
