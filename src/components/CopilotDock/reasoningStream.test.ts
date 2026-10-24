// src/components/CopilotDock/reasoningStream.test.ts
//
// 推理 store 的几条契约。
//
// ⚠️ 这个文件碰的是**模块级单例**（`entries`），用例之间会互相看见。
//    所以每个用例开头都 `resetReasoning()` —— 不重置的话"上一条消息留了
//    什么"会变成一种隐式依赖，红的永远是第二个跑的那个用例。
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyReasoning,
  type ReasoningEntry,
  reasoningEntryOf,
  reasoningOfMessage,
  resetReasoning,
} from './reasoningStream';

const entryOf = (id: string): ReasoningEntry | null => reasoningEntryOf(id);

beforeEach(() => {
  resetReasoning();
});

describe('applyReasoning：delta 是旁路，content 是全文对账点', () => {
  it('逐条 delta 追加', () => {
    applyReasoning({ messageId: 'm1', delta: '我' });
    applyReasoning({ messageId: 'm1', delta: '想想' });

    expect(entryOf('m1')).toEqual({ text: '我想想', streaming: true });
  });

  it('⭐ content 到了就以它为准（覆盖 delta 拼出来的那一份）', () => {
    applyReasoning({ messageId: 'm1', delta: '残缺' });
    applyReasoning({ messageId: 'm1', content: '完整全文', done: true });

    expect(entryOf('m1')).toEqual({ text: '完整全文', streaming: false });
  });

  it('不同的消息各存一份（按 messageId 隔离）', () => {
    applyReasoning({ messageId: 'm1', delta: '第一条' });
    applyReasoning({ messageId: 'm2', delta: '第二条' });

    expect(entryOf('m1')?.text).toBe('第一条');
    expect(entryOf('m2')?.text).toBe('第二条');
  });

  it('空 delta 什么都不做（后端自己也不发空壳）', () => {
    applyReasoning({ messageId: 'm1', delta: '' });
    expect(entryOf('m1')).toBeNull();
  });

  it('缺 messageId / 空 id 直接忽略（那帧挂不到任何消息上）', () => {
    applyReasoning({ messageId: '' });
    applyReasoning({} as { messageId: string });
    expect(entryOf('')).toBeNull();
  });
});

describe('done：收尾的兜底信号', () => {
  it('⭐ 后端对"没有思维链"是不发 completed 的，所以 message.completed 补一条 done', () => {
    applyReasoning({ messageId: 'm1', delta: '想' });
    expect(entryOf('m1')?.streaming).toBe(true);

    applyReasoning({ messageId: 'm1', done: true });
    expect(entryOf('m1')).toEqual({ text: '想', streaming: false });
  });

  it('⭐ 没有 entry 时 done 不留下空 entry（否则界面会渲染出一个空折叠块）', () => {
    applyReasoning({ messageId: 'm1', done: true });
    expect(entryOf('m1')).toBeNull();
  });

  it('重复 done 是幂等的（后端断线重连会重放帧）', () => {
    applyReasoning({ messageId: 'm1', delta: '想' });
    applyReasoning({ messageId: 'm1', done: true });
    applyReasoning({ messageId: 'm1', done: true });

    expect(entryOf('m1')).toEqual({ text: '想', streaming: false });
  });
});

describe('快照必须是缓存里的那个对象', () => {
  it('⭐ 同一个 id 连查两次拿到**同一个引用** —— 否则 useSyncExternalStore 会死循环', () => {
    applyReasoning({ messageId: 'm1', delta: '想' });
    expect(reasoningEntryOf('m1')).toBe(reasoningEntryOf('m1'));
  });

  it('改了之后引用才换（这样组件才会重渲染）', () => {
    applyReasoning({ messageId: 'm1', delta: '想' });
    const before = reasoningEntryOf('m1');
    applyReasoning({ messageId: 'm1', delta: '，再想' });

    expect(reasoningEntryOf('m1')).not.toBe(before);
  });

  it('id 为 undefined / null 时返回 null（用户消息没有推理）', () => {
    expect(reasoningEntryOf(undefined)).toBeNull();
    expect(reasoningEntryOf(null)).toBeNull();
  });
});

describe('resetReasoning', () => {
  it('清掉全部（换 agent / 新一轮）', () => {
    applyReasoning({ messageId: 'm1', delta: '想' });
    resetReasoning();
    expect(entryOf('m1')).toBeNull();
  });
});

/**
 * 一条消息的推理从哪来 —— metadata 优先于实时 store。
 *
 * ⚠️ 合并那套（`mergeReplyReasoning`）已经删了：2026-10-20 需求是"多个思考
 *    过程不要合并、按事件顺序显示"，每条消息只读自己那一段。这条读取口径
 *    仍然要钉住 —— 判错的表现很隐蔽：刷新历史之后，同一条消息显示的可能是
 *    上一轮的残留推理。
 */
describe('reasoningOfMessage：metadata 优先', () => {
  const withMeta = (id: string, reasoning?: unknown) => ({
    id,
    metadata: { kind: 'chat', reasoning },
  });

  it('history.ts 塞进 metadata 的推理优先（历史那条的权威数据）', () => {
    // store 里还留着上一轮的残留 —— 必须被 metadata 压掉
    applyReasoning({ messageId: 'm1', delta: '实时残留' });

    expect(reasoningOfMessage(withMeta('m1', '历史里的推理'))).toEqual({
      text: '历史里的推理',
      streaming: false,
    });
  });

  it('metadata 里没有（或空白）时退回实时 store', () => {
    applyReasoning({ messageId: 'm2', delta: '实时推理' });

    expect(reasoningOfMessage(withMeta('m2'))?.text).toBe('实时推理');
    expect(reasoningOfMessage(withMeta('m2', '   '))?.text).toBe('实时推理');
  });

  it('两边都没有 -> null（不造一个空 entry 出来）', () => {
    expect(reasoningOfMessage({ id: 'm3' })).toBeNull();
    expect(reasoningOfMessage({})).toBeNull();
  });

  it('历史里的推理一定是收尾态（它来自一条已经落库的消息）', () => {
    expect(reasoningOfMessage(withMeta('m4', '想完了'))?.streaming).toBe(false);
  });
});
