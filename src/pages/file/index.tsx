// src/pages/file/index.tsx
// 文件管理页 —— 对接 YTraderHarness 后端 /api/v1/files
import {
  AppstoreOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PlusOutlined,
  TableOutlined,
} from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import {
  App,
  Badge,
  Button,
  Pagination,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useEffect, useRef, useState } from 'react';

import FileDetailDrawer from './components/FileDetailDrawer';
import FileGrid from './components/FileGrid';
import UploadModal from './components/UploadModal';
import type { FileListItem, FileStatus } from './data';
import { deleteFile, downloadFile, listFiles } from './service';
import { downloadMany, formatBytes, getFileTypeMeta, shortId } from './utils';

/** MIME 类型筛选项，value 走后端前缀匹配（如 image/ 匹配所有图片）。 */
const CONTENT_TYPE_ENUM: Record<string, { text: string }> = {
  'application/pdf': { text: 'application/pdf' },
  'text/csv': { text: 'text/csv' },
  'application/json': { text: 'application/json' },
  'application/zip': { text: 'application/zip' },
  'image/': { text: 'image/*（前缀匹配）' },
  'text/': { text: 'text/*（前缀匹配）' },
};

const FileListPage: React.FC = () => {
  const { message, modal } = App.useApp();
  const actionRef = useRef<ActionType | undefined>(undefined);

  const [tab, setTab] = useState<FileStatus>('active');
  const [view, setView] = useState<'table' | 'grid'>('table');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [selectedRows, setSelectedRows] = useState<FileListItem[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  // 切换 Tab 时清空选中项，避免跨状态误操作
  useEffect(() => {
    setSelectedRowKeys([]);
    setSelectedRows([]);
  }, [tab]);

  const reload = () => {
    setSelectedRowKeys([]);
    setSelectedRows([]);
    actionRef.current?.reload();
  };

  /** 单个删除：后端为逻辑删除，物理文件不立即清除。 */
  const handleDelete = (record: FileListItem) => {
    modal.confirm({
      title: '确认删除该文件？',
      icon: null,
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>{record.file_name}</div>
          <div style={{ fontSize: 13, opacity: 0.65 }}>
            删除为<b>逻辑删除</b>，文件状态将置为 <code>deleted</code>
            ，物理文件暂不清除。
          </div>
        </div>
      ),
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteFile(record.file_id);
        message.success('已逻辑删除');
        reload();
      },
    });
  };

  const handleBatchDelete = () => {
    modal.confirm({
      title: `确认删除选中的 ${selectedRows.length} 个文件？`,
      content: '删除为逻辑删除，文件状态将置为 deleted，物理文件暂不清除。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBatchLoading(true);
        try {
          await Promise.all(selectedRows.map((row) => deleteFile(row.file_id)));
          message.success(`已逻辑删除 ${selectedRows.length} 个文件`);
          reload();
        } finally {
          setBatchLoading(false);
        }
      },
    });
  };

  const handleDownload = async (record: FileListItem) => {
    try {
      await downloadFile(record.file_id, record.file_name);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '下载失败');
    }
  };

  const handleBatchDownload = async () => {
    setBatchLoading(true);
    try {
      await downloadMany(selectedRows);
    } finally {
      setBatchLoading(false);
    }
  };

  const columns: ProColumns<FileListItem>[] = [
    {
      title: '文件名',
      dataIndex: 'file_name',
      width: 300,
      ellipsis: true,
      fieldProps: { placeholder: '模糊匹配，不区分大小写' },
      render: (_, record) => {
        const meta = getFileTypeMeta(record.file_name);
        const IconComponent = meta.icon;
        return (
          <Space size={12}>
            <span
              style={{
                width: 40,
                height: 40,
                flex: '0 0 40px',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: meta.color,
                background: `${meta.color}14`,
                fontSize: 20,
              }}
            >
              <IconComponent />
            </span>
            <span style={{ minWidth: 0 }}>
              <Typography.Link
                onClick={() => setDetailId(record.file_id)}
                title={record.file_name}
                style={{ display: 'block', fontWeight: 500 }}
              >
                {record.file_name}
              </Typography.Link>
              <span style={{ fontSize: 12, opacity: 0.45 }}>
                {shortId(record.file_id)}
              </span>
            </span>
          </Space>
        );
      },
    },
    {
      title: '大小',
      dataIndex: 'file_size',
      width: 110,
      align: 'right',
      search: false,
      render: (_, record) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatBytes(record.file_size)}
        </span>
      ),
    },
    {
      title: 'MIME 类型',
      dataIndex: 'content_type',
      width: 190,
      valueType: 'select',
      valueEnum: CONTENT_TYPE_ENUM,
      fieldProps: { placeholder: '全部' },
      render: (_, record) => (
        <Tag color={getFileTypeMeta(record.file_name).tag}>
          <Typography.Text
            ellipsis={{ tooltip: true }}
            style={{ color: 'inherit' }}
          >
            {record.content_type ?? '-'}
          </Typography.Text>
        </Tag>
      ),
    },
    {
      title: 'SHA-256',
      dataIndex: 'checksum',
      width: 150,
      search: false,
      render: (_, record) => (
        <Typography.Text
          copyable={{
            text: record.checksum,
            tooltips: ['复制完整值', '已复制'],
          }}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        >
          {`${record.checksum.slice(0, 10)}…`}
        </Typography.Text>
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
      title: '上传者',
      dataIndex: 'uploaded_by',
      width: 140,
      fieldProps: { placeholder: '上传用户 UUID' },
      render: (_, record) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {shortId(record.uploaded_by)}
        </span>
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
      title: '操作',
      key: 'option',
      width: 150,
      valueType: 'option',
      fixed: 'right',
      render: (_, record) => [
        <Typography.Link key="download" onClick={() => handleDownload(record)}>
          下载
        </Typography.Link>,
        <Typography.Link
          key="detail"
          onClick={() => setDetailId(record.file_id)}
        >
          详情
        </Typography.Link>,
        <Typography.Link
          key="delete"
          disabled={record.status === 'deleted'}
          onClick={() => handleDelete(record)}
        >
          删除
        </Typography.Link>,
      ],
    },
    {
      // 仅用于查询表单：创建时间区间，映射到 created_from / created_to
      title: '创建时间',
      key: 'created_range',
      dataIndex: 'created_range',
      valueType: 'dateTimeRange',
      hideInTable: true,
      search: {
        transform: (value: any) => ({
          created_from: value?.[0],
          created_to: value?.[1],
        }),
      },
    },
  ];

  return (
    <PageContainer
      title="文件管理"
      content={
        <div style={{ maxWidth: 760 }}>
          统一管理上传的物理文件资产：支持按文件名、MIME
          类型与创建时间检索，查看存储位置与 SHA-256
          校验值，下载原始内容或执行逻辑删除。文件与文档解耦，删除仅标记为
          <code>deleted</code>，物理清理由后台任务完成。
        </div>
      }
      extra={[
        <Button
          key="upload"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setUploadOpen(true)}
        >
          上传文件
        </Button>,
      ]}
      tabList={[
        { tab: '正常', key: 'active' },
        { tab: '回收站', key: 'deleted' },
      ]}
      tabActiveKey={tab}
      onTabChange={(key) => setTab(key as FileStatus)}
    >
      <ProTable<FileListItem>
        actionRef={actionRef}
        rowKey="file_id"
        columns={columns}
        // 列宽合计 1352（多选 32 + 各列写死的宽度）。
        //
        // **必须配 scroll.x**：这张表列多且每列都写死了宽度，不设 scroll.x 时 antd
        // 不会生成横向滚动容器（.ant-table-content 的 overflow 仍是 visible），表格就
        // 直接撑到卡片外面去 —— 行内「删除」看不见，最后那列「操作」还会被挤出可视区，
        // 右侧 AI 助手面板一展开就把它整个盖住。设了 scroll.x 之后固定列（fixed:'right'）
        // 才会被钉在可视区右边缘、始终可点。文档库 / 文档类型定义两张表是同样写法。
        scroll={{ x: 1352 }}
        // status 由 Tab 控制，不作为查询表单项
        params={{ status: tab }}
        request={async (params) => {
          const { current, pageSize, ...rest } = params as Record<string, any>;
          const response = await listFiles({
            page: current,
            page_size: pageSize,
            file_name: rest.file_name || undefined,
            content_type: rest.content_type || undefined,
            uploaded_by: rest.uploaded_by || undefined,
            // 后端要求 datetime，统一转 ISO 8601 避免时区/格式歧义
            created_from: rest.created_from
              ? dayjs(rest.created_from).toISOString()
              : undefined,
            created_to: rest.created_to
              ? dayjs(rest.created_to).toISOString()
              : undefined,
            status: rest.status as FileStatus,
          });
          return {
            data: response?.items ?? [],
            success: true,
            total: response?.total ?? 0,
          };
        }}
        search={{ labelWidth: 'auto', defaultCollapsed: true }}
        options={{ reload: true, density: true, setting: true }}
        optionsRender={(_, defaultDom) => [
          <Segmented
            key="view"
            size="small"
            value={view}
            onChange={(value) => setView(value as 'table' | 'grid')}
            options={[
              { label: '表格', value: 'table', icon: <TableOutlined /> },
              { label: '网格', value: 'grid', icon: <AppstoreOutlined /> },
            ]}
          />,
          ...(defaultDom as React.ReactNode[]),
        ]}
        toolBarRender={() => [
          <Button
            key="batch-delete"
            danger
            icon={<DeleteOutlined />}
            disabled={selectedRowKeys.length === 0}
            loading={batchLoading}
            onClick={handleBatchDelete}
          >
            批量删除
          </Button>,
          <Button
            key="batch-download"
            icon={<DownloadOutlined />}
            disabled={selectedRowKeys.length === 0}
            loading={batchLoading}
            onClick={handleBatchDownload}
          >
            批量下载
          </Button>,
        ]}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys, rows) => {
            setSelectedRowKeys(keys);
            setSelectedRows(rows as FileListItem[]);
          },
        }}
        tableAlertRender={({ selectedRowKeys: keys, onCleanSelected }) => (
          <Space size={16}>
            <span>
              已选择 <b>{keys.length}</b> 项
            </span>
            <span style={{ opacity: 0.65 }}>
              合计{' '}
              {formatBytes(
                selectedRows.reduce((sum, row) => sum + row.file_size, 0),
              )}
            </span>
            <Typography.Link onClick={onCleanSelected}>
              取消选择
            </Typography.Link>
          </Space>
        )}
        tableAlertOptionRender={false}
        tableViewRender={(props, defaultDom) => {
          // defaultDom 是懒执行函数（pro-components 注释：需要默认 Table 时请调用），
          // 直接 return defaultDom 会把函数当 React 子节点，导致表格渲染为空。
          const defaultTable =
            typeof defaultDom === 'function' ? defaultDom() : defaultDom;
          if (view !== 'grid') return defaultTable;
          const paginationProps = props.pagination as any;
          return (
            <>
              <FileGrid
                dataSource={props.dataSource ?? []}
                selectedRowKeys={selectedRowKeys}
                onSelectionChange={(keys, rows) => {
                  setSelectedRowKeys(keys);
                  setSelectedRows(rows);
                }}
                onOpenDetail={(fileId) => setDetailId(fileId)}
                onDownload={handleDownload}
                onDelete={handleDelete}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  padding: '16px 24px',
                }}
              >
                <Pagination
                  current={paginationProps?.current}
                  pageSize={paginationProps?.pageSize}
                  total={paginationProps?.total}
                  showSizeChanger
                  showQuickJumper
                  showTotal={(total) => `共 ${total} 条`}
                  onChange={(page, size) =>
                    paginationProps?.onChange?.(page, size)
                  }
                />
              </div>
            </>
          );
        }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        dateFormatter="string"
      />

      <UploadModal
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        onSuccess={reload}
      />

      <FileDetailDrawer fileId={detailId} onClose={() => setDetailId(null)} />
    </PageContainer>
  );
};

export default FileListPage;
