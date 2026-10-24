// src/pages/document/components/NodeDetailDrawer.tsx
// 节点执行详情抽屉：概览 → 执行明细（Tab 逐路切换）→ input/output/metrics 三段 JSON。
//
// 结构刻意与 demo 保持一致：
//  - **概览常驻**，不进 Tab（node_id / group / sequence / attempt / 耗时 / 起止 / 说明 / 执行单元汇总 / 错误 / 原始节点行）；
//  - **Tab 属于「执行明细」**，放在明细标题正下方而不是抽屉顶部，切 Tab 只影响明细区；
//  - Tab 内容固定三段 JSON，接口没返回就显示空态，绝不编造数据；
//  - input_summary / output_summary 里出现「*_ref 且带 file_id」时，该段右上角给
//    当前版本文件的下载按钮。
import { DownloadOutlined } from '@ant-design/icons';
import {
  Button,
  Drawer,
  Empty,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';

import { downloadFile } from '../../file/service';
import { useFileInfo } from '../fileInfo';
import type { NodeRunStatus, TimelineNode } from '../pipeline';
import { NODE_STATUS_TEXT } from '../pipeline';
import { useStyles } from '../style';

const NODE_TAG_COLOR: Record<NodeRunStatus, string> = {
  completed: 'green',
  running: 'blue',
  pending: 'default',
  failed: 'red',
  skipped: 'default',
};

interface FileRefHit {
  /** 命中的字段路径，如 output_summary.source_ref。 */
  path: string;
  /** 从该 ref 里取到的 file_id；取不到时为 null。 */
  fileId: string | null;
}

/** 命中文件引用的 key：ref 本身，以及任何以 _ref 结尾的 key。 */
const isRefKey = (key: string) => key === 'ref' || key.endsWith('_ref');

/**
 * 在一段 JSON 里找「key 叫 ref 或以 _ref 结尾」的字段，并尝试从中取出 file_id。
 * file_id 的两种形态：
 *   { "ref": { "file_id": "..." } } / { "source_ref": { "file_id": "..." } }  —— 对象里带 file_id 键
 *   { "ref": "file_id=abc123" }                                              —— 字符串里含 file_id
 * 递归下钻，嵌套多层的 ref 也能命中。取不到 file_id 时 fileId 为 null（此时不给下载按钮）。
 */
function collectFileRefs(value: unknown, path = ''): FileRefHit[] {
  if (value == null || typeof value !== 'object') return [];

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectFileRefs(item, `${path}[${index}]`),
    );
  }

  const record = value as Record<string, unknown>;
  const hits: FileRefHit[] = [];
  for (const key of Object.keys(record)) {
    const child = record[key];
    const childPath = path ? `${path}.${key}` : key;
    if (isRefKey(key)) {
      hits.push({ path: childPath, fileId: extractFileId(child) });
    }
    hits.push(...collectFileRefs(child, childPath));
  }
  return hits;
}

/** 从一个 ref 的值里抽出 file_id。 */
function extractFileId(value: unknown): string | null {
  if (typeof value === 'string') {
    const matched = /file_id["'\s:=]+([A-Za-z0-9_-]{4,})/.exec(value);
    return matched ? matched[1] : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === 'file_id' && typeof record[key] === 'string') {
        return record[key] as string;
      }
      if (key.includes('file_id') && typeof record[key] === 'string') {
        return record[key] as string;
      }
    }
  }
  return null;
}

/**
 * 单个文件引用的下载按钮。
 * **下载目标就是 ref 里解析出的 file_id** —— 不是当前版本的文件，
 * 两者常常不是同一个（ref 可能指向解析产物、中间文件等）。
 * 文件名要回查 File Service，所以每个按钮自己订阅一次（带缓存，同 id 只请求一次）。
 */
const FileRefDownloadButton: React.FC<{ fileId: string; label: string }> = ({
  fileId,
  label,
}) => {
  const { file, loading } = useFileInfo(fileId);
  return (
    <Tooltip title={file ? `${file.file_name}（${fileId}）` : fileId}>
      <Button
        size="small"
        icon={<DownloadOutlined />}
        loading={loading}
        disabled={!file}
        onClick={() => file && downloadFile(file.file_id, file.file_name)}
      >
        {label}
      </Button>
    </Tooltip>
  );
};

interface NodeDetailDrawerProps {
  /** null 表示关闭；用 nodeId 而不是下标定位，轮询下更稳。 */
  nodeId: string | null;
  node: TimelineNode | null;
  onClose: () => void;
}

const NodeDetailDrawer: React.FC<NodeDetailDrawerProps> = ({
  nodeId,
  node,
  onClose,
}) => {
  const { styles } = useStyles();
  /** 默认选中第一个执行单元；切换节点时由 key 变化重置。 */
  const [tabKey, setTabKey] = useState<string>('');

  const units = useMemo(() => {
    if (!node) return [];
    // 扇出节点：一路一行；线性 / 控制节点：只有自己那一行
    return node.branches.length > 0 ? node.branches : [];
  }, [node]);

  const activeKey = useMemo(() => {
    if (units.length === 0) return '';
    return units.some((unit) => unit.key === tabKey) ? tabKey : units[0].key;
  }, [units, tabKey]);

  const kv = (label: string, value: React.ReactNode) => (
    <React.Fragment key={label}>
      <div className={styles.kvLabel}>{label}</div>
      <div className={styles.kvValue}>{value}</div>
    </React.Fragment>
  );

  /**
   * 一段 JSON：接口没返回就给空态，不编造。
   * input_summary / output_summary 里**每个带 file_id 的 ref 各给一个下载按钮**，
   * 下载的就是该 ref 指向的文件（不是当前版本文件，两者常常不同）。
   */
  const renderJson = (name: string, value: unknown) => {
    const allRefs =
      name === 'input_summary' || name === 'output_summary'
        ? collectFileRefs(value)
        : [];
    const refs = allRefs.filter((hit) => hit.fileId != null);

    return (
      <div key={name} className={styles.drawerSection}>
        <div className={styles.sectionHead}>
          <div className={styles.drawerTitle} style={{ margin: 0 }}>
            {name}
          </div>
          {refs.length > 0 && (
            <Space size={8} wrap>
              {refs.map((hit) => (
                <FileRefDownloadButton
                  key={hit.path}
                  fileId={hit.fileId as string}
                  label={hit.path.split('.').pop() || hit.path}
                />
              ))}
            </Space>
          )}
        </div>
        {allRefs.length > 0 && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: 'block', marginBottom: 6 }}
          >
            {refs.length > 0
              ? `文件引用：${refs
                  .map((hit) => `${hit.path}=${hit.fileId}`)
                  .join('，')}`
              : `检测到 ${allRefs.length} 个 ref 字段，但都没有 file_id，无法定位文件`}
          </Typography.Text>
        )}
        {value == null ? (
          <div className={styles.emptyInline}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  接口暂未返回 {name}
                </Typography.Text>
              }
            />
          </div>
        ) : (
          <pre className={styles.jsonBlock}>
            {JSON.stringify(value, null, 2)}
          </pre>
        )}
      </div>
    );
  };

  const renderUnit = (unit: (typeof units)[number]) => (
    <div>
      <div className={styles.detailHead}>
        <Tag color={NODE_TAG_COLOR[unit.status]}>
          {NODE_STATUS_TEXT[unit.status]}
        </Tag>
        <span>{unit.label}</span>
        {unit.durationMs != null && (
          <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
            耗时 {unit.durationMs} ms
          </Typography.Text>
        )}
      </div>
      <div className={styles.kvGrid}>
        {kv('unit_key', <span className={styles.monoValue}>{unit.key}</span>)}
        {kv(
          'started_at',
          <span className={styles.monoValue}>{unit.startedAt ?? '—'}</span>,
        )}
        {kv(
          'finished_at',
          <span className={styles.monoValue}>{unit.finishedAt ?? '—'}</span>,
        )}
        {kv('attempt', unit.attempt ?? '—')}
        {unit.chunkCount != null && kv('chunks', unit.chunkCount)}
        {unit.tokenCount != null && kv('tokens', unit.tokenCount)}
      </div>
      {unit.errorMessage && (
        <div className={styles.errorBox}>
          {unit.errorType ? `error_type: ${unit.errorType}\n` : ''}
          {unit.errorMessage}
        </div>
      )}
      <div className={styles.divider} />
      {renderJson('input_summary', unit.inputSummary)}
      {renderJson('output_summary', unit.outputSummary)}
      {renderJson('metrics', unit.metrics)}
    </div>
  );

  /** 线性 / 控制节点没有执行单元，直接把唯一那一行摊开。 */
  const renderSingleRow = (row: TimelineNode['rows'][number]) => (
    <div>
      {renderJson('input_summary', row.input_summary)}
      {renderJson('output_summary', row.output_summary)}
      {renderJson('metrics', row.metrics)}
    </div>
  );

  const tabItems = units.map((unit) => ({
    key: unit.key,
    label: (
      <span>
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            marginRight: 6,
            verticalAlign: 1,
            background:
              unit.status === 'completed'
                ? '#52c41a'
                : unit.status === 'running'
                  ? '#1677ff'
                  : unit.status === 'failed'
                    ? '#ff4d4f'
                    : unit.status === 'skipped'
                      ? '#bfbfbf'
                      : '#d9d9d9',
          }}
        />
        {unit.label}
      </span>
    ),
    children: renderUnit(unit),
  }));

  return (
    <Drawer
      open={Boolean(nodeId && node)}
      onClose={onClose}
      /** antd v6 起 width 已废弃，用 size 指定宽度（数字＝像素）。
       *  执行明细要并排读三段 JSON，宽度给足一些。 */
      size={760}
      placement="right"
      destroyOnHidden
      title={
        node ? (
          <div className={styles.detailHead} style={{ marginBottom: 0 }}>
            <span>{node.label}</span>
            <Tag color={NODE_TAG_COLOR[node.state]}>
              {NODE_STATUS_TEXT[node.state]}
            </Tag>
            <Tag>{node.group}</Tag>
            <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
              第 {node.sequence} 步
            </Typography.Text>
            {node.deprecated && <Tag color="warning">已退役节点</Tag>}
          </div>
        ) : (
          '节点详情'
        )
      }
    >
      {node && (
        <>
          {/* ---------- 概览（常驻，不进 Tab） ---------- */}
          <div className={styles.drawerSection}>
            <div className={styles.drawerTitle}>概览</div>
            <div className={styles.kvGrid}>
              {kv(
                'node_id',
                <span className={styles.monoValue}>{node.nodeId}</span>,
              )}
              {kv('group', node.group)}
              {kv('sequence', node.sequence)}
              {kv(
                'attempt',
                node.attempt != null ? (
                  <>
                    {node.attempt}
                    {node.attempt > 1 && (
                      <Tag color="warning" style={{ marginLeft: 6 }}>
                        重试 {node.attempt} 次
                      </Tag>
                    )}
                  </>
                ) : (
                  '—'
                ),
              )}
              {kv(
                '耗时',
                node.durationMs != null ? `${node.durationMs} ms` : '—',
              )}
              {kv(
                'started_at',
                <span className={styles.monoValue}>
                  {node.startedAt ?? '—'}
                </span>,
              )}
              {kv(
                'finished_at',
                <span className={styles.monoValue}>
                  {node.finishedAt ?? '—'}
                </span>,
              )}
            </div>
          </div>

          {node.description && (
            <div className={styles.drawerSection}>
              <div className={styles.drawerTitle}>节点说明</div>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                {node.description}
              </Typography.Text>
            </div>
          )}

          {node.branches.length > 0 && (
            <div className={styles.drawerSection}>
              <div className={styles.drawerTitle}>
                执行单元（动态扇入 · {node.branches.length} 路）
              </div>
              <div>
                {node.branches.map((branch) => (
                  <div key={branch.key} className={styles.branchRow}>
                    <span className={styles.branchName}>{branch.label}</span>
                    <Tag color={NODE_TAG_COLOR[branch.status]}>
                      {NODE_STATUS_TEXT[branch.status]}
                    </Tag>
                    <span>耗时 {branch.durationMs ?? '—'} ms</span>
                    {branch.chunkCount != null && (
                      <span>{branch.chunkCount} chunks</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {node.errorMessage && (
            <div className={styles.drawerSection}>
              <div className={styles.drawerTitle}>错误（节点聚合）</div>
              <div className={styles.errorBox}>
                {node.errorType ? `error_type: ${node.errorType}\n` : ''}
                {node.errorMessage}
              </div>
            </div>
          )}

          {node.preview && (
            <div className={styles.drawerSection}>
              <div className={styles.drawerTitle}>产出预览</div>
              <div className={styles.previewBox}>{node.preview}</div>
            </div>
          )}

          <div className={styles.drawerSection}>
            <div className={styles.drawerTitle}>原始节点行</div>
            {node.rows.length > 0 ? (
              <pre className={styles.jsonBlock}>
                {JSON.stringify(
                  node.rows.map((row) => ({
                    node_id: row.node_id,
                    branch_key: row.branch_key,
                    attempt: row.attempt,
                    status: row.status,
                    duration_ms: row.duration_ms,
                    error_type: row.error_type,
                  })),
                  null,
                  2,
                )}
              </pre>
            ) : (
              <div className={styles.emptyInline}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无节点行"
                />
              </div>
            )}
          </div>

          {/* ---------- 执行明细：Tab 紧贴明细标题 ---------- */}
          <div className={styles.divider} />
          <div className={styles.drawerSection}>
            <div className={styles.drawerTitle}>执行明细</div>
            {units.length > 0 ? (
              <Tabs
                activeKey={activeKey}
                items={tabItems}
                onChange={setTabKey}
                size="small"
              />
            ) : node.rows.length > 0 ? (
              renderSingleRow(node.rows[0])
            ) : (
              <div className={styles.emptyInline}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="接口暂未返回执行明细"
                />
              </div>
            )}
          </div>
        </>
      )}
    </Drawer>
  );
};

export default NodeDetailDrawer;
