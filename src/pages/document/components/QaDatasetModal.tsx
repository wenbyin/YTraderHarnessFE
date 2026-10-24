// src/pages/document/components/QaDatasetModal.tsx
// 生成 QA 评估数据集：POST /api/v1/qa-datasets:generate（document_version.yaml）
//
// 这个弹窗想回答的是「这次生成到底怎么样」，而不只是「成功 / 失败」。
// 契约里有一句话是全部 UI 的出发点：
//
//     「生成了 3 条」和「生成了 3 条、另外 47 个窗口全失败了」是两回事。
//
// 所以结果面板把**窗口**和**题目**拆成两条线分别给数，窗口失败数单独报警 ——
// 只报 case_count 会把一次大面积失败包装成一次小成功。
//
// 另外两件必须写在界面上的事：
//   1. **同步接口**：请求时长 ≈ 窗口数 × 单次云端 LLM 调用。max_windows 默认
//      只有 10（不是全量）就是这个原因，所以每一项参数都写清「调大意味着什么」，
//      生成中要给等待计时 —— 没有计时的长请求看起来就是卡死了。
//   2. **产物不在响应里**：JSON 落到服务器磁盘，这里只拿到路径与统计，
//      不能给用户一个「下载数据集」的按钮 —— 那是我们给不了的。
//
// ⚠️ 本文件曾按 2026-09-23 下午的「块」口径改版过（max_blocks / max_block_chars
// / temperature 默认不传 / 响应 blocks_*），现已**回退到窗口口径**：
// max_windows 默认 10、temperature 默认 0 且总是发出、响应读 windows_*。
import { DatabaseOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useEffect, useState } from 'react';

import type {
  QADatasetFailure,
  QADatasetGenerateRequest,
  QADatasetGenerateResponse,
} from '../data';
import { useStyles } from '../style';
import { generateQaDataset } from '../versionResult';

/** 契约里的默认值。改这里之前先确认 document_version.yaml 没变。 */
const DEFAULTS = {
  max_windows: 10,
  sample_seed: 0,
  max_questions_per_window: 3,
  concurrency: 4,
  temperature: 0,
};

/** 表单值。数字项用 number|null —— null 表示该字段不随请求发出（走后端默认）。 */
export interface QaFormValues {
  max_windows: number | null;
  sample_seed: number | null;
  max_questions_per_window: number | null;
  concurrency: number | null;
  provider: string | null;
  temperature: number | null;
}

const INITIAL_VALUES: QaFormValues = {
  max_windows: DEFAULTS.max_windows,
  sample_seed: DEFAULTS.sample_seed,
  max_questions_per_window: DEFAULTS.max_questions_per_window,
  concurrency: DEFAULTS.concurrency,
  provider: null,
  temperature: DEFAULTS.temperature,
};

/**
 * InputNumber 的 onChange 给的是 `number | string | null`，
 * 空输入框是 null、手输中途可能是字符串。统一收敛成 number | null。
 */
export function toNumber(
  value: number | string | null | undefined,
): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** null / 非法值不进请求体 —— 让后端用自己的默认值，前端不替它猜。 */
export function buildBody(
  documentVersionId: string,
  values: QaFormValues,
): QADatasetGenerateRequest {
  const body: QADatasetGenerateRequest = {
    document_version_id: documentVersionId,
  };
  const maxWindows = toNumber(values.max_windows);
  const seed = toNumber(values.sample_seed);
  const perWindow = toNumber(values.max_questions_per_window);
  const concurrency = toNumber(values.concurrency);
  const temperature = toNumber(values.temperature);

  if (maxWindows != null) body.max_windows = maxWindows;
  if (seed != null) body.sample_seed = seed;
  if (perWindow != null) body.max_questions_per_window = perWindow;
  if (concurrency != null) body.concurrency = concurrency;
  if (temperature != null) body.temperature = temperature;
  // 契约里 provider 是 string | null，null 有明确语义（用 llm.yaml 的
  // default_provider），所以它**总是发出去**，不做「空就不传」的处理。
  body.provider = values.provider?.trim() ? values.provider.trim() : null;

  return body;
}

interface QaDatasetModalProps {
  open: boolean;
  onClose: () => void;
  documentVersionId: string | null;
  versionNumber: number | null;
  /**
   * 该版本是否已经产出 chunk。
   * null = 还不知道（正在加载 / retrievals 走了降级口径），此时不提示 ——
   * 不知道就别装作知道。
   */
  hasChunks: boolean | null;
}

const QaDatasetModal: React.FC<QaDatasetModalProps> = ({
  open,
  onClose,
  documentVersionId,
  versionNumber,
  hasChunks,
}) => {
  const [form] = Form.useForm<QaFormValues>();

  /** form = 填参数；running = 已发出、在等服务端；done = 拿到结果。 */
  const [phase, setPhase] = useState<'form' | 'running' | 'done'>('form');
  const [result, setResult] = useState<QADatasetGenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);

  // 每次打开都回到填参数那一步：上一次的结果不该被误当成这一次的
  useEffect(() => {
    if (!open) return;
    setPhase('form');
    setResult(null);
    setError(null);
    setWaited(0);
    form.setFieldsValue(INITIAL_VALUES);
  }, [open, form]);

  // 等待计时。没有它，几分钟的同步请求看起来和卡死没有区别。
  useEffect(() => {
    if (phase !== 'running') return;
    setWaited(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setWaited(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const handleGenerate = async () => {
    if (!documentVersionId) return;
    let values: QaFormValues;
    try {
      values = await form.validateFields();
    } catch {
      // 校验不通过的字段 antd 已经标红了，这里什么都不做，输入原样保留
      return;
    }

    setPhase('running');
    setError(null);
    setResult(null);
    try {
      const response = await generateQaDataset(
        buildBody(documentVersionId, values),
      );
      setResult(response);
      setPhase('done');
    } catch (err) {
      // 回到表单而不是关弹窗 —— 参数全留着，用户改小窗口数就能重试
      setError(err instanceof Error ? err.message : '生成失败');
      setPhase('form');
    }
  };

  const running = phase === 'running';

  return (
    <Modal
      title={
        versionNumber != null
          ? `生成评估数据集 · 版本 v${versionNumber}`
          : '生成评估数据集'
      }
      width={640}
      open={open}
      onCancel={onClose}
      // 生成中不允许点遮罩关掉 —— 手滑一下就把几分钟的等待弄丢了
      mask={{ closable: !running }}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        // 生成中不给「开始生成」：重复提交只会再跑一遍同样的窗口
        running ? null : (
          <Button
            key="submit"
            type="primary"
            icon={<DatabaseOutlined />}
            onClick={handleGenerate}
          >
            {phase === 'done' ? '再生成一次' : '开始生成'}
          </Button>
        ),
      ]}
    >
      {phase === 'form' && (
        <>
          {hasChunks === false && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              title="该版本目前没有 chunk"
              description="没有 chunk 就求不出标注交集，先生成或等待处理完成"
            />
          )}

          {error && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              title={`生成失败：${error}`}
            />
          )}

          <Form form={form} layout="vertical" initialValues={INITIAL_VALUES}>
            <Form.Item
              label="窗口数"
              name="max_windows"
              tooltip="本次最多处理多少个窗口（按 2~4 级标题切出来的小节）。它是耗时的直接来源：10 个窗口通常是几十秒到几分钟，调大一倍就慢一倍。"
            >
              <InputNumber
                min={1}
                max={100}
                step={1}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item
              label="抽样种子"
              name="sample_seed"
              tooltip="窗口是从全部小节里随机抽的，不是取前 N 个 —— 取前 N 个会永远只看得到文档开头，那部分的事件类型和中间、结尾完全不同。固定种子 = 同样参数抽出同一批窗口，便于比较两次改动的差异。"
            >
              <InputNumber min={0} step={1} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              label="每窗口最多出题数"
              name="max_questions_per_window"
              tooltip="单个窗口最多出几道题。窗口本身可能只有一百来字，题目上限远高于内容量时，多出来的题会因为没有可引用的原文而被丢弃。"
            >
              <InputNumber
                min={1}
                max={10}
                step={1}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item
              label="并发数"
              name="concurrency"
              tooltip="并发调用云端 LLM 的条数。不要盲目调大 —— 各家都有 QPS 限制，打满会触发限流，重试反而更慢，还可能把 key 短时间封掉。"
            >
              <InputNumber
                min={1}
                max={16}
                step={1}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item
              label="LLM 提供方"
              name="provider"
              tooltip="留空 = 用 app/common/llm.yaml 里的 default_provider。"
            >
              <Input allowClear placeholder="留空使用 default_provider" />
            </Form.Item>

            <Form.Item
              label="采样温度"
              name="temperature"
              tooltip="默认 0 —— 出题要可复现。调高会让同一窗口每次跑出不同的问题，两次数据集就没法比了。"
            >
              <InputNumber
                min={0}
                max={2}
                step={0.1}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Form>
        </>
      )}

      {running && (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <Space orientation="vertical" size={10} style={{ width: '100%' }}>
            <Space size={8}>
              <Spin size="small" />
              <Typography.Text strong>
                正在生成，已等待 {waited}s
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              服务端同步执行中。关闭这个弹窗不会中止已发出的请求，但结果就取不回来了。
            </Typography.Text>
          </Space>
        </div>
      )}

      {phase === 'done' && result && <GenerateResult result={result} />}
    </Modal>
  );
};

/** 结果面板：窗口一条线、题目一条线，失败与丢弃分别给解释。 */
const GenerateResult: React.FC<{ result: QADatasetGenerateResponse }> = ({
  result,
}) => {
  const { styles } = useStyles();

  const dropReasons = Object.entries(result.drop_reasons ?? {});
  const failures = result.failures ?? [];

  return (
    <div>
      {/**
       * 只报 case_count 会骗人：99 个窗口全失败、1 个窗口成功，也是「生成了 3 条」。
       * 所以窗口失败数单独成条，措辞直接照搬契约里那句话。
       */}
      {result.windows_failed > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`有 ${result.windows_failed} / ${result.windows_total} 个窗口调用失败`}
        />
      )}

      <div className={styles.qaResult}>
        <div className={styles.qaStatGrid}>
          <div>
            <div className={styles.qaStatLabel}>保留样本</div>
            <div className={styles.qaStatValue}>{result.case_count}</div>
          </div>
          <div>
            <div className={styles.qaStatLabel}>窗口成功</div>
            <div className={styles.qaStatValue}>
              {result.windows_ok}
              <span className={styles.qaStatUnit}>
                / {result.windows_total}
              </span>
            </div>
          </div>
          <div>
            <div className={styles.qaStatLabel}>窗口失败</div>
            <div
              className={`${styles.qaStatValue} ${result.windows_failed > 0 ? styles.qaStatWarn : styles.qaStatMuted}`}
            >
              {result.windows_failed}
            </div>
          </div>
          <div>
            <div className={styles.qaStatLabel}>出题总数</div>
            <div className={styles.qaStatValue}>
              {result.questions_generated}
            </div>
          </div>
          <div>
            <div className={styles.qaStatLabel}>保留</div>
            <div className={styles.qaStatValue}>{result.questions_kept}</div>
          </div>
          <div>
            <div className={styles.qaStatLabel}>丢弃</div>
            <div
              className={`${styles.qaStatValue} ${result.questions_dropped > 0 ? styles.qaStatWarn : styles.qaStatMuted}`}
            >
              {result.questions_dropped}
            </div>
          </div>
        </div>
      </div>

      {result.questions_dropped > 0 && (
        <div className={styles.noticeBox}>
          丢弃 {result.questions_dropped} 条不一定是坏事：最常见的原因是模型没有
          逐字引用原文（它改写了），那种题的目标位置无法确定，留着只会污染数据集。
          真要判断问题出在哪一环，看下面的原因分类。
        </div>
      )}

      {dropReasons.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className={styles.metaLabel}>丢弃原因</div>
          <Space size={6} wrap style={{ marginTop: 4 }}>
            {dropReasons.map(([reason, count]) => (
              // 原因是后端给的自由键，原样显示 —— 前端翻译不出它没见过的键
              <Tag key={reason} className={styles.monoValue}>
                {reason}: {count}
              </Tag>
            ))}
          </Space>
        </div>
      )}

      {failures.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className={styles.metaLabel}>
            失败窗口（后端最多保留前若干个）
          </div>
          <div className={styles.qaFailureList}>
            {failures.map((item) => (
              // 用 section + 字符区间做 key：后端给的是「失败窗口明细」，
              // 同一个标题理论上不该出现两次，出现时区间还能再区分一层
              <FailureRow
                key={`${item.section}-${item.span?.[0]}-${item.span?.[1]}`}
                item={item}
              />
            ))}
          </div>
        </div>
      )}

      <div className={styles.divider} />

      <div className={styles.kvGrid}>
        <span className={styles.kvLabel}>落盘路径</span>
        <span className={styles.kvValue}>
          <Typography.Text
            copyable={{ text: result.dataset_path }}
            className={styles.qaPath}
          >
            {result.dataset_path}
          </Typography.Text>
        </span>
        <span className={styles.kvLabel}>整批耗时</span>
        <span className={styles.kvValue}>{result.elapsed_seconds}s</span>
      </div>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        产物在服务器磁盘上，接口只回路径 —— 这个文件要下载或入库得走别的通道。
      </Typography.Text>
    </div>
  );
};

const FailureRow: React.FC<{ item: QADatasetFailure }> = ({ item }) => {
  const { styles } = useStyles();
  return (
    <div className={styles.qaFailureRow}>
      <Tooltip title={item.reason}>
        <Typography.Text style={{ fontSize: 12.5 }}>
          {item.section || '（无标题窗口）'}
        </Typography.Text>
      </Tooltip>
      <Typography.Text
        type="secondary"
        className={styles.monoValue}
        style={{ fontSize: 12 }}
      >
        [{item.span?.[0] ?? '?'}, {item.span?.[1] ?? '?'})
      </Typography.Text>
    </div>
  );
};

export default QaDatasetModal;
