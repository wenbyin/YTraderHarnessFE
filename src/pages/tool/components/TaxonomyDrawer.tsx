// src/pages/tool/components/TaxonomyDrawer.tsx
// 分类体系 —— 建树 + 新建 + 编辑 + 停用 + 删除。
//
// **契约来源是 capability.yaml（v1.0.0），不是 tool.yaml** ——
// 这套分类为主体的 CRUD 已经整体迁到 `/api/v1/capabilities`，
// 实体在契约里叫 `Capability`。（`/tools/{tool_id}/classifications` 那条
// 「工具挂了哪些分类」的关联接口没搬，仍在 tool.yaml。）
//
// 用 Table 而不是 Tree 展示：需要并排看到 code / sort_order / is_active 三列，
// Tree 的 title 里塞这么多东西会挤成一团。用 Table 的 children 字段即可树形展开。
//
// ── 新建与编辑**共用同一个弹窗**，靠 mode 区分 ──
//
// 早先是「新建 = 抽屉底部内联一张表单项、编辑 = 弹窗」，同一个动作两种形态。
// 抽屉的主体是那棵树，底下再挂一张常驻表单会把树挤短，而且表单填一半去点别的行
// 很容易忘掉它的存在。现在两个动作都在弹窗里，形态一致：
//
//   | | 新建 | 编辑 |
//   | --- | --- | --- |
//   | code | 输入框（必填） | 只读展示，不可改 |
//   | is_active | 不出现（契约的 CapabilityCreate 没这个字段） | Switch |
//   | 提交 | POST /capabilities | PATCH /capabilities/{id}，只发变更字段 |
//
// 所以是**一个 Modal + 一个 Form 实例 + 一份字段 JSX**，字段按 mode 条件渲染，
// 而不是两个几乎一样的 Modal。用 `validateFields(['code','name'])` 显式列字段名：
// 未渲染的 Form.Item 不在校验集合里，显式传比依赖 antd 的隐式行为可靠。
//
// ── 删除的三条契约约束（capability.yaml，写死在后端，前端必须跟着表达）──
//
//  1. **有子分类的节点一律删不掉**（409），而且 **force 无效** —— 自引用 FK
//     故意不做级联。所以这里对有子节点的行**直接禁用删除按钮**，而不是等 409：
//     让用户点一个注定失败的按钮是最差的交互。要删先把子节点挪走或停用。
//
//  2. **仍被工具引用的节点默认也删不掉**（409，错误信息里带引用数），
//     这时才轮到 `force=true`：删掉节点并把它上面的工具绑定一并解掉。
//     所以删除是**两段式** —— 先不带 force 试一次，409 再弹确认问要不要强制。
//
//  3. 删除是**硬删除**（204 无 body），没有回收站。停用（PATCH is_active=false）
//     才是"软删"，历史绑定也保留 —— 提示里要把这两者的区别讲清楚，别让人误删。
//
// ── 编辑为什么走 PATCH 而不是 PUT ──
// 契约同时给了 PATCH 与 PUT。PUT 是**省略即清空**（description / parent_id
// 会被写成 null），一个只想改名的 PUT 还得把 sort_order / is_active 原样传回去，
// 传漏了就是静默重置。这里改成**只发变更字段的 PATCH**：表单怎么填就怎么改，
// 不会因为"某个字段没在表单里渲染"而误清空。
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  type TableColumnsType,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useEffect, useMemo, useState } from 'react';
import {
  buildTree,
  type Capability,
  type CapabilityUpdate,
  classificationMap,
  classPath,
  descendantsOf,
} from '../data';
import {
  createCapability,
  deleteCapability,
  httpStatus,
  listCapabilities,
  updateCapability,
} from '../service';
import { useStyles } from '../style';

interface TaxonomyDrawerProps {
  open: boolean;
  onClose: () => void;
  classifications: Capability[];
  /** 变更后通知外层重新拉一次（树变了，绑定 TAB 的下拉也要跟着变） */
  onReload: (next: Capability[]) => void;
}

/** 弹窗表单的全部字段 —— 新建与编辑共用一份，按 mode 决定渲染哪几个。 */
interface DialogValues {
  code?: string;
  name: string;
  description?: string;
  parent_id?: string;
  sort_order?: number;
  is_active?: boolean;
}

type DialogMode = 'create' | 'edit';

interface DialogState {
  mode: DialogMode;
  /** 仅 edit 有 */
  item?: Capability;
}

const norm = (v?: string | null) => (v ?? '').trim();

const TaxonomyDrawer: React.FC<TaxonomyDrawerProps> = ({
  open,
  onClose,
  classifications,
  onReload,
}) => {
  const { styles } = useStyles();
  const { message, modal } = App.useApp();
  const [busyId, setBusyId] = useState<string | null>(null);

  /** 新建 / 编辑共用的弹窗状态。null = 关闭。 */
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<DialogValues>();

  const map = classificationMap(classifications);

  const isEdit = dialog?.mode === 'edit';
  const editing = isEdit ? (dialog?.item ?? null) : null;

  /** id → 直属子节点数。删除能不能点，全看它。 */
  const childCount = useMemo(() => {
    const m = new Map<string, number>();
    classifications.forEach((c) => {
      if (!c.parent_id) return;
      m.set(c.parent_id, (m.get(c.parent_id) ?? 0) + 1);
    });
    return m;
  }, [classifications]);

  /** 工具栏上那行统计。停用数单独给，是因为它才是"需要留意"的那部分。 */
  const counts = useMemo(() => {
    const total = classifications.length;
    const inactive = classifications.filter(
      (c) => c.is_active === false,
    ).length;
    return { total, inactive, active: total - inactive };
  }, [classifications]);

  const reload = async () => {
    const next = (await listCapabilities()) ?? [];
    onReload(next);
  };

  const toggle = async (item: Capability) => {
    setBusyId(item.id);
    try {
      await updateCapability(item.id, { is_active: !item.is_active });
      message.success(`${item.name} 已${item.is_active ? '停用' : '启用'}`);
      await reload();
    } catch (e: unknown) {
      message.error(
        (e as Error)?.message ?? `${item.is_active ? '停用' : '启用'}失败`,
      );
    } finally {
      setBusyId(null);
    }
  };

  // ---------- 新建 / 编辑（同一个弹窗） ----------

  const openCreate = () => setDialog({ mode: 'create' });

  const openEdit = (item: Capability) => setDialog({ mode: 'edit', item });

  /**
   * 回填必须在 Form **挂载之后**做。
   *
   * 如果在 openCreate / openEdit 里直接 setFieldsValue，那一刻 Modal 还没渲染、
   * Form 实例没接上任何元素，antd 会警告 "Instance created by useForm is not
   * connected to any Form element" 并且值不生效 —— 表现是"打开弹窗是空的"。
   * 放到 effect 里：dialog 变化触发 Modal 挂载，effect 在 DOM 更新之后跑，Form 已就位。
   *
   * 新建时先 resetFields：Form 实例是跨次复用的，不清会带上一次填的残值。
   */
  useEffect(() => {
    if (!dialog) return;
    if (dialog.mode === 'edit' && dialog.item) {
      form.setFieldsValue({
        code: dialog.item.code,
        name: dialog.item.name,
        description: dialog.item.description ?? '',
        parent_id: dialog.item.parent_id ?? undefined,
        sort_order: dialog.item.sort_order ?? 0,
        is_active: dialog.item.is_active ?? true,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ sort_order: 0 });
    }
  }, [dialog, form]);

  /**
   * 可选父节点。
   *
   * 编辑时 = 全部 - 自己 - 自己的全部后代：后端会拦环（409），但那要等一次往返，
   * 这里直接不给选，选项里就没有非法项。新建时没有"自己"这回事，全部可选。
   */
  const parentOptions = useMemo(() => {
    const banned = editing
      ? new Set(descendantsOf(editing.id, classifications))
      : new Set<string>();
    return classifications
      .filter((c) => !banned.has(c.id))
      .map((c) => ({ label: classPath(c.id, map), value: c.id }));
  }, [editing, classifications, map]);

  const submitDialog = async () => {
    if (!dialog) return;

    // 校验失败会 reject —— 单独接住，别让它掉进下面的"接口失败"分支弹成
    // 一条错误消息（校验提示已经由 Form 自己展示在字段下）。
    // 显式列出字段名：未渲染的 Form.Item 不在校验集合里，靠 antd 隐式判断太脆。
    try {
      await form.validateFields(
        dialog.mode === 'create' ? ['code', 'name'] : ['name'],
      );
    } catch {
      return;
    }
    // validateFields 只返回被校验字段，其余字段得从实例上取
    const values = form.getFieldsValue();

    const name = norm(values.name);
    if (!name) {
      message.error('name 不能为空');
      return;
    }

    setSaving(true);
    try {
      if (dialog.mode === 'create') {
        await createCapability({
          code: norm(values.code),
          name,
          description: norm(values.description) || null,
          parent_id: values.parent_id ?? null,
          sort_order: values.sort_order ?? 0,
        });
        message.success('分类已创建');
      } else {
        const cur = dialog.item as Capability;

        // 只发变了的字段 —— 见文件头"为什么走 PATCH"
        const patch: CapabilityUpdate = {};
        if (name !== cur.name) patch.name = name;

        // 表单里留空 = 清掉说明；PATCH 显式传 null 后端才认（它用 model_fields_set 判定）
        const desc = norm(values.description) || null;
        if (desc !== (cur.description ?? null)) patch.description = desc;

        const parent = values.parent_id ?? null;
        if (parent !== (cur.parent_id ?? null)) patch.parent_id = parent;

        const sort = values.sort_order ?? 0;
        if (sort !== (cur.sort_order ?? 0)) patch.sort_order = sort;

        const active = values.is_active ?? true;
        if (active !== (cur.is_active ?? true)) patch.is_active = active;

        if (Object.keys(patch).length === 0) {
          message.info('没有任何改动');
          setDialog(null);
          return;
        }
        await updateCapability(cur.id, patch);
        message.success('已保存');
      }
      setDialog(null);
      await reload();
    } catch (e: unknown) {
      message.error(
        (e as Error)?.message ??
          (dialog.mode === 'create' ? '创建失败' : '保存失败'),
      );
    } finally {
      setSaving(false);
    }
  };

  // ---------- 删除 ----------

  const remove = async (item: Capability, force: boolean) => {
    setBusyId(item.id);
    try {
      await deleteCapability(item.id, force);
      message.success(`已删除 ${item.name}`);
      // 删的正好是弹窗里正在编辑的那个 → 弹窗里已经没有对象了，关掉
      if (editing?.id === item.id) setDialog(null);
      await reload();
    } catch (e: unknown) {
      // 409 且还没强制过 → 大概率是"仍被工具引用"，问一句要不要强制解绑。
      // 子节点那种 409 走不到这里（按钮已经禁用了），但真走到了也一并交给用户判断。
      if (!force && httpStatus(e) === 409) {
        askForce(item, e);
        return;
      }
      message.error((e as Error)?.message ?? '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const askForce = (item: Capability, e: unknown) => {
    modal.confirm({
      title: '这个分类删不掉',
      width: 460,
      content: (
        <>
          <div>{item.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {(e as Error)?.message || '它仍被工具引用，或仍有子分类。'}
          </Typography.Text>
          <div style={{ marginTop: 8 }}>
            强制删除会把它上面的工具绑定一并解掉（ON DELETE CASCADE），
            只靠它分类的工具会变成「未分类」。
            <b>如果它还有子分类，强制也没用</b> —— 得先挪走或停用子节点。
          </div>
        </>
      ),
      okText: '强制删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => remove(item, true),
    });
  };

  // buildTree 产出的 { node, children } 正好是 antd Table 的树形数据结构
  const rows = buildTree(classifications);

  const columns: TableColumnsType<(typeof rows)[number]> = [
    {
      title: '名称',
      dataIndex: ['node', 'name'],
      render: (_: unknown, row) => {
        /*
         * ⚠️ 这一格**只有名字**（2026-10-21 用户：「直接去除下方的小字」）。
         *
         * 以前名字下面还挂一行灰色的祖先路径（`classPath(parent_id)`），本意是
         * 补"它在哪一层"。实际读起来是**每行两行高**、而那行小字八成都被截断，
         * 层级关系在树形缩进里已经看得见 —— 所以删掉，一行一个名字。
         *
         * ⚠️ 名字为什么是 block + nowrap + 省略号
         * ------------------------------------
         *   用户上一轮的要求是「名称折行了直接让两个 span 换行显示」，那时是两个
         *   span；现在只剩一个，block 仍然要留着：普通行内元素会让断点落在**名字
         *   中间**（「智能体运行时流 程编排」），读不出这是一个词。名字独占一行
         *   还放不下时截断，观感比断字好（样式见 style.ts 的 cellName）。
         *
         * ⚠️⚠️ **不要**用 antd 的 <Space> 包这个名字
         * ---------------------------------------
         *   <Space> 的根是 `display: inline-flex` —— 一个**原子**的 inline-level
         *   盒子，**不能跨行断开**。而表格的树形缩进与展开图标是 antd 用
         *   `float: left` 摆的（`antd/es/table/style/expand.js` 里
         *   `.ant-table-row-indent` 与 `.ant-table-row-expand-icon` 都是 float）。
         *
         *   于是当这一格的内容比"图标右边剩下的那点宽度"更宽时，浏览器只能把整块
         *   **挪到浮动元素下方**：图标孤零零留在上一行、文字从单元格最左边起排 ——
         *   就是界面上那个"文字错位"。
         *
         *   换成 block 之后：行盒会被浮动缩窄，文字仍然紧跟图标排，图标永远跟着
         *   第一行 —— 这也是 antd 树形表格本来的用法。
         */
        return <span className={styles.cellName}>{row.node.name}</span>;
      },
    },
    {
      title: 'code',
      dataIndex: ['node', 'code'],
      width: 160,
      render: (code: string) => <span className={styles.mono}>{code}</span>,
    },
    {
      title: 'sort_order',
      dataIndex: ['node', 'sort_order'],
      width: 100,
    },
    {
      title: 'is_active',
      dataIndex: ['node', 'is_active'],
      width: 90,
      render: (active: boolean) =>
        active ? (
          <Tag color="success">启用</Tag>
        ) : (
          <Tag color="warning">停用</Tag>
        ),
    },
    {
      title: '操作',
      width: 160,
      align: 'right',
      render: (_: unknown, row) => {
        const item = row.node;
        const kids = childCount.get(item.id) ?? 0;
        const busy = busyId === item.id;
        return (
          /*
           * 表格内的操作一律 **type="text" 轻量按钮** —— 与文档覆盖页签表格里的
           * 清除按钮同一套。描边按钮在密集表格里会盖过数据本身，一行的视觉重心
           * 应该是分类名，不是三个按钮。
           * 删除额外用 danger（text + danger 仍是红字、无边框）。
           */
          <Space size={0}>
            <Button type="text" size="small" onClick={() => openEdit(item)}>
              编辑
            </Button>
            <Button
              type="text"
              size="small"
              loading={busy}
              onClick={() => toggle(item)}
            >
              {item.is_active ? '停用' : '启用'}
            </Button>
            {/* 有子节点的行不给删 —— 契约里 force 也救不了，别让人点了才知道 */}
            <Tooltip
              title={
                kids > 0
                  ? `还有 ${kids} 个子分类。自引用外键不做级联，force 也删不掉 —— 先把子节点挪走或停用`
                  : '硬删除，不可恢复。只是想让它不参与路由的话，用「停用」'
              }
            >
              <span>
                <Popconfirm
                  title="删除这个分类？"
                  description={
                    <>
                      <b>{item.name}</b> 会被<b>硬删除</b>
                      ，它上面的工具绑定也会一并解掉。
                    </>
                  }
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  disabled={kids > 0}
                  onConfirm={() => remove(item, false)}
                >
                  <Button type="text" size="small" danger disabled={kids > 0}>
                    删除
                  </Button>
                </Popconfirm>
              </span>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="large"
      title="业务分类体系 · /capabilities"
    >
      {/*
        工具栏（与页面其它页签同一套 actionsRow：说明居左、按钮右对齐）。
        新建入口放这儿而不是标题栏 —— 标题栏右侧通常放"这张卡片的显示方式"类控件，
        而"新建"是这个抽屉最重的动作，值得占一行、配一行统计。
      */}
      <div className={styles.actionsRow} style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {counts.total} 个节点 · 启用 {counts.active}
          {counts.inactive ? ` · 停用 ${counts.inactive}` : ''}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Button type="primary" onClick={openCreate}>
          新建分类
        </Button>
      </div>

      {/*
        Table 保持 size="small" —— 与 SchemaPanel 的参数表同一档：
        表格要看的是行与行之间的数据，紧凑一点是对的。
        （表单控件则相反，走默认尺寸；两套尺寸各有理由，不是漏改。）
      */}
      <Table
        size="small"
        rowKey={(row) => row.node.id}
        columns={columns}
        dataSource={rows}
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
      />

      {/*
        新建 / 编辑共用一个弹窗，字段按 mode 条件渲染 —— 见文件头的对照表。
        表单**不设 size**：走 antd 默认尺寸，与工具列表的筛选框、处理器配置
        抽屉里的控件同一档（之前这里写 size="small"，同一个页面两套输入框高度）。
      */}
      <Modal
        open={!!dialog}
        title={
          <Space size={8}>
            <span>{isEdit ? '编辑分类' : '新建分类'}</span>
            {/* 编辑时把 code 亮在标题里 —— 它是这行的真正身份，比 name 更能对上数据 */}
            {editing && (
              <Typography.Text className={styles.mono} type="secondary">
                {editing.code}
              </Typography.Text>
            )}
          </Space>
        }
        okText={isEdit ? '保存' : '创建'}
        cancelText="取消"
        onOk={submitDialog}
        onCancel={() => setDialog(null)}
        confirmLoading={saving}
        destroyOnHidden
      >
        {/*
          code 在编辑时只读 —— 契约里 PATCH / PUT 都不收 code：
          "它是稳定标识，改了会让已有的 Tool 链接变成孤儿"。
          把原因写清楚，否则用户会以为"code 输入框不见了"是个 bug。
        */}
        {isEdit ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            title={
              <>
                <span className={styles.mono}>code</span> 不可修改（稳定标识）
              </>
            }
          />
        ) : null}

        <Form form={form} layout="vertical">
          {isEdit ? null : (
            <Form.Item
              name="code"
              label="code"
              rules={[{ required: true, message: 'code 必填' }]}
              extra="全表唯一（表上就是 UNIQUE），撞了会被后端拒；创建之后不可修改"
            >
              <Input placeholder="us_stock" />
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="name"
            rules={[{ required: true, message: 'name 必填' }]}
          >
            <Input placeholder="美股行情" />
          </Form.Item>
          <Form.Item
            name="description"
            label="description"
            extra={isEdit ? '留空 = 清掉说明' : '可留空'}
          >
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            name="parent_id"
            label="parent_id"
            extra={
              isEdit
                ? '已排除自己与自己的后代（否则成环，后端会 409）'
                : '留空 = 顶级分类'
            }
          >
            {/* showSearch 与工具列表的筛选框同一写法，分类多了能靠路径搜 */}
            <Select
              allowClear
              showSearch={{ optionFilterProp: 'label' }}
              placeholder="（留空 = 顶级）"
              options={parentOptions}
            />
          </Form.Item>
          <Form.Item name="sort_order" label="sort_order">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          {/*
            is_active 只出现在编辑里：契约的 CapabilityCreate 没有这个字段，
            新建的节点一律默认启用，不给用户在新建时就创建出停用节点。
          */}
          {isEdit ? (
            <Form.Item
              name="is_active"
              label="is_active"
              valuePropName="checked"
            >
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>
    </Drawer>
  );
};

export default TaxonomyDrawer;
