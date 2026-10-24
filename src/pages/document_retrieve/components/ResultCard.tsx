// src/pages/document_retrieve/components/ResultCard.tsx
// 单条召回结果。字段严格来自 DocumentRetrieveResult。
//
// pipeline_keys 是**数组**：同一个 chunk 被多路同时命中是融合最有价值的产物。
// 两路以上时，这几枚路径标签就是一组按钮 —— 选中哪一路，正文里就只描
// 那一路标出来的命中（见 data.ts 的 marksByRoute）。两路以下没什么可切的，
// 退回普通标签，免得为一路摆一个只有一个选项的控件。
//
// 命中高亮**不单独列**，而是描在正文里。索引给的是「带 <em> 的片段」，
// 按路分好组之后换算回正文坐标再上色 —— 片段本身不另占版面。
//
// 注意：metadata 是后端自由结构，可能出现很长的字符串（preview / checksum 等），
// 这里统一截断展示，完整值放在 title 里。
import { Segmented, Space, Tag, Typography } from 'antd';
import React, { useMemo, useState } from 'react';
import {
  ALL_ROUTES,
  cellHit,
  type DocumentRetrieveResult,
  highlightFragments,
  markCells,
  marksByRoute,
  marksForRoute,
  PIPELINE_KEY_COLOR,
  pathLabel,
  resultPathKeys,
} from '../data';
import { pathDotClass, useStyles } from '../style';

interface ResultCardProps {
  result: DocumentRetrieveResult;
  /** document_type_definition_id → 名称，拿不到就显示短 ID */
  dtdName?: string;
  maxScore: number;
}

const MAX_META_LEN = 160;

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const ResultCard: React.FC<ResultCardProps> = ({
  result,
  dtdName,
  maxScore,
}) => {
  const { styles } = useStyles();
  const [expanded, setExpanded] = useState(false);
  /** null = 全部路。默认看并集 —— 多路同时命中本来就是要看的东西。 */
  const [route, setRoute] = useState<string | null>(null);

  const pct = Math.max(2, Math.round((result.score / (maxScore || 1)) * 100));

  /**
   * 可切换的几路：以 pipeline_keys 为准（那是「命中过这条」的权威列表），
   * 再把 highlights 里多出来的键并进来 —— 真出现那种不一致时，至少不会让
   * 某一路的标记变成看不见的死角。
   */
  const routes = useMemo(() => {
    const merged = resultPathKeys(result);
    for (const key of Object.keys(result.highlights ?? {})) {
      if (!merged.includes(key)) merged.push(key);
    }
    return merged;
  }, [result]);

  /** 每一路自己的描出区间。按路算一次，之后切换只是换索引。 */
  const byRoute = useMemo(
    () => marksByRoute(result.content, result.highlights),
    [result.content, result.highlights],
  );

  /**
   * 正文的最小单元 —— 切点取自**所有路**的端点，所以跟选中的路无关。
   * 这正是切换动画能全交给 CSS 的前提：元素不重挂。
   */
  const cells = useMemo(
    () => markCells(result.content, byRoute),
    [result.content, byRoute],
  );

  const routeMarks = useMemo(
    () => marksForRoute(byRoute, route),
    [byRoute, route],
  );

  /** 当前这一档拿到的片段数，用来区分「没标到」与「这一路压根不产高亮」。 */
  const fragments = useMemo(
    () => highlightFragments(result.highlights, route),
    [result.highlights, route],
  );

  /**
   * 当前这一档的名字。
   *
   * 只有一路时「全部」跟那一路是同一件事，直接报路名 —— 否则提示文案里
   * 会出现「全部路没有给出高亮片段」这种别扭说法。
   */
  const activeLabel = useMemo(() => {
    if (route !== null) return pathLabel(route);
    if (routes.length === 0) return '这一条';
    if (routes.length === 1) return pathLabel(routes[0]);
    return '全部路';
  }, [route, routes]);

  // preview 是 chunk 的全文预览，和上面的 content 重复且极长，命中面板里不展示。
  const metaEntries = Object.entries(result.metadata ?? {}).filter(
    ([key]) => key !== 'preview',
  );

  return (
    <div className={styles.resultItem}>
      <div className={styles.rank}>{result.rank}</div>
      <div className={styles.resultMain}>
        <div className={styles.routeSwitch}>
          {routes.length > 1 ? (
            <Segmented
              size="small"
              value={route ?? ALL_ROUTES}
              onChange={(value) =>
                setRoute(value === ALL_ROUTES ? null : String(value))
              }
              options={[
                {
                  value: ALL_ROUTES,
                  label: '全部',
                  tooltip: `这几路的并集：${routes
                    .map((key) => pathLabel(key))
                    .join(' / ')}`,
                },
                ...routes.map((key) => {
                  const count = highlightFragments(
                    result.highlights,
                    key,
                  ).length;
                  return {
                    value: key,
                    // 圆点保留每路的颜色身份，与全页其它路径标签同一个映射
                    label: (
                      <span>
                        <span
                          className={`${styles.pathDot} ${pathDotClass(styles, key)}`}
                        />
                        {pathLabel(key)}
                      </span>
                    ),
                    tooltip: count
                      ? `${pathLabel(key)} 给出 ${count} 段命中片段`
                      : `${pathLabel(key)} 没有给出高亮片段`,
                  };
                }),
              ]}
            />
          ) : routes.length === 1 ? (
            <Tag color={PIPELINE_KEY_COLOR[routes[0]] ?? 'default'}>
              {pathLabel(routes[0])}
            </Tag>
          ) : (
            <Tag>未标注路径</Tag>
          )}

          {/* 多路命中是融合的核心信号，单独标一下，别埋在控件里 */}
          {routes.length > 1 ? (
            <Tag color="gold">{`${routes.length} 路同时命中`}</Tag>
          ) : null}
          {dtdName ? (
            <Tag>{dtdName}</Tag>
          ) : (
            <Tag>{result.document_type_definition_id.slice(0, 8)}</Tag>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            score
          </Typography.Text>
          <Typography.Text strong>{result.score.toFixed(4)}</Typography.Text>
          <div className={styles.scoreTrack} title={`score ${result.score}`}>
            <div className={styles.scoreFill} style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            chunk {result.document_chunk_id} · version{' '}
            {result.document_version_id} · doc {result.document_id}
          </Typography.Text>
        </div>

        {/* 命中处描在正文里，不另占版面。单元按所有路的端点切好、与选中的路
            无关，所以切换只是同一批元素换 class ——「旧的先渐隐、新的再渐亮」
            是两条 CSS 过渡自己排出来的顺序。 */}
        <div
          className={`${styles.content} ${expanded ? '' : styles.contentClamp}`}
        >
          {cells.map((cell) => (
            <span
              key={cell.start}
              className={cellHit(cell, route) ? styles.mark : styles.markOff}
            >
              {cell.text}
            </span>
          ))}
        </div>

        {/* 后端给了片段、正文里却定位不到 —— 这是异常，得单独占一行说清楚。
            常见原因：片段被截断，或正文被 cutter.max_content_chars 截断在片段之前。 */}
        {fragments.length > 0 && !routeMarks.length ? (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', marginTop: 6 }}
          >
            后端返回了 {fragments.length} 个高亮片段，但在正文里定位不到 ——
            片段可能被截断，或正文被 max_content_chars 截断。
          </Typography.Text>
        ) : null}

        {/* 左：展开全文；右：这一档一段都没标到时的结论。
            结论只给「哪一路没标到」，原因压在 title 里 —— 那半句解释更长，
            摆在行里会把「展开全文」挤到中间去。 */}
        <div className={styles.resultFooter}>
          <Space size={12}>
            <Typography.Link
              style={{ fontSize: 12 }}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? '收起' : '展开全文'}
            </Typography.Link>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {result.content.length} 字符
            </Typography.Text>
          </Space>

          {!fragments.length ? (
            <Typography.Text
              className={styles.footerNote}
              title="高亮靠索引侧的高亮器，纯向量相似度那几路不经过它（ES 的 sparse_vector 就是这样）—— 标不出来不代表没召回"
            >
              {activeLabel}没有给出高亮片段
            </Typography.Text>
          ) : null}
        </div>

        {metaEntries.length ? (
          <div className={styles.metaGrid}>
            {metaEntries.map(([key, value]) => {
              const text = stringify(value);
              return (
                <div
                  key={key}
                  className={styles.metaItem}
                  title={`${key}: ${text}`}
                >
                  <Typography.Text type="secondary">{key}: </Typography.Text>
                  <Typography.Text>
                    {text.length > MAX_META_LEN
                      ? `${text.slice(0, MAX_META_LEN)}…`
                      : text}
                  </Typography.Text>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ResultCard;
