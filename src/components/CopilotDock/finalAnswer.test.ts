// src/components/CopilotDock/finalAnswer.test.ts
//
// 「最后一条 AIMessage」这条判定。
//
// 为什么要单独钉：它决定**反馈图标行挂在哪条消息下面**，而错了不会报错 ——
// 只会挂错一条（或者一条都不挂）。库自己的判据是"数组里最后一个元素"，
// 两种偏差都已出现在眼前：
//   · 一次运行产出多条助手消息（多节点图）→ 每条都像有反馈按钮；
//   · 数组以 tool / user 消息结尾 → 反馈行整体消失。
import type { Message } from '@ag-ui/client';
import { describe, expect, it } from 'vitest';

import {
  isLastAssistantMessage,
  isOrphanAnchor,
  lastAssistantIndex,
  orphanAnchorIndex,
  replyRangeOf,
} from './finalAnswer';

/** 只填判定真正读的字段（role / 下标），其余用断言补掉。 */
const msg = (role: Message['role'], id: string) =>
  ({ id, role, content: '' }) as unknown as Message;

const user = (id: string) => msg('user', id);
const assistant = (id: string) => msg('assistant', id);
const tool = (id: string) => msg('tool', id);

/**
 * 历史里的**工具活动记录**：契约里 role 也是 assistant（只有两个角色），
 * 靠 `kind: 'tool_activity'` 区分。它显示成"工具调用 / 工具结果"块，不是回答。
 */
const toolActivity = (id: string) =>
  ({
    id,
    role: 'assistant',
    content: '',
    metadata: { kind: 'tool_activity' },
  }) as unknown as Message;

describe('lastAssistantIndex', () => {
  it('空数组 -> -1（没有可挂的对象）', () => {
    expect(lastAssistantIndex([])).toBe(-1);
  });

  it('只有用户消息 -> -1', () => {
    expect(lastAssistantIndex([user('u1')])).toBe(-1);
  });

  it('[user, assistant] -> 1', () => {
    expect(lastAssistantIndex([user('u1'), assistant('a1')])).toBe(1);
  });

  it('⭐ [user, assistant, assistant] -> 2 —— 一次运行里的多条助手消息只认最后一条', () => {
    expect(
      lastAssistantIndex([user('u1'), assistant('a1'), assistant('a2')]),
    ).toBe(2);
  });

  it('⭐ [user, assistant, tool] -> 1 —— 数组以工具结果结尾时，助手消息仍然是第 1 条', () => {
    // 后端现在还不发 tool.* 事件（runEventStream.ts），但事件一出就是这个形状。
    // 库的"数组最后一个元素"在这里会落到 tool 上 → 反馈行整体消失。
    expect(lastAssistantIndex([user('u1'), assistant('a1'), tool('t1')])).toBe(
      1,
    );
  });

  it('⭐ [user, assistant, user] -> 1 —— 以用户消息结尾时不会算成"没有"', () => {
    expect(lastAssistantIndex([user('u1'), assistant('a1'), user('u2')])).toBe(
      1,
    );
  });

  it('多轮对话取最后一轮的那条', () => {
    expect(
      lastAssistantIndex([
        user('u1'),
        assistant('a1'),
        user('u2'),
        assistant('a2'),
        user('u3'),
        assistant('a3'),
      ]),
    ).toBe(5);
  });

  it('⭐ 工具活动记录不算"最后一条 AIMessage"（它 role 也是 assistant）', () => {
    // 一轮运行若停在工具调用上（含 interrupted 等审批），数组里最后那条
    // assistant 其实是 tool_activity。不排掉它，反馈按钮就会挂到工具记录上。
    expect(
      lastAssistantIndex([user('u1'), assistant('a1'), toolActivity('ta1')]),
    ).toBe(1);
  });

  it('⭐ 只有工具活动、没有正文回答 -> -1（不该往工具记录上挂反馈按钮）', () => {
    expect(lastAssistantIndex([user('u1'), toolActivity('ta1')])).toBe(-1);
  });

  it('实时的助手消息没有 kind 标记 -> 照旧算正文（不能把实时那轮判成"没有"）', () => {
    const streaming = {
      id: 's1',
      role: 'assistant',
      content: '正在说',
      metadata: {},
    } as unknown as Message;
    expect(lastAssistantIndex([user('u1'), streaming])).toBe(1);
  });
});

describe('isLastAssistantMessage', () => {
  const messages = [user('u1'), assistant('a1'), assistant('a2')];

  it('只有最后一条助手消息为真', () => {
    expect(isLastAssistantMessage(messages, 0)).toBe(false); // user
    expect(isLastAssistantMessage(messages, 1)).toBe(false); // 过程
    expect(isLastAssistantMessage(messages, 2)).toBe(true); // 答案
  });

  it('下标越界 / 负数 -> false，不抛', () => {
    expect(isLastAssistantMessage(messages, 3)).toBe(false);
    expect(isLastAssistantMessage(messages, 99)).toBe(false);
    expect(isLastAssistantMessage(messages, -1)).toBe(false);
  });

  it('没有助手消息时，任何下标都不是"最后一条 AIMessage"', () => {
    const onlyUser = [user('u1'), user('u2')];
    expect(isLastAssistantMessage(onlyUser, 0)).toBe(false);
    expect(isLastAssistantMessage(onlyUser, 1)).toBe(false);
  });

  it('空数组不抛', () => {
    expect(isLastAssistantMessage([], 0)).toBe(false);
  });

  it('工具活动记录不是"最后一条 AIMessage"—— 反馈按钮落到它前面那条正文上', () => {
    const withTa = [user('u1'), assistant('a1'), toolActivity('ta1')];
    expect(isLastAssistantMessage(withTa, 2)).toBe(false); // 工具记录
    expect(isLastAssistantMessage(withTa, 1)).toBe(true); // 真正的回答
  });
});

/**
 * 「一轮回复」的范围 —— "这一轮还有没有推理在流"的边界就在这儿。
 *
 * 需求原话（2026-10-20）：「多个思考过程也不要合并了」—— 所以这里**不再有**
 * "思考过程该挂在哪条消息上"（anchor）那回事：每条消息画自己那段。
 * 剩下的唯一用途是给最后一条正文判断"整轮还在不在流"（决定要不要关掉库
 * 自己的 loading 光标）。
 *
 * 一轮 = 上一条 user 之后到下一条 user 之前。边界判错的表现是"最后那条
 * 提前关掉 loading"或者"明明在流却亮着两个 loading"，都不会报错。
 */
describe('replyRangeOf：一轮回复的范围', () => {
  it('单轮单条：范围就是那一条', () => {
    const messages = [user('u1'), assistant('a1')];
    expect(replyRangeOf(messages, 1)).toEqual({ start: 1, end: 1 });
    // 从 user 那条问，答案也一样（它属于"这一轮"的起点之前）
    expect(replyRangeOf(messages, 0)).toEqual({ start: 1, end: 1 });
  });

  it('⭐ 长链路（3 条助手消息）：三条都算同一轮', () => {
    const messages = [
      user('u1'),
      assistant('a1'),
      assistant('a2'),
      assistant('a3'),
    ];

    // 三条各自查出来必须是同一个范围 —— 否则最后那条会看不到前一步的推理
    for (const index of [1, 2, 3]) {
      expect(replyRangeOf(messages, index)).toEqual({ start: 1, end: 3 });
    }
  });

  it('⭐ 多轮：范围被 user 切成段，不串到隔壁回答上', () => {
    const messages = [
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      assistant('a3'),
    ];

    expect(replyRangeOf(messages, 1)).toEqual({ start: 1, end: 1 });
    expect(replyRangeOf(messages, 3)).toEqual({ start: 3, end: 4 });
    expect(replyRangeOf(messages, 4)).toEqual({ start: 3, end: 4 });
  });

  it('工具活动也算本轮（它自己就是一步，推理就挂在它上面）', () => {
    const messages = [user('u1'), toolActivity('ta1'), assistant('a1')];
    expect(replyRangeOf(messages, 1)).toEqual({ start: 1, end: 2 });
  });

  it('一条正文回答都没有（只有工具记录）-> 范围仍然覆盖它', () => {
    const messages = [user('u1'), toolActivity('ta1')];
    expect(replyRangeOf(messages, 1)).toEqual({ start: 1, end: 1 });
  });

  it('以助手消息开头（没有 user，比如历史被截断）-> 从 0 开始', () => {
    const messages = [assistant('a1'), assistant('a2')];
    expect(replyRangeOf(messages, 1)).toEqual({ start: 0, end: 1 });
  });

  it('刚发出的用户消息（还没有回答）-> 空范围', () => {
    const messages = [user('u1'), assistant('a1'), user('u2')];
    expect(replyRangeOf(messages, 2)).toEqual({ start: 3, end: 2 });
  });

  it('下标越界 / 负数 -> 空范围，不抛', () => {
    const messages = [user('u1'), assistant('a1')];
    const empty = { start: -1, end: -1 };

    expect(replyRangeOf(messages, -1)).toEqual(empty);
    expect(replyRangeOf(messages, 2)).toEqual(empty);
    expect(replyRangeOf([], 0)).toEqual(empty);
  });
});

// ============================================================
// 「兜底的工具行挂在哪条消息上」（2026-10-22）
// ============================================================
//
// 这类工具行（`messageId` 空 / 指不到任何消息）没有自己的位置，必须挑一条
// 消息来挂。**挑错了会动**：一开始挂"最后一条"，随着消息一条条进来它一路
// 往后漂，用户看到的就是"本来在最上面的工具调用跑到下面去了"。
// 所以判据钉在这里：本轮**第一条**。
describe('orphanAnchorIndex：兜底工具行锚在本轮第一条', () => {
  it('⭐ 跳过上一条 user，取本轮的第一条回复', () => {
    const messages = [
      user('u0'),
      assistant('a0'),
      user('u1'),
      assistant('a1'),
      assistant('a2'),
    ];

    expect(orphanAnchorIndex(messages)).toBe(3);
  });

  it('★ 后面再来多少条消息，锚点都**不动**（这正是原来那个 bug 的判据）', () => {
    const base = [user('u1'), assistant('a1')];
    const grown = [...base, assistant('a2'), assistant('a3')];

    expect(orphanAnchorIndex(base)).toBe(1);
    expect(orphanAnchorIndex(grown)).toBe(1);
  });

  it('一条助手消息都没有（还没回来）-> -1，无处可挂', () => {
    expect(orphanAnchorIndex([user('u1')])).toBe(-1);
    expect(orphanAnchorIndex([])).toBe(-1);
  });

  it('以助手消息开头（历史被截断，没有 user）-> 第一条', () => {
    expect(orphanAnchorIndex([assistant('a1'), assistant('a2')])).toBe(0);
  });

  it('同一个数组只算一次（每渲染一条消息都会问一次）', () => {
    const messages = [user('u1'), assistant('a1')];
    expect(orphanAnchorIndex(messages)).toBe(orphanAnchorIndex(messages));
  });

  it('isOrphanAnchor 只对那一条为真', () => {
    const messages = [user('u1'), assistant('a1'), assistant('a2')];

    expect(isOrphanAnchor(messages, 1)).toBe(true);
    expect(isOrphanAnchor(messages, 0)).toBe(false);
    expect(isOrphanAnchor(messages, 2)).toBe(false);
  });
});
