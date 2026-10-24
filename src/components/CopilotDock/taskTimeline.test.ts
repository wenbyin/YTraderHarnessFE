// src/components/CopilotDock/taskTimeline.test.ts
//
// 任务时间线的**分组**逻辑 —— 谁跟谁是同一个任务、节点画在哪一行。
//
// 这一层是纯函数，错的后果全是"看起来只是有点乱"：节点画错行、收尾之后
// 主对话的回答被吸进最后一个任务的轨道、两个任务被并成一个。所以每条
// 边界都钉一个用例。
import type { Message } from '@ag-ui/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { noteLiveTask, resetLiveTasks } from './liveTaskFeed';
import { taskTitle } from './planTasks';
import {
  planIndexOf,
  taskBoundaryOf,
  taskDescriptionOf,
  taskMessageOf,
  taskRowLabel,
  taskRowOf,
  taskRowsOf,
  taskShortTitle,
} from './taskTimeline';

/**
 * 一段**真实格式**的 task_instruction 正文（后端 task_prompt.render_task_instruction
 * 拼出来的那套：标题行 / 任务 ID / 任务说明 / 任务参数 / 输出要求）。
 *
 * 测试里用真格式而不是 `content: id`，因为节点标题是从这段文本里抠出来的 ——
 * 抠错的表现就是"刷新前后不一致"，必须钉住。
 */
const instructionBody = (description: string, params?: unknown) => {
  const lines = [
    '你当前处于任务执行模式。',
    '请完成下面的任务，产出任务结果；**不要**回答用户输入。',
    '',
    '任务 ID：t1',
    '技能：financial_research',
    '',
    '任务说明：',
    description,
  ];

  if (params !== undefined) {
    lines.push(
      '',
      '任务参数：',
      '```json',
      JSON.stringify(params, null, 2),
      '```',
    );
  }

  lines.push(
    '',
    '输出要求：给出可被父图汇总的任务结果；不要重复用户问题，不要把任务说明当作对用户的答复。',
  );

  return lines.join('\n');
};

/** 一条普通消息（没有任务归属）。 */
const plain = (id: string, role: Message['role'] = 'assistant') =>
  ({ id, role, content: id }) as unknown as Message;

/** 一条任务边界消息（task_instruction / task_result）。 */
const task = (
  id: string,
  kind: 'task_instruction' | 'task_result',
  taskId: string,
  extra: { planId?: string; skillKey?: string; content?: string } = {},
) =>
  ({
    id,
    role: kind === 'task_instruction' ? 'user' : 'assistant',
    content: extra.content ?? id,
    metadata: {
      kind,
      task: {
        kind,
        taskId,
        planId: extra.planId ?? 'plan-1',
        skillKey: extra.skillKey ?? '',
      },
    },
  }) as unknown as Message;

beforeEach(() => {
  resetLiveTasks();
});

describe('taskBoundaryOf：认不认得出是任务的两条边界', () => {
  it('task_instruction / task_result 都认，并带回 task_id / plan_id / skill_key', () => {
    const instruction = taskBoundaryOf(
      task('i1', 'task_instruction', 't1', { skillKey: 'financial_research' }),
    );

    expect(instruction).toEqual({
      kind: 'task_instruction',
      taskId: 't1',
      planId: 'plan-1',
      skillKey: 'financial_research',
    });
  });

  it('★ 没有 task_id 的边界消息**不参与分组**（否则会退化成"一条一组"）', () => {
    expect(
      taskBoundaryOf({
        metadata: {
          kind: 'task_instruction',
          task: { kind: 'task_instruction', taskId: '' },
        },
      }),
    ).toBeNull();
  });

  it('普通消息（没有 metadata.task）一律不是边界', () => {
    expect(taskBoundaryOf(plain('a1'))).toBeNull();
    expect(taskBoundaryOf({ metadata: { kind: 'chat' } })).toBeNull();
  });
});

describe('taskRowsOf：历史通道的分组（instruction → 中间步 → result）', () => {
  it('★ 中间那些**没有 task_id** 的消息也归进这一组（靠作用域）', () => {
    const messages = [
      plain('u0', 'user'),
      task('i1', 'task_instruction', 't1'),
      plain('a1'),
      plain('t1-tool'),
      task('r1', 'task_result', 't1'),
      plain('a9'),
    ];

    const rows = taskRowsOf(messages);

    expect(rows.get('u0')).toBeUndefined();
    expect(rows.get('a9')).toBeUndefined();

    expect(rows.get('i1')).toMatchObject({
      taskId: 't1',
      role: 'instruction',
      ordinal: 1,
      first: true,
      last: false,
    });
    expect(rows.get('a1')).toMatchObject({ role: 'step', first: false });
    expect(rows.get('t1-tool')).toMatchObject({ role: 'step', first: false });
    expect(rows.get('r1')).toMatchObject({
      role: 'result',
      first: false,
      last: true,
    });
  });

  it('★ result 之后的消息**不再**属于这个任务（收尾）', () => {
    const rows = taskRowsOf([
      task('i1', 'task_instruction', 't1'),
      task('r1', 'task_result', 't1'),
      plain('a1'),
    ]);

    expect(rows.size).toBe(2);
    expect(rows.get('a1')).toBeUndefined();
  });

  it('两个任务 -> 序号连续，且第一个任务的组尾落在它的 result 上', () => {
    const rows = taskRowsOf([
      task('i1', 'task_instruction', 't1'),
      task('r1', 'task_result', 't1'),
      task('i2', 'task_instruction', 't2'),
      task('r2', 'task_result', 't2'),
    ]);

    expect(rows.get('i1')).toMatchObject({ ordinal: 1, last: false });
    expect(rows.get('r1')).toMatchObject({ ordinal: 1, last: true });
    expect(rows.get('i2')).toMatchObject({ ordinal: 2, first: true });
    expect(rows.get('r2')).toMatchObject({ ordinal: 2, last: true });
  });

  it('没有 result 的任务在下一条 instruction 处换组（组尾是换组前那一行）', () => {
    const rows = taskRowsOf([
      task('i1', 'task_instruction', 't1'),
      plain('a1'),
      task('i2', 'task_instruction', 't2'),
      plain('a2'),
    ]);

    // t1 没有 result 收尾，但在 i2 处换组了 -> 组尾落在 a1 上（不能越界盖到 i2）。
    expect(rows.get('i1')).toMatchObject({
      ordinal: 1,
      first: true,
      last: false,
    });
    expect(rows.get('a1')).toMatchObject({ ordinal: 1, last: true });
    expect(rows.get('i2')).toMatchObject({
      ordinal: 2,
      first: true,
      last: false,
    });
  });

  it('★ 只剩一条任务说明、一句话都没产出 -> 整组丢掉（不占节点也不占序号）', () => {
    const rows = taskRowsOf([
      task('i1', 'task_instruction', 't1'),
      plain('a1'),
      task('i2', 'task_instruction', 't2'),
    ]);

    // t1 跑过一步，照常成组。
    expect(rows.get('a1')).toMatchObject({ ordinal: 1, last: true });

    // t2 只落了任务说明、没有任何产出 —— 实时侧永远不会为它留标记，
    // 历史侧如果画出节点，就是"刷新后凭空多出一个任务"（用户 2026-10-22 的截图）。
    expect(rows.has('i2')).toBe(false);
    expect(rows.has('i1')).toBe(true);
  });

  it('只有 result（instruction 丢了）：自己成一个单行组', () => {
    const rows = taskRowsOf([task('r1', 'task_result', 't1')]);

    expect(rows.get('r1')).toMatchObject({
      role: 'result',
      first: true,
      last: true,
      ordinal: 1,
    });
  });

  it('plan_id / skill_key 缺一份时沿用组内已声明的那份', () => {
    const messages = [
      task('i1', 'task_instruction', 't1', { planId: 'p9', skillKey: 'sk' }),
      task('r1', 'task_result', 't1', { planId: '', skillKey: '' }),
    ];

    // result 那条的 metadata 里两个字段是空串 -> 沿用 instruction 的
    const patched = messages.map((message, index) =>
      index === 1
        ? ({
            ...message,
            metadata: {
              kind: 'task_result',
              task: {
                kind: 'task_result',
                taskId: 't1',
                planId: '',
                skillKey: '',
              },
            },
          } as unknown as Message)
        : message,
    );

    const rows = taskRowsOf(patched);

    expect(rows.get('r1')).toMatchObject({ planId: 'p9', skillKey: 'sk' });
  });
});

describe('taskRowsOf：实时通道的分组（按 messageId 的标记）', () => {
  it('★ 带标记的连续消息成一组，组首就是第一个带标记的', () => {
    noteLiveTask('a1', { taskId: 't1', title: '查财报', planId: 'p1' });
    noteLiveTask('a2', { taskId: 't1', title: '查财报', planId: 'p1' });

    const rows = taskRowsOf([plain('u0', 'user'), plain('a1'), plain('a2')]);

    expect(rows.get('u0')).toBeUndefined();
    expect(rows.get('a1')).toMatchObject({
      taskId: 't1',
      title: '查财报',
      role: 'step',
      first: true,
      last: false,
    });
    expect(rows.get('a2')).toMatchObject({ first: false, last: true });
  });

  it('★ 任务结束之后的消息**不进轨道**（不然主对话的总结会被吸进最后一个任务）', () => {
    noteLiveTask('a1', { taskId: 't1', title: '查财报', planId: 'p1' });

    const rows = taskRowsOf([plain('a1'), plain('a2')]);

    expect(rows.get('a1')).toMatchObject({ last: true });
    expect(rows.get('a2')).toBeUndefined();
  });

  it('两个任务交替时按先后各成一组，序号递增', () => {
    noteLiveTask('a1', { taskId: 't1', title: 'A', planId: 'p1' });
    noteLiveTask('a2', { taskId: 't2', title: 'B', planId: 'p1' });

    const rows = taskRowsOf([plain('a1'), plain('a2')]);

    expect(rows.get('a1')).toMatchObject({
      ordinal: 1,
      first: true,
      last: true,
    });
    expect(rows.get('a2')).toMatchObject({
      ordinal: 2,
      first: true,
      last: true,
    });
  });

  it('★ 历史边界优先于实时标记（同一条消息两边都有归属时以 metadata 为准）', () => {
    noteLiveTask('i1', { taskId: 'live-x', title: '实时标题', planId: 'p1' });
    noteLiveTask('r1', { taskId: 'live-x', title: '实时标题', planId: 'p1' });

    const rows = taskRowsOf([
      task('i1', 'task_instruction', 't1'),
      task('r1', 'task_result', 't1'),
    ]);

    // 用的是消息自己的 task_id / role，而不是实时标记那份。
    expect(rows.get('i1')).toMatchObject({
      taskId: 't1',
      role: 'instruction',
      title: '',
    });
    expect(rows.get('r1')).toMatchObject({ taskId: 't1', role: 'result' });
  });
});

describe('taskRowOf：缓存与空值', () => {
  it('同一个 messages 数组只算一次（返回同一个 Map）', () => {
    const messages = [task('i1', 'task_instruction', 't1')];

    expect(taskRowsOf(messages)).toBe(taskRowsOf(messages));
  });

  it('换一个数组引用就重新算（消息变了分组可能就变了）', () => {
    const first = [task('i1', 'task_instruction', 't1')];
    const second = [...first, task('r1', 'task_result', 't1')];

    expect(taskRowOf(first, 'r1')).toBeNull();
    expect(taskRowOf(second, 'r1')).not.toBeNull();
  });

  it('不在任何任务里的消息返回 null', () => {
    expect(taskRowOf([plain('a1')], 'a1')).toBeNull();
  });
});

describe('taskDescriptionOf：从任务说明里抠出那句人话标题', () => {
  it('★ 抠出「任务说明：」后面那段（多行压成一个空格）', () => {
    const body = instructionBody(
      '【STEP-2 确定主题】\n挑选 3 个值得深挖的\n方向',
    );

    expect(taskDescriptionOf(body)).toBe(
      '【STEP-2 确定主题】 挑选 3 个值得深挖的 方向',
    );
  });

  it('★ 到「任务参数：」就停 —— JSON 一个字都不能混进节点标题', () => {
    const body = instructionBody('查 A 公司财报', { company: 'A', year: 2025 });

    expect(taskDescriptionOf(body)).toBe('查 A 公司财报');
  });

  it('没有「任务说明：」这一段（description 为空）-> 空串，交给上层退回角色词', () => {
    const body = [
      '你当前处于任务执行模式。',
      '',
      '任务 ID：t1',
      '',
      '输出要求：随便。',
    ].join('\n');

    expect(taskDescriptionOf(body)).toBe('');
  });

  it('普通对话文本不会被误抠（里面没有那个标记）', () => {
    expect(taskDescriptionOf('你好，帮我看看这家公司')).toBe('');
  });

  it('★ 与实时侧的 description 逐字相等（这就是"刷新前后一致"的判据）', () => {
    const description =
      '【STEP-2 确定主题】\n挑选 3 个值得深挖的\n方向，并给出理由';

    // 实时侧：节点标题取自计划事件里的
    // tasks[].history[0].parts[].data.description（planTasks.taskTitle）。
    const liveTitle = taskTitle({
      id: 't1',
      history: [{ role: 'ROLE_USER', parts: [{ data: { description } }] }],
    });

    // 历史侧：刷新之后只能从 task_instruction 正文里抠。
    const historyTitle = taskDescriptionOf(instructionBody(description));

    expect(historyTitle).toBe(liveTitle);
    expect(liveTitle).toBe(
      '【STEP-2 确定主题】 挑选 3 个值得深挖的 方向，并给出理由',
    );
  });
});

describe('taskMessageOf：认不认得出这是任务消息（不管有没有 task_id）', () => {
  it('★ 有 kind 但 task_id 丢了：边界判据不认，任务消息判据仍然认', () => {
    const message = {
      metadata: {
        kind: 'task_result',
        task: { kind: 'task_result', taskId: '' },
      },
    };

    expect(taskBoundaryOf(message)).toBeNull();
    expect(taskMessageOf(message)).toMatchObject({ kind: 'task_result' });
  });

  it('普通消息两种都不是', () => {
    expect(taskMessageOf(plain('a1'))).toBeNull();
    expect(taskMessageOf({ metadata: { task: { kind: 'chat' } } })).toBeNull();
  });
});

describe('taskShortTitle：节点标题只取一句，不显示全文', () => {
  /** 用户截图里那条真数据（后端 `message.description` 的原样）。 */
  const REAL =
    '目标：基于 STEP-1 的目的与语气，确定该客户邮件的邮件主题（Subject）。 输入：STEP-1 的结论。输出：一个主标题 + 两个备选。';

  it('⭐ 去掉"目标："前缀，只取第一句', () => {
    expect(taskShortTitle(REAL)).toBe(
      '基于 STEP-1 的目的与语气，确定该客户邮件的邮件主题（Subject）',
    );
  });

  it('★ 一个句号都不写、直接接"输入："时也要断得开', () => {
    expect(
      taskShortTitle(
        '目标：撰写会议通知邮件正文 输入：STEP-1 与 STEP-2 的结论 输出：完整正文',
      ),
    ).toBe('撰写会议通知邮件正文');
  });

  it('第一句本身就太长 -> 回退到 40 字内最后一个逗号', () => {
    const long =
      '这是一段没有任何句末标点的超长任务说明，它一口气写了非常多的内容，中间只有逗号，一路写到这里还没完，而且还要接着往下写很久很久';
    const head = taskShortTitle(long);
    const body = head.slice(0, -1);

    expect(head.endsWith('…')).toBe(true);
    expect(head.length).toBeLessThanOrEqual(41);

    // 只做截断、不改写：可见部分一定是原文的前缀
    expect(long.startsWith(body)).toBe(true);
    // 停在一个词的边界上：原文紧接着的那个字是逗号（不是半个词）
    expect(long[body.length]).toBe('，');
  });

  it('本来就短 -> 原样返回（不补省略号）', () => {
    expect(taskShortTitle('确定邮件主题')).toBe('确定邮件主题');
  });

  it('空串 / 只有前缀 -> 空串（渲染层据此只写"任务 N"）', () => {
    expect(taskShortTitle('')).toBe('');
    expect(taskShortTitle('目标：')).toBe('');
  });
});

describe('taskRowLabel：节点旁边那句话', () => {
  const row = (patch: Partial<Parameters<typeof taskRowLabel>[0]>) => ({
    taskId: 't1',
    planId: 'p1',
    skillKey: '',
    title: '',
    ordinal: 1,
    role: 'step' as const,
    first: true,
    last: true,
    ...patch,
  });

  it('有标题就用标题（实时通道的样子）', () => {
    expect(taskRowLabel(row({ title: '获取并整理 A 公司财报' }))).toBe(
      '获取并整理 A 公司财报',
    );
  });

  it('没标题时退回角色词（历史通道的样子）', () => {
    expect(taskRowLabel(row({ role: 'instruction' }))).toBe('任务指令');
    expect(taskRowLabel(row({ role: 'result' }))).toBe('任务结果');
  });

  it('执行中的一步既没标题也不是边界 —— 什么都不说', () => {
    expect(taskRowLabel(row({ role: 'step' }))).toBe('');
  });
});

/**
 * 同一个任务被切成多段 —— 「一个任务 = 一个节点」还成立吗。
 *
 * 2026-10-22 用户报「task_1 描述的 timeline 跑到 task_2 正文上方」，刷新后又
 * 对齐了。原因是实时通道的 `liveTask` 只有一个，而 `task.updated` 的
 * `current_task_id` 是**每一次认领**打的：并行子代理来回认领时它就在几个任务
 * 之间跳，同一个任务的消息被别的任务隔开，于是被切成两段，而每段都画了一个
 * 节点 —— 第二个节点就落在那个任务自己的**末尾**。
 */
describe('taskRowsOf：同一个任务被别的任务隔开', () => {
  const mark = (id: string, taskId: string) =>
    noteLiveTask(id, { taskId, title: `${taskId} 的说明`, planId: 'p1' });

  /** 并行认领的典型顺序：t1 → t2 → t1 → t2。 */
  const interleaved = () => {
    mark('a1', 't1');
    mark('a2', 't2');
    mark('a3', 't1');
    mark('a4', 't2');
    return taskRowsOf([
      plain('u0', 'user'),
      plain('a1'),
      plain('a2'),
      plain('a3'),
      plain('a4'),
    ]);
  };

  it('⭐ 一个任务只有一个节点：圆点只在**第一次**出现的那一行', () => {
    const rows = interleaved();

    expect(rows.get('a1')).toMatchObject({ first: true });
    expect(rows.get('a2')).toMatchObject({ first: true });
    // 第二次出现的段：只接着画轨道，不再画圆点/标题。
    expect(rows.get('a3')).toMatchObject({ taskId: 't1', first: false });
    expect(rows.get('a4')).toMatchObject({ taskId: 't2', first: false });
  });

  it('⭐ 序号不翻倍：同一个任务共用第一次出现时的序号', () => {
    const rows = interleaved();

    // 修复前这里是 1 / 2 / 3 / 4 —— 后面两个任务被顶号，越跑越乱。
    expect(rows.get('a1')?.ordinal).toBe(1);
    expect(rows.get('a3')?.ordinal).toBe(1);
    expect(rows.get('a2')?.ordinal).toBe(2);
    expect(rows.get('a4')?.ordinal).toBe(2);
  });

  it('★ 中间那一段的末尾**继续往下穿**，只有最后一段才收尾', () => {
    const rows = interleaved();

    expect(rows.get('a1')).toMatchObject({ last: false });
    expect(rows.get('a2')).toMatchObject({ last: false });
    expect(rows.get('a3')).toMatchObject({ last: true });
    expect(rows.get('a4')).toMatchObject({ last: true });
  });
});

/**
 * 序号是「**这份计划里的**第几个任务」，不是"我在对话里看到的第几个"。
 *
 * 2026-10-22 用户贴了实时 DOM：`data-task-id="…:t2"` 的节点标题写着
 * 「任务 1 · 基于 t1 确定的目的与语气…」—— id 是 t2、正文也在说 t1，
 * 只有那个数字是 1。根因是规划器把"已经做完的那一步"也拆成了一个任务
 * （t1 一句话都没产出），`group` 把它整组丢掉之后，按"出现顺序"编号的
 * t2 就顶上了 1。
 */
describe('taskRowsOf：序号按计划内位置（`<planId>:tN` 的 N）', () => {
  it('⭐ 前一个任务一句话都没产出时，后面的**不能顶号**', () => {
    const rows = taskRowsOf([
      // t1 只有一条 instruction —— group 会整组丢掉（见 group 的注释）。
      task('i1', 'task_instruction', 'plan-1:t1'),
      task('i2', 'task_instruction', 'plan-1:t2'),
      plain('a2'),
      task('r2', 'task_result', 'plan-1:t2'),
      task('i3', 'task_instruction', 'plan-1:t3'),
      plain('a3'),
      task('r3', 'task_result', 'plan-1:t3'),
    ]);

    // 空节点仍然不画（这是上一轮的结论，不变）。
    expect(rows.get('i1')).toBeUndefined();

    // 但序号必须跟着 id 走：t2 是「任务 2」。
    expect(rows.get('i2')).toMatchObject({ ordinal: 2, first: true });
    expect(rows.get('i3')).toMatchObject({ ordinal: 3, first: true });
  });

  it('读不出计划内位置时整份计划退回出现顺序（不混着算）', () => {
    const rows = taskRowsOf([
      task('i1', 'task_instruction', 'plan-1:research'),
      plain('a1'),
      task('r1', 'task_result', 'plan-1:research'),
      task('i2', 'task_instruction', 'plan-1:t5'),
      plain('a2'),
      task('r2', 'task_result', 'plan-1:t5'),
    ]);

    // 一个读不出 -> 整份退回出现顺序，避免出现"任务 5 和任务 1"这种跳跃。
    expect(rows.get('i1')?.ordinal).toBe(1);
    expect(rows.get('i2')?.ordinal).toBe(2);
  });

  it('plan_id 缺失时两轮计划并成一桶，撞号 -> 整份退回出现顺序', () => {
    // 两个计划的 t1 因为 plan_id 读不到而落进同一个桶，都解析成 1。
    // 照用会画成两个「任务 1」，所以整份退回出现顺序。
    const rows = taskRowsOf([
      task('i1', 'task_instruction', 'plan-a:t1', { planId: '' }),
      plain('a1'),
      task('r1', 'task_result', 'plan-a:t1', { planId: '' }),
      task('i2', 'task_instruction', 'plan-b:t1', { planId: '' }),
      plain('a2'),
      task('r2', 'task_result', 'plan-b:t1', { planId: '' }),
    ]);

    expect(rows.get('i1')?.ordinal).toBe(1);
    expect(rows.get('i2')?.ordinal).toBe(2);
  });

  it('不同计划各算各的：各自的 t1 都是「任务 1」', () => {
    const rows = taskRowsOf([
      task('i1', 'task_instruction', 'plan-a:t1', { planId: 'plan-a' }),
      plain('a1'),
      task('r1', 'task_result', 'plan-a:t1', { planId: 'plan-a' }),
      task('i2', 'task_instruction', 'plan-b:t1', { planId: 'plan-b' }),
      plain('a2'),
      task('r2', 'task_result', 'plan-b:t1', { planId: 'plan-b' }),
    ]);

    expect(rows.get('i1')?.ordinal).toBe(1);
    expect(rows.get('i2')?.ordinal).toBe(1);
  });

  it('planIndexOf：只认尾巴上的 `tN`，中间出现不算', () => {
    expect(planIndexOf('767e8cb1-7a27-47a9-ac5a-e1c2dc94e108:t2')).toBe(2);
    expect(planIndexOf('t1')).toBe(1);
    expect(planIndexOf('p1:t0')).toBe(0);
    expect(planIndexOf('p1:research')).toBe(0);
    // `t2` 后面还有别的 -> 不是尾巴，不认。
    expect(planIndexOf('p1:t2:message:1')).toBe(0);
    expect(planIndexOf('')).toBe(0);
  });
});
