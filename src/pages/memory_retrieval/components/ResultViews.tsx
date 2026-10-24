// src/pages/memory_retrieval/components/ResultViews.tsx
//
// 六个接口的响应渲染（memory_api_v2.yaml v2.1.0）。放在一个文件里是因为它们共用
// 同一批小件（分段头 / 时间 / 元信息行 / 加载更多页脚），拆开就要么复制要么再开
// 一层 barrel。
//
// 六条贯穿全文件的纪律（v2 之后重写过一遍，其中两条是新口径）：
//   1. **降级必须显示**（汇总的 degraded）。契约原话：静默少一段会被读成
//      「这个人没有画像 / 没有场景」，而那是另一个事实。
//   2. **空 items 与「这一段没要」是两件事**。关掉的层根本不出现在 sections 里；
//      出现了但 items 为空 = 要了、没命中。文案必须分开。
//   3. **⚠️ `/query/l0|l1` 是「浏览」不是「检索」**：没有 score、没有 matched_by、
//      没有"命中片段"—— 返回的是**已保存记录的完整正文**。文案里不许再出现
//      「命中」这种召回口径的词，否则会被读成"这里按相关性排过序"。
//      ⚠️ 但**汇总**的 conversations / facts 两段是**真的召回命中**（有 score 与
//      matched_by，L0 那边还是**截断片段**）—— 同一个"L0"在两处含义不同，
//      所以两套渲染组件是**故意分开**的（ConversationBody vs ConversationHitBody）。
//   4. **⚠️ L2 列表恒为索引**（SceneSummary，没有正文）—— 要全文只能走
//      `/query/l2/detail`。入口只有**点开某一张卡**（整卡就是按钮），不是"少给了"。
//   5. ⚠️ 正文分两类（2026-10-12 用户要求「所有 md 文件用专用阅读器」）：
//      · **文档**（persona.md / 场景 .md，带 META 块的 markdown 文件）→ 走
//        `MarkdownDoc`：默认阅读器模式，右上角可切「原文」（META 块只在原文里看得到）；
//      · **数据**（L0 消息原文 / L1 记忆陈述 / 拼好的 prompt）→ 继续 pre-wrap 原样显示。
//        它们不是 md 文件，按 md 渲染会把下划线、井号、星号改样。
//   6. ⚠️ 汇总的 `sections` **按 L0 -> L3 升序展示**（2026-10-12 用户要求
//      「召回记忆的顺序按照 l0 ~ l3 排序」）—— 后端返回的是 **prompt 顺序**
//      （L3 -> L2 -> L0 -> L1），必须前端重排，见 `sortSectionsByLayer`。
//   7. ⚠️ **L0 消息原文默认只显示 3 行**，点「展开全部」看全文（2026-10-12 用户要求）——
//      见 `ClampedMessageText`。只给 L0 的**浏览记录**用（L1 / 召回命中不给夹子）。
//   8. ⚠️ **L1 / L2 列表是「卡片网格」**（2026-10-12 用户要求，仿的是 file 页那个
//      「网格」视图 `pages/file/components/FileGrid.tsx`，**不是**表格的条目行）：
//      一张卡一条记录，卡上只放**缩略内容**，**点整张卡**在右侧抽屉里看全文。
//      ⚠️ 变的只是"怎么摆"，不是"怎么翻页"：条目仍然**累积**、仍然看 `has_more`
//      往下一页加（不透明游标没有页码），所以页脚那份 `ListPager` 一行都没动。
//      ⚠️ 两层的数据形态不同，卡的内容也不同：
//        · **L1** —— 浏览端点本来就给了**完整正文**，卡上第三行就是它（夹 3 行），
//          抽屉**不用再发请求**；
//        · **L2** —— 列表恒为**索引**（`SceneSummary` 没有 content），卡上放的是
//          summary，抽屉必须再走一趟 `/query/l2/detail`（找不到是 404）。
//        别为了"两张卡长得一样"给 L2 编一段正文上去 —— 那是假的。
//
// ⚠️ JSX 的文本里不能写 markdown 的星号加粗（会原样渲染出来）。要强调用 <b>，
//    引号用「」。
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ReactNode } from 'react';
import React, { useLayoutEffect, useRef, useState } from 'react';

import type {
  ConversationHit,
  ConversationRecord,
  DegradedHitRoute,
  DegradedLayer,
  FactHit,
  FactRecord,
  L3QueryResponse,
  MemoryRetrievalPrompt,
  Pagination,
  PersonaRecord,
  PromptSection,
  RecallRoute,
  SceneDetail,
  SceneSummary,
  SectionBlock,
} from '../data';
import { useStyles } from '../style';
import {
  canLoadMore,
  factTypeLabel,
  formatTime,
  fromNow,
  heatText,
  layerLabel,
  pageSummaryText,
  priorityText,
  roleLabel,
  sceneSummaryText,
  seqText,
  shortId,
  sortSectionsByLayer,
  systemPromptState,
  truncatedText,
} from '../utils';
import { MarkdownDoc } from './MarkdownDoc';

/** block -> Tag 颜色。四层在整页里保持同一套配色，切 tab 不会认错层。 */
const BLOCK_COLOR: Record<SectionBlock, string> = {
  conversations: 'blue',
  facts: 'geekblue',
  scenes: 'cyan',
  persona: 'purple',
};

/** 一条记录的元信息小格（label 与值都压暗一档，不抢正文）。 */
const MetaItem: React.FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <>
    <span>{label}：</span>
    <span>{children}</span>
  </>
);

/** 时间：正文给人看的格式，title 里挂相对时间。 */
const TimeText: React.FC<{ value: string | null | undefined }> = ({
  value,
}) => (
  <Tooltip title={fromNow(value)}>
    <span>{formatTime(value)}</span>
  </Tooltip>
);

/**
 * **顶层**降级提示：某一层整体没能参与这次组装（那一层就没有 section）。
 *
 * ⚠️ 与段内的 `degraded_routes` **不是一回事**（后者见 `DegradedRoutes`）：
 *    顶层的语义是「这一层没查成」，段内的是「这一层查成了、但其中一路挂了」。
 *    契约特地分成两个字段是刻意的 —— 合成一个的话，「向量路挂了但还是给了关键词
 *    结果」会看起来像「整层没跑成」。
 *
 * ⚠️ v2.1.0 起四种 layer 都可能出现在这里：团队 target 下开了
 *    `retrieve.l0` / `retrieve.l1` 就走这条路（那两层没有团队维度，而汇总端点
 *    不能整单 400）—— 所以别把它一律读成"后端出故障"。
 */
export const DegradedAlert: React.FC<{ layer?: DegradedLayer[] }> = ({
  layer,
}) => {
  const { styles } = useStyles();
  if (!layer?.length) return null;

  return (
    <Alert
      type="warning"
      showIcon
      className={styles.alertGap}
      title={`${layer.length} 层未参与本次组装 —— 结果可能不完整`}
      description={
        <div className={styles.degradedList}>
          {layer.map((item) => (
            <div key={`layer-${item.layer}`} className={styles.degradedItem}>
              <b>{layerLabel(item.layer)}</b>：{item.reason}
            </div>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            单层后端故障刻意不让整个请求失败 —— 能取到的部分确实可用；但不静默，
            所以在这里如实报出。
          </Typography.Text>
        </div>
      }
    />
  );
};

// ---------------------------------------------------------------- 各层记录

/**
 * 一篇画像。
 *
 * ⚠️ **只有一层盒子**（就是这个 md 编辑器），文件名只出现一次。
 *    原来这里上面还有一条「persona.md + version + 更新时间」的灰条，
 *    而正文那个 `MarkdownDoc` 自己的栏里又写了一遍文件名 —— 看起来像
 *    「一个编辑器被塞进另一张卡里」（2026-10-17 用户要求去掉这层嵌套）。
 *    现在版本 / 时间并进编辑器的那条栏（`meta`），外层灰卡在调用点一并去掉。
 *
 * ⚠️ `version` 后面的「写入侧每改写一次 +1」进了 tooltip：栏里塞不下这么长一句，
 *    但它就是这个数字的口径（不是"第几次读"），不能丢。
 */
const PersonaBody: React.FC<{ item: PersonaRecord }> = ({ item }) => {
  return (
    <MarkdownDoc
      text={item.content}
      label={item.filename}
      meta={
        /* `·` 是分隔符：文件名与版本挨着放（原来靠紫色 Tag 撑开），
           少了它读起来像 "persona.md version 0" 一个整体。 */
        <Space size={6} wrap separator="·">
          <Tooltip title="写入侧每改写一次 +1（不是读取次数）">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              version {item.version}
            </Typography.Text>
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <TimeText value={item.updated_at} />
          </Typography.Text>
        </Space>
      }
    />
  );
};

/**
 * 一条场景**索引**（一张灰底卡，**只给汇总的 scenes 段用**）。
 *
 * ⚠️ `onOpen` 在 2026-10-12 去掉了：L2 列表改成卡片网格之后，"点开看全文"由
 *    `SceneCard` 自己（整卡是按钮）承担，这里只剩汇总端点还在用 —— 汇总是一次性的
 *    组装预览，本来就不该从那里再拉单篇正文。
 */
const SceneBody: React.FC<{ item: SceneSummary }> = ({ item }) => {
  const { styles } = useStyles();
  return (
    <>
      <Space size={6} wrap>
        <Typography.Text strong style={{ fontFamily: 'monospace' }}>
          {item.filename}
        </Typography.Text>
        <Tag color={item.heat === null ? 'default' : 'orange'}>
          {heatText(item.heat)}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          version {item.version}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <TimeText value={item.updated_at} />
        </Typography.Text>
      </Space>
      <div className={styles.fieldHint}>{sceneSummaryText(item.summary)}</div>
    </>
  );
};

/** 场景**全文**（`/query/l2/detail`）—— 与索引的差别只有最后那段正文。 */
export const SceneDetailBody: React.FC<{ scene: SceneDetail }> = ({
  scene,
}) => {
  const { styles } = useStyles();
  return (
    <>
      <Space size={6} wrap>
        <Typography.Text strong style={{ fontFamily: 'monospace' }}>
          {scene.filename}
        </Typography.Text>
        <Tag color={scene.heat === null ? 'default' : 'orange'}>
          {heatText(scene.heat)}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          version {scene.version}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <TimeText value={scene.updated_at} />
        </Typography.Text>
      </Space>
      <div className={styles.fieldHint}>{sceneSummaryText(scene.summary)}</div>
      <MarkdownDoc text={scene.content} label="场景全文（markdown）" />
    </>
  );
};

/**
 * **L0 消息正文**：默认最多显示 N 行（3 行），超出才给「展开全部 / 收起」。
 *
 * ⚠️ 两件事必须**量**、不能猜：
 *   1. **要不要给开关** = `scrollHeight > clientHeight`。按字数猜一定错 —— 换行、
 *      中英混排、列宽都会影响行数；而短消息上挂一个「展开全部」是纯噪音。
 *   2. **展开态绝不再量**：展开后 `clientHeight` 已经等于全文高度，再量必然"不溢出" →
 *      一量就把自己的开关抹掉（开关没了 = 再也收不回去）。所以只在**收起态**量。
 *
 * ⚠️ 点击展开**只做在按钮上**，不做在正文上：这一页的用途就是**核对原文**，
 *    正文得能被正常框选复制；把整块正文做成可点，松手那一刻就会展开。
 */
const ClampedMessageText: React.FC<{ text: string; lines?: number }> = ({
  text,
  lines = 3,
}) => {
  const { styles } = useStyles();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    if (expanded) return; // 见 docstring 第 2 条：展开态量不出真话
    const el = boxRef.current;
    if (!el) return;
    // +1 是容差：clientHeight / scrollHeight 都取整，等长时可能差 1px
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [expanded, text]);

  return (
    <>
      <div
        ref={boxRef}
        data-clamped={expanded ? 'open' : 'clamped'}
        /*
          ⚠️ `data-clamp-lines` 不只是给测试看的：happy-dom **不序列化**
          `-webkit-line-clamp`（`style` 属性里读不到），所以"收起态挂的是 3 行夹子"
          这件事在单测里只能靠它来钉。真实浏览器里夹子到底有没有生效，
          由探针**量几何**（夹住后 ≈3 行高）来证。
        */
        data-clamp-lines={expanded ? undefined : lines}
        className={
          expanded
            ? `${styles.clampText} ${styles.clampTextOpen}`
            : styles.clampText
        }
        style={expanded ? undefined : { WebkitLineClamp: lines }}
      >
        {text}
      </div>
      {overflowing ? (
        <Button
          type="link"
          size="small"
          className={styles.clampToggle}
          data-clamp-toggle={expanded ? 'collapse' : 'expand'}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : `展开全部（默认只显示 ${lines} 行）`}
        </Button>
      ) : null}
    </>
  );
};

/** L0 的一条消息 —— v2 返回的是**完整正文**，不是召回命中的片段。 */
const ConversationBody: React.FC<{ item: ConversationRecord }> = ({ item }) => {
  const { styles } = useStyles();
  return (
    <>
      <div className={styles.tagRow}>
        <Tag color={item.role === 'user' ? 'blue' : 'green'}>
          {roleLabel(item.role)}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {seqText(item)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <TimeText value={item.created_at} />
        </Typography.Text>
      </div>
      <ClampedMessageText text={item.text} />
      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <MetaItem label="message_id">
            <span className={styles.mono}>{shortId(item.message_id)}</span>
          </MetaItem>
        </div>
        <div className={styles.metaItem}>
          <MetaItem label="session_id">
            <span className={styles.mono} title={item.session_id}>
              {shortId(item.session_id)}
            </span>
          </MetaItem>
        </div>
      </div>
    </>
  );
};

/**
 * 一条 L1 原子记忆的**全文**（列表的那条灰色卡没了，它现在只活在右侧抽屉里）。
 *
 * ⚠️ 2026-10-12 起 L1 列表改成表格，`content` 在格子里只显示一行省略，
 *    完整正文由右侧抽屉渲染这个组件 —— 所以这里的各部分都按"抽屉里读一篇"来排：
 *    标签行在最上、正文整段给足高度、下面才是 record_id 那几个不太看的字段。
 *
 * ⚠️ 仍然没有 score / matched_by —— `/query/l1` 是**浏览**不是召回。
 */
export const FactDetailBody: React.FC<{ record: FactRecord }> = ({
  record: item,
}) => {
  const { styles } = useStyles();
  return (
    <>
      <div className={styles.tagRow}>
        <Tag color="blue">{factTypeLabel(item.type)}</Tag>
        <Tag color={item.priority === -1 ? 'red' : 'default'}>
          {priorityText(item.priority)}
        </Tag>
        {item.priority === -1 ? (
          <Tooltip title="优先级不参与排序与过滤 —— 返回它是让调用方（尤其是模型）自己权衡。顺序只由 order 参数决定。">
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              不参与排序
            </Typography.Text>
          </Tooltip>
        ) : null}
        {item.scene_name ? <Tag>场景 {item.scene_name}</Tag> : null}
      </div>
      <div className={styles.factContent}>{item.content}</div>
      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <MetaItem label="record_id">
            <span className={styles.mono} title={item.record_id}>
              {shortId(item.record_id)}
            </span>
          </MetaItem>
        </div>
        {item.timestamp_str ? (
          <div className={styles.metaItem}>
            <MetaItem label="timestamp_str">
              <Tooltip title="提示词推出来的时间线主值，可能是「2018 年」这类半成品。不要拿它做范围过滤 —— 要么报错要么静默错。">
                {item.timestamp_str}
              </Tooltip>
            </MetaItem>
          </div>
        ) : null}
        <div className={styles.metaItem}>
          <MetaItem label="updated_at">
            <TimeText value={item.updated_at} />
          </MetaItem>
        </div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------- 召回命中（汇总的 L0/L1 段）
//
// ⚠️ 这一组**只给汇总的 conversations / facts 段用**，不要和上面的
//    ConversationBody / FactBody 混：那两套渲染的是 `/query/l0|l1` 的**浏览记录**
//    （完整正文、没有 score），这一组渲染的是**召回命中**（有 score / matched_by，
//    而且 L0 那边的 text 是**截断片段**）。同一个"L0"在两处含义不同。

const ROUTE_LABEL: Record<RecallRoute, string> = {
  keyword: '关键词路',
  vector: '向量路',
};

/** 一条命中被哪（几）路召回到。**可能两路都命中** —— 那正是融合要解决的问题。 */
const RouteTags: React.FC<{ routes: RecallRoute[] }> = ({ routes }) => {
  if (!routes.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        matched_by 为空
      </Typography.Text>
    );
  }
  return (
    <>
      {routes.map((route) => (
        <Tag key={route} color={route === 'vector' ? 'purple' : 'blue'}>
          {ROUTE_LABEL[route]}
        </Tag>
      ))}
    </>
  );
};

/**
 * 融合分。**只在本次响应内可比**（契约原话：关键词分来自 ts_rank、向量分来自
 * 余弦距离）—— 所以界面上不能说"越大越相关"就完了，必须说清这个相对性，
 * 否则用户会拿两次预览的分数互相比较。
 */
const ScoreText: React.FC<{ score: number }> = ({ score }) => (
  <Tooltip title="融合分，越大越相关。⚠️ 只在**本次响应内**可比：关键词分来自 ts_rank、向量分来自余弦距离，两次预览之间的分数没有可比性。">
    <Tag color="warning">score {score.toFixed(4)}</Tag>
  </Tooltip>
);

/**
 * 段内的**路级**降级：这一层查成了，但其中一路（关键词 / 向量）没跑成。
 *
 * ⚠️ 一定要显示 —— 契约刻意把它与顶层 `degraded` 分开，就是为了让
 *    「向量路挂了、但还是给了关键词结果」不被读成「整层没跑成」。
 */
const DegradedRoutes: React.FC<{ routes: DegradedHitRoute[] }> = ({
  routes,
}) => {
  const { styles } = useStyles();
  if (!routes.length) return null;
  return (
    <div className={styles.degradedList}>
      {routes.map((item) => (
        <div key={`route-${item.route}`} className={styles.degradedItem}>
          <b>{ROUTE_LABEL[item.route]}没跑成</b>：{item.reason}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {' '}
            —— 这一段仍然给了另一路的结果，不是整层缺失。
          </Typography.Text>
        </div>
      ))}
    </div>
  );
};

/** L0 召回的一条命中。`text` 是**片段**（400 字符），不是整条消息。 */
const ConversationHitBody: React.FC<{ item: ConversationHit }> = ({ item }) => {
  const { styles } = useStyles();
  return (
    <>
      <div className={styles.tagRow}>
        <Tag color={item.role === 'user' ? 'blue' : 'green'}>
          {roleLabel(item.role)}
        </Tag>
        <ScoreText score={item.score} />
        <RouteTags routes={item.matched_by} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {seqText(item)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <TimeText value={item.created_at} />
        </Typography.Text>
      </div>
      <div className={styles.factContent}>{item.text}</div>
      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <MetaItem label="message_id">
            <span className={styles.mono}>{shortId(item.message_id)}</span>
          </MetaItem>
        </div>
        <div className={styles.metaItem}>
          <MetaItem label="session_id">
            <span className={styles.mono} title={item.session_id}>
              {shortId(item.session_id)}
            </span>
          </MetaItem>
        </div>
      </div>
    </>
  );
};

/** L1 召回的一条命中。`content` **不截断**（与 L0 的片段相反）。 */
const FactHitBody: React.FC<{ item: FactHit }> = ({ item }) => {
  const { styles } = useStyles();
  return (
    <>
      <div className={styles.tagRow}>
        <Tag color="blue">{factTypeLabel(item.type)}</Tag>
        <Tag color={item.priority === -1 ? 'red' : 'default'}>
          {priorityText(item.priority)}
        </Tag>
        <ScoreText score={item.score} />
        <RouteTags routes={item.matched_by} />
        {item.scene_name ? <Tag>场景 {item.scene_name}</Tag> : null}
      </div>
      <div className={styles.factContent}>{item.content}</div>
      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <MetaItem label="record_id">
            <span className={styles.mono} title={item.record_id}>
              {shortId(item.record_id)}
            </span>
          </MetaItem>
        </div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------- 加载更多（列表页脚）

export interface ListPagerProps {
  /** 当前这一条流里已经累积了多少条。 */
  count: number;
  page: Pagination | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  /**
   * 筛选改过之后就不能再往这条流里追加了。
   *
   * ⚠️ 游标是**不透明**的，它绑死在"服务端当时那套筛选 + 排序"上。筛选改了却继续
   *    用旧游标，拿回来的是**另一套条件**下的第二页 —— 两页之间没有任何关系，
   *    界面上却完全看不出来。所以这里把按钮灰掉，并写清"要接着看就重新执行"。
   */
  stale?: boolean;
}

/**
 * 列表页脚：本页统计 + 「加载更多」。
 *
 * ⚠️ 有没有下一页看响应的 `has_more`，**不是** `next_cursor !== null` —— 契约把
 *    两个字段都列了，拿后者当判据在两者不一致时（服务端实现细节）会显示错。
 */
const ListPager: React.FC<ListPagerProps> = ({
  count,
  page,
  loadingMore,
  onLoadMore,
  stale,
}) => {
  const { styles } = useStyles();
  if (!page) return null;
  const more = canLoadMore(page);

  return (
    <div className={styles.listFooter}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {pageSummaryText(count, page)}
      </Typography.Text>
      {more ? (
        <Space size={8}>
          {stale ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              筛选改过了 —— 先重新执行，再从第一页往下看
            </Typography.Text>
          ) : null}
          <Button
            size="small"
            loading={loadingMore}
            disabled={stale}
            onClick={onLoadMore}
          >
            加载更多
          </Button>
        </Space>
      ) : null}
    </div>
  );
};

/**
 * 三个列表端点共用的头（已加载条数 + 一段口径说明）。
 *
 * ⚠️ 2026-10-12：原来第一行还有一枚 `scope_kind · user` 的 Tag，**已移到结果卡的
 *    卡头**（紧跟「结果」二字）。这一枚回答的是"这次返回的是谁的记忆" —— 属于
 *    结果的身份，不该埋在结果体里要滚动才看见；而且三处（列表头 / L3 / 汇总）
 *    各画一遍就是同一份信息有四个来源。现在标题行是唯一来源。
 */
const ListHead: React.FC<{
  count: number;
  note: ReactNode;
}> = ({ count, note }) => {
  const { styles } = useStyles();
  return (
    <div className={styles.listHeadBox}>
      <div className={styles.sectionHead}>
        <Tag>{`已加载 ${count} 条`}</Tag>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {note}
      </Typography.Text>
    </div>
  );
};

// ---------------------------------------------------------------- 汇总

/**
 * 一段的正文，按 block 分流（block 才是"选哪套模板"的标识，title 只是建议）。
 *
 * ⚠️ 四个分支**不是同一类东西**：persona / scenes 是"每轮都带的现成内容"，
 *    conversations / facts 是"这次真的跑了一轮召回的命中" —— 所以后者会多出
 *    段内的 `degraded_routes` 提示，前者没有。
 */
const SectionBody: React.FC<{ section: PromptSection }> = ({ section }) => {
  const { styles } = useStyles();

  const recall = section.block === 'conversations' || section.block === 'facts';

  if (section.items.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {recall
          ? '这一段是「要了但没有命中」—— 召回真跑了，只是这次没有足够相关的。'
          : '这一段是「要了但没有命中」（该层参与了组装，只是没有内容）'}
        {' ——'}
        与「这一段没要」是两件事：关掉的层根本不会出现在这个列表里。
      </Typography.Text>
    );
  }

  return (
    <>
      {section.block === 'conversations'
        ? section.items.map((item) => (
            <div key={item.message_id} className={styles.recordItem}>
              <ConversationHitBody item={item} />
            </div>
          ))
        : null}
      {section.block === 'facts'
        ? section.items.map((item) => (
            <div key={item.record_id} className={styles.recordItem}>
              <FactHitBody item={item} />
            </div>
          ))
        : null}
      {section.block === 'persona'
        ? section.items.map((item) => (
            /* 不再套 `recordItem`（灰底卡）：那层就是「嵌套」的外壳，
               现在编辑器自己就是这张卡（见 PersonaBody 的注释）。 */
            <PersonaBody key={item.filename} item={item} />
          ))
        : null}
      {section.block === 'scenes'
        ? section.items.map((item) => (
            <div key={item.filename} className={styles.recordItem}>
              <SceneBody item={item} />
            </div>
          ))
        : null}
    </>
  );
};

/**
 * 「拼装好的 prompt」块。
 *
 * ⚠️ 三件事必须说清，否则这一块会被误读：
 *   1. 它是**展示**用的，不是注入路径的产物（注入由调用方按同一份提示词模块渲染）；
 *   2. `system` 是**常量**（每次调用都一样）→ 默认收起，别占屏；
 *   3. `system === null` 是"那份提示词**还没写**"，不是"提示词是空的"。
 */
const PromptPreview: React.FC<{
  prompt: MemoryRetrievalPrompt['prompt'] | undefined;
}> = ({ prompt }) => {
  const { styles } = useStyles();

  if (!prompt) {
    return (
      <div className={styles.sectionBox}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>
            <Tag>prompt</Tag>
            <span>拼装好的预览</span>
          </div>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          本次响应<b>没有带</b> <code>prompt</code> 字段 —— 契约 v2 把它列进了
          required，所以这是一个不该出现、但要能如实说出口的状态。
        </Typography.Text>
      </div>
    );
  }

  const system = systemPromptState(prompt.system);

  return (
    <div className={styles.sectionBox}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>
          <Tag color="purple">prompt</Tag>
          <span>拼装好的预览</span>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          展示用，不是注入路径的产物
        </Typography.Text>
      </div>

      <Collapse
        size="small"
        ghost
        defaultActiveKey={system.kind === 'missing' ? [] : ['system']}
        items={[
          {
            key: 'system',
            label: (
              <Space size={6}>
                <span>system</span>
                {system.kind === 'missing' ? (
                  <Tag color="warning">null · 还没写</Tag>
                ) : system.kind === 'empty' ? (
                  <Tag>空串</Tag>
                ) : (
                  <Tag>常量，每次调用都一样</Tag>
                )}
              </Space>
            ),
            children:
              system.kind === 'text' ? (
                <div className={styles.promptText}>{system.text}</div>
              ) : system.kind === 'empty' ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <code>prompt.system</code> 是<b>空串</b> —— 提示词写了但是空的
                  （与 null 的「还没写」是两件事）。
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <code>prompt.system = null</code>：那份{' '}
                  <code>memory_retrieval</code> 系统提示词<b>还没写</b>
                  （模块还没落地）—— 与「提示词是空的」区分开。
                </Typography.Text>
              ),
          },
        ]}
      />

      <div style={{ marginTop: 10 }}>
        <Space size={6}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            user
          </Typography.Text>
          <Tag>预览的主体</Tag>
        </Space>
        <div className={styles.promptText}>{prompt.user}</div>
      </div>
    </div>
  );
};

/**
 * 汇总：sections 的结构 + 拼装好的预览。
 *
 * ⚠️ v2.1.0 起四层都可能出现：`retrieve.l0` / `retrieve.l1` 打开时
 *    conversations（L0 命中）/ facts（L1 命中）两段会出现，它们带 score 与
 *    matched_by —— 与 `/query/l0|l1` 的"浏览记录"**不是同一套渲染**。
 *
 * ⚠️⚠️ 展示顺序是 **L0 -> L3 升序**（用户 2026-10-12 要求），而后端返回的是
 *    **prompt 顺序**（L3 -> L2 -> L0 -> L1）→ 这里必须 `sortSectionsByLayer`。
 *    别把 data.sections 直接 map 出来，那是后端顺序。
 */
export const PromptView: React.FC<{ data: MemoryRetrievalPrompt }> = ({
  data,
}) => {
  const { styles } = useStyles();

  /** 按 L0 -> L3 重排后的段（**不就地改响应对象**）。 */
  const sections = sortSectionsByLayer(data.sections);

  return (
    <>
      <DegradedAlert layer={data.degraded} />

      <div className={styles.sectionBox}>
        <div className={styles.sectionHead}>
          {/*
            ⚠️ `scope_kind · x` 那枚 Tag 已撤掉（2026-10-12）—— 它现在在**结果卡的
            卡头**上（紧跟「结果」二字）。这里只留"这次的组装规模"这一类信息。
          */}
          <Space size={6} wrap>
            {data.degraded.length ? (
              <Tag color="warning">{`${data.degraded.length} 层降级`}</Tag>
            ) : (
              <Tag color="success">
                {/* 三段 `${}` 拼 '/' 是历史写法（biome 的 useTemplate 会报）；
                    这里只做等价改写：N/N 层参与。 */}
                {`${data.sections.length}/${data.sections.length}`}层参与
              </Tag>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <TimeText value={data.generated_at} />
          </Typography.Text>
        </div>

        <div className={styles.metaGrid}>
          <div className={styles.metaItem}>
            <MetaItem label="retrieval_id">
              <span className={styles.mono}>{shortId(data.retrieval_id)}</span>
            </MetaItem>
          </div>
          <div className={styles.metaItem}>
            <MetaItem label="input">
              <Tooltip title="本轮用户输入。⚠️ v2.1.0 起是**必填**的 —— 打开 L0/L1 时它就是召回查询串。">
                <span>{data.input || '（空串）'}</span>
              </Tooltip>
            </MetaItem>
          </div>
          <div className={styles.metaItem}>
            <MetaItem label="target">
              <span className={styles.mono}>
                {[
                  data.target.user_id ? `user=${data.target.user_id}` : null,
                  data.target.team_id ? `team=${data.target.team_id}` : null,
                  // agent_id 是必填的，但回显里仍然打印出来 —— 传错的表现是
                  // 空结果，事后唯一能对的就是这一行
                  `agent=${data.target.agent_id ?? '（未回显）'}`,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </span>
            </MetaItem>
          </div>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className={styles.emptyBox}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space vertical size={4}>
                <Typography.Text>sections 为空 —— 一段都没有</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  两种可能：四个开关全是关（一段都没要），或者每一层都取不到 ——
                  后者会在上面的 degraded 里列出来。
                </Typography.Text>
              </Space>
            }
          />
        </div>
      ) : (
        sections.map((section) => {
          const truncatable =
            section.block === 'persona' || section.block === 'scenes';
          const routes = truncatable ? [] : section.degraded_routes;
          return (
            <div key={section.block} className={styles.sectionBox}>
              <div className={styles.sectionHead}>
                <div className={styles.sectionTitle}>
                  <Tag color={BLOCK_COLOR[section.block]}>{section.block}</Tag>
                  <Tag>{section.layer.toUpperCase()}</Tag>
                  <span>{section.title}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {section.returned} 条
                  </Typography.Text>
                </div>
                {truncatable ? (
                  <Tooltip title={truncatedText(section.truncated)}>
                    <Tag color={section.truncated ? 'warning' : 'default'}>
                      {section.truncated ? '已截断' : '未截断'}
                    </Tag>
                  </Tooltip>
                ) : routes.length ? (
                  <Tooltip title="这一层查成了，但其中一路召回没跑成 —— 段落仍然给了另一路的结果。">
                    <Tag color="warning">{`${routes.length} 路降级`}</Tag>
                  </Tooltip>
                ) : (
                  <Tooltip title="召回是 top-K，不是分页：「还有没有更多」没有定义（limit 就是答案的边界）。要更多就调大 limits。">
                    <Tag>top-K · 无截断字段</Tag>
                  </Tooltip>
                )}
              </div>
              <SectionBody section={section} />
              {routes.length ? <DegradedRoutes routes={routes} /> : null}
            </div>
          );
        })
      )}

      <PromptPreview prompt={data.prompt} />
    </>
  );
};

// ---------------------------------------------------------------- 列表（L0 / L1 / L2）

/** 三个列表视图共有的 props。条目是**累积**的（卡片流 + 加载更多）。 */
export interface ListViewProps<T> {
  items: T[];
  page: Pagination | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  stale?: boolean;
}

/**
 * L0：**仍然是一条一条的消息**，不是卡片网格。
 *
 * ⚠️ 2026-10-12 只把 L1 / L2 换成了网格（用户点名那两层），L0 保持原样是有理由的：
 *    这一层的用途是**核对会话原文**，一条消息要横向占满、按时间顺序读下来，切成
 *    一张张方卡反而把"这是第几条、谁说的"挤没了。别为了"三个列表长得一样"把它也换掉。
 */
export const L0View: React.FC<ListViewProps<ConversationRecord>> = ({
  items,
  page,
  loadingMore,
  onLoadMore,
  stale,
}) => {
  const { styles } = useStyles();
  return (
    <>
      <ListHead
        count={items.length}
        note={
          <>
            ⚠️ 这一层是<b>浏览</b>，不是检索：<code>text_contains</code> 只做
            <b>字面包含</b>（不是语义、不是向量）。返回的是<b>完整消息正文</b>{' '}
            —— v2 里没有"命中片段 + score"那套东西了。
            <br />
            排序看 <code>order</code>；<code>session_seq_*</code> 建议只与{' '}
            <code>session_id</code>{' '}
            一起用（跨会话排出来的是各会话的序号混在一起）。 会话不存在时是{' '}
            <b>404</b>，与「会话里没有符合的消息」（200 + 空列表） 区分开。
          </>
        }
      />

      {items.length === 0 ? (
        <div className={styles.emptyBox}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="该 scope 下没有消息（正常结果，不是错误）"
          />
        </div>
      ) : (
        items.map((item) => (
          <div key={item.message_id} className={styles.recordItem}>
            <ConversationBody item={item} />
          </div>
        ))
      )}

      <ListPager
        count={items.length}
        page={page}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        stale={stale}
      />
    </>
  );
};

// ---------------------------------------------------------------- L1 / L2 的卡片网格
//
// ⚠️ 仿的是 **file 页那个「网格」视图**（`src/pages/file/components/FileGrid.tsx`）——
//    不是表格的条目行。同一份数据两处用过：file 页左下角那个 Segmented 切出来的
//    「网格」才是这里要的形态（一张卡一件事、整卡可点）。用户 2026-10-12 点名。
//
// ⚠️ 只是把卡片流换成卡片网格，**翻页方式一行没变**：条目仍然累积、"还有下一页"
//    仍然看 `has_more`（不透明游标做不了页码），所以页脚那份 `ListPager` 照旧。
//    `auto-fill + minmax` 由 CSS 决定一行几张，前端不写"每行 N 个"这种常量。

/** 一张卡里的缩略正文行数（内容与 summary 共用 —— 格子里的摘要就是这个高度）。 */
const CARD_CLAMP_LINES = 3;

/**
 * 网格容器。
 *
 * ⚠️ `minmax(240px, 1fr)` 而不是固定列数：结果区宽度随左边 420px 的参数栏与窗口
 *    变，写死列数会在窄屏上把卡压成一竖条。空列表时这里返回 null —— 空事由各自的
 *    `Empty` 说（要把"没有记录是正常结果"这句留住），不能交给空 grid 什么都不画。
 */
export const CardGrid: React.FC<{
  children: ReactNode;
  /** 给探针/单测的稳定抓手（`data-memory-grid="l1|l2"`）。 */
  layer: 'l1' | 'l2';
}> = ({ children, layer }) => {
  const { styles } = useStyles();
  return (
    <div className={styles.cardGrid} data-memory-grid={layer}>
      {children}
    </div>
  );
};

/**
 * L1 的一张卡（缩略内容 + 整卡可点）。
 *
 * ⚠️ 三件事必须守住，丢一件就退化回"列表 + 抽屉"的老形态：
 *   1. **整张卡就是一个 `<button>`**（FileGrid 的手感）—— 卡里没有第二个"打开方式"，
 *      让用户先找到一颗小按钮是多此一举；
 *   2. ⚠️ **用 `<button>` 而不是 `div + role="button"`**：真 button 自带键盘（Enter /
 *      空格）与读屏语义，`div` 那条路要自己补 `tabIndex` + `onKeyDown`，补漏一次就是
 *      "只能鼠标点"。代价是子元素必须换成 `<span>`（button 里放 `<div>` 不是合法 HTML），
 *      所以 `cardTitle` / `cardFooter` 那几个样式里都自带 `display`。
 *   3. **`content` 完整留在 DOM 里**，视觉上被 `-webkit-line-clamp` 夹成 3 行 ——
 *      与 L0 那条纪律一样：夹子只影响视觉，不放弃数据（选中复制拿得到整段）。
 *
 * ⚠️ 2026-10-12 第二轮（用户拿截图指出"排版显示不全"）：type / priority 两枚 Tag
 *    原本**绝对定位在右上角**，标题为了给它让位写了 `padding-right: 96px` ——
 *    结果标题只剩半行（截图里「我（AI）在帮用户确认今晚去合。」被切掉）。
 *    现在两枚 Tag 挪到**卡脚右侧**，标题整行可用、也不再需要那个魔法 padding。
 */
const FactCard: React.FC<{
  item: FactRecord;
  onOpenFull: (item: FactRecord) => void;
}> = ({ item, onOpenFull }) => {
  const { styles } = useStyles();
  return (
    <button
      type="button"
      className={styles.recordCard}
      data-record-card="l1"
      data-record-id={item.record_id}
      onClick={() => onOpenFull(item)}
    >
      <span className={styles.cardTitle} title={item.scene_name ?? undefined}>
        {item.scene_name ? (
          item.scene_name
        ) : (
          <Typography.Text type="secondary">未归场景</Typography.Text>
        )}
      </span>

      <span
        className={styles.cardClamp}
        /*
          ⚠️ 这个 `data-*` 不只是给测试看的：探针要按它量"夹子到底生效没有"，
          而卡里现在有三格（标题 / 缩略 / 卡脚），**不能靠"第几个孩子"去找** ——
          第一版就是这么写的，卡脚右侧那组 Tag 一挪位置就把索引数错了。
        */
        data-card-clamp="true"
        style={{ WebkitLineClamp: CARD_CLAMP_LINES }}
      >
        {item.content}
      </span>

      <span className={styles.cardFooter}>
        <span className={styles.cardMeta}>
          <span className={styles.mono} title={item.record_id}>
            {shortId(item.record_id)}
          </span>
          <span>v{item.version}</span>
        </span>
        <span className={styles.cardTags}>
          <Tag color="blue">{factTypeLabel(item.type)}</Tag>
          <Tag color={item.priority === -1 ? 'red' : 'default'}>
            {priorityText(item.priority)}
          </Tag>
        </span>
      </span>
    </button>
  );
};

/**
 * L2 的一张卡。
 *
 * ⚠️ 和 L1 那张卡的差别是**刻意的**：这里只有索引（filename + summary + heat），
 *    **没有正文** —— 卡上第三行显示的是 summary，不是 content；要看全文得点开抽屉
 *    走 `/query/l2/detail`。别为了"两张卡长得一样"去编一段正文放上去，那是假的。
 *
 * ⚠️ 卡脚右侧原来是那句「查看全文」提示，现在换成 heat / version 两枚 Tag
 *    （与 L1 同构：**标识在左、状态标签在右**）。"点开看全文"这件事没有丢：
 *    整张卡就是按钮，另外列表头写着「点任意一张卡」，`aria-label` 也说了。
 *    —— 不能再加第三组了：卡最窄 240px，`更新时间 + 提示 + 两枚 Tag` 一定会换行。
 */
const SceneCard: React.FC<{
  item: SceneSummary;
  onOpenFull: (item: SceneSummary) => void;
}> = ({ item, onOpenFull }) => {
  const { styles } = useStyles();
  return (
    <button
      type="button"
      className={styles.recordCard}
      data-record-card="l2"
      data-record-filename={item.filename}
      aria-label={`查看场景全文：${item.filename}`}
      onClick={() => onOpenFull(item)}
    >
      <span className={styles.cardTitle} title={item.filename}>
        <span className={styles.cardTitleMono}>{item.filename}</span>
      </span>

      <span
        className={styles.cardClamp}
        /*
          ⚠️ 这个 `data-*` 不只是给测试看的：探针要按它量"夹子到底生效没有"，
          而卡里现在有三格（标题 / 缩略 / 卡脚），**不能靠"第几个孩子"去找** ——
          第一版就是这么写的，卡脚右侧那组 Tag 一挪位置就把索引数错了。
        */
        data-card-clamp="true"
        style={{ WebkitLineClamp: CARD_CLAMP_LINES }}
      >
        {sceneSummaryText(item.summary)}
      </span>

      <span className={styles.cardFooter}>
        <TimeText value={item.updated_at} />
        <span className={styles.cardTags}>
          <Tag color={item.heat === null ? 'default' : 'orange'}>
            {heatText(item.heat)}
          </Tag>
          <Tag>v{item.version}</Tag>
        </span>
      </span>
    </button>
  );
};

export interface L1ViewProps extends ListViewProps<FactRecord> {
  /** 点某一张卡 —— 右侧抽屉显示这条记忆的全文。 */
  onOpenFull: (item: FactRecord) => void;
}

export const L1View: React.FC<L1ViewProps> = ({
  items,
  page,
  loadingMore,
  onLoadMore,
  onOpenFull,
  stale,
}) => {
  const { styles } = useStyles();
  return (
    <>
      <ListHead
        count={items.length}
        note={
          <>
            ⚠️ 这一层也是<b>浏览</b>：<code>text_contains</code> 只做字面包含，
            没有召回、没有 score。正文<b>整条返回、不截断</b> —— 一条 L1
            记忆已经是 提炼过的陈述，截断会把「喜欢 X，但不能 Y」切成半句。
            <br />
            <code>priority = -1</code> 是<b>全局死命令</b>（不是"最低优先级"），
            而且它<b>不参与排序</b> —— 顺序只由 <code>order</code> 决定。
            <br />
            卡里只显示前 {CARD_CLAMP_LINES} 行（缩略），
            <b>点任意一张卡</b>在右侧抽屉看全文。
          </>
        }
      />

      {items.length === 0 ? (
        <div className={styles.emptyBox}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="该 scope 下没有原子记忆（正常结果，不是错误）"
          />
        </div>
      ) : (
        <CardGrid layer="l1">
          {items.map((item) => (
            <FactCard
              key={item.record_id}
              item={item}
              onOpenFull={onOpenFull}
            />
          ))}
        </CardGrid>
      )}

      <ListPager
        count={items.length}
        page={page}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        stale={stale}
      />
    </>
  );
};

export interface L2ViewProps extends ListViewProps<SceneSummary> {
  /** 点某一张卡 —— 抽屉里再拉 `/query/l2/detail`（索引里没有正文）。 */
  onOpenFull: (item: SceneSummary) => void;
}

export const L2View: React.FC<L2ViewProps> = ({
  items,
  page,
  loadingMore,
  onLoadMore,
  onOpenFull,
  stale,
}) => {
  const { styles } = useStyles();
  return (
    <>
      <ListHead
        count={items.length}
        note={
          <>
            ⚠️ 列表恒为<b>索引</b>（filename + summary + heat），
            <b>没有正文</b> —— 要看全文<b>点任意一张卡</b>（走{' '}
            <code>/query/l2/detail</code>
            ，右侧抽屉显示）。这不是"少给了"，是这一段拆成了两个接口。
            <br />
            这一层是「列举」：<code>filename_contains</code> 只筛<b>文件名</b>，
            v2 不再提供按内容筛选。
          </>
        }
      />

      {items.length === 0 ? (
        <div className={styles.emptyBox}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="该 scope 还没有场景文件（这是正常状态，不是 404）"
          />
        </div>
      ) : (
        <CardGrid layer="l2">
          {items.map((item) => (
            <SceneCard
              key={item.filename}
              item={item}
              onOpenFull={onOpenFull}
            />
          ))}
        </CardGrid>
      )}

      <ListPager
        count={items.length}
        page={page}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        stale={stale}
      />
    </>
  );
};

// ---------------------------------------------------------------- L3

/**
 * L3：一篇画像，或者 `persona: null`。
 *
 * ⚠️ 这里原来顶上还有一个 `scope_kind · x` 的灰底盒子 —— 已撤掉（2026-10-12），
 *    它现在长在**结果卡的卡头**上（紧跟「结果」二字）。撤掉之后这一层没有别的头，
 *    所以整块不留空壳。
 */
export const L3View: React.FC<{ data: L3QueryResponse }> = ({ data }) => {
  const { styles } = useStyles();

  return (
    <>
      {data.persona === null ? (
        <div className={styles.emptyBox}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space vertical size={4}>
                <Typography.Text>persona: null</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  这个 scope 还没有生成过画像 —— 这是正常状态，不是 404。
                  管理员视图下不判 scope 是否存在（任何没见过的 scope
                  都只是「还没有数据」），所以这里只有 200。
                </Typography.Text>
              </Space>
            }
          />
        </div>
      ) : (
        /* 同上：不再套 `recordItem`，只留编辑器这一层。 */
        <PersonaBody item={data.persona} />
      )}
    </>
  );
};
