// src/pages/tool/index.tsx
// 工具定义管理 —— 直接对应 tool.yaml（Tool Definition Management API v1.0.0）。
//
// 页面形态由契约决定，不是设计选择：
//
//   - ToolManifest 全字段 readOnly → 概览页一个输入框都没有。
//   - 只有 description_override / return_description_override /
//     parameter_descriptions / 分类 是人能改的。
//   - ToolDocumentation 同时返回 source 与 effective_*，而 LLM 消费 effective
//     → 文档页每个字段必须同时呈现「代码写的 / 我写的 / 最终生效的」。
//
// 两个与后端现状有关的事实：
//   - 首屏有多个 GET 并行（列表 / 能力树 / provider 清单），任何一个失败都要
//     退化成页内告警或空下拉，不能刷一片 toast —— 见 service.ts 的 skipErrorHandler。
//   - 列表不做分页器：Tool 的量级是几百而不是几万，一次取满放进可滚动列表更好用。

import { NodeIndexOutlined, SyncOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ClassEditor from './components/ClassEditor';
import DocEditor from './components/DocEditor';
import ManifestPanel from './components/ManifestPanel';
import ProcessorChainPanel from './components/ProcessorChainPanel';
import SchemaPanel from './components/SchemaPanel';
import SyncModal from './components/SyncModal';
import TaxonomyDrawer from './components/TaxonomyDrawer';
import type { ToolFilters } from './components/ToolList';
import ToolList, { emptyFilters } from './components/ToolList';
import ToolStatusTag from './components/ToolStatusTag';
import {
  buildDocPutBody,
  type Capability,
  type DocDraft,
  isDocDirty,
  isToolEnabled,
  type MCPProviderSummary,
  openDocDraft,
  TOOL_DISABLED_COLOR,
  type ToolDefinitionDetail,
  type ToolSummary,
} from './data';
import { useEnumLabels } from './enumLabels';
import { applyFilterPatch } from './mcpProvider';
import {
  getTool,
  listCapabilities,
  listMcpProviders,
  listTools,
  replaceToolClassifications,
  replaceToolDocumentation,
  setToolEnabled,
} from './service';
import { useStyles } from './style';

/** 一次取满（契约上限 200）。Tool 的量级撑不到需要分页器。 */
const PAGE_SIZE = 100;

type TabKey = 'overview' | 'doc' | 'schema' | 'class' | 'chain';

const ToolPage: React.FC = () => {
  const { styles } = useStyles();
  const labels = useEnumLabels();
  const { message, modal } = App.useApp();

  const [filters, setFilters] = useState<ToolFilters>(emptyFilters());
  const [items, setItems] = useState<ToolSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 分类字典一次拉全 —— 几十上百个节点，前端自己建树比按层懒加载简单。 */
  const [classifications, setClassifications] = useState<Capability[]>([]);

  /**
   * MCP provider 清单（GET /mcp/providers）。
   *
   * 只拉一次、不跟着筛选走：它是**筛选项的选项**，不是结果。跟随筛选刷新
   * 会让下拉在每次查询时闪一下，而且 provider 集合与筛选条件无关。
   */
  const [providers, setProviders] = useState<MCPProviderSummary[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ToolDefinitionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [docDraft, setDocDraft] = useState<DocDraft | null>(null);
  const [classDraft, setClassDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState<'doc' | 'class' | null>(null);
  /** 运行时开关的在途状态。它是个 PATCH，不能和上面两个保存互斥（不是同一份草稿）。 */
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  /** 处理链的脏标记由面板自己算（items vs saved），这里只接过来点亮 tab。 */
  const [chainDirty, setChainDirty] = useState(false);

  const [tab, setTab] = useState<TabKey>('overview');
  const [taxonomyOpen, setTaxonomyOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  /**
   * 见过的 source_type 累积下来。
   *
   * 契约没把它定成枚举（"local_method / mcp / openapi / ..." 那个省略号是认真的），
   * 所以只能从数据反推；但筛选后如果某个类型恰好不在结果里，
   * 下拉选项会凭空少一项 —— 累积着，不清空。
   */
  const [knownTypes, setKnownTypes] = useState<string[]>([]);

  const loadClassifications = useCallback(async () => {
    try {
      const next = (await listCapabilities()) ?? [];
      setClassifications(next);
    } catch {
      // 页内已经准备了「暂无分类」的空态，这里不必出声
      setClassifications([]);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    try {
      const res = await listMcpProviders();
      setProviders(res?.items ?? []);
    } catch (e: unknown) {
      // 页内不额外报警：下拉本来就退化成"配置里没有 MCP provider"，
      // 再叠一条告警会跟列表那条 404 重复喊同一件事。
      setProviders([]);
      setProvidersError((e as Error)?.message ?? '加载 MCP provider 失败');
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  const loadTools = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listTools({
        keyword: filters.keyword || undefined,
        source_type: filters.source_type || undefined,
        source_ref: filters.source_ref || undefined,
        source_state: (filters.source_state || undefined) as never,
        classification_code: filters.classification_code || undefined,
        page: 1,
        page_size: PAGE_SIZE,
      });
      const list = res?.items ?? [];
      setItems(list);
      setTotal(res?.total ?? list.length);
      setKnownTypes((prev) => {
        const merged = new Set(prev);
        list.forEach((t) => {
          merged.add(t.source_type);
        });
        return [...merged];
      });
      // 切换筛选后当前选中项可能已经不在结果里 —— 不自动改选，
      // 详情还在就让它继续显示（用户可能正看着），列表只是少了高亮。
    } catch (e: unknown) {
      setItems([]);
      setTotal(0);
      setLoadError((e as Error)?.message ?? '加载 Tool 列表失败');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadClassifications();
  }, [loadClassifications]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  /** 选中一条 → 拉详情 → 开两份草稿。草稿跟着**详情**初始化，不是跟着面板默认值。 */
  const selectTool = useCallback(async (id: string) => {
    setSelectedId(id);
    setTab('overview');
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await getTool(id);
      setDetail(res ?? null);
      if (res) {
        setDocDraft(openDocDraft(res.manifest, res.documentation));
        setClassDraft((res.classifications ?? []).map((c) => c.id));
      } else {
        setDocDraft(null);
        setClassDraft([]);
      }
    } catch (e: unknown) {
      setDetail(null);
      setDocDraft(null);
      setClassDraft([]);
      setDetailError((e as Error)?.message ?? '加载 Tool 详情失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const reloadDetail = useCallback(async () => {
    if (!selectedId) return;
    try {
      const res = await getTool(selectedId);
      if (res) {
        setDetail(res);
        setDocDraft(openDocDraft(res.manifest, res.documentation));
        setClassDraft((res.classifications ?? []).map((c) => c.id));
      }
    } catch {
      /* 保存成功后 reload 失败不影响刚才那次写，静默即可 */
    }
  }, [selectedId]);

  const onSaveDoc = async () => {
    if (!selectedId || !docDraft) return;
    setSaving('doc');
    try {
      await replaceToolDocumentation(selectedId, buildDocPutBody(docDraft));
      message.success('文档覆盖已保存（全量替换）');
      await reloadDetail();
      await loadTools();
    } catch (e: unknown) {
      message.error((e as Error)?.message ?? '保存失败');
    } finally {
      setSaving(null);
    }
  };

  const onSaveClass = async () => {
    if (!selectedId) return;
    setSaving('class');
    try {
      const next = await replaceToolClassifications(selectedId, {
        classification_ids: classDraft,
      });
      setDetail((prev) =>
        prev ? { ...prev, classifications: next ?? [] } : prev,
      );
      setClassDraft((next ?? []).map((c) => c.id));
      message.success('分类绑定已保存（全量替换）');
      await loadTools();
    } catch (e: unknown) {
      message.error((e as Error)?.message ?? '保存失败');
    } finally {
      setSaving(null);
    }
  };

  /**
   * 运行时上下线（PATCH /tools/{tool_id}/enabled）。
   *
   * 契约里这条开关的三个要点，决定了这里的交互写法：
   *   1. 它不在 manifest 里，也不被 sync 覆盖 —— 后端存在
   *      tool_definition_state（有行 = 显式禁用，无行 = 启用），所以重同步
   *      不会把下线的工具"复活"。这与 source_state=MISSING（代码侧没了）
   *      是两件事，界面上必须分开表达。
   *   2. 只对**下一轮**工具解析生效，正在跑的一轮不受影响 —— 提示语不能写成
   *      "已下线"，得说清"下一轮起"。
   *   3. 下线等于摘掉 LLM 可见性，是可逆但有实际影响的操作 → 先确认再发。
   *      恢复是纯增益，不拦。
   */
  const onToggleEnabled = async (next: boolean) => {
    if (!selectedId) return;
    if (!next) {
      const ok = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: `下线「${detail?.manifest.name ?? selectedId}」？`,
          content:
            '下一轮工具解析起不再下发给 LLM，本轮执行不受影响。开关存在 tool_definition_state 里，重新同步代码不会自动恢复，需要在这里手动打开。',
          okText: '下线',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return;
    }
    setTogglingEnabled(true);
    try {
      const res = await setToolEnabled(selectedId, next);
      // 以服务端回写的状态为准：并发下别人可能已经改过。
      const enabled = typeof res?.enabled === 'boolean' ? res.enabled : next;
      setDetail((prev) => (prev ? { ...prev, enabled } : prev));
      message.success(
        enabled
          ? '已恢复：下一轮起重新下发给 LLM'
          : '已下线：下一轮起不再下发给 LLM',
      );
      await loadTools();
    } catch (e: unknown) {
      message.error((e as Error)?.message ?? '操作失败');
    } finally {
      setTogglingEnabled(false);
    }
  };

  const docDirty = useMemo(
    () => Boolean(docDraft && isDocDirty(docDraft, detail?.documentation)),
    [docDraft, detail?.documentation],
  );
  const classDirty = useMemo(() => {
    const saved = (detail?.classifications ?? []).map((c) => c.id);
    const a = [...classDraft].sort().join();
    const b = [...saved].sort().join();
    return a !== b;
  }, [classDraft, detail?.classifications]);

  const missingCount = useMemo(
    () => items.filter((t) => t.source_state === 'MISSING').length,
    [items],
  );

  /**
   * 当前被运行时下线的数量。
   *
   * 和 missingCount 一样只统计**已取回的这批**（列表一次取满 100，不翻页），
   * 不是全库真值 —— 所以标签只说"N 个"，不写"共 N 个"。
   */
  const disabledCount = useMemo(
    () => items.filter((t) => !isToolEnabled(t)).length,
    [items],
  );

  const tabItems = useMemo(() => {
    if (!detail) return [];
    return [
      {
        key: 'overview' as TabKey,
        label: '概览 · Manifest',
        children: (
          <ManifestPanel manifest={detail.manifest} enabled={detail.enabled} />
        ),
      },
      {
        key: 'doc' as TabKey,
        label: docDirty ? '文档覆盖 ●' : '文档覆盖',
        children: docDraft ? (
          <DocEditor
            manifest={detail.manifest}
            documentation={detail.documentation}
            draft={docDraft}
            dirty={docDirty}
            saving={saving === 'doc'}
            onDraftChange={setDocDraft}
            onSave={onSaveDoc}
            onReset={() =>
              setDocDraft(openDocDraft(detail.manifest, detail.documentation))
            }
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="草稿未初始化"
          />
        ),
      },
      {
        key: 'schema' as TabKey,
        label: 'Schema',
        children: (
          <SchemaPanel
            manifest={detail.manifest}
            documentation={detail.documentation}
          />
        ),
      },
      {
        key: 'class' as TabKey,
        label: classDirty ? '业务分类 ●' : '业务分类',
        children: (
          <ClassEditor
            classifications={classifications}
            saved={detail.classifications ?? []}
            draft={classDraft}
            dirty={classDirty}
            saving={saving === 'class'}
            onDraftChange={setClassDraft}
            onSave={onSaveClass}
            onReset={() =>
              setClassDraft((detail.classifications ?? []).map((c) => c.id))
            }
          />
        ),
      },
      {
        key: 'chain' as TabKey,
        label: chainDirty ? '处理链 ●' : '处理链',
        children: (
          <ProcessorChainPanel
            toolId={detail.manifest.id}
            onDirtyChange={setChainDirty}
          />
        ),
      },
    ];
  }, [
    detail,
    docDraft,
    docDirty,
    classDraft,
    classDirty,
    chainDirty,
    classifications,
    saving,
    onSaveDoc,
    onSaveClass,
  ]);

  return (
    <PageContainer
      title="工具定义"
      content="Tool 定义由代码注册产生，manifest 只读 —— 可写的是文档覆盖、业务分类，以及运行时上下线（enabled，不影响代码侧事实）。"
      extra={[
        <Button
          key="taxonomy"
          icon={<NodeIndexOutlined />}
          onClick={() => setTaxonomyOpen(true)}
        >
          分类体系
        </Button>,
        <Button
          key="sync"
          type="primary"
          icon={<SyncOutlined />}
          onClick={() => setSyncOpen(true)}
        >
          同步发现
        </Button>,
      ]}
    >
      {loadError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title="Tool 列表加载失败"
          description={
            <>
              {loadError}
              <div className={styles.hint}>先确认后端已启动、令牌未过期</div>
            </>
          }
          action={
            <Button size="small" onClick={loadTools}>
              重试
            </Button>
          }
        />
      ) : null}

      <div className={styles.layout}>
        <div className={styles.column}>
          <Card
            size="small"
            title="工具列表"
            extra={
              <Space size={6}>
                <Tag>Total {total}</Tag>
                {missingCount ? (
                  <Tag color="error" title="source_state = MISSING">
                    {labels.sourceState('MISSING')} {missingCount}
                  </Tag>
                ) : null}
                {disabledCount ? (
                  <Tag
                    color={TOOL_DISABLED_COLOR}
                    title="enabled = false：运行时已下线，下一轮工具解析不再下发给 LLM"
                  >
                    {labels.enabled(false)} {disabledCount}
                  </Tag>
                ) : null}
              </Space>
            }
          >
            <ToolList
              items={items}
              loading={loading}
              total={total}
              selectedId={selectedId}
              onSelect={selectTool}
              sourceTypes={knownTypes}
              providers={providers}
              providersLoading={providersLoading}
              providersError={providersError}
              classifications={classifications}
              filters={filters}
              // ⚠️ 不能直接 {...prev, ...patch}：source_type 与 source_ref
              //   有联动（非 mcp 类型 + provider 恒为空集），规则在 mcpProvider.ts
              onFiltersChange={(patch) =>
                setFilters((prev) => applyFilterPatch(prev, patch))
              }
            />
          </Card>
        </div>

        <div className={styles.column}>
          {detailLoading ? (
            <Card size="small">
              <div style={{ textAlign: 'center', padding: 32 }}>
                <Spin />
              </div>
            </Card>
          ) : detailError ? (
            <Alert
              type="error"
              showIcon
              title="Tool 详情加载失败"
              description={detailError}
            />
          ) : detail ? (
            <Card
              size="small"
              title={
                <Space size={6} wrap>
                  <Typography.Text strong>
                    {detail.manifest.name}
                  </Typography.Text>
                  {/* 状态槽只有一个：MISSING > 已下线 > 生效中（见组件注释） */}
                  <ToolStatusTag
                    sourceState={detail.manifest.source_state}
                    enabled={detail.enabled}
                  />
                  <Tag title={detail.manifest.source_type}>
                    {labels.sourceType(detail.manifest.source_type)}
                  </Tag>
                </Space>
              }
              extra={
                // 「已下线」已由标题里的状态槽表达，这里不再重复一个标签
                <Switch
                  checked={isToolEnabled(detail)}
                  loading={togglingEnabled}
                  onChange={onToggleEnabled}
                  checkedChildren={labels.enabled(true)}
                  unCheckedChildren={labels.enabled(false)}
                  title="运行时开关：关闭后下一轮工具解析不再下发给 LLM"
                />
              }
            >
              <Tabs
                activeKey={tab}
                onChange={(k) => setTab(k as TabKey)}
                items={tabItems}
              />
            </Card>
          ) : (
            <Card size="small">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="从左侧选一个 Tool"
              />
            </Card>
          )}
        </div>
      </div>

      <TaxonomyDrawer
        open={taxonomyOpen}
        onClose={() => setTaxonomyOpen(false)}
        classifications={classifications}
        onReload={setClassifications}
      />

      <SyncModal
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        sourceTypes={knownTypes}
        onSynced={() => {
          loadTools();
          if (selectedId) selectTool(selectedId);
        }}
      />
    </PageContainer>
  );
};

export default ToolPage;
