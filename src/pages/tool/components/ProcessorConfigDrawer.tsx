// src/pages/tool/components/ProcessorConfigDrawer.tsx
//
// 链上一个处理器实例的绑定配置：hook / execution_mode / enabled / config。
//
// 两条硬约束在 UI 里必须**挡住**而不是"保存时报错"：
//
//  1. **AROUND ⇒ SYNC**。SQL 有 ck_tool_processor_around_sync，服务层还会再拦一次
//     （为了落 409 而不是 500）。所以 hook 切到 AROUND 时 ASYNC 直接不可选，
//     且自动把 execution_mode 掰成 SYNC —— 留着那个选项只会让人配出一个必错的组合。
//
//  2. **hook / execution_mode 必须在注册表的 supported_* 之内**。
//     不支持的选项 disabled 并注明原因，不让用户猜哪个能用。
//
// 还有一条容易踩的：config 里**不能**出现 sequence / hook / execution_mode ——
// 那三个是结构属性（表上的列），config 只放处理器自身的业务参数。
//
// ⚠️ config 区的字段渲染**一律走公共组件 @/components/SchemaForm**（2026-10-05 起）。
// 这里本来有一份自己写的简化版 if 链（enum / boolean / integer / 兜底 Input），
// 少了 array 和 object 两支 —— 于是 `AuthConfig.require_roles: list[str]`
// 被渲染成一个单行输入框，用户填完提交上去是**字符串**，后端 pydantic 直接 422。
// 而且那份还丢了 title 之外的 description、type 标签、$ref 解引用。
// 现在与「文档类型定义 → 能力配置」共用同一份渲染器，两处不会再分叉。

import {
  Alert,
  Button,
  Drawer,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import React, { useEffect, useState } from 'react';
import { buildDefaults, SchemaForm } from '@/components/SchemaForm';
import { useEnumLabels } from '../enumLabels';
import {
  type ChainItem,
  EXECUTION_MODES,
  type ExecutionMode,
  PROCESSOR_HOOKS,
  type ProcessorDefinition,
  type ProcessorHook,
} from '../processorChain';
import { useStyles } from '../style';

export interface ProcessorConfigDraft {
  hook: ProcessorHook;
  execution_mode: ExecutionMode;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface ProcessorConfigDrawerProps {
  open: boolean;
  item: ChainItem | null;
  def?: ProcessorDefinition;
  onCancel: () => void;
  onSave: (draft: ProcessorConfigDraft) => void;
}

const ProcessorConfigDrawer: React.FC<ProcessorConfigDrawerProps> = ({
  open,
  item,
  def,
  onCancel,
  onSave,
}) => {
  const { styles } = useStyles();
  const labels = useEnumLabels();
  const [draft, setDraft] = useState<ProcessorConfigDraft | null>(null);

  /** 每次打开都按当前实例重新起一份草稿 —— 抽屉不销毁，靠这里重置。 */
  useEffect(() => {
    if (!open || !item) return;
    setDraft({
      hook: item.hook,
      execution_mode: item.execution_mode,
      enabled: item.enabled,
      config: { ...(item.config ?? {}) },
    });
  }, [open, item]);

  if (!item || !draft) return null;

  const patch = (p: Partial<ProcessorConfigDraft>) =>
    setDraft((prev) => (prev ? { ...prev, ...p } : prev));

  const onHookChange = (hook: ProcessorHook) => {
    // 切到 AROUND：异步必须让位（AROUND 要包住整次调用，异步包不住）
    patch(hook === 'AROUND' ? { hook, execution_mode: 'SYNC' } : { hook });
  };

  /** config_schema 是 pydantic v2 model_json_schema() 的原生输出，直接喂公共渲染器。 */
  const schema = def?.config_schema;

  return (
    <Drawer
      open={open}
      onClose={onCancel}
      size={440}
      title={
        <Space size={6} wrap>
          <Typography.Text strong>
            {def?.name ?? item.processor_key}
          </Typography.Text>
          <span className={styles.mono}>{item.processor_key}</span>
        </Space>
      }
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onCancel}>取消</Button>
          <Button
            type="primary"
            onClick={() => {
              // 兜底：即便 UI 被绕过（比如注册表里 supported_* 缺失），AROUND 也强制 SYNC
              onSave({
                ...draft,
                execution_mode:
                  draft.hook === 'AROUND' ? 'SYNC' : draft.execution_mode,
              });
            }}
          >
            保存
          </Button>
        </Space>
      }
    >
      {def?.description ? (
        <div className={styles.hint} style={{ marginBottom: 10 }}>
          {def.description}
        </div>
      ) : null}

      {!def ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="注册表中已不存在这个处理器"
          description="保存会被后端以 404 拒绝 —— 建议先从链上摘掉。"
        />
      ) : null}

      <div className={styles.field}>
        <div className={styles.fieldLabel}>挂载位置 hook</div>
        <Select
          value={draft.hook}
          onChange={onHookChange}
          style={{ width: '100%' }}
          options={PROCESSOR_HOOKS.map((h) => {
            const ok = !def || def.supported_hooks.includes(h);
            return {
              value: h,
              label: ok ? labels.hook(h) : `${labels.hook(h)}（不支持）`,
              disabled: !ok,
            };
          })}
        />
        <div className={styles.fieldDesc}>
          {/* 选项里只放译文，原值在说明里补上 —— 对接口时要按原值说话 */}
          {PROCESSOR_HOOKS.map((h) => labels.hookBoth(h)).join(' / ')}
          （进入正序、退出逆序）。
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>执行方式 execution_mode</div>
        <Select
          value={draft.execution_mode}
          onChange={(v) => {
            if (draft.hook === 'AROUND' && v !== 'SYNC') return;
            patch({ execution_mode: v });
          }}
          style={{ width: '100%' }}
          options={EXECUTION_MODES.map((m) => {
            const modeOk = !def || def.supported_execution_modes.includes(m);
            const ok = modeOk && !(draft.hook === 'AROUND' && m === 'ASYNC');
            const note = !modeOk
              ? '（不支持）'
              : draft.hook === 'AROUND' && m === 'ASYNC'
                ? '（AROUND 禁止）'
                : '';
            return {
              value: m,
              label: `${labels.mode(m)}${note}`,
              disabled: !ok,
            };
          })}
        />
        <div className={styles.fieldDesc}>
          {EXECUTION_MODES.map((m) => labels.modeBoth(m)).join(' / ')}
          ：SYNC 阻塞主链路，ASYNC 发出即忘。
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>启用 enabled</div>
        <Switch
          checked={draft.enabled}
          onChange={(v) => patch({ enabled: v })}
          checkedChildren="启用"
          unCheckedChildren="停用"
        />
        <div className={styles.fieldDesc}>
          停用的处理器仍留在链上（顺序保留），只是执行时跳过 —— 时间轴里灰显。
        </div>
      </div>

      <div className={styles.fieldDivider} />

      <div className={styles.field}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
          }}
        >
          <Typography.Text strong>config</Typography.Text>
          <Tag color="warning">只放处理器自身参数</Tag>
          <span style={{ flex: 1 }} />
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={!schema}
            onClick={() => patch({ config: buildDefaults(schema) })}
          >
            恢复默认
          </Button>
        </div>
      </div>

      {schema ? (
        <SchemaForm
          root={schema}
          schema={schema}
          value={draft.config ?? {}}
          depth={0}
          onChange={(next) => patch({ config: next })}
          emptyText="该处理器没有可配置参数。"
        />
      ) : (
        <div className={styles.hint}>该处理器没有可配置参数。</div>
      )}

      <div className={styles.hint} style={{ marginTop: 10 }}>
        config 里<b>不能</b>放 sequence / hook / execution_mode ——
        那三个是结构属性，不是业务配置。
      </div>
    </Drawer>
  );
};

export default ProcessorConfigDrawer;
