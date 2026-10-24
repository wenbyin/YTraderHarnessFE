// src/pages/document_type_definition/service.ts
// 对接 YTraderHarness 后端 /api/v1/document-type-definitions（严格对齐 document.yaml 最新版）。
// 子项（processor / retrieval / binding）通过父级级联全量替换语义保存，不提供子路径 DELETE。
import { request } from '@umijs/max';

import type {
  DocumentTypeDefinitionCreateRequest,
  DocumentTypeDefinitionDetail,
  DocumentTypeDefinitionListResponse,
  DocumentTypeDefinitionUpdateRequest,
  ListDocumentTypeDefinitionsParams,
} from './data';

const API_BASE = '/api/v1/document-type-definitions';

/** 分页查询文档类型定义列表。GET /api/v1/document-type-definitions */
export async function listDocumentTypeDefinitions(
  params: ListDocumentTypeDefinitionsParams,
) {
  return request<DocumentTypeDefinitionListResponse>(API_BASE, {
    method: 'GET',
    params,
  });
}

/** 获取文档类型定义详情（含 processors/retrievals/bindings）。GET /api/v1/document-type-definitions/{id} */
export async function getDocumentTypeDefinition(id: string) {
  return request<DocumentTypeDefinitionDetail>(`${API_BASE}/${id}`, {
    method: 'GET',
  });
}

/** 新建文档类型定义（可级联创建 processors/retrievals/bindings）。POST /api/v1/document-type-definitions */
export async function createDocumentTypeDefinition(
  body: DocumentTypeDefinitionCreateRequest,
) {
  return request<DocumentTypeDefinitionDetail>(API_BASE, {
    method: 'POST',
    data: body,
  });
}

/**
 * 更新文档类型定义（基本信息 + 级联子项全量替换）。
 * PUT /api/v1/document-type-definitions/{id}
 * 必须携带 revision（乐观锁）；processors / retrievals / bindings 为数组时全量替换，
 * null 表示不触碰对应子表。子项按自然键（file_extension / retrieval_type）识别，不传 id。
 */
export async function updateDocumentTypeDefinition(
  id: string,
  body: DocumentTypeDefinitionUpdateRequest,
) {
  return request<DocumentTypeDefinitionDetail>(`${API_BASE}/${id}`, {
    method: 'PUT',
    data: body,
  });
}

/** 逻辑删除文档类型定义。DELETE /api/v1/document-type-definitions/{id}（204） */
export async function deleteDocumentTypeDefinition(id: string) {
  return request<void>(`${API_BASE}/${id}`, { method: 'DELETE' });
}
