// src/pages/document/components/UploadVersionModal.tsx
// 上传新版本：复用 File Service 上传拿到 file_id，再 PUT /documents/{id} { file_id }
// 追加一个新 DocumentVersion（version_number 由后端自增）。
//
// 409 场景：新文件与当前版本 checksum 相同，后端不会创建无意义的新版本。
import { UploadOutlined } from '@ant-design/icons';
import { ModalForm } from '@ant-design/pro-components';
import { App, Button, Form, Progress, Upload } from 'antd';
import React, { useState } from 'react';

import type { FileDetail } from '../../file/data';
import { uploadFile } from '../../file/service';
import { formatBytes } from '../fileInfo';
import { updateDocument } from '../service';

interface UploadVersionModalProps {
  documentId: string;
  onSuccess: () => void;
}

const UploadVersionModal: React.FC<UploadVersionModalProps> = ({
  documentId,
  onSuccess,
}) => {
  const { message } = App.useApp();
  const [uploaded, setUploaded] = useState<FileDetail | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const beforeUpload = async (file: File) => {
    setUploading(true);
    setProgress(0);
    setUploaded(null);
    try {
      const detail = await uploadFile(file, (p) => setProgress(p));
      setUploaded(detail);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading(false);
    }
    return false;
  };

  return (
    <ModalForm
      title="上传新版本"
      width={520}
      trigger={<Button icon={<UploadOutlined />}>上传新版本</Button>}
      modalProps={{
        destroyOnHidden: true,
        maskClosable: false,
      }}
      submitter={{ searchConfig: { submitText: '创建版本' } }}
      onFinish={async () => {
        if (!uploaded?.file_id) {
          message.error('请先上传文件');
          return false;
        }
        try {
          await updateDocument(documentId, { file_id: uploaded.file_id });
          message.success('新版本已创建');
          setUploaded(null);
          onSuccess();
          return true;
        } catch (error) {
          message.error(
            error instanceof Error ? error.message : '创建版本失败',
          );
          return false;
        }
      }}
    >
      <Form.Item
        label="新版本文件"
        required
        tooltip="上传完成后后端会自动创建下一个版本号（当前最大版本号 + 1）"
      >
        <div>
          <Upload
            maxCount={1}
            beforeUpload={beforeUpload}
            showUploadList={false}
            disabled={uploading}
          >
            <Button icon={<UploadOutlined />} loading={uploading}>
              {uploading ? '上传中…' : '选择并上传文件'}
            </Button>
          </Upload>
          {(uploading || uploaded) && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                {uploaded
                  ? `${uploaded.file_name}（${formatBytes(uploaded.file_size)}）`
                  : '上传中…'}
              </div>
              {uploading ? (
                <Progress percent={progress} size="small" />
              ) : (
                uploaded && (
                  <Progress percent={100} size="small" status="success" />
                )
              )}
            </div>
          )}
        </div>
      </Form.Item>
    </ModalForm>
  );
};

export default UploadVersionModal;
