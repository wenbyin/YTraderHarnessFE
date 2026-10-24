// src/pages/document/components/EditDocumentModal.tsx
// 编辑 Document 本体：PUT /documents/{id} { title, metadata }
// 只改本体，不创建新版本。document_key 与 document_type_definition_id 创建后不可修改。
import { EditOutlined } from '@ant-design/icons';
import {
  ModalForm,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import { App, Button } from 'antd';
import React from 'react';

import { updateDocument } from '../service';

interface EditDocumentModalProps {
  documentId: string;
  title: string | null;
  metadata: Record<string, any>;
  onSuccess: () => void;
}

const EditDocumentModal: React.FC<EditDocumentModalProps> = ({
  documentId,
  title,
  metadata,
  onSuccess,
}) => {
  const { message } = App.useApp();

  return (
    <ModalForm
      title="编辑文档信息"
      width={520}
      trigger={<Button icon={<EditOutlined />}>编辑</Button>}
      modalProps={{ destroyOnHidden: true }}
      initialValues={{
        title: title ?? '',
        metadata: JSON.stringify(metadata ?? {}, null, 2),
      }}
      onFinish={async (values: any) => {
        let parsed: Record<string, any> = {};
        try {
          parsed = values.metadata?.trim() ? JSON.parse(values.metadata) : {};
        } catch {
          message.error('metadata 不是合法 JSON');
          return false;
        }
        try {
          await updateDocument(documentId, {
            title: values.title || null,
            metadata: parsed,
          });
          message.success('已保存');
          onSuccess();
          return true;
        } catch (error) {
          message.error(error instanceof Error ? error.message : '保存失败');
          return false;
        }
      }}
    >
      <ProFormText
        name="title"
        label="标题"
        placeholder="留空则显示「（未命名）」"
        rules={[{ max: 500, message: '不超过 500 字' }]}
      />
      <ProFormTextArea
        name="metadata"
        label="文档级 metadata (JSON)"
        fieldProps={{ rows: 6, style: { fontFamily: 'monospace' } }}
      />
    </ModalForm>
  );
};

export default EditDocumentModal;
