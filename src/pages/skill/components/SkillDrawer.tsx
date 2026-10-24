// src/pages/skill/components/SkillDrawer.tsx
//
// 技能详情 / 编辑 / 新建。三个模式共用一个表单，理由是这一版契约的可写字段
// 不多（name / description / tags / examples / instructions / status）+ 一组
// 绑定，"只读视图"再加一层渲染除了多一份要同步的 UI 没有别的收益。
//
// 几个和契约强绑定的行为，别改：
//   · **PATCH 只发改过的字段**。契约里 SkillPatch 有 minProperties: 1 —— 发 {}
//     是 422。所以下面要先 diff 再决定发不发。
//   · **skill_key 编辑态不可改**。后端没有这个字段（PATCH 带它就是 422），
//     所以不是"禁用一个输入框"这么简单：提交时**绝不能**把它放进 body。
//   · **能力绑定是 PUT 全量替换**，不是增量。所以只有"集合变了"才发，
//     并且发的是当前选中的全集（空数组 = 清空）。
//   · **tags / examples 的"空"不等于"不改"**。后端语义是"不传 = 不改、
//     传 [] = 清空"，所以这两个字段必须显式比对：用户删光标签却没发请求，
//     那边就永远不会变。
//   · 绑定失败不应该吞掉前面的保存：先 PATCH 再 PUT，各自 try，报错分别提示。
import { DeleteOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Segmented,
  Select,
  Spin,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { Capability, SkillDetail, SkillPatch, SkillStatus } from '../data';
import {
  formatDateTime,
  formatExamples,
  normalizeTags,
  parseExamples,
  SKILL_STATUS_META,
  SKILL_STATUS_ORDER,
  sameStringList,
  skillKeyError,
} from '../data';
import {
  createSkill,
  deleteSkill,
  getSkill,
  replaceSkillCapabilities,
  skillErrorMessage,
  updateSkill,
} from '../service';
import { useStyles } from '../style';
import CapabilityTreePicker from './CapabilityTreePicker';

interface FormValues {
  skill_key: string;
  name: string;
  description: string;
  /** A2A tags：Select mode="tags" 给的是数组，提交前还要过一遍 normalizeTags */
  tags: string[];
  /** A2A examples：表单里一行一条，提交前拆成数组（见 parseExamples） */
  examples: string;
  instructions: string;
  status: SkillStatus;
  capability_ids: string[];
}

export interface SkillDrawerProps {
  open: boolean;
  /** null = 新建 */
  skillId: string | null;
  capabilities: readonly Capability[];
  onClose: () => void;
  onSaved: (skill: SkillDetail) => void;
  onDeleted: (skillId: string) => void;
}

const SkillDrawer: React.FC<SkillDrawerProps> = ({
  open,
  skillId,
  capabilities,
  onClose,
  onSaved,
  onDeleted,
}) => {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();

  const isCreate = skillId === null;
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const statusValue = Form.useWatch('status', form);
  const boundIds = Form.useWatch('capability_ids', form);

  // 打开时拉详情并灌进表单。cancelled 是为了防止"连点两张卡"时先发的请求
  // 后回来，把后一张的表单覆盖掉。
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDetail(null);

    if (skillId === null) {
      form.resetFields();
      return;
    }

    let cancelled = false;
    setLoading(true);
    getSkill(skillId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        form.setFieldsValue({
          skill_key: data.skill_key,
          name: data.name,
          description: data.description,
          tags: data.tags,
          examples: formatExamples(data.examples),
          instructions: data.instructions,
          status: data.status,
          capability_ids: data.capabilities.map((item) => item.id),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(skillErrorMessage(err, '加载技能失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, skillId, form]);

  const handleSubmit = useCallback(async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      // 校验失败由 Form.Item 自己标红，不需要再弹全局提示
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (isCreate) {
        const created = await createSkill({
          skill_key: values.skill_key.trim(),
          name: values.name.trim(),
          description: values.description.trim(),
          // 空数组是有意义的：后端 default_factory=list，显式发 [] 与省略等价，
          // 但发出去能让"用户清空了标签"这件事在日志里看得出来。
          tags: normalizeTags(values.tags ?? []),
          examples: parseExamples(values.examples ?? ''),
          instructions: values.instructions,
          status: values.status,
        });
        // 新建时顺手绑能力：契约的 POST 不收 capability_ids，只能另发一次 PUT。
        // 空数组就不发 —— PUT 空数组是"清空"，对新建对象没意义。
        const draft = values.capability_ids ?? [];
        const bound =
          draft.length > 0
            ? await replaceSkillCapabilities(created.id, draft)
            : created.capabilities;
        onSaved({ ...created, capabilities: bound });
        message.success(`已创建「${created.name}」`);
        return;
      }

      if (!detail) return;

      // 只发改过的字段（SkillPatch 是 minProperties: 1，空对象直接 422）
      const patch: SkillPatch = {};
      const name = values.name.trim();
      const description = values.description.trim();
      if (name !== detail.name) patch.name = name;
      if (description !== detail.description) patch.description = description;

      // tags / examples 是"不传=不改、传 [] = 清空"。所以必须显式比对，
      // 否则用户删光标签后不发请求，后端那边永远不会变。
      const tags = normalizeTags(values.tags ?? []);
      if (!sameStringList(tags, detail.tags)) patch.tags = tags;

      const examples = parseExamples(values.examples ?? '');
      if (!sameStringList(examples, detail.examples)) patch.examples = examples;

      if (values.instructions !== detail.instructions) {
        patch.instructions = values.instructions;
      }
      if (values.status !== detail.status) patch.status = values.status;

      const saved =
        Object.keys(patch).length > 0
          ? await updateSkill(detail.id, patch)
          : detail;

      // 绑定是**全量替换**：比较集合，不是比较条数
      const before = [...detail.capabilities.map((item) => item.id)].sort();
      const after = [...(values.capability_ids ?? [])].sort();
      const changed =
        before.length !== after.length ||
        before.some((id, index) => id !== after[index]);

      const bound = changed
        ? await replaceSkillCapabilities(detail.id, values.capability_ids ?? [])
        : saved.capabilities;

      onSaved({ ...saved, capabilities: bound });
      message.success(changed ? '已保存，能力绑定已更新' : '已保存');
    } catch (err: unknown) {
      setError(skillErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  }, [detail, form, isCreate, message, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!detail) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteSkill(detail.id);
      message.success(`已删除「${detail.name}」`);
      onDeleted(detail.id);
    } catch (err: unknown) {
      setError(skillErrorMessage(err, '删除失败'));
    } finally {
      setDeleting(false);
    }
  }, [detail, message, onDeleted]);

  const statusHint = statusValue ? SKILL_STATUS_META[statusValue].hint : '';
  /**
   * 只有"启用 + 零绑定"才报警。
   *
   * 判据不是"是不是新建"：草稿本来就允许先存个空壳，一打开表单就红一片只会
   * 让人以为填错了。真正要拦的是"启用了但一个工具都没有" —— 那种 skill 被主
   * agent 选中后什么都做不了，而且现场看不出来。
   */
  const noBinding = statusValue === 'ACTIVE' && (boundIds?.length ?? 0) === 0;

  const footer = (
    <div className={styles.drawerFooter}>
      <div>
        {isCreate ? null : (
          <Popconfirm
            title="删除这个技能？"
            description="能力绑定会一起删除，且不可恢复。日常退役请改用「已停用」。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={!detail || saving || deleting}
            onConfirm={handleDelete}
          >
            <Button
              danger
              type="text"
              icon={<DeleteOutlined />}
              disabled={!detail || saving}
              loading={deleting}
            >
              删除
            </Button>
          </Popconfirm>
        )}
      </div>
      <div className={styles.drawerFooterRight}>
        <Button onClick={onClose} disabled={saving}>
          取消
        </Button>
        <Button type="primary" loading={saving} onClick={handleSubmit}>
          {isCreate ? '创建' : '保存'}
        </Button>
      </div>
    </div>
  );

  return (
    <Drawer
      open={open}
      size="large"
      forceRender
      // 抽屉里有大段 instructions，误点遮罩就关掉等于白写（v6 用 mask.closable）
      mask={{ closable: false }}
      title={isCreate ? '新建技能' : (detail?.name ?? '技能详情')}
      onClose={onClose}
      footer={footer}
    >
      <Spin spinning={loading}>
        {error ? (
          <Alert
            className={styles.drawerAlert}
            type="error"
            showIcon
            title={error}
            closable={{ onClose: () => setError(null) }}
          />
        ) : null}

        <Form
          form={form}
          layout="vertical"
          disabled={saving || deleting}
          initialValues={{
            status: 'DRAFT',
            capability_ids: [],
            tags: [],
            examples: '',
          }}
        >
          <div className={styles.sectionTitle}>
            基本信息
            <span className={styles.sectionHint}>
              skill_key 是稳定标识，创建后不可改
            </span>
          </div>

          <Form.Item
            label="skill_key"
            name="skill_key"
            required={isCreate}
            extra={
              isCreate
                ? '小写字母开头，只能用小写字母 / 数字 / 下划线，2~120 字符。task board 用它路由，创建后不可修改。'
                : '创建后不可修改；要换标识只能新建一个技能。'
            }
            rules={
              isCreate
                ? [
                    {
                      validator: async (_rule, value: unknown) => {
                        const err = skillKeyError(String(value ?? ''));
                        if (err) throw new Error(err);
                      },
                    },
                  ]
                : []
            }
          >
            <Input placeholder="doc_qa_retrieval" disabled={!isCreate} />
          </Form.Item>

          <Form.Item
            label="名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请填写名称' },
              { max: 200, message: '不超过 200 个字符' },
            ]}
          >
            <Input placeholder="文档检索问答" />
          </Form.Item>

          <Form.Item
            label="状态"
            name="status"
            extra={statusHint}
            rules={[{ required: true, message: '请选择状态' }]}
          >
            <Segmented
              block
              options={SKILL_STATUS_ORDER.map((status) => ({
                value: status,
                label: SKILL_STATUS_META[status].label,
              }))}
            />
          </Form.Item>

          <div className={styles.sectionTitle}>
            路由信息
            <span className={styles.sectionHint}>
              主 agent 只读 name / description 来决定要不要选它
            </span>
          </div>

          <Form.Item
            label="描述"
            name="description"
            rules={[
              { required: true, whitespace: true, message: '请填写描述' },
            ]}
            extra="写给主 agent 看的：这个技能解决什么问题、什么时候该选它。不要写实现细节。"
          >
            <Input.TextArea rows={3} placeholder="面向文档库的多轮检索问答……" />
          </Form.Item>

          <div className={styles.sectionTitle}>
            A2A 元数据
            <span className={styles.sectionHint}>
              发布 AgentCard 时才用到，主 agent 选技能不读它
            </span>
          </div>

          {/* 纯标签编辑器：不给候选，所以回显的就是"已输入的值" */}
          <Form.Item
            label="tags"
            name="tags"
            extra="发布 / 发现用的关键词。A2A 标准要求有这个字段但允许为空；空标签和重复项提交时会自动丢掉。"
          >
            <Select
              mode="tags"
              suffixIcon={null}
              // 没有候选项，给一句"怎么输入"比 antd 默认的空面板 / Not Found 有用
              notFoundContent={
                <span className={styles.selectHint}>
                  输入后按回车（或逗号）确认
                </span>
              }
              showSearch={{ filterOption: false }}
              tokenSeparators={[',', '，']}
              placeholder="回车或逗号确认，例如 legal / contract"
            />
          </Form.Item>

          <Form.Item
            label="examples"
            name="examples"
            extra="一行一条，写「用户会怎么问」的完整问句。只进 AgentCard，不显示在列表卡片上。"
          >
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={
                '这份合同的违约金上限是多少？\n有没有和付款周期冲突的条款？'
              }
            />
          </Form.Item>

          <div className={styles.sectionTitle}>
            行为提示词
            <span className={styles.sectionHint}>
              注入子 agent 节点，不会出现在任何对外卡片里
            </span>
          </div>

          <Form.Item
            label="instructions"
            name="instructions"
            rules={[
              { required: true, whitespace: true, message: '请填写行为提示词' },
            ]}
          >
            <Input.TextArea
              className={styles.monoInput}
              autoSize={{ minRows: 8, maxRows: 20 }}
              placeholder={'你是文档问答子 agent。\n1. …\n2. …'}
            />
          </Form.Item>

          <div className={styles.sectionTitle}>
            能力绑定
            <span className={styles.sectionHint}>
              决定子 agent 能看到哪些工具，不是授权
            </span>
          </div>

          {/* 与工具页「业务分类」同一个控件：树形多选 + 父子互不联动 */}
          <Form.Item name="capability_ids">
            <CapabilityTreePicker capabilities={capabilities} />
          </Form.Item>

          {noBinding ? (
            <div className={styles.bindWarn}>
              已启用但一个能力都没绑：子 agent 会被正常创建，但解析不到 tool_key
              —— 它什么工具都调不了。要么先绑能力，要么把状态改回草稿。
            </div>
          ) : (
            <div className={styles.bindHint}>
              父子可以<b>同时勾</b>，也可以只勾其中一个：绑定是精确匹配，
              勾父能力<b>不会</b>带上子能力的工具 —— 需要哪些就勾哪些。
              列表接口的 <span className={styles.monoKey}>capability_id</span>{' '}
              同样只精确匹配一个节点。
            </div>
          )}

          {detail ? (
            <div className={styles.metaBox}>
              <div>
                <span className={styles.metaKey}>id</span>
                <span className={styles.metaValue}>{detail.id}</span>
              </div>
              <div>
                <span className={styles.metaKey}>创建</span>
                {formatDateTime(detail.created_at)}
              </div>
              <div>
                <span className={styles.metaKey}>更新</span>
                {formatDateTime(detail.updated_at)}
              </div>
            </div>
          ) : null}
        </Form>
      </Spin>
    </Drawer>
  );
};

export default SkillDrawer;
