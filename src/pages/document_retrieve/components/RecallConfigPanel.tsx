// src/pages/document_retrieve/components/RecallConfigPanel.tsx
// 每路召回参数（retrieval_config）：按 retrieval_type 逐路设置融合**之前**的
// 召回参数 —— 候选池多大、多干净、超时多久。
//
// 与 RouteFilter 的分工（契约原话）：
//   那个决定**跑哪几路**（retrieval_types），这个决定**每路跑多宽**
//   （retrieval_config）。所以两块在页面上是相邻的，且都是「并集里的一路一条」。
//
// 三条必须守住的边界：
//  1. key 只能是**合法的 retrieval type**。拼错（dense_vectorr）会被 422 拒
//     绝 —— 这一点比 retrieval_types 严格得多，后者是过滤器（点名不存在的值
//     只是筛不掉东西），这是配置（一个匹配不上任何东西的 key 就是错误）。
//     所以这里**不提供任何手填入口**，只从并集里取值。
//  2. 字段不填 = 不传 = 走该路自己的默认。因此面板里的数值默认都是 null，
//     而不是把契约默认值（如 top_k 的 200）预先填进去 —— 那会让「看着配了
//     其实等于没配」的字段混进请求体。
//  3. min_score 的量纲**逐路不同**，且必须在索引侧执行。所以每一路要给自己的
//     量纲说明，绝不做统一的 0..1 钳制。
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Collapse,
  Input,
  InputNumber,
  Space,
  Tag,
  Typography,
} from 'antd';
import React from 'react';

import { retrievalTypeLabel } from '@/utils/retrievalType';
import {
  defaultRecallPanel,
  minScoreMeta,
  type RetrievalRecallPanel,
  type SearchParamRow,
  searchParamsNote,
} from '../data';
import { pathDotClass, useStyles } from '../style';
import ExtraSwitch from './ExtraSwitch';

interface RecallConfigPanelProps {
  /** 并集（已去重）。详情还没回来时是空数组 —— 那就是「当前无法配置」。 */
  types: string[];
  /** 定向召回里**被排除**的路 —— 这些路本轮不执行，下发了也不生效。 */
  excluded?: string[];
  /** key = retrieval_type。没动过的路不在键里（= 不传 = 默认）。 */
  value: Record<string, RetrievalRecallPanel>;
  onChange: (next: Record<string, RetrievalRecallPanel>) => void;
  /** 详情还在拉取中。 */
  pending?: boolean;
}

/** 折叠标题上的摘要：让人不展开也知道这一路到底下发了什么。 */
function summarize(cfg: RetrievalRecallPanel): string {
  if (!cfg.on) return '继承该路默认（字段不传）';

  const parts: string[] = [];
  if (cfg.topK !== null) parts.push(`top_k=${cfg.topK}`);
  if (cfg.minScore !== null) parts.push(`min_score=${cfg.minScore}`);
  if (cfg.timeoutMs !== null) parts.push(`${cfg.timeoutMs}ms`);
  if (cfg.searchParamRows.some((r) => r.key.trim() && r.value.trim())) {
    parts.push('search_params');
  }
  return parts.length ? parts.join(' · ') : '已启用，但一个字段都没填';
}

const RecallConfigPanel: React.FC<RecallConfigPanelProps> = ({
  types,
  excluded = [],
  value,
  onChange,
  pending,
}) => {
  const { styles } = useStyles();

  const patch = (type: string, p: Partial<RetrievalRecallPanel>) => {
    const base = value[type] ?? defaultRecallPanel();
    onChange({ ...value, [type]: { ...base, ...p } });
  };

  const setRows = (type: string, rows: SearchParamRow[]) =>
    patch(type, { searchParamRows: rows });

  const patchRow = (
    type: string,
    rows: SearchParamRow[],
    index: number,
    p: Partial<SearchParamRow>,
  ) =>
    setRows(
      type,
      rows.map((row, i) => (i === index ? { ...row, ...p } : row)),
    );

  const items = types.map((type) => {
    const cfg = value[type] ?? defaultRecallPanel();
    const meta = minScoreMeta(type);
    /** 定向召回没勾这一路 —— 下发了也只是「用不上」，如实说出来。 */
    const skipped = excluded.includes(type);
    const isDense = type === 'dense_vector';

    return {
      key: type,
      label: (
        <Space size={8}>
          {/* 圆点保留每路的颜色身份，与全页其它路径标签同一个映射 */}
          <span className={`${styles.pathDot} ${pathDotClass(styles, type)}`} />
          <Typography.Text strong>{retrievalTypeLabel(type)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {summarize(cfg)}
          </Typography.Text>
          {skipped ? <Tag>本轮不执行</Tag> : null}
        </Space>
      ),
      extra: (
        <ExtraSwitch checked={cfg.on} onChange={(on) => patch(type, { on })} />
      ),
      children: (
        <Space vertical size={10} style={{ width: '100%' }}>
          {skipped ? (
            <div className={styles.recallNote}>
              定向召回没勾这一路，<code>retrieval_types</code> 里不会有它 —— key
              合法所以不会报错，但参数只是被忽略。
            </div>
          ) : null}

          <div className={styles.recallRow}>
            <span className={styles.recallLabel}>top_k</span>
            <InputNumber
              size="small"
              min={1}
              max={500}
              style={{ width: 130 }}
              placeholder="默认 200"
              value={cfg.topK ?? undefined}
              onChange={(v) => patch(type, { topK: v ?? null })}
            />
            <span className={styles.recallNote}>
              候选池大小 —— <b>不是</b>结果条数，那是 cutter.top_k。池子太窄，
              相关但排位靠后的 chunk 进不来，后面再怎么融合重排都捞不回。
            </span>
          </div>

          <div className={styles.recallRow}>
            <span className={styles.recallLabel}>min_score</span>
            <InputNumber
              size="small"
              step={meta.step}
              style={{ width: 130 }}
              placeholder={meta.placeholder}
              value={cfg.minScore ?? undefined}
              onChange={(v) => patch(type, { minScore: v ?? null })}
            />
            <span className={styles.recallNote}>{meta.note}</span>
          </div>

          <div className={styles.recallRow}>
            <span className={styles.recallLabel}>timeout_ms</span>
            <InputNumber
              size="small"
              min={1}
              max={60000}
              style={{ width: 130 }}
              placeholder="不限制"
              value={cfg.timeoutMs ?? undefined}
              onChange={(v) => patch(type, { timeoutMs: v ?? null })}
            />
            <span className={styles.recallNote}>
              超时只把<b>这一路</b>放进 degraded_routes，其它路照常返回。
            </span>
          </div>

          <div>
            <div className={styles.recallNote}>
              search_params —— {searchParamsNote(type)}
            </div>
            <Space vertical size={6} style={{ width: '100%', marginTop: 6 }}>
              {cfg.searchParamRows.map((row, index) => (
                <Space size={6} key={`sp-${index.toString()}`}>
                  <Input
                    size="small"
                    style={{ width: 118 }}
                    placeholder={isDense ? 'ef' : 'key'}
                    value={row.key}
                    onChange={(e) =>
                      patchRow(type, cfg.searchParamRows, index, {
                        key: e.target.value,
                      })
                    }
                  />
                  <Input
                    size="small"
                    style={{ width: 118 }}
                    placeholder={isDense ? '128' : 'value'}
                    value={row.value}
                    onChange={(e) =>
                      patchRow(type, cfg.searchParamRows, index, {
                        value: e.target.value,
                      })
                    }
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      setRows(
                        type,
                        cfg.searchParamRows.length === 1
                          ? [{ key: '', value: '' }]
                          : cfg.searchParamRows.filter((_, i) => i !== index),
                      )
                    }
                  />
                </Space>
              ))}
              <Button
                size="small"
                type="link"
                icon={<PlusOutlined />}
                onClick={() =>
                  setRows(type, [
                    ...cfg.searchParamRows,
                    { key: '', value: '' },
                  ])
                }
              >
                添加参数
              </Button>
            </Space>
          </div>

          <div className={styles.recallSub}>
            min_score 是在索引侧执行的：每路召回后会立刻除以本路最大值做归一化，
            把第一名钉成 1.0 —— 拿阈值去比归一化后的分数，永远筛不掉任何东西。
          </div>
        </Space>
      ),
    };
  });

  const enabledCount = types.filter((type) => value[type]?.on).length;

  return (
    <div className={styles.recallConfig}>
      <div className={styles.routeFilterHead}>
        <Space size={6}>
          <Typography.Text strong>每路召回参数</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            retrieval_config
          </Typography.Text>
        </Space>
        {types.length ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`${enabledCount} / ${types.length} 路单独下发`}
          </Typography.Text>
        ) : null}
      </div>

      {types.length ? (
        <Collapse ghost size="small" items={items} />
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {pending
            ? '正在拉取已选定义的 retrieval 配置…'
            : '已选定义没有启用中的 retrieval —— 没有可配置的召回路径。'}
        </Typography.Text>
      )}

      <div className={styles.hint} style={{ marginTop: 6 }}>
        与上面的「定向召回路径」分工：那里决定<b>跑哪几路</b>，这里决定
        <b>每路跑多宽</b> —— 候选池的大小与干净程度，发生在融合<b>之前</b>。
        不填的字段一律不传，走该路自己的默认。
      </div>
    </div>
  );
};

export default RecallConfigPanel;
