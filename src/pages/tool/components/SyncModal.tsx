// src/pages/tool/components/SyncModal.tsx
// POST /tools/discovery/sync
//
// 这一块的重点不是「发一个 POST」，而是把 **remove_missing 的代价说明白**。
//
// 契约原文写着 Recommended to keep false，因为：
//   - 勾 false（默认）：代码里找不到的 Tool 标记为 MISSING，**记录保留**，
//     人工写的文档覆盖也还在 —— 代码改回来它自动复活。
//   - 勾 true：物理删除缺失的定义。Tool 没了，tool_documentation 也级联没了
//     （models.sql 里是 ON DELETE CASCADE）。下次代码加回来就是一条全新记录，
//     之前人工写的描述全部丢失。
//
// 这是个**不可逆**的操作，界面必须把它讲清楚，而不是给个开关了事。
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';
import type { ToolSyncRequest, ToolSyncResult } from '../data';
import { syncTools } from '../service';
import { useStyles } from '../style';

interface SyncModalProps {
  open: boolean;
  onClose: () => void;
  /** 现有数据里出现过的 source_type，供勾选 */
  sourceTypes: string[];
  onSynced: () => void;
}

const SyncModal: React.FC<SyncModalProps> = ({
  open,
  onClose,
  sourceTypes,
  onSynced,
}) => {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [types, setTypes] = useState<string[]>([]);
  const [refsText, setRefsText] = useState('');
  const [removeMissing, setRemoveMissing] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ToolSyncResult | null>(null);

  const body = useMemo<ToolSyncRequest>(() => {
    const next: ToolSyncRequest = {};
    if (types.length) next.source_types = types;
    const refs = refsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (refs.length) next.source_refs = refs;
    // undefined = 用服务端默认 false。只有显式勾上才写进请求体
    if (removeMissing) next.remove_missing = true;
    return next;
  }, [types, refsText, removeMissing]);

  const run = async () => {
    setRunning(true);
    try {
      const res = await syncTools(body);
      setResult(res ?? null);
      message.success('同步完成');
      onSynced();
    } catch (e: unknown) {
      message.error((e as Error)?.message ?? '同步失败');
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setTypes([]);
    setRefsText('');
    setRemoveMissing(false);
    setResult(null);
  };

  const entries = result
    ? (Object.entries(result) as [keyof ToolSyncResult, number][])
    : [];

  return (
    <Modal
      open={open}
      title="同步发现 · POST /tools/discovery/sync"
      width={620}
      onCancel={() => {
        onClose();
        reset();
      }}
      footer={[
        <Button
          key="cancel"
          onClick={() => {
            onClose();
            reset();
          }}
        >
          关闭
        </Button>,
        <Button key="run" type="primary" loading={running} onClick={run}>
          执行同步
        </Button>,
      ]}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="按 manifest_hash 比对，幂等"
        // 最后一句是 tool.yaml 明说的：enabled 存在 tool_definition_state，
        // 同步既不写也不清它 —— 不说清的话，"同步过了怎么还是下线"必然会被问。
        description="unchanged / updated / MISSING（默认不删除）。同步不改运行时开关：已下线的工具同步后仍是下线，需在详情页手动恢复。"
      />

      <Typography.Text strong>source_types</Typography.Text>
      <div className={styles.hint} style={{ marginBottom: 6 }}>
        留空 = 全部可发现来源
      </div>
      <Checkbox.Group
        options={sourceTypes.map((t) => ({ label: t, value: t }))}
        value={types}
        onChange={(v) => setTypes(v.map(String))}
      />

      <div style={{ marginTop: 12 }}>
        <Typography.Text strong>source_refs</Typography.Text>
        <div className={styles.hint} style={{ marginBottom: 6 }}>
          逗号分隔，留空 = 全部
        </div>
        <Input
          value={refsText}
          onChange={(e) => setRefsText(e.target.value)}
          placeholder="app.services.market.quote, mcp://news"
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <Space align="start">
          <Switch checked={removeMissing} onChange={setRemoveMissing} />
          <div>
            <Typography.Text>remove_missing</Typography.Text>
            <div className={styles.hint}>
              契约原文：<i>Recommended to keep false.</i>
              <br />
              勾上后代码里找不到的 Tool 会被<b>真的删掉</b>
              ，连同它的人工文档覆盖一起 （models.sql 里是{' '}
              <span className={styles.mono}>ON DELETE CASCADE</span>）
              。下次代码加回来就是一条全新记录。
            </div>
          </div>
        </Space>
      </div>

      {removeMissing ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          title="这是不可逆操作"
          description="缺失定义与其文档覆盖会被物理删除"
        />
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Typography.Text strong>请求体预览</Typography.Text>
        <pre className={styles.jsonBlock} style={{ marginTop: 6 }}>
          {JSON.stringify(body, null, 2)}
        </pre>
      </div>

      {result ? (
        <div className={styles.docBlock} style={{ marginTop: 12 }}>
          <div className={styles.docBlockHead}>
            <Typography.Text strong>ToolSyncResult</Typography.Text>
          </div>
          <Space size={6} wrap>
            {entries.map(([key, value]) => (
              <Tag
                key={key}
                color={
                  key === 'missing' && value
                    ? 'red'
                    : key === 'updated' && value
                      ? 'orange'
                      : 'default'
                }
              >
                {`${key} · ${value}`}
              </Tag>
            ))}
          </Space>
          <div className={styles.hint} style={{ marginTop: 8 }}>
            {result.missing ? (
              <>
                <b>missing {result.missing}</b>：这些 Tool 代码里找不到了，
                {removeMissing
                  ? '已按 remove_missing=true 物理删除（人工写的文档覆盖一起没了）。'
                  : '但记录保留（remove_missing=false），人工写的覆盖也还在。'}
                <br />
              </>
            ) : null}
            {result.orphaned_documentations ? (
              <>
                <b>orphaned_documentations {result.orphaned_documentations}</b>
                ：指向已不存在参数的覆盖。代码删了参数之后，这些描述对 LLM
                已经失去意义 —— 进对应 Tool 的「文档覆盖」把它们清掉。
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
};

export default SyncModal;
