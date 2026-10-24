// src/pages/retrieval_eval/index.tsx
// 检索评测 · Bundle 列表页（入口）。
// 一个 bundle = 一套冻结的 QA 数据集；点行进详情看生成过程中的窗口切分与用例。
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, Link } from '@umijs/max';
import { App, Tooltip, Typography } from 'antd';
import React, { useRef } from 'react';
import BundleCreateModal from './components/BundleCreateModal';
import DtdTagList from './components/DtdTagList';
import { BundleStatusTag } from './components/StatusTag';
import type { CreateEvalBundleRequest, EvalBundleSummary } from './data';
import { useDtdOptions } from './dtdOptions';
import { createRetrievalEvalBundle, listRetrievalEvalBundles } from './service';
import { useStyles } from './style';

const { Text } = Typography;

/**
 * 各列定值宽之和 —— 传给 `scroll.x`，**改任何一列的宽度都要同步这个数**。
 *
 * 两条实测结论（1500 宽的窗口下量的，别再靠猜）：
 *
 *   · 容器 1085、列宽之和若 > 1085 → 表格变横向滚动；此时「操作」列会跑到
 *     可视区外面，用户得先横向滚一下才能点「详情」。所以这个和优先控制在
 *     **1048** 附近（常见窗口下不出现滚动条），而不是"总之给个 scroll.x"。
 *   · `valueType:'option'` **不会**自动 `fixed:'right'`（编译产物里唯一的
 *     `fixed:"right"` 是 ProTable 列设置菜单的"固定在列尾"）。想让操作列常驻
 *     可点必须显式写 `fixed:'right'` —— 这里就这么做的。
 */
const BUNDLE_TABLE_MIN_W = 88 + 220 + 84 + 80 + 176 + 128 + 152 + 120;

const RetrievalEvalBundleListPage: React.FC = () => {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const actionRef = useRef<ActionType | undefined>(undefined);
  // 订阅 DTD 选项：拉到之后这一个 hook 会让本页重渲染，下面的 dtdLabel 才有名字可用
  const dtds = useDtdOptions();

  const handleCreate = async (values: CreateEvalBundleRequest) => {
    const res = await createRetrievalEvalBundle(values);
    message.success(
      `已创建 bundle，生成任务已入队（run ${res.generation_run_id.slice(0, 8)}…）`,
    );
    actionRef.current?.reload();
    // 造题是分钟级的后台任务（202 受理）：直接进详情页看窗口进度，
    // 比停在列表上等一个不知道什么时候变的状态更有意义（详情页会在
    // generating 期间轮询，见 detail.tsx）。
    history.push(`/retrieval-eval/bundles/${res.bundle_id}`);
  };

  const columns: ProColumns<EvalBundleSummary>[] = [
    {
      // ⚠️ 这里原本是「关键词」模糊搜索框，已换成 DTD 筛选。
      //    契约（retrieval_eval_openapi.yaml 的 GET /bundles 参数，以及后端
      //    list_bundles 的签名）只认 status 与 document_type_definition_id ——
      //    没有 keyword。留着那个框就是一个永远筛不出东西的输入框。
      title: '覆盖 DTD',
      dataIndex: 'document_type_definition_id',
      valueType: 'select',
      hideInTable: true,
      fieldProps: {
        placeholder: '只看覆盖了某个 DTD 的 bundle',
        showSearch: { optionFilterProp: 'label' },
        options: dtds.map((d) => ({
          value: d.document_type_definition_id,
          label: `${d.type_key} · ${d.name}`,
        })),
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      valueType: 'select',
      width: 88,
      valueEnum: {
        draft: { text: '草稿' },
        generating: { text: '生成中' },
        ready: { text: '就绪' },
        partial_failed: { text: '部分失败' },
        failed: { text: '失败' },
        archived: { text: '已归档' },
      },
      render: (_, r) => <BundleStatusTag status={r.status} />,
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 220,
      ellipsis: true,
      search: false,
      render: (_, r) => (
        <Tooltip title={r.name}>
          <Typography.Link
            strong
            onClick={() => history.push(`/retrieval-eval/${r.bundle_id}`)}
          >
            {r.name}
          </Typography.Link>
        </Tooltip>
      ),
    },
    {
      title: '源 chunk',
      dataIndex: 'source_chunk_count',
      width: 84,
      align: 'right',
      search: false,
    },
    {
      title: '用例数',
      dataIndex: 'case_count',
      width: 80,
      align: 'right',
      search: false,
    },
    {
      // ⚠️ 只平铺一个标签，其余折进 `+N`。
      //    一条 bundle 可能覆盖 8 个 DTD，8 个标签竖排会让**这一行的高度由这一列
      //    决定**（实测整行 150px），别的列都是一个短值 → 表格头重脚轻；标签还会
      //    撑破列宽溢到邻列上。全量在 `+N` 的 Popover 里，一点没丢。
      title: '覆盖 DTD',
      dataIndex: 'document_type_definition_ids',
      width: 176,
      search: false,
      render: (_, r) => (
        <DtdTagList ids={r.document_type_definition_ids} tagMaxWidth={112} />
      ),
    },
    {
      title: '数据集指纹',
      dataIndex: 'dataset_sha256',
      width: 128,
      search: false,
      render: (v) =>
        v ? (
          <Text className={styles.mono} type="secondary">
            {(v as string).slice(0, 12)}…
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      valueType: 'dateTime',
      width: 152,
      search: false,
    },
    {
      title: '操作',
      valueType: 'option',
      // 显式 fixed：表格一旦横向滚动，「详情 / 发起跑测」必须还在可视区里可点
      fixed: 'right',
      width: 120,
      render: (_, r) => [
        <Link key="detail" to={`/retrieval-eval/bundles/${r.bundle_id}`}>
          详情
        </Link>,
        <Link key="run" to={`/retrieval-eval/runs?bundle=${r.bundle_id}`}>
          发起跑测
        </Link>,
      ],
    },
  ];

  return (
    <PageContainer
      title="检索评测 · Bundle"
      subTitle="DTD 抽样 chunk → LLM 逆向出题 → 冻结 QA 数据集"
      extra={[<BundleCreateModal key="create" onSubmit={handleCreate} />]}
    >
      <ProTable<EvalBundleSummary>
        rowKey="bundle_id"
        actionRef={actionRef}
        columns={columns}
        request={async (params) => {
          const res = await listRetrievalEvalBundles({
            page: params.current,
            page_size: params.pageSize,
            status: params.status as never,
            document_type_definition_id: params.document_type_definition_id as
              | string
              | undefined,
          });
          return { data: res.items, total: res.total, success: true };
        }}
        pagination={{ defaultPageSize: 20 }}
        search={{ labelWidth: 'auto' }}
        scroll={{ x: BUNDLE_TABLE_MIN_W }}
      />
    </PageContainer>
  );
};

export default RetrievalEvalBundleListPage;
