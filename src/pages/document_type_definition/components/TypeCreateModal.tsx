// src/pages/document_type_definition/components/TypeCreateModal.tsx
// 新建文档类型定义（基础信息）。创建后跳转到详情页以编辑两阶段 N:N 处理流水线。
import { PlusOutlined } from '@ant-design/icons';
import {
  ModalForm,
  ProFormGroup,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import { history } from '@umijs/max';
import { App, Button } from 'antd';
import React from 'react';

import {
  ANALYSIS_MODE_OPTIONS,
  FUSION_STRATEGY_OPTIONS,
  MODALITY_OPTIONS,
  RERANK_STRATEGY_OPTIONS,
  VERSION_MODE_OPTIONS,
} from '../data';
import { createDocumentTypeDefinition } from '../service';

const parseConfig = (str?: string): Record<string, any> => {
  const trimmed = (str ?? '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
};

interface TypeCreateModalProps {
  /** 列表刷新回调（创建后跳转详情，可不依赖此刷新）。 */
  reload?: () => void;
}

const TypeCreateModal: React.FC<TypeCreateModalProps> = () => {
  const { message } = App.useApp();

  return (
    <ModalForm
      title="新建文档类型"
      width={640}
      trigger={
        <Button type="primary" icon={<PlusOutlined />}>
          新建文档类型
        </Button>
      }
      modalProps={{ destroyOnHidden: true, maskClosable: false }}
      initialValues={{
        version_mode: 'versioned',
        allow_update: true,
        analysis_mode: 'default',
        fusion_strategy: '',
        rerank_strategy: '',
      }}
      submitter={{ searchConfig: { submitText: '创建' } }}
      onFinish={async (values: any) => {
        try {
          const created = await createDocumentTypeDefinition({
            type_key: values.type_key,
            name: values.name,
            description: values.description || null,
            modality_type: values.modality_type,
            analysis_mode: values.analysis_mode,
            allow_update: values.allow_update ?? true,
            version_mode: values.version_mode,
            fusion_strategy: values.fusion_strategy || null,
            fusion_config: parseConfig(values.fusion_config),
            rerank_strategy: values.rerank_strategy || null,
            rerank_config: parseConfig(values.rerank_config),
            processors: [],
            retrievals: [],
            bindings: [],
          });
          message.success('已创建，进入详情配置流水线');
          history.push(
            `/document-type-definitions/${created.document_type_definition_id}`,
          );
          return true;
        } catch (error) {
          message.error(error instanceof Error ? error.message : '创建失败');
          return false;
        }
      }}
    >
      <ProFormText
        name="type_key"
        label="类型编码"
        placeholder="如 company_announcement（创建后不可修改）"
        rules={[
          { required: true, message: '请输入类型编码' },
          {
            pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/,
            message: '以字母开头，仅含字母、数字、下划线',
          },
        ]}
      />
      <ProFormText
        name="name"
        label="名称"
        placeholder="如 公司公告"
        rules={[{ required: true, message: '请输入名称' }]}
      />
      <ProFormTextArea
        name="description"
        label="业务描述"
        placeholder="该文档类型的业务语义描述"
        fieldProps={{ rows: 3 }}
      />
      <ProFormSelect
        name="modality_type"
        label="模型类型"
        width="sm"
        options={MODALITY_OPTIONS}
        tooltip="创建后不可修改；决定该类型可承载的文件模态"
        rules={[{ required: true, message: '请选择 模型类型' }]}
      />
      <ProFormSelect
        name="analysis_mode"
        label="解析模式"
        width="sm"
        options={ANALYSIS_MODE_OPTIONS}
        tooltip="default=系统.*自动连全部检索；config=自定义 N:N；none=不解析"
        rules={[{ required: true, message: '请选择解析模式' }]}
      />
      <ProFormSelect
        name="version_mode"
        label="版本策略"
        width="sm"
        options={VERSION_MODE_OPTIONS}
        rules={[{ required: true, message: '请选择版本策略' }]}
      />
      <ProFormSwitch
        name="allow_update"
        label="允许更新"
        tooltip="文档级是否允许覆盖更新"
      />
      <ProFormGroup title="Fusion / Rerank" size={8}>
        <ProFormSelect
          name="fusion_strategy"
          label="Fusion 策略"
          width="sm"
          options={FUSION_STRATEGY_OPTIONS}
          tooltip="多 Index 召回结果的融合策略；选“不融合”则为空"
        />
        <ProFormTextArea
          name="fusion_config"
          label="Fusion 配置 (JSON)"
          width="md"
          fieldProps={{ rows: 2, style: { fontFamily: 'monospace' } }}
          placeholder="{}"
        />
        <ProFormSelect
          name="rerank_strategy"
          label="Rerank 策略"
          width="sm"
          options={RERANK_STRATEGY_OPTIONS}
          tooltip="Fusion 后是否重排；选“不重排”则为空"
        />
        <ProFormTextArea
          name="rerank_config"
          label="Rerank 配置 (JSON)"
          width="md"
          fieldProps={{ rows: 2, style: { fontFamily: 'monospace' } }}
          placeholder="{}"
        />
      </ProFormGroup>
    </ModalForm>
  );
};

export default TypeCreateModal;
