// src/pages/file/components/UploadModal.tsx
import { InboxOutlined } from '@ant-design/icons';
import { Button, Modal, message, Progress, Space, Tag, Upload } from 'antd';
import React, { useEffect, useState } from 'react';

import { uploadFile } from '../service';
import { useStyles } from '../style';
import { formatBytes } from '../utils';

interface UploadModalProps {
  open: boolean;
  onCancel: () => void;
  /** 全部文件上传成功后回调，用于刷新列表 */
  onSuccess: () => void;
}

type QueueStatus = 'pending' | 'uploading' | 'success' | 'error';

interface QueueItem {
  /** 本地唯一标识 */
  uid: string;
  file: File;
  percent: number;
  status: QueueStatus;
  error?: string;
}

const UploadModal: React.FC<UploadModalProps> = ({
  open,
  onCancel,
  onSuccess,
}) => {
  const { styles } = useStyles();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [messageApi, messageHolder] = message.useMessage();

  // 每次打开时重置队列，避免残留上一次的状态
  useEffect(() => {
    if (open) {
      setQueue([]);
      setUploading(false);
    }
  }, [open]);

  const patchItem = (uid: string, patch: Partial<QueueItem>) => {
    setQueue((prev) =>
      prev.map((item) => (item.uid === uid ? { ...item, ...patch } : item)),
    );
  };

  /**
   * 拦截 antd Upload 的自动上传，改为本地排队。
   * 返回 false 后文件不会进入受控 fileList，因此这里手动维护队列。
   */
  const beforeUpload = (file: File) => {
    setQueue((prev) => [
      ...prev,
      {
        uid: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        percent: 0,
        status: 'pending',
      },
    ]);
    return false;
  };

  const handleRemove = (uid: string) => {
    setQueue((prev) => prev.filter((item) => item.uid !== uid));
  };

  const handleUpload = async () => {
    if (queue.length === 0) {
      messageApi.warning('请先选择要上传的文件');
      return;
    }
    setUploading(true);

    let successCount = 0;
    let failureCount = 0;

    for (const item of queue) {
      if (item.status === 'success') continue;
      patchItem(item.uid, { status: 'uploading', percent: 0 });
      try {
        // eslint-disable-next-line no-await-in-loop
        await uploadFile(item.file, (percent) => {
          patchItem(item.uid, { percent });
        });
        patchItem(item.uid, { status: 'success', percent: 100 });
        successCount += 1;
      } catch (error) {
        patchItem(item.uid, {
          status: 'error',
          error: error instanceof Error ? error.message : '上传失败',
        });
        failureCount += 1;
      }
    }

    setUploading(false);

    if (failureCount === 0) {
      messageApi.success(`成功上传 ${successCount} 个文件`);
      onSuccess();
      onCancel();
    } else {
      messageApi.error(`${successCount} 个成功，${failureCount} 个失败`);
      if (successCount > 0) onSuccess();
    }
  };

  const pendingCount = queue.filter((item) => item.status !== 'success').length;

  return (
    <Modal
      title="上传文件"
      open={open}
      onCancel={uploading ? undefined : onCancel}
      mask={{ closable: !uploading }}
      width={560}
      footer={
        <Space>
          <Button onClick={onCancel} disabled={uploading}>
            取消
          </Button>
          <Button
            type="primary"
            loading={uploading}
            onClick={handleUpload}
            disabled={queue.length === 0}
          >
            {uploading ? '上传中' : `开始上传（${pendingCount}）`}
          </Button>
        </Space>
      }
    >
      {messageHolder}
      <Upload.Dragger
        multiple
        beforeUpload={beforeUpload}
        showUploadList={false}
        disabled={uploading}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点击或拖拽文件到此区域上传</p>
        <p className="ant-upload-hint">支持单个或批量上传</p>
      </Upload.Dragger>

      {queue.length > 0 && (
        <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
          {queue.map((item) => (
            <div key={item.uid} className={styles.queueItem}>
              <div className={styles.queueName}>
                <div className={styles.queueNameText}>{item.file.name}</div>
                <div className={styles.queueMeta}>
                  {formatBytes(item.file.size)} ·{' '}
                  {item.status === 'success'
                    ? '已完成'
                    : item.status === 'error'
                      ? item.error
                      : item.status === 'uploading'
                        ? '上传中'
                        : '等待上传'}
                </div>
                {item.status !== 'pending' && (
                  <Progress
                    percent={item.percent}
                    size="small"
                    status={
                      item.status === 'success'
                        ? 'success'
                        : item.status === 'error'
                          ? 'exception'
                          : 'active'
                    }
                  />
                )}
              </div>
              {item.status === 'success' ? (
                <Tag color="success">成功</Tag>
              ) : item.status === 'error' ? (
                <Tag color="error">失败</Tag>
              ) : (
                <Tag color="processing">{item.percent}%</Tag>
              )}
              {!uploading && item.status !== 'success' && (
                <Button
                  type="link"
                  size="small"
                  danger
                  onClick={() => handleRemove(item.uid)}
                >
                  移除
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};

export default UploadModal;
