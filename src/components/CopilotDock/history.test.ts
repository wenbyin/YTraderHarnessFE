// src/components/CopilotDock/history.test.ts
//
// 转换层是「后端历史」与「聊天界面」之间唯一的翻译点，错了不会报错 ——
// 只会安静地少显示几条或者显示空气泡。所以过滤规则必须逐条钉住。
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentBlock, SessionMessage } from './agentRuntime';
import {
  classifyMessage,
  interactionOf,
  messageText,
  reasoningOf,
  toAgentMessage,
  toAgentMessages,
  toolActivityOf,
} from './history';
import { rememberToolStatuses, resetToolStatusCache } from './toolStatusCache';

const block = (text: string | null): ContentBlock => ({
  type: 'text',
  text,
  artifact_id: null,
  source_id: null,
});

const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  ({ type: 'tool_call', id: `c-${name}`, name, args }) as ContentBlock;

const message = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  message_id: 'm-1',
  seq: 1,
  run_id: 'r-1',
  role: 'user',
  kind: 'chat',
  business_agent_id: null,
  content: [block('你好')],
  status: 'completed',
  reply_to_message_id: null,
  created_at: '2026-10-03T03:11:32.776052Z',
  // 契约里恒等于 created_at（消息写一次就不再改）
  updated_at: '2026-10-03T03:11:32.776052Z',
  metadata: {},
  ...over,
});

describe('messageText', () => {
  it('单个文本块原样取出', () => {
    expect(messageText(message())).toBe('你好');
  });

  it('多个文本块用空行连接（不能粘在一起，块之间是结构边界）', () => {
    const m = message({ content: [block('正文'), block('引用来源')] });
    expect(messageText(m)).toBe('正文\n\n引用来源');
  });

  it('text 缺失或为 null 的块当空（附件块没有文本）', () => {
    const m = message({
      content: [{ type: 'artifact', artifact_id: 'a-1' }, block('正文')],
    });
    expect(messageText(m)).toBe('正文');
  });

  it('全是空白时返回空串，调用方据此识别"没有可显示内容"', () => {
    expect(messageText(message({ content: [block('   '), block('')] }))).toBe(
      '',
    );
  });
});

describe('classifyMessage：每种 kind 画成什么（或不该画）', () => {
  it('chat 画成普通气泡', () => {
    expect(classifyMessage(message({ kind: 'chat' }))).toBe('chat');
  });

  it('⭐ tool_activity 也显示，但走自己那一路（不是普通气泡）', () => {
    expect(classifyMessage(message({ kind: 'tool_activity' }))).toBe(
      'tool_activity',
    );
    // 带 tool_call 块的更典型：正文可能就是空的
    const call = message({ kind: 'tool_activity', content: [toolCall('foo')] });
    expect(classifyMessage(call)).toBe('tool_activity');
  });

  it('⭐ interaction（HITL 问答）显示成"我发出的那条消息"', () => {
    const interaction = message({
      kind: 'interaction',
      content: [
        block('Q: 继续吗？\nA: 继续'),
        {
          type: 'interaction',
          questions: [
            { question: '继续吗？', options: [], multiSelect: false },
          ],
          answers: { '继续吗？': '继续' },
          annotations: {},
        } as unknown as ContentBlock,
      ],
    });
    expect(classifyMessage(interaction)).toBe('interaction');
  });

  it('notice 仍然不显示（它不是"谁说的话"）', () => {
    expect(classifyMessage(message({ kind: 'notice' }))).toBeNull();
  });

  it('interaction 里读不出问题、也没有文本 -> 不显示（否则是空卡片）', () => {
    expect(
      classifyMessage(message({ kind: 'interaction', content: [] })),
    ).toBeNull();
  });

  it('角色必须是 user / assistant —— 不认的角色宁可不显示', () => {
    expect(classifyMessage(message({ role: 'assistant' }))).toBe('chat');
    // 后端将来加角色时，不该冒出一个我们不认的空白气泡
    expect(classifyMessage(message({ role: 'system' as never }))).toBeNull();
  });

  it('chat 没有可显示文本时不显示（否则是空气泡）', () => {
    expect(classifyMessage(message({ content: [] }))).toBeNull();
    expect(classifyMessage(message({ content: [block('  ')] }))).toBeNull();
  });

  it('tool_activity 既没工具调用又没文本时不显示（空壳）', () => {
    expect(
      classifyMessage(message({ kind: 'tool_activity', content: [] })),
    ).toBe(null);
  });
});

describe('toolActivityOf：抽出工具调用的三件套', () => {
  it('tool_call 块 -> calls；没有 tool_call 块 -> 空数组（= 工具结果）', () => {
    const call = message({
      kind: 'tool_activity',
      content: [block('我先查一下'), toolCall('a.b.c', { q: 1 })],
    });
    const view = toolActivityOf(call);
    expect(view.calls).toEqual([
      { id: 'c-a.b.c', name: 'a.b.c', args: { q: 1 } },
    ]);
    // 旁白仍然在（模型的话不能因为"旁边有工具调用"就丢掉）
    expect(view.text).toBe('我先查一下');

    const result = message({
      kind: 'tool_activity',
      content: [block('{"ok":true}')],
    });
    expect(toolActivityOf(result).calls).toEqual([]);
    expect(toolActivityOf(result).text).toBe('{"ok":true}');
  });

  it('字段缺失/类型不对时降级，不把 undefined 漏进界面', () => {
    const weird = message({
      kind: 'tool_activity',
      content: [{ type: 'tool_call' } as ContentBlock],
    });
    expect(toolActivityOf(weird).calls).toEqual([
      { id: '', name: '', args: null },
    ]);
  });
});

describe('toAgentMessage', () => {
  it('id 沿用后端 message_id（稳定，重载不变）', () => {
    expect(toAgentMessage(message()).id).toBe('m-1');
  });

  it('后端字段进 metadata，界面上能看出这条来自哪次运行', () => {
    const m = message({ seq: 7, run_id: 'r-9', status: 'failed' });
    expect(toAgentMessage(m).metadata).toMatchObject({
      messageId: 'm-1',
      seq: 7,
      runId: 'r-9',
      status: 'failed',
      kind: 'chat',
    });
  });

  it('content 是字符串（AG-UI 要的是字符串，不是后端的内容块数组）', () => {
    expect(toAgentMessage(message()).content).toBe('你好');
  });

  it('⭐ tool_activity 的渲染原料随 metadata 带下去', () => {
    // 渲染层只拿得到 AG-UI Message（content 是字符串），拿不到内容块数组 ——
    // "调了哪个工具、参数是什么"必须在这一步就抽出来。
    const m = message({
      kind: 'tool_activity',
      content: [toolCall('agent.platform.list', { limit: 3 })],
    });
    expect(toAgentMessage(m).metadata).toMatchObject({
      kind: 'tool_activity',
      toolActivity: {
        calls: [
          {
            id: 'c-agent.platform.list',
            name: 'agent.platform.list',
            args: { limit: 3 },
          },
        ],
        text: '',
      },
    });
  });

  it('chat 不带那个字段（渲染层据此走普通气泡）', () => {
    const meta = toAgentMessage(message()).metadata as Record<string, unknown>;
    expect(meta.toolActivity).toBeUndefined();
  });

  it('⭐ interaction 的问答随 metadata 带下去（渲染层据此画"我发出的消息"）', () => {
    const m = message({
      kind: 'interaction',
      content: [
        block('Q: 继续吗？\nA: 继续'),
        {
          type: 'interaction',
          questions: [
            {
              question: '继续吗？',
              header: '确认',
              options: [{ label: '继续', description: '', preview: null }],
              multiSelect: false,
            },
          ],
          answers: { '继续吗？': '继续' },
          annotations: {},
        } as unknown as ContentBlock,
      ],
    });

    expect(toAgentMessage(m).metadata).toMatchObject({
      kind: 'interaction',
      interaction: {
        questions: [
          { question: '继续吗？', header: '确认', multiSelect: false },
        ],
        answers: { '继续吗？': '继续' },
      },
    });
  });
});

describe('interactionOf：HITL 问答的问答对', () => {
  const interactionMsg = (
    questions?: unknown,
    answers?: unknown,
  ): SessionMessage =>
    message({
      kind: 'interaction',
      content: [
        block('Q: 问题甲\nA: 答甲'),
        {
          type: 'interaction',
          questions,
          answers,
          annotations: {},
        } as unknown as ContentBlock,
      ],
    });

  it('questions 用实时提问卡片**同一个**解析器（多选题、空 label 等规则一致）', () => {
    const view = interactionOf(
      interactionMsg(
        [
          {
            question: '用哪个数据源？',
            header: '数据源',
            options: [
              { label: '东财', description: 'A 股', preview: null },
              { label: '', description: '没名字，丢掉' },
            ],
            multiSelect: true,
          },
        ],
        { '用哪个数据源？': '东财' },
      ),
    );

    expect(view.questions).toEqual([
      {
        question: '用哪个数据源？',
        header: '数据源',
        options: [{ label: '东财', description: 'A 股', preview: '' }],
        multiSelect: true,
      },
    ]);
    expect(view.answers).toEqual({ '用哪个数据源？': '东财' });
  });

  it('answers 只收字符串，别的类型一律丢掉（不把 undefined 漏进界面）', () => {
    const view = interactionOf(
      interactionMsg([{ question: '继续吗？' }], {
        '继续吗？': '继续',
        坏值: 42,
      }),
    );
    expect(view.answers).toEqual({ '继续吗？': '继续' });
  });

  it('没有 interaction 块 -> 空问答（渲染层据此不画空卡片）', () => {
    const view = interactionOf(message({ kind: 'interaction', content: [] }));
    expect(view).toEqual({ questions: [], answers: {} });
  });
});

describe('toAgentMessages', () => {
  it('保持后端给定的顺序（seq 升序 = 时间序，不二次排序）', () => {
    const list = [
      message({ message_id: 'a', seq: 1 }),
      message({ message_id: 'b', seq: 2, role: 'assistant' }),
      message({ message_id: 'c', seq: 3 }),
    ];
    expect(toAgentMessages(list).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('滤掉不可显示的，其余一条不少（tool_activity 现在也留）', () => {
    const list = [
      message({ message_id: 'a', seq: 1 }),
      message({ message_id: 'b', seq: 2, kind: 'tool_activity' }),
      message({ message_id: 'c', seq: 3, content: [] }),
      message({ message_id: 'd', seq: 4, role: 'assistant' }),
      message({ message_id: 'e', seq: 5, kind: 'notice' }),
    ];
    expect(toAgentMessages(list).map((m) => m.id)).toEqual(['a', 'b', 'd']);
  });

  it('同一条历史里，工具调用排在它前后两条正文之间（顺序不动）', () => {
    const list = [
      message({ message_id: 'u', seq: 1 }),
      message({
        message_id: 't1',
        seq: 2,
        role: 'assistant',
        kind: 'tool_activity',
        content: [toolCall('search')],
      }),
      message({
        message_id: 't2',
        seq: 3,
        role: 'assistant',
        kind: 'tool_activity',
        content: [block('结果')],
      }),
      message({ message_id: 'a', seq: 4, role: 'assistant' }),
    ];
    expect(toAgentMessages(list).map((m) => m.id)).toEqual([
      'u',
      't1',
      't2',
      'a',
    ]);
  });

  it('空历史得到空数组（不是一条空气泡）', () => {
    expect(toAgentMessages([])).toEqual([]);
  });

  it('不去重：重复的 message_id 原样返回（脏数据要暴露而不是被藏起来）', () => {
    const dup = [
      message({ message_id: 'a', seq: 1 }),
      message({ message_id: 'a', seq: 1 }),
    ];
    expect(toAgentMessages(dup)).toHaveLength(2);
  });
});

/**
 * 思维链。
 *
 * ⚠️ 取值规则是**两个来源取先非空者**，顺序不能改 ——
 * `reasoning_content ?? content 里 type=reasoning 的块`。
 * 契约 messages.yaml 里也是这么写的：那一列是后加的，存量行没有它。
 */
describe('reasoningOf', () => {
  it('新消息：只读 reasoning_content 那一列', () => {
    const m = message({
      role: 'assistant',
      reasoning_content: '先想一下要不要查工具。',
    });
    expect(reasoningOf(m)).toBe('先想一下要不要查工具。');
  });

  it('⭐ 存量行：推理躺在 content 的块数组里（那一列整个键都没有）', () => {
    const m = message({
      role: 'assistant',
      content: [
        { type: 'reasoning', reasoning: '存量推理' } as ContentBlock,
        block('正文'),
      ],
    });
    expect(reasoningOf(m)).toBe('存量推理');
  });

  it('推理块的文本也可能放在 text 键里（两种键都出现过，只认一种会静默取不到）', () => {
    const m = message({
      role: 'assistant',
      content: [{ type: 'reasoning', text: '放 text 的推理' } as ContentBlock],
    });
    expect(reasoningOf(m)).toBe('放 text 的推理');
  });

  it('⭐ 两个来源都有时以新字段为准（新写入的消息不会在 content 里再放一遍）', () => {
    const m = message({
      role: 'assistant',
      reasoning_content: '新的',
      content: [{ type: 'reasoning', reasoning: '旧的' } as ContentBlock],
    });
    expect(reasoningOf(m)).toBe('新的');
  });

  it('没有推理 = 空串（"这次没有" 与 "推理是空的" 都按没有处理）', () => {
    expect(reasoningOf(message({ role: 'assistant' }))).toBe('');
    expect(
      reasoningOf(message({ role: 'assistant', reasoning_content: null })),
    ).toBe('');
    expect(
      reasoningOf(message({ role: 'assistant', reasoning_content: '   ' })),
    ).toBe('');
  });
});

describe('推理不进正文（否则会显示两遍）', () => {
  it('⭐ messageText 跳过 type=reasoning 的块', () => {
    const m = message({
      role: 'assistant',
      content: [
        { type: 'reasoning', reasoning: '草稿纸' } as ContentBlock,
        block('正文'),
      ],
    });
    expect(messageText(m)).toBe('正文');
  });

  it('⭐ 只有推理的 chat 消息**不丢**（气泡空、折叠区有内容，也是一条真实回答）', () => {
    const m = message({
      role: 'assistant',
      content: [{ type: 'reasoning', reasoning: '只想了没答' } as ContentBlock],
    });
    expect(messageText(m)).toBe('');
    expect(classifyMessage(m)).toBe('chat');
  });

  it('既没正文又没推理的空气泡照旧不显示', () => {
    const m = message({ role: 'assistant', content: [block('   ')] });
    expect(classifyMessage(m)).toBeNull();
  });

  it('⭐ 推理随 metadata 带过去（渲染层只看得到被压成字符串的 content）', () => {
    const m = message({
      role: 'assistant',
      reasoning_content: '草稿纸',
      content: [block('正文')],
    });
    const meta = toAgentMessage(m).metadata as { reasoning?: string };
    expect(meta.reasoning).toBe('草稿纸');
  });

  it('没有推理时不塞这个字段（空串会让界面渲染出一个空折叠块）', () => {
    const meta = toAgentMessage(message({ role: 'assistant' })).metadata as {
      reasoning?: string;
    };
    expect(meta.reasoning).toBeUndefined();
  });
});

/**
 * 刷新之后工具行要和刚才 SSE 里一模一样 —— 数据来源是本地存档
 * （toolStatusCache），因为后端**没有**把逐次成败落库。
 *
 * ⚠️ 存档是**按后端 run_id 分桶**的（不是"这一页里最后一次运行"），
 *    所以每条消息拿它自己的 run_id 去问 —— 审批前后那两段因此都有图标。
 */
describe('工具调用的成败：从本地存档补（按 run_id 分桶）', () => {
  const toolMsg = (id: string, runId: string, names: string[], seq: number) =>
    message({
      message_id: id,
      seq,
      run_id: runId,
      kind: 'tool_activity',
      role: 'assistant',
      content: names.map(
        (name) =>
          ({
            type: 'tool_call',
            id: `c-${name}`,
            name,
            args: {},
          }) as ContentBlock,
      ),
    });

  const callsOf = (m: { metadata?: unknown }) =>
    (
      m.metadata as {
        toolActivity?: { calls: { name: string; status?: string }[] };
      }
    ).toolActivity?.calls ?? [];

  beforeEach(() => {
    resetToolStatusCache();
  });

  it('⭐ 这次运行的调用带上存档里的状态（含错误文案）', () => {
    rememberToolStatuses('s-1', [
      { key: 'k1', name: 'web.search', status: 'done', runId: 'r-1' },
      {
        key: 'k2',
        name: 'doc.read',
        status: 'error',
        error: '超时',
        runId: 'r-1',
      },
    ]);

    const [first] = toAgentMessages(
      [toolMsg('m-1', 'r-1', ['web.search', 'doc.read'], 1)],
      's-1',
    );

    expect(callsOf(first)).toEqual([
      { id: 'c-web.search', name: 'web.search', args: {}, status: 'done' },
      {
        id: 'c-doc.read',
        name: 'doc.read',
        args: {},
        status: 'error',
        error: '超时',
      },
    ]);
  });

  it('⚠️ 别的运行不补：run_id 对不上就没有桶，套上去就是张冠李戴', () => {
    rememberToolStatuses('s-1', [
      {
        key: 'k1',
        name: 'web.search',
        status: 'error',
        error: '这一轮失败了',
        runId: 'r-new',
      },
    ]);

    const list = [
      toolMsg('m-1', 'r-old', ['web.search'], 1),
      toolMsg('m-2', 'r-new', ['web.search'], 2),
    ];
    const [oldest, newest] = toAgentMessages(list, 's-1');

    expect(callsOf(newest)[0].status).toBe('error');
    // 另一次运行没有状态 —— 宁可没有图标，也不要拿别的运行来凑
    expect(callsOf(oldest)[0].status).toBeUndefined();
  });

  it('⭐⭐ HITL：审批前后两条记录属于同一个 run_id -> 两张卡都有图标', () => {
    // 一次审批在界面侧是两次 AG-UI run，但后端 run_id 是同一个
    // （见 agent.ts / toolStatusCache 的文件头）。
    rememberToolStatuses('s-1', [
      { key: 'k1', name: 'web.search', status: 'done', runId: 'r-1' },
      {
        key: 'k2',
        name: 'db.write',
        status: 'error',
        error: '审批后被拒',
        runId: 'r-1',
      },
    ]);

    const list = [
      toolMsg('m-1', 'r-1', ['web.search'], 1),
      toolMsg('m-2', 'r-1', ['db.write'], 2),
    ];
    const [before, after] = toAgentMessages(list, 's-1');

    expect(callsOf(before)[0].status).toBe('done');
    expect(callsOf(after)[0]).toMatchObject({
      status: 'error',
      error: '审批后被拒',
    });
  });

  it('没有存档（别的浏览器 / 清了缓存）-> 一条状态都不填', () => {
    const [msg] = toAgentMessages(
      [toolMsg('m-1', 'r-1', ['web.search'], 1)],
      's-1',
    );

    expect(callsOf(msg)[0].status).toBeUndefined();
  });

  it('不传 sessionId 时同旧行为（单条转换不查存档）', () => {
    rememberToolStatuses('s-1', [
      { key: 'k1', name: 'web.search', status: 'done', runId: 'r-1' },
    ]);

    const msg = toAgentMessage(toolMsg('m-1', 'r-1', ['web.search'], 1));

    expect(callsOf(msg)[0].status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 任务的两条边界（2026-10-22）
//
// 用户：「识别后端的 message 类型。现在 main 节点的 task_instruction，
// task_result 也会回复。将他也生成在对话框中。」—— 也就是说这两条**要显示**，
// 而且要靠 metadata 里的 task_id 挂到时间线上（见 taskTimeline.ts）。
// 这里钉的是转换层的那一半：**分类要认、归属要带过去**。
// ---------------------------------------------------------------------------
describe('任务消息（task_instruction / task_result）', () => {
  const taskMessage = (
    kind: 'task_instruction' | 'task_result',
    meta: Record<string, unknown> = {
      task_id: 't-1',
      plan_id: 'p-1',
      skill_key: 'financial_research',
    },
  ) =>
    message({
      kind,
      role: kind === 'task_instruction' ? 'user' : 'assistant',
      content: [block(kind === 'task_instruction' ? '任务说明' : '任务结果')],
      metadata: meta,
    });

  it('⭐ 两种都分类成 task（之前是 null —— 整条消息被丢掉）', () => {
    expect(classifyMessage(taskMessage('task_instruction'))).toBe('task');
    expect(classifyMessage(taskMessage('task_result'))).toBe('task');
  });

  it('没有可显示内容的（正文与推理都空）仍然不画', () => {
    const empty = message({
      kind: 'task_result',
      role: 'assistant',
      content: [],
      metadata: { task_id: 't-1' },
    });

    expect(classifyMessage(empty)).toBeNull();
  });

  it('⭐ task_id / plan_id / skill_key 随 metadata 带过去（时间线靠它分组）', () => {
    const converted = toAgentMessage(taskMessage('task_instruction'));
    const meta = converted.metadata as { task?: unknown };

    expect(meta.task).toEqual({
      kind: 'task_instruction',
      taskId: 't-1',
      planId: 'p-1',
      skillKey: 'financial_research',
    });
  });

  it('缺字段时给空串（不是 undefined —— 空串在 taskTimeline 里是"没有就降级"）', () => {
    const converted = toAgentMessage(taskMessage('task_result', {}));
    const meta = converted.metadata as { task?: unknown };

    expect(meta.task).toEqual({
      kind: 'task_result',
      taskId: '',
      planId: '',
      skillKey: '',
    });
  });

  it('普通消息不带那份归属（时间线不该因为"看起来像"就长出轨道）', () => {
    const converted = toAgentMessage(message());
    const meta = converted.metadata as { task?: unknown };

    expect(meta.task).toBeUndefined();
  });

  it('toAgentMessages 不再把它们过滤掉（这是"生成在对话框中"的前提）', () => {
    const converted = toAgentMessages([
      message({ message_id: 'u1', kind: 'chat' }),
      { ...taskMessage('task_instruction'), message_id: 'i1' },
      { ...taskMessage('task_result'), message_id: 'r1' },
    ]);

    expect(converted.map((item) => item.id)).toEqual(['u1', 'i1', 'r1']);
  });
});
