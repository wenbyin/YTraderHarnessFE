// src/pages/retrieval_eval/runs/index.tsx
// 跑测列表页 + 发起跑测（选 bundle、max_k、**多轮召回阶梯**）。
//
// 关键约束（对齐 openapi + codegen prompt）：
//   - 一个 case 只对一个 DTD 发起检索，不传多个 DTD；
//   - 跑测阶段不调用 LLM 生成答案 / judge，指标全部来自 gold chunk_id 的集合命中；
//   - 召回本身（recaller）不可覆盖，但**每一路召回多少条**可以（`recall_top_k`）；
//   - 三轮是**逐轮放宽**：第 N 轮只跑第 N-1 轮没命中的 case，所以每轮分母不同。
import {
  MinusCircleOutlined,
  PlusOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, useSearchParams } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import React, { useEffect, useRef, useState } from 'react';

import {
  type AttemptRoundForm,
  DEFAULT_ATTEMPT_ROUNDS,
  defaultRounds,
  FILTER_MODE_OPTIONS,
  MAX_ATTEMPTS,
  REWRITE_OPTIONS,
  rewriteKindsDiffer,
  roundsToAttempts,
} from '../attemptLadder';
import { JobStatusTag } from '../components/StatusTag';
import type {
  CreateEvalRunRequest,
  EvalBundleSummary,
  EvalRunDetail,
} from '../data';
import { rememberEvalRun } from '../runRegistry';
import {
  createRetrievalEvalRun,
  listEvalRunHistory,
  listRetrievalEvalBundles,
} from '../service';
import { useStyles } from '../style';

const { Text } = Typography;

/**
 * 轮次卡片里每个控件的定宽。
 *
 * 定宽是为了**跨行对齐**：每行左边是阶段名（固定 104px 一列），右边是这一步的参数；
 * 参数宽一律 132px，各步的第一个参数才会落在同一条竖线上。
 * 让它们按内容自适应的话，`裁剪 top_k`（5 字）与 `每路条数`（4 字）的输入框会错开，
 * 再叠着阶段名那一列，参差感会被放大成"排版坏了"。
 */
const ROW_ITEM_W = 132;

/**
 * 「查询改写」控件的宽度。
 *
 * 比标量宽：选项文案是 `common · 日期展开` 这类，132px 下会被 Select 截成
 * `common · 日期…`，而"展开"这个词正是它与非模型改写之外那些选项的区别。
 */
const REWRITE_ITEM_W = 200;

/**
 * 「过滤」三态下拉的宽度。
 *
 * 比标量略宽：最长的选项是 `按阈值`（3 字 + 箭头），132px 下箭头会贴着文字。
 */
const FILTER_ITEM_W = 140;

const RetrievalEvalRunsPage: React.FC = () => {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const actionRef = useRef<ActionType | undefined>(undefined);
  const [searchParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bundles, setBundles] = useState<EvalBundleSummary[]>([]);
  const [form] = Form.useForm();
  // 实时读回这三项，用来在提交前发现「裁剪条数 < max_k」这类口径不一致
  const maxK = Form.useWatch('max_k', form) as number | undefined;
  const attemptRounds = Form.useWatch('attempts', form) as
    | AttemptRoundForm[]
    | undefined;

  // 从 URL 带 bundle 参数进来时自动开抽屉并预选
  useEffect(() => {
    const b = searchParams.get('bundle');
    if (b) {
      setDrawerOpen(true);
      form.setFieldsValue({ bundle_id: b });
    }
  }, [searchParams, form]);

  useEffect(() => {
    if (drawerOpen) {
      listRetrievalEvalBundles({ page: 1, page_size: 100 }).then((r) =>
        setBundles(
          r.items.filter(
            (x) => x.status === 'ready' || x.status === 'partial_failed',
          ),
        ),
      );
    }
  }, [drawerOpen]);

  /**
   * 口径一致性检查：`max_k` 是命中判定的截断位置，而实际返回多少条由
   * **该轮的 `cutter.top_k`** 决定。二者对不上时 `hit_rate_at_k` 的分母写着
   * 一个数、实际测的是另一个，而且不报错。
   *
   * ⚠️ 注意这与单轮时代的规则不同：建轮次时后端会把**运行级** cutter.top_k
   * 自动补到 `max(max_k, 曲线最大 k)`，但逐轮的 `cutter` 是**整段替换**运行级
   * 配置的（`build_retrieve_request` 是整体取值，不是字段合并），所以轮次里
   * 显式写的 `cutter.top_k` 不会被补。这里提前把不一致指出来。
   */
  const narrowRounds = (attemptRounds ?? []).filter(
    (r) => r?.cutter_top_k != null && maxK != null && r.cutter_top_k < maxK,
  );

  /**
   * 逐轮换改写器 → 相邻两轮的差里混进了「改写器换了」这个变量。
   *
   * ⚠️ 内置阶梯**就是**这样的（第 1 轮 common、第 2 轮 llm、第 3 轮不改），
   * 所以这条提示在默认状态下也会出现 —— 那是对的：它讲的是默认阶梯的真实
   * 性质（后端在 `DEFAULT_ATTEMPT_LADDER` 上写着同一条 caveat）。不提示的话
   * 用户会拿 `第 3 轮 - 第 2 轮` 当"纯精排收益"，而里面还含着少一次改写的损失。
   */
  const rewriteMismatch = rewriteKindsDiffer(attemptRounds ?? []);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const attempts = roundsToAttempts(
      (values.attempts ?? []) as AttemptRoundForm[],
    );
    const body: CreateEvalRunRequest = {
      bundle_id: values.bundle_id,
      max_k: values.max_k,
      include_stage_trace: values.include_stage_trace,
      // ⚠️ 只发 `attempts`，**不发** `query_processor_override`。
      //
      // 契约：传了 attempts 时以它为准、后者被忽略；而「不传 attempts」时后端
      // 用的是内置三档阶梯，那三档**每一轮都自带 retrieve_processor**，于是
      // 运行级 override 同样不生效。换句话说这个页面上它无论如何都不会生效 ——
      // 发了它只会让后来读代码的人以为"这里还能覆盖 DTD"，而实际上没有任何
      // 一条路径用到它。四段配置因此统一由**轮次**表达。
      attempts,
    };
    const res = await createRetrievalEvalRun(body);
    // 契约里没有「列出跑测」端点，列表页只能靠本机登记的 id 逐个拉详情
    // （见 runRegistry.ts）。不记的话这一次跑测在列表里根本不会出现。
    rememberEvalRun(res.eval_run_id);
    message.success('跑测已入队，正在后台执行');
    setDrawerOpen(false);
    history.push(`/retrieval-eval/runs/${res.eval_run_id}`);
  };

  const columns: ProColumns<EvalRunDetail>[] = [
    {
      title: '跑测 ID',
      dataIndex: 'eval_run_id',
      width: 140,
      search: false,
      render: (v) => (
        <Typography.Link
          onClick={() => history.push(`/retrieval-eval/runs/${v}`)}
        >
          <Text className={styles.mono}>{(v as string).slice(0, 8)}…</Text>
        </Typography.Link>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      search: false,
      render: (_, r) => <JobStatusTag status={r.status} />,
    },
    {
      title: 'max_k',
      dataIndex: 'max_k',
      width: 80,
      search: false,
    },
    {
      title: 'Hit@1',
      dataIndex: ['metrics', 'hit_rate_at_1'],
      width: 92,
      search: false,
      render: (_, r) => fmtPct(r.metrics.hit_rate_at_1),
    },
    {
      title: 'Hit@5',
      dataIndex: ['metrics', 'hit_rate_at_5'],
      width: 92,
      search: false,
      render: (_, r) => fmtPct(r.metrics.hit_rate_at_5),
    },
    {
      title: 'Hit@K',
      dataIndex: ['metrics', 'hit_rate_at_k'],
      width: 92,
      search: false,
      render: (_, r) => <Text strong>{fmtPct(r.metrics.hit_rate_at_k)}</Text>,
    },
    {
      title: 'MRR@K',
      dataIndex: ['metrics', 'mrr_at_k'],
      width: 92,
      search: false,
      render: (_, r) =>
        r.metrics.mrr_at_k == null ? '-' : r.metrics.mrr_at_k.toFixed(4),
    },
    {
      title: 'P95 延迟',
      dataIndex: ['metrics', 'p95_latency_ms'],
      width: 100,
      search: false,
      render: (_, r) =>
        r.metrics.p95_latency_ms == null
          ? '-'
          : `${r.metrics.p95_latency_ms} ms`,
    },
    {
      title: '用例数',
      dataIndex: 'total_cases',
      width: 84,
      search: false,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      valueType: 'dateTime',
      width: 165,
      search: false,
    },
    {
      title: '操作',
      valueType: 'option',
      width: 100,
      render: (_, r) => [
        <Typography.Link
          key="d"
          onClick={() => history.push(`/retrieval-eval/runs/${r.eval_run_id}`)}
        >
          查看分析
        </Typography.Link>,
      ],
    },
  ];

  return (
    <PageContainer
      title="检索评测 · 跑测"
      subTitle="对冻结的 QA bundle 做确定性召回测试，统计命中率与 gold chunk 丢弃原因"
      extra={[
        <Button
          key="new"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setDrawerOpen(true)}
        >
          发起跑测
        </Button>,
      ]}
    >
      <ProTable<EvalRunDetail>
        rowKey="eval_run_id"
        actionRef={actionRef}
        columns={columns}
        request={async () => {
          const rows = await listEvalRunHistory();
          return { data: rows, total: rows.length, success: true };
        }}
        search={false}
        pagination={{ defaultPageSize: 10 }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="本机还没有跑测记录 —— 点右上角「发起跑测」开始"
            />
          ),
        }}
      />

      <Drawer
        title="发起检索跑测"
        size={720}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              onClick={handleSubmit}
            >
              开始跑测
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            max_k: 10,
            include_stage_trace: true,
            // 预填内置三档阶梯（`DEFAULT_ATTEMPT_LADDER`）—— 见 attemptLadder.ts
            attempts: defaultRounds(),
          }}
        >
          <Form.Item
            label="目标 Bundle"
            name="bundle_id"
            rules={[{ required: true, message: '请选择 bundle' }]}
            extra="只有就绪 / 部分失败的 bundle 可跑测"
          >
            <Select
              placeholder="选择 bundle"
              options={bundles.map((b) => ({
                value: b.bundle_id,
                label: `${b.name}（${b.case_count} 用例）`,
              }))}
            />
          </Form.Item>

          <Space size={16}>
            <Form.Item
              label="max_k"
              name="max_k"
              style={{ width: 140 }}
              extra="命中判定的截断位置"
            >
              <InputNumber min={1} max={1000} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              label="包含阶段 trace"
              name="include_stage_trace"
              valuePropName="checked"
              extra="关闭则不留分阶段明细"
            >
              <Switch />
            </Form.Item>
          </Space>

          <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
            <Text style={{ fontSize: 13 }}>多轮召回阶梯</Text>
          </Divider>

          {/*
            ⚠️ 语义（决定这里为什么长这样）：
              · 第 N 轮**只跑第 N-1 轮没命中的 case** —— 每轮分母不同，
                所以「2 轮 vs 3 轮的增量」只有在**逐轮分开统计**下才成立；
              · 未开启的段（精排 / 过滤）是**继承该 DTD 的配置**，不是「关闭」。
                所以它们是开关而不是「填个 false」—— 混起来会静默改错配置；
              · **查询改写是唯一的例外**：它没有 DTD 回落，「不改写」就是
                不传这个字段（`QueryRewriterConfig` 在 data.d.ts 里写了理由）。
                所以它用三态 Select 而不是开关 —— 开关只有两态，表达不了
                「common / llm」这两档；
              · 整段配置都走**轮次**表达，不再发运行级 query_processor_override
                （理由见 handleSubmit）。
            默认三档即后端内置阶梯：召回/融合/裁剪逐轮放宽，第 3 轮才开精排
            （精排贵 —— top_n=50 实测 45 秒 —— 只让前两轮都没找到的那批去付），
            改写则逐轮换档：第 1 轮 common（免费白送的基线）、第 2 轮 llm
            （换种说法再查一次）、第 3 轮不改（那时要读的是精排的增量）。
          */}

          {narrowRounds.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              title="裁剪条数小于 max_k，命中口径会对不上"
              description={`第 ${narrowRounds
                .map((r) => r.name || '?')
                .join(
                  ' / ',
                )} 轮 top_k 小于 max_k（${maxK ?? '-'}），Hit@K 会偏低`}
            />
          )}

          {rewriteMismatch && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              title="逐轮用了不同的查询改写器"
            />
          )}

          <Form.List name="attempts">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field, idx) => (
                  <Card
                    key={field.key}
                    size="small"
                    title={
                      <Space size={8}>
                        <Tag color="blue">第 {idx + 1} 轮</Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {idx === 0
                            ? '全部 case'
                            : `只跑第 ${idx} 轮未命中的 case`}
                        </Text>
                      </Space>
                    }
                    extra={
                      fields.length > 1 ? (
                        <Button
                          type="text"
                          danger
                          size="small"
                          icon={<MinusCircleOutlined />}
                          onClick={() => remove(field.name)}
                        >
                          删除
                        </Button>
                      ) : null
                    }
                    style={{ marginBottom: 12 }}
                  >
                    {/*
                      布局：**一步一行，且行的顺序 = 后端真实的检索顺序**。

                      用户在这张卡里配的是一条流水线，所以行的顺序就该是执行顺序：
                      查询改写 → 多路召回 → 融合 → 过滤 → 精排 → 裁剪。
                      依据是后端 `RetrieveProcessor.run`：改写（`_rewrite_query`）在
                      检索之前跑，之后是 多路 recall（并行）→ fusioner → filter →
                      reranker → cutter。

                      原来「裁剪 top_k」和「查询改写」挤在同一行、而且排在融合之前 ——
                      等于用排版讲了一个相反的因果（读起来像"先裁剪、再改写、再召回"）。

                      每行一个阶段：左边阶段名（带序号），右边这一步的参数。参数多于一行时
                      （覆盖过滤展开后是 4 个控件，抽屉里一行只放得下 3 个）换行落在
                      **参数列**里，不会跑到阶段名下面去（见 style.ts 的 stageRow）。
                    */}
                    <div data-round-stages>
                      {/* 轮次名：这轮的标识，不是流水线的一步 —— 单独一行、不占序号 */}
                      <div
                        className={`${styles.stageRow} ${styles.stageRowIdentity}`}
                        data-stage="identity"
                      >
                        <div
                          className={`${styles.stageName} ${styles.stageNameMuted}`}
                        >
                          轮次名
                        </div>
                        <div className={styles.stageControls}>
                          <Form.Item
                            name={[field.name, 'name']}
                            style={{ width: ROW_ITEM_W, marginBottom: 0 }}
                          >
                            <Input placeholder="round1" aria-label="轮次名" />
                          </Form.Item>
                        </div>
                      </div>

                      {/* ① 查询改写 —— 在召回**之前**，改的是 query 本身 */}
                      <div className={styles.stageRow} data-stage="rewrite">
                        <div
                          className={styles.stageName}
                          title="召回之前对 query 的改写。它不是检索的一个 stage（不进 trace），但确实发生在召回前，所以排在第一行。"
                        >
                          <span className={styles.stageNo}>1</span>
                          查询改写
                        </div>
                        <div className={styles.stageControls}>
                          <Form.Item
                            label="改写档位"
                            name={[field.name, 'rewrite_kind']}
                            style={{ width: REWRITE_ITEM_W, marginBottom: 0 }}
                            // 这一层的语义与四段覆盖**相反**（那四段「不传 = 继承
                            // DTD」，这里「不传 = 不改写」），所以用 tooltip 讲清楚，
                            // 不另设开关 —— 开关会把两种语义混成一个。
                            tooltip="召回之前对 query 的改写。不改写 = 整个字段不发给后端（没有「继承该 DTD」这回事：改写会改变 query 本身，不该由文档类型决定）。common 只把日期展开成中文/短横线两种写法，不调模型所以免费；llm 调一次模型按提示词改写，失败/超时自动退回原文并标 degraded，不影响检索。"
                          >
                            <Select options={REWRITE_OPTIONS} />
                          </Form.Item>
                        </div>
                      </div>

                      {/* ② 多路召回 —— 每一路各取一个候选池 */}
                      <div className={styles.stageRow} data-stage="recall">
                        <div
                          className={styles.stageName}
                          title="每一路召回各取多少条候选。路数由该 DTD 决定，这里只控制「每路几条」，所以叫「每路条数」而不是「召回条数」。"
                        >
                          <span className={styles.stageNo}>2</span>
                          多路召回
                        </div>
                        <div className={styles.stageControls}>
                          <Form.Item
                            label="每路条数"
                            name={[field.name, 'recall_top_k']}
                            style={{ width: ROW_ITEM_W, marginBottom: 0 }}
                            rules={[{ required: true, message: '必填' }]}
                          >
                            <InputNumber
                              min={1}
                              max={500}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                        </div>
                      </div>

                      {/*
                        ③ 融合过滤 —— 两个处理器（fusioner → filter）合成一行。
                        用户读这张卡时把它当一个步骤，所以不拆两行；顺序仍然是
                        「先融合 top_k，再按阈值过滤」（`RetrieveProcessor.run` 里就是
                        `_fuse` 然后 `filter.apply`）。
                      */}
                      <div className={styles.stageRow} data-stage="fusion">
                        <div
                          className={styles.stageName}
                          title="fusioner 先把多路候选合并（RRF）并截到 top_k，之后 filter 再按阈值过滤。两个处理器，此顺序。"
                        >
                          <span className={styles.stageNo}>3</span>
                          融合过滤
                        </div>
                        <div className={styles.stageControls}>
                          <Form.Item
                            label="融合 top_k"
                            name={[field.name, 'fusioner_top_k']}
                            style={{ width: ROW_ITEM_W, marginBottom: 0 }}
                            rules={[{ required: true, message: '必填' }]}
                          >
                            <InputNumber
                              min={1}
                              max={5000}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                          {/*
                            过滤只有**一个**控件（三态）。原来这里是「覆盖过滤」+「过滤状态」
                            两颗开关并排，而且都默认打开 —— 看着就是"同一个东西放了两个"。

                            真相是：filter 这一段没有 DTD 级配置，后端默认 enabled=true、
                            不设阈值。于是「不覆盖」和「覆盖 + 启用」在默认阈值下结果一样，
                            两颗开关的区别只体现在第三种状态（关掉过滤）。三种状态用一个
                            下拉讲清楚，比两颗开关省一次推理。
                          */}
                          <Form.Item
                            label="过滤"
                            name={[field.name, 'filter_mode']}
                            style={{ width: FILTER_ITEM_W, marginBottom: 0 }}
                            tooltip="后端默认「启用、不设阈值」——所以这里的三态是：默认 = 不覆盖，只做归属/元数据过滤；按阈值 = 额外按分数筛，下方的 score_threshold 才生效；关闭 = 这一轮整段跳过过滤（做消融用）。"
                          >
                            <Select options={FILTER_MODE_OPTIONS} />
                          </Form.Item>
                          <Form.Item
                            noStyle
                            shouldUpdate={(prev, cur) =>
                              prev.attempts?.[idx]?.filter_mode !==
                              cur.attempts?.[idx]?.filter_mode
                            }
                          >
                            {({ getFieldValue }) =>
                              getFieldValue([
                                'attempts',
                                idx,
                                'filter_mode',
                              ]) === 'on' ? (
                                <Form.Item
                                  label="score_threshold"
                                  name={[field.name, 'score_threshold']}
                                  style={{ width: 160, marginBottom: 0 }}
                                >
                                  <InputNumber
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    style={{ width: '100%' }}
                                  />
                                </Form.Item>
                              ) : null
                            }
                          </Form.Item>
                        </div>
                      </div>

                      {/* ④ 精排 —— 在过滤之后、裁剪之前；最贵，默认不跑 */}
                      <div className={styles.stageRow} data-stage="rerank">
                        <div
                          className={styles.stageName}
                          title="reranker 在过滤之后、裁剪之前重排。cross_encoder 实测很贵（top_n=50 约 45 秒），所以内置阶梯只让前两轮都没找到的那批去付。"
                        >
                          <span className={styles.stageNo}>4</span>
                          精排
                        </div>
                        <div className={styles.stageControls}>
                          <Form.Item
                            label="覆盖精排"
                            name={[field.name, 'override_reranker']}
                            valuePropName="checked"
                            style={{ width: ROW_ITEM_W, marginBottom: 0 }}
                            tooltip="打开 = 这一轮启用精排并用下面的值整段替换该 DTD 的 reranker 配置。关掉 = 继承 DTD（多数情况就是不跑精排）。"
                          >
                            <Switch size="small" />
                          </Form.Item>
                          <Form.Item
                            noStyle
                            shouldUpdate={(prev, cur) =>
                              prev.attempts?.[idx]?.override_reranker !==
                              cur.attempts?.[idx]?.override_reranker
                            }
                          >
                            {({ getFieldValue }) =>
                              getFieldValue([
                                'attempts',
                                idx,
                                'override_reranker',
                              ]) ? (
                                <>
                                  <Form.Item
                                    label="类型"
                                    name={[field.name, 'reranker_type']}
                                    style={{ width: 160, marginBottom: 0 }}
                                  >
                                    <Select
                                      options={[
                                        {
                                          value: 'cross_encoder',
                                          label: 'cross_encoder',
                                        },
                                        { value: 'llm', label: 'llm' },
                                        { value: 'custom', label: 'custom' },
                                      ]}
                                    />
                                  </Form.Item>
                                  <Form.Item
                                    label="top_n"
                                    name={[field.name, 'reranker_top_n']}
                                    style={{
                                      width: ROW_ITEM_W,
                                      marginBottom: 0,
                                    }}
                                  >
                                    <InputNumber
                                      min={1}
                                      max={5000}
                                      style={{ width: '100%' }}
                                    />
                                  </Form.Item>
                                </>
                              ) : null
                            }
                          </Form.Item>
                        </div>
                      </div>

                      {/* ⑤ 裁剪 —— 流水线的最后一步，交给评测的就是这一步的结果 */}
                      <div className={styles.stageRow} data-stage="cut">
                        <div
                          className={styles.stageName}
                          title="cutter 截到 top_k 条，这就是交给评测的那批结果。它必须 ≥ max_k，否则 Hit@K 的分母和实际测的对不上（页面会当场警告）。"
                        >
                          <span className={styles.stageNo}>5</span>
                          裁剪
                        </div>
                        <div className={styles.stageControls}>
                          <Form.Item
                            label="裁剪 top_k"
                            name={[field.name, 'cutter_top_k']}
                            style={{ width: ROW_ITEM_W, marginBottom: 0 }}
                            rules={[{ required: true, message: '必填' }]}
                          >
                            <InputNumber
                              min={1}
                              max={1000}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}

                <Space size={12}>
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    disabled={fields.length >= MAX_ATTEMPTS}
                    onClick={() =>
                      add(
                        DEFAULT_ATTEMPT_ROUNDS[fields.length] ??
                          DEFAULT_ATTEMPT_ROUNDS[1],
                      )
                    }
                  >
                    新增一轮（最多 {MAX_ATTEMPTS} 轮）
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      form.setFieldsValue({ attempts: defaultRounds() })
                    }
                  >
                    恢复内置阶梯
                  </Button>
                </Space>
              </>
            )}
          </Form.List>

          <div style={{ marginTop: 16 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              <Tag>提示</Tag>
              跑测是后台任务：提交后跳到详情页自动轮询。
              <br />
              每轮 <Text strong>cutter.top_k</Text> 必须 ≥ max_k，否则 Hit@K
              会偏低。
            </Text>
          </div>
        </Form>
      </Drawer>
    </PageContainer>
  );
};

function fmtPct(v?: number | null) {
  if (v == null) return <Text type="secondary">-</Text>;
  const pct = v * 100;
  const color = pct >= 90 ? '#3f8600' : pct >= 75 ? '#d48806' : '#cf1322';
  return (
    <Text style={{ color, fontVariantNumeric: 'tabular-nums' }}>
      {pct.toFixed(1)}%
    </Text>
  );
}

export default RetrievalEvalRunsPage;
