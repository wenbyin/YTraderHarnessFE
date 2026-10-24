// src/pages/retrieval_eval/detail.tsx
// Bundle 详情页：生成进度（窗口切分）/ QA 用例预览（含 gold chunk 多对多）/ 导出。
//
// 这里把「一题多 gold」讲清楚：answer_original 是源 chunk 的精确原文子串，
// gold_chunk_ids 是**所有**经独立验证可回答该题的 chunk —— 逆向提问时
// 采样池里别的 chunk 也可能含正确答案，所以列表里 gold 数 > 1 是正常的。
import {
  ArrowLeftOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, useParams } from '@umijs/max';
import {
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Popconfirm,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import DtdTagList, { DtdTag } from './components/DtdTagList';
import { BundleStatusTag } from './components/StatusTag';
import WindowPlan from './components/WindowPlan';
import type { EvalBundleDetail, EvalCase, GenerationRunDetail } from './data';
import { useDtdOptions } from './dtdOptions';
import {
  exportRetrievalEvalBundle,
  getRetrievalEvalBundle,
  getRetrievalEvalGenerationRun,
  listRetrievalEvalCases,
  retryRetrievalEvalGenerationWindows,
} from './service';
import { useStyles } from './style';

const { Text, Paragraph } = Typography;

/** 生成中时的轮询间隔。造题是分钟级任务，3 秒足够跟手又不至于打爆后端。 */
const POLL_INTERVAL_MS = 3000;

/** 还在动的状态 —— 只有这几种才需要轮询。 */
const ACTIVE_BUNDLE_STATUSES = new Set(['draft', 'generating']);
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);

const VALIDATION_META: Record<
  string,
  { text: string; status: 'success' | 'warning' | 'error' }
> = {
  pending: { text: '待校验', status: 'warning' },
  validated: { text: '已校验', status: 'success' },
  rejected: { text: '已拒绝', status: 'error' },
};

/**
 * @param bundleIdOverride 仅独立预览构建使用：脱离路由时直接指定 bundle。
 *   在 umi 项目内不传，仍从 useParams 取。
 */
const RetrievalEvalBundleDetailPage: React.FC<{
  bundleIdOverride?: string;
}> = ({ bundleIdOverride }) => {
  const { styles } = useStyles();
  const params = useParams<{ bundleId: string }>();
  const bundleId = bundleIdOverride ?? params.bundleId ?? '';
  const { message } = App.useApp();
  const actionRef = useRef<ActionType | undefined>(undefined);

  const [bundle, setBundle] = useState<EvalBundleDetail | null>(null);
  const [genRun, setGenRun] = useState<GenerationRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // 订阅 DTD 选项：拉到之后本页重渲染，DtdTag/DtdTagList 里的 dtdLabel 才有名字可用
  useDtdOptions();

  const refreshBase = useCallback(async () => {
    if (!bundleId) return;
    setLoading(true);
    try {
      const b = await getRetrievalEvalBundle(bundleId);
      setBundle(b);
      if (b.latest_generation_run_id) {
        const run = await getRetrievalEvalGenerationRun(
          b.latest_generation_run_id,
        );
        setGenRun(run);
      }
    } catch {
      // 失败提示由全局 errorHandler 统一弹（它读 FastAPI 的 detail），
      // 这里不补第二条 —— 两条 toast 说同一件事只会让人以为错了两次。
    } finally {
      setLoading(false);
    }
  }, [bundleId]);

  useEffect(() => {
    refreshBase();
  }, [refreshBase]);

  /**
   * 生成中轮询。
   *
   * 为什么要它：`POST /bundles` 是 **202 受理**，真正的出题在分钟级的后台任务里
   * （见 app/api/v1/retrieval_eval.py 的模块注释）。只加载一次的话，用户建完
   * bundle 进来看到的永远是一张停在「生成中」的静态快照 —— 既不知道有没有进展，
   * 也不知道窗口有没有在失败重试。
   *
   * 依赖刻意选「这一批状态」而不是 bundle 对象本身：对象每次都换引用，
   * 用它做依赖会把定时器无限重建。
   */
  const bundleStatus = bundle?.status;
  const genStatus = genRun?.status;
  useEffect(() => {
    const active =
      (bundleStatus && ACTIVE_BUNDLE_STATUSES.has(bundleStatus)) ||
      (genStatus && ACTIVE_JOB_STATUSES.has(genStatus));
    if (!active) return;
    const timer = setInterval(refreshBase, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [bundleStatus, genStatus, refreshBase]);

  /**
   * 「未成功窗口」= failed ∪ queued。
   *
   * queued 也算：造题一次执行有窗口数上限（后端 MAX_WINDOWS_PER_TASK_RUN），
   * 排不下的一直留在 queued，而这一层不发子任务 —— 再调一次重试端点就是
   * 继续跑它们的**唯一**途径（后端注释里明确写了"实际覆盖范围比名字宽"）。
   */
  const retryableWindowCount =
    genRun?.windows.filter(
      (w) => w.status === 'failed' || w.status === 'queued',
    ).length ?? 0;
  const [retryingWindows, setRetryingWindows] = useState(false);

  const handleRetryWindows = async () => {
    if (!genRun) return;
    setRetryingWindows(true);
    try {
      const res = await retryRetrievalEvalGenerationWindows(
        genRun.generation_run_id,
      );
      message.success(`已重新入队 ${res.retried_window_count} 个窗口`);
      await refreshBase();
    } catch {
      // 409（没有可重试的窗口）的解释由全局 errorHandler 弹，这里不补第二条
    } finally {
      setRetryingWindows(false);
    }
  };

  const handleExport = async () => {
    try {
      const data = await exportRetrievalEvalBundle(bundleId);
      // demo：直接下载为 JSON 文件
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.bundle_name}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已导出 ${data.items.length} 条 validated 用例`);
    } catch {
      // 后端在 bundle 未就绪时返回 409，那句话由全局 errorHandler 弹（它读 detail）；
      // 这里不再补一条 —— 同一件事弹两次会被读成"错了两次"。
    }
  };

  const caseColumns: ProColumns<EvalCase>[] = [
    {
      title: '问题',
      dataIndex: 'question',
      ellipsis: true,
      search: false,
      render: (_, r) => (
        <Tooltip title={r.question}>
          <Text>{r.question}</Text>
        </Tooltip>
      ),
    },
    {
      title: '源文档主体',
      dataIndex: 'document_title',
      width: 158,
      search: false,
      // 这三列（document_id / title / key）是这类题的**可复核性前提**：
      // 正文里常写「本公司」，出题时主体只能从文档取来写进问题 ——
      // 所以问题一旦写了公司名，答案的正确性就依赖「这块 chunk 属于那家公司」。
      render: (_, r) => {
        if (!r.document_title) {
          return (
            <Tooltip title="政策/规章类文档没有主体（公司名），此列可为空">
              <Text type="secondary">—</Text>
            </Tooltip>
          );
        }
        // 复核：问题里写的主体应当就是源文档主体
        const subjectInQuestion = r.question.includes(r.document_title);
        return (
          <Tooltip
            title={
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                <div>源文档：{r.document_title}</div>
                {r.document_key ? <div>业务标识：{r.document_key}</div> : null}
                {r.document_id ? <div>document_id：{r.document_id}</div> : null}
                <div style={{ marginTop: 2 }}>
                  {subjectInQuestion
                    ? '✓ 问题中出现该主体，主体归属可复核'
                    : '⚠ 问题中未出现该主体，复核时需人工确认归属'}
                </div>
              </div>
            }
          >
            <div style={{ lineHeight: 1.35 }}>
              <Space size={4}>
                {subjectInQuestion ? null : (
                  <ExclamationCircleOutlined style={{ color: '#faad14' }} />
                )}
                <Text>{r.document_title}</Text>
              </Space>
              {r.document_key ? (
                <div>
                  <Text
                    className={styles.mono}
                    type="secondary"
                    style={{ fontSize: 12 }}
                  >
                    {r.document_key}
                  </Text>
                </div>
              ) : null}
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: '答案原文',
      dataIndex: 'answer_original',
      width: 220,
      ellipsis: true,
      search: false,
      // 位置（offset）比措辞更可靠：判定「有没有召回到」时比对的是位置，
      // 不是字符串相不相等 —— 这样「没召回到」与「召回但措辞对不上」才分得开。
      render: (v, r) => (
        <Tooltip
          title={
            r.answer_start_offset != null && r.answer_end_offset != null
              ? `源 chunk 内字符区间 [${r.answer_start_offset}, ${r.answer_end_offset})`
              : '后端未返回偏移量'
          }
        >
          <Text code style={{ fontSize: 12 }}>
            {v}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '源 chunk',
      dataIndex: 'chunk_id',
      width: 120,
      search: false,
      render: (v) => (
        <Tooltip title={v as string}>
          <Text className={styles.mono} type="secondary">
            {(v as string).slice(0, 8)}…
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'gold chunks',
      dataIndex: 'gold_chunk_ids',
      width: 118,
      search: false,
      render: (_, r) =>
        r.gold_chunk_ids.length > 1 ? (
          <Tooltip
            title={`共 ${r.gold_chunk_ids.length} 个 chunk 均可回答此题（含源 chunk）：${r.gold_chunk_ids
              .map((g) => g.slice(0, 8))
              .join(', ')}`}
          >
            <Tag color="gold">★ {r.gold_chunk_ids.length} 个</Tag>
          </Tooltip>
        ) : (
          <Tag>1 个</Tag>
        ),
    },
    {
      title: 'DTD',
      dataIndex: 'document_type_definition_id',
      width: 130,
      search: false,
      render: (v) => <DtdTag id={v as string} maxWidth={104} />,
    },
    {
      title: '校验状态',
      dataIndex: 'validation_status',
      width: 110,
      valueType: 'select',
      valueEnum: {
        pending: { text: '待校验' },
        validated: { text: '已校验' },
        rejected: { text: '已拒绝' },
      },
      render: (_, r) => {
        const m = VALIDATION_META[r.validation_status];
        return (
          <Tooltip title={r.validation_error}>
            <Badge status={m.status} text={m.text} />
          </Tooltip>
        );
      },
    },
  ];

  if (loading && !bundle) {
    return (
      <PageContainer>
        <Card loading />
      </PageContainer>
    );
  }

  if (!bundle) {
    return (
      <PageContainer>
        <Empty description="Bundle 不存在" />
      </PageContainer>
    );
  }

  const genConfig = bundle.generation_config ?? {};

  return (
    <PageContainer
      title={
        <Space>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/retrieval-eval/bundles')}
          />
          <span>{bundle.name}</span>
          <BundleStatusTag status={bundle.status} />
        </Space>
      }
      breadcrumb={{
        items: [
          { title: '评测' },
          { title: 'Bundle 列表', href: '/retrieval-eval/bundles' },
          { title: bundle.name },
        ],
      }}
      extra={[
        // 只在真的还有没成功的窗口时出现 —— 常驻一个"点了会 409"的按钮是干扰
        retryableWindowCount > 0 ? (
          <Popconfirm
            key="retry"
            title={`重新入队 ${retryableWindowCount} 个未成功的窗口？`}
            description="幂等：已完成的窗口不会再跑，不会重复付模型的钱。"
            okText="重试"
            cancelText="取消"
            onConfirm={handleRetryWindows}
          >
            <Button icon={<ReloadOutlined />} loading={retryingWindows}>
              重试未成功窗口（{retryableWindowCount}）
            </Button>
          </Popconfirm>
        ) : null,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={refreshBase}>
          刷新
        </Button>,
        <Button
          key="export"
          icon={<ExportOutlined />}
          disabled={bundle.status !== 'ready'}
          onClick={handleExport}
        >
          导出数据集
        </Button>,
        <Button
          key="run"
          type="primary"
          disabled={bundle.status !== 'ready'}
          onClick={() =>
            history.push(`/retrieval-eval/runs?bundle=${bundle.bundle_id}`)
          }
        >
          发起跑测
        </Button>,
      ]}
    >
      <Card size="small" style={{ marginBottom: 16 }}>
        <Descriptions column={3} size="small">
          <Descriptions.Item label="Bundle ID">
            <Text className={styles.mono}>{bundle.bundle_id}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="源 chunk 数">
            {bundle.source_chunk_count}
          </Descriptions.Item>
          <Descriptions.Item label="QA 用例数">
            {bundle.case_count}
          </Descriptions.Item>
          <Descriptions.Item label="覆盖 DTD">
            {/* 页头比表格宽松，平铺 3 个；其余折进 +N，行数不至于被它顶起来 */}
            <DtdTagList
              ids={bundle.document_type_definition_ids}
              max={3}
              tagMaxWidth={200}
            />
          </Descriptions.Item>
          <Descriptions.Item label="抽样策略">
            {String(bundle.selection_config?.sampling_strategy ?? '-')}
          </Descriptions.Item>
          <Descriptions.Item label="seed">
            {String(bundle.selection_config?.seed ?? '-')}
          </Descriptions.Item>
          <Descriptions.Item label="M 每块问题数">
            {String(genConfig.questions_per_chunk ?? '-')}
          </Descriptions.Item>
          <Descriptions.Item label="L 每窗块数">
            {String(genConfig.chunks_per_window ?? '-')}
          </Descriptions.Item>
          <Descriptions.Item label="token 预算">
            {String(genConfig.max_input_tokens ?? '-')}
          </Descriptions.Item>
          {/*
            跨块裁决这个开关**改变数据集内容**（决定 gold_chunk_ids 是否只有一个），
            所以必须能从快照里认出来 —— 契约里专门写了 "which mode produced a
            bundle must stay answerable afterwards"。缺了它，两份内容不同的数据集
            在页面上长得一模一样。
          */}
          <Descriptions.Item label="跨块金标裁决">
            {genConfig.enable_cross_chunk_judge === true ? (
              <Tag color="success">由模型评判</Tag>
            ) : (
              <Tooltip title="关闭时金标只有出题那一块：检索返回了另一块同样答得上的内容会被判成假 miss，召回率偏低且从结果里看不出来。">
                <Tag>仅出题块</Tag>
              </Tooltip>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="模型角色">
            {String(genConfig.model_role ?? genRun?.model_role ?? '-')}
          </Descriptions.Item>
          <Descriptions.Item label="模型">
            {/*
              ⚠️ 模型名**不在** generation_config 快照里 —— 后端只在那里存了
              model_role（见 retrieval_eval_service_impl.py 的 generation_config
              构造）。实际解析到的模型名在**造题运行**上，所以这里必须读 genRun。
              原来读 genConfig.model_name 是这个字段永远显示「-」的原因。
            */}
            {genRun?.model_name ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label="数据集指纹">
            {bundle.dataset_sha256 ? (
              <Text className={styles.mono}>
                {bundle.dataset_sha256.slice(0, 16)}…
              </Text>
            ) : (
              <Text type="secondary">未生成</Text>
            )}
          </Descriptions.Item>
        </Descriptions>
        {bundle.description && (
          <Paragraph
            type="secondary"
            style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}
          >
            {bundle.description}
          </Paragraph>
        )}
      </Card>

      <Tabs
        items={[
          {
            key: 'generation',
            label: '生成过程',
            children: genRun ? (
              <WindowPlan
                run={genRun}
                maxInputTokens={Number(genConfig.max_input_tokens ?? 12000)}
              />
            ) : (
              <Empty description="尚未启动生成运行" />
            ),
          },
          {
            key: 'cases',
            label: `QA 用例（${bundle.case_count}）`,
            children: (
              <ProTable<EvalCase>
                rowKey="eval_case_id"
                actionRef={actionRef}
                columns={caseColumns}
                request={async (params) => {
                  const res = await listRetrievalEvalCases(bundle.bundle_id, {
                    page: params.current,
                    page_size: params.pageSize,
                    validation_status: params.validation_status as never,
                  });
                  return { data: res.items, total: res.total, success: true };
                }}
                search={{ labelWidth: 'auto' }}
                pagination={{ defaultPageSize: 20 }}
                options={false}
              />
            ),
          },
          {
            key: 'export',
            label: '导出预览',
            children: (
              <Card size="small">
                <Space
                  orientation="vertical"
                  size={8}
                  style={{ width: '100%' }}
                >
                  <Text>
                    导出为确定性 JSON，仅包含{' '}
                    <Tag color="success">validated</Tag> 用例； 每条含{' '}
                    <Text code>chunk_id</Text>（源块）、
                    <Text code>gold_chunk_ids</Text>
                    （全部可回答块）、<Text code>question</Text>、
                    <Text code>answer_original</Text>（原文精确子串）、
                    <Text code>document_title</Text>/
                    <Text code>document_key</Text>
                    （源文档主体，供外部工具复核）。
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    bundle 内容就绪后不可变；改 N / M / L / DTD 范围需新建
                    bundle。 数据集指纹用于校验复现一致性。
                  </Text>
                  <div style={{ fontSize: 12 }}>
                    {bundle.status === 'ready' ? (
                      <Tag color="success">当前可导出</Tag>
                    ) : (
                      <Tag color="warning">
                        当前状态为 {bundle.status}，导出接口将返回 409
                      </Tag>
                    )}
                  </div>
                </Space>
              </Card>
            ),
          },
        ]}
      />
    </PageContainer>
  );
};

export default RetrievalEvalBundleDetailPage;
