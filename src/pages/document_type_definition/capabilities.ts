// src/pages/document_type_definition/capabilities.ts
// 处理器能力目录：GET /api/v1/document-processor-capabilities
// 严格对齐 YTraderHarness app/services/document/processor_capability.yaml。
//
// 契约要点（yaml 里写死的，别违反）：
//  1. processor_key 永不复用，会被冻结进历史快照；**不要硬编码清单**（yaml 故意没给 enum）。
//  2. config_schema 不是冻结值（给能力加参数是常规变更）→ 只做会话级缓存，不落 localStorage。
//  3. 返回顺序由后端反射发现顺序决定 → 前端按 processor_key 自行排序。
//  4. 单查 404 时前端要回退显示原始 key，不能丢弃配置。
//  5. selector（modality_type / support_suffix / is_default）**只有 role=loader 才有**。
//
// 目录是「只读的能力清单」，与 /document-processors（配置资源）不是一个东西：
// 前者回答「平台有哪些实现」，后者是「这个定义选了哪个实现 + 参数」。

import { request } from '@umijs/max';
import { useEffect, useState } from 'react';

import type { JsonSchema } from '@/components/SchemaForm';

/** 能力在写入流水线里承担的阶段。取值与后端 ProcessorRole 一致。 */
export type ProcessorRole =
  | 'loader'
  | 'normalize'
  | 'clean'
  | 'enrich_metadata'
  | 'chunk'
  | 'chunk_enrich'
  | 'embed';

/** 仅 role=loader 出现：运行时「按什么把 loader 选出来」的谓词。 */
export interface ProcessorCapabilitySelector {
  modality_type: string;
  /** 服务端已归一化：小写 + 带前导点，例如 ['.txt']。 */
  support_suffix: string[];
  /** 同一后缀有多个候选 loader 时，是否为默认选中的那个。 */
  is_default: boolean;
}

export interface ProcessorCapabilityEntry {
  processor_key: string;
  role: ProcessorRole;
  selector?: ProcessorCapabilitySelector;
  /** JSON Schema（draft 2020-12）= pydantic v2 model_json_schema() 原生输出。 */
  config_schema: JsonSchema;
}

export interface ProcessorCapabilityCatalogResponse {
  items: ProcessorCapabilityEntry[];
  /** 派生值：本次返回 items 中 role=loader 条目的 support_suffix 去重并集（受过滤影响）。 */
  support_suffix: string[];
  total: number;
}

const API_BASE = '/api/v1/document-processor-capabilities';

export interface ListProcessorCapabilitiesParams {
  role?: ProcessorRole;
  /** 只作用于 role=loader。 */
  modality_type?: string;
  /** 只作用于 role=loader，例如 .txt 或 txt，大小写不敏感。 */
  file_extension?: string;
}

/**
 * 拉取能力目录。不分页。
 * 用 skipErrorHandler：目录拉取失败要降级（下拉退回自由输入 + 提示），不该弹全局错误。
 */
export async function listProcessorCapabilities(
  params?: ListProcessorCapabilitiesParams,
) {
  return request<ProcessorCapabilityCatalogResponse>(API_BASE, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}

// ---------------- 会话级缓存 ----------------
// 多个卡片同时渲染时只发一次请求；进程内共享，不落持久化存储（config_schema 不是冻结值）。
const cache = new Map<ProcessorRole, ProcessorCapabilityEntry[]>();
const inflight = new Map<
  ProcessorRole,
  Promise<ProcessorCapabilityEntry[] | null>
>();

async function loadRole(
  role: ProcessorRole,
): Promise<ProcessorCapabilityEntry[] | null> {
  const hit = inflight.get(role);
  if (hit) return hit;
  const p = listProcessorCapabilities({ role })
    .then((res) => {
      const items = [...(res?.items ?? [])].sort((a, b) =>
        a.processor_key.localeCompare(b.processor_key),
      );
      cache.set(role, items);
      inflight.delete(role);
      return items;
    })
    .catch(() => {
      inflight.delete(role);
      return null; // 失败：交给调用方降级
    });
  inflight.set(role, p);
  return p;
}

export interface CapabilitiesState {
  items: ProcessorCapabilityEntry[];
  /** 首次加载中（缓存命中时为 false）。 */
  loading: boolean;
  /** 拉取失败：调用方应降级，不要阻塞用户编辑。 */
  failed: boolean;
}

/** 按 role 取能力目录（会话级缓存）。 */
export function useProcessorCapabilities(
  role: ProcessorRole,
): CapabilitiesState {
  const [state, setState] = useState<CapabilitiesState>(() => ({
    items: cache.get(role) ?? [],
    loading: !cache.has(role),
    failed: false,
  }));

  useEffect(() => {
    let alive = true;
    if (cache.has(role)) {
      setState({ items: cache.get(role) ?? [], loading: false, failed: false });
      return;
    }
    setState({ items: [], loading: true, failed: false });
    loadRole(role).then((items) => {
      if (!alive) return;
      setState({
        items: items ?? [],
        loading: false,
        failed: items === null,
      });
    });
    return () => {
      alive = false;
    };
  }, [role]);

  return state;
}

/**
 * 把能力目录组装成下拉选项。**只包含目录里真实存在的条目** ——
 * 当前值不在目录时不要往里塞「（目录中未找到）」兜底项（否则目录正常时
 * 下拉里永远多一条脏选项）；这种兜底只允许出现在「目录拉取失败」的
 * 降级分支里，目录可用时让用户直接换选即可。
 */
export function buildCapabilityOptions(
  items: ProcessorCapabilityEntry[],
): { label: string; value: string }[] {
  return items.map((c) => {
    const suffix = c.selector?.support_suffix?.length
      ? `　${c.selector.support_suffix.join(' ')}`
      : '';
    const dft = c.selector?.is_default ? '　默认' : '';
    return {
      label: `${c.processor_key}${suffix}${dft}`,
      value: c.processor_key,
    };
  });
}
