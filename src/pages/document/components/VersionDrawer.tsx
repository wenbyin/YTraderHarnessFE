// src/pages/document/components/VersionDrawer.tsx
// 版本抽屉：点击版本行右侧「查看」弹出。数据来源分三块：
//  - 版本文件：file_id 回查 File Service（GET /api/v1/files/{file_id}）；
//  - Pipeline 快照：GET /documents/{id}/versions/{vid} 的 pipeline_config；
//  - Retrieval / Chunk：document_version.yaml 的
//      GET /document-versions/{vid}/retrievals                 → tab 列表
//      GET /document-versions/{vid}/retrievals/{rid}/chunks    → 某个 tab 的内容
//      POST /document-chunk-projections                       → 这些 chunk 写进索引的投影
//      POST /qa-datasets:generate                             → 生成本版本的 QA 测试集（手动触发）
//    注：投影是「一条 chunk × N 路 retrieval」的嵌套结构 —— 同一条 chunk 会被
//    多路各写一份、形态不同，所以它不挂在某个 tab 下，点一次看到的是全部路。
//    两个接口后端仍在落地；投影还是「点了才请求」，HEAD 里的降级对
//    retrievals / chunks 生效，见 versionResult.ts。
import { DownloadOutlined, ExperimentOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Pagination,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';

import { retrievalTypeLabel } from '@/utils/retrievalType';

import { downloadFile } from '../../file/service';
import type {
  ChunkProjection,
  ChunkProjectionEntry,
  DocumentChunkSummary,
  DocumentVersionDetailResponse,
  DocumentVersionRetrievalSummary,
  DocumentVersionSummary,
} from '../data';
import { formatBytes, useFileInfo } from '../fileInfo';
import { useStyles } from '../style';
import {
  useChunkProjections,
  useVersionChunks,
  useVersionRetrievals,
} from '../versionResult';
import QaDatasetModal from './QaDatasetModal';

const PROCESSING_META: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '待处理' },
  processing: { color: 'blue', text: '处理中' },
  completed: { color: 'green', text: '已完成' },
  failed: { color: 'red', text: '失败' },
};

const KIND_META: Record<string, { color: string; text: string }> = {
  dense: { color: 'blue', text: '稠密向量' },
  sparse: { color: 'geekblue', text: '稀疏向量' },
  graph: { color: 'purple', text: '图结构' },
};

interface VersionDrawerProps {
  open: boolean;
  onClose: () => void;
  documentId: string;
  version: DocumentVersionSummary | null;
  versionDetail: DocumentVersionDetailResponse | null;
  loadingDetail: boolean;
}

const VersionDrawer: React.FC<VersionDrawerProps> = ({
  open,
  onClose,
  documentId,
  version,
  versionDetail,
  loadingDetail,
}) => {
  const { styles } = useStyles();
  const { file, loading: loadingFile } = useFileInfo(version?.file_id);

  const versionId = version?.document_version_id ?? null;
  const snapshotRetrievals = versionDetail?.pipeline_config?.retrievals ?? null;

  const {
    items: retrievals,
    loading: loadingRetrievals,
    degraded: retrievalsDegraded,
  } = useVersionRetrievals(versionId, open, snapshotRetrievals);

  const [activeKey, setActiveKey] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [qaOpen, setQaOpen] = useState(false);

  const activeRetrieval = retrievals.find(
    (item) => item.document_retrieval_definition_id === activeKey,
  );

  const {
    items: chunks,
    total,
    loading: loadingChunks,
    degraded: chunksDegraded,
  } = useVersionChunks({
    documentVersionId: versionId,
    documentRetrievalDefinitionId:
      activeRetrieval?.document_retrieval_definition_id ?? null,
    retrievalType: activeRetrieval?.retrieval_type ?? null,
    page,
    pageSize,
    enabled: open,
  });

  /** 投影按需加载：默认一条都不取，点了才发请求（投影要现算现发，别浪费）。 */
  const projections = useChunkProjections();

  const handleLoadProjection = useCallback(
    (chunkId: string) => {
      void projections.load([chunkId]);
    },
    [projections.load],
  );

  const handleLoadFullVector = useCallback(
    (chunkId: string) => {
      // 完整向量体积大（稠密 512 个 float），单独再要一次
      void projections.load([chunkId], true);
    },
    [projections.load],
  );

  // 换版本：回到第一个 tab 并重置分页
  useEffect(() => {
    setPage(1);
    setActiveKey('');
  }, [versionId]);

  // 默认选中第一个 tab。用 definition id 而不是 retrieval_type 做 key ——
  // 同一个 retic 类型可能有多路，只有 id 是唯一的。
  useEffect(() => {
    if (!activeKey && retrievals.length > 0) {
      setActiveKey(retrievals[0].document_retrieval_definition_id);
    }
  }, [retrievals, activeKey]);

  // tab 列表换了一批（切版本 / 数据回来晚了），先前选中的那个不存在了
  useEffect(() => {
    if (
      activeKey &&
      retrievals.length > 0 &&
      !retrievals.some(
        (item) => item.document_retrieval_definition_id === activeKey,
      )
    ) {
      setActiveKey(retrievals[0].document_retrieval_definition_id);
    }
  }, [retrievals, activeKey]);

  const pipeline = versionDetail?.pipeline_config;

  /**
   * 该版本是否已经产出 chunk —— 生成 QA 数据集靠「正文区间 ∩ chunk 区间」定位
   * 目标 chunk，没有 chunk 就求不出交集。
   *
   * null = 还不知道（在加载 / retrievals 走了降级口径，那时 chunk_count 是假的 0），
   * 不知道就别提示，别拿假数据吓人。
   */
  const hasChunks =
    loadingRetrievals || retrievalsDegraded
      ? null
      : retrievals.some((item) => item.chunk_count > 0);

  /** 某一路 retrieval 的面板：运行信息 + chunk 列表。只给当前选中的那个渲染。 */
  const renderRetrievalBody = (item: DocumentVersionRetrievalSummary) => {
    // 降级（接口未提供）时 chunker / chunk_count / processing_status 都不是真值，不展示
    const statusMeta = retrievalsDegraded
      ? null
      : PROCESSING_META[item.processing_status];

    return (
      <div>
        <div className={styles.drawerMeta} style={{ marginBottom: 12 }}>
          {item.storage_backend && (
            <span>存储后端：{item.storage_backend}</span>
          )}
          {!retrievalsDegraded && (
            <>
              <span>
                chunker：
                {item.chunker ? (
                  <Tooltip
                    title={
                      item.chunker.config &&
                      Object.keys(item.chunker.config).length > 0 ? (
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 12,
                            maxWidth: 360,
                            maxHeight: 240,
                            overflow: 'auto',
                          }}
                        >
                          {JSON.stringify(item.chunker.config, null, 2)}
                        </pre>
                      ) : (
                        '这次运行没有记录 chunker 配置'
                      )
                    }
                  >
                    <Typography.Text className={styles.monoValue}>
                      {item.chunker.processor_key}
                    </Typography.Text>
                  </Tooltip>
                ) : (
                  // 契约要求：缺失时显示「未知」，**不要**回退去读当前定义
                  // —— 改过定义之后，现值跟这次运行用的根本不是一回事。
                  <Tooltip title="后端没有留下这次运行用的 chunker 记录（该版本跑在改造之前），所以只报「未知」，不回退去读当前定义 —— 那会撒谎">
                    <Typography.Text type="secondary">未知</Typography.Text>
                  </Tooltip>
                )}
              </span>
              <span>chunk 数：{item.chunk_count}</span>
            </>
          )}
          {statusMeta && <Tag color={statusMeta.color}>{statusMeta.text}</Tag>}
          <span className={styles.monoValue}>
            {item.document_retrieval_definition_id.slice(0, 8)}…
          </span>
        </div>

        {item.error_message && (
          <div className={styles.errorBox}>{item.error_message}</div>
        )}

        <div className={styles.metaLabel} style={{ margin: '12px 0' }}>
          Chunk 列表
        </div>

        {loadingChunks ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : chunks.length === 0 ? (
          <Empty description="暂无 Chunk" />
        ) : (
          <div className={styles.chunkList}>
            {chunks.map((chunk) => (
              <ChunkRow
                // 带上 retrieval id：换 tab 时同序号的行不会复用上一次的展开状态
                key={`${item.document_retrieval_definition_id}-${chunk.chunk_index}`}
                chunk={chunk}
                retrievalId={item.document_retrieval_definition_id}
                projection={projections.items[chunk.document_chunk_id]}
                projectionLoading={projections.loading[chunk.document_chunk_id]}
                projectionError={projections.errors[chunk.document_chunk_id]}
                onLoadProjection={handleLoadProjection}
                onLoadFullVector={handleLoadFullVector}
              />
            ))}
          </div>
        )}

        {total > pageSize && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: 16,
            }}
          >
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              onChange={(nextPage, nextSize) => {
                setPage(nextPage);
                setPageSize(nextSize);
              }}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <Drawer
      title={version ? `版本 v${version.version_number} 详情` : '版本详情'}
      size={720}
      open={open}
      onClose={onClose}
      destroyOnHidden
    >
      {/* 版本文件 */}
      <div className={styles.drawerSection}>
        <p className={styles.drawerTitle}>版本文件</p>
        {loadingFile ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : (
          <Space orientation="vertical" size={6} style={{ width: '100%' }}>
            <Space size={8} wrap>
              <Typography.Text strong>{file?.file_name ?? '—'}</Typography.Text>
              {file?.content_type && <Tag>{file.content_type}</Tag>}
              <Typography.Text type="secondary">
                {formatBytes(file?.file_size)}
              </Typography.Text>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                disabled={!file}
                onClick={() =>
                  file && downloadFile(file.file_id, file.file_name)
                }
              >
                下载
              </Button>
            </Space>
            <Typography.Text
              copyable={{ text: version?.file_id ?? '' }}
              className={styles.monoValue}
              type="secondary"
            >
              file_id: {version?.file_id ?? '—'}
            </Typography.Text>
          </Space>
        )}
      </div>

      {/* Pipeline 快照 */}
      <div className={styles.drawerSection}>
        <p className={styles.drawerTitle}>Pipeline 配置快照</p>
        {loadingDetail ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : versionDetail ? (
          <Space orientation="vertical" size={4} style={{ width: '100%' }}>
            <Space size={8} wrap>
              <Typography.Text type="secondary">模型类型</Typography.Text>
              <Tag color="blue">{pipeline?.modality_type ?? '—'}</Tag>
              <Typography.Text type="secondary">loader</Typography.Text>
              <Tag>{pipeline?.loader?.name ?? '—'}</Tag>
              <Typography.Text type="secondary">processor</Typography.Text>
              <Tag>{pipeline?.processor?.name ?? '—'}</Tag>
            </Space>
            <Typography.Text type="secondary" className={styles.monoValue}>
              document: {documentId}
            </Typography.Text>
          </Space>
        ) : (
          <Empty description="暂无配置快照" />
        )}
      </div>

      {/**
       * QA 评估数据集：手动触发，不在任何管线步骤里。
       * 放在 Pipeline 快照之后、Retrieval / Chunk 之前 —— 它的输入就是
       * 「这个版本处理完的正文与 chunk」，跟快照同源；而下面那一大块
       * Retrieval / Chunk 是逐路展开的细节，放它前面会把入口挤到看不见。
       */}
      <div className={styles.drawerSection}>
        <div className={styles.sectionHead}>
          <p className={styles.drawerTitle} style={{ margin: 0 }}>
            QA 评估数据集
          </p>
          <Button
            size="small"
            icon={<ExperimentOutlined />}
            disabled={!versionId}
            onClick={() => setQaOpen(true)}
          >
            生成数据集
          </Button>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          以本版本的 clean 正文与 chunk 区间为素材，生成带精确目标标注（目标
          chunk id）的 QA 测试集 —— 排查「某个 chunk 搜不到」时不必再手工挑
          chunk、 手工构造 query。产物写在服务器磁盘上，接口只回路径与统计。
        </Typography.Text>
      </div>

      {/* Retrieval + Chunk */}
      <div className={styles.drawerSection}>
        <div className={styles.sectionHead}>
          <p className={styles.drawerTitle} style={{ margin: 0 }}>
            Retrieval / Chunk
          </p>
          {chunksDegraded && <Tag color="warning">Chunk 为示例数据</Tag>}
        </div>

        {loadingRetrievals || loadingDetail ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : retrievals.length === 0 ? (
          <Empty description="该版本没有 retrieval 处理结果" />
        ) : (
          <>
            {retrievalsDegraded && (
              <div className={styles.noticeBox}>
                GET /document-versions/
                {'{vid}'}/retrievals
                这次没取到（后端故障，或该版本还没处理完），下面退回
                pipeline_config 的旧口径 —— 当次实际使用的 chunker
                与成败状态暂不可知。
              </div>
            )}
            <Tabs
              activeKey={activeKey}
              onChange={(key) => {
                setActiveKey(key);
                setPage(1);
              }}
              items={retrievals.map((item) => ({
                key: item.document_retrieval_definition_id,
                // 只显示中文名；原始 key 在下面的段头里以等宽字体给出，便于对照后端
                label: retrievalTypeLabel(item.retrieval_type),
                // 只渲染选中的那一屏：chunk 数据始终对应 activeKey
                children:
                  item.document_retrieval_definition_id === activeKey
                    ? renderRetrievalBody(item)
                    : null,
              }))}
            />
          </>
        )}
      </div>

      <QaDatasetModal
        open={qaOpen}
        onClose={() => setQaOpen(false)}
        documentVersionId={versionId}
        versionNumber={version?.version_number ?? null}
        hasChunks={hasChunks}
      />
    </Drawer>
  );
};

/** 预览长度：超过就折叠，点「展开」看全文。 */
const PREVIEW_CHARS = 220;

/**
 * 单条 chunk。提出来做组件，列表重渲染时不必重建整棵树的 props。
 *
 * 这里的折叠是**纯前端行为**：接口没传 preview_chars，拿到的就是全文，
 * 所以「展开」不需要再请求。后端截断过的（content_truncated）没有全文可给，
 * 那种情况不给「展开」，只如实标注。
 */
interface ChunkRowProps {
  chunk: DocumentChunkSummary;
  /**
   * 当前 tab 的 retrieval 定义 id。
   * 投影是按「这条 chunk 被哪几路用到」给的，可能不止当前 tab 这一路，
   * 传进来是为了把当前 tab 那一路标出来 —— 路本身的名字在投影项里自带，
   * 不需要这里再传 retrieval_type。
   */
  retrievalId: string;
  projection?: ChunkProjection;
  projectionLoading?: boolean;
  projectionError?: string;
  onLoadProjection: (chunkId: string) => void;
  onLoadFullVector: (chunkId: string) => void;
}

const ChunkRow: React.FC<ChunkRowProps> = ({
  chunk,
  retrievalId,
  projection,
  projectionLoading,
  projectionError,
  onLoadProjection,
  onLoadFullVector,
}) => {
  const { styles } = useStyles();
  const [expanded, setExpanded] = useState(false);
  const [showProjection, setShowProjection] = useState(false);
  /** 元数据默认只给摘要（有哪几项），点开才铺开 JSON。 */
  const [showMeta, setShowMeta] = useState(false);
  const hasLocator =
    Boolean(chunk.locator) && Object.keys(chunk.locator ?? {}).length > 0;
  const hasMetadata = Object.keys(chunk.metadata ?? {}).length > 0;

  const canCollapse =
    !chunk.content_truncated && chunk.content.length > PREVIEW_CHARS;
  const shown =
    canCollapse && !expanded
      ? `${chunk.content.slice(0, PREVIEW_CHARS)}…`
      : chunk.content;

  const toggleProjection = () => {
    const next = !showProjection;
    setShowProjection(next);
    // 第一次点开才请求；之后走 hook 内的缓存
    if (next && !projection && !projectionLoading) {
      onLoadProjection(chunk.document_chunk_id);
    }
  };

  return (
    <div className={styles.chunkRow}>
      <div className={styles.chunkHeader}>
        <span className={styles.chunkIndex}>#{chunk.chunk_index}</span>
        {chunk.token_count != null && (
          <Tag color="default">{chunk.token_count} tokens</Tag>
        )}
        <Tag>{chunk.char_count} 字符</Tag>
        {chunk.start_index != null && chunk.end_index != null && (
          <Typography.Text type="secondary" className={styles.monoValue}>
            [{chunk.start_index}, {chunk.end_index})
          </Typography.Text>
        )}
      </div>
      <div className={styles.chunkBody}>
        {/* 1. 预览 */}
        <div className={styles.chunkSection}>
          <div className={styles.chunkSectionHead}>
            <span className={styles.chunkSectionTitle}>预览</span>
            {canCollapse ? (
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? '收起' : `展开全文（共 ${chunk.char_count} 字符）`}
              </Typography.Link>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                共 {chunk.char_count} 字符
              </Typography.Text>
            )}
          </div>

          <pre className={styles.chunkContent}>{shown}</pre>

          {chunk.content_truncated && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              后端返回的是截断内容（「字符」标签给的是截断**前**的长度）。
              取全文要走 GET /document-chunks/
              {'{id}'} —— 这个接口实测还没提供。
            </Typography.Text>
          )}
        </div>

        {/* 2. 投影 */}
        <div className={styles.chunkSection}>
          <div className={styles.chunkSectionHead}>
            <span className={styles.chunkSectionTitle}>投影</span>
            <Button size="small" type="text" onClick={toggleProjection}>
              {showProjection ? '收起' : '查询投影'}
            </Button>
          </div>

          {showProjection ? (
            <ProjectionPanel
              projection={projection}
              activeRetrievalId={retrievalId}
              loading={projectionLoading}
              error={projectionError}
              onLoadFullVector={() => onLoadFullVector(chunk.document_chunk_id)}
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              点击「查询投影」获取这条 chunk 当时写进索引的内容（向量 /
              图结构）。
            </Typography.Text>
          )}
        </div>

        {/* 3. 元数据 */}
        <div className={styles.chunkSection}>
          <div className={styles.chunkSectionHead}>
            <span className={styles.chunkSectionTitle}>元数据</span>
            {hasLocator || hasMetadata ? (
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={() => setShowMeta((value) => !value)}
              >
                {showMeta ? '收起' : '展开'}
              </Typography.Link>
            ) : null}
          </div>

          {!hasLocator && !hasMetadata ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              无
            </Typography.Text>
          ) : showMeta ? (
            <>
              {hasLocator && (
                <div className={styles.metaBlock} style={{ borderTop: 0 }}>
                  <div className={styles.metaLabel}>locator</div>
                  <pre className={styles.metaJson}>
                    {JSON.stringify(chunk.locator, null, 2)}
                  </pre>
                </div>
              )}
              {hasMetadata && (
                <div className={styles.metaBlock}>
                  <div className={styles.metaLabel}>metadata</div>
                  <pre className={styles.metaJson}>
                    {JSON.stringify(chunk.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[
                hasLocator ? 'locator' : null,
                hasMetadata
                  ? `metadata（${Object.keys(chunk.metadata ?? {}).length} 个字段）`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          )}
        </div>
      </div>
    </div>
  );
};

interface ProjectionPanelProps {
  projection?: ChunkProjection;
  /** 当前 tab 的 retrieval 定义 id —— 用来在 N 路里标出「当前」那一标。 */
  activeRetrievalId: string;
  loading?: boolean;
  error?: string;
  onLoadFullVector: () => void;
}

/**
 * 一条 chunk 的投影。
 *
 * 外层是「这条 chunk」，里面的 projections 是**一组**：每一路用到这条 chunk
 * 的 retrieval 各占一项 —— 它们被写进不同的索引、形态也不同（稠密 / 稀疏 /
 * 透传），所以「这条 chunk 的投影」本来就不是一条记录。
 *
 * 因此在任何一个 tab 里点一次，看到的是它在**所有**路下的样子 ——
 * 这正是这份数据的用处所在，不该只看当前 tab 那一路。
 */
const ProjectionPanel: React.FC<ProjectionPanelProps> = ({
  projection,
  activeRetrievalId,
  loading,
  error,
  onLoadFullVector,
}) => {
  const { styles } = useStyles();

  if (loading) return <Skeleton active paragraph={{ rows: 2 }} />;

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginTop: 8 }}
        title={`投影加载失败：${error}`}
      />
    );
  }

  if (!projection) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        还没有拿到这条 chunk 的投影，请重新点一次「查询投影」。
      </Typography.Text>
    );
  }

  // 整条 chunk 就取不到（document_chunk 里没有这条 id），此时必然一路都没有
  if (projection.unavailable_reason) {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 8 }}
        title="这条 chunk 没有投影"
        description={projection.unavailable_reason}
      />
    );
  }

  const entries = projection.projections ?? [];

  if (entries.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        后端没有返回任何一路的投影（正常不该发生：用到它的 retrieval
        至少有一路）。
      </Typography.Text>
    );
  }

  return (
    // 不套 metaBlock：段与段之间已经由 chunkSection 的虚线分隔，再叠一条会变成双线
    <div>
      {projection.chunker_key && (
        <div className={styles.metaLabel}>
          由{' '}
          <Typography.Text className={styles.monoValue}>
            {projection.chunker_key}
          </Typography.Text>{' '}
          切出，被下面 {entries.length} 路 retrieval 用到
        </div>
      )}
      {entries.map((entry) => (
        <ProjectionEntry
          key={entry.document_retrieval_definition_id}
          entry={entry}
          current={entry.document_retrieval_definition_id === activeRetrievalId}
          onLoadFullVector={onLoadFullVector}
        />
      ))}
    </div>
  );
};

interface ProjectionEntryProps {
  entry: ChunkProjectionEntry;
  /** 是不是当前 tab 那一路。不是的那几路是「同一条 chunk 的其它去向」。 */
  current: boolean;
  onLoadFullVector: () => void;
}

/**
 * 某一路 retrieval 下的投影。
 *
 * 布局沿用原来的写法，只是作用域从「一条 chunk」缩到「一条 chunk 的某一路」
 * —— 所以 kind / embedder / dimensions / unavailable_reason 都在这里各自一份。
 */
const ProjectionEntry: React.FC<ProjectionEntryProps> = ({
  entry,
  current,
  onLoadFullVector,
}) => {
  const { styles } = useStyles();
  const [showFields, setShowFields] = useState(false);

  const kindMeta = entry.kind ? KIND_META[entry.kind] : null;
  const summary = entry.vector_summary;
  const sparse = entry.sparse_summary;
  const hasFields = Object.keys(entry.fields ?? {}).length > 0;
  // include_vector=true 时可能只有完整向量而没有摘要，也算「有内容」
  const hasFullVector = Boolean(entry.vector?.length);
  const hasFullSparse = Boolean(
    entry.sparse && Object.keys(entry.sparse).length > 0,
  );
  const hasBody = Boolean(
    summary || sparse || hasFields || hasFullVector || hasFullSparse,
  );

  return (
    <div className={styles.projEntry}>
      <Space size={8} wrap style={{ marginBottom: 6 }}>
        <Tag color={current ? 'blue' : undefined}>
          {retrievalTypeLabel(entry.retrieval_type)}
        </Tag>
        {current && <Tag color="blue">当前 tab</Tag>}
        {kindMeta ? (
          <Tag color={kindMeta.color}>{kindMeta.text}</Tag>
        ) : (
          // 透传那两路（keyword / document）没有独立产物，kind 本来就是 null
          !entry.unavailable_reason && <Tag>无投影形态</Tag>
        )}
        {entry.embedder && (
          <Typography.Text type="secondary" className={styles.monoValue}>
            {entry.embedder}
          </Typography.Text>
        )}
        {entry.dimensions != null && (
          <Typography.Text type="secondary">
            声明维度 {entry.dimensions}
          </Typography.Text>
        )}
      </Space>

      {/* keyword / document 那两路是透传的，没有单独产物 —— 把后端给的原因说出来 */}
      {entry.unavailable_reason ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {entry.unavailable_reason}
        </Typography.Text>
      ) : !hasBody ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          这一路没有可展示的投影内容。
        </Typography.Text>
      ) : (
        <>
          {/* 声明维度与实际向量长度不一致 —— 这本身就是问题，要点出来 */}
          {summary &&
            entry.dimensions != null &&
            summary.dimensions !== entry.dimensions && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                title={`维度不一致：产物声明 ${entry.dimensions}，实际向量长度 ${summary.dimensions}`}
              />
            )}

          {summary && (
            <div className={styles.kvGrid} style={{ marginBottom: 8 }}>
              <span className={styles.kvLabel}>实际维度</span>
              <span className={styles.kvValue}>{summary.dimensions}</span>
              <span className={styles.kvLabel}>非零分量</span>
              <span className={styles.kvValue}>{summary.nonzero_count}</span>
              <span className={styles.kvLabel}>L2 模长</span>
              <span className={styles.kvValue}>
                {summary.l2_norm.toFixed(4)}
                {/* embedder 开了归一化时应接近 1.0，明显偏离说明没归一化 */}
                {Math.abs(summary.l2_norm - 1) > 0.05 ? '（未归一化）' : ''}
              </span>
              <span className={styles.kvLabel}>前几个值</span>
              <span className={styles.kvValue}>
                {summary.head.map((value) => value.toFixed(4)).join(', ')}
              </span>
            </div>
          )}

          {sparse && (
            <div style={{ marginBottom: 8 }}>
              <div className={styles.metaLabel}>
                稀疏向量 · 非零项 {sparse.nonzero_count}
              </div>
              <Space size={6} wrap>
                {sparse.top.map((item) => (
                  // dim 是 token id，同一条 sparse 向量内唯一
                  <Tag key={String(item.dim)} className={styles.monoValue}>
                    {String(item.dim)}: {String(item.weight)}
                  </Tag>
                ))}
              </Space>
            </div>
          )}

          {/* graph 的图结构就在 fields 里；dense/sparse 的 fields 是随向量一起发的非向量字段 */}
          {hasFields && (
            <div style={{ marginBottom: 8 }}>
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={() => setShowFields((value) => !value)}
              >
                {showFields
                  ? `收起${entry.kind === 'graph' ? '图结构' : '非向量字段'}`
                  : `展开${entry.kind === 'graph' ? '图结构' : '非向量字段'}`}
              </Typography.Link>
              {showFields && (
                <pre className={styles.jsonBlock} style={{ marginTop: 6 }}>
                  {JSON.stringify(entry.fields, null, 2)}
                </pre>
              )}
            </div>
          )}

          {/* 完整向量体积大（稠密 512 个 float），默认不取 */}
          {hasFullVector ? (
            <pre className={styles.jsonBlock} style={{ marginTop: 6 }}>
              {JSON.stringify(entry.vector)}
            </pre>
          ) : entry.kind === 'dense' || entry.kind === 'sparse' ? (
            <Typography.Link
              style={{ fontSize: 12 }}
              onClick={onLoadFullVector}
            >
              加载完整向量
            </Typography.Link>
          ) : null}

          {hasFullSparse && (
            <pre className={styles.jsonBlock} style={{ marginTop: 6 }}>
              {JSON.stringify(entry.sparse, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  );
};

export default VersionDrawer;
