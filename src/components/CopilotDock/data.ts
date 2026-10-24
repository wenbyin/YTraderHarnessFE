// src/components/CopilotDock/data.ts
//
// 右侧 AI 助手面板的**会话**状态 + 持久化。
//
// 为什么持久化到 localStorage：
//   面板挂在布局层（不在路由里），切页面不会卸载它，所以「切换页面不影响对话窗口」
//   靠挂载位置就够了。但**刷新页面**会重建整棵树 —— 那还是「影响了」。
//   所以会话列表落一份本地存储。
//
// **折叠状态不在这里**，它由 src/app.tsx 的 initialState 持有（menuCollapsed / dockCollapsed）：
//   左侧菜单和这块面板是**互斥**的（谁展开另一边就收起），而左侧菜单的折叠状态天生要在
//   布局层的 React 状态里（ProLayout 的受控 collapsed），把它俩放一起才谈得上「同步」，
//   否则跨组件改另一边得靠事件广播。顺带的好处：折叠状态天然不被持久化 ——
//   菜单每次刷新都从展开开始，若面板的折叠被存下来，刷新后就会出现
//   「面板展开 + 菜单也展开」的矛盾状态。
//
// 这里刻意把「纯函数」和「读写存储」分开：
//   - 纯函数（parse / pick / with* / panelWidth）不碰 window，可以直接在 node 里跑断言；
//   - 只有 readDockState / writeDockState 碰存储，且全部包了 try ——
//     隐私模式下 localStorage 会直接抛，不能让它把整个面板拖挂。

export interface CopilotConversation {
  id: string;
  title: string;
  /** 创建时间戳（ms）。列表按它倒序 —— 新会话在上。 */
  createdAt: number;
  /**
   * 这条会话**被用过没有** —— 也就是「有没有人在里面发过一条消息」。
   *
   * 它决定两件事（都见下面的 hasStartedConversation）：
   *   ① 要不要出现在历史列表里（空会话不列）；
   *   ② 点「+」时能不能拿它来复用（能，就不新建）。
   *
   * 为什么不能只看 sessionId / title，见 hasStartedConversation 的注释。
   * 老数据没有这个字段（那时只有标题一个信号），所以它是可选的。
   */
  used?: boolean;
  /**
   * 后端 Agent Runtime 的会话 id（POST /api/v1/sessions 建的）。
   *
   * 为什么要有本地 id 到后端 id 的映射，而不是直接用后端 id：
   *   面板允许「新建对话」但此时**不该**建后端会话（用户可能只是想开个空对话），
   *   所以本地会话先存在；第一次真正发消息时才懒建后端会话，把 id 记在这里。
   *   后端没有「列会话」的接口（session.yaml 只有建 / 查单个），列表只能以本地为准。
   */
  sessionId?: string;
  /**
   * **最后活动时间**，ISO 8601 字符串（如 `2026-10-05T04:00:00.000Z`）。
   *
   * ⚠️ 字段名与类型都**照抄后端契约**，别改：
   *   · `session.yaml` → `Session.updated_at`（"最后活动时间。每次往这个会话发消息
   *     都会前进 —— 消息写在 agent_message 表，会话行本身没有字段变动，所以由后端在
   *     create_run 时显式把它推到当下"）；
   *   · `messages.yaml` → `SessionMessage.updated_at`。
   *   两边都是 `type: string, format: date-time`。
   *
   * 为什么不用 createdAt 排序：createdAt 是**建对话**的时刻，而用户记得的是
   * 「我刚才聊的那个」。一个上周建的对话今天又聊了，它就该排在最上面。
   * 历史列表按这个字段倒序、按它分组（见 groupConversations）。
   *
   * ⚠️ 为什么存字符串而不是毫秒数：
   *   契约就是字符串，同名字段直接赋值即可，不需要任何转换 —— 那正是「字段名对齐」
   *   的意义。而且字符串**没法被误当成数字相减**（`a.updated_at - b.updated_at`
   *   会立刻得 NaN，响声够大）；存毫秒数时那种错会静默算出一个错值。
   *   所有时间运算一律走 conversationUpdatedAt()，它负责把字符串变成 ms。
   *
   * 老数据没有这个字段（更早的版本叫 `lastUpdateTime`、存的是毫秒数）——
   * 一律回落 createdAt（见 conversationUpdatedAt）。**不能**因为缺字段就把老会话
   * 全塞进「更久以前」或干脆不显示。
   */
  updated_at?: string;
  /**
   * 是否置顶。置顶的会话排在所有分组之前，且不受时间分组限制。
   *
   * 老数据没有这个字段 = 没置顶（不是坏数据）。
   */
  pinned?: boolean;
}

/** 面板里**需要落盘**的那部分状态。折叠与否不在这 —— 见文件头。 */
export interface DockState {
  conversations: CopilotConversation[];
  activeId: string;
}

/** 展开时占可视宽度的几分之一 —— 需求：三分之一。 */
export const PANEL_WIDTH_DIVISOR = 3;

/**
 * 「放大」之后占几分之一 —— 需求：**半屏**（2026-10-22）。
 *
 * ⚠️ 只到 1/2，不做全屏：面板是**侧边**助手，左边始终要留着能让用户
 *    一边看内容一边问的正文区。半屏是"看得清长回答"和"不把内容挤没"的平衡点。
 */
export const PANEL_WIDTH_DIVISOR_WIDE = 2;

/**
 * 面板该占多少像素。
 *   - 收起：**0**。右侧一点占位都不留，内容区拿回全部宽度，只剩一个浮动展开图标。
 *   - 展开：可视宽度的 1/3；`wide` 时是 1/2（见 PANEL_WIDTH_DIVISOR_WIDE）。
 *     传的是 `documentElement.clientWidth`（跟 `.ant-pro-layout` 的实际宽度同源），
 *     这样「内容区让出的宽度」和「面板宽度」能严丝合缝，不留缝也不重叠；
 *     用 vw 的话有纵向滚动条时会把滚动条算进去，内容和面板之间裂出一条缝。
 *
 * ⚠️ `wide` 默认 `false` —— 老调用点（含测试）不用改，行为与从前逐像素相同。
 */
export function panelWidth(
  collapsed: boolean,
  viewportWidth: number,
  wide = false,
): number {
  if (collapsed) return 0;
  const divisor = wide ? PANEL_WIDTH_DIVISOR_WIDE : PANEL_WIDTH_DIVISOR;
  return Math.round(viewportWidth / divisor);
}

export const DEFAULT_TITLE = '新对话';
/** 用首条消息当标题时的截断长度 */
export const TITLE_MAX = 20;

const KEY_LIST = 'ytrader.copilot.conversations';
const KEY_ACTIVE = 'ytrader.copilot.active';

/**
 * 早期版本把折叠状态也存了（`collapsed` 之前还叫过 `open`）。现在折叠状态不落盘，
 * 这两个 key 只做一次清理，别让它们一直躺在用户的浏览器里。
 */
const DEAD_KEYS = ['ytrader.copilot.collapsed', 'ytrader.copilot.open'];

/* ------------------------------------------------------------------ *
 * 存储读写（唯一碰 window 的地方）
 * ------------------------------------------------------------------ */

function readRaw(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function removeRaw(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

export function createConversation(now: number): CopilotConversation {
  return {
    id: `conv-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: DEFAULT_TITLE,
    createdAt: now,
  };
}

/**
 * 这条会话**用过了没有** —— 判据是「有没有人在里面发过消息」。
 *
 * 它是两件事的唯一依据：
 *   · 要不要出现在历史列表里（没用过的不列，见 index.tsx）；
 *   · 点「+」时能不能拿它来复用（能，就不新建，见 withNewConversation）。
 *
 * 为什么要三个信号一起看 —— 每个单独用都有洞：
 *   · `used` 是权威信号，在**提交那一刻**就写上，与后端成不成功无关；
 *   · `sessionId` 补的是老数据（那时还没有 used 字段）；
 *   · `title !== DEFAULT_TITLE` 同样是老数据兜底（以前只有标题这一个信号）。
 *
 * 单看 `sessionId` 的洞：它要等 createSession 返回（中间还要建运行），有几百毫秒
 * 空窗；而且**建会话失败时它永远不会有** —— 那这条已经有消息的对话就再也不
 * 出现在历史里了。单看 `title` 的洞：用户第一条消息恰好就是「新对话」四个字时，
 * withFirstMessage 会认为标题没变，title 仍是默认值、看起来像没用过。
 */
export function hasStartedConversation(conv: CopilotConversation): boolean {
  return conv.used === true || !!conv.sessionId || conv.title !== DEFAULT_TITLE;
}

/**
 * 任意「时间」输入 -> 规范化的 ISO 8601 字符串；认不出来返回 undefined。
 *
 * 为什么要容错：这个字段跨过一次改名（`lastUpdateTime: number` → `updated_at: string`），
 * 用户浏览器里存着老版本的数据，直接按新类型读会让**所有老会话的时间失效**
 * （全掉进「更久以前」）。所以三种形态都认：
 *   · ISO 字符串（`2026-10-05T04:00:00.000Z`）—— 契约形态，也是我们写出去的形态；
 *   · 毫秒数（`1759600000000`）—— 老版本 `lastUpdateTime` 的形态；
 *   · 其他能被 `Date.parse` 认出来的字符串（带时区偏移的 `+08:00` 等）。
 *
 * ⚠️ 输出统一用 `toISOString()` 归一化，而不是把原字符串原样存下来：
 *   同一个时刻的写法有无数种（`+08:00` / `Z` / 无毫秒），存成一种才能在存储里
 *   直接比字符串、也才看得出"这条到底改过没有"（withFirstMessage 的早退判据）。
 */
function toIsoDateTime(value: unknown): string | undefined {
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

/** JSON 字符串 -> 会话数组。坏数据一律丢掉，不要让一条脏记录把整个列表渲染崩。 */
export function parseConversations(raw: string | null): CopilotConversation[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: CopilotConversation[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const {
      id,
      title,
      createdAt,
      sessionId,
      used,
      updated_at,
      lastUpdateTime,
      pinned,
    } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') continue;
    // 新字段优先，老字段兜底 —— 两个都在时以新字段为准（它才是被持续写入的那个）。
    const updatedAt =
      toIsoDateTime(updated_at) ?? toIsoDateTime(lastUpdateTime);
    out.push({
      id,
      title: typeof title === 'string' && title ? title : DEFAULT_TITLE,
      createdAt: typeof createdAt === 'number' ? createdAt : 0,
      // 旧数据没有这些字段 —— 缺了不是坏数据，分别表示
      // 「还没发过消息」「还没建后端会话」「没置顶」。
      // ⚠️ 这里必须显式列出来：这个函数是**白名单**式的，漏写等于把字段丢掉
      //   （实测踩过：漏了 used，刷新后所有会话又都变回"没用过"，
      //   历史列表直接空掉 —— 而且是静默的，只有单测抓得到）。
      // 同理：漏了 updated_at / pinned，置顶和分组会一起失效。
      ...(used === true ? { used: true } : {}),
      ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
      ...(pinned === true ? { pinned: true } : {}),
    });
  }
  return out;
}

/** 列表永远至少有一条 —— 空列表会让「当前会话」这个概念没有落点。 */
export function ensureConversations(
  list: CopilotConversation[],
  now: number,
): CopilotConversation[] {
  return list.length ? list : [createConversation(now)];
}

export function sortByCreatedDesc(
  list: CopilotConversation[],
): CopilotConversation[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------------------------------------------ *
 * 历史列表的分组（置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更久以前）
 * ------------------------------------------------------------------ */

/**
 * 这条会话该按哪个时刻排序 / 分组 —— 返回**毫秒数**。
 *
 * 这是全模块**唯一**把 `updated_at`（字符串）变成数字的地方。
 * 别在别处直接 `Date.parse(conv.updated_at)`：那样每个调用点都要自己想一遍
 * "解析失败怎么办"，而正确答案只有一个 —— 回落到 createdAt。
 *
 * ⚠️ 解析不出来（字段缺失 / 脏字符串）一律回落 `createdAt`，**不能返回 0**：
 *   返回 0 等于 1970 年，所有老会话会被静默塞进「更久以前」——
 *   列表看着还在、内容却在错误的组里，比直接不显示更难发现。
 */
export function conversationUpdatedAt(conv: CopilotConversation): number {
  if (typeof conv.updated_at === 'string') {
    const ms = Date.parse(conv.updated_at);
    if (!Number.isNaN(ms)) return ms;
  }
  return conv.createdAt;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 补零到两位 —— 只喂给 `HH:mm`。 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 会话行右侧那个「最后对话时间」。
 *
 * 分三档，越近越精确 —— 面板宽度只有 1/3 屏，日期不能把标题挤掉：
 *   同一天 → `14:05`；同年 → `9-12`；跨年 → `2025-9-12`。
 *
 * ⚠️ **没有「昨天」这一档**。列表本身已经按「今天 / 昨天 / 7 天内」分组，
 *    行尾再写一个「昨天」，等于把分组标题重复到每一行上 —— 一眼看过去
 *    满屏"昨天"，反而看不出哪条是昨晚哪条是前天。跨了日就给日期。
 *
 * 三件必须坚持的事：
 *
 * 1. **基准只能是 `conversationUpdatedAt`**，不能在这里再解析一遍 `updated_at`。
 *    两处各算一遍就会出现"排在『今天』组里、右边却写着别的日子"——那是同一个字段的
 *    两种解析结果，最难查的那种不一致。
 * 2. **`now` 可以注入**。时间格式化一旦依赖跑测试那一刻的真实时钟，
 *    断言就只能写成"大概是这个形状"，等于没测。
 * 3. **按日历日比较，不用 `now - 24h`**。23:50 发的消息在 00:10 看应该算"前一天"，
 *    用毫秒差会算成"同一天"；夏令时那一小时同理。
 */
export function formatConversationTime(
  conv: CopilotConversation,
  now: number = Date.now(),
): string {
  const d = new Date(conversationUpdatedAt(conv));
  const n = new Date(now);

  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();

  if (sameDay) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  if (d.getFullYear() === n.getFullYear()) {
    return `${d.getMonth() + 1}-${d.getDate()}`;
  }
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 分组 key。用字符串常量而不是中文标题 —— 标题要能改，key 不能。 */
export type ConversationGroupKey =
  | 'pinned'
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'older';

export interface ConversationGroup {
  key: ConversationGroupKey;
  label: string;
  items: CopilotConversation[];
}

/** 组的展示顺序 = 定义顺序（置顶 → 今天 → …… → 更久以前），别用 sort 排中文。 */
const GROUP_ORDER: ConversationGroupKey[] = [
  'pinned',
  'today',
  'yesterday',
  'last7',
  'last30',
  'older',
];

/**
 * 归到哪一组 —— **按自然日算，不是按 24 小时整**。
 *
 * 「昨天」= 昨天这个自然日（不是 24 小时前）。会话多半在白天产生，
 * 按自然日算才符合用户直觉（昨天下午 23:59 和今天凌晨 00:01 是两天，
 * 尽管只差 58 分钟）。
 *
 * ⚠️ 算「差几天」必须**先把两边都各自归零到当天零点，再相减**。
 *   直接 `(startOfToday - ts) / DAY` 是在量"距今天零点的时长"：
 *   昨天下午 12 点距今天零点只有 12 小时，floor 出来是 **0** → 被判成"今天"，
 *   于是「昨天」这一组永远收不到下午的会话（踩过：单测 at(1, 12) 就红了）。
 *   归零之后再除，还得用 `Math.round` 而不是 `floor`：
 *   夏令时切换那天两个零点之间是 23h 或 25h，floor 会整整差一天。
 *
 * ⚠️ 五个时间组的**边界必须写全**，这是上一版的真 bug：
 *   上一版只有 4 组（没有「今天」也没有「更久以前」），于是
 *     · `days <= 0` 被塞进 `last7` → 今天和「7 天内」混在一起，
 *       用户按「今天」找会话时找不到（这正是这次报的问题）；
 *     · `days > 30` 也塞进 `last30` → 一年前的会话显示在「30 天内」下，
 *       标签直接是错的。
 *   现在：0 = 今天、1 = 昨天、2~7 = 7 天内、8~30 = 30 天内、> 30 = 更久以前。
 *
 * `days < 0`（时间戳在未来，机器时钟被改过）也归「今天」—— 总得有个落脚点，
 * 而"未来"最接近的语义就是"刚刚"。
 *
 * `now` 显式传进来而不是内部取 Date.now()：这样它是纯函数，
 * 可以在单测里钉住「今天上午 / 昨天下午 / 8 天前」这些边界。
 */
export function conversationGroupKey(
  conv: CopilotConversation,
  now: number,
): ConversationGroupKey {
  if (conv.pinned === true) return 'pinned';

  const startOf = (ts: number) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round(
    (startOf(now) - startOf(conversationUpdatedAt(conv))) / DAY_MS,
  );
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'last7';
  if (days <= 30) return 'last30';
  return 'older';
}

export const GROUP_LABELS: Record<ConversationGroupKey, string> = {
  pinned: '置顶',
  today: '今天',
  yesterday: '昨天',
  last7: '7 天内',
  last30: '30 天内',
  older: '更久以前',
};

/**
 * 分组 + 组内排序。**空组不返回**（DeepSeek 那样），所以渲染层直接 map 即可。
 *
 * 组内按 updated_at 倒序（新的在上）；置顶组同样按时间排，
 * 不按标题排 —— 置顶解决的是「别沉底」，不是「按名字排队」。
 *
 * @param now 显式传入当前时间（纯函数，见上面 conversationGroupKey 的注释）
 */
export function groupConversations(
  list: CopilotConversation[],
  now: number,
): ConversationGroup[] {
  const buckets = new Map<ConversationGroupKey, CopilotConversation[]>();
  for (const conv of list) {
    const key = conversationGroupKey(conv, now);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(conv);
    else buckets.set(key, [conv]);
  }
  return GROUP_ORDER.flatMap((key) => {
    const items = buckets.get(key);
    if (!items || items.length === 0) return [];
    return [
      {
        key,
        label: GROUP_LABELS[key],
        items: [...items].sort(
          (a, b) => conversationUpdatedAt(b) - conversationUpdatedAt(a),
        ),
      },
    ];
  });
}

/**
 * 置顶/取消置顶。**没有这个函数就别在 UI 上放置顶按钮** —— 那是假功能。
 *
 * ⚠️ 「已经是这个状态」的判据要用 `=== true` 归一化，不能直接比 `c.pinned === pinned`：
 *   老数据**根本没有 pinned 这个键**，拿 `undefined === false` 去比恒为假 →
 *   「取消置顶」每次都会白造一个新对象、多落一次盘。
 */
export function withPinned(
  state: DockState,
  id: string,
  pinned: boolean,
): DockState {
  let changed = false;
  const conversations = state.conversations.map((c) => {
    if (c.id !== id) return c;
    const isPinned = c.pinned === true;
    if (isPinned === pinned) return c;
    changed = true;
    return pinned ? { ...c, pinned: true } : { ...c, pinned: false };
  });
  return changed ? { ...state, conversations } : state;
}

/** 存的 activeId 可能已经不在列表里了（删过 / 换过浏览器），回落到第一条。 */
export function pickActiveId(
  list: CopilotConversation[],
  stored: string | null,
): string {
  if (stored && list.some((c) => c.id === stored)) return stored;
  return list[0]?.id ?? '';
}

/** 首条消息 -> 会话标题。折叠空白，超长截断。空消息返回 ''（调用方据此不改标题）。 */
export function titleFromMessage(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

/**
 * 只留**最新的一条**空会话，其余空会话整条丢掉。
 *
 * 为什么可以丢：空会话 = 没有消息、没有后端会话、标题还是默认值，
 * 彼此完全等价 —— 留着就是垃圾（历史列表里也看不到，见 hasStartedConversation）。
 * 早期版本每点一次「+」就存一条，用户手里可能已经攒了一排（实测截到的
 * 那张图里 5 条「新对话」就是这么来的）。
 *
 * 只在**读**的时候做一次（读出来的状态随后会被写回去），不在 withNewConversation
 * 里做 —— 那里已经保证不会再产生新的重复了，这里只负责清历史遗留。
 *
 * 入参假定已按 createdAt 倒序（readDockState 保证了），所以第一条空会话就是最新的。
 */
export function pruneEmptyConversations(
  list: CopilotConversation[],
): CopilotConversation[] {
  let keptOne = false;
  return list.filter((c) => {
    if (hasStartedConversation(c)) return true;
    if (keptOne) return false;
    keptOne = true;
    return true;
  });
}

export function readDockState(now: number = Date.now()): DockState {
  const list = sortByCreatedDesc(
    ensureConversations(
      pruneEmptyConversations(parseConversations(readRaw(KEY_LIST))),
      now,
    ),
  );
  return {
    conversations: list,
    activeId: pickActiveId(list, readRaw(KEY_ACTIVE)),
  };
}

export function writeDockState(state: DockState): void {
  writeRaw(KEY_LIST, JSON.stringify(state.conversations));
  writeRaw(KEY_ACTIVE, state.activeId);
  for (const key of DEAD_KEYS) removeRaw(key);
}

/**
 * 新建会话。**但手上已经有「没用过的空会话」时，是切过去、不是再建一条。**
 *
 * 为什么：空会话之间没有任何可辨识的差别 —— 同一句欢迎语、同一个标题
 * 「新对话」、时间戳还在同一分钟。用户按几次「+」就堆出几条一模一样的记录，
 * 而界面上什么都看不出来，于是他会以为「点了没反应」继续按（实测 14 秒内
 * 堆了 5 条）。ChatGPT / DeepSeek 也是这个行为：已经在新对话里了，再点
 * 「新对话」就停在原地。
 *
 * 复用不刷新 createdAt —— 否则时间戳会跳，反而更像"确实新建了"，更容易误导。
 *
 * 返回值：已经在那个空会话里时**原样返回同一个对象**，避免一次无意义的重渲染
 * （用户看到的就是"没有任何副作用"）。
 */
export function withNewConversation(state: DockState, now: number): DockState {
  const reusable = state.conversations.find((c) => !hasStartedConversation(c));
  if (reusable) {
    return state.activeId === reusable.id
      ? state
      : { ...state, activeId: reusable.id };
  }

  const conv = createConversation(now);
  return {
    conversations: [conv, ...state.conversations],
    activeId: conv.id,
  };
}

/**
 * 删除会话。
 * 删掉的正好是当前会话时，优先接它后面那条，没有就接前面那条 ——
 * 比「一律跳第一条」更符合直觉（用户视线不用跳到列表顶端）。
 */
export function withRemovedConversation(
  state: DockState,
  id: string,
  now: number = Date.now(),
): DockState {
  const index = state.conversations.findIndex((c) => c.id === id);
  if (index < 0) return state;

  const fallback =
    state.conversations[index + 1]?.id ??
    state.conversations[index - 1]?.id ??
    '';
  const list = ensureConversations(
    state.conversations.filter((c) => c.id !== id),
    now,
  );
  const wanted = state.activeId === id ? fallback : state.activeId;
  return {
    conversations: list,
    activeId: pickActiveId(list, wanted),
  };
}

/**
 * 后端**没有**标题（`Session` 契约里只有 session_id / agent_id / status /
 * user_id / updated_at），所以从后端补回来的条目只能用这个占位名。
 *
 * 本地存的那份标题是**显示名缓存**，不是数据源：列表成员由后端决定，
 * 标题只是"这条会话在用户眼里叫什么"。
 */
export const REMOTE_TITLE = '历史对话';

/**
 * 补回来的本地 id 前缀。id 由 `session_id` 派生而不是随手生成一个随机串：
 * 同一份后端数据对齐两次不会多出一条（幂等），刷新也不会增生。
 */
function remoteConversationId(sessionId: string): string {
  return `remote-${sessionId}`;
}

/**
 * `reconcileWithSessions` 需要的最小形状。
 *
 * 刻意**不** import agentRuntime 的 AgentSession：这一层是存储层，
 * 不该认识 HTTP。AgentSession 结构上满足这个接口，直接传进来即可。
 */
export interface RemoteSessionLike {
  session_id: string;
  /** 目前不消费（列表没有标题可用），留着是为了调用方不必裁剪对象。 */
  agent_id?: string;
  /** 只有 active 的会留下；archived（软删过的）一律跳过。 */
  status?: string;
  /** 最后活动时间，ISO 8601 字符串。 */
  updated_at: string;
}

export interface ReconcileOptions {
  /** 当前时刻，注入是为了可测。 */
  now?: number;
  /**
   * 这次请求**发出**的时刻（ms）。
   *
   * 用来保护"快照之后才出现/动过"的本地会话：请求在飞的时候用户可能刚发了
   * 第一条消息、把草稿变成了真会话，那次会话当然不在响应里 —— 不能因为
   * "后端没返回"就把它删掉。
   */
  snapshotAt?: number;
  /**
   * 后端是否把**全部**会话都给回来了（`total <= items.length`）。
   *
   * false（分页没取全）时**只并集、不剔除** —— 这是硬约束：按"没返回 = 已删"
   * 去删本地条目，会把落在第 2 页的几百条历史一次抹掉，而本地是标题的**唯一
   * 副本**，删了不可恢复。
   */
  complete?: boolean;
}

/**
 * 用后端会话列表**校准**本地账本：成员、时间以后端为准。
 *
 * 这是"数据以 sessions 为准"的落点 —— 每次拉到列表都调它一次：
 *
 *     后端有、本地没有   → 补一条（标题回落 REMOTE_TITLE）
 *     两边都有           → 用后端的 updated_at 覆盖（时间只有一个权威）
 *     **后端没有、本地有** → complete 时**删掉**（这就是"别用本地缓存"）
 *
 * 三条**不能被删**的例外（都写进了代码，别随手去掉）：
 *   · 没有 sessionId 的**草稿**（还没发过消息的新对话，后端压根没有它）；
 *   · **当前会话**：别在读着的时候把它从脚下抽走 —— 它可能刚被别的设备删了，
 *     下一次发消息会拿到 404/409，界面会给可读的原因，比"对话突然消失"好；
 *   · `snapshotAt` **之后**才创建或更新过的：那不是"后端没有"，是"响应还没
 *     包含它"。
 *
 * ⚠️ 没有变化时返回**同一个对象**
 * ----------------------------
 *   调用方拿它 setState，返回新对象 = 无条件重渲染 + `writeDockState` 多写
 *   一次盘。每次拉列表都造个新对象，面板空闲时也会反复落盘。
 */
export function reconcileWithSessions(
  state: DockState,
  sessions: readonly RemoteSessionLike[],
  options: ReconcileOptions = {},
): DockState {
  const now = options.now ?? Date.now();
  const snapshotAt = options.snapshotAt ?? now;
  const complete = options.complete ?? false;

  let conversations = [...state.conversations];
  /** sessionId -> 在 conversations 里的下标（本地有 sessionId 的那些）。 */
  const index = new Map<string, number>();
  conversations.forEach((c, i) => {
    if (c.sessionId) index.set(c.sessionId, i);
  });

  /** 后端这次给回来的 sessionId（archived 的不算"活着"）。 */
  const alive = new Set<string>();
  let changed = false;

  for (const remote of sessions) {
    const sessionId = remote?.session_id;
    if (!sessionId) continue;
    // 软删过的会话不该回到列表里 —— 默认请求本来就不返回它们，
    // 这里再挡一次是因为调用方可能显式传了 status=archived。
    if (remote.status === 'archived') continue;

    alive.add(sessionId);

    const stamp = toIsoDateTime(remote.updated_at);
    const at = index.get(sessionId);

    if (at !== undefined) {
      const local = conversations[at];
      // 后端时间更新 → 对齐。相等就不动（保住"无变化返回原对象"）。
      if (stamp && local.updated_at !== stamp) {
        conversations[at] = { ...local, updated_at: stamp };
        changed = true;
      }
      continue;
    }

    // ⚠️ 除了按 sessionId 建索引，还要挡住"同一个 id 已经存在"这种极小概率
    // 的撞车（历史遗留数据里可能已经有一条同名 id）。
    const id = remoteConversationId(sessionId);
    if (conversations.some((c) => c.id === id)) continue;

    const createdMs = stamp ? Date.parse(stamp) : Number.NaN;
    conversations.push({
      id,
      title: REMOTE_TITLE,
      createdAt: Number.isNaN(createdMs) ? now : createdMs,
      // 有 sessionId 就已经算"用过"（见 hasStartedConversation），显式写下来
      // 是为了让数据本身自解释 —— 读的人不必再推理一遍。
      used: true,
      sessionId,
      updated_at: stamp ?? new Date(now).toISOString(),
    });
    index.set(sessionId, conversations.length - 1);
    changed = true;
  }

  if (complete) {
    const kept = conversations.filter((c) => {
      if (!c.sessionId) return true; // 草稿：后端没有它，但它属于"还没提交"
      if (alive.has(c.sessionId)) return true;
      if (c.id === state.activeId) return true;
      // ⚠️ 用 updated_at 而不是 createdAt：一条老会话今天又聊过，它比快照新。
      return conversationUpdatedAt(c) >= snapshotAt;
    });
    if (kept.length !== conversations.length) {
      conversations = kept;
      changed = true;
    }
  }

  if (!changed) return state;

  return {
    conversations: ensureConversations(conversations, now),
    activeId: pickActiveId(conversations, state.activeId),
  };
}

/**
 * 记下某个本地会话对应的后端会话 id（首次发消息建完会话后调用）。
 * 找不到这个会话（比如刚被删掉）就原样返回 —— 调用方在异步回来的路上，
 * 期间用户可能已经把它删了，不能因此把状态改坏。
 */
export function withSessionId(
  state: DockState,
  conversationId: string,
  sessionId: string,
): DockState {
  let changed = false;
  const conversations = state.conversations.map((c) => {
    if (c.id !== conversationId || c.sessionId === sessionId) return c;
    changed = true;
    return { ...c, sessionId };
  });
  return changed ? { ...state, conversations } : state;
}

/**
 * 用首条消息给当前会话命名，并**把它标记为「用过了」**。
 *
 * 标题：只有还是默认值时才改 —— 名字一旦定了就不再变。
 * 用过标记：与标题无关，**每次提交都写**。它是「这条会话算不算历史对话」的权威
 *   信号（见 hasStartedConversation），必须在这一刻就落地 —— 不能等后端把会话
 *   建出来（中间还要建运行，几百毫秒），更不能依赖它成功。
 *
 * 最后活动时间：每次提交都刷新（分组和排序靠它，见 conversationUpdatedAt）。
 *   写出去的是 **ISO 字符串**（`updated_at` 的契约类型），不是毫秒数。
 * ⚠️ 原来这个函数在「标题没变且 used 已是 true」时直接返回原对象（省一次渲染），
 *   加上时间戳之后**不能**再走这条早退 —— 否则第二次发消息时间戳不更新，
 *   会话在列表里会停在上一次的位置，看起来像「没生效」。
 *
 * @param now 当前时间戳（ms）。显式传入是为了让这个纯函数可测。
 */
export function withFirstMessage(
  state: DockState,
  message: string,
  now: number = Date.now(),
): DockState {
  const title = titleFromMessage(message);
  if (!title) return state;

  const stamp = new Date(now).toISOString();
  let changed = false;
  const conversations = state.conversations.map((c) => {
    if (c.id !== state.activeId) return c;
    const nextTitle = c.title === DEFAULT_TITLE ? title : c.title;
    if (c.used === true && nextTitle === c.title && c.updated_at === stamp)
      return c;
    changed = true;
    return { ...c, title: nextTitle, used: true, updated_at: stamp };
  });
  return changed ? { ...state, conversations } : state;
}
