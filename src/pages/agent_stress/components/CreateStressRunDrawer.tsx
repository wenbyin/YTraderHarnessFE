// src/pages/agent_stress/components/CreateStressRunDrawer.tsx
//
// 新建压测：把 v2 的 `StressRunCreate` 摊成一张表单。
//
// 一次 Run 不再是一组独立请求，而是**一组虚拟会话**：每个会话对应 Agent 的
// 一个真实 session_id，在其上串行跑 N 轮（N 由截断正态抽样）。所以表单按
// 「目标 → 会话 → 每轮输入 → 负载与终止 → 模拟模型」分段，而不是按
// v1 那种「并发 + 到达率 + 请求体」的平铺。
//
// 三个刻意的取舍：
//   · 表单值 ≠ 请求体。`load_mode` / `concurrency` / `session_rate` 是三选一，
//     `turns_*` 是摊平的（契约里嵌套在 session.turns 下），`input_template` 是
//     文本框 —— POST 前统一过 `toStressRunCreate()` 收敛成 yaml 白名单字段。
//     契约是 additionalProperties:false，多一个键就是 422。
//   · `streaming` 做成**只读的 true**：后端强制要求（Agent 没有
//     GET /runs/{id}，非流式无法判断单轮终态），传 false 直接 422。
//     与其让人改完再被打回来，不如显示成"固定开启"并说明原因。
//   · 默认值给一套**能跑出结果**的配置（12 会话 / 平均 4.5 轮 / 60s），
//     而不是全空。压测页第一次打开就该能点「创建」看到数据。
//
// 两种打开方式（同一个抽屉）
// ------------------------
//   新建：`preset` 不传，用 INITIAL_VALUES。
//   重新发起：列表操作列把整条 run 传进来（`preset`），用 `fromStressRunCreate`
//   把契约形状的 config 反解成表单值回填。**只回填、不自动提交** —— 库里就有
//   162 会话的配置，点错一次就是 162 个真会话打到被测服务上。
import { PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Col,
  Collapse,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Row,
  Segmented,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import React, { useEffect, useMemo, useState } from 'react';

import type { StressRun, StressRunCreate, StressRunFormValues } from '../data';
import { stressErrorMessage } from '../service';
import {
  CLEANUP_OPTIONS,
  fromStressRunCreate,
  ON_HITL_OPTIONS,
  ON_TURN_FAILURE_OPTIONS,
  ROUNDING_OPTIONS,
  toStressRunCreate,
  turnRateFromSessionRate,
} from '../stressMeta';

const { Text } = Typography;

/** 后端 `/sessions` 的 agent_id 取值；AutoComplete 允许自由填写。 */
const AGENT_ID_OPTIONS = [{ value: 'general' }, { value: 'stock_research' }];

const PROFILE_OPTIONS = [
  { value: 'balanced' },
  { value: 'fast' },
  { value: 'slow' },
];

const DEFAULT_PATHS = {
  create_session_path: '/api/v1/sessions',
  create_run_path: '/api/v1/sessions/{session_id}/runs',
  run_events_path: '/api/v1/runs/{run_id}/events',
  cancel_run_path: '/api/v1/runs/{run_id}/cancel',
  resume_run_path: '/api/v1/runs/{run_id}/resume',
  delete_session_path: '/api/v1/sessions/{session_id}',
};

const INITIAL_VALUES: Partial<StressRunFormValues> = {
  base_url: 'http://127.0.0.1:8080',
  token_env: 'STRESS_RUNNER_TOKEN',
  agent_id: 'general',
  turns_mean: 4.5,
  turns_stddev: 1.5,
  turns_min: 1,
  turns_max: 8,
  turns_rounding: 'round',
  think_time_ms: 0,
  on_turn_failure: 'abort',
  on_hitl: 'abort',
  cleanup: 'keep',
  streaming: true,
  load_mode: 'concurrency',
  concurrency: 10,
  session_rate: 2,
  duration_seconds: 60,
  warmup_seconds: 0,
  ramp_up_seconds: 0,
  total_sessions: 12,
  request_timeout_ms: 120_000,
  seed: 42,
  input_size_chars: 480,
  mock_model: {
    profile: 'balanced',
    base_latency_ms: 180,
    latency_jitter_ms: 60,
    ttft_ms: 240,
    output_tokens_min: 200,
    output_tokens_max: 600,
    tokens_per_second: 90,
    error_rate: 0.01,
    timeout_rate: 0.002,
    stream_chunk_tokens: 8,
  },
};

/** 单选/下拉都要「值 + 一句人话」，这里统一从 stressMeta 的 options 取。 */
function hintOf(
  options: readonly { value: string; label: string; hint: string }[],
  value: string | undefined,
): string | undefined {
  return options.find((item) => item.value === value)?.hint;
}

export interface CreateStressRunDrawerProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (body: StressRunCreate) => Promise<void>;
  /**
   * 「重新发起」时的来源运行 —— 有值就把它的 `config` 回填进表单。
   *
   * ⚠️ 传**整条 run** 而不是 `run.config`：抽屉除了参数，还要在顶部说清
   *    "这批参数是从哪一次运行带过来的"（名称 + run_id 前 8 位）。
   *
   * ⚠️ 只回填、**不自动提交**：库里就有一条 162 会话的配置，点错一次
   *    就是 162 个真实会话打到被测服务上。所以仍然要人看一眼再点「发起」。
   */
  preset?: StressRun | null;
}

export const CreateStressRunDrawer: React.FC<CreateStressRunDrawerProps> = ({
  open,
  onClose,
  onSubmit,
  preset,
}) => {
  const [form] = Form.useForm<StressRunFormValues>();
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);

  /**
   * 回填值：默认配置打底，再用源运行的参数覆盖。
   *
   * ⚠️ 必须走 `fromStressRunCreate`（契约 → 表单的逆向映射，见 stressMeta.ts）：
   *    `session.turns` 是嵌套的、`load` 是三选一、`input_template` 是对象 ——
   *    直接把 `run.config` 塞给 `setFieldsValue` 会一个字段都对不上。
   */
  const presetValues = useMemo<Partial<StressRunFormValues>>(
    () =>
      preset
        ? { ...INITIAL_VALUES, ...fromStressRunCreate(preset.config) }
        : {},
    [preset],
  );

  /**
   * 每次打开都按「这一次的 preset」重来一遍。
   *
   * 为什么要有这个 effect（`destroyOnHidden` + `initialValues` 不够）：
   *   · 正常路径下抽屉关掉时表单已销毁，重新打开会重新吃 `initialValues`；
   *   · 但"关 → 立刻开"（动画还没结束就点了另一条「重新发起」）时表单
   *     **没有重挂**，`initialValues` 不会重新应用 —— 那样就会拿上一条运行的
   *     参数去发起下一次，是个很难复现、但后果很重的错。
   *   所以打开时显式 reset（回到默认值）再灌一遍 preset，两种情况都对。
   */
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (preset) form.setFieldsValue(presetValues);
  }, [open, preset, presetValues, form]);

  const loadMode = Form.useWatch('load_mode', form) ?? 'concurrency';
  const onTurnFailure = Form.useWatch('on_turn_failure', form);
  const onHitl = Form.useWatch('on_hitl', form);
  const cleanup = Form.useWatch('cleanup', form);
  const totalSessions = Form.useWatch('total_sessions', form);
  const turnsMean = Form.useWatch('turns_mean', form);
  const maxTurns = Form.useWatch('max_turns', form);
  const sessionRate = Form.useWatch('session_rate', form);
  const durationSeconds = Form.useWatch('duration_seconds', form);

  // 量级预估：total_sessions × E[N]。只用于提示，不参与提交。
  const plannedTurns =
    typeof totalSessions === 'number' && typeof turnsMean === 'number'
      ? Math.round(totalSessions * turnsMean)
      : null;

  // 到达率模式下「轮次速率」= 新建会话速率 × E[N]；这是用户嘴里的 TPS
  const turnRate = turnRateFromSessionRate(sessionRate, turnsMean);

  // 时长内按到达率应该建多少会话；被 total_sessions 夹住就提示（否则"看着填了 10 轮/s，
  // 实际只跑 0.9 轮/s"，因为 12 个会话 × 4.5 轮 = 54 轮就没了）
  const sessionsByRate =
    typeof sessionRate === 'number' && typeof durationSeconds === 'number'
      ? Math.round(sessionRate * durationSeconds)
      : null;
  const cappedByTotalSessions =
    loadMode === 'session_rate' &&
    sessionsByRate !== null &&
    typeof totalSessions === 'number' &&
    totalSessions < sessionsByRate;
  const cappedTurnRate =
    cappedByTotalSessions &&
    typeof totalSessions === 'number' &&
    typeof durationSeconds === 'number' &&
    durationSeconds > 0 &&
    typeof turnsMean === 'number'
      ? (totalSessions * turnsMean) / durationSeconds
      : null;

  const handleFinish = async (values: StressRunFormValues) => {
    setSubmitting(true);
    try {
      const body = toStressRunCreate(values);
      await onSubmit(body);
      form.resetFields();
      onClose();
    } catch (error) {
      message.error(stressErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      title={preset ? '重新发起压测' : '新建压测'}
      size={820}
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={submitting}
            onClick={() => form.submit()}
          >
            {preset ? '按此参数发起' : '创建并入队'}
          </Button>
        </div>
      }
    >
      {preset ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          title="参数已按所选运行回填"
          description={
            <span>
              {preset.name?.trim() || '未命名'}
              <Text code>{preset.run_id.slice(0, 8)}…</Text>
            </span>
          }
        />
      ) : null}

      <Form<StressRunFormValues>
        form={form}
        layout="vertical"
        initialValues={INITIAL_VALUES}
        onFinish={handleFinish}
        requiredMark
      >
        <Divider titlePlacement="start">目标与认证</Divider>
        <Row gutter={16}>
          <Col span={24}>
            <Form.Item
              name="name"
              label="名称"
              extra="可留空；列表里会用 run_id 前 8 位兜底"
            >
              <Input
                placeholder="例如 baseline · 12 会话 / 平均 4.5 轮"
                maxLength={200}
              />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item
              name="base_url"
              label="被测 Agent 服务地址"
              rules={[
                { required: true, message: '填写被测 Agent 的 base_url' },
                {
                  pattern: /^https?:\/\/[^\s/]+/i,
                  message:
                    '需要 http/https 绝对地址（路径不必带，见下方「端点路径」）',
                },
              ]}
              extra="只填 scheme + host + port；各接口路径在「端点路径」里，默认值通常不用改"
            >
              <Input placeholder="http://127.0.0.1:8080" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="token_env"
              label="鉴权环境变量名"
              extra="只填变量名，不填 token（会落库并回显）"
            >
              <Input placeholder="STRESS_RUNNER_TOKEN" />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="start">会话与轮次</Divider>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              name="agent_id"
              label="Agent ID"
              rules={[{ required: true, message: '填写 agent_id' }]}
              extra="建会话时传给 POST /sessions"
            >
              <AutoComplete
                options={AGENT_ID_OPTIONS}
                showSearch={{
                  filterOption: (input, option) =>
                    String(option?.value ?? '')
                      .toLowerCase()
                      .includes(input.toLowerCase()),
                }}
              >
                <Input placeholder="general" />
              </AutoComplete>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="turns_mean"
              label="平均轮数 E[N]"
              rules={[{ required: true, message: '必填' }]}
              extra="截断前正态均值，须落在 [min,max] 内"
            >
              <InputNumber
                min={1}
                max={30}
                step={0.5}
                style={{ width: '100%' }}
                suffix="轮"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="turns_stddev"
              label="标准差"
              rules={[{ required: true, message: '必填' }]}
              extra="0 = 固定轮数，便于复现"
            >
              <InputNumber
                min={0}
                max={30}
                step={0.5}
                style={{ width: '100%' }}
                suffix="轮"
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="turns_min" label="轮数下限">
              <InputNumber
                min={1}
                max={30}
                style={{ width: '100%' }}
                suffix="轮"
              />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="turns_max" label="轮数上限">
              <InputNumber
                min={1}
                max={30}
                style={{ width: '100%' }}
                suffix="轮"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="turns_rounding"
              label="取整方式"
              extra="抽样后如何取整"
            >
              <Segmented
                block
                options={ROUNDING_OPTIONS.map((item) => ({
                  label: item.label,
                  value: item.value,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="think_time_ms"
              label="轮间停顿"
              extra="只作用于第 2 轮及以后"
            >
              <InputNumber
                min={0}
                max={600000}
                style={{ width: '100%' }}
                suffix="ms"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="on_turn_failure"
              label="某轮失败后"
              extra={hintOf(ON_TURN_FAILURE_OPTIONS, onTurnFailure)}
            >
              <Segmented
                block
                options={ON_TURN_FAILURE_OPTIONS.map((item) => ({
                  label: item.label,
                  value: item.value,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="on_hitl"
              label="遇到人工审批"
              extra={hintOf(ON_HITL_OPTIONS, onHitl)}
            >
              <Segmented
                block
                options={ON_HITL_OPTIONS.map((item) => ({
                  label: item.label,
                  value: item.value,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="cleanup"
              label="会话清理"
              extra={hintOf(CLEANUP_OPTIONS, cleanup)}
            >
              <Segmented
                block
                options={CLEANUP_OPTIONS.map((item) => ({
                  label: item.label,
                  value: item.value,
                }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="start">每轮输入</Divider>
        <Row gutter={16}>
          <Col span={16}>
            <Form.Item
              name="input_template"
              label="input_template（JSON 对象）"
              extra={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  留空则由后端按「输入长度」生成合成文本；这里的内容会原样发给被测
                  Agent，
                  <Text type="danger">不要填真实用户数据</Text>。
                </Text>
              }
            >
              <Input.TextArea
                rows={4}
                placeholder={'{\n  "text": "请分析这只股票最近的公告。"\n}'}
                spellCheck={false}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="input_size_chars"
              label="合成输入长度"
              extra="仅在未填模板时生效"
            >
              <InputNumber
                min={1}
                max={100000}
                style={{ width: '100%' }}
                suffix="字符"
              />
            </Form.Item>
            <Form.Item
              name="streaming"
              label="流式消费事件"
              valuePropName="checked"
              extra="当前版本必须开启：Agent 没有 GET /runs/{id}，只能靠 SSE 判断单轮终态"
            >
              <Switch checked disabled />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="start">负载与终止</Divider>
        <Form.Item name="load_mode" label="施加方式">
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: '固定并发会话', value: 'concurrency' },
              { label: '固定到达率', value: 'session_rate' },
            ]}
          />
        </Form.Item>
        <Row gutter={16}>
          <Col span={12}>
            {loadMode === 'session_rate' ? (
              <Form.Item
                name="session_rate"
                label="新建会话速率"
                rules={[{ required: true, message: '填写每秒新建会话数' }]}
                extra={
                  turnRate !== null
                    ? `≈ ${turnRate.toFixed(1)} 轮/s（= 该值 × E[N]，TPS 一般指轮次速率）`
                    : '轮次速率 = 该值 × E[N]（TPS 指轮次速率）'
                }
              >
                <InputNumber
                  min={0.01}
                  max={10000}
                  step={1}
                  style={{ width: '100%' }}
                  suffix="会话/s"
                />
              </Form.Item>
            ) : (
              <Form.Item
                name="concurrency"
                label="并发会话数"
                rules={[{ required: true, message: '填写并发会话数' }]}
                extra="同时在途的会话上限（不是请求数）；轮次速率 ≈ 并发 ÷ 单会话平均耗时"
              >
                <InputNumber
                  min={1}
                  max={10000}
                  style={{ width: '100%' }}
                  suffix="个"
                />
              </Form.Item>
            )}
          </Col>
          <Col span={12}>
            <Form.Item
              name="duration_seconds"
              label="持续时长"
              rules={[{ required: true, message: '填写持续时长' }]}
              extra="整个 Run 的墙钟硬上限"
            >
              <InputNumber
                min={1}
                max={86400}
                style={{ width: '100%' }}
                suffix="秒"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="warmup_seconds"
              label="预热"
              extra="窗口内建的会话不计入聚合"
            >
              <InputNumber
                min={0}
                max={3600}
                style={{ width: '100%' }}
                suffix="秒"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="ramp_up_seconds" label="爬坡">
              <InputNumber
                min={0}
                max={3600}
                style={{ width: '100%' }}
                suffix="秒"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="request_timeout_ms"
              label="单轮超时"
              rules={[{ required: true, message: '填写超时时间' }]}
              extra="提交 Run 到收到终态"
            >
              <InputNumber
                min={100}
                max={600000}
                style={{ width: '100%' }}
                suffix="ms"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="total_sessions"
              label="会话总数上限"
              extra="留空则由时长与负载决定"
            >
              <InputNumber
                min={1}
                style={{ width: '100%' }}
                suffix="个"
                placeholder="不限制"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="max_turns"
              label="轮次总数上限"
              extra="达到后未完成会话计为 abandoned"
            >
              <InputNumber
                min={1}
                style={{ width: '100%' }}
                suffix="轮"
                placeholder="不限制"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="seed"
              label="随机种子"
              extra="N 抽样与模型随机共用；同种子可复现"
            >
              <InputNumber style={{ width: '100%' }} placeholder="留空则随机" />
            </Form.Item>
          </Col>
        </Row>

        {cappedByTotalSessions ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={`会话总数上限 ${totalSessions} 会先于时长生效：本次最多约 ${plannedTurns?.toLocaleString(
              'zh-CN',
            )} 轮${cappedTurnRate !== null ? `，平均 ${cappedTurnRate.toFixed(2)} 轮/s` : ''}`}
            description={`按时长 × 到达率本应建 ${sessionsByRate} 个 · 留空或调高可跑满窗口`}
          />
        ) : plannedTurns !== null ? (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            title={`量级预估：约 ${totalSessions} 个会话 × ${turnsMean} 轮 ≈ ${plannedTurns.toLocaleString(
              'zh-CN',
            )} 轮${turnRate !== null && loadMode === 'session_rate' ? `（目标 ${turnRate.toFixed(1)} 轮/s）` : ''}`}
            description={
              maxTurns != null
                ? `轮次上限 ${maxTurns} 会先于预估生效（到点后未完成会话计为 abandoned）。`
                : 'N 是抽样出来的，实际轮次以指标里的 turns_per_session 为准。'
            }
          />
        ) : null}

        <Divider titlePlacement="start">模拟模型</Divider>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name={['mock_model', 'profile']} label="档位">
              <AutoComplete options={PROFILE_OPTIONS} placeholder="balanced">
                <Input />
              </AutoComplete>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'base_latency_ms']}
              label="基础时延"
              rules={[{ required: true, message: '必填' }]}
            >
              <InputNumber
                min={0}
                max={600000}
                style={{ width: '100%' }}
                suffix="ms"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'latency_jitter_ms']}
              label="时延抖动"
            >
              <InputNumber
                min={0}
                max={600000}
                style={{ width: '100%' }}
                suffix="ms"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'ttft_ms']}
              label="首 token 时延"
              rules={[{ required: true, message: '必填' }]}
            >
              <InputNumber
                min={0}
                max={600000}
                style={{ width: '100%' }}
                suffix="ms"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'output_tokens_min']}
              label="输出 token 下限"
              rules={[{ required: true, message: '必填' }]}
            >
              <InputNumber
                min={0}
                max={100000}
                style={{ width: '100%' }}
                suffix="个"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'output_tokens_max']}
              label="输出 token 上限"
              dependencies={[['mock_model', 'output_tokens_min']]}
              rules={[
                { required: true, message: '必填' },
                ({ getFieldValue }) => ({
                  validator: async (_, value: number | undefined) => {
                    const min = getFieldValue([
                      'mock_model',
                      'output_tokens_min',
                    ]);
                    if (typeof value !== 'number' || typeof min !== 'number')
                      return;
                    if (value < min) throw new Error('上限不能小于下限');
                  },
                }),
              ]}
            >
              <InputNumber
                min={0}
                max={100000}
                style={{ width: '100%' }}
                suffix="个"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'tokens_per_second']}
              label="生成速度"
              rules={[{ required: true, message: '必填' }]}
            >
              <InputNumber
                min={0.1}
                max={100000}
                style={{ width: '100%' }}
                suffix="token/s"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'stream_chunk_tokens']}
              label="流式分片大小"
            >
              <InputNumber
                min={1}
                max={10000}
                style={{ width: '100%' }}
                suffix="token/片"
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'error_rate']}
              label="错误率"
              extra="0.01 = 1%"
            >
              <InputNumber
                min={0}
                max={1}
                step={0.005}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'timeout_rate']}
              label="超时率"
              extra="0.002 = 0.2%"
            >
              <InputNumber
                min={0}
                max={1}
                step={0.001}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={['mock_model', 'max_inflight_requests']}
              label="替身并发上限"
              extra="留空表示不额外限流"
            >
              <InputNumber
                min={1}
                style={{ width: '100%' }}
                placeholder="不限制"
              />
            </Form.Item>
          </Col>
        </Row>

        <Collapse
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'paths',
              /*
               * ⚠️ forceRender 不是性能取舍，是**正确性**要求。
               *
               * Collapse 默认懒渲染：没展开过时子节点压根不挂载 → 里面的
               * Form.Item 不会注册 → `form.getFieldsValue()` 拿不到 `paths`，
               * 提交时这六个字段**静默消失**（后端于是用默认路径）。
               * 平时看不出来（默认值本来就等于后端默认），但「重新发起」把
               * 一次用了自定义前缀的运行带回来时，路径会丢 —— 那就不是同一个
               * 压测了。挂上 forceRender，折叠状态下也照常注册与提交。
               */
              forceRender: true,
              label: (
                <Text>
                  端点路径{' '}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （默认值通常不用改；联调换了前缀才展开）
                  </Text>
                </Text>
              ),
              children: (
                <Row gutter={16}>
                  {(
                    [
                      ['create_session_path', '建会话'],
                      ['create_run_path', '提交单轮 Run'],
                      ['run_events_path', 'SSE 事件流'],
                      ['cancel_run_path', '取消单轮'],
                      ['resume_run_path', 'HITL 恢复'],
                      ['delete_session_path', '删除会话'],
                    ] as const
                  ).map(([key, label]) => (
                    <Col span={12} key={key}>
                      <Form.Item
                        name={['paths', key]}
                        label={label}
                        style={{ marginBottom: 12 }}
                      >
                        <Input
                          placeholder={DEFAULT_PATHS[key]}
                          spellCheck={false}
                        />
                      </Form.Item>
                    </Col>
                  ))}
                  <Col span={24}>
                    <Space size={6} wrap>
                      <Tag>{'{session_id}'}</Tag>
                      <Tag>{'{run_id}'}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        由 Runner 替换；留空即用后端默认值。
                      </Text>
                    </Space>
                  </Col>
                </Row>
              ),
            },
          ]}
        />

        <Text type="secondary" style={{ fontSize: 12 }}>
          提交后返回 202，跑测先进入 queued，调度器拉起后开始计时。
        </Text>
      </Form>
    </Drawer>
  );
};

export default CreateStressRunDrawer;
