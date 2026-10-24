// src/pages/document/typeMap.ts
// Document 只返回 document_type_definition_id，列表 / 详情要显示类型名需要回查。
// 类型定义数量有限，这里一次性拉取后建 id → {name, type_key} 映射并缓存。
import { useEffect, useState } from 'react';

import { listDocumentTypeDefinitions } from '../document_type_definition/service';

export interface TypeInfo {
  name: string;
  type_key: string;
}

const cache = new Map<string, TypeInfo>();

let inflight: Promise<Map<string, TypeInfo>> | null = null;

export function fetchTypeMap(): Promise<Map<string, TypeInfo>> {
  if (inflight) return inflight;
  const task = listDocumentTypeDefinitions({ page: 1, page_size: 100 })
    .then((res) => {
      (res.items ?? []).forEach((item) => {
        cache.set(item.document_type_definition_id, {
          name: item.name,
          type_key: item.type_key,
        });
      });
      return cache;
    })
    .catch(() => cache)
    .finally(() => {
      inflight = null;
    });
  inflight = task;
  return task;
}

/** 在组件里订阅类型映射。 */
export function useTypeMap() {
  const [map, setMap] = useState<Map<string, TypeInfo>>(cache);

  useEffect(() => {
    let cancelled = false;
    fetchTypeMap().then((result) => {
      if (!cancelled) setMap(new Map(result));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return map;
}

/** 取展示名：优先「名称（type_key）」，未命中时回落短 ID。 */
export function typeLabel(
  map: Map<string, TypeInfo>,
  id?: string | null,
): string {
  if (!id) return '—';
  const info = map.get(id);
  if (info) return `${info.name}（${info.type_key}）`;
  return `${id.slice(0, 8)}…`;
}
