// src/pages/tool/components/DocEditor.tsx
// 文档覆盖 —— 这个页面存在的理由。
//
// 契约给了两件事，逼出这个形态：
//
//  1. ToolDocumentation **同时**返回 source（manifest.source_docstring 里）与
//     effective_*（= override ?? source），而 **LLM / JEV 消费的是 effective**。
//     所以每个可覆盖字段必须同时呈现三样东西：代码写的什么、我写的什么、
//     最终生效的是什么 —— 缺一个，用户就无法回答「这段描述到底哪来的」。
//
//  2. PUT 是**全量替换**（operationId: replaceToolDocumentation），不是 merge。
//     请求体里没带的 parameter_path = 那条覆盖被删掉了。所以这里永远整张表提交，
//     并且把 PUT body 摊开给人看 —— 让「到底会发什么」在点保存之前就可见。
//
// 「清空」= 发 null，不是发空串：空串会让 effective 变成一段空白描述，
// 比不覆盖更糟（LLM 拿到空白而不是代码原文）。normalizeOverride 负责这件事。
import {
  Button,
  Card,
  Empty,
  Input,
  Space,
  Table,
  type TableColumnsType,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React from 'react';
import {
  buildDocPutBody,
  type DocDraft,
  effectiveText,
  isOrphanPath,
  normalizeOverride,
  paramPaths,
  sourceParamDesc,
  type ToolDocumentation,
  type ToolManifest,
  toolDocstring,
} from '../data';
import { useStyles } from '../style';

interface DocEditorProps {
  manifest: ToolManifest;
  documentation: ToolDocumentation | null;
  draft: DocDraft;
  dirty: boolean;
  saving: boolean;
  onDraftChange: (draft: DocDraft) => void;
  onSave: () => void;
  onReset: () => void;
}

/** 一个可覆盖字段的三态块：代码 / 覆盖 / 生效。 */
const OverrideField: React.FC<{
  title: string;
  contractKey: string;
  source: string | null;
  value: string;
  onChange: (v: string) => void;
}> = ({ title, contractKey, source, value, onChange }) => {
  const { styles } = useStyles();
  const eff = effectiveText(value, source);
  const covered = Boolean(normalizeOverride(value));

  return (
    <div className={styles.docBlock}>
      <div className={styles.docBlockHead}>
        <Typography.Text strong>{title}</Typography.Text>
        <Tag color={covered ? 'blue' : 'default'}>
          {covered ? '已覆盖' : '用代码原文'}
        </Tag>
        <span style={{ flex: 1 }} />
        <span className={styles.mono}>{contractKey}</span>
      </div>

      <div className={styles.sourceBox}>
        {source ?? '（代码没有给这段描述）'}
      </div>
      <div className={styles.caption}>
        ↑ 代码侧（<span className={styles.mono}>source_docstring</span>），只读
      </div>

      <Input.TextArea
        style={{ marginTop: 6 }}
        autoSize={{ minRows: 2, maxRows: 6 }}
        value={value}
        placeholder="留空 = 不覆盖，直接用代码原文"
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={styles.caption}>
        ↑ 覆盖。清空即提交 <span className={styles.mono}>null</span>
        —— <b>不是</b>空串
      </div>

      <div
        className={`${styles.effBox} ${eff.fromOverride ? '' : styles.effBoxFallback}`}
        style={{ marginTop: 6 }}
      >
        {eff.text ?? '（生效值为空，LLM 看不到任何描述）'}
      </div>
      <div className={styles.caption}>
        ↑ <span className={styles.mono}>effective_*</span> = override ?? source
        —— <b>LLM / JEV 真正消费的只有这一行</b>
      </div>
    </div>
  );
};

const DocEditor: React.FC<DocEditorProps> = ({
  manifest,
  documentation,
  draft,
  dirty,
  saving,
  onDraftChange,
  onSave,
  onReset,
}) => {
  const { styles } = useStyles();
  const doc = toolDocstring(manifest);
  const paths = paramPaths(manifest, documentation);

  const rows = paths.map((path) => ({
    path,
    source: sourceParamDesc(manifest, path),
    override: draft.params[path] ?? '',
    orphan: isOrphanPath(manifest, path),
  }));

  const columns: TableColumnsType<(typeof rows)[number]> = [
    {
      title: 'parameter_path',
      dataIndex: 'path',
      width: 190,
      render: (path: string, row) => (
        <Space size={4} wrap>
          <Typography.Text className={styles.mono}>{path}</Typography.Text>
          {row.orphan ? (
            <Tooltip title="input_schema 里已经没有这个参数了 —— 这是一条孤儿覆盖，只在点了全表提交后才可能被清掉">
              <Tag color="error" style={{ fontSize: 10 }}>
                孤儿
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: '代码描述',
      dataIndex: 'source',
      render: (source: string | null) => (
        <div className={styles.cellSource}>{source ?? '（无）'}</div>
      ),
    },
    {
      title: '覆盖',
      dataIndex: 'override',
      width: '30%',
      render: (_: unknown, row) => (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 4 }}
          value={row.override}
          placeholder="留空 = 不覆盖"
          onChange={(e) =>
            onDraftChange({
              ...draft,
              params: { ...draft.params, [row.path]: e.target.value },
            })
          }
        />
      ),
    },
    {
      title: '生效',
      width: '24%',
      render: (_: unknown, row) => {
        const eff = effectiveText(row.override, row.source);
        return (
          <div
            className={`${styles.cellEffective} ${
              eff.fromOverride ? '' : styles.cellEffectiveFallback
            }`}
          >
            {eff.text ?? '（无）'}
          </div>
        );
      },
    },
    {
      title: '',
      width: 56,
      render: (_: unknown, row) =>
        normalizeOverride(row.override) ? (
          <Tooltip title="清除这条覆盖（提交时发 null）">
            <Button
              size="small"
              type="text"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  params: { ...draft.params, [row.path]: '' },
                })
              }
            >
              ×
            </Button>
          </Tooltip>
        ) : null,
    },
  ];

  return (
    <>
      <OverrideField
        title="Tool 整体描述"
        contractKey="description_override"
        source={doc.description ?? null}
        value={draft.descriptionOverride}
        onChange={(descriptionOverride) =>
          onDraftChange({ ...draft, descriptionOverride })
        }
      />

      <OverrideField
        title="返回值描述"
        contractKey="return_description_override"
        source={doc.returns ?? null}
        value={draft.returnDescriptionOverride}
        onChange={(returnDescriptionOverride) =>
          onDraftChange({ ...draft, returnDescriptionOverride })
        }
      />

      <div className={styles.docBlock}>
        <div className={styles.docBlockHead}>
          <Typography.Text strong>参数级描述</Typography.Text>
          <Tag>JSON Pointer</Tag>
          <span style={{ flex: 1 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {paths.length} 个路径
          </Typography.Text>
        </div>

        {rows.length ? (
          <Table
            size="small"
            rowKey="path"
            columns={columns}
            dataSource={rows}
            pagination={false}
            scroll={{ y: 420 }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="input_schema 里没有可描述的参数"
          />
        )}

        <div className={styles.caption} style={{ marginTop: 6 }}>
          路径从 <span className={styles.mono}>input_schema</span> 派生 （
          <span className={styles.mono}>/filters/date_from</span>{' '}
          这种嵌套写法）， 不手打。表里的路径 = schema ∪ source_docstring ∪
          已存覆盖 的<b>并集</b>
          ——
          代码删了参数但覆盖还在时，那条覆盖（标「孤儿」）也得看得见、删得掉。
        </div>
      </div>

      <Card size="small" title="PUT 请求体预览" style={{ marginTop: 12 }}>
        <pre className={styles.jsonBlock}>
          {JSON.stringify(buildDocPutBody(draft), null, 2)}
        </pre>
      </Card>

      {/* 操作行与处理链页签同一套：状态居左、按钮右对齐（styles.actionsRow） */}
      <div className={styles.actionsRow}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {dirty ? '有未保存的修改' : '已与服务端一致'}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Button disabled={!dirty} onClick={onReset}>
          放弃修改
        </Button>
        <Button
          type="primary"
          loading={saving}
          disabled={!dirty}
          onClick={onSave}
        >
          保存（全量替换）
        </Button>
      </div>
    </>
  );
};

export default DocEditor;
