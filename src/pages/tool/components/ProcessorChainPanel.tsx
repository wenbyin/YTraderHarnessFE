// src/pages/tool/components/ProcessorChainPanel.tsx
//
// 处理链编辑容器 —— 左「处理器库」/ 右「洋葱时间轴」，底部校验 + PUT 预览 + 保存。
//
// 四条决定这个容器怎么写的后端事实（详见 processorChain.ts 顶部）：
//
//  1. **保存只走 PUT 全量替换一条路**。POST / PATCH / DELETE 虽然都有，
//     但"顺序 + hook + config"是一起变的，拆成多次写会出现只有一半的中间态。
//
//  2. **PUT 会重建 processor_id**（行是全删重建的）。所以 draft 只用本地 uid，
//     保存后必须**重新 GET** 再解析 —— 这里保存成功就 reload()，不拿旧 id 做任何事。
//
//  3. **AROUND 在库里是两条记录**（进 / 出，各带一份 config），前端是一条实例。
//     parse / serialize 的往返由 processorChain 负责，这里只管"什么时候调"。
//
//  4. 后端放得下、但本页表达不出来的链形（并列的 AROUND 区间）→ parseChain 返回
//     ok:false，整页**降级成只读 + 告警**。宁可不给编辑，也不给一个会转错形状的编辑器。

import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Collapse,
  Empty,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Floater } from '../chainAnim';
import { makeFloater, morphInto } from '../chainAnim';
import {
  type ChainItem,
  defaultBind,
  defaultConfig,
  newUid,
  type ProcessorDefinition,
  parseChain,
  serializeChain,
  type ToolProcessor,
  validateChain,
  validateOnion,
} from '../processorChain';
import {
  listProcessorDefinitions,
  listToolProcessors,
  replaceToolProcessorChain,
} from '../processorService';
import { useStyles } from '../style';
import ChainOrderHint from './ChainOrderHint';
import OnionTimeline from './OnionTimeline';
import ProcessorConfigDrawer, {
  type ProcessorConfigDraft,
} from './ProcessorConfigDrawer';
import ProcessorLibrary from './ProcessorLibrary';

interface ProcessorChainPanelProps {
  toolId: string;
  onDirtyChange?: (dirty: boolean) => void;
}

/** 拷贝一份实例 —— saved 与 draft 必须是两个对象，否则 reset 等于没 reset。 */
const cloneItems = (list: ChainItem[]): ChainItem[] =>
  list.map((i) => ({ ...i, config: { ...(i.config ?? {}) } }));

const ProcessorChainPanel: React.FC<ProcessorChainPanelProps> = ({
  toolId,
  onDirtyChange,
}) => {
  const { styles } = useStyles();
  const { message } = App.useApp();

  const [loading, setLoading] = useState(true);
  const [defs, setDefs] = useState<ProcessorDefinition[]>([]);
  const [items, setItems] = useState<ChainItem[]>([]);
  const [saved, setSaved] = useState<ChainItem[]>([]);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [registryDown, setRegistryDown] = useState(false);

  const [saving, setSaving] = useState(false);
  const [cfgUid, setCfgUid] = useState<string | null>(null);

  /** 左栏 → 右栏的变形飞入：浮层在渲染**前**造好，渲染后才知道飞到哪儿。 */
  const morphRef = useRef<{ floater: Floater; uid: string } | null>(null);

  const defMap = useMemo(() => new Map(defs.map((d) => [d.key, d])), [defs]);
  /** key → 链上实例数。只用来在左栏显示「已挂 ×N」，**不**用来禁挂 —— 同 key 可挂 N 次。 */
  const usedCounts = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((i) => {
      m.set(i.processor_key, (m.get(i.processor_key) ?? 0) + 1);
    });
    return m;
  }, [items]);

  /* ------------------------------------------------------------- 加载 */

  const loadChain = useCallback(async (): Promise<boolean> => {
    try {
      const res = await listToolProcessors(toolId);
      const parsed = parseChain((res?.processors ?? []) as ToolProcessor[]);
      setItems(cloneItems(parsed.items));
      setSaved(cloneItems(parsed.items));
      setUnsupported(parsed.ok ? null : (parsed.reason ?? '无法解析'));
      return true;
    } catch {
      setItems([]);
      setSaved([]);
      setUnsupported(null);
      return false;
    }
  }, [toolId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      const [regRes, chainOk] = await Promise.all([
        listProcessorDefinitions().catch(() => null),
        loadChain(),
      ]);
      if (!alive) return;
      const list = regRes?.items ?? [];
      setDefs(list);
      setRegistryDown(!list.length);
      setLoading(false);
      if (!chainOk && list.length) {
        // 链接口没起来但注册表起来了：多半是 Tool 侧还没实装，页内空态承接
        setUnsupported(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadChain]);

  useLayoutEffect(() => {
    const m = morphRef.current;
    if (!m) return;
    morphRef.current = null;
    const el = document.querySelector<HTMLElement>(
      `[data-chain-uid="${m.uid}"]:not([data-floater])`,
    );
    if (!el) {
      m.floater.el.remove();
      return;
    }
    morphInto(m.floater, el);
  });

  /* --------------------------------------------------------- 派生状态 */

  const readOnly = Boolean(unsupported);

  const dirty = useMemo(
    () =>
      JSON.stringify(serializeChain(items)) !==
      JSON.stringify(serializeChain(saved)),
    [items, saved],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const checks = useMemo(() => validateChain(items, defMap), [items, defMap]);
  const badCount = checks.filter((c) => c.level === 'bad').length;
  const onion = useMemo(() => validateOnion(items), [items]);
  const putBody = useMemo(
    () => JSON.stringify({ items: serializeChain(items) }, null, 2),
    [items],
  );

  /* ------------------------------------------------------------- 动作 */

  const onAdd = (def: ProcessorDefinition, srcEl: HTMLElement | null) => {
    const floater = srcEl ? makeFloater(srcEl, styles.floater) : null;
    const bind = defaultBind(def);
    const item: ChainItem = {
      uid: newUid(),
      processor_key: def.key,
      hook: bind.hook,
      execution_mode: bind.execution_mode,
      config: defaultConfig(def),
      enabled: true,
    };
    setItems((prev) => [...prev, item]);
    if (floater) morphRef.current = { floater, uid: item.uid };
  };

  const onSaveChain = async () => {
    setSaving(true);
    try {
      await replaceToolProcessorChain(toolId, { items: serializeChain(items) });
      message.success('处理链已保存（全量替换，processor_id 已重建）');
      await loadChain(); // 重新 GET —— 拿回重建后的 id 与服务端规范化过的顺序
    } catch (e: unknown) {
      message.error((e as Error)?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const cfgItem = useMemo(
    () => items.find((i) => i.uid === cfgUid) ?? null,
    [items, cfgUid],
  );

  const onSaveCfg = (d: ProcessorConfigDraft) => {
    if (!cfgUid) return;
    setItems((prev) =>
      prev.map((i) =>
        i.uid === cfgUid
          ? {
              ...i,
              hook: d.hook,
              execution_mode: d.hook === 'AROUND' ? 'SYNC' : d.execution_mode,
              enabled: d.enabled,
              config: d.config,
            }
          : i,
      ),
    );
    setCfgUid(null);
  };

  /* ------------------------------------------------------------- 渲染 */

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {unsupported ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title="这条链的形状本页无法编辑，已降级为只读"
          description={
            <>
              {unsupported}
              <div className={styles.hint}>
                本页只支持「所有 AROUND 互相嵌套」的链
              </div>
            </>
          }
        />
      ) : null}

      {registryDown ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="处理器注册表为空"
          description={
            <>
              <span className={styles.mono}>GET /api/v1/processors</span>{' '}
              无返回数据，无法新增处理器
            </>
          }
        />
      ) : null}

      {/*
        「执行顺序 · 外 → 内」放在两栏**之上**：它解释的是「这条链整体怎么执行」，
        不属于左栏也不属于右栏；而且六行阶梯要占满整宽才好读。
        （与下面那段说明同一个理由 —— 放栏内会把两栏正文压得不在同一条基线上。）
      */}
      <ChainOrderHint />

      {/*
        说明提到两栏**之上**而不是各自放在栏内 ——
        栏内的说明行数不一样（左栏一行、右栏五六行），会把两栏正文压得不在同一条基线上，
        看着像"上方留白不一致"。提到上面后两栏都是「标题头 + 正文」，天然对齐。
      */}
      <div className={styles.chainGrid}>
        <div className={styles.docBlock}>
          <div className={`${styles.docBlockHead} ${styles.chainHead}`}>
            <Typography.Text strong>处理器库</Typography.Text>
            <span className={styles.mono}>GET /processors</span>
            <span style={{ flex: 1 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {defs.length} 个
            </Typography.Text>
          </div>
          <ProcessorLibrary
            defs={defs}
            usedCounts={usedCounts}
            disabled={readOnly}
            onAdd={onAdd}
          />
        </div>

        <div className={styles.docBlock}>
          <div className={`${styles.docBlockHead} ${styles.chainHead}`}>
            <Typography.Text strong>处理链 · 洋葱时间轴</Typography.Text>
            <Tag>{items.length} 个</Tag>
            <Tag color={onion.ok ? 'green' : 'red'}>
              {onion.aroundCount
                ? `${onion.aroundCount} 层 AROUND`
                : '无 AROUND'}
            </Tag>
            <span style={{ flex: 1 }} />
          </div>

          {items.length ? (
            <OnionTimeline
              items={items}
              defs={defMap}
              readOnly={readOnly}
              onReorder={setItems}
              onRemove={(uid) =>
                setItems((prev) => prev.filter((i) => i.uid !== uid))
              }
              onConfigure={setCfgUid}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="这个 Tool 还没有挂任何处理器"
            />
          )}
        </div>
      </div>

      <Collapse
        ghost
        style={{ marginTop: 12 }}
        items={[
          {
            key: 'check',
            label: (
              <Space size={8}>
                <Typography.Text strong>
                  硬约束校验 & PUT 请求体
                </Typography.Text>
                <Tag color={badCount ? 'red' : 'green'}>
                  {badCount
                    ? `${badCount} 项不合规`
                    : checks.some((c) => c.level === 'warn')
                      ? '有提示'
                      : '全部通过'}
                </Tag>
              </Space>
            ),
            children: (
              <>
                <div className={styles.checks}>
                  {checks.map((c) => (
                    <div
                      key={c.text}
                      className={[
                        styles.check,
                        c.level === 'bad' ? styles.checkBad : '',
                        c.level === 'warn' ? styles.checkWarn : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span>
                        {c.level === 'ok' ? '✓' : c.level === 'bad' ? '✕' : '!'}
                      </span>
                      <span>{c.text}</span>
                    </div>
                  ))}
                </div>

                <div
                  className={styles.docBlockHead}
                  style={{ margin: '12px 0 6px' }}
                >
                  <span className={styles.mono}>
                    PUT /tools/&#123;tool_id&#125;/processors
                  </span>
                  <Tag color="warning">全量替换</Tag>
                </div>
                <pre className={styles.jsonBlock}>{putBody}</pre>
              </>
            ),
          },
        ]}
      />

      <div className={styles.actionsRow}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {dirty ? '有未保存的修改' : '已与服务端一致'}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Tooltip title="放弃未保存的修改，回到上次保存的样子">
          <Button
            icon={<ReloadOutlined />}
            disabled={!dirty || readOnly}
            onClick={() => setItems(cloneItems(saved))}
          >
            重置
          </Button>
        </Tooltip>
        <Tooltip
          title={
            readOnly
              ? '当前链形无法编辑'
              : badCount
                ? '存在不合规项，保存会被后端拒绝'
                : ''
          }
        >
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty || readOnly || badCount > 0}
            onClick={onSaveChain}
          >
            保存（全量替换）
          </Button>
        </Tooltip>
      </div>

      <ProcessorConfigDrawer
        open={Boolean(cfgItem)}
        item={cfgItem}
        def={cfgItem ? defMap.get(cfgItem.processor_key) : undefined}
        onCancel={() => setCfgUid(null)}
        onSave={onSaveCfg}
      />
    </>
  );
};

export default ProcessorChainPanel;
