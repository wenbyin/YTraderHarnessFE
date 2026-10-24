// src/pages/document_type_definition/components/PipelineGraph.tsx
// 两阶段 N:N 可视化编辑器（嵌入 React Flow，对齐 document-pipeline-demo.html 设计）。
//  - Analyzer 泳道（左）：阶段1 [loader → processor]，对应 processors[i]。
//  - Retrieval 泳道（右）：阶段2 [chunker → retriever]，对应 retrievals[j]。
//  - 节点 id 与绑定都用「数组下标」(proc:i / retr:j)，因为新增项尚未落库、没有 uuid。
//  - 中间 modality 图标仅作背景展示；整个面板左对齐（与上方表单一致）。
//  - default 模式：单一 .* Analyzer 自动连接全部 Retrieval（蓝色不可移除连线）。
//  - config 模式：多 Analyzer / 多 Retrieval，可拖拽连线编辑 N:N 绑定。
//
// 布局说明：卡片高度随「折叠/展开」变化，因此坐标用 ResizeObserver 实测高度累加；
// 关键点在于**必须把实测高度写回 node.measured** —— React Flow v12 的规则是：
//   internalNode.measured = { width: userNode.measured?.width, height: userNode.measured?.height }
//   且 NodeWrapper 会在 measured 缺失时把节点设为 visibility:hidden、并重置 handleBounds。
// 若每次渲染都 new 一批不带 measured 的 node，卡片与连线就会直接消失（这正是历史 bug 的根因）。

import {
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  getSmoothStepPath,
  Handle,
  type IsValidConnection,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import '@xyflow/react/dist/style.css';
import {
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { App, Button, Input, Select, Tooltip } from 'antd';
import {
  type ConfigObject,
  parseConfigText,
  reconcile,
} from '@/components/SchemaForm';
import {
  buildCapabilityOptions,
  useProcessorCapabilities,
} from '../capabilities';
import {
  type AnalysisMode,
  type BindingEditorItem,
  CHUNKER_OPTIONS,
  defaultDatasource,
  LOADER_OPTIONS,
  MODALITY_META,
  type ModalityType,
  PROCESSOR_OPTIONS,
  type ProcessorEditorItem,
  RETRIEVAL_DATASOURCE_OPTIONS,
  RETRIEVAL_DS_META,
  RETRIEVER_BY_TYPE,
  type RetrievalEditorItem,
  type RetrievalType,
  type StorageBackend,
  SUFFIX_OPTIONS,
} from '../data';
import CapabilityConfigModal from './CapabilityConfigModal';

// ---------------- 几何布局 ----------------
const CARD_W = 232;
const STAGE_W = 988;
const LANE_W = 360;
const PANEL_PAD_X = 20;
const ANALYZER_LANE_LEFT = PANEL_PAD_X;
const RETRIEVAL_LANE_LEFT = STAGE_W - PANEL_PAD_X - LANE_W;
const LANE_TOP = 40; // 泳道距面板顶部
const LANE_HEAD_H = 34; // 泳道标题高度
const CARD_TOP = LANE_TOP + LANE_HEAD_H + 14; // 卡片起始 y（标题下方）
const CARD_GAP = 26; // 同列卡片纵向间距
const HEADER_H = 30; // 卡片标题栏（写死以免行高抖动）
const TOGGLE_H = 22; // 卡片底部折叠把手
const cardX = (lane: 'analyzer' | 'retrieval') =>
  (lane === 'analyzer' ? ANALYZER_LANE_LEFT : RETRIEVAL_LANE_LEFT) +
  (LANE_W - CARD_W) / 2;

/**
 * 连线拐弯处的圆角半径（2026-10-23 用户：「在连线拐弯处做一个圆角」）。
 *
 * 走 smoothstep（折线：横 → 竖 → 横），拐弯处由 `pathOptions.borderRadius`
 * 倒角：给 0 就是**直角**，给大了才叫"圆角"。
 *
 * 为什么不用默认的 bezier（现在是曲线、本来就没有角）：
 * 折线在"哪一列属于哪一列"这件事上更清楚 —— 两条泳道之间是**横向长段**，
 * 折线能一眼看出"从这张卡的右边出来、平着过去、再进那张卡"，曲线在卡片密集
 * 时会挤成一团互相穿插的弧。
 *
 * 14px 的依据：卡片圆角是 10px，连线圆角比它大一点才不像"线被折断了"，
 * 而再大（>20）横向段会明显变短、拐弯挤到卡片边上。
 */
const EDGE_CORNER_RADIUS = 14;

/** 折线连线的公共画法 —— 两条分支（default 蓝线 / config 绑定线）共用。 */
const smoothStepOptions = { borderRadius: EDGE_CORNER_RADIUS };

/**
 * 首帧尚未实测时的高度估值（折叠态 -> 展开态），实测后立刻被真实值替换。
 * 估值越接近真实值，首次渲染的抖动越小。
 */
const ESTIMATE_H = {
  collapsed: 126,
  analyzerExpanded: 374,
  retrievalExpanded: 530,
};

/**
 * 从节点 id（`proc:<i>` / `retr:<j>`）解析出它在 processors / retrievals 数组中的下标。
 * 下标即绑定的链接键：新增项还没有 uuid，只能用下标建边。
 */
const parseIdx = (
  prefix: 'proc' | 'retr',
  nodeId?: string | null,
): number | null => {
  if (!nodeId?.startsWith(`${prefix}:`)) return null;
  const n = Number(nodeId.slice(prefix.length + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
};

// ---------------- 节点数据 ----------------
interface AnalyzerData {
  nodeId: string;
  isDefault?: boolean;
  modality: ModalityType;
  expanded: boolean;
  item?: ProcessorEditorItem;
  onMeasure?: (id: string, height: number) => void;
  onToggleExpand?: () => void;
  onFileExtensionChange?: (v: string) => void;
  onLoaderNameChange?: (v: string) => void;
  onLoaderConfigChange?: (v: string) => void;
  onProcessorNameChange?: (v: string) => void;
  onProcessorConfigChange?: (v: string) => void;
  onRemove?: () => void;
}
interface RetrievalData {
  nodeId: string;
  item: RetrievalEditorItem;
  expanded: boolean;
  onMeasure?: (id: string, height: number) => void;
  onToggleExpand: () => void;
  onRetrievalTypeChange: (v: RetrievalType) => void;
  onChunkerNameChange: (v: string) => void;
  onChunkerConfigChange: (v: string) => void;
  onRetrieverNameChange: (v: string) => void;
  onRetrieverConfigChange: (v: string) => void;
  onStorageBackendChange: (v: StorageBackend) => void;
  onStorageConfigChange: (v: string) => void;
  onRemove: () => void;
}

// ---------------- 高度实测 Hook ----------------
/** 实测元素高度并回传父级；useLayoutEffect 保证首帧即用真实高度，避免抖动。 */
const useMeasuredHeight = (
  id: string,
  onMeasure?: (id: string, height: number) => void,
) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !onMeasure) return;
    const report = () => {
      const h = el.offsetHeight;
      if (h > 0) onMeasure(id, h);
    };
    report(); // 首帧同步测量
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onMeasure]);
  return ref;
};

// ---------------- 控件小部件 ----------------
const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  warn?: string;
}> = ({ label, children, warn }) => (
  <div style={{ marginBottom: 8 }}>
    <div
      style={{
        fontSize: 12,
        color: '#434343',
        fontWeight: 500,
        lineHeight: '16px',
        marginBottom: 3,
      }}
    >
      {label}
    </div>
    {children}
    {warn && (
      <div style={{ fontSize: 11, color: '#ff4d4f', marginTop: 2 }}>{warn}</div>
    )}
  </div>
);

const selectStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  color: '#262626',
};
const jsonStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'Consolas, monospace',
  fontSize: 12,
  color: '#262626',
  height: 46,
  resize: 'none',
};
/**
 * retrieval_type 下拉：label 后拼接自动归类出的检索器名。
 * retriever 不再单独成字段（与 retrieval_type 强绑定），归类信息直接在这里展示。
 */
const RETRIEVAL_TYPE_OPTIONS = (
  Object.keys(RETRIEVER_BY_TYPE) as RetrievalType[]
).map((t) => ({
  label: `${t}（${RETRIEVER_BY_TYPE[t].label}）`,
  value: t,
}));

/** 字段下方的补充说明（如能力支持哪些后缀）。 */
const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#8c8c8c',
  marginTop: 2,
};
const hintWarnStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#d48806',
  marginTop: 2,
};

// ---------------- 折叠区（高度动画） ----------------
/**
 * 可折叠区域：默认折叠，展开显示全部字段。
 * 动画用「实测内容高度 + max-height 过渡」实现——不写死高度，
 * 内容变化（如 JSON 文本框被撑高）也能自适应。
 */
const CollapseBody: React.FC<{
  expanded: boolean;
  children: React.ReactNode;
}> = ({ expanded, children }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number>(0);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => {
      const nh = el.offsetHeight;
      setH((prev) => (Math.abs(prev - nh) < 1 ? prev : nh));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      style={{
        maxHeight: expanded ? h : 0,
        opacity: expanded ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height .28s ease, opacity .2s ease',
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
};

/** 卡片底部居中的折叠把手：向下箭头，展开后旋转 180°。 */
const ExpandBar: React.FC<{ expanded: boolean; onToggle: () => void }> = ({
  expanded,
  onToggle,
}) => (
  <Tooltip title={expanded ? '收起' : '展开'}>
    <div
      onClick={onToggle}
      style={{
        height: TOGGLE_H,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        borderTop: '1px solid #e8e8e8',
        background: '#f5f5f5',
        borderBottomLeftRadius: 10,
        borderBottomRightRadius: 10,
      }}
    >
      <DownOutlined
        style={{
          fontSize: 12,
          color: '#595959',
          transition: 'transform .25s ease',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        }}
      />
    </div>
  </Tooltip>
);

/** 卡片标题栏（写死高度，避免不同字体行高导致整体布局漂移）。 */
const CardHeader: React.FC<{
  bg: string;
  color: string;
  title: string;
  children?: React.ReactNode;
}> = ({ bg, color, title, children }) => (
  <div
    style={{
      height: HEADER_H,
      boxSizing: 'border-box',
      padding: '0 10px',
      background: bg,
      color,
      fontWeight: 600,
      fontSize: 12,
      lineHeight: 1,
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}
  >
    <span>{title}</span>
    {children}
  </div>
);

// ---------------- Analyzer 节点 ----------------
function AnalyzerNode({ data }: NodeProps) {
  const d = data as unknown as AnalyzerData;
  const meta = MODALITY_META[d.modality] || MODALITY_META.text;
  const ref = useMeasuredHeight(d.nodeId, d.onMeasure);
  const toggle = d.onToggleExpand ?? (() => {});

  // ---- Loader 走能力目录（role=loader）：会话级缓存，多张卡片只发一次请求
  const { message } = App.useApp();
  const caps = useProcessorCapabilities('loader');
  const item = d.item as ProcessorEditorItem | undefined;
  const loaderKey = item?.loader_name ?? '';
  const cap = useMemo(
    () => caps.items.find((c) => c.processor_key === loaderKey) ?? null,
    [caps.items, loaderKey],
  );
  /**
   * 目录可用 → 只展示目录条目，当前值不在目录时不塞兜底选项
   * （避免下拉里永远多一条「目录中未找到」的脏选项）；
   * 目录不可用（接口未就绪 / 失败）→ 回退硬编码候选并保证当前值可见。
   */
  const loaderOptions = useMemo(() => {
    if (caps.items.length) return buildCapabilityOptions(caps.items);
    const fallback = [...LOADER_OPTIONS];
    if (loaderKey && !fallback.some((o) => o.value === loaderKey))
      fallback.unshift({
        label: `${loaderKey}（目录中未找到）`,
        value: loaderKey,
      });
    return fallback;
  }, [caps.items, loaderKey]);
  /** 目录可用但当前 loader_name 不在其中（历史数据 / 新建默认值）：提示换选。 */
  const loaderUnknown = caps.items.length > 0 && loaderKey !== '' && !cap;
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgValue, setCfgValue] = useState<ConfigObject>({});

  // ---- Processor 走能力目录（role=clean）：与 Loader 同一套逻辑
  const procCaps = useProcessorCapabilities('clean');
  const processorKey = item?.processor_name ?? '';
  const procCap = useMemo(
    () => procCaps.items.find((c) => c.processor_key === processorKey) ?? null,
    [procCaps.items, processorKey],
  );
  /** 同上：目录可用就只用目录条目，目录失败或返回空时回退内置候选。 */
  const processorOptions = useMemo(() => {
    if (procCaps.items.length) return buildCapabilityOptions(procCaps.items);
    const fallback = [...PROCESSOR_OPTIONS];
    if (processorKey && !fallback.some((o) => o.value === processorKey))
      fallback.unshift({
        label: `${processorKey}（目录中未找到）`,
        value: processorKey,
      });
    return fallback;
  }, [procCaps.items, processorKey]);
  /** 目录可用但当前 processor_name 不在其中。 */
  const processorUnknown =
    procCaps.items.length > 0 && processorKey !== '' && !procCap;
  /** 目录拉到了但 role=clean 一条都没有（后端还没注册该 role 的实现）。 */
  const procDirEmpty = !procCaps.loading && procCaps.items.length === 0;
  const [procCfgOpen, setProcCfgOpen] = useState(false);
  const [procCfgValue, setProcCfgValue] = useState<ConfigObject>({});

  /** 换 Processor：旧 config 按新 schema 对齐。清空（= 不处理）时保留原 config。 */
  const handleProcessorChange = (v?: string) => {
    d.onProcessorNameChange?.(v ?? '');
    const next = procCaps.items.find((c) => c.processor_key === v);
    if (!next || !item) return;
    const r = reconcile(
      parseConfigText(item.processor_config) ?? {},
      next.config_schema,
    );
    d.onProcessorConfigChange?.(JSON.stringify(r.value, null, 2));
    if (r.dropped.length)
      message.warning(
        `已丢弃 ${r.dropped.length} 个不匹配的字段：${r.dropped.join('、')}`,
      );
  };

  /** 打开 Processor 配置弹窗。 */
  const openProcessorConfig = () => {
    if (!procCap) {
      message.info('能力目录中没有该 Processor，无法生成表单');
      return;
    }
    const parsed = parseConfigText(item?.processor_config);
    if (parsed === null) {
      message.error('Processor Config 不是合法 JSON，请先修正');
      return;
    }
    const r = reconcile(parsed, procCap.config_schema);
    if (r.dropped.length)
      message.warning(
        `已丢弃 ${r.dropped.length} 个不匹配的字段：${r.dropped.join('、')}`,
      );
    setProcCfgValue(r.value);
    setProcCfgOpen(true);
  };

  /** 换 Loader：旧 config 按新 schema 对齐，被丢弃的字段给出提示。 */
  const handleLoaderChange = (v: string) => {
    d.onLoaderNameChange?.(v);
    const next = caps.items.find((c) => c.processor_key === v);
    if (!next || !item) return;
    const r = reconcile(
      parseConfigText(item.loader_config) ?? {},
      next.config_schema,
    );
    d.onLoaderConfigChange?.(JSON.stringify(r.value, null, 2));
    if (r.dropped.length)
      message.warning(
        `已丢弃 ${r.dropped.length} 个不匹配的字段：${r.dropped.join('、')}`,
      );
  };

  /** 打开配置弹窗：当前 JSON 先按 schema 对齐再交给表单。 */
  const openLoaderConfig = () => {
    if (!cap) {
      message.info('能力目录中没有该 Loader，无法生成表单');
      return;
    }
    const parsed = parseConfigText(item?.loader_config);
    if (parsed === null) {
      message.error('Loader Config 不是合法 JSON，请先修正');
      return;
    }
    const r = reconcile(parsed, cap.config_schema);
    if (r.dropped.length)
      message.warning(
        `已丢弃 ${r.dropped.length} 个不匹配的字段：${r.dropped.join('、')}`,
      );
    setCfgValue(r.value);
    setCfgOpen(true);
  };

  if (d.isDefault) {
    return (
      <div
        ref={ref}
        style={{
          width: CARD_W,
          borderRadius: 10,
          border: '1px solid #1677ff',
          background: '#fff',
          boxShadow: '0 2px 10px rgba(22,119,255,.18)',
        }}
      >
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: '#1677ff' }}
        />
        <CardHeader bg="#1677ff" color="#fff" title="Default Analyzer" />
        <div style={{ padding: 10 }}>
          <Field label="后缀名（锁定）">
            <Select
              value=".*"
              disabled
              size="small"
              style={selectStyle}
              options={SUFFIX_OPTIONS}
            />
          </Field>
          <CollapseBody expanded={d.expanded}>
            <div
              style={{
                fontSize: 11,
                color: '#595959',
                lineHeight: 1.6,
                background: '#f0f5ff',
                border: '1px solid #adc6ff',
                borderRadius: 6,
                padding: '6px 8px',
              }}
            >
              后缀 <b>.*</b> 承接当前 modality（{meta.label}）下
              <b>全部文件格式</b>
              ，使用系统默认 loader / processor，不可修改。
            </div>
          </CollapseBody>
        </div>
        <ExpandBar expanded={d.expanded} onToggle={toggle} />
      </div>
    );
  }

  const warn =
    item &&
    item.file_extension !== '.*' &&
    !meta.suffix.includes(item.file_extension)
      ? `后缀不属于 ${meta.label}，上传将被拒绝`
      : undefined;

  return (
    <div
      ref={ref}
      style={{
        width: CARD_W,
        borderRadius: 10,
        border: '1px solid #d9d9d9',
        background: '#fff',
        boxShadow: '0 2px 10px rgba(0,0,0,.08)',
      }}
    >
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: '#1677ff' }}
      />
      <CardHeader bg="#e6f4ff" color="#1677ff" title="Custom Analyzer">
        {d.onRemove && (
          <Tooltip title="删除该前处理">
            <DeleteOutlined
              style={{ cursor: 'pointer', fontSize: 12 }}
              onClick={d.onRemove}
            />
          </Tooltip>
        )}
      </CardHeader>
      <div style={{ padding: 10 }}>
        <Field
          label={warn ? '后缀名（不匹配当前 modality）' : '后缀名'}
          warn={warn}
        >
          <Select
            value={item?.file_extension}
            size="small"
            style={selectStyle}
            options={SUFFIX_OPTIONS}
            onChange={d.onFileExtensionChange}
          />
        </Field>
        <CollapseBody expanded={d.expanded}>
          <Field label="Loader">
            <Select
              value={loaderKey}
              size="small"
              style={selectStyle}
              options={loaderOptions}
              showSearch
              loading={caps.loading}
              onChange={handleLoaderChange}
            />
            {caps.failed && (
              <div style={hintWarnStyle}>
                能力目录不可用，已回退到内置候选值
              </div>
            )}
            {loaderUnknown && (
              <div style={hintWarnStyle}>
                当前 Loader 不在能力目录中，请重新选择
              </div>
            )}
            {cap?.selector?.support_suffix?.length ? (
              <div style={hintStyle}>
                支持后缀：{cap.selector.support_suffix.join(' ')}
              </div>
            ) : null}
          </Field>
          <Field label="Loader Config（JSON · 只读）">
            {/* JSON 设为只读，只允许通过右侧按钮按 config_schema 生成的表单编辑，
                避免手写出 schema 不含的字段被后端拒绝。 */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
              <Input.TextArea
                value={item?.loader_config ?? ''}
                rows={2}
                size="small"
                readOnly
                style={{ ...jsonStyle, flex: 1, minWidth: 0 }}
                placeholder="{}"
              />
              <Tooltip title="按 config_schema 生成表单">
                <Button
                  size="small"
                  icon={<SettingOutlined />}
                  disabled={!cap}
                  onClick={openLoaderConfig}
                />
              </Tooltip>
            </div>
          </Field>
          <Field label="Processor">
            <Select
              value={processorKey || undefined}
              size="small"
              style={selectStyle}
              options={processorOptions}
              placeholder="不处理"
              showSearch
              allowClear
              loading={procCaps.loading}
              onChange={(v?: string) => handleProcessorChange(v)}
            />
            {processorUnknown && (
              <div style={hintWarnStyle}>
                当前 Processor 不在能力目录中，请重新选择
              </div>
            )}
            {procCaps.failed && (
              <div style={hintWarnStyle}>
                能力目录不可用，已回退到内置候选值
              </div>
            )}
            {!procCaps.failed && procDirEmpty && (
              <div style={hintWarnStyle}>
                能力目录暂无 role=clean 的条目，已回退到内置候选值
              </div>
            )}
          </Field>
          <Field label="Processor Config（JSON · 只读）">
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
              <Input.TextArea
                value={item?.processor_config ?? ''}
                rows={2}
                size="small"
                readOnly
                style={{ ...jsonStyle, flex: 1, minWidth: 0 }}
                placeholder="{}"
              />
              <Tooltip title="按 config_schema 生成表单">
                <Button
                  size="small"
                  icon={<SettingOutlined />}
                  disabled={!procCap}
                  onClick={openProcessorConfig}
                />
              </Tooltip>
            </div>
          </Field>
        </CollapseBody>
        {/* 由 config_schema 生成的配置弹窗（portal，不参与卡片高度测量） */}
        <CapabilityConfigModal
          open={cfgOpen}
          capability={cap}
          value={cfgValue}
          onCancel={() => setCfgOpen(false)}
          onSave={(next) => {
            d.onLoaderConfigChange?.(JSON.stringify(next, null, 2));
            setCfgOpen(false);
          }}
        />
        <CapabilityConfigModal
          open={procCfgOpen}
          capability={procCap}
          value={procCfgValue}
          onCancel={() => setProcCfgOpen(false)}
          onSave={(next) => {
            d.onProcessorConfigChange?.(JSON.stringify(next, null, 2));
            setProcCfgOpen(false);
          }}
        />
      </div>
      <ExpandBar expanded={d.expanded} onToggle={toggle} />
    </div>
  );
}

// ---------------- Retrieval 节点 ----------------
function RetrievalNode({ data }: NodeProps) {
  const d = data as unknown as RetrievalData;
  const item = d.item;
  const meta = RETRIEVAL_DS_META[item.retrieval_type] || {
    ds: '—',
    color: '#999',
  };
  const ref = useMeasuredHeight(d.nodeId, d.onMeasure);

  // ---- Chunker 走能力目录（role=chunk）：与 Analyzer 里 Loader / Processor 同一套逻辑
  const { message } = App.useApp();
  const chunkCaps = useProcessorCapabilities('chunk');
  const chunkerKey = item.chunker_name ?? '';
  const chunkCap = useMemo(
    () => chunkCaps.items.find((c) => c.processor_key === chunkerKey) ?? null,
    [chunkCaps.items, chunkerKey],
  );
  /** 目录可用就只用目录条目；目录失败或返回空时回退内置候选。 */
  const chunkerOptions = useMemo(() => {
    if (chunkCaps.items.length) return buildCapabilityOptions(chunkCaps.items);
    const fallback = [...CHUNKER_OPTIONS];
    if (chunkerKey && !fallback.some((o) => o.value === chunkerKey))
      fallback.unshift({
        label: `${chunkerKey}（目录中未找到）`,
        value: chunkerKey,
      });
    return fallback;
  }, [chunkCaps.items, chunkerKey]);
  const chunkerUnknown =
    chunkCaps.items.length > 0 && chunkerKey !== '' && !chunkCap;
  const chunkDirEmpty = !chunkCaps.loading && chunkCaps.items.length === 0;
  const [chunkCfgOpen, setChunkCfgOpen] = useState(false);
  const [chunkCfgValue, setChunkCfgValue] = useState<ConfigObject>({});

  /** 换 Chunker：旧 config 按新 schema 对齐。清空（= 不切分）时保留原 config。 */
  const handleChunkerChange = (v?: string) => {
    d.onChunkerNameChange(v ?? '');
    const next = chunkCaps.items.find((c) => c.processor_key === v);
    if (!next) return;
    const r = reconcile(
      parseConfigText(item.chunker_config) ?? {},
      next.config_schema,
    );
    d.onChunkerConfigChange(JSON.stringify(r.value, null, 2));
    if (r.dropped.length)
      message.warning(
        `已丢弃 ${r.dropped.length} 个不匹配的字段：${r.dropped.join('、')}`,
      );
  };

  /** 打开 Chunker 配置弹窗。 */
  const openChunkerConfig = () => {
    if (!chunkCap) {
      message.info('能力目录中没有该 Chunker，无法生成表单');
      return;
    }
    const parsed = parseConfigText(item.chunker_config);
    if (parsed === null) {
      message.error('Chunker Config 不是合法 JSON，请先修正');
      return;
    }
    const r = reconcile(parsed, chunkCap.config_schema);
    if (r.dropped.length)
      message.warning(
        `已丢弃 ${r.dropped.length} 个不匹配的字段：${r.dropped.join('、')}`,
      );
    setChunkCfgValue(r.value);
    setChunkCfgOpen(true);
  };

  /**
   * 切换 retrieval_type：检索器与数据源都是强绑定，随之自动归类；
   * 类型变了旧 config 语义全变，retriever / storage 的 config 一并重置。
   */
  const handleRetrievalTypeChange = (v: RetrievalType) => {
    d.onRetrievalTypeChange(v);
    d.onRetrieverNameChange(RETRIEVER_BY_TYPE[v].value);
    d.onStorageBackendChange(defaultDatasource(v));
    d.onRetrieverConfigChange('{}');
    d.onStorageConfigChange('{}');
  };

  /**
   * Retrieval Type Config 的配置入口：内容由 retrieval_type 决定（Embedding 模型等），
   * 但对应 schema 接口尚未开放，先只放按钮占位 —— 接口就绪后这里换成
   * `CapabilityConfigModal` + `RETRIEVAL_TYPE_CONFIG_SCHEMA[type]` 即可，UI 不用再动。
   */
  const openRetrievalTypeConfig = () => {
    message.info(
      'Retrieval Type Config 的配置 schema 接口尚未开放，暂不可用表单编辑',
    );
  };

  /** 数据源：由 retrieval_type 自动绑定，这一版恒取第一条。 */
  const datasourceOptions = (
    RETRIEVAL_DATASOURCE_OPTIONS[item.retrieval_type] ?? []
  ).map((o) => ({ label: o.label, value: o.backend }));
  const lockedDatasource = defaultDatasource(item.retrieval_type);

  return (
    <div
      ref={ref}
      style={{
        width: CARD_W,
        borderRadius: 10,
        border: `1px solid ${meta.color}`,
        background: '#fff',
        boxShadow: '0 2px 10px rgba(0,0,0,.08)',
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: meta.color }}
      />
      <CardHeader bg={meta.color} color="#fff" title="Retrieval">
        <Tooltip title="删除该检索">
          <DeleteOutlined
            style={{ cursor: 'pointer', fontSize: 12 }}
            onClick={d.onRemove}
          />
        </Tooltip>
      </CardHeader>
      <div style={{ padding: 10 }}>
        <Field label="Retrieval Type">
          <Select
            value={item.retrieval_type}
            size="small"
            style={selectStyle}
            options={RETRIEVAL_TYPE_OPTIONS}
            onChange={handleRetrievalTypeChange}
          />
        </Field>
        <CollapseBody expanded={d.expanded}>
          {/* 数据源：retrieval_type 自动绑定，这一版恒取第一条、不可修改 */}
          <Field label="数据源（自动绑定）">
            <Select
              value={lockedDatasource || undefined}
              size="small"
              style={selectStyle}
              disabled
              options={datasourceOptions}
            />
          </Field>
          <Field label="Retrieval Type Config（JSON · 只读）">
            {/* Embedding 模型等参数由检索类型决定；对应 API 尚未暴露，先留空占位。 */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
              <Input.TextArea
                value="{}"
                rows={2}
                size="small"
                readOnly
                style={{ ...jsonStyle, flex: 1, minWidth: 0 }}
                placeholder="{}"
              />
              <Tooltip title="按 config_schema 生成表单">
                <Button
                  size="small"
                  icon={<SettingOutlined />}
                  onClick={openRetrievalTypeConfig}
                />
              </Tooltip>
            </div>
          </Field>
          <Field label="Chunker">
            <Select
              value={chunkerKey || undefined}
              size="small"
              style={selectStyle}
              options={chunkerOptions}
              placeholder="不切分"
              showSearch
              allowClear
              loading={chunkCaps.loading}
              onChange={(v?: string) => handleChunkerChange(v)}
            />
            {chunkerUnknown && (
              <div style={hintWarnStyle}>
                当前 Chunker 不在能力目录中，请重新选择
              </div>
            )}
            {chunkCaps.failed && (
              <div style={hintWarnStyle}>
                能力目录不可用，已回退到内置候选值
              </div>
            )}
            {!chunkCaps.failed && chunkDirEmpty && (
              <div style={hintWarnStyle}>
                能力目录暂无 role=chunk 的条目，已回退到内置候选值
              </div>
            )}
          </Field>
          <Field label="Chunker Config（JSON · 只读）">
            {/* 同 Analyzer：JSON 只读，只允许通过 config_schema 生成的表单编辑 */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
              <Input.TextArea
                value={item.chunker_config}
                rows={2}
                size="small"
                readOnly
                style={{ ...jsonStyle, flex: 1, minWidth: 0 }}
                placeholder="{}"
              />
              <Tooltip title="按 config_schema 生成表单">
                <Button
                  size="small"
                  icon={<SettingOutlined />}
                  disabled={!chunkCap}
                  onClick={openChunkerConfig}
                />
              </Tooltip>
            </div>
          </Field>
          {/* Retriever 不再单独成字段：与 retrieval_type 强绑定，
              归类结果拼在 retrieval_type 的 label 里展示。 */}
          {/* Storage Backend / Storage Config 已移除：数据源锁定后两者都由 retrieval_type 推导，
              提交时 storage_backend = 推导值、storage_config = {} */}
        </CollapseBody>
        {/* 由 config_schema 生成的配置弹窗（portal，不参与卡片高度测量） */}
        <CapabilityConfigModal
          open={chunkCfgOpen}
          capability={chunkCap}
          value={chunkCfgValue}
          onCancel={() => setChunkCfgOpen(false)}
          onSave={(next) => {
            d.onChunkerConfigChange(JSON.stringify(next, null, 2));
            setChunkCfgOpen(false);
          }}
        />
      </div>
      <ExpandBar expanded={d.expanded} onToggle={d.onToggleExpand} />
    </div>
  );
}

const nodeTypes = { analyzer: AnalyzerNode, retrieval: RetrievalNode };

/**
 * 拖拽中的那条连线。
 *
 * ⚠️ 必须自己画：库自带的 ConnectionLine 对 SmoothStep **写死 borderRadius=5**
 *   （见 @xyflow/react 的 ConnectionLine 实现），不给参数。用它的话就是
 *   "拖着的时候是小尖角、松手落地变成 14px 圆角" —— 同一条线两种画法。
 *   这里用同一个 `getSmoothStepPath` + 同一个半径，全程一致。
 */
const PipelineConnectionLine: React.FC<ConnectionLineComponentProps> = ({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
}) => {
  const [path] = getSmoothStepPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
    borderRadius: EDGE_CORNER_RADIUS,
  });

  return (
    <path
      d={path}
      fill="none"
      stroke="#1677ff"
      strokeWidth={1.6}
      className="react-flow__connection-path"
    />
  );
};

// ---------------- 主组件 ----------------
export interface PipelineGraphProps {
  mode: AnalysisMode;
  modality: ModalityType;
  processors: ProcessorEditorItem[];
  retrievals: RetrievalEditorItem[];
  bindings: BindingEditorItem[];
  onAddProcessor: () => void;
  onAddRetrieval: () => void;
  /** 全部以「数组下标」定位：新增项还没 uuid，只能按下标标识。 */
  onUpdateProcessor: (
    processorIndex: number,
    patch: Partial<ProcessorEditorItem>,
  ) => void;
  onRemoveProcessor: (processorIndex: number) => void;
  onUpdateRetrieval: (
    retrievalIndex: number,
    patch: Partial<RetrievalEditorItem>,
  ) => void;
  onRemoveRetrieval: (retrievalIndex: number) => void;
  onBindingsChange: (bindings: BindingEditorItem[]) => void;
}

type LaneItem = { id: string; kind: 'analyzer' | 'retrieval' };

const PipelineGraph: React.FC<PipelineGraphProps> = (props) => {
  const {
    mode,
    modality,
    processors,
    retrievals,
    bindings,
    onAddProcessor,
    onAddRetrieval,
    onUpdateProcessor,
    onRemoveProcessor,
    onUpdateRetrieval,
    onRemoveRetrieval,
    onBindingsChange,
  } = props;

  // 实测的各卡片高度（id → px）
  const [heights, setHeights] = useState<Record<string, number>>({});
  // 卡片折叠状态放在父级而非节点内部：
  //  节点组件任何原因重挂载都不会丢失 UI 状态，且布局可直接参与计算。
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});

  const onMeasure = useCallback((id: string, height: number) => {
    setHeights((prev) => {
      const cur = prev[id];
      if (cur !== undefined && Math.abs(cur - height) < 1) return prev;
      return { ...prev, [id]: height };
    });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedMap((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // 节点 id 用数组下标（proc:<i> / retr:<j>），不用 uuid —— 新增项还没有 uuid。
  const analyzerItems = useMemo<LaneItem[]>(
    () =>
      mode === 'default'
        ? [{ id: 'analyzer-default', kind: 'analyzer' }]
        : processors.map((_, i) => ({
            id: `proc:${i}`,
            kind: 'analyzer' as const,
          })),
    [mode, processors],
  );
  const retrievalItems = useMemo<LaneItem[]>(
    () =>
      retrievals.map((_, j) => ({
        id: `retr:${j}`,
        kind: 'retrieval' as const,
      })),
    [retrievals],
  );

  // 清理已删除卡片的残余高度，避免同一 id 复用时沿用旧值导致错位。
  const liveIdsKey = useMemo(
    () => [...analyzerItems, ...retrievalItems].map((i) => i.id).join(','),
    [analyzerItems, retrievalItems],
  );
  useEffect(() => {
    const alive = new Set(liveIdsKey ? liveIdsKey.split(',') : []);
    setHeights((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (alive.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [liveIdsKey]);

  /** 卡片高度：优先实测值，未实测时按折叠/展开状态取估值。 */
  const heightOf = useCallback(
    (it: LaneItem): number => {
      const measured = heights[it.id];
      if (measured !== undefined) return measured;
      const opened = !!expandedMap[it.id];
      if (!opened) return ESTIMATE_H.collapsed;
      return it.kind === 'analyzer'
        ? ESTIMATE_H.analyzerExpanded
        : ESTIMATE_H.retrievalExpanded;
    },
    [heights, expandedMap],
  );

  // 按高度累加 y 坐标；两列都从 CARD_TOP 起排，保证顶部对齐。
  const { analyzerPos, retrievalPos, contentBottom } = useMemo(() => {
    const stack = (list: LaneItem[]) => {
      const pos: Record<string, number> = {};
      let y = CARD_TOP;
      for (const it of list) {
        pos[it.id] = y;
        y += heightOf(it) + CARD_GAP;
      }
      return { pos, bottom: list.length ? y - CARD_GAP : CARD_TOP };
    };
    const a = stack(analyzerItems);
    const r = stack(retrievalItems);
    return {
      analyzerPos: a.pos,
      retrievalPos: r.pos,
      contentBottom: Math.max(a.bottom, r.bottom),
    };
  }, [analyzerItems, retrievalItems, heightOf]);

  const nodes = useMemo<Node[]>(() => {
    const retrievalNodes: Node[] = retrievals.map((r, j) => {
      const id = `retr:${j}`;
      const h = heightOf({ id, kind: 'retrieval' });
      return {
        id,
        type: 'retrieval',
        draggable: false,
        position: { x: cardX('retrieval'), y: retrievalPos[id] ?? CARD_TOP },
        // node.measured 必须显式给出，否则 React Flow 会判定节点无尺寸而隐藏它
        measured: { width: CARD_W, height: h },
        data: {
          nodeId: id,
          item: r,
          expanded: !!expandedMap[id],
          onMeasure,
          onToggleExpand: () => toggleExpand(id),
          onRetrievalTypeChange: (v: RetrievalType) =>
            onUpdateRetrieval(j, { retrieval_type: v }),
          onChunkerNameChange: (v: string) =>
            onUpdateRetrieval(j, { chunker_name: v }),
          onChunkerConfigChange: (v: string) =>
            onUpdateRetrieval(j, { chunker_config: v }),
          onRetrieverNameChange: (v: string) =>
            onUpdateRetrieval(j, { retriever_name: v }),
          onRetrieverConfigChange: (v: string) =>
            onUpdateRetrieval(j, { retriever_config: v }),
          onStorageBackendChange: (v: StorageBackend) =>
            onUpdateRetrieval(j, { storage_backend: v }),
          onStorageConfigChange: (v: string) =>
            onUpdateRetrieval(j, { storage_config: v }),
          onRemove: () => onRemoveRetrieval(j),
        },
      };
    });

    if (mode === 'default') {
      const id = 'analyzer-default';
      return [
        {
          id,
          type: 'analyzer',
          draggable: false,
          position: { x: cardX('analyzer'), y: analyzerPos[id] ?? CARD_TOP },
          measured: {
            width: CARD_W,
            height: heightOf({ id, kind: 'analyzer' }),
          },
          data: {
            nodeId: id,
            isDefault: true,
            modality,
            expanded: !!expandedMap[id],
            onMeasure,
            onToggleExpand: () => toggleExpand(id),
          },
        } as Node,
        ...retrievalNodes,
      ];
    }

    const analyzerNodes: Node[] = processors.map((p, i) => {
      const id = `proc:${i}`;
      return {
        id,
        type: 'analyzer',
        draggable: false,
        position: { x: cardX('analyzer'), y: analyzerPos[id] ?? CARD_TOP },
        measured: {
          width: CARD_W,
          height: heightOf({ id, kind: 'analyzer' }),
        },
        data: {
          nodeId: id,
          modality,
          item: p,
          expanded: !!expandedMap[id],
          onMeasure,
          onToggleExpand: () => toggleExpand(id),
          onFileExtensionChange: (v: string) =>
            onUpdateProcessor(i, { file_extension: v }),
          onLoaderNameChange: (v: string) =>
            onUpdateProcessor(i, { loader_name: v }),
          onLoaderConfigChange: (v: string) =>
            onUpdateProcessor(i, { loader_config: v }),
          onProcessorNameChange: (v: string) =>
            onUpdateProcessor(i, { processor_name: v }),
          onProcessorConfigChange: (v: string) =>
            onUpdateProcessor(i, { processor_config: v }),
          onRemove: () => onRemoveProcessor(i),
        },
      };
    });
    return [...analyzerNodes, ...retrievalNodes];
  }, [
    mode,
    modality,
    processors,
    retrievals,
    analyzerPos,
    retrievalPos,
    expandedMap,
    heightOf,
    onMeasure,
    toggleExpand,
    onUpdateProcessor,
    onRemoveProcessor,
    onUpdateRetrieval,
    onRemoveRetrieval,
  ]);

  const edges = useMemo<Edge[]>(() => {
    if (mode === 'default') {
      return retrievals.map((_, j) => ({
        id: `auto:retr:${j}`,
        source: 'analyzer-default',
        target: `retr:${j}`,
        type: 'smoothstep',
        pathOptions: smoothStepOptions,
        deletable: false,
        selectable: false,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#1677ff', strokeWidth: 1.6 },
      }));
    }
    return bindings.map((b) => ({
      id: `bind:${b.processor_index}:${b.retrieval_index}`,
      source: `proc:${b.processor_index}`,
      target: `retr:${b.retrieval_index}`,
      type: 'smoothstep',
      pathOptions: smoothStepOptions,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#86909c', strokeWidth: 1.6 },
    }));
  }, [mode, retrievals, bindings]);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (mode !== 'config') return;
      const i = parseIdx('proc', conn.source);
      const j = parseIdx('retr', conn.target);
      if (i === null || j === null) return;
      if (
        bindings.some((b) => b.processor_index === i && b.retrieval_index === j)
      )
        return;
      onBindingsChange([
        ...bindings,
        { processor_index: i, retrieval_index: j },
      ]);
    },
    [mode, bindings, onBindingsChange],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (mode !== 'config') return;
      const removes = new Set(
        deleted.map(
          (e) => `${parseIdx('proc', e.source)}::${parseIdx('retr', e.target)}`,
        ),
      );
      onBindingsChange(
        bindings.filter(
          (b) => !removes.has(`${b.processor_index}::${b.retrieval_index}`),
        ),
      );
    },
    [mode, bindings, onBindingsChange],
  );

  const isValidConnection = useCallback<IsValidConnection>((conn) => {
    const s = conn.source ?? '';
    const t = conn.target ?? '';
    return s.startsWith('proc:') && t.startsWith('retr:') && s !== t;
  }, []);

  const laneHeight = Math.max(320, contentBottom - LANE_TOP + 28);
  const panelHeight = LANE_TOP + laneHeight + 16;
  const stageHeight = panelHeight;
  const modalityTop = stageHeight / 2 - 40;
  const meta = MODALITY_META[modality] || MODALITY_META.text;

  if (mode === 'none') return null;

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      {/* 面板左对齐（不加 margin:auto），与上方表单一致。
          在捕获阶段截断 wheel，使 React Flow 的内部监听器收不到该事件，
          从而不调用 preventDefault —— 页面滚动恢复正常（本画布不需要缩放/平移）。 */}
      <div
        onWheelCapture={(e) => e.stopPropagation()}
        style={{ position: 'relative', width: STAGE_W, height: stageHeight }}
      >
        {/* 面板背景 */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: STAGE_W,
            height: panelHeight,
            background: '#fbfcfe',
            border: '1px solid #e5e8eb',
            borderRadius: 12,
          }}
        />
        {/* 泳道背景 */}
        <div
          style={{
            position: 'absolute',
            top: LANE_TOP,
            left: ANALYZER_LANE_LEFT,
            width: LANE_W,
            height: laneHeight,
            background: '#f5f5f5',
            border: '1px solid #d9d9d9',
            borderRadius: 10,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: LANE_TOP,
            left: RETRIEVAL_LANE_LEFT,
            width: LANE_W,
            height: laneHeight,
            background: '#ffffff',
            border: '1px solid #d9d9d9',
            borderRadius: 10,
          }}
        />
        {/* 泳道标题（含添加按钮，z-index 高于 ReactFlow 以便点击） */}
        <div
          style={{
            position: 'absolute',
            top: LANE_TOP,
            left: ANALYZER_LANE_LEFT,
            width: LANE_W,
            height: LANE_HEAD_H,
            padding: '0 10px 0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#595959',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            borderTopLeftRadius: 10,
            borderTopRightRadius: 10,
            zIndex: 10,
          }}
        >
          <span>Analyzer（解析器 · 后缀绑定）</span>
          {mode === 'config' && (
            <Tooltip title="添加解析器">
              <Button
                size="small"
                shape="circle"
                icon={<PlusOutlined />}
                onClick={onAddProcessor}
                style={{
                  background: 'rgba(255,255,255,.2)',
                  border: 0,
                  color: '#fff',
                }}
              />
            </Tooltip>
          )}
        </div>
        <div
          style={{
            position: 'absolute',
            top: LANE_TOP,
            left: RETRIEVAL_LANE_LEFT,
            width: LANE_W,
            height: LANE_HEAD_H,
            padding: '0 10px 0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#d9d9d9',
            color: '#262626',
            fontSize: 12,
            fontWeight: 600,
            borderTopLeftRadius: 10,
            borderTopRightRadius: 10,
            zIndex: 10,
          }}
        >
          <span>Retrieval（检索 · 存储格式）</span>
          <Tooltip title="添加检索">
            <Button
              size="small"
              shape="circle"
              icon={<PlusOutlined />}
              onClick={onAddRetrieval}
              style={{ background: '#fff', border: '1px solid #bfbfbf' }}
            />
          </Tooltip>
        </div>
        {/* 中间 modality 半透明背景（仅图标，不接触泳道，不拦截指针） */}
        <div
          style={{
            position: 'absolute',
            left: STAGE_W / 2 - 40,
            top: modalityTop,
            width: 80,
            height: 80,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 56,
            opacity: 0.22,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {meta.icon}
        </div>
        {/* ReactFlow 画布（置于泳道背景之上、标题之下） */}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          // 拖拽中的预览线也走同一条折线 + 同一个圆角（见 PipelineConnectionLine）
          connectionLineComponent={PipelineConnectionLine}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          isValidConnection={isValidConnection}
          nodesDraggable={false}
          nodesConnectable={mode === 'config'}
          nodesFocusable={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          panOnDrag={false}
          panOnScroll={false}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          proOptions={{ hideAttribution: true }}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            background: 'transparent',
          }}
        />
      </div>
    </div>
  );
};

export default PipelineGraph;
