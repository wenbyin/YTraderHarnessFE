// src/components/CopilotDock/data.test.ts
//
// 纯函数 + 存储读写。面板是「常驻 + 收起不卸载」，会话状态全靠这一层，
// 所以这里把边界（坏数据、删到最后一条、旧 key 清理）都钉死。
//
// 折叠状态**不在这一层**（由 app.tsx 的 initialState 持有，因为它要跟左侧菜单互斥），
// 所以这里不再有 readCollapsed / withCollapsed 那套断言。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  conversationGroupKey,
  conversationUpdatedAt,
  DEFAULT_TITLE,
  type DockState,
  ensureConversations,
  formatConversationTime,
  groupConversations,
  hasStartedConversation,
  PANEL_WIDTH_DIVISOR,
  PANEL_WIDTH_DIVISOR_WIDE,
  panelWidth,
  parseConversations,
  pickActiveId,
  pruneEmptyConversations,
  REMOTE_TITLE,
  readDockState,
  reconcileWithSessions,
  sortByCreatedDesc,
  TITLE_MAX,
  titleFromMessage,
  withFirstMessage,
  withNewConversation,
  withPinned,
  withRemovedConversation,
  withSessionId,
  writeDockState,
} from './data';

const KEY_COLLAPSED = 'ytrader.copilot.collapsed';
const KEY_LIST = 'ytrader.copilot.conversations';
const KEY_ACTIVE = 'ytrader.copilot.active';
const KEY_OPEN_LEGACY = 'ytrader.copilot.open';

const conv = (id: string, createdAt: number, title = DEFAULT_TITLE) => ({
  id,
  title,
  createdAt,
});

const makeState = (over: Partial<DockState> = {}): DockState => ({
  conversations: [conv('a', 100)],
  activeId: 'a',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe('panelWidth', () => {
  it('展开 = 可视宽度的 1/3', () => {
    expect(PANEL_WIDTH_DIVISOR).toBe(3);
    expect(panelWidth(false, 1200)).toBe(400);
    expect(panelWidth(false, 1920)).toBe(640);
  });

  it('除不尽时四舍五入到整像素', () => {
    expect(panelWidth(false, 1000)).toBe(333);
    expect(panelWidth(false, 1001)).toBe(334);
  });

  it('收起 = 0：右侧一点占位都不留', () => {
    expect(panelWidth(true, 1200)).toBe(0);
    expect(panelWidth(true, 0)).toBe(0);
  });

  it('可视宽度为 0（未布局 / 首屏）时不返回 NaN 或负值', () => {
    expect(panelWidth(false, 0)).toBe(0);
  });

  it('放大 = 可视宽度的 1/2（2026-10-22 需求：允许扩到半屏）', () => {
    expect(PANEL_WIDTH_DIVISOR_WIDE).toBe(2);
    expect(panelWidth(false, 1200, true)).toBe(600);
    expect(panelWidth(false, 1920, true)).toBe(960);
  });

  it('放大态下收起仍然是 0 —— 两个开关互不干扰', () => {
    expect(panelWidth(true, 1200, true)).toBe(0);
  });

  it('不传 wide 时与从前逐像素相同（老调用点不用改）', () => {
    expect(panelWidth(false, 1200)).toBe(panelWidth(false, 1200, false));
  });
});

describe('titleFromMessage', () => {
  it('折叠连续空白', () => {
    expect(titleFromMessage('  你好   世界 \n')).toBe('你好 世界');
  });

  it(`超过 ${TITLE_MAX} 字截断并加省略号`, () => {
    const long = '一'.repeat(TITLE_MAX + 5);
    const title = titleFromMessage(long);
    expect(title).toHaveLength(TITLE_MAX + 1);
    expect(title.endsWith('…')).toBe(true);
  });

  it('刚好等于上限时不截断', () => {
    const exact = '一'.repeat(TITLE_MAX);
    expect(titleFromMessage(exact)).toBe(exact);
  });

  it('纯空白返回空串（调用方据此不改标题）', () => {
    expect(titleFromMessage('   \n\t ')).toBe('');
    expect(titleFromMessage('')).toBe('');
  });
});

describe('parseConversations', () => {
  it('空 / 坏 JSON / 非数组一律回空', () => {
    expect(parseConversations(null)).toEqual([]);
    expect(parseConversations('')).toEqual([]);
    expect(parseConversations('{oops')).toEqual([]);
    expect(parseConversations('{"id":"a"}')).toEqual([]);
  });

  it('丢掉没有 id 的记录，其余补默认值', () => {
    const raw = JSON.stringify([
      { id: 'a', title: '甲', createdAt: 1 },
      { title: '没有 id' },
      null,
      'string',
      { id: 'b' },
      { id: '', title: '空 id' },
    ]);
    expect(parseConversations(raw)).toEqual([
      { id: 'a', title: '甲', createdAt: 1 },
      { id: 'b', title: DEFAULT_TITLE, createdAt: 0 },
    ]);
  });
});

describe('ensureConversations', () => {
  it('空列表补一条，非空原样返回（不复制）', () => {
    const created = ensureConversations([], 42);
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe(DEFAULT_TITLE);
    expect(created[0].createdAt).toBe(42);

    const list = [conv('a', 1)];
    expect(ensureConversations(list, 42)).toBe(list);
  });
});

describe('sortByCreatedDesc', () => {
  it('按创建时间倒序，且不改动入参', () => {
    const list = [conv('a', 1), conv('c', 3), conv('b', 2)];
    expect(sortByCreatedDesc(list).map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(list.map((c) => c.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('pickActiveId', () => {
  const list = [conv('a', 2), conv('b', 1)];

  it('存的 id 还在就用它', () => {
    expect(pickActiveId(list, 'b')).toBe('b');
  });

  it('存的 id 失效 / 为空则回落到第一条', () => {
    expect(pickActiveId(list, 'gone')).toBe('a');
    expect(pickActiveId(list, null)).toBe('a');
  });

  it('列表为空返回空串', () => {
    expect(pickActiveId([], 'a')).toBe('');
  });
});

describe('hasStartedConversation（这条会话「用没用过」）', () => {
  it('全新会话：没用过', () => {
    expect(hasStartedConversation(conv('a', 1))).toBe(false);
  });

  it('used 标记为真 = 用过（与后端成不成功无关，提交那刻就写）', () => {
    expect(hasStartedConversation({ ...conv('a', 1), used: true })).toBe(true);
  });

  it('有后端 sessionId = 用过（老数据没有 used 字段，靠它兜底）', () => {
    expect(hasStartedConversation({ ...conv('a', 1), sessionId: 's-1' })).toBe(
      true,
    );
  });

  it('标题已不是默认值 = 用过（更老的数据只存过标题）', () => {
    expect(hasStartedConversation(conv('a', 1, '你有什么能力'))).toBe(true);
  });

  it('标题恰好就是「新对话」时不会误判 —— 这里靠 used/sessionId，不靠标题', () => {
    // 用户第一条消息就是「新对话」，标题看起来没变，但它确实是用过的会话
    expect(hasStartedConversation(conv('a', 1, DEFAULT_TITLE))).toBe(false);
    expect(
      hasStartedConversation({
        ...conv('a', 1, DEFAULT_TITLE),
        used: true,
      }),
    ).toBe(true);
  });
});

describe('withNewConversation', () => {
  /** 一条「用过的」会话 —— 有它才不会走复用分支。 */
  const used = (id: string, createdAt: number) => ({
    ...conv(id, createdAt, '聊过的'),
    used: true,
  });

  it('手上没有空会话时：新建一条，插到最前并切过去', () => {
    const state = makeState({
      conversations: [used('a', 100)],
      activeId: 'a',
    });
    const next = withNewConversation(state, 500);

    expect(next.conversations).toHaveLength(2);
    expect(next.activeId).not.toBe('a');
    expect(next.conversations[0].id).toBe(next.activeId);
    expect(next.conversations[1].id).toBe('a');
  });

  it('⭐ 已有空会话时：切过去，**不新建**（回归：曾经堆出一排「新对话」）', () => {
    const next = withNewConversation(makeState(), 500);

    expect(next.conversations).toHaveLength(1);
    expect(next.activeId).toBe('a');
  });

  it('⭐ 重复点 + 不堆会话：连点 5 次仍然只有一条', () => {
    let state = makeState();
    for (let i = 0; i < 5; i += 1) {
      state = withNewConversation(state, 500 + i);
    }

    expect(state.conversations).toHaveLength(1);
    expect(state.activeId).toBe('a');
  });

  it('已经就在那个空会话里时，原样返回**同一个对象**（不做无意义重渲染）', () => {
    const state = makeState();
    expect(withNewConversation(state, 500)).toBe(state);
  });

  it('复用最新那条空会话（列表倒序，第一条即最新）', () => {
    const state = makeState({
      conversations: [conv('newer', 300), used('old', 100)],
      activeId: 'old',
    });
    const next = withNewConversation(state, 400);

    expect(next.conversations).toHaveLength(2);
    expect(next.activeId).toBe('newer');
  });

  it('空会话不在最前也照样复用（不依赖列表顺序）', () => {
    const state = makeState({
      conversations: [used('a', 300), conv('blank', 200), used('b', 100)],
      activeId: 'a',
    });
    const next = withNewConversation(state, 400);

    expect(next.conversations).toHaveLength(3);
    expect(next.activeId).toBe('blank');
  });
});

describe('pruneEmptyConversations', () => {
  it('空会话只留最新一条，其余整条丢掉', () => {
    const list = [conv('e3', 500), conv('e2', 400), conv('e1', 300)];
    expect(pruneEmptyConversations(list).map((c) => c.id)).toEqual(['e3']);
  });

  it('用过的会话一条都不动（哪怕夹在空会话之间）', () => {
    const list = [
      conv('a', 400, '聊过的'),
      conv('e1', 300),
      conv('e2', 200),
      conv('b', 100, '也聊过'),
    ];
    expect(pruneEmptyConversations(list).map((c) => c.id)).toEqual([
      'a',
      'e1',
      'b',
    ]);
  });

  it('没有空会话时原样保留', () => {
    const list = [conv('a', 2, 'x'), conv('b', 1, 'y')];
    expect(pruneEmptyConversations(list).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('全是空会话 -> 只留一条（列表不会变空）', () => {
    const list = [conv('e1', 2), conv('e2', 1)];
    expect(pruneEmptyConversations(list)).toHaveLength(1);
    expect(pruneEmptyConversations(list)[0].id).toBe('e1');
  });

  it('空数组原样', () => {
    expect(pruneEmptyConversations([])).toEqual([]);
  });
});

describe('withRemovedConversation', () => {
  it('删的不是当前会话，当前会话不动', () => {
    const state = makeState({
      conversations: [conv('a', 3), conv('b', 2), conv('c', 1)],
      activeId: 'a',
    });
    const next = withRemovedConversation(state, 'b', 9);
    expect(next.conversations.map((c) => c.id)).toEqual(['a', 'c']);
    expect(next.activeId).toBe('a');
  });

  it('删的是当前会话 -> 接它后面那条', () => {
    const state = makeState({
      conversations: [conv('a', 3), conv('b', 2), conv('c', 1)],
      activeId: 'b',
    });
    expect(withRemovedConversation(state, 'b', 9).activeId).toBe('c');
  });

  it('当前会话是最后一条 -> 接它前面那条', () => {
    const state = makeState({
      conversations: [conv('a', 3), conv('b', 2)],
      activeId: 'b',
    });
    expect(withRemovedConversation(state, 'b', 9).activeId).toBe('a');
  });

  it('删到一条不剩时补一条新的（列表永不为空）', () => {
    const state = makeState({ conversations: [conv('a', 3)], activeId: 'a' });
    const next = withRemovedConversation(state, 'a', 9);

    expect(next.conversations).toHaveLength(1);
    expect(next.conversations[0].id).not.toBe('a');
    expect(next.activeId).toBe(next.conversations[0].id);
  });

  it('id 不存在时原引用返回', () => {
    const state = makeState();
    expect(withRemovedConversation(state, 'nope', 9)).toBe(state);
  });
});

describe('withFirstMessage', () => {
  it('标题是默认值时才改', () => {
    const state = makeState({ activeId: 'a' });
    const next = withFirstMessage(state, '帮我查一下文档');
    expect(next.conversations[0].title).toBe('帮我查一下文档');
  });

  it('标题已定就不再改', () => {
    const state = makeState({
      conversations: [conv('a', 100, '定过的名字')],
      activeId: 'a',
    });
    expect(withFirstMessage(state, '新消息').conversations[0].title).toBe(
      '定过的名字',
    );
  });

  it('空消息 / 非当前会话都不触发写入', () => {
    const state = makeState({ activeId: 'other' });
    expect(withFirstMessage(state, '   ')).toBe(state);
    expect(withFirstMessage(state, '你好')).toBe(state);
  });

  it('⭐ 同时把会话标记为「用过了」（这是它进历史的依据）', () => {
    const next = withFirstMessage(makeState({ activeId: 'a' }), '你好');
    expect(next.conversations[0].used).toBe(true);
    expect(hasStartedConversation(next.conversations[0])).toBe(true);
  });

  it('⭐ 标题已定时也照样补上 used 标记（老数据升级路径）', () => {
    // 老记录有标题、没有 used —— 发第二条消息时应该把标记补上
    const state = makeState({
      conversations: [conv('a', 100, '定过的名字')],
      activeId: 'a',
    });
    const next = withFirstMessage(state, '第二条');

    expect(next.conversations[0].title).toBe('定过的名字');
    expect(next.conversations[0].used).toBe(true);
  });

  it('标题恰好是「新对话」时，used 标记仍然落地（标题判据的洞由它补）', () => {
    const next = withFirstMessage(makeState({ activeId: 'a' }), DEFAULT_TITLE);

    expect(next.conversations[0].title).toBe(DEFAULT_TITLE);
    expect(hasStartedConversation(next.conversations[0])).toBe(true);
  });
});

describe('存储读写', () => {
  it('空存储时给一条默认会话', () => {
    const state = readDockState(1000);
    expect(state.conversations).toHaveLength(1);
    expect(state.activeId).toBe(state.conversations[0].id);
  });

  it('折叠状态不出现在落盘的状态里（它归 app.tsx 管）', () => {
    const state = readDockState(1000);
    expect(Object.keys(state).sort()).toEqual(['activeId', 'conversations']);
  });

  it('⭐ 读的时候顺手清理历史遗留的重复空会话（只留最新一条）', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([conv('e2', 200), conv('e1', 100)]),
    );
    const state = readDockState(1000);

    expect(state.conversations.map((c) => c.id)).toEqual(['e2']);
  });

  it('⭐ 清理时用过的会话一条都不能少', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([
        conv('a', 400, '聊过的'),
        conv('e1', 300),
        conv('e2', 200),
        conv('e3', 100),
      ]),
    );
    const state = readDockState(1000);

    expect(state.conversations.map((c) => c.id)).toEqual(['a', 'e1']);
  });

  it('当前会话是被清掉的那条空会话时，回落到留下的那条', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([conv('newer', 200), conv('older', 100)]),
    );
    localStorage.setItem(KEY_ACTIVE, 'older');

    const state = readDockState(1000);
    expect(state.conversations.map((c) => c.id)).toEqual(['newer']);
    expect(state.activeId).toBe('newer');
  });

  it('写进去再读出来，列表 / 当前会话都还在', () => {
    const state = makeState({
      conversations: [
        { ...conv('a', 100, '聊过的'), used: true, sessionId: 's-a' },
        conv('b', 50, '也聊过'),
      ],
      activeId: 'b',
    });
    writeDockState(state);

    const back = readDockState(1000);
    expect(back.conversations).toEqual(state.conversations);
    expect(back.activeId).toBe('b');
  });

  it('只有一条空会话时原样往返（它是「当前新对话」，不该被清掉）', () => {
    const state = makeState({
      conversations: [conv('a', 100)],
      activeId: 'a',
    });
    writeDockState(state);

    const back = readDockState(1000);
    expect(back.conversations).toEqual(state.conversations);
    expect(back.activeId).toBe('a');
  });

  it('早期版本的折叠 key 会被顺手清掉', () => {
    localStorage.setItem(KEY_COLLAPSED, '1');
    localStorage.setItem(KEY_OPEN_LEGACY, '1');

    writeDockState(makeState());

    expect(localStorage.getItem(KEY_COLLAPSED)).toBeNull();
    expect(localStorage.getItem(KEY_OPEN_LEGACY)).toBeNull();
    expect(localStorage.getItem(KEY_ACTIVE)).toBe('a');
    expect(localStorage.getItem(KEY_LIST)).toContain('"id":"a"');
  });

  it('activeId 指向已不存在的会话时回落到第一条', () => {
    localStorage.setItem(
      KEY_LIST,
      JSON.stringify([conv('x', 2), conv('y', 1)]),
    );
    localStorage.setItem(KEY_ACTIVE, 'ghost');
    expect(readDockState(1000).activeId).toBe('x');
  });

  it('存的列表是坏数据时退回一条默认会话', () => {
    localStorage.setItem(KEY_LIST, 'not json');
    const state = readDockState(1000);
    expect(state.conversations).toHaveLength(1);
    expect(state.activeId).toBe(state.conversations[0].id);
  });
});

/**
 * 本地会话 ↔ 后端会话（session_id）的映射。
 * 新建对话时**不建**后端会话（懒建），所以这个字段一开始就是缺的，
 * 缺 != 坏数据 —— 这两条是这里最该钉住的。
 */
describe('后端会话 id 映射', () => {
  it('withSessionId 只改目标那条会话', () => {
    const state: DockState = {
      conversations: [conv('a', 2), conv('b', 1)],
      activeId: 'a',
    };

    const next = withSessionId(state, 'a', 'sess-a');

    expect(next.conversations[0].sessionId).toBe('sess-a');
    expect(next.conversations[1].sessionId).toBeUndefined();
    expect(next.activeId).toBe('a');
  });

  it('会话已经不在了（发消息途中被删）时原样返回', () => {
    const state: DockState = {
      conversations: [conv('a', 2)],
      activeId: 'a',
    };

    expect(withSessionId(state, 'ghost', 'sess-x')).toBe(state);
  });

  it('已经记着同一个 id 时不产生新对象（少一次落盘/重渲染）', () => {
    const state: DockState = {
      conversations: [{ ...conv('a', 2), sessionId: 'sess-a' }],
      activeId: 'a',
    };

    expect(withSessionId(state, 'a', 'sess-a')).toBe(state);
  });

  it('落盘再读回来还在；旧数据没有这个字段也不算坏数据', () => {
    writeDockState({
      conversations: [{ ...conv('a', 2), sessionId: 'sess-a' }, conv('b', 1)],
      activeId: 'a',
    });

    const state = readDockState(1000);

    expect(state.conversations.find((c) => c.id === 'a')?.sessionId).toBe(
      'sess-a',
    );
    expect(state.conversations.find((c) => c.id === 'b')?.sessionId).toBe(
      undefined,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 最后活动时间（排序 / 分组的依据）
 * ------------------------------------------------------------------ */

describe('updated_at', () => {
  /** 契约给的是 ISO 字符串 —— 断言时用它换算，别写死字面量（时区会漂）。 */
  const iso = (ms: number) => new Date(ms).toISOString();

  it('⭐ 老数据没有这个字段：回落到 createdAt（不是 0）', () => {
    // 回落 0 的话，所有老会话会被判成 1970 年 -> 全掉进「更久以前」兜底组
    expect(conversationUpdatedAt(conv('a', 12345))).toBe(12345);
    expect(
      conversationUpdatedAt({ ...conv('a', 1), updated_at: iso(999) }),
    ).toBe(999);
  });

  it('⭐ 字段名与契约一致：`updated_at` 是 ISO 字符串，不是毫秒数', () => {
    const next = withFirstMessage(makeState(), '你好', 1700000000000);
    const value = next.conversations[0].updated_at;
    expect(typeof value).toBe('string');
    expect(value).toBe('2023-11-14T22:13:20.000Z');
    // 能被 Date.parse 认出来，且 round-trip 回同一个毫秒
    expect(Date.parse(value as string)).toBe(1700000000000);
  });

  it('⭐ 脏字符串回落到 createdAt，不会被当成 0（1970）', () => {
    expect(
      conversationUpdatedAt({ ...conv('a', 4321), updated_at: '不是时间' }),
    ).toBe(4321);
    expect(conversationUpdatedAt({ ...conv('a', 4321), updated_at: '' })).toBe(
      4321,
    );
  });

  it('⭐ 每次提交都刷新它 —— 包括标题早就定过的那次', () => {
    // 这条是真正的回归点：原来这里有「标题没变且 used 已 true 就原样返回」的
    // 早退，加上时间戳之后必须去掉，否则第二次发消息时间戳不更新。
    const state: DockState = {
      conversations: [
        { ...conv('a', 100, '定过的名字'), used: true, updated_at: iso(100) },
      ],
      activeId: 'a',
    };

    const next = withFirstMessage(state, '第二条', 555);

    expect(next.conversations[0].title).toBe('定过的名字');
    expect(next.conversations[0].updated_at).toBe(iso(555));
  });

  it('同一个时间戳重复提交时不产生新对象（保留早退优化）', () => {
    const state: DockState = {
      conversations: [
        {
          ...conv('a', 100, '定过的名字'),
          used: true,
          updated_at: iso(555),
        },
      ],
      activeId: 'a',
    };
    expect(withFirstMessage(state, '又一条', 555)).toBe(state);
  });

  it('⭐ 落盘再读回来还在（白名单解析别把它丢了）', () => {
    writeDockState({
      conversations: [
        {
          ...conv('a', 100, '聊过的'),
          used: true,
          updated_at: iso(8888),
          pinned: true,
        },
      ],
      activeId: 'a',
    });

    const read = readDockState(1000).conversations[0];
    expect(read.updated_at).toBe(iso(8888));
    expect(read.pinned).toBe(true);
  });

  it('⭐ 迁移：老版本的 `lastUpdateTime`（毫秒数）要能读出来并归一化成 ISO', () => {
    // 老格式整个是另一套（字段名 + 类型都不同）。直接按新类型读会让时间失效，
    // 所有老会话静默掉进「更久以前」—— 所以这一条必须钉住。
    const legacy = JSON.stringify([
      {
        id: 'a',
        title: '老的',
        createdAt: 100,
        used: true,
        lastUpdateTime: 8888,
      },
    ]);
    const read = parseConversations(legacy);
    expect(read).toHaveLength(1);
    expect(read[0].updated_at).toBe(iso(8888));
  });

  it('⭐ 迁移：两种字段都在时以 `updated_at` 为准（它才是被持续写入的那个）', () => {
    const both = JSON.stringify([
      {
        id: 'a',
        title: '两边都有',
        createdAt: 100,
        updated_at: iso(200),
        lastUpdateTime: 8888,
      },
    ]);
    expect(parseConversations(both)[0].updated_at).toBe(iso(200));
  });

  it('不可解析的时间不会被写进状态（缺字段好过脏字段）', () => {
    const junk = JSON.stringify([
      { id: 'a', title: '脏的', createdAt: 100, updated_at: 'nope' },
    ]);
    const read = parseConversations(junk);
    // 字段整个丢掉，读的时候回落 createdAt —— 而不是留一个 NaN 到处传
    expect(read[0].updated_at).toBeUndefined();
    expect(conversationUpdatedAt(read[0])).toBe(100);
  });
});

describe('withPinned', () => {
  const state: DockState = {
    conversations: [{ ...conv('a', 100, '聊过的'), used: true }],
    activeId: 'a',
  };

  it('置顶 / 取消置顶', () => {
    expect(withPinned(state, 'a', true).conversations[0].pinned).toBe(true);
    // 取消要显式写 false，不能只是"不写这个字段"——
    // 否则 parseConversations 之后两种状态在存储里长得一样（都缺字段）。
    expect(
      withPinned(withPinned(state, 'a', true), 'a', false).conversations[0]
        .pinned,
    ).toBe(false);
  });

  it('状态没变时原样返回（少一次落盘）', () => {
    expect(withPinned(state, 'a', false)).toBe(state);
    expect(withPinned(state, 'ghost', true)).toBe(state);
  });
});

/* ------------------------------------------------------------------ *
 * 分组：置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更久以前
 * ------------------------------------------------------------------ */

describe('groupConversations', () => {
  /** 固定"现在"为 2026-10-05 12:00 本地时间，跨天/跨月的边界才钉得住 */
  const NOW = new Date(2026, 9, 5, 12, 0, 0).getTime();
  const at = (days: number, hour = 12) =>
    new Date(2026, 9, 5 - days, hour, 0, 0).getTime();
  /** 用 contract 的 ISO 形态喂 updated_at —— 别再用毫秒数（那正是这次要改的） */
  const iso = (ms: number) => new Date(ms).toISOString();

  it('⭐ 组的顺序是 置顶 → 今天 → 昨天 → 7 天内 → 30 天内 → 更久以前（不按中文排序）', () => {
    const groups = groupConversations(
      [
        { ...conv('o', at(300)), used: true },
        { ...conv('m', at(20)), used: true },
        { ...conv('s', at(3)), used: true },
        { ...conv('y', at(1)), used: true },
        { ...conv('t', at(0, 9)), used: true },
        { ...conv('p', at(400)), used: true, pinned: true },
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      '置顶',
      '今天',
      '昨天',
      '7 天内',
      '30 天内',
      '更久以前',
    ]);
  });

  it('⭐ 空组不返回（渲染层直接 map，不用判空）', () => {
    const groups = groupConversations(
      [{ ...conv('y', at(1)), used: true }],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['昨天']);
  });

  it('⭐ 今天的会话进「今天」组（回归：上一版把它塞进了「7 天内」）', () => {
    expect(
      conversationGroupKey({ ...conv('t', at(0, 9)), used: true }, NOW),
    ).toBe('today');
    // 凌晨那条也算今天 —— 只要还在同一个自然日
    expect(
      conversationGroupKey({ ...conv('t', at(0, 0)), used: true }, NOW),
    ).toBe('today');
  });

  it('⭐「昨天」按**自然日**算，不是按 24 小时整', () => {
    // 昨天下午 23:59 与今天凌晨 00:01 只差 58 分钟，但它们是**两天**
    const lateYesterday = conversationGroupKey(
      { ...conv('a', at(1, 23)), used: true },
      NOW,
    );
    const earlyToday = conversationGroupKey(
      { ...conv('b', at(0, 0)), used: true },
      NOW,
    );
    expect(lateYesterday).toBe('yesterday');
    expect(earlyToday).toBe('today');
  });

  it('⭐ 边界全表：今天 0 / 昨天 1 / 7 天内 2~7 / 30 天内 8~30 / 更久以前 31+', () => {
    const key = (days: number) =>
      conversationGroupKey({ ...conv('x', at(days)), used: true }, NOW);
    expect(key(0)).toBe('today');
    expect(key(1)).toBe('yesterday');
    expect(key(2)).toBe('last7');
    expect(key(7)).toBe('last7');
    expect(key(8)).toBe('last30');
    expect(key(30)).toBe('last30');
    // ⚠️ 回归点：上一版把一年前的会话也归「30 天内」，标签就是错的
    expect(key(31)).toBe('older');
    expect(key(365)).toBe('older');
  });

  it('⭐ 未来时间戳（机器时钟被改过）归「今天」，不落进更久以前', () => {
    expect(
      conversationGroupKey({ ...conv('x', at(-3)), used: true }, NOW),
    ).toBe('today');
  });

  it('⭐ 判定用的是 `updated_at`：建得早但聊得晚 → 按最后活动时间归组', () => {
    // createdAt 是 20 天前（本该进「30 天内」），但昨天又聊过 → 应该进「昨天」
    const conv1 = {
      ...conv('revisited', at(20)),
      used: true,
      updated_at: iso(at(1)),
    };
    expect(conversationGroupKey(conv1, NOW)).toBe('yesterday');
  });

  it('⭐ 置顶优先于时间：一年前的置顶项也进「置顶」组且排最前', () => {
    const groups = groupConversations(
      [
        { ...conv('y', at(1)), used: true },
        { ...conv('p', at(365)), used: true, pinned: true },
      ],
      NOW,
    );
    expect(groups[0].key).toBe('pinned');
    expect(groups[0].items.map((c) => c.id)).toEqual(['p']);
  });

  it('⭐ 组内按 updated_at 倒序（建得早但聊得晚的排前面）', () => {
    const groups = groupConversations(
      [
        // 昨天建的，但今天 11:00 又聊过
        { ...conv('new', at(1)), used: true, updated_at: iso(at(0, 11)) },
        // 今天建的，最后一次活动是今天 09:00
        { ...conv('old', at(0)), used: true, updated_at: iso(at(0, 9)) },
      ],
      NOW,
    );
    // 两条的 updated_at 都在今天 -> 同进「今天」这一组
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('today');
    // ⚠️ 按 createdAt 排的话顺序会反过来（old 是今天建的、new 是昨天建的），
    //   所以这条断言真的在验「按 updated_at 排」。
    expect(groups[0].items.map((c) => c.id)).toEqual(['new', 'old']);
  });

  it('老数据（无 updated_at）按 createdAt 排，不至于全挤在一起', () => {
    const groups = groupConversations(
      [
        { ...conv('b', at(0, 20)), used: true },
        { ...conv('a', at(0, 9)), used: true },
      ],
      NOW,
    );
    // 两条都是今天 -> 同一个组，按 createdAt（这里就是 createdAt 本身）倒序
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('today');
    expect(groups[0].items.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('不改动入参（纯函数）', () => {
    const input = [
      { ...conv('y', at(1)), used: true },
      { ...conv('p', at(2)), used: true, pinned: true },
    ];
    const snapshot = JSON.stringify(input);
    groupConversations(input, NOW);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('空列表返回空数组', () => {
    expect(groupConversations([], NOW)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 行尾那一格「最后对话时间」
 * ------------------------------------------------------------------ */

describe('formatConversationTime', () => {
  /** 本地时区造时刻 —— 别用 `Date.UTC`，否则「同一天」在跨时区时会漂。 */
  const at = (y: number, m: number, d: number, h = 0, mi = 0) =>
    new Date(y, m - 1, d, h, mi).getTime();

  const withTime = (ms: number) => ({
    ...conv('a', 1),
    updated_at: new Date(ms).toISOString(),
  });

  const NOW = at(2026, 10, 17, 15, 30);

  it('同一天只给时分（分组已经说了是「今天」）', () => {
    expect(formatConversationTime(withTime(at(2026, 10, 17, 9, 5)), NOW)).toBe(
      '09:05',
    );
  });

  it('⭐ 行尾**不写「昨天」** —— 分组标题已经说了，每行再写一遍满屏都是昨天', () => {
    expect(formatConversationTime(withTime(at(2026, 10, 16, 22, 0)), NOW)).toBe(
      '10-16',
    );
  });

  it('同年更早给 `月-日`，跨年才带年份', () => {
    expect(formatConversationTime(withTime(at(2026, 3, 8, 1, 0)), NOW)).toBe(
      '3-8',
    );
    expect(formatConversationTime(withTime(at(2025, 12, 31, 1, 0)), NOW)).toBe(
      '2025-12-31',
    );
  });

  it('⭐ 按日历日判「同一天」，不是按 24 小时', () => {
    // 23:50 发的、00:10 看的 —— 真实时钟算下来才 20 分钟前，但已经跨了一天，
    // 分组会把它放进「昨天」。行尾必须同步给日期，不能还显示 `23:50`
    // （那样它就跟「今天」组里的 23:50 长得一模一样）。
    const now = at(2026, 10, 17, 0, 10);
    expect(
      formatConversationTime(withTime(at(2026, 10, 16, 23, 50)), now),
    ).toBe('10-16');
  });

  it('⭐ 没有 updated_at（老数据）就看 createdAt，不是看 now', () => {
    // 回落成 now 的话，所有老会话都会显示成"刚刚"
    const old = { ...conv('a', at(2024, 5, 1, 8, 0)) };
    expect(formatConversationTime(old, NOW)).toBe('2024-5-1');
  });

  it('脏字符串同样回落 createdAt，不抛错、不显示 NaN', () => {
    const broken = {
      ...conv('a', at(2026, 10, 17, 8, 0)),
      updated_at: '不是时间',
    };
    expect(formatConversationTime(broken, NOW)).toBe('08:00');
  });
});

describe('reconcileWithSessions：以后端 sessions 为准校准本地账本', () => {
  /** 后端 Session 的最小形状（契约里没有 title）。 */
  const remote = (sessionId: string, updatedAt: string, status = 'active') => ({
    session_id: sessionId,
    agent_id: 'assistant_dock',
    status,
    updated_at: updatedAt,
  });

  const T = Date.parse('2026-10-18T02:00:00.000Z');
  const AT = '2026-10-18T02:00:00.000Z';

  it('后端有、本地没有 → 补一条，id 由 sessionId 派生、标题是占位', () => {
    const next = reconcileWithSessions(
      makeState({ conversations: [conv('a', 100)], activeId: 'a' }),
      [remote('s-1', AT)],
      { now: T, snapshotAt: T, complete: true },
    );

    expect(next.conversations).toHaveLength(2);
    const added = next.conversations[1];
    expect(added.id).toBe('remote-s-1');
    expect(added.sessionId).toBe('s-1');
    expect(added.title).toBe(REMOTE_TITLE);
    expect(added.createdAt).toBe(T);
    expect(added.updated_at).toBe(AT);
    expect(added.used).toBe(true);
    expect(hasStartedConversation(added)).toBe(true);
  });

  it('⭐ 幂等：同一份后端数据校准两次不会多出一条，且第二次返回原对象', () => {
    const opts = { now: T, snapshotAt: T, complete: true };
    const once = reconcileWithSessions(makeState(), [remote('s-1', AT)], opts);
    const twice = reconcileWithSessions(once, [remote('s-1', AT)], opts);

    expect(twice.conversations).toHaveLength(2);
    // 没有变化必须返回**同一个对象** —— 否则每次开抽屉都多一次重渲染 + 写盘
    expect(twice).toBe(once);
  });

  it('时间相同就不动；后端时间更新则对齐（标题保留本地的）', () => {
    const state = makeState({
      conversations: [
        {
          ...conv('a', 100, '上周那个问题'),
          sessionId: 's-1',
          used: true,
          updated_at: AT,
        },
      ],
    });
    expect(
      reconcileWithSessions(state, [remote('s-1', AT)], {
        now: T,
        snapshotAt: T,
        complete: true,
      }),
    ).toBe(state);

    const next = reconcileWithSessions(
      state,
      [remote('s-1', '2026-10-18T05:00:00.000Z')],
      { now: T, snapshotAt: T, complete: true },
    );
    expect(next.conversations[0].title).toBe('上周那个问题');
    expect(next.conversations[0].updated_at).toBe('2026-10-18T05:00:00.000Z');
  });

  it('⭐ complete 时剔除后端没有的会话（"别用本地缓存"就落在这里）', () => {
    const state = makeState({
      conversations: [
        { ...conv('a', 100), sessionId: 's-1', used: true },
        { ...conv('b', 100), sessionId: 's-2', used: true },
      ],
      activeId: 'a',
    });

    // 后端只剩 s-1（s-2 在别的设备上删了）
    const next = reconcileWithSessions(state, [remote('s-1', AT)], {
      now: T,
      snapshotAt: T,
      complete: true,
    });

    expect(next.conversations.map((c) => c.id)).toEqual(['a']);
  });

  it('⭐ 分页没取全（complete=false）时只并集、绝不剔除', () => {
    const state = makeState({
      conversations: [
        { ...conv('a', 100), sessionId: 's-1', used: true },
        { ...conv('b', 100), sessionId: 's-2', used: true },
      ],
    });

    const next = reconcileWithSessions(state, [remote('s-1', AT)], {
      now: T,
      snapshotAt: T,
      complete: false,
    });

    expect(next.conversations.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('⭐ 草稿（没有 sessionId）永不被剔除', () => {
    const state = makeState({
      conversations: [
        conv('draft', 100),
        { ...conv('a', 100), sessionId: 's-1', used: true },
      ],
      activeId: 'draft',
    });

    const next = reconcileWithSessions(state, [], {
      now: T,
      snapshotAt: T,
      complete: true,
    });

    expect(next.conversations.map((c) => c.id)).toEqual(['draft']);
  });

  it('⭐ 当前会话永不被剔除（别把用户正在读的那条从脚下抽走）', () => {
    const state = makeState({
      conversations: [{ ...conv('a', 100), sessionId: 's-1', used: true }],
      activeId: 'a',
    });

    const next = reconcileWithSessions(state, [], {
      now: T,
      snapshotAt: T,
      complete: true,
    });

    expect(next).toBe(state);
  });

  it('⭐ 快照之后才更新过的会话要留着（"后端没返回" ≠ "已删除"）', () => {
    // 请求发出的那一刻是 snapshotAt；用户在这之后发了消息，updated_at 更晚，
    // 而这次的响应里当然还没有它。
    const snapshotAt = T;
    const state = makeState({
      conversations: [
        {
          ...conv('a', T),
          sessionId: 's-new',
          used: true,
          updated_at: new Date(T + 5000).toISOString(),
        },
      ],
      activeId: 'a',
    });

    const next = reconcileWithSessions(state, [], {
      now: T + 6000,
      snapshotAt,
      complete: true,
    });

    expect(next.conversations.map((c) => c.id)).toEqual(['a']);
  });

  it('归档（软删）的会话不补进来；本地已有的会被剔除', () => {
    // ⚠️ updated_at 必须**早于** snapshotAt：快照之后更新过的条目受保护
    //   （那是"响应还没包含它"，不是"后端删了它"）。
    const empty = makeState({
      conversations: [
        {
          ...conv('a', T - 60_000),
          sessionId: 's-9',
          used: true,
          updated_at: new Date(T - 60_000).toISOString(),
        },
      ],
      activeId: 'b',
    });

    const next = reconcileWithSessions(empty, [remote('s-9', AT, 'archived')], {
      now: T,
      snapshotAt: T,
      complete: true,
    });

    // 不在 alive 里 → 被剔除；ensureConversations 补一条空会话兜底
    expect(next.conversations.some((c) => c.sessionId === 's-9')).toBe(false);
  });

  it('空列表 + 坏时间：不炸，时间回落 now', () => {
    const next = reconcileWithSessions(
      makeState({ conversations: [], activeId: '' }),
      [{ session_id: 's-9', updated_at: '不是时间' }],
      { now: T, snapshotAt: T, complete: true },
    );

    const added = next.conversations.find((c) => c.sessionId === 's-9');
    expect(added?.createdAt).toBe(T);
    expect(added?.updated_at).toBe(new Date(T).toISOString());
  });

  it('本地 id 撞车（历史遗留）时不再追加，避免两条同 id', () => {
    const state = makeState({
      conversations: [conv('remote-s-1', 100, '手工造的')],
      activeId: 'remote-s-1',
    });

    const next = reconcileWithSessions(state, [remote('s-1', AT)], {
      now: T,
      snapshotAt: T,
      complete: true,
    });
    expect(next.conversations).toHaveLength(1);
  });
});
