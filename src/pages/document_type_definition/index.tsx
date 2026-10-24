// src/pages/document_type_definition/index.tsx
// 文档类型定义管理 —— 列表页（CRUD）。点击行进入详情页编辑 RAG 流水线。
import { DeleteOutlined, PartitionOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history } from '@umijs/max';
import { App, Badge, Space, Tag, Typography } from 'antd';
import React, { useRef } from 'react';

import TypeCreateModal from './components/TypeCreateModal';
import type { DocumentTypeDefinitionListItem } from './data';
import { ANALYSIS_MODE_OPTIONS, MODALITY_META } from './data';
import {
  deleteDocumentTypeDefinition,
  listDocumentTypeDefinitions,
} from './service';

const DocumentTypeListPage: React.FC = () => {
  const { message, modal } = App.useApp();
  const actionRef = useRef<ActionType | undefined>(undefined);

  const reload = () => actionRef.current?.reload();

  const handleDelete = (record: DocumentTypeDefinitionListItem) => {
    modal.confirm({
      title: '确认删除该文档类型？',
      icon: null,
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>{record.name}</div>
          <div style={{ fontSize: 13, opacity: 0.65 }}>
            删除为<b>逻辑删除</b>，其下流水线将一并移除。
          </div>
        </div>
      ),
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteDocumentTypeDefinition(record.document_type_definition_id);
        message.success('已删除');
        reload();
      },
    });
  };

  const columns: ProColumns<DocumentTypeDefinitionListItem>[] = [
    {
      title: '关键词',
      dataIndex: 'keyword',
      valueType: 'text',
      hideInTable: true,
      fieldProps: { placeholder: '按编码 / 名称模糊搜索' },
    },
    {
      title: '类型编码',
      dataIndex: 'type_key',
      width: 220,
      ellipsis: true,
      search: false,
      render: (_, record) => (
        <Typography.Link
          strong
          onClick={() =>
            history.push(
              `/document-type-definitions/${record.document_type_definition_id}`,
            )
          }
        >
          {record.type_key}
        </Typography.Link>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 200,
      ellipsis: true,
      search: false,
    },
    {
      title: '版本策略',
      dataIndex: 'version_mode',
      width: 120,
      search: false,
      valueType: 'select',
      valueEnum: {
        versioned: { text: '可版本化' },
        immutable: { text: '不可变' },
      },
      render: (_, record) => (
        <Tag color={record.version_mode === 'versioned' ? 'blue' : 'default'}>
          {record.version_mode === 'versioned' ? '可版本化' : '不可变'}
        </Tag>
      ),
    },
    {
      title: 'Modality',
      dataIndex: 'modality_type',
      width: 120,
      search: false,
      render: (_, record) => {
        const meta =
          MODALITY_META[record.modality_type as keyof typeof MODALITY_META];
        return meta ? (
          <Tag color={meta.color}>
            {meta.icon} {meta.label}
          </Tag>
        ) : (
          <span style={{ opacity: 0.4 }}>—</span>
        );
      },
    },
    {
      title: '解析模式',
      dataIndex: 'analysis_mode',
      width: 130,
      search: false,
      valueType: 'select',
      valueEnum: Object.fromEntries(
        ANALYSIS_MODE_OPTIONS.map((o) => [o.value, { text: o.label }]),
      ),
      render: (_, record) => {
        const opt = ANALYSIS_MODE_OPTIONS.find(
          (o) => o.value === record.analysis_mode,
        );
        return (
          <Tag color={record.analysis_mode === 'config' ? 'blue' : 'default'}>
            {opt?.label ?? record.analysis_mode}
          </Tag>
        );
      },
    },
    {
      title: 'Fusion',
      dataIndex: 'fusion_strategy',
      width: 140,
      search: false,
      render: (_, record) =>
        record.fusion_strategy ? (
          <Tag color="purple">{record.fusion_strategy}</Tag>
        ) : (
          <span style={{ opacity: 0.4 }}>—</span>
        ),
    },
    {
      title: 'Rerank',
      dataIndex: 'rerank_strategy',
      width: 140,
      search: false,
      render: (_, record) =>
        record.rerank_strategy ? (
          <Tag color="blue">{record.rerank_strategy}</Tag>
        ) : (
          <span style={{ opacity: 0.4 }}>—</span>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      search: false,
      render: (_, record) =>
        record.status === 'active' ? (
          <Badge status="success" text="正常" />
        ) : (
          <Badge status="default" text="已删除" />
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      width: 180,
      valueType: 'dateTime',
      search: false,
    },
    {
      title: '操作',
      key: 'option',
      width: 160,
      valueType: 'option',
      fixed: 'right',
      render: (_, record) => [
        <Typography.Link
          key="detail"
          onClick={() =>
            history.push(
              `/document-type-definitions/${record.document_type_definition_id}`,
            )
          }
        >
          <Space size={4}>
            <PartitionOutlined />
            查看流水线
          </Space>
        </Typography.Link>,
        <Typography.Link
          key="delete"
          disabled={record.status === 'deleted'}
          onClick={() => handleDelete(record)}
        >
          <Space size={4}>
            <DeleteOutlined />
            删除
          </Space>
        </Typography.Link>,
      ],
    },
  ];

  return (
    <PageContainer
      title="文档类型定义"
      content="定义业务文档类型及其检索策略。两阶段模型：Analyzer（loader→processor，绑定文件后缀）与 Retrieval（chunker→retriever，绑定检索类型），通过 N:N 绑定连接。"
      // 「新建文档类型」放页头右上角（与「文件管理」的上传文件按钮同一位置），
      // 不占表格工具栏 —— 工具栏留给 ProTable 自己的刷新/密度/列设置。
      extra={[<TypeCreateModal key="create" reload={reload} />]}
      tabList={[{ tab: '文档类型', key: 'list' }]}
      tabActiveKey="list"
    >
      <ProTable<DocumentTypeDefinitionListItem>
        actionRef={actionRef}
        rowKey="document_type_definition_id"
        columns={columns}
        request={async (params) => {
          const { current, pageSize, ...rest } = params as Record<string, any>;
          const response = await listDocumentTypeDefinitions({
            page: current,
            page_size: pageSize,
            keyword: rest.keyword || undefined,
            status: rest.status || undefined,
          });
          return {
            data: response?.items ?? [],
            success: true,
            total: response?.total ?? 0,
          };
        }}
        search={{ labelWidth: 'auto' }}
        options={{ reload: true, density: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        dateFormatter="string"
        scroll={{ x: 1200 }}
      />
    </PageContainer>
  );
};

export default DocumentTypeListPage;
