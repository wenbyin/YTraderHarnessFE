// src/pages/retrieval_eval/components/TargetChunkText.tsx
//
// 阶段 trace 面板顶部的「目标 chunk 原文」。
//
// 为什么必须和 trace 挨着看
// ------------------------
// trace 只回答「这颗金标在哪一段被丢的」（`is_target` / gold_ranks_*），
// 回答不了「丢得冤不冤」。只有读到正文才判断得出：
//
//     查询与正文说法不一致   → 检索质量问题（改写 / 分块 / 向量该调）
//     正文里根本没这个说法   → 是金标本身有问题（题造错了）
//
// 两者结论完全相反，而只盯着一串 UUID 是分不出来的。
//
// 数据从哪来
// ----------
// 走 document 域的通用单条端点 `GET /document-chunks/{id}`（见 service 的
// `getDocumentChunk`）—— trace 响应里**没有**正文，只有 `gold_chunk_ids`。
// 不把正文塞进 trace 响应，是因为那样每次下钻都要为每个阶段重传一遍正文。
//
// 为什么是「点开抽屉才请求」而不是把正文挂进 trace
// ----------------------------------------------
// 一道题的金标通常只有一两颗，但抽屉是**按轮次可切换**的，同一颗金标会被
// 反复看到。这里按 chunkId 缓存（key = chunkId，切轮次不重复请求正文，
// 因为正文与轮次无关）。
//
// 视觉照抄 document 页版本抽屉里的 `ChunkRow`（同一响应体、同一读者），
// 不另造一套：段头左标题右操作、白底段、等宽 JSON 块。
import { Alert, Spin, Tag, Tooltip, Typography } from 'antd';
import React, { useEffect, useState } from 'react';
import type { DocumentChunkText as ChunkText } from '../data';
import { getDocumentChunk } from '../service';
import { useStyles } from '../style';

const { Text } = Typography;

/**
 * 折叠阈值。与 document 页版本抽屉取同一个数（见 VersionDrawer 的
 * `PREVIEW_CHARS`）—— 同一块 chunk 在两个页面上折叠在不同的地方，
 * 会让人以为读到的是两块不同的东西。
 */
const PREVIEW_CHARS = 220;

const shortId = (id: string) => `${id.slice(0, 8)}…`;

interface LoadState {
  loading: boolean;
  data?: ChunkText;
  /** 取不到时的原因（404 / 后端不可达）。空串表示还没失败过。 */
  error?: string;
}

/**
 * 单颗目标 chunk 的正文卡。
 *
 * 提出来做组件而不是在列表里内联，是为了让「折叠 / 元数据展开」这两个
 * 纯本地状态天然按 chunk 分开；也为了把请求生命周期收在一个 chunk 上 ——
 * `chunkId` 是字符串，effect 的依赖天然稳定，不会因为父级重渲染重取。
 */
const TargetChunkCard: React.FC<{ chunkId: string }> = ({ chunkId }) => {
  const { styles } = useStyles();
  const [state, setState] = useState<LoadState>({ loading: true });
  const [expanded, setExpanded] = useState(false);
  const [showMeta, setShowMeta] = useState(false);

  useEffect(() => {
    // 抽屉里切轮次会让父级重渲染；卸载标记防的是「请求回来了，组件已经没了」
    // 之后仍然 setState（React 18 不再报 warning，但状态会挂在一个死组件上）。
    let cancelled = false;
    setState({ loading: true });

    getDocumentChunk(chunkId)
      .then((data) => {
        if (!cancelled) setState({ loading: false, data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [chunkId]);

  const chunk = state.data;
  const locator = chunk?.locator ?? null;
  const hasLocator = Boolean(locator) && Object.keys(locator ?? {}).length > 0;

  // 后端截断过的没有全文可给，**不给「展开全文」** —— 手里没有全文，
  // 展开也没得展，只能如实标注。本页请求不传 preview_chars，正常恒 false。
  const canCollapse =
    Boolean(chunk) &&
    !chunk?.content_truncated &&
    (chunk?.content.length ?? 0) > PREVIEW_CHARS;

  const shown = !chunk
    ? ''
    : canCollapse && !expanded
      ? `${chunk.content.slice(0, PREVIEW_CHARS)}…`
      : chunk.content;

  return (
    <div className={styles.chunkRow}>
      <div className={styles.chunkHeader}>
        <span className={styles.chunkIndex}>
          #{chunk ? chunk.chunk_index : '—'}
        </span>
        {chunk?.token_count != null && (
          <Tag color="default">{chunk.token_count} tokens</Tag>
        )}
        {chunk && <Tag>{chunk.char_count} 字符</Tag>}
        {chunk?.start_index != null && chunk?.end_index != null && (
          <Text type="secondary" className={styles.monoValue}>
            [{chunk.start_index}, {chunk.end_index})
          </Text>
        )}
        {/*
          卡头右侧钉住 chunk_id：下面整张 trace 都是按 chunk_id 认人的，
          卡上不写就得多绕一次「这颗是列表里哪个 ★」。金色与 trace 里的
          gold 标记同一套，跨组件一眼对得上。
        */}
        <Tooltip title={chunkId}>
          <Text
            className={styles.mono}
            style={{ color: '#d48806', marginLeft: 'auto' }}
          >
            ★ {shortId(chunkId)}
          </Text>
        </Tooltip>
      </div>

      <div className={styles.chunkBody}>
        {/* 1. 原文 */}
        <div className={styles.chunkSection}>
          <div className={styles.chunkSectionHead}>
            <span className={styles.chunkSectionTitle}>原文</span>
            {canCollapse ? (
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? '收起' : `展开全文（共 ${chunk?.char_count} 字符）`}
              </Typography.Link>
            ) : chunk ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                共 {chunk.char_count} 字符
              </Text>
            ) : null}
          </div>

          {state.loading ? (
            <Spin size="small" />
          ) : state.error ? (
            <Alert
              type="warning"
              showIcon
              title="取不到这块 chunk 的原文"
              description={
                <>
                  {state.error}
                  <br />
                  常见原因：chunk 已随文档重跑被清掉，或后端不可达
                </>
              }
            />
          ) : (
            <>
              <pre className={styles.chunkContent}>{shown}</pre>
              {chunk?.content_truncated && (
                <Text type="warning" style={{ fontSize: 12 }}>
                  后端只返回了前 {chunk.content.length}{' '}
                  个字符（「字符」标签给的是截断**前**的长度），这里拿不到全文。
                </Text>
              )}
            </>
          )}
        </div>

        {/* 2. 元数据（locator 是从正文里定位回源文件的唯一线索） */}
        {hasLocator && (
          <div className={styles.chunkSection}>
            <div className={styles.chunkSectionHead}>
              <span className={styles.chunkSectionTitle}>元数据</span>
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={() => setShowMeta((value) => !value)}
              >
                {showMeta ? '收起' : '展开'}
              </Typography.Link>
            </div>

            {showMeta ? (
              <div className={styles.metaBlock} style={{ borderTop: 0 }}>
                <div className={styles.metaLabel}>locator</div>
                <pre className={styles.metaJson}>
                  {JSON.stringify(locator, null, 2)}
                </pre>
              </div>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                locator · 在源文件里的位置（页码 / 章节 / 行）
              </Text>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

interface TargetChunkTextProps {
  /** 要展示正文的目标 chunk（评测里就是 gold_chunk_ids）。 */
  chunkIds: string[];
}

/**
 * 目标 chunk 的原文区。
 *
 * 无 id 时**整块不渲染**（而不是给个空态）：一颗金标都没有的 case 本来
 * 就没有"目标"，摆一个空框只会让人找"是不是没加载出来"。
 */
const TargetChunkText: React.FC<TargetChunkTextProps> = ({ chunkIds }) => {
  const { styles } = useStyles();

  if (!chunkIds.length) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <h3 className={styles.sectionTitle}>target chunk 原文</h3>
      <Text
        type="secondary"
        style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
      >
        逐层追踪的那颗金标写了什么。trace 只说「它在哪一段被丢」，
        读得到正文才判断得出丢得冤不冤 —— 是查询与正文的说法对不上（检索
        质量问题），还是正文里根本没有这种说法（金标本身有问题）。
      </Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {chunkIds.map((id) => (
          <TargetChunkCard key={id} chunkId={id} />
        ))}
      </div>
    </div>
  );
};

export default TargetChunkText;
