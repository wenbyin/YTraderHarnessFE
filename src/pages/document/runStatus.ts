// src/pages/document/runStatus.ts
// 版本列表里每行要显示「最新一次运行的状态」。
// document.yaml 的版本摘要不含运行信息，只能按版本回查 pipeline-runs 列表；
// 这里取 page_size=1（只拿最新一条的 status，不拉节点明细），并做缓存与并发去重。
//
// 轮询场景下不需要重新走这个批量接口：拿到 /pipeline-runs/{id}/progress 后
// 直接用 setVersionRunStatus 把那一行改写掉即可（同时更新缓存）。
import { useCallback, useEffect, useState } from 'react';

import { listVersionPipelineRuns, type RunStatus } from './pipeline';

const cache = new Map<string, RunStatus | null>();
const inflight = new Map<string, Promise<RunStatus | null>>();

/** 清空缓存（重跑/新增版本后调用）。 */
export function clearRunStatusCache() {
  cache.clear();
}

export function fetchLatestRunStatus(
  documentId: string,
  documentVersionId: string,
): Promise<RunStatus | null> {
  const key = `${documentId}|${documentVersionId}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = listVersionPipelineRuns(documentId, documentVersionId, {
    page: 1,
    page_size: 1,
  })
    .then((response) => {
      const status = response.items?.[0]?.status ?? null;
      cache.set(key, status);
      return status;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}

/**
 * 批量订阅多个版本的最新运行状态。
 *
 * 返回值：
 *  - runStatusMap        版本 id → 最新运行状态（null 表示无运行记录，UI 显示「—」）
 *  - setVersionRunStatus 轮询时把某一行改成最新状态（同时写回缓存，避免下次进入页面又拉一次旧值）
 *
 * 没有运行记录时值为 null。
 */
export function useVersionRunStatuses(
  documentId: string | undefined,
  versionIds: string[],
) {
  const [map, setMap] = useState<Record<string, RunStatus | null>>({});
  const key = versionIds.join(',');

  useEffect(() => {
    if (!documentId || versionIds.length === 0) {
      setMap({});
      return;
    }
    let cancelled = false;
    // 先同步已有缓存，避免列表加载完成到请求返回之间的空窗
    const seeded: Record<string, RunStatus | null> = {};
    for (const versionId of versionIds) {
      const cached = cache.get(`${documentId}|${versionId}`);
      if (cached !== undefined) seeded[versionId] = cached;
    }
    if (Object.keys(seeded).length > 0) setMap(seeded);

    Promise.all(
      versionIds.map(async (versionId) => ({
        versionId,
        status: await fetchLatestRunStatus(documentId, versionId),
      })),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, RunStatus | null> = {};
      for (const item of results) next[item.versionId] = item.status;
      setMap(next);
    });

    return () => {
      cancelled = true;
    };
    // key 已覆盖 versionIds 的内容变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, key]);

  /** 轮询回调：单行改写，值相同时不触发重渲染。 */
  const setVersionRunStatus = useCallback(
    (versionId: string, status: RunStatus | null) => {
      if (documentId) cache.set(`${documentId}|${versionId}`, status);
      setMap((prev) =>
        prev[versionId] === status ? prev : { ...prev, [versionId]: status },
      );
    },
    [documentId],
  );

  return { runStatusMap: map, setVersionRunStatus };
}
