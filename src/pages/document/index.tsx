// src/pages/document/index.tsx
// Document 管理列表页。点击标题 / 查看进入详情页。
// 对接真实后端 /api/v1/documents（无 mock，与 file 页一致）。
//
// 新契约下列表项只有 document_type_definition_id 与 current_document_version_id：
// 类型名通过 typeMap 回查，版本号列表接口不返回，这里展示版本 ID 短码。
import { FileTextOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history } from '@umijs/max';
import { App, Badge, Popconfirm, Space, Tag, Typography } from 'antd';
import React, { useRef, useState } from 'react';

import CreateDocumentModal from './components/CreateDocumentModal';
import type { DocumentResponse, DocumentStatus } from './data';
import { deleteDocument, listDocuments } from './service';
import { fetchTypeMap, typeLabel, useTypeMap } from './typeMap';

const DocumentListPage: React.FC = () => {
  const actionRef = useRef<ActionType | undefined>(undefined);
  const { message } = App.useApp();
  // 状态由 Tab 控制，作为查询表单的固定参数透传给后端。
  const [tab, setTab] = useState<DocumentStatus>('active');
  const typeMap = useTypeMap();

  const reload = () => actionRef.current?.reload();

  const columns: ProColumns<DocumentResponse>[] = [
    {
      title: '关键词',
      dataIndex: 'keyword',
      valueType: 'text',
      hideInTable: true,
      fieldProps: { placeholder: '按标题 / 业务标识模糊搜索' },
    },
    {
      title: '文档类型',
      dataIndex: 'document_type_definition_id',
      valueType: 'select',
      width: 200,
      ellipsis: true,
      request: async () => {
        const map = await fetchTypeMap();
        return [...map.entries()].map(([value, info]) => ({
          value,
          label: `${info.name}（${info.type_key}）`,
        }));
      },
      render: (_, record) => (
        <Tag color="blue">
          {typeLabel(typeMap, record.document_type_definition_id)}
        </Tag>
      ),
    },
    {
      title: '标题',
      dataIndex: 'title',
      width: 260,
      ellipsis: true,
      search: false,
      render: (_, record) => (
        <Space size={10}>
          <FileTextOutlined style={{ color: 'var(--ant-color-primary)' }} />
          <Typography.Link
            strong
            onClick={() => history.push(`/documents/${record.document_id}`)}
          >
            {record.title || '（未命名）'}
          </Typography.Link>
        </Space>
      ),
    },
    {
      title: '业务标识',
      dataIndex: 'document_key',
      width: 180,
      ellipsis: true,
      search: false,
      render: (_, record) =>
        record.document_key ?? <span style={{ opacity: 0.4 }}>—</span>,
    },
    {
      title: '当前版本',
      dataIndex: 'current_document_version_id',
      width: 130,
      search: false,
      tooltip: '列表接口只返回版本 ID，版本号请在详情页查看',
      render: (_, record) =>
        record.current_document_version_id ? (
          <Typography.Text
            copyable={{ text: record.current_document_version_id }}
            style={{ fontSize: 12, fontFamily: 'monospace' }}
          >
            {record.current_document_version_id.slice(0, 8)}…
          </Typography.Text>
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
      title: '创建时间',
      dataIndex: 'created_at',
      width: 180,
      valueType: 'dateTime',
      search: false,
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
      width: 120,
      valueType: 'option',
      fixed: 'right',
      render: (_, record) => [
        <Typography.Link
          key="detail"
          onClick={() => history.push(`/documents/${record.document_id}`)}
        >
          查看
        </Typography.Link>,
        record.status === 'active' ? (
          <Popconfirm
            key="delete"
            title="确认删除该文档？"
            description="逻辑删除，历史版本与文件不会被物理删除。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await deleteDocument(record.document_id);
                message.success('已删除');
                reload();
              } catch (error) {
                message.error(
                  error instanceof Error ? error.message : '删除失败',
                );
              }
            }}
          >
            <Typography.Link type="danger">删除</Typography.Link>
          </Popconfirm>
        ) : null,
      ],
    },
  ];

  return (
    <PageContainer
      title="文档管理"
      content="基于已上传文件与文档类型创建 Document，查看各版本的处理进度与 Chunk。点击行进入详情可上传新版本、切换生效版本并查看分块内容。"
      // 「新建文档」放页头右上角（与「文件管理」的上传文件按钮同一位置），
      // 不占表格工具栏 —— 工具栏留给 ProTable 自己的刷新/密度/列设置。
      extra={[<CreateDocumentModal key="create" reload={reload} />]}
      tabList={[
        { tab: '正常', key: 'active' },
        { tab: '回收站', key: 'deleted' },
      ]}
      tabActiveKey={tab}
      onTabChange={(key) => setTab(key as DocumentStatus)}
    >
      <ProTable<DocumentResponse>
        actionRef={actionRef}
        rowKey="document_id"
        columns={columns}
        params={{ status: tab }}
        request={async (params) => {
          const { current, pageSize, ...rest } = params as Record<string, any>;
          const response = await listDocuments({
            page: current,
            page_size: pageSize,
            keyword: rest.keyword || undefined,
            status: rest.status || undefined,
            document_type_definition_id:
              rest.document_type_definition_id || undefined,
          });
          return {
            data: response?.items ?? [],
            success: true,
            total: response?.total ?? 0,
          };
        }}
        search={{ labelWidth: 'auto', defaultCollapsed: true }}
        options={{ reload: true, density: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        dateFormatter="string"
        scroll={{ x: 1400 }}
      />
    </PageContainer>
  );
};

export default DocumentListPage;
