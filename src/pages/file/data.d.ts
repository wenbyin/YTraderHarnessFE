// src/pages/file/data.ts
// 类型定义严格对齐 YTraderHarness 后端
// app/services/file/domain/schemas/file.py 与 enum.py

/** File 生命周期状态。对应后端 FileStatus 枚举。 */
export type FileStatus = 'active' | 'deleted';

/**
 * 列表项。对应后端 FileListItem。
 * 注意：后端刻意不在列表返回 storage_key / storage_backend / metadata，
 * 需要完整信息时走 GET /files/{file_id}。
 */
export interface FileListItem {
  file_id: string;
  tenant_id: string | null;
  file_name: string;
  content_type: string | null;
  /** 单位 Byte */
  file_size: number;
  /** SHA-256 */
  checksum: string;
  status: FileStatus;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 文件详情。对应后端 FileResponse（FileListItem 的超集）。 */
export interface FileDetail extends FileListItem {
  storage_backend: string;
  storage_key: string;
  metadata: Record<string, any>;
}

/** 分页列表响应。对应后端 ListFilesResponse。 */
export interface ListFilesResponse {
  items: FileListItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** 逻辑删除响应。对应后端 DeleteFileResponse。 */
export interface DeleteFileResponse {
  file_id: string;
  status: string;
  deleted_at: string;
}

/**
 * 列表查询参数。对应后端 ListFilesRequest / GET /files 的 query 参数。
 * 时间参数为闭区间，序列化为 ISO 8601 字符串。
 */
export interface ListFilesParams {
  status?: FileStatus;
  file_name?: string;
  /** MIME 前缀匹配，如 'image/' 匹配所有图片 */
  content_type?: string;
  uploaded_by?: string;
  created_from?: string;
  created_to?: string;
  page?: number;
  page_size?: number;
}
