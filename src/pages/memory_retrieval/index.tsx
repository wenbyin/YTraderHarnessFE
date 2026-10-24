// src/pages/memory_retrieval/index.tsx
// 四层记忆的浏览与上下文组装（管理员视图）——
// 对接 YTraderHarness app/services/memory/memory_api_v2.yaml（**v2.1.0**，2026-10-12）。
//
// 六个接口 = **五个 tab**（`/query/l2/detail` 不单独占一个 tab —— 它是 L2 列表里
// 「查看全文」抽屉的后端；同一份正文不再开第二个入口）：
//   汇总    POST /memory/retrieval          模拟一轮上下文组装（默认 L3 画像 + L2 场景索引，
//                                           L0/L1 可选、打开时以 input 真跑一轮召回）
//   L0      POST /memory/query/l0           **浏览**已保存的消息全文（游标分页）
//   L1      POST /memory/query/l1           **浏览**已保存的原子记忆（游标分页）
//   L2      POST /memory/query/l2           **浏览**场景索引（游标分页；点某张卡开抽屉看全文）
//   L3      POST /memory/query/l3           取该 scope 的画像
//   （`POST /memory/query/l2/detail` —— 只有抽屉在调）
//
// ⚠️ v2.0.0 是**破坏性**改版（上一版叫 /memory/retrieval/l0|l1|...）：
//   1. L0/L1 **不再是检索**：没有 mode / score / matched_by / degraded_routes，
//      `query` 变成 `text_contains`（**字面包含**，契约明说不是语义检索），
//      L0 返回的是**完整消息正文**。所以页面里不再有"召回模式"这个控件。
//   2. 三个列表端点改成**不透明游标分页** → 界面用「卡片流 + 加载更多」：
//      条目累积、只往前走；"还有下一页"看响应的 `has_more`。
//      ⚠️ 游标绑死在"当时那套筛选"上，所以**改筛选必须让"加载更多"失效**
//      （靠 `listSignature` 比对），否则会把两套筛选的页拼在一起。
//   3. `session_id` 从汇总端点移除（三个 `/query` 里只有 L0 还吃它）。
//
// ⚠️⚠️ v2.1.0 把 L0/L1 **放回了汇总端点**，这是本页最容易读反的一处：
//   · `retrieve.l0` / `retrieve.l1` 打开时服务端会**以 `input` 为查询串真跑一轮
//     混合召回**（与 Agent 调 `memory.search` 同一条实现）—— 所以 `input` 变回
//     **必填**，所以参数卡里四个开关的顺序与 `sections` 的顺序都要按 **L0 -> L3**
//     （用户 2026-10-12 要求），而后端返回的 `sections` 是 **prompt 顺序**。
//   · 注意这**只**影响汇总预览：三个 `/query` 端点仍然是"浏览不是检索"，
//     那套 mode / score 并没有回来。
//
// 页面口径（都是契约明写、前端不能替他做主的）：
//   1. **target = (user_id / team_id 恰一个) + agent_id（必填）**。两个归属都给是
//      **400** —— 界面上由开关从**结构**上保证"恰有一个"（切走就清另一侧）。
//      `agent_id` 是**选**出来的（当前只有一个候选 `general`，见 AGENT_ID_OPTIONS）。
//   2. **团队 target 下 L0/L1 查询**是 400（这两层没有按 team 过滤的路径）→
//      拦在发起处。汇总端点**不拦**：它不整单 400，那两层在该 target 下会进
//      `degraded`（所以别把那里的降级读成"后端出故障"）。
//   3. 本组端点全部要求 Y-Trader-Admin（403 而不是 404），且本地 dev-bypass 的
//      roles 是空的 → 本地调它必然 403，别把它当成"后端没起"。
//   4. **不调模型**：返回的是数据（记录、分段结构、拼好的 prompt 预览）。
//
// 界面布局（2026-10-12 按用户要求调过四处，都是"信息该在哪一行"的问题）：
//   1. 「个人 / 团队」开关从参数区搬到左侧那张卡的**卡头左边**（与右上角的端点 Tag
//      同一行）→ state 只能上提到页面（`useScopeSwitch`），见 Fields.tsx。
//   2. 结果那一侧：`scope_kind` 直接跟在卡头「结果」二字后面 —— 它回答的是"这次
//      返回的是谁的记忆"，属于结果的身份；原来埋在结果体里要滚动才看得见。
//      于是列表头 / L3 / 汇总三处各自那枚 scope Tag 一起撤掉，**只留这一个来源**。
//   3. md 阅读器的「阅读器 / 原文」切换器改成**两个图标**（图片 / 文本），文案进 tooltip。
//   4. 页面级「重置」= **把这一页恢复成刚打开的样子**（原来只清当前 tab 的参数与
//      结果，导致最常见的那次点击里什么都不变 → 被读成"点了没反应"）。
//
// ⚠️ JSX 的**属性字符串**里不能出现双引号（会提前闭合），也不能写 markdown 的
//    星号加粗（会原样渲染出来）。正文里要强调就用 <b>，引号用「」。
import {
  CopyOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useState } from 'react';

import {
  FieldRow,
  LimitField,
  OrderField,
  PreviewLayersFields,
  ScopeFields,
  ScopeSwitch,
  useScopeSwitch,
} from './components/Fields';
import {
  EMPTY_SCENE_FULL,
  RecordDrawer,
  type RecordRef,
} from './components/RecordDrawer';
import {
  L0View,
  L1View,
  L2View,
  L3View,
  PromptView,
} from './components/ResultViews';
import type {
  ConversationRecord,
  FactRecord,
  L3QueryResponse,
  MemoryRetrievalPrompt,
  Pagination,
  SceneDetail,
  SceneSummary,
  ScopeKind,
} from './data';
import {
  previewMemoryContext,
  queryMemoryL0,
  queryMemoryL1,
  queryMemoryL2,
  queryMemoryL2Detail,
  queryMemoryL3,
} from './service';
import { useStyles } from './style';
import {
  type AggregateInput,
  buildAggregateRequest,
  buildL0QueryRequest,
  buildL1QueryRequest,
  buildL2DetailRequest,
  buildL2QueryRequest,
  buildL3Request,
  canLoadMore,
  DEFAULT_L0_INPUT,
  DEFAULT_L1_INPUT,
  DEFAULT_L2_INPUT,
  DEFAULT_PREVIEW_LAYERS,
  DEFAULT_PREVIEW_LIMITS,
  DEFAULT_TARGET_INPUT,
  describeRequestError,
  FACT_TYPE_OPTIONS,
  L0_ORDERS,
  type L0Input,
  L1_ORDERS,
  type L1Input,
  L2_ORDERS,
  type L2Input,
  layerUnavailableForTarget,
  listSignature,
  orderWarning,
  QUERY_LIMITS,
  type ScopeInput,
  type TargetInput,
  validateAggregateInput,
  validateLimit,
  validatePriority,
  validateTarget,
} from './utils';

type TabKey = 'aggregate' | 'l0' | 'l1' | 'l2' | 'l3';

/** 三个"浏览"端点（游标分页 + 卡片流）。 */
const LIST_TABS = ['l0', 'l1', 'l2'] as const;
type ListTab = (typeof LIST_TABS)[number];

function isListTab(tab: TabKey): tab is ListTab {
  return (LIST_TABS as readonly string[]).includes(tab);
}

interface TabMeta {
  key: TabKey;
  tab: string;
  endpoint: string;
  operationId: string;
  summary: string;
}

const TABS: TabMeta[] = [
  {
    key: 'aggregate',
    tab: '汇总组装',
    endpoint: 'POST /memory/retrieval',
    operationId: 'retrieveMemory',
    summary: '',
  },
  {
    key: 'l0',
    tab: 'L0 消息原文',
    endpoint: 'POST /memory/query/l0',
    operationId: 'queryMemoryL0',
    summary: '分页浏览已保存的原始消息（完整正文）—— 浏览，不是召回。',
  },
  {
    key: 'l1',
    tab: 'L1 原子记忆',
    endpoint: 'POST /memory/query/l1',
    operationId: 'queryMemoryL1',
    summary: '分页浏览已保存的原子记忆 —— 正文整条返回、不截断。',
  },
  {
    key: 'l2',
    tab: 'L2 场景',
    endpoint: 'POST /memory/query/l2',
    operationId: 'queryMemoryL2',
    summary:
      '分页列出场景索引（filename + summary + heat）—— 点某张卡在右侧抽屉看全文。',
  },
  {
    key: 'l3',
    tab: 'L3 画像',
    endpoint: 'POST /memory/query/l3',
    operationId: 'queryMemoryL3',
    summary: '取该 scope 的画像 —— 一个 scope 只有一篇，是取而不是查。',
  },
];

/**
 * 一个 tab 的运行状态。
 *
 * ⚠️ 列表 tab（L0/L1/L2）与单发 tab（汇总 / L3）共用这一个形状：
 *    列表那边 `items` 是**累积**的（卡片流 + 加载更多），`page`/`signature`
 *    才是有意义的；单发那边只用到 `result`。共用是为了让"切回来还能看到上一次
 *    的结果"这件事在每个 tab 上是同一套代码。
 */
interface TabRun {
  loading: boolean;
  /** 只在"加载更多"时为 true —— 与整页刷新区分开，按钮上只看这个。 */
  loadingMore: boolean;
  error: string | null;
  elapsed: number | null;
  /** 最近一次响应（列表 tab 上是最后一页的响应 —— 拿它的 scope_kind）。 */
  result: unknown;
  /** 列表 tab 累积的条目。 */
  items: unknown[];
  /** 列表 tab 最近一页的翻页信息。 */
  page: Pagination | null;
  /**
   * 上一次"执行"时那套筛选的签名（`listSignature`，不含游标）。
   * 与当前不一致 → 筛选改过 → 不许再往这条流里追加。
   */
  signature: string | null;
}

const EMPTY_RUN: TabRun = {
  loading: false,
  loadingMore: false,
  error: null,
  elapsed: null,
  result: null,
  items: [],
  page: null,
  signature: null,
};

/**
 * 右侧抽屉正在看的那一条。
 *
 * ⚠️ `opened` 用判别联合而不是 `{ filename, loading, ... }` 一张平表（2026-10-12 改）：
 *    L1 与 L2 的全文**来源不同** —— L1 的浏览端点本来就给了完整正文（不用再请
 *    求），L2 的索引里没有正文、必须再走一趟 `/query/l2/detail`。平表里"这次要不要
 *    发请求"只能靠"filename 空不空"去推，而"打开了但还没取到"和"没打开"两种形态会
 *    共用同一个空串。分开之后这件事在类型上就定死了。
 */
interface DetailState {
  opened: RecordRef | null;
  loading: boolean;
  error: string | null;
  /** ⚠️ 存的是抽出来的 scene，不是整个响应 —— 抽屉只需要它（scope_kind 有别的来源）。 */
  data: SceneDetail | null;
}

const EMPTY_DETAIL: DetailState = {
  opened: null,
  loading: false,
  error: null,
  data: null,
};

const MemoryRetrievalPage: React.FC = () => {
  const { styles } = useStyles();

  const [tab, setTab] = useState<TabKey>('aggregate');

  /** target + session_id：六个接口共用（只有 L0 还吃 session_id）。 */
  /**
   * ⚠️ 初始值是 `DEFAULT_TARGET_INPUT`（不是 `EMPTY_TARGET_INPUT`）：归属留空、
   *    `agent_id` 给上唯一那个候选。重置按钮恢复的也是它 —— "刚打开的样子"
   *    与"什么都没选"是两回事。
   */
  const [target, setTarget] = useState<TargetInput>(DEFAULT_TARGET_INPUT);
  const [sessionId, setSessionId] = useState('');

  /**
   * 「个人 / 团队」开关的 state。
   *
   * ⚠️ 它**必须**在这（页面层）：开关渲染在左侧那张卡的**卡头**（与右上角的端点
   *    Tag 同一行），而它控制的参数控件在卡体里 —— 两处不在同一个 DOM 位置，
   *    藏在组件内部就传不过去。逻辑本身在 `useScopeSwitch` 里（页面与单测共用）。
   */
  const {
    scope,
    change: changeScope,
    reset: resetScope,
  } = useScopeSwitch(target, setTarget);

  const [agg, setAgg] = useState<AggregateInput>(() => ({
    input: '',
    retrieve: { ...DEFAULT_PREVIEW_LAYERS },
    limits: { ...DEFAULT_PREVIEW_LIMITS },
  }));
  // ⚠️ roles 是数组，必须给出**新数组**（直接展开 DEFAULT_* 会共享同一个引用）。
  const [l0, setL0] = useState<L0Input>(() => ({
    ...DEFAULT_L0_INPUT,
    roles: [],
  }));
  const [l1, setL1] = useState<L1Input>(() => ({ ...DEFAULT_L1_INPUT }));
  const [l2, setL2] = useState<L2Input>(() => ({ ...DEFAULT_L2_INPUT }));

  /** 结果按 tab 分开存：切回来还能看到上一次的结果，比每次清空好用。 */
  const [runs, setRuns] = useState<Partial<Record<TabKey, TabRun>>>({});

  /**
   * L1 / L2 表格点某一行拉起来的右侧抽屉。
   *
   * ⚠️ 整页**只有一个**抽屉实例：同一时刻只可能有一篇正在看的全文，两个列表共用它。
   */
  const [detail, setDetail] = useState<DetailState>(EMPTY_DETAIL);

  const meta = TABS.find((item) => item.key === tab) ?? TABS[0];
  const run = runs[tab] ?? EMPTY_RUN;

  const patchAgg = (part: Partial<AggregateInput>) =>
    setAgg((prev) => ({ ...prev, ...part }));
  const patchL0 = (part: Partial<L0Input>) =>
    setL0((prev) => ({ ...prev, ...part }));
  const patchL1 = (part: Partial<L1Input>) =>
    setL1((prev) => ({ ...prev, ...part }));
  const patchL2 = (part: Partial<L2Input>) =>
    setL2((prev) => ({ ...prev, ...part }));

  /**
   * 页面参数 -> 请求体。构造规则全在 utils 的 `buildXxxQueryRequest` 里（可单测）。
   *
   * `cursor` 只对列表 tab 有意义：首页传 null（＝不传），"加载更多"传上一页的
   * `next_cursor`。其余 tab 忽略它。
   */
  const buildBody = (cursor: string | null) => {
    switch (tab) {
      case 'l0':
        return buildL0QueryRequest(
          { target, session_id: sessionId } satisfies ScopeInput,
          l0,
          cursor,
        );
      case 'l1':
        return buildL1QueryRequest(target, l1, cursor);
      case 'l2':
        return buildL2QueryRequest(target, l2, cursor);
      case 'l3':
        return buildL3Request(target);
      default:
        return buildAggregateRequest(target, agg);
    }
  };

  /** 首页请求体 —— 请求体预览展示的就是它（游标只在翻页时出现，预览里不展示）。 */
  const firstPageBody = buildBody(null);
  const requestText = JSON.stringify(firstPageBody, null, 2);

  /**
   * 发起前的检查，**拦在发起处**。
   *
   * 不靠"构造请求时兜底"：构造请求是纯函数，它没资格替用户改主意。
   *   - target 的三种不合法形态（都没给 / 都给 / 缺 agent_id）必然 400；
   *   - **汇总的 `input` 为空必然 400**（v2.1.0 起它是 required + minLength 1，
   *     因为 L0/L1 打开后要拿它当召回查询串）；
   *   - **团队 target 调 L0/L1 查询必然 400**（契约的能力缺口）—— 这条尤其要在前端拦：
   *     它是一个"参数看上去完全合理"的请求；
   *   - limit / priority 越界后端也是 400；
   *   - L2 列表里的 filename 天然来自返回体，不会手打，所以没有"文件名"这一档校验。
   * 汇总端点在团队 target 下**不拦**：它不整单 400，那两层进 `degraded`。
   */
  const preflight = (): string | null => {
    const targetIssue = validateTarget(target);
    if (targetIssue) return targetIssue;

    if (tab === 'aggregate') return validateAggregateInput(agg.input);
    if (tab === 'l0') {
      if (layerUnavailableForTarget('l0', target)) {
        return '团队 target 下 L0 查询今天不可用 —— memory_atom / agent_message 里 org_id 只是元数据，这一层的过滤维度只有 session_id 与 user_id，所以契约明说团队 scope 调它直接 400。要看团队 scope 的场景与画像，用 L2 / L3 那两个 tab。';
      }
      return validateLimit(l0.limit, 'l0');
    }
    if (tab === 'l1') {
      if (layerUnavailableForTarget('l1', target)) {
        return '团队 target 下 L1 查询今天不可用 —— 同 L0，契约明说直接 400。要看团队 scope 的场景与画像，用 L2 / L3 那两个 tab。';
      }
      return validateLimit(l1.limit, 'l1') ?? validatePriority(l1.priority);
    }
    if (tab === 'l2') return validateLimit(l2.limit, 'l2');
    return null;
  };

  const submit = async () => {
    const activeTab = tab;
    const problem = preflight();
    if (problem) {
      setRuns((prev) => ({
        ...prev,
        [activeTab]: {
          ...(prev[activeTab] ?? EMPTY_RUN),
          loading: false,
          loadingMore: false,
          error: problem,
        },
      }));
      return;
    }

    const body = firstPageBody;
    setRuns((prev) => ({
      ...prev,
      [activeTab]: { ...EMPTY_RUN, loading: true },
    }));

    const started = performance.now();
    try {
      const result = await callEndpoint(activeTab, body);
      const list = isListTab(activeTab)
        ? (result as { items: unknown[]; page: Pagination })
        : null;
      setRuns((prev) => ({
        ...prev,
        [activeTab]: {
          loading: false,
          loadingMore: false,
          error: null,
          elapsed: Math.round(performance.now() - started),
          result,
          // 重新执行 = 从第一页重新累积（旧的那些条目属于旧的筛选，不保留）
          items: list ? list.items : [],
          page: list ? list.page : null,
          signature: listSignature(body),
        },
      }));
    } catch (error) {
      setRuns((prev) => ({
        ...prev,
        [activeTab]: {
          ...EMPTY_RUN,
          error: describeRequestError(error),
          elapsed: Math.round(performance.now() - started),
        },
      }));
    }
  };

  /**
   * 加载更多：拿**上一页的 `next_cursor`** 再要一页，把条目追加到已有的流后面。
   *
   * 两道门都必须过：
   *   1. `has_more` 为真（不是看 `next_cursor` 有没有值）；
   *   2. **当前筛选与发起时一致** —— 游标绑死在旧筛选上，拿它配新筛选要回来的
   *      是"另一套条件"的第二页。
   */
  const loadMore = async () => {
    const activeTab = tab;
    const current = runs[activeTab];
    if (!isListTab(activeTab) || !current) return;

    const cursor = current.page?.next_cursor ?? null;
    if (!canLoadMore(current.page) || !cursor) return;
    if (current.signature !== listSignature(firstPageBody)) return;

    setRuns((prev) => ({
      ...prev,
      [activeTab]: {
        ...(prev[activeTab] ?? EMPTY_RUN),
        loadingMore: true,
        error: null,
      },
    }));

    const started = performance.now();
    try {
      const result = await callEndpoint(activeTab, buildBody(cursor));
      const page = result as { items: unknown[]; page: Pagination };
      setRuns((prev) => {
        const before = prev[activeTab] ?? EMPTY_RUN;
        return {
          ...prev,
          [activeTab]: {
            ...before,
            loadingMore: false,
            error: null,
            elapsed: Math.round(performance.now() - started),
            result,
            items: [...before.items, ...page.items],
            page: page.page,
          },
        };
      });
    } catch (error) {
      setRuns((prev) => ({
        ...prev,
        [activeTab]: {
          ...(prev[activeTab] ?? EMPTY_RUN),
          loadingMore: false,
          error: describeRequestError(error),
        },
      }));
    }
  };

  /**
   * 页面级「重置」= **把这一页恢复成刚打开的样子**。
   *
   * ⚠️ 2026-10-12 用户报「右上角重置按钮点了没反应」。查过：按钮本身是好的
   *    （探针里命中测试通过、点击确实清掉了那一 tab 的参数与结果）。真正的问题是
   *    **它的作用域比用户预期小** —— 上一版只重置"当前 tab 的查询参数 + 结果"，
   *    于是「查谁的记忆」（target / session_id）原封不动；而这一页的用户心智恰恰是
   *    "重置这页"（按钮在**页面级**的 extra 上，不在任何 tab 或卡片里）。
   *    只清一部分 = 在最常见的那次点击里什么都不变 → 读起来就是"点了没反应"。
   *
   * 所以现在四样一起清：target（含开关档位）、session_id、五个 tab 的参数、全部结果。
   * ⚠️ target 恢复的是 `DEFAULT_TARGET_INPUT` —— 归属为空、`agent_id` 回到默认那个
   *    候选。它与 `EMPTY_TARGET_INPUT` 的差别就是"刚打开的样子"与"什么都没选"。
   * 按钮上的 tooltip 把这件事说死，免得又被读成"只重置当前 tab"。
   */
  const resetTab = () => {
    resetScope();
    setTarget({ ...DEFAULT_TARGET_INPUT });
    setSessionId('');
    setAgg({
      input: '',
      retrieve: { ...DEFAULT_PREVIEW_LAYERS },
      limits: { ...DEFAULT_PREVIEW_LIMITS },
    });
    setL0({ ...DEFAULT_L0_INPUT, roles: [] });
    setL1({ ...DEFAULT_L1_INPUT });
    setL2({ ...DEFAULT_L2_INPUT });
    setRuns({});
    setDetail(EMPTY_DETAIL);
  };

  /** 从 L2 网格点某张卡 —— 拉单篇场景全文，塞进抽屉（索引里没有正文）。 */
  /**
   * L1：点一张卡 -> 抽屉。**不发请求** —— `/query/l1` 返回的就是完整正文，
   * 再拉一次只会多一次 404 的机会（merge 之后 record_id 会变，用旧 id 去查是错的）。
   */
  const openFact = (record: FactRecord) => {
    /*
      ⚠️ L1 那一侧没有"正在取全文"这件事 —— `SceneFullState` 三态必须全部回到空档
      （`EMPTY_SCENE_FULL` 就是这份默认值）。不重置的话，上一次看 L2 留下的
      loading / error 会挂在 L1 的抽屉上（抽屉内容由 `kind` 选，但手一抖撸进去就看出来了）。
    */
    setDetail({ opened: { kind: 'fact', record }, ...EMPTY_SCENE_FULL });
  };

  /**
   * L2：点一张卡 -> 抽屉，**这一趟必须发请求** —— `SceneSummary` 里没有正文。
   */
  const openScene = async (item: SceneSummary) => {
    const filename = item.filename;
    const reqTarget = target;
    setDetail({
      opened: { kind: 'scene', filename },
      loading: true,
      error: null,
      data: null,
    });
    try {
      const res = await queryMemoryL2Detail(
        buildL2DetailRequest(reqTarget, filename),
      );
      setDetail((prev) =>
        prev.opened?.kind === 'scene' && prev.opened.filename === filename
          ? { ...prev, loading: false, data: res.scene }
          : prev,
      );
    } catch (error) {
      setDetail((prev) =>
        prev.opened?.kind === 'scene' && prev.opened.filename === filename
          ? { ...prev, loading: false, error: describeRequestError(error) }
          : prev,
      );
    }
  };

  const disabled = run.loading || run.loadingMore;
  const teamTarget = target.team_id.trim() !== '';
  /** L0/L1 吃 session_id；L2/L3 与详情都不看它，所以那些 tab 不画这个输入框。 */
  const showSession = tab === 'aggregate' || tab === 'l0';

  /** 列表 tab：筛选改过之后，已加载的那条流就不再是可续的了。 */
  const stale = isListTab(tab)
    ? run.signature !== null && run.signature !== listSignature(firstPageBody)
    : false;

  // ------------------------------------------------------------ 参数卡片

  const paramsCard = () => {
    if (tab === 'aggregate') {
      return (
        <Card
          size="small"
          /* input 已经挪到上面那张卡的第一条，这里只剩「要展示的层」，
             标题不能再写「本轮输入与…」，否则会指着一个不在这儿的字段。 */
          title="要展示的层"
          extra={<Tag>{meta.operationId}</Tag>}
        >
          <PreviewLayersFields
            retrieve={agg.retrieve}
            limits={agg.limits}
            onRetrieveChange={(retrieve) => patchAgg({ retrieve })}
            onLimitsChange={(limits) => patchAgg({ limits })}
            disabled={disabled}
          />
        </Card>
      );
    }

    if (tab === 'l0') {
      return (
        <Card
          size="small"
          title="L0 浏览参数"
          extra={<Tag>{meta.operationId}</Tag>}
        >
          <FieldRow
            label="text_contains"
            hint={
              <>
                ⚠️ <b>字面包含</b>，不是语义检索（契约原话）。想要「意思相近」
                这一层给不了 —— 那是 Agent 工具的活。留空 = 不筛。
              </>
            }
          >
            <Input
              value={l0.text_contains}
              disabled={disabled}
              allowClear
              placeholder="留空 = 不筛（这一层按 order 排）"
              onChange={(e) => patchL0({ text_contains: e.target.value })}
            />
          </FieldRow>

          <FieldRow
            label="roles"
            hint={
              <>
                限定消息角色。不选 = 两种都要（「我说过什么」与「你说过什么」
                都是正当问题）。
              </>
            }
          >
            <Select
              mode="multiple"
              allowClear
              value={l0.roles}
              disabled={disabled}
              style={{ width: '100%' }}
              placeholder="不选 = user 与 assistant 都要"
              onChange={(roles) => patchL0({ roles })}
              options={[
                { value: 'user', label: 'user · 用户说过的' },
                { value: 'assistant', label: 'assistant · 助手说过的' },
              ]}
            />
          </FieldRow>

          <FieldRow
            label="时间区间"
            hint="按 created_at（记录时间，不是正文里提到的时间）。两端都是闭区间。"
          >
            <DatePicker.RangePicker
              showTime
              style={{ width: '100%' }}
              disabled={disabled}
              // ⚠️ 必须给 allowEmpty：刷新期间 `disabled` 为真、而这两端本来就可以
              //    是空的（空 = 不筛），rc-picker 会在开发态打一条
              //    "`disabled` should not set with empty `value`" 的告警。
              //    给上 [true,true] 正是我们想要的语义：两端都可以空着。
              allowEmpty={[true, true]}
              value={
                l0.time_from && l0.time_to
                  ? [dayjs(l0.time_from), dayjs(l0.time_to)]
                  : null
              }
              onChange={(dates) =>
                patchL0({
                  time_from: dates?.[0]?.toISOString() ?? null,
                  time_to: dates?.[1]?.toISOString() ?? null,
                })
              }
            />
          </FieldRow>

          <FieldRow
            label="order"
            hint="排序键。翻页沿它切，所以改它等于换一套结果。"
          >
            <OrderField
              value={l0.order}
              options={L0_ORDERS}
              disabled={disabled}
              onChange={(order) => patchL0({ order })}
            />
          </FieldRow>
          {orderWarning(l0.order, Boolean(sessionId.trim())) ? (
            <div className={styles.hint} style={{ marginTop: 4 }}>
              ⚠️ {orderWarning(l0.order, Boolean(sessionId.trim()))}
            </div>
          ) : null}

          <FieldRow
            label="limit"
            hint={`一页几条（不是"召回深度"）—— ${QUERY_LIMITS.l0.note}`}
          >
            <LimitField
              value={l0.limit}
              min={QUERY_LIMITS.l0.min}
              max={QUERY_LIMITS.l0.max}
              disabled={disabled}
              suffix="条 / 页"
              onChange={(limit) => patchL0({ limit })}
            />
          </FieldRow>

          <div className={styles.hint} style={{ marginTop: 8 }}>
            ⚠️ 给了 <code>session_id</code> 但那个会话<b>不存在</b>时是{' '}
            <b>404</b>
            （不是空列表）。
          </div>
        </Card>
      );
    }

    if (tab === 'l1') {
      return (
        <Card
          size="small"
          title="L1 浏览参数"
          extra={<Tag>{meta.operationId}</Tag>}
        >
          <FieldRow
            label="type"
            hint={
              <>
                精确匹配记忆类型。契约明说它<b>不是枚举</b>（词表会长）→
                可以自由输入，认不出的值后端就按原样精确匹配。
              </>
            }
          >
            <AutoComplete
              value={l1.type}
              disabled={disabled}
              allowClear
              style={{ width: '100%' }}
              placeholder="不填 = 全部类型"
              options={FACT_TYPE_OPTIONS.map((value) => ({ value }))}
              onChange={(value) => patchL1({ type: value ?? '' })}
            />
          </FieldRow>

          <FieldRow
            label="priority"
            hint={
              <>
                精确匹配优先级。<b>-1 = 全局死命令</b>（不是「最低」）， 普通值
                0-100。留空 = 不筛。
              </>
            }
          >
            <InputNumber
              value={l1.priority}
              min={-1}
              max={100}
              step={1}
              style={{ width: 140 }}
              disabled={disabled}
              placeholder="留空 = 不筛"
              onChange={(next) =>
                patchL1({
                  priority: next === null ? null : Math.floor(Number(next)),
                })
              }
            />
          </FieldRow>

          <FieldRow
            label="scene_name"
            hint="精确匹配所属场景名（与 L2 的 filename 同源）。"
          >
            <Input
              value={l1.scene_name}
              disabled={disabled}
              allowClear
              placeholder="留空 = 不筛"
              onChange={(e) => patchL1({ scene_name: e.target.value })}
            />
          </FieldRow>

          <FieldRow
            label="更新时间"
            hint="按 updated_at（写入/合并时间）。两端闭区间。"
          >
            <DatePicker.RangePicker
              showTime
              style={{ width: '100%' }}
              disabled={disabled}
              // 同上面 L0 那条：空区间是正常的，给上 allowEmpty 免得开发态刷告警
              allowEmpty={[true, true]}
              value={
                l1.updated_from && l1.updated_to
                  ? [dayjs(l1.updated_from), dayjs(l1.updated_to)]
                  : null
              }
              onChange={(dates) =>
                patchL1({
                  updated_from: dates?.[0]?.toISOString() ?? null,
                  updated_to: dates?.[1]?.toISOString() ?? null,
                })
              }
            />
          </FieldRow>

          <FieldRow
            label="text_contains"
            hint="记忆正文字面包含（不是语义召回）。留空 = 不筛。"
          >
            <Input
              value={l1.text_contains}
              disabled={disabled}
              allowClear
              placeholder="留空 = 不筛"
              onChange={(e) => patchL1({ text_contains: e.target.value })}
            />
          </FieldRow>

          <FieldRow
            label="order"
            hint="优先级排序与 updated_at 排序是两套口径。"
          >
            <OrderField
              value={l1.order}
              options={L1_ORDERS}
              disabled={disabled}
              onChange={(order) => patchL1({ order })}
            />
          </FieldRow>

          <FieldRow label="limit" hint={`一页几条 —— ${QUERY_LIMITS.l1.note}`}>
            <LimitField
              value={l1.limit}
              min={QUERY_LIMITS.l1.min}
              max={QUERY_LIMITS.l1.max}
              disabled={disabled}
              suffix="条 / 页"
              onChange={(limit) => patchL1({ limit })}
            />
          </FieldRow>
        </Card>
      );
    }

    if (tab === 'l2') {
      return (
        <Card
          size="small"
          title="L2 浏览参数"
          extra={<Tag>{meta.operationId}</Tag>}
        >
          <FieldRow
            label="filename_contains"
            hint={
              <>
                只筛<b>文件名</b>（v2 不再提供按内容筛选）。留空 = 不筛。
              </>
            }
          >
            <Input
              value={l2.filename_contains}
              disabled={disabled}
              allowClear
              placeholder="留空 = 列出该 scope 的全部场景"
              onChange={(e) => patchL2({ filename_contains: e.target.value })}
            />
          </FieldRow>

          <FieldRow label="order" hint="默认最近更新在前；也可以按文件名排。">
            <OrderField
              value={l2.order}
              options={L2_ORDERS}
              disabled={disabled}
              onChange={(order) => patchL2({ order })}
            />
          </FieldRow>

          <FieldRow label="limit" hint={`一页几篇 —— ${QUERY_LIMITS.l2.note}`}>
            <LimitField
              value={l2.limit}
              min={QUERY_LIMITS.l2.min}
              max={QUERY_LIMITS.l2.max}
              disabled={disabled}
              suffix="篇 / 页"
              onChange={(limit) => patchL2({ limit })}
            />
          </FieldRow>
        </Card>
      );
    }

    return (
      <Card size="small" title="L3 参数" extra={<Tag>{meta.operationId}</Tag>}>
        <div className={styles.hint}>
          这一个接口<b>只有 target</b> —— 一个 scope
          只有一篇画像（persona.md），
          所以是「取」而不是「查」，没有任何查询参数。
          <br />
          ⚠️ 没有画像是<b>正常状态</b>：<code>persona: null</code> 表示这个 scope
          还没生成过，<b>不是 404</b>（与「scope 不存在」不同 ——
          管理员视图下压根不判 scope 是否存在）。
        </div>
      </Card>
    );
  };

  // ------------------------------------------------------------ 结果卡片

  const resultCard = () => {
    const result = run.result;
    const scopeKind = (result as { scope_kind?: ScopeKind } | null)?.scope_kind;

    const body = () => {
      if (run.error) {
        return (
          <Alert
            type="error"
            showIcon
            className={styles.alertGap}
            title="请求失败"
            description={run.error}
          />
        );
      }
      if (!result) {
        return (
          <div className={styles.emptyBox}>
            <Typography.Text type="secondary">
              尚未执行{meta.summary ? ` —— ${meta.summary}` : ''}
            </Typography.Text>
          </div>
        );
      }
      if (tab === 'aggregate') {
        return <PromptView data={result as MemoryRetrievalPrompt} />;
      }
      if (tab === 'l0') {
        return (
          <L0View
            items={run.items as ConversationRecord[]}
            page={run.page}
            loadingMore={run.loadingMore}
            onLoadMore={loadMore}
            stale={stale}
          />
        );
      }
      if (tab === 'l1') {
        return (
          <L1View
            items={run.items as FactRecord[]}
            page={run.page}
            loadingMore={run.loadingMore}
            onLoadMore={loadMore}
            onOpenFull={openFact}
            stale={stale}
          />
        );
      }
      if (tab === 'l2') {
        return (
          <L2View
            items={run.items as SceneSummary[]}
            page={run.page}
            loadingMore={run.loadingMore}
            onLoadMore={loadMore}
            onOpenFull={(item) => void openScene(item)}
            stale={stale}
          />
        );
      }
      return <L3View data={result as L3QueryResponse} />;
    };

    return (
      <Card
        size="small"
        /**
         * ⚠️ 2026-10-12 用户要求：scope 直接跟在「结果」后面。
         *
         * 这一枚 Tag 原来在**结果体**里（列表头那个灰底盒子的第一行），要滚到内容
         * 区才看得到；而它回答的是"这次返回的是谁的记忆"—— 属于**这次结果的身份**，
         * 放在卡头与「结果」同排才对（与「20 ms」分列两端）。
         * 于是列表头 / L3 / 汇总三处各自那枚 scope Tag 一起撤掉 —— 同一份信息
         * **只留一个来源**，标题行就是它。
         */
        title={
          <Space size={8}>
            <span>结果</span>
            {scopeKind ? (
              <Tag color={scopeKind === 'team' ? 'green' : 'blue'}>
                scope_kind · {scopeKind}
              </Tag>
            ) : null}
          </Space>
        }
        extra={
          run.elapsed !== null ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {run.elapsed} ms
            </Typography.Text>
          ) : null
        }
      >
        {body()}
      </Card>
    );
  };

  return (
    <PageContainer
      title="记忆浏览与组装（管理员视图）"
      content={
        <div className={styles.roleNote} style={{ maxWidth: 900 }}>
          v2 之后这一组端点分成两件事：<b>汇总组装</b>
          （把 L3 画像与 L2 场景索引按 prompt 顺序拼出一份预览）， 以及四个
          <b>单层端点</b>（L0/L1/L2 是<b>分页浏览已保存的记录</b>， L3
          是取画像）。 ⚠️ L0/L1 已经<b>不是检索</b>了 ——
          它们只按字面包含与排序键翻页，没有相关性打分。
          <br />
          ⚠️ 本组端点<b>全部</b>要求调用者持有 <code>Y-Trader-Admin</code>{' '}
          角色（够格的调用方能读任何人，所以越权是 <b>403 而不是 404</b>）。
          本地把鉴权开关关掉时，bypass 身份里的 roles 是<b>刻意留空</b>的 ——
          所以本地调它<b>必然 403</b>，别把它当成「后端没起」。要真调通得用真
          token。
        </div>
      }
      extra={[
        <Tooltip
          key="reset-tip"
          title="把这一页恢复成刚打开的样子：查谁的记忆、会话、五个 tab 的参数与结果一起清空"
        >
          <Button
            key="reset"
            icon={<ReloadOutlined />}
            onClick={resetTab}
            disabled={disabled}
          >
            重置
          </Button>
        </Tooltip>,
      ]}
      tabList={TABS.map((item) => ({ tab: item.tab, key: item.key }))}
      tabActiveKey={tab}
      onTabChange={(key) => setTab(key as TabKey)}
    >
      <div className={styles.layout}>
        {/* ==================== 左：查询条件 ==================== */}
        <div className={styles.column}>
          {/*
            ⚠️ 卡头左边是「个人 / 团队」开关，右边是端点 Tag —— 用户要求两者并排。
            开关的 state 在页面上（见 useScopeSwitch），因为它管的参数控件在卡体里。
          */}
          <Card
            size="small"
            title={
              <ScopeSwitch
                scope={scope}
                onChange={changeScope}
                disabled={disabled}
              />
            }
            extra={<Tag>{meta.endpoint}</Tag>}
          >
            {/*
              两块内容放进同一个 `column`（flex + gap），间距才和 ScopeFields 内部
              的行距一致；直接并排会紧贴在一起。
            */}
            <div className={styles.column}>
              {/*
                `input` = 「这一轮用户会说什么」，原先长在第二张卡里。它是这次
                组装能不能成立的前提（汇总端点里必填），所以提到**最上面这张卡的
                第一条** —— 先写问题、再选查谁的记忆。其它 tab 没有这个字段
                （L0/L1 只按字面翻页、L2/L3 取现成的），整行不渲染。
              */}
              {tab === 'aggregate' ? (
                <FieldRow label="input（必填）">
                  <Input.TextArea
                    rows={2}
                    value={agg.input}
                    disabled={disabled}
                    placeholder="这轮用户会说什么？例如：帮我把上季度的对账单整理一下"
                    onChange={(e) => patchAgg({ input: e.target.value })}
                  />
                </FieldRow>
              ) : null}

              <ScopeFields
                target={target}
                scope={scope}
                sessionId={sessionId}
                onTargetChange={setTarget}
                onSessionChange={setSessionId}
                showSession={showSession}
                disabled={disabled}
              />
            </div>
            {teamTarget && (tab === 'l0' || tab === 'l1') ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                title="团队 target 下这一层查不了"
                description="L0/L1 不支持 team 过滤，请换 L2/L3 或个人 scope"
              />
            ) : null}

            {/*
              执行按钮：这张卡的**右下角**。参数填完就在原地提交 ——
              原来它挂在最下面「请求体预览」里（还是 `space-between` 顶到左边），
              填完参数得往下滚两张卡才找得到。
            */}
            <div className={styles.cardActions}>
              <Button
                type="primary"
                icon={<SearchOutlined />}
                loading={run.loading}
                onClick={submit}
              >
                执行
              </Button>
            </div>
          </Card>

          {paramsCard()}

          <Card
            size="small"
            title="请求体预览"
            extra={
              <Button
                type="link"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => navigator.clipboard?.writeText(requestText)}
              >
                复制
              </Button>
            }
          >
            {/* 执行按钮已挪到最上面那张参数卡的右下角 —— 这张卡只负责"看一眼要发什么"。 */}
            <pre className={styles.requestPreview}>{requestText}</pre>
          </Card>
        </div>

        {/* ==================== 右：结果 ==================== */}
        <div className={styles.column}>{resultCard()}</div>
      </div>

      {/*
        L1 / L2 点卡片拉起来的右侧抽屉 —— 正文只有一个入口，就在这里落一次。
        ⚠️ 两条列表共用**这一个**实例：同一时刻只可能有一篇正在看的全文。
      */}
      <RecordDrawer
        opened={detail.opened}
        scene={detail}
        onClose={() => setDetail(EMPTY_DETAIL)}
      />
    </PageContainer>
  );
};

/** 按 tab 分派到对应的 service 函数（集中一处，避免几处 if 散在组件里）。 */
async function callEndpoint(tab: TabKey, body: unknown): Promise<unknown> {
  switch (tab) {
    case 'l0':
      return queryMemoryL0(body as Parameters<typeof queryMemoryL0>[0]);
    case 'l1':
      return queryMemoryL1(body as Parameters<typeof queryMemoryL1>[0]);
    case 'l2':
      return queryMemoryL2(body as Parameters<typeof queryMemoryL2>[0]);
    case 'l3':
      return queryMemoryL3(body as Parameters<typeof queryMemoryL3>[0]);
    default:
      return previewMemoryContext(
        body as Parameters<typeof previewMemoryContext>[0],
      );
  }
}

export default MemoryRetrievalPage;
