// src/pages/document/components/CreateDocumentModal.tsx
// 新建 Document：选择一个文档类型（document_type_definition）+ 上传源文件，
// 后端用返回的 file_id 创建 Document 及其首个 DocumentVersion。
// 注：后端不存在 "document_type_version"，创建引用的是 document_type_definition_id。
import { PlusOutlined, UploadOutlined } from '@ant-design/icons';
import {
  ModalForm,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import { history } from '@umijs/max';
import { App, Button, Form, Progress, Upload } from 'antd';
import React, { useState } from 'react';
import type { DocumentTypeDefinitionListItem } from '../../document_type_definition/data';
import { listDocumentTypeDefinitions } from '../../document_type_definition/service';
import type { FileDetail } from '../../file/data';
import { uploadFile } from '../../file/service';
import { formatBytes } from '../fileInfo';
import { createDocument } from '../service';

interface CreateDocumentModalProps {
  /** 列表刷新回调（创建后跳详情，可不依赖此刷新）。 */
  reload?: () => void;
}

const parseMetadata = (str?: string): Record<string, any> | null => {
  const trimmed = (str ?? '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const CreateDocumentModal: React.FC<CreateDocumentModalProps> = () => {
  const { message } = App.useApp();

  // 上传结果直接复用 File Service 的 FileDetail（含 file_name / file_size / content_type）
  const [uploaded, setUploaded] = useState<FileDetail | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  // 手动上传：阻止 antd 自带上传，用后端 multipart 接口拿 file_id。
  const beforeUpload = async (file: File) => {
    setUploading(true);
    setProgress(0);
    setUploaded(null);
    try {
      const detail = await uploadFile(file, (p) => setProgress(p));
      setUploaded(detail);
      message.success('文件上传完成');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading(false);
    }
    return false;
  };

  return (
    <ModalForm
      title="新建文档"
      width={640}
      trigger={
        // 页头右上角的入口按钮：与「文件管理」的上传文件、「文档类型定义」的新建
        // 保持同一套外观（primary + 加号）。弹窗内侧那个「选择并上传文件」仍用上传图标
        // —— 那个按钮的动作才是"上传"。
        <Button type="primary" icon={<PlusOutlined />}>
          新建文档
        </Button>
      }
      modalProps={{ destroyOnHidden: true, maskClosable: false }}
      initialValues={{ title: undefined, document_key: undefined }}
      submitter={{ searchConfig: { submitText: '创建' } }}
      onFinish={async (values: any) => {
        if (!uploaded?.file_id) {
          message.error('请先上传源文件');
          return false;
        }
        const metadata = parseMetadata(values.metadata);
        if (metadata === null) {
          message.error('metadata 不是合法 JSON');
          return false;
        }
        try {
          const created = await createDocument({
            file_id: uploaded.file_id,
            document_type_definition_id: values.document_type_definition_id,
            // 标题留空时回落到文件名，避免详情页出现「未命名」
            title: values.title || uploaded.file_name || null,
            document_key: values.document_key || null,
            // 复用上面已经校验过的结果，避免重复解析
            metadata,
          });
          message.success('已创建，进入详情查看处理进度');
          history.push(`/documents/${created.document_id}`);
          return true;
        } catch (error) {
          message.error(error instanceof Error ? error.message : '创建失败');
          return false;
        }
      }}
    >
      <ProFormSelect
        name="document_type_definition_id"
        label="文档类型"
        placeholder="选择该文档归属的文档类型"
        rules={[{ required: true, message: '请选择文档类型' }]}
        request={async () => {
          const res = await listDocumentTypeDefinitions({
            page: 1,
            page_size: 100,
            status: 'active',
          });
          return (res.items ?? []).map(
            (item: DocumentTypeDefinitionListItem) => ({
              label: `${item.name}（${item.type_key}）`,
              value: item.document_type_definition_id,
            }),
          );
        }}
      />
      <ProFormText
        name="title"
        label="标题"
        placeholder="可选；默认取文件名"
        rules={[{ max: 500, message: '不超过 500 字' }]}
      />
      <ProFormText
        name="document_key"
        label="业务标识"
        placeholder="可选；同类型下唯一稳定标识"
        rules={[{ max: 255, message: '不超过 255 字' }]}
      />
      <ProFormTextArea
        name="metadata"
        label="文档级 metadata (JSON)"
        placeholder="{}"
        fieldProps={{ rows: 2, style: { fontFamily: 'monospace' } }}
      />
      <Form.Item
        label="源文件"
        required
        tooltip="需先上传，后端用返回的 file_id 创建 Document 并匹配 Pipeline"
      >
        <div>
          <Upload
            maxCount={1}
            accept=".pdf,.md,.html,.txt,.csv,.json,.docx,.zip"
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
                  ? `${uploaded.file_name}（${formatBytes(uploaded.file_size)}${
                      uploaded.content_type ? ` · ${uploaded.content_type}` : ''
                    }）`
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

export default CreateDocumentModal;
