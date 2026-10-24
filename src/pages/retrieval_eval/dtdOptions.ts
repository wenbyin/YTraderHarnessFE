// src/pages/retrieval_eval/dtdOptions.ts
// DTD（文档类型定义）选项的**页面级缓存 + 订阅**。
//
// 为什么需要它
// ------------
// 三个页面都要把 DTD 的 UUID 显示成可读的 type_key（列表页的「覆盖 DTD」标签、
// 详情页的 DTD 列、跑测页的 DTD 列），而 DTD 名字要请求
// `/api/v1/document-type-definitions` 才拿得到。
//
// 麻烦在于 **ProTable 的 `render` 是同步的** —— 数据没回来时没有办法 await。
// 所以只能"先用兜底文案渲染、数据到了再重渲染"，而这件事散在三个页面里写三遍
// 必然写成三种样子（谁先拉、失败怎么办、要不要显示 unknown）。
//
// 这里把它收成一个模块：一个模块级缓存 + 一个订阅 hook。
//
// ⚠️ `dtdLabel()` 读的是**模块级缓存**，不是 React 状态
// ---------------------------------------------------
// 也就是说：页面**必须**调用一次 `useDtdOptions()`，否则缓存更新时页面不会
// 重渲染，标签会一直停在兜底文案上。这是刻意的取舍 —— 让 render 保持同步、
// 调用方显式声明"我要这份数据"。
import { useEffect, useState } from 'react';
import type { DtdOption } from './data';
import { DTD_OPTIONS } from './mockData';
import { listDtdOptions } from './service';

let cache: DtdOption[] | null = null;
let inflight: Promise<DtdOption[]> | null = null;
const listeners = new Set<(list: DtdOption[]) => void>();

function publish(list: DtdOption[]) {
  cache = list;
  for (const fn of listeners) fn(list);
}

/**
 * 加载 DTD 选项（并发去重 + 结果缓存）。
 *
 * 失败**不抛**：DTD 名字只是展示层的信息，拉不到就退化成短 UUID，
 * 不该因为一个辅助请求把整页卡住或弹错误 —— 主数据请求失败时全局
 * errorHandler 已经会提示一次。
 */
export function loadDtdOptions(): Promise<DtdOption[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = listDtdOptions()
      .then((r) => {
        publish(r.items);
        return r.items;
      })
      .catch(() => {
        publish([]);
        return [];
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * DTD id → 可读标签。
 *
 * 三级兜底：真实缓存 → 演示数据表（mock 模式下 id 就是演示表里的那几个）→
 * 短 UUID。最后一级刻意**不是 'unknown'** —— 真实后端里 id 是随机 UUID，
 * 统一显示 unknown 会让一屏标签长得一模一样，连"是不是同一个 DTD"都看不出来。
 */
export function dtdLabel(id: string): string {
  if (!id) return '-';
  const hit = (cache ?? DTD_OPTIONS).find(
    (d) => d.document_type_definition_id === id,
  );
  return hit?.type_key ?? `${id.slice(0, 8)}…`;
}

/**
 * 订阅 DTD 选项。首次挂载触发一次加载；加载完成后所有订阅者一起重渲染。
 */
export function useDtdOptions(): DtdOption[] {
  const [list, setList] = useState<DtdOption[]>(cache ?? []);

  useEffect(() => {
    listeners.add(setList);
    loadDtdOptions().then(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  return list;
}
