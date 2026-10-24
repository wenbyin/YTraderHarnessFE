// src/pages/document/fileInfo.ts
// 版本摘要只返回 file_id，文件名 / 大小 / MIME 需要回查 File Service。
// 这里做一层带缓存的封装：同一个 file_id 在页面生命周期内只请求一次。
import { useEffect, useState } from 'react';

import type { FileListItem } from '../file/data';
import { getFile } from '../file/service';

const cache = new Map<string, FileListItem>();

const inflight = new Map<string, Promise<FileListItem | null>>();

/** 查询文件信息（带缓存与并发去重）。失败时返回 null，不抛错。 */
export function fetchFileInfo(fileId: string): Promise<FileListItem | null> {
  const cached = cache.get(fileId);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(fileId);
  if (pending) return pending;

  const task = getFile(fileId)
    .then((file) => {
      cache.set(fileId, file);
      return file;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(fileId);
    });

  inflight.set(fileId, task);
  return task;
}

/** 在组件里订阅文件信息。 */
export function useFileInfo(fileId?: string | null) {
  const known = fileId ? cache.get(fileId) : undefined;
  const [file, setFile] = useState<FileListItem | null>(known ?? null);
  const [loading, setLoading] = useState(Boolean(fileId) && !known);

  useEffect(() => {
    if (!fileId) {
      setFile(null);
      setLoading(false);
      return;
    }
    const cached = cache.get(fileId);
    if (cached) {
      setFile(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchFileInfo(fileId).then((result) => {
      if (cancelled) return;
      setFile(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  return { file, loading };
}

/** 字节数 → 可读文本。 */
export function formatBytes(size?: number | null): string {
  if (size == null) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}
