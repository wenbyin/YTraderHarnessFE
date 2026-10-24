// src/pages/document_type_definition/components/CapabilityConfigModal.tsx
// 能力配置弹窗 —— 只负责「Modal 外壳 + 草稿生命周期」，
// 字段渲染完全交给公共组件 @/components/SchemaForm（与 pages/tool 的处理器配置抽屉共用同一份）。
//
// ⚠️ 从 2026-10-05 起这里**不再自己写字段分支**。要改字段渲染一律改公共组件，
// 否则两条路径会再次分叉 —— 历史上 pages/tool 那份就是因为少写了 array 分支，
// 把 `list[str]` 渲染成了单行输入框（填完提交是字符串，后端 pydantic 直接 422）。

import { Button, Modal, Space, Tag } from 'antd';
import { createStyles } from 'antd-style';
import { useEffect, useRef, useState } from 'react';

import {
  buildDefaults,
  type ConfigObject,
  SchemaForm,
  sanitize,
} from '@/components/SchemaForm';
import type { ProcessorCapabilityEntry } from '../capabilities';

const useStyles = createStyles(({ css, token }) => ({
  emptyCfg: css`
    font-size: 13px;
    color: ${token.colorTextTertiary};
    padding: 24px 0;
    text-align: center;
  `,
  footerRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
  `,
}));

export interface CapabilityConfigModalProps {
  open: boolean;
  /** 当前能力；为空表示目录里没找到（调用方应先拦截）。 */
  capability: ProcessorCapabilityEntry | null;
  /** 初值。打开时快照一份作为草稿，关闭丢弃。 */
  value: ConfigObject;
  onCancel: () => void;
  onSave: (next: ConfigObject) => void;
}

const CapabilityConfigModal: React.FC<CapabilityConfigModalProps> = ({
  open,
  capability,
  value,
  onCancel,
  onSave,
}) => {
  const { styles } = useStyles();
  const [draft, setDraft] = useState<ConfigObject>(value);
  // 打开时同步一次初值即可；不把 value 放进依赖，避免父级重渲染把用户正在编辑的草稿冲掉。
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (open) setDraft(latest.current);
  }, [open]);

  const schema = capability?.config_schema;
  const handleReset = () => setDraft(buildDefaults(schema));
  const handleOk = () => {
    if (!schema) return;
    onSave(sanitize({ ...draft }, schema));
  };

  return (
    <Modal
      open={open}
      width={560}
      title={
        <span>
          配置 · {capability?.processor_key ?? '—'}
          {capability?.role && <Tag color="blue">{capability.role}</Tag>}
        </span>
      }
      okText="保存"
      cancelText="取消"
      destroyOnHidden
      onCancel={onCancel}
      onOk={handleOk}
      // 底部左角放「恢复默认」链接，右侧是取消 / 保存
      footer={(_origin, extra) => {
        const { OkBtn, CancelBtn } = extra;
        return (
          <div className={styles.footerRow}>
            <Button
              type="link"
              size="small"
              style={{ paddingLeft: 0 }}
              onClick={handleReset}
            >
              恢复默认
            </Button>
            <Space>
              <CancelBtn />
              <OkBtn />
            </Space>
          </div>
        );
      }}
    >
      {!schema ? (
        <div className={styles.emptyCfg}>
          能力目录中没有该实现，无法生成表单
        </div>
      ) : (
        <SchemaForm
          root={schema}
          schema={schema}
          value={draft}
          depth={0}
          onChange={setDraft}
        />
      )}
    </Modal>
  );
};

export default CapabilityConfigModal;
