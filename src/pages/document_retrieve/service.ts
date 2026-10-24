// src/pages/document_retrieve/service.ts
// 对接 YTraderHarness 后端 /api/v1/documents/retrieve（严格对齐 document_retrieve.yaml）。
//
// 语义提醒（后端不做的部分，前端不要替它做）：
//   - 一次调用 = 一轮召回。服务端不会自动扩召回、改写查询、重试或进入 agent 循环。
//   - Recaller 是内部实现，请求体里没有它的位置。
import { request } from '@umijs/max';

import type { DocumentRetrieveRequest, DocumentRetrieveResponse } from './data';

const API_BASE = '/api/v1/documents/retrieve';

/**
 * 执行一轮召回。POST /api/v1/documents/retrieve
 *
 * 失败语义（由调用方决定如何展示）：
 *   - 400 / 422 请求体不合法
 *   - 404 一个或多个 document_type_definition_id 不存在
 *   - 500 召回处理内部错误
 */
export async function retrieveDocuments(body: DocumentRetrieveRequest) {
  return request<DocumentRetrieveResponse>(API_BASE, {
    method: 'POST',
    data: body,
  });
}
