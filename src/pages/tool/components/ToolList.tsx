// src/pages/tool/components/ToolList.tsx
// 左侧：筛选 + 工具列表。
//
// 五个筛选框严格对应 GET /tools 的五个查询参数，**不自己发明第六个** ——
// 契约没给的维度（比如按 has_override 过滤）前端做不出来，放了也只会误导。
//
// provider 那个框是**联动**的（不是独立条件）
// -----------------------------------------
//   `source_ref` 与 `source_type` 在后端是 AND 的两个条件。组合里有两种是
//   恒空集：非 mcp 类型 + provider、以及拼错的 provider 名。前者界面上必须
//   挡掉（类型不是 mcp 就禁掉这个框），后者只能靠下拉选项给全 —— 所以
//   provider 是 `Select` 而不是自由输入。规则实现在 mcpProvider.ts，有单测。
//
// 特别注意 classification_code：后端是**精确匹配一个分类节点**，不含子分类。
// 下拉里展示全路径是给人看的；真要「含子分类」得前端展开 descendant，
// 那是另一个语义，别混在一个控件里。
//
// 列表项渲染成真 <button> 而不是 div + role=button：键盘可达与语义都是白拿的，
// 样式上的那点差异在 style.ts 的 toolItem 里 reset 掉。
//
// 业务标签（列表项底部那几个「智能体运行时 / 智能体HITL」）**必须有色**
// ------------------------------------------------------------------
//   2026-10-21 用户截图：这个标签看不出颜色。根因是它留了 antd Tag 的默认灰 ——
//   底色 colorFillQuaternary (#fafafa) 与列表项底 colorFillTertiary (#f5f5f5)
//   几乎同色，未选中时整个"沉"进卡片里；选中态换成 colorPrimaryBg (#e6f4ff)
//   之后才勉强浮出来，于是"只有选中才看得见"。
//
//   为什么选紫色：这一页的语义色位已经被占满了 ——
//     · 红 / 绿 = source_state（MISSING / ACTIVE）；
//     · 橙 = 停用 / 只读之类"要注意"的状态；
//     · 蓝 = 主色，也是列表项的**选中态**底色（再放蓝标签就又同色了）。
//   紫是唯一空着的语义位，且分类本来就是"另起一维"的信息，值得独占一色。
//
//   不改成"白底 + 描边"的原因：那在灰底与蓝底上确实都能看见，但看起来像可点的
//   按钮（这一列里唯一的按钮是列表项本身），而分类是纯展示信息。

import { Empty, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import React from 'react';
import {
  type Capability,
  classificationMap,
  classPath,
  type MCPProviderSummary,
  SOURCE_STATE_COLOR,
  type ToolSummary,
} from '../data';
import { useEnumLabels } from '../enumLabels';
import {
  mcpFilterDisabled,
  mcpProviderDetail,
  mcpProviderSelectLabel,
} from '../mcpProvider';
import { useStyles } from '../style';

/** 筛选条件。空串 = 该条件不参与过滤。 */
export interface ToolFilters {
  keyword: string;
  source_type: string;
  /** MCP provider 名（GET /tools 的 source_ref）。联动规则见 mcpProvider.ts */
  source_ref: string;
  source_state: string;
  classification_code: string;
}

export const emptyFilters = (): ToolFilters => ({
  keyword: '',
  source_type: '',
  source_ref: '',
  source_state: '',
  classification_code: '',
});

interface ToolListProps {
  items: ToolSummary[];
  loading: boolean;
  total: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 已加载过的数据里出现过的 source_type —— 契约没给枚举，只能从数据反推 */
  sourceTypes: string[];
  /** GET /mcp/providers 的结果。空数组 = 配置里没有 provider（或还没加载完） */
  providers: MCPProviderSummary[];
  providersLoading?: boolean;
  /** provider 清单本身拉失败了 —— 与"配置里没有"是两件事，下拉文案要分开 */
  providersError?: string | null;
  /** 全部分类（含父级）—— 用来把 id 翻成全路径名 */
  classifications: Capability[];
  filters: ToolFilters;
  onFiltersChange: (patch: Partial<ToolFilters>) => void;
}

const ToolList: React.FC<ToolListProps> = ({
  items,
  loading,
  total,
  selectedId,
  onSelect,
  sourceTypes,
  providers,
  providersLoading = false,
  providersError = null,
  classifications,
  filters,
  onFiltersChange,
}) => {
  const { styles } = useStyles();
  const labels = useEnumLabels();
  const map = classificationMap(classifications);

  const providerDisabled = mcpFilterDisabled(filters.source_type);
  /** 选中的 provider 对象 —— 只用于下面那行状态明细，取不到就不显示。 */
  const activeProvider = providers.find((p) => p.name === filters.source_ref);

  return (
    <>
      <Space vertical size={8} style={{ width: '100%' }}>
        <Input.Search
          allowClear
          placeholder="tool_key / name 关键字"
          defaultValue={filters.keyword}
          onSearch={(keyword) => onFiltersChange({ keyword: keyword.trim() })}
        />
        <Select
          allowClear
          placeholder="source_type"
          value={filters.source_type || undefined}
          onChange={(v) => onFiltersChange({ source_type: v ?? '' })}
          style={{ width: '100%' }}
          options={sourceTypes.map((t) => ({ label: t, value: t }))}
        />
        {/*
          MCP provider（GET /tools 的 source_ref）。

          ⚠️ 禁用的判据不是"没配 provider"，而是**类型不是 mcp**：
             那是唯一会产出空集的组合（见 mcpProvider.ts 的 applyFilterPatch）。
             类型不限时**不禁** —— 那时 source_ref 单独就成立。
        */}
        <Select
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          disabled={providerDisabled}
          placeholder={
            providerDisabled
              ? 'MCP provider（先把 source_type 选成 mcp）'
              : 'MCP provider'
          }
          value={filters.source_ref || undefined}
          onChange={(v) => onFiltersChange({ source_ref: v ?? '' })}
          style={{ width: '100%' }}
          notFoundContent={
            providersLoading ? (
              <div style={{ textAlign: 'center', padding: 8 }}>
                <Spin size="small" />
              </div>
            ) : providersError ? (
              // "没拉到"和"配置里没有"必须分开说，否则排障时会去翻 mcp.yaml
              `provider 清单加载失败：${providersError}`
            ) : (
              '配置里没有 MCP provider'
            )
          }
          options={providers.map((p) => ({
            label: mcpProviderSelectLabel(p),
            // 禁用/未连接的 provider 仍然可选：历史行还在库里，
            // 恰恰是"想看它有哪些 MISSING 工具"的时候最需要能选。
            value: p.name,
          }))}
        />
        {activeProvider ? (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12 }}
            title={`source_ref=${activeProvider.name}（transport=${activeProvider.transport}，tools_mode=${activeProvider.tools_mode}）`}
          >
            {mcpProviderDetail(activeProvider)}
          </Typography.Text>
        ) : null}
        <Select
          allowClear
          placeholder="source_state"
          value={filters.source_state || undefined}
          onChange={(v) => onFiltersChange({ source_state: v ?? '' })}
          style={{ width: '100%' }}
          options={[
            { label: 'ACTIVE（代码里还在）', value: 'ACTIVE' },
            { label: 'MISSING（代码里已找不到）', value: 'MISSING' },
          ]}
        />
        <Select
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          placeholder="classification_code（精确匹配，不含子分类）"
          value={filters.classification_code || undefined}
          onChange={(v) => onFiltersChange({ classification_code: v ?? '' })}
          style={{ width: '100%' }}
          options={classifications.map((c) => ({
            label: `${classPath(c.id, map)}（${c.code}）`,
            value: c.code,
          }))}
        />
      </Space>

      <div className={styles.toolList}>
        {loading && !items.length ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : items.length ? (
          items.map((tool) => (
            <button
              type="button"
              key={tool.id}
              className={`${styles.toolItem} ${
                tool.id === selectedId ? styles.toolItemActive : ''
              }`}
              onClick={() => onSelect(tool.id)}
            >
              <div className={styles.toolItemName} data-role="name">
                <span style={{ minWidth: 0 }}>{tool.name}</span>
                <Tag
                  color={SOURCE_STATE_COLOR[tool.source_state]}
                  style={{ marginInlineEnd: 0 }}
                  // 译文给人看，原值挂在 title 上 —— 对接口时得按原值说话
                  title={tool.source_state}
                >
                  {labels.sourceState(tool.source_state)}
                </Tag>
              </div>
              <div className={styles.mono} style={{ color: '#8a9099' }}>
                {tool.tool_key}
              </div>
              <div className={styles.toolItemDesc}>
                {tool.description || '（无生效描述）'}
              </div>
              {tool.classifications?.length ? (
                <Space size={4} wrap style={{ marginTop: 4 }}>
                  {tool.classifications.map((c) => (
                    // 业务标签**必须有色**（purple），理由见文件头「业务标签」那段。
                    <Tag
                      key={c.id}
                      color="purple"
                      style={{ fontSize: 11 }}
                      title={c.code}
                    >
                      {classPath(c.id, map)}
                    </Tag>
                  ))}
                </Space>
              ) : null}
            </button>
          ))
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={total ? '没有匹配的工具' : '后端暂无 Tool 数据'}
          />
        )}
      </div>

      <div className={styles.hint}>
        共 {total} 条。列表用 <span className={styles.mono}>description</span>{' '}
        字段（服务端算好的生效描述）而不是自己去拼 override —— 两处各算一遍，
        迟早在「trim 过没」这种事上给出不同答案。
      </div>
    </>
  );
};

export default ToolList;
