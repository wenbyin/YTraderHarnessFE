// src/pages/retrieval_eval/components/BundleCreateModal.tsx
// 新建 bundle 表单：选定 DTD 范围 + 抽样规模 N + 每块问题数 M + 每窗 chunk 数 L + token 预算。
//
// 设计要点：
//   1. DTD 是多选（跨 DTD 平衡抽样），但**每个 QA case 只归属一个 DTD**，
//      评测时也只对那一个 DTD 发起检索 —— 这点在表单里用提示文案明确写出，防止误解。
//   2. N / L / M 三个数字的乘积关系直接影响窗口数与调用次数，表单实时预估并展示。
//   3. seed 可留空（后端生成并存档），留空时提示「可复现性由后端 seed 保证」。
import { PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import React, { useEffect, useMemo, useState } from 'react';
import type { CreateEvalBundleRequest } from '../data';
import { useDtdOptions } from '../dtdOptions';

const { Text } = Typography;

interface Props {
  onSubmit: (values: CreateEvalBundleRequest) => Promise<void>;
}

/**
 * 自带触发器的「新建 Bundle」入口。
 *
 * 与项目里其他列表页的 `XxxCreateModal` 一致：**弹窗自己管 open 状态、自己渲染触发按钮**，
 * 页面只把它放进 `PageContainer` 的 `extra`（页头右上角），不占 ProTable 工具栏 ——
 * 工具栏留给 ProTable 自己的刷新 / 密度 / 列设置（这是项目既有约定）。
 */
const BundleCreateModal: React.FC<Props> = ({ onSubmit }) => {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<CreateEvalBundleRequest>();
  // DTD 选项走页面级缓存（真实模式下来自 /api/v1/document-type-definitions）
  const dtds = useDtdOptions();
  const [submitting, setSubmitting] = useState(false);

  // 受控读取三个关键数字，用于实时预估窗口数
  const sampledChunkCount = Form.useWatch('sampled_chunk_count', form);
  const chunksPerWindow = Form.useWatch('chunks_per_window', form);
  const questionsPerChunk = Form.useWatch('questions_per_chunk', form);
  // 跨块裁决是**每题一次额外模型调用**，所以它必须进"预计调用次数"——
  // 否则用户开了它以后看到的成本估算会少一大截（题数往往远大于窗口数）。
  const crossChunkJudge = Form.useWatch('enable_cross_chunk_judge', form);

  const est = useMemo(() => {
    const N = sampledChunkCount ?? 100;
    const L = chunksPerWindow ?? 5;
    const M = questionsPerChunk ?? 3;
    const windows = Math.ceil(N / L);
    const cases = N * M;
    const judgeCalls = crossChunkJudge ? cases : 0;
    return { windows, cases, judgeCalls, calls: windows + judgeCalls };
  }, [sampledChunkCount, chunksPerWindow, questionsPerChunk, crossChunkJudge]);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        name: '',
        description: '',
        document_type_definition_ids: [],
        sampled_chunk_count: 100,
        questions_per_chunk: 3,
        chunks_per_window: 5,
        max_input_tokens: 12000,
        // 契约与后端都是 default=false：judge 的模型绑定没配好也不该影响造题
        enable_cross_chunk_judge: false,
        sampling_strategy: 'balanced_by_dtd',
        seed: undefined,
      });
    }
  }, [open, form]);

  const handleOk = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await onSubmit(values);
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setOpen(true)}
      >
        新建 Bundle
      </Button>
      <Modal
        open={open}
        title="新建 Retrieval Eval Bundle"
        width={720}
        okText="创建并开始生成"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleOk}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item
            label="Bundle 名称"
            name="name"
            rules={[{ required: true, message: '请输入名称' }, { max: 255 }]}
          >
            <Input placeholder="例如 company-announcement-retrieval-v1" />
          </Form.Item>

          <Form.Item label="描述" name="description">
            <Input.TextArea
              rows={2}
              maxLength={10000}
              placeholder="用于确定性 chunk 召回测试的直接事实型 QA"
            />
          </Form.Item>

          <Form.Item
            label="文档类型定义（DTD）"
            name="document_type_definition_ids"
            rules={[{ required: true, message: '至少选择一个 DTD' }]}
            extra="跨所选 DTD 做平衡抽样；但每个 QA case 只归属一个 DTD，评测时只对那一个 DTD 发起检索。"
          >
            <Select
              mode="multiple"
              placeholder="选择一个或多个 DTD"
              showSearch={{ optionFilterProp: 'label' }}
              options={dtds.map((d) => ({
                value: d.document_type_definition_id,
                // chunk 数只有演示数据有（真实 DTD 列表项不提供），所以按需拼接
                label: d.chunk_count
                  ? `${d.type_key} · ${d.name}（${d.chunk_count} chunks）`
                  : `${d.type_key} · ${d.name}`,
              }))}
            />
          </Form.Item>

          <Divider titlePlacement="start" style={{ margin: '8px 0 16px' }}>
            <Text style={{ fontSize: 13 }}>抽样与生成参数</Text>
          </Divider>

          <Space size={16} align="start" style={{ width: '100%' }}>
            <Form.Item
              label="抽样 chunk 总数 N"
              name="sampled_chunk_count"
              rules={[{ required: true, message: '必填' }]}
              style={{ width: 200 }}
              extra="跨所有 DTD 的总数，非每 DTD"
            >
              <InputNumber min={1} max={100000} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              label="每块问题数 M"
              name="questions_per_chunk"
              style={{ width: 160 }}
              extra="每 chunk 生成的独立问题数"
            >
              <InputNumber min={1} max={20} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              label="每窗 chunk 数 L"
              name="chunks_per_window"
              style={{ width: 160 }}
              extra="单次 LLM 请求最大块数"
            >
              <InputNumber min={1} max={50} style={{ width: '100%' }} />
            </Form.Item>
          </Space>

          <Space size={16} align="start" style={{ width: '100%' }}>
            <Form.Item
              label="输入 token 预算"
              name="max_input_tokens"
              style={{ width: 200 }}
              extra="与 L 同时生效，先命中者限制窗口"
            >
              <InputNumber
                min={1000}
                max={1000000}
                step={1000}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item
              label="抽样策略"
              name="sampling_strategy"
              style={{ width: 220 }}
            >
              <Select
                options={[
                  {
                    value: 'balanced_by_dtd',
                    label: 'balanced_by_dtd（跨 DTD 平衡）',
                  },
                  { value: 'uniform_all', label: 'uniform_all（全体均匀）' },
                ]}
              />
            </Form.Item>

            <Form.Item
              label="随机种子 seed"
              name="seed"
              style={{ width: 180 }}
              extra="留空则由后端生成并持久化"
            >
              <InputNumber
                min={0}
                // 后端 seed 上限是 BIGINT 9223372036854775807，超出 JS 安全整数范围，
                // 这里收敛到 Number.MAX_SAFE_INTEGER，避免精度丢失（bitint 用字符串传更妥）。
                max={Number.MAX_SAFE_INTEGER}
                style={{ width: '100%' }}
                placeholder="可留空"
              />
            </Form.Item>
          </Space>

          <Divider titlePlacement="start" style={{ margin: '16px 0 12px' }}>
            <Text style={{ fontSize: 13 }}>金标判定</Text>
          </Divider>

          <Form.Item
            label="跨块金标裁决"
            name="enable_cross_chunk_judge"
            valuePropName="checked"
            style={{ marginBottom: 16 }}
            extra={
              <span style={{ fontSize: 12 }}>
                开启后
                <Text strong>每道题多调一次模型</Text>
                ，判定「同一份文档里别的块是否也答得上这道题」，答得上的块一并计入金标。
                <br />
                关闭（默认）时金标只有出题那一块 ——
                检索返回了另一块同样答得上的内容会被
                <Text strong>冤枉判成未命中</Text>
                ，召回率偏低、且这种偏低从结果里看不出来。
                <br />
                候选只取
                <Text strong>同一份文档</Text>
                内的其它块（别家公司的文档答不了关于这家公司的问题）；
                跨公司随机抽样时通常没有候选，此时开了也是零调用、零收益。
                <br />
                该值会写进 generation_config 快照 ——
                它改变数据集内容，事后必须能分辨。
              </span>
            }
          >
            <Switch checkedChildren="由模型评判" unCheckedChildren="仅出题块" />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            title={
              <Space size={16} wrap>
                <span>
                  预计窗口数：<Text strong>{est.windows}</Text>
                </span>
                <span>
                  预计 LLM 调用：<Text strong>{est.calls}</Text> 次
                  {est.judgeCalls > 0 && (
                    <Text type="secondary">
                      （其中跨块裁决 {est.judgeCalls} 次）
                    </Text>
                  )}
                </span>
                <span>
                  预计用例上限：<Text strong>{est.cases}</Text> 条（N×M）
                </span>
              </Space>
            }
            description={
              <Text type="secondary" style={{ fontSize: 12 }}>
                窗口数 = ceil(N / L)，同时还受 token
                预算二次切分，实际窗口数可能更多。 bundle 就绪后内容不可变 ——
                要改 N/M/L 需新建 bundle。
              </Text>
            }
          />

          {/*
            历史提醒：这里曾有一个叫 `auto_adjudicate` 的同类开关被删掉 —— 当时
            契约里没有这个字段，而后端请求体是 `extra="forbid"`
            （app/common/schemas/base.py），多带一个就是 **422** 而不是被忽略。
            现在契约补了正式字段 `enable_cross_chunk_judge`
            （CreateEvalBundleRequest，default=false，落进 generation_config 快照），
            开关因此回来了。**名字与默认值一律以契约为准**，别再写回 auto_adjudicate。
          */}
        </Form>
      </Modal>
    </>
  );
};

export default BundleCreateModal;
