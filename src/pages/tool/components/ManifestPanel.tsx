// src/pages/tool/components/ManifestPanel.tsx
// 概览 —— ToolManifest 全字段展示，**没有一处输入框**。
//
// 为什么一个输入框都没有：yaml 里 ToolManifest 的每个字段都标了 readOnly: true。
// 它们是**代码注册得到的**（加 @tool 装饰器、挂到 mcp server、写进 openapi spec），
// 前端改了也会被服务端丢弃。要改请改代码再 sync —— 这一页的职责就是
// 把这句话说清楚，而不是提供一个改了没用的表单。
import { Alert, Descriptions, Tag, Typography } from 'antd';
import React from 'react';
import { SOURCE_STATE_COLOR, type ToolManifest, toolDocstring } from '../data';
import { useEnumLabels } from '../enumLabels';
import { useStyles } from '../style';

interface ManifestPanelProps {
  manifest: ToolManifest;
}

/** ISO 时间去掉尾巴，页面空间有限不需要到毫秒 */
function fmt(iso?: string | null): string {
  if (!iso) return '—';
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
    .replace(/Z$/, '');
}

const ManifestPanel: React.FC<ManifestPanelProps> = ({ manifest }) => {
  const { styles } = useStyles();
  const labels = useEnumLabels();
  const missing = manifest.source_state === 'MISSING';

  return (
    <>
      {missing ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="source_state = MISSING"
          description={
            <>
              上次 discovery 未发现该 Tool，但记录与文档覆盖<b>都保留着</b>
            </>
          }
        />
      ) : null}

      <Descriptions
        size="small"
        column={1}
        bordered
        items={[
          {
            key: 'tool_key',
            label: 'tool_key',
            children: <span className={styles.mono}>{manifest.tool_key}</span>,
          },
          { key: 'name', label: 'name', children: manifest.name },
          {
            key: 'source_type',
            label: 'source_type',
            // 原值 + 译文：source_type 是开放字符串，未命中的翻译会回落到原值，
            // 这时括号里那句就变成重复的同一个词 —— 用 both 逻辑避免（见 enumLabels）
            children: (
              <span className={styles.mono} title={manifest.source_type}>
                {manifest.source_type}
                {labels.sourceType(manifest.source_type) !==
                manifest.source_type
                  ? `（${labels.sourceType(manifest.source_type)}）`
                  : ''}
              </span>
            ),
          },
          {
            key: 'source_state',
            label: 'source_state',
            children: (
              <Tag
                color={SOURCE_STATE_COLOR[manifest.source_state]}
                title={manifest.source_state}
              >
                {labels.sourceState(manifest.source_state)}
              </Tag>
            ),
          },
          {
            key: 'source_ref',
            label: 'source_ref',
            children: (
              <span className={styles.mono}>{manifest.source_ref ?? '—'}</span>
            ),
          },
          {
            key: 'entrypoint',
            label: 'entrypoint',
            children: (
              <span className={styles.mono}>{manifest.entrypoint ?? '—'}</span>
            ),
          },
          {
            key: 'manifest_hash',
            label: 'manifest_hash',
            children: (
              <>
                <span className={styles.mono}>{manifest.manifest_hash}</span>
              </>
            ),
          },
          {
            key: 'discovered_at',
            label: 'discovered_at',
            children: (
              <span className={styles.mono}>{fmt(manifest.discovered_at)}</span>
            ),
          },
          {
            key: 'last_synced_at',
            label: 'last_synced_at',
            children: (
              <span className={styles.mono}>
                {fmt(manifest.last_synced_at)}
              </span>
            ),
          },
        ]}
      />

      <div className={styles.docBlock} style={{ marginTop: 12 }}>
        <div className={styles.docBlockHead}>
          <Typography.Text strong>source_docstring</Typography.Text>
          <Tag>只读</Tag>
          <span style={{ flex: 1 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            代码 docstring 的原始 / 解析结果
          </Typography.Text>
        </div>
        <pre className={styles.jsonBlock}>
          {JSON.stringify(manifest.source_docstring ?? {}, null, 2)}
        </pre>
        {!toolDocstring(manifest).description ? (
          <div className={styles.hint} style={{ marginTop: 6 }}>
            这份 docstring 里解析不出{' '}
            <span className={styles.mono}>description</span>
            —— 「代码侧描述」会是空的，建议在下面的人工覆盖里补一句， 否则这个
            Tool 对 LLM 就是没有说明书的。
          </div>
        ) : null}
      </div>
    </>
  );
};

export default ManifestPanel;
