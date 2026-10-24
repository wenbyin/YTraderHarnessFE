// src/pages/document/versionResult.ts
// 对接 YTraderHarness
// app/services/document/document_version.yaml（Document Version API）。
//
// 抽屉里「处理结果」这两块的取数口径：
//   GET  /document-versions/{vid}/retrievals                      tab 列表（运行时冻结的 chunker + 成败）
//   GET  /document-versions/{vid}/retrievals/{rid}/chunks         某个 tab 的 chunk（分页 + preview_chars）
//
// 手动触发的产物：
//   POST /qa-datasets:generate                                    为某版本生成 QA 测试集
//
// 两个接口后端**已经实装**（2026-09-21 实测：3 个 tab、chunk 分页都是 200 + 真实数据）。
// 降级路径保留，但触发条件不再是「404 未实现」，而是真实故障 ——
// 版本还没处理完、后端 5xx、网络断。留着它，抽屉才不会因为这些原因整块开天窗：
//   retrievals → 退回 pipeline_config.retrievals（旧口径，可能为空）
//   chunks     → 退回 chunkSample 的示例数据（页面会打出「示例数据」标记）
//
// 为什么两份实现放在 hook 里而不是组件里：
//   降级逻辑（何时用哪份数据、degraded 标记）是两个 hook 各自的事，
//   塞进组件会让它同时管渲染和数据源仲裁。
import { request } from '@umijs/max';
import { useCallback, useEffect, useState } from 'react';

import { listVersionChunks } from './chunkSample';
import type {
  ChunkItem,
  ChunkProjection,
  ChunkProjectionListResponse,
  DocumentChunkListResponse,
  DocumentChunkSummary,
  DocumentVersionRetrievalListResponse,
  DocumentVersionRetrievalSummary,
  PipelineRetrievalSnapshot,
  QADatasetGenerateRequest,
  QADatasetGenerateResponse,
} from './data';

const API_BASE = '/api/v1/document-versions';
const PROJECTION_API = '/api/v1/document-chunk-projections';
const QA_DATASET_API = '/api/v1/qa-datasets:generate';

/**
 * 某版本实际参与处理的 retrieval 列表 —— 抽屉据此生成 N 个 tab。
 *
 * 来源是版本级绑定记录，**只返回真正跑过的**（包括失败的那几路）。
 */
export async function listDocumentVersionRetrievals(documentVersionId: string) {
  return request<DocumentVersionRetrievalListResponse>(
    `${API_BASE}/${documentVersionId}/retrievals`,
    { method: 'GET', skipErrorHandler: true },
  );
}

/**
 * 某个 tab 的 chunk 列表。排序固定 chunk_index 升序，翻页不会漂移。
 *
 * preview_chars：传了就只返回每条的前 N 个字符，并用 content_truncated 标记。
 * 单条全文要留着 —— 因为 GET /document-chunks/{id} 取单条的接口尚未提供，
 * 所以在它落地前**不要传 preview_chars**，否则用户看不到完整内容。
 */
export async function listDocumentVersionRetrievalChunks(
  documentVersionId: string,
  documentRetrievalDefinitionId: string,
  params: { page?: number; page_size?: number; preview_chars?: number } = {},
) {
  return request<DocumentChunkListResponse>(
    `${API_BASE}/${documentVersionId}/retrievals/${documentRetrievalDefinitionId}/chunks`,
    { method: 'GET', params, skipErrorHandler: true },
  );
}

/**
 * 批量查 chunk 的**投影** —— 这些 chunk 当时写给索引的是什么。
 *
 * 为什么用 POST：chunk_id 一次可能传上百个，塞 query string 会撞 URL 长度上限；
 * 语义上它是只读的。单次上限 200（契约限制）。
 *
 * include_vector=false（默认）只给摘要：维度 / 非零项数 / 模长 / 前几个值。
 * 稠密向量一条 512 个 float，N 条一起返回体积不小，所以要完整值得显式传 true。
 *
 * 结果与入参一一对应且同序，**包括取不到的那些**（带 unavailable_reason）。
 * 每一项内部还有一组 projections —— 每条对应**一路**用到这条 chunk 的
 * retrieval，因为 chunk 是版本级的，会被多路各写一份、形态还不同。
 * 所以这里一次请求就能喂给所有 tab，不必按 retrieval 各请求一遍。
 */
export async function getChunkProjections(
  documentChunkIds: string[],
  includeVector = false,
) {
  return request<ChunkProjectionListResponse>(PROJECTION_API, {
    method: 'POST',
    data: { document_chunk_ids: documentChunkIds },
    params: { include_vector: includeVector },
    skipErrorHandler: true,
  });
}

// ============================================================
// QA 数据集生成
// ============================================================

/**
 * 为某个文档版本生成一份带**精确目标标注**的 QA 测试集。
 *
 * ⚠️ 这是**同步**接口：请求时长 ≈ 窗口数 × 单次云端 LLM 调用。
 * 契约里 max_windows 默认只有 10（不是全量）正是这个原因 —— 一份 51.7 万字符
 * 的档案能切出 1257 个窗口，全量会挂几小时。所以这里显式把超时放宽到 30 分钟，
 * 默认的请求超时会把正常请求掐断。
 *
 * 产物**不在响应里**：服务端把它写成 JSON 落到磁盘，响应只给路径与统计。
 */
export async function generateQaDataset(body: QADatasetGenerateRequest) {
  return request<QADatasetGenerateResponse>(QA_DATASET_API, {
    method: 'POST',
    data: body,
    timeout: 30 * 60 * 1000,
  });
}

/** 把旧的 pipeline_config.retrievals 适配成 tab 的形状，用于降级显示。 */
function adaptSnapshot(list: PipelineRetrievalSnapshot[]) {
  return list.map<DocumentVersionRetrievalSummary>((item) => ({
    document_version_retrieval_binding_id:
      item.document_retrieval_definition_id ?? '',
    document_retrieval_definition_id:
      item.document_retrieval_definition_id ?? '',
    retrieval_type: item.retrieval_type ?? 'unknown',
    storage_backend: item.storage_backend ?? null,
    // 「当时用的 chunker」只有新接口知道，旧快照里没有 —— 留 null，别猜
    chunker: null,
    chunk_count: 0,
    processing_status: 'pending',
    error_message: null,
  }));
}

/** 示例数据 → chunk 的形状。 */
function adaptChunk(
  chunk: ChunkItem,
  documentRetrievalDefinitionId: string,
): DocumentChunkSummary {
  return {
    document_chunk_id: `${documentRetrievalDefinitionId}-${chunk.chunk_index}`,
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    content_truncated: false,
    char_count: chunk.char_count ?? chunk.content.length,
    token_count: chunk.token_count,
    start_index: (chunk.metadata?.start_index as number) ?? null,
    end_index: (chunk.metadata?.end_index as number) ?? null,
    content_hash: null,
    locator: null,
    metadata: chunk.metadata ?? {},
    created_at: null,
  };
}

export interface RetrievalsResult {
  items: DocumentVersionRetrievalSummary[];
  loading: boolean;
  /** true = 专用接口这次没取到（后端故障 / 版本尚未处理完），当前用的是 pipeline_config 的旧口径。 */
  degraded: boolean;
}

/**
 * 取某个版本的 retrieval tab 列表。
 *
 * degraded 为 true 时，items 可能来自 pipeline_config.retrievals，
 * 其中的 chunker / chunk_count / processing_status **都不是真值**，
 * 调用方不该展示它们。
 */
export function useVersionRetrievals(
  documentVersionId: string | null,
  enabled: boolean,
  fallback: PipelineRetrievalSnapshot[] | null,
): RetrievalsResult {
  const [items, setItems] = useState<DocumentVersionRetrievalSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!documentVersionId || !enabled) {
      setItems([]);
      setLoading(false);
      setDegraded(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listDocumentVersionRetrievals(documentVersionId)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items ?? []);
        setDegraded(false);
      })
      .catch(() => {
        if (cancelled) return;
        // 接口未就绪 → 退到旧快照口径，并标记降级
        setItems(fallback ? adaptSnapshot(fallback) : []);
        setDegraded(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentVersionId, enabled, fallback]);

  return { items, loading, degraded };
}

export interface ChunksResult {
  items: DocumentChunkSummary[];
  total: number;
  loading: boolean;
  /** true = 专用接口不可用，当前是示例数据（页面上必须明示）。 */
  degraded: boolean;
}

/** 取某个 tab 的 chunk；接口不可用时退回示例数据。 */
export function useVersionChunks(params: {
  documentVersionId: string | null;
  documentRetrievalDefinitionId: string | null;
  retrievalType: string | null;
  page: number;
  pageSize: number;
  enabled: boolean;
}): ChunksResult {
  const {
    documentVersionId,
    documentRetrievalDefinitionId,
    retrievalType,
    page,
    pageSize,
    enabled,
  } = params;

  const [items, setItems] = useState<DocumentChunkSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!enabled || !documentVersionId || !documentRetrievalDefinitionId) {
      setItems([]);
      setTotal(0);
      setDegraded(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    listDocumentVersionRetrievalChunks(
      documentVersionId,
      documentRetrievalDefinitionId,
      { page, page_size: pageSize },
    )
      .then((result) => {
        if (cancelled) return;
        setItems(result.items ?? []);
        setTotal(result.total ?? 0);
        setDegraded(false);
      })
      .catch(async () => {
        if (cancelled) return;
        const sample = await listVersionChunks({
          documentVersionId,
          retrievalType: retrievalType ?? 'unknown',
          page,
          pageSize,
        });
        if (cancelled) return;
        setItems(
          sample.items.map((chunk) =>
            adaptChunk(chunk, documentRetrievalDefinitionId),
          ),
        );
        setTotal(sample.total);
        setDegraded(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    documentVersionId,
    documentRetrievalDefinitionId,
    retrievalType,
    page,
    pageSize,
    enabled,
  ]);

  return { items, total, loading, degraded };
}

// ============================================================
// Chunk 投影
// ============================================================

/**
 * 投影的进程内缓存。key 是 `${chunkId}|${includeVector}` ——
 * 摘要版和完整向量版是两个不同的东西，不能互相顶掉。
 */
const projectionCache = new Map<string, ChunkProjection>();

export interface ProjectionsResult {
  /** 已取到的投影，按 chunk id 索引。 */
  items: Record<string, ChunkProjection>;
  /** 正在请求中的 chunk id。 */
  loading: Record<string, boolean>;
  /** 取失败的提示，按 chunk id 索引。 */
  errors: Record<string, string>;
  /** 按需加载；已经缓存过的不会再发请求。 */
  load: (chunkIds: string[], includeVector?: boolean) => Promise<void>;
  clear: () => void;
}

/**
 * 按需取 chunk 的投影。
 *
 * 设计上刻意**不做自动预取**：投影不落库、要现算现发，而抽屉里一页可能有
 * 几十条 chunk，绝大多数用户根本不看投影。所以默认不展示，点了才请求，
 * 并且同一个 id 在页面生命周期内只请求一次。
 */
export function useChunkProjections(): ProjectionsResult {
  const [items, setItems] = useState<Record<string, ChunkProjection>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(
    async (chunkIds: string[], includeVector = false) => {
      const fresh = chunkIds.filter(
        (id) => !projectionCache.has(`${id}|${includeVector}`),
      );
      if (fresh.length === 0) {
        // 全部命中缓存：直接同步到 state，不发请求
        setItems((prev) => {
          const next = { ...prev };
          for (const id of chunkIds) {
            const cached = projectionCache.get(`${id}|${includeVector}`);
            if (cached) next[id] = cached;
          }
          return next;
        });
        return;
      }

      // 一次最多 200（契约限制）
      const batch = fresh.slice(0, 200);
      setLoading((prev) => {
        const next = { ...prev };
        for (const id of batch) next[id] = true;
        return next;
      });
      setErrors((prev) => {
        const next = { ...prev };
        for (const id of batch) delete next[id];
        return next;
      });

      try {
        const result = await getChunkProjections(batch, includeVector);
        setItems((prev) => {
          const next = { ...prev };
          // 结果与入参一一对应且同序 —— 包括取不到的那些（带 unavailable_reason）
          for (const projection of result.items ?? []) {
            projectionCache.set(
              `${projection.document_chunk_id}|${includeVector}`,
              projection,
            );
            next[projection.document_chunk_id] = projection;
          }
          return next;
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : '请求失败';
        setErrors((prev) => {
          const next = { ...prev };
          for (const id of batch) next[id] = reason;
          return next;
        });
      } finally {
        setLoading((prev) => {
          const next = { ...prev };
          for (const id of batch) delete next[id];
          return next;
        });
      }
    },
    [],
  );

  const clear = useCallback(() => {
    setItems({});
    setLoading({});
    setErrors({});
  }, []);

  return { items, loading, errors, load, clear };
}
