// src/pages/document_type_definition/detail.tsx
// 文档类型详情页：编辑基础信息 + 可视化两阶段 N:N 处理流水线（嵌入 React Flow）。
//  - 返回链接融合进页面顶部（非按钮）。
//  - modality_type 创建后不可修改（只读）。
//  - analysis_mode 决定解析方式：default（.* 自动连全部 Retrieval）/ config（自定义 N:N）/ none（不解析）。
//  - 阶段1 [loader→processor] = Analyzer（按 file_extension 区分）；阶段2 [chunker→retriever] = Retrieval（按 retrieval_type 区分）；
//    bindings = N:N 关系表，用 (processors 下标, retrievals 下标) 链接——
//    新建的子项还没有 uuid，无法用 uuid 建边；由后端先插入拿到 uuid 再按下标完成链接。
import {
  PageContainer,
  ProForm,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import { Link, useParams } from '@umijs/max';
import {
  App,
  Button,
  Card,
  Empty,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import PipelineGraph from './components/PipelineGraph';
import {
  ANALYSIS_MODE_HINT,
  ANALYSIS_MODE_OPTIONS,
  type AnalysisMode,
  type BindingEditorItem,
  type DocumentProcessorDefinitionItem,
  type DocumentProcessorDefinitionResponse,
  type DocumentRetrievalDefinitionItem,
  type DocumentRetrievalDefinitionResponse,
  type DocumentTypeDefinitionDetail,
  defaultDatasource,
  FUSION_STRATEGY_OPTIONS,
  MODALITY_META,
  MODALITY_OPTIONS,
  type ModalityType,
  type ProcessorEditorItem,
  type ProcessorRetrievalBindingResponse,
  RERANK_STRATEGY_OPTIONS,
  RETRIEVER_BY_TYPE,
  type RetrievalEditorItem,
  type RetrievalType,
  type StorageBackend,
  SUFFIX_OPTIONS,
  VERSION_MODE_OPTIONS,
} from './data';
import {
  getDocumentTypeDefinition,
  updateDocumentTypeDefinition,
} from './service';
import { useStyles } from './style';

/** JSON 字符串 → 对象；空串视为 {}；非法 JSON 返回 null（调用方据此拦截保存）。 */
const parseConfig = (str?: string): Record<string, any> | null => {
  const t = (str ?? '').trim();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

const toProcEditor = (
  p: DocumentProcessorDefinitionResponse,
): ProcessorEditorItem => ({
  file_extension: p.file_extension,
  loader_name: p.loader_name,
  loader_config: JSON.stringify(p.loader_config ?? {}, null, 2),
  processor_name: p.processor_name ?? '',
  processor_config: JSON.stringify(p.processor_config ?? {}, null, 2),
});

const toRetrEditor = (
  r: DocumentRetrievalDefinitionResponse,
): RetrievalEditorItem => ({
  retrieval_type: r.retrieval_type,
  chunker_name: r.chunker_name ?? '',
  chunker_config: JSON.stringify(r.chunker_config ?? {}, null, 2),
  retriever_name: r.retriever_name ?? '',
  retriever_config: JSON.stringify(r.retriever_config ?? {}, null, 2),
  storage_backend: (r.storage_backend ?? '') as StorageBackend,
  storage_config: JSON.stringify(r.storage_config ?? {}, null, 2),
});

/**
 * 后端返回的绑定 → 编辑器内部的下标绑定。
 * 后端若已返回 processor_index / retrieval_index 则直接用；
 * 否则用 (file_extension, retrieval_type) 在各自数组里反查下标。
 */
const toBindingEditor = (
  bs: ProcessorRetrievalBindingResponse[],
  ps: DocumentProcessorDefinitionResponse[],
  rs: DocumentRetrievalDefinitionResponse[],
): BindingEditorItem[] => {
  const out: BindingEditorItem[] = [];
  for (const b of bs) {
    const i =
      b.processor_index ??
      (b.file_extension
        ? ps.findIndex((p) => p.file_extension === b.file_extension)
        : -1);
    const j =
      b.retrieval_index ??
      (b.retrieval_type
        ? rs.findIndex((r) => r.retrieval_type === b.retrieval_type)
        : -1);
    if (i >= 0 && j >= 0) out.push({ processor_index: i, retrieval_index: j });
  }
  return out;
};

/**
 * 删除某一侧的第 idx 项后重排绑定下标：
 * 引用该项的绑定直接丢弃，位于其后的下标整体前移 1 位。
 */
const remapAfterRemove = (
  list: BindingEditorItem[],
  side: 'processor' | 'retrieval',
  idx: number,
): BindingEditorItem[] => {
  const key = side === 'processor' ? 'processor_index' : 'retrieval_index';
  return list
    .filter((b) => b[key] !== idx)
    .map((b) => (b[key] > idx ? { ...b, [key]: b[key] - 1 } : b));
};

/** 取一个当前未使用的后缀名作为新增 Analyzer 默认值。 */
const pickFreeSuffix = (used: string[]): string => {
  const free = SUFFIX_OPTIONS.map((o) => o.value).filter(
    (v) => v !== '.*' && !used.includes(v),
  );
  return free[0] ?? '.pdf';
};

/** 取一个当前未使用的检索类型作为新增 Retrieval 默认值。 */
const pickFreeRetrievalType = (used: RetrievalType[]): RetrievalType => {
  const all: RetrievalType[] = [
    'document',
    'keyword',
    'sparse_vector',
    'dense_vector',
    'graph',
  ];
  return all.find((t) => !used.includes(t)) ?? 'dense_vector';
};

const DocumentTypeDetailPage: React.FC = () => {
  const { typeId } = useParams<{ typeId: string }>();
  const { message } = App.useApp();
  const { styles } = useStyles();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<DocumentTypeDefinitionDetail | null>(
    null,
  );

  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('default');
  const [processors, setProcessors] = useState<ProcessorEditorItem[]>([]);
  const [retrievals, setRetrievals] = useState<RetrievalEditorItem[]>([]);
  const [bindings, setBindings] = useState<BindingEditorItem[]>([]);

  const baseFormRef = useRef<any>(undefined);

  const load = useCallback(async () => {
    if (!typeId) return;
    setLoading(true);
    try {
      const data = await getDocumentTypeDefinition(typeId);
      setDetail(data);
      setAnalysisMode(data.analysis_mode);
      const procs = (data.processors ?? []).map(toProcEditor);
      const retrs = (data.retrievals ?? []).map(toRetrEditor);
      setProcessors(procs);
      setRetrievals(retrs);
      // 绑定以数组下标链接（后端返回的可能是自然键，这里统一反查成下标）
      setBindings(
        toBindingEditor(
          data.bindings ?? [],
          data.processors ?? [],
          data.retrievals ?? [],
        ),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载详情失败');
    } finally {
      setLoading(false);
    }
  }, [typeId, message]);

  useEffect(() => {
    load();
  }, [load]);

  /** 切换 analysis_mode 时的结构性清理。 */
  const handleModeChange = (val: AnalysisMode) => {
    setAnalysisMode(val);
    if (val === 'default') {
      // 仅清前处理与绑定；检索保留（服务端按 .* 自动全绑定）。
      setProcessors([]);
      setBindings([]);
    } else if (val === 'none') {
      setProcessors([]);
      setRetrievals([]);
      setBindings([]);
    }
    // config：保留检索；前处理由用户自行增删。
  };

  // ---------------- 子项编辑回调 ----------------
  const onAddProcessor = () => {
    const ext = pickFreeSuffix(processors.map((p) => p.file_extension));
    setProcessors((prev) => [
      ...prev,
      {
        file_extension: ext,
        loader_name: 'text_loader',
        loader_config: '{}',
        processor_name: '',
        processor_config: '{}',
      },
    ]);
  };

  /** 下标即身份：改字段不影响绑定，只需原地替换。 */
  const onUpdateProcessor = (
    idx: number,
    patch: Partial<ProcessorEditorItem>,
  ) => {
    setProcessors((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    );
  };

  const onRemoveProcessor = (idx: number) => {
    setProcessors((prev) => prev.filter((_, i) => i !== idx));
    setBindings((prev) => remapAfterRemove(prev, 'processor', idx));
  };

  const onAddRetrieval = () => {
    const rt = pickFreeRetrievalType(retrievals.map((r) => r.retrieval_type));
    setRetrievals((prev) => [
      ...prev,
      {
        retrieval_type: rt,
        chunker_name: 'fixed_chunker',
        chunker_config: '{}',
        // 检索器与数据源都由 retrieval_type 强绑定，新建即取推导值
        retriever_name: RETRIEVER_BY_TYPE[rt].value,
        retriever_config: '{}',
        storage_backend: defaultDatasource(rt),
        storage_config: '{}',
      },
    ]);
  };

  const onUpdateRetrieval = (
    idx: number,
    patch: Partial<RetrievalEditorItem>,
  ) => {
    setRetrievals((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  };

  const onRemoveRetrieval = (idx: number) => {
    setRetrievals((prev) => prev.filter((_, i) => i !== idx));
    setBindings((prev) => remapAfterRemove(prev, 'retrieval', idx));
  };

  const handleSaveAll = async () => {
    if (!typeId || !detail) return;
    let values: any;
    try {
      values = await baseFormRef.current?.validateFields();
    } catch {
      message.warning('请先完善基础信息');
      return;
    }

    // 校验所有 JSON 配置合法
    const allConfigs = [
      ...processors.flatMap((p) => [p.loader_config, p.processor_config]),
      ...retrievals.flatMap((r) => [
        r.chunker_config,
        r.retriever_config,
        r.storage_config,
      ]),
      values.fusion_config,
      values.rerank_config,
    ];
    for (const c of allConfigs) {
      if (parseConfig(c) === null) {
        message.error('存在非法的 JSON 配置，请检查后再保存');
        return;
      }
    }

    setSaving(true);
    try {
      const procItems: DocumentProcessorDefinitionItem[] =
        analysisMode === 'config'
          ? processors.map((p) => ({
              file_extension: p.file_extension,
              mime_types: [],
              loader_name: p.loader_name,
              loader_config: parseConfig(p.loader_config) ?? {},
              processor_name: p.processor_name || null,
              processor_config: parseConfig(p.processor_config) ?? {},
            }))
          : [];
      const retrItems: DocumentRetrievalDefinitionItem[] = retrievals.map(
        (r) => ({
          retrieval_type: r.retrieval_type,
          chunker_name: r.chunker_name || null,
          chunker_config: parseConfig(r.chunker_config) ?? {},
          // 检索器与数据源由 retrieval_type 强绑定：提交时统一归一化，
          // 存量数据（旧值/空值）也会在这次保存中被校正。
          retriever_name: RETRIEVER_BY_TYPE[r.retrieval_type]?.value || null,
          retriever_config: parseConfig(r.retriever_config) ?? {},
          storage_backend: defaultDatasource(r.retrieval_type) || undefined,
          storage_config: parseConfig(r.storage_config) ?? {},
        }),
      );
      // 绑定按下标下发：后端先插入 processors / retrievals 拿到 uuid，再按下标完成链接。
      const bindingItems: BindingEditorItem[] =
        analysisMode === 'config'
          ? bindings.filter(
              (b) =>
                b.processor_index >= 0 &&
                b.processor_index < processors.length &&
                b.retrieval_index >= 0 &&
                b.retrieval_index < retrievals.length,
            )
          : [];

      await updateDocumentTypeDefinition(typeId, {
        revision: detail.revision,
        name: values.name,
        description: values.description || null,
        analysis_mode: analysisMode,
        allow_update: values.allow_update ?? true,
        version_mode: values.version_mode,
        fusion_strategy: values.fusion_strategy || null,
        fusion_config: parseConfig(values.fusion_config) ?? {},
        rerank_strategy: values.rerank_strategy || null,
        rerank_config: parseConfig(values.rerank_config) ?? {},
        processors: procItems,
        retrievals: retrItems,
        bindings: bindingItems,
      });

      // 重新拉取权威状态（revision 已 +1，需以服务端为准）。
      const fresh = await getDocumentTypeDefinition(typeId);
      setDetail(fresh);
      setAnalysisMode(fresh.analysis_mode);
      setProcessors((fresh.processors ?? []).map(toProcEditor));
      setRetrievals((fresh.retrievals ?? []).map(toRetrEditor));
      setBindings(
        toBindingEditor(
          fresh.bindings ?? [],
          fresh.processors ?? [],
          fresh.retrievals ?? [],
        ),
      );
      message.success('已保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <Skeleton active paragraph={{ rows: 12 }} />
      </PageContainer>
    );
  }

  if (!detail) {
    return (
      <PageContainer>
        <Empty description="未找到该文档类型" />
      </PageContainer>
    );
  }

  const modalityMeta =
    MODALITY_META[detail.modality_type as ModalityType] || MODALITY_META.text;

  return (
    <PageContainer
      ghost
      header={{
        breadcrumb: {
          items: [
            {
              title: <Link to="/document-type-definitions">文档类型定义</Link>,
            },
            { title: detail.name },
          ],
        },
      }}
      title={detail.name}
      content={
        <Space size={8} wrap>
          <span>类型编码：{detail.type_key}</span>
          <Tag color={modalityMeta.color}>{modalityMeta.label}</Tag>
        </Space>
      }
    >
      {/* 标题以下的内容统一放进一个白色容器（与 AI 助手页的 Card 布局一致） */}
      <Card
        variant="borderless"
        className={styles.whiteCard}
        styles={{ body: { padding: 24 } }}
      >
        <div className={styles.contentWrap}>
          {/* 基础信息 */}
          <h3 className={styles.sectionTitle}>基础信息</h3>
          <ProForm
            formRef={baseFormRef}
            submitter={false}
            initialValues={{
              type_key: detail.type_key,
              tenant_id: detail.tenant_id,
              name: detail.name,
              description: detail.description ?? '',
              allow_update: detail.allow_update,
              version_mode: detail.version_mode,
              modality_type: detail.modality_type,
              fusion_strategy: detail.fusion_strategy ?? '',
              fusion_config:
                detail.fusion_config && Object.keys(detail.fusion_config).length
                  ? JSON.stringify(detail.fusion_config, null, 2)
                  : '',
              rerank_strategy: detail.rerank_strategy ?? '',
              rerank_config:
                detail.rerank_config && Object.keys(detail.rerank_config).length
                  ? JSON.stringify(detail.rerank_config, null, 2)
                  : '',
            }}
          >
            <ProFormText
              name="type_key"
              label="类型编码"
              disabled
              tooltip="创建后不可修改"
            />
            <ProFormText name="tenant_id" label="租户 ID" disabled />
            <ProFormText
              name="name"
              label="名称"
              rules={[{ required: true, message: '请输入名称' }]}
            />
            <ProFormTextArea
              name="description"
              label="业务描述"
              fieldProps={{ rows: 2 }}
            />
            <ProFormSwitch name="allow_update" label="允许更新" />
            <ProFormSelect
              name="version_mode"
              label="版本策略"
              width="sm"
              options={VERSION_MODE_OPTIONS}
              rules={[{ required: true }]}
            />
            <ProFormSelect
              name="modality_type"
              label="模型类型"
              width="sm"
              disabled
              tooltip="创建后不可修改"
              options={MODALITY_OPTIONS}
            />
            <ProFormSelect
              name="fusion_strategy"
              label="Fusion 策略"
              width="sm"
              options={FUSION_STRATEGY_OPTIONS}
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
            />
            <ProFormTextArea
              name="rerank_config"
              label="Rerank 配置 (JSON)"
              width="md"
              fieldProps={{ rows: 2, style: { fontFamily: 'monospace' } }}
              placeholder="{}"
            />
          </ProForm>

          {/* 解析模式 */}
          <h3 className={styles.sectionTitle} style={{ marginTop: 24 }}>
            解析模式（Analysis Mode）
          </h3>
          <Segmented
            value={analysisMode}
            onChange={(val) => handleModeChange(val as AnalysisMode)}
            options={ANALYSIS_MODE_OPTIONS.map((o) => ({
              label: o.label,
              value: o.value,
            }))}
          />
          <Typography.Paragraph
            type="secondary"
            style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}
          >
            {ANALYSIS_MODE_HINT[analysisMode]}
          </Typography.Paragraph>

          {/* 两阶段 N:N 处理流水线（analysis_mode = none 时整段隐去） */}
          {analysisMode !== 'none' && (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 12,
                  marginTop: 24,
                  marginBottom: 16,
                }}
              >
                <h3 className={styles.sectionTitle} style={{ margin: 0 }}>
                  RAG 处理流水线
                </h3>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {analysisMode === 'default'
                    ? '.* 自动连接全部 Retrieval（不可移除）'
                    : `Analyzer ${processors.length} · Retrieval ${retrievals.length} · 绑定 ${bindings.length}`}
                </Typography.Text>
              </div>
              <PipelineGraph
                mode={analysisMode}
                modality={detail.modality_type as ModalityType}
                processors={processors}
                retrievals={retrievals}
                bindings={bindings}
                onAddProcessor={onAddProcessor}
                onAddRetrieval={onAddRetrieval}
                onUpdateProcessor={onUpdateProcessor}
                onRemoveProcessor={onRemoveProcessor}
                onUpdateRetrieval={onUpdateRetrieval}
                onRemoveRetrieval={onRemoveRetrieval}
                onBindingsChange={setBindings}
              />
            </>
          )}

          <div className={styles.footerBar}>
            <Button type="primary" loading={saving} onClick={handleSaveAll}>
              保存
            </Button>
          </div>
        </div>
      </Card>
    </PageContainer>
  );
};

export default DocumentTypeDetailPage;
