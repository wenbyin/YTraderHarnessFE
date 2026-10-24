// src/pages/document/service.ts
// 对接 YTraderHarness 后端 /api/v1/documents（严格对齐 document.yaml 最新版）。
//
// 已移除的旧接口（不要再用）：
//  - GET  /api/v1/document-chunks
//  - POST /api/v1/document-versions/{id}/reprocess
//  - GET  /api/v1/documents/{id}?version_id=xxx
// 处理进度与 Chunk 暂用前端示例数据，见 ./progress.ts。
import { request } from '@umijs/max';

import type {
  CreateDocumentRequest,
  DocumentDetailResponse,
  DocumentListResponse,
  DocumentResponse,
  DocumentVersionDetailResponse,
  DocumentVersionListResponse,
  ListDocumentsParams,
  ListVersionsParams,
  UpdateDocumentRequest,
} from './data';

const API_BASE = '/api/v1/documents';

/** 分页查询 Document 列表。GET /api/v1/documents（后端固定 created_at 倒序） */
export async function listDocuments(params: ListDocumentsParams) {
  return request<DocumentListResponse>(API_BASE, {
    method: 'GET',
    params,
  });
}

/**
 * 获取 Document 详情。GET /api/v1/documents/{document_id}
 * 返回本体 + current_document_version + 全部 versions，前端不再传 version_id。
 */
export async function getDocument(documentId: string) {
  return request<DocumentDetailResponse>(`${API_BASE}/${documentId}`, {
    method: 'GET',
  });
}

/** 创建 Document（引用已上传的 file_id），自动创建 Version 1。POST /api/v1/documents */
export async function createDocument(body: CreateDocumentRequest) {
  return request<DocumentResponse>(API_BASE, {
    method: 'POST',
    data: body,
  });
}

/**
 * 更新 Document。PUT /api/v1/documents/{document_id}
 *
 * 三种语义，调用方按需传字段：
 *  - { file_id }                     追加一个新版本
 *  - { current_document_version_id } 切换当前生效版本
 *  - { title, metadata }             只改本体
 *
 * 409 场景：file_id 与 current_document_version_id 同时提供 /
 *          file_id 与当前版本 checksum 相同 / 版本不属于该 Document。
 */
export async function updateDocument(
  documentId: string,
  body: UpdateDocumentRequest,
) {
  return request<DocumentResponse>(`${API_BASE}/${documentId}`, {
    method: 'PUT',
    data: body,
  });
}

/** 逻辑删除 Document。DELETE /api/v1/documents/{document_id}（204） */
export async function deleteDocument(documentId: string) {
  return request<void>(`${API_BASE}/${documentId}`, {
    method: 'DELETE',
  });
}

/** 分页查询某个 Document 的版本（version_number 升序）。GET /api/v1/documents/{id}/versions */
export async function listDocumentVersions(
  documentId: string,
  params: ListVersionsParams = {},
) {
  return request<DocumentVersionListResponse>(
    `${API_BASE}/${documentId}/versions`,
    {
      method: 'GET',
      params,
    },
  );
}

/**
 * 获取单个版本详情（含 pipeline_config 快照）。
 * GET /api/v1/documents/{document_id}/versions/{document_version_id}
 */
export async function getDocumentVersion(
  documentId: string,
  documentVersionId: string,
) {
  return request<DocumentVersionDetailResponse>(
    `${API_BASE}/${documentId}/versions/${documentVersionId}`,
    {
      method: 'GET',
    },
  );
}
