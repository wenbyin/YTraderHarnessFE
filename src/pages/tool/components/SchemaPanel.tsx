// src/pages/tool/components/SchemaPanel.tsx
// Schema —— 只读，并且把「parameter_path 是怎么来的」摊开。
//
// 这一页存在的意义不是让人读 JSON（那玩意儿直接看 source 更快），
// 而是回答一个问题：**左边那张参数表里 /filters/date_from 凭什么是这个值？**
// 答案是它从 input_schema 递归走出来的。把它显式画出来，
// 用户才会相信「不能手改 parameter_path」不是前端偷懒。
import { Empty, Table, type TableColumnsType, Tag, Typography } from 'antd';
import React from 'react';
import {
  overrideAt,
  type SchemaNode,
  schemaPaths,
  sourceParamDesc,
  type ToolDocumentation,
  type ToolManifest,
} from '../data';
import { useStyles } from '../style';

interface SchemaPanelProps {
  manifest: ToolManifest;
  documentation: ToolDocumentation | null;
}

const SchemaPanel: React.FC<SchemaPanelProps> = ({
  manifest,
  documentation,
}) => {
  const { styles } = useStyles();
  const nodes = schemaPaths(manifest.input_schema);

  const columns: TableColumnsType<SchemaNode> = [
    {
      title: 'JSON Pointer',
      dataIndex: 'path',
      width: 200,
      render: (path: string) => (
        <Typography.Text className={styles.mono}>{path}</Typography.Text>
      ),
    },
    {
      title: 'kind',
      dataIndex: 'kind',
      width: 90,
      render: (kind: SchemaNode['kind']) => (
        <Tag color={kind === 'object' ? 'purple' : 'default'}>{kind}</Tag>
      ),
    },
    {
      title: 'schema.description',
      width: '30%',
      render: (_: unknown, row) => {
        const desc = row.schema?.description;
        return (
          <span style={{ color: '#595959' }}>
            {typeof desc === 'string' && desc.trim() ? desc : '—'}
          </span>
        );
      },
    },
    {
      title: '代码描述（派生后）',
      width: '26%',
      render: (_: unknown, row) => sourceParamDesc(manifest, row.path) ?? '—',
    },
    {
      title: '已有覆盖',
      width: 90,
      render: (_: unknown, row) =>
        overrideAt(documentation, row.path).trim() ? (
          <Tag color="blue">有</Tag>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <>
      <div className={styles.docBlock}>
        <div className={styles.docBlockHead}>
          <Typography.Text strong>
            input_schema → parameter_path 映射
          </Typography.Text>
          <Tag>只读</Tag>
          <span style={{ flex: 1 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {nodes.length} 个节点
          </Typography.Text>
        </div>
        {nodes.length ? (
          <Table
            size="small"
            rowKey="path"
            columns={columns}
            dataSource={nodes}
            pagination={false}
            scroll={{ y: 320 }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="input_schema 不是 object 或没有 properties"
          />
        )}
      </div>

      <div className={styles.docBlock}>
        <div className={styles.docBlockHead}>
          <Typography.Text strong>input_schema</Typography.Text>
          <Tag>只读</Tag>
        </div>
        <pre className={styles.jsonBlock}>
          {JSON.stringify(manifest.input_schema ?? {}, null, 2)}
        </pre>
      </div>

      <div className={styles.docBlock}>
        <div className={styles.docBlockHead}>
          <Typography.Text strong>output_schema</Typography.Text>
          <Tag color={manifest.output_schema ? 'default' : 'orange'}>
            {manifest.output_schema ? '只读' : '契约可空'}
          </Tag>
          <span style={{ flex: 1 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            yaml 里是 <span className={styles.mono}>nullable: true</span>
          </Typography.Text>
        </div>
        <pre className={styles.jsonBlock}>
          {JSON.stringify(manifest.output_schema ?? null, null, 2)}
        </pre>
      </div>
    </>
  );
};

export default SchemaPanel;
