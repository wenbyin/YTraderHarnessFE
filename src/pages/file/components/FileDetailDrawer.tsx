// src/pages/file/components/FileDetailDrawer.tsx
import {
  Badge,
  Button,
  Descriptions,
  Drawer,
  message,
  Skeleton,
  Space,
  Tag,
} from 'antd';
import dayjs from 'dayjs';
import React, { useEffect, useState } from 'react';

import type { FileDetail as FileDetailType } from '../data';
import { downloadFile, getFile } from '../service';
import { useStyles } from '../style';
import { formatBytes, getFileTypeMeta } from '../utils';

const DATE_FORMAT = 'YYYY-MM-DD HH:mm:ss';

interface FileDetailDrawerProps {
  /** 为 null 时关闭抽屉 */
  fileId: string | null;
  onClose: () => void;
}

const FileDetailDrawer: React.FC<FileDetailDrawerProps> = ({
  fileId,
  onClose,
}) => {
  const { styles } = useStyles();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FileDetailType | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [messageApi, messageHolder] = message.useMessage();

  useEffect(() => {
    if (!fileId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getFile(fileId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((error) => {
        if (!cancelled) {
          messageApi.error(error?.message ?? '加载文件详情失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, messageApi]);

  const handleDownload = async () => {
    if (!data) return;
    setDownloading(true);
    try {
      await downloadFile(data.file_id, data.file_name);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '下载失败');
    } finally {
      setDownloading(false);
    }
  };

  const meta = data ? getFileTypeMeta(data.file_name) : null;
  const IconComponent = meta?.icon;

  return (
    <Drawer
      title="文件详情"
      placement="right"
      size={720}
      open={Boolean(fileId)}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            loading={downloading}
            disabled={!data}
            onClick={handleDownload}
          >
            下载文件
          </Button>
        </Space>
      }
    >
      {messageHolder}
      {loading || !data ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <>
          <div className={styles.previewHero}>
            <div
              className={styles.previewHeroIcon}
              style={{ color: meta?.color }}
            >
              {IconComponent ? <IconComponent /> : null}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 600,
                  wordBreak: 'break-all',
                }}
              >
                {data.file_name}
              </div>
              <div
                style={{
                  marginTop: 6,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Tag color={meta?.tag}>{data.content_type ?? '未知类型'}</Tag>
                <Tag color={data.status === 'active' ? 'success' : 'default'}>
                  {data.status}
                </Tag>
                <span style={{ fontSize: 13, opacity: 0.65 }}>
                  {formatBytes(data.file_size)}
                </span>
              </div>
            </div>
          </div>

          <h3 className={styles.sectionTitle}>基础信息</h3>
          <Descriptions
            bordered
            column={2}
            size="small"
            items={[
              {
                key: 'file_id',
                label: 'file_id',
                span: 2,
                children: (
                  <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {data.file_id}
                  </span>
                ),
              },
              { key: 'file_name', label: '文件名', children: data.file_name },
              {
                key: 'file_size',
                label: '大小',
                children: `${formatBytes(data.file_size)}（${data.file_size.toLocaleString()} B）`,
              },
              {
                key: 'content_type',
                label: 'MIME 类型',
                children: data.content_type ?? '-',
              },
              {
                key: 'status',
                label: '状态',
                children:
                  data.status === 'active' ? (
                    <Badge status="success" text="正常" />
                  ) : (
                    <Badge status="default" text="已删除" />
                  ),
              },
              {
                key: 'tenant_id',
                label: '租户 ID',
                children: (
                  <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {data.tenant_id ?? '-'}
                  </span>
                ),
              },
              {
                key: 'uploaded_by',
                label: '上传者',
                children: (
                  <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {data.uploaded_by ?? '-'}
                  </span>
                ),
              },
            ]}
          />

          <h3 className={styles.sectionTitle} style={{ marginTop: 24 }}>
            存储信息
          </h3>
          <Descriptions
            bordered
            column={2}
            size="small"
            items={[
              {
                key: 'storage_backend',
                label: '后端',
                children: <Tag color="blue">{data.storage_backend}</Tag>,
              },
              {
                key: 'checksum',
                label: 'SHA-256',
                span: 2,
                children: (
                  <span
                    style={{
                      fontFamily: 'monospace',
                      fontSize: 12,
                      wordBreak: 'break-all',
                    }}
                  >
                    {data.checksum}
                  </span>
                ),
              },
              {
                key: 'storage_key',
                label: 'storage_key',
                span: 2,
                children: (
                  <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {data.storage_key}
                  </span>
                ),
              },
            ]}
          />

          <h3 className={styles.sectionTitle} style={{ marginTop: 24 }}>
            时间
          </h3>
          <Descriptions
            bordered
            column={2}
            size="small"
            items={[
              {
                key: 'created_at',
                label: '创建时间',
                children: dayjs(data.created_at).format(DATE_FORMAT),
              },
              {
                key: 'updated_at',
                label: '更新时间',
                children: dayjs(data.updated_at).format(DATE_FORMAT),
              },
              {
                key: 'deleted_at',
                label: '删除时间',
                span: 2,
                children: data.deleted_at
                  ? dayjs(data.deleted_at).format(DATE_FORMAT)
                  : '—',
              },
            ]}
          />

          <h3 className={styles.sectionTitle} style={{ marginTop: 24 }}>
            扩展 Metadata
          </h3>
          <pre className={styles.jsonBlock}>
            {JSON.stringify(data.metadata ?? {}, null, 2)}
          </pre>
        </>
      )}
    </Drawer>
  );
};

export default FileDetailDrawer;
