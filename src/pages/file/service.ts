// src/pages/file/service.ts
// 对接 YTraderHarness 后端 /api/v1/files
import { request } from '@umijs/max';

import { authHeaders } from '@/services/auth';
import type {
  DeleteFileResponse,
  FileDetail,
  ListFilesParams,
  ListFilesResponse,
} from './data';

const API_BASE = '/api/v1/files';

/**
 * 分页查询文件列表。
 * GET /api/v1/files
 * 排序由后端固定为 created_at 倒序，前端不传排序字段。
 */
export async function listFiles(params: ListFilesParams) {
  return request<ListFilesResponse>(API_BASE, {
    method: 'GET',
    params,
  });
}

/**
 * 获取文件完整元数据（含 storage_key / storage_backend / metadata）。
 * GET /api/v1/files/{file_id}
 */
export async function getFile(fileId: string) {
  return request<FileDetail>(`${API_BASE}/${fileId}`, {
    method: 'GET',
  });
}

/**
 * 逻辑删除文件。
 * DELETE /api/v1/files/{file_id}
 */
export async function deleteFile(fileId: string) {
  return request<DeleteFileResponse>(`${API_BASE}/${fileId}`, {
    method: 'DELETE',
  });
}

/**
 * 上传文件。
 * POST /api/v1/files
 *
 * 后端签名为 upload: UploadFile = FastAPIFile(...)，
 * 因此 multipart 字段名必须是 "upload"。
 *
 * 使用 XMLHttpRequest 而非 request：
 *   1. 需要上传进度事件；
 *   2. 避免 umi-request 按 json/form 序列化 FormData，
 *      由浏览器自动生成 multipart boundary 最稳妥。
 *
 * ⚠️ 手动补 Authorization
 * ----------------------
 *   它绕开了 umi 的 request，所以**也绕开了请求拦截器** —— 不自己挂 token
 *   就是 401（后端 /api/v1 下所有接口都要 bearer，见 user.yaml）。
 *   这里只挂请求头，不做 401 刷新重试：那是拦截器统一负责的事，两处都做会打起来。
 */
export function uploadFile(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<FileDetail> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('upload', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE);
    for (const [key, value] of Object.entries(authHeaders())) {
      xhr.setRequestHeader(key, value);
    }

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as FileDetail);
        } catch {
          reject(new Error('上传成功，但解析响应失败'));
        }
        return;
      }
      reject(new Error(extractErrorMessage(xhr, '上传失败')));
    });

    xhr.addEventListener('error', () =>
      reject(new Error('网络错误，上传失败')),
    );
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));

    xhr.send(formData);
  });
}

/**
 * 下载文件原始内容。
 * GET /api/v1/files/{file_id}/content
 *
 * 后端以 Content-Disposition: attachment 返回二进制流，
 * 这里直接落 blob 并触发浏览器下载。
 *
 * ⚠️ 同样绕开了 request，要手动带 Authorization（理由见 uploadFile）。
 *    这里不能走 umi 的 request：它会把响应当 JSON 解，而这是二进制流。
 */
export async function downloadFile(fileId: string, fileName: string) {
  const response = await fetch(`${API_BASE}/${fileId}/content`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 从 FastAPI 的错误响应中提取 detail 字段（422 时 detail 为数组）。 */
function extractErrorMessage(xhr: XMLHttpRequest, fallback: string): string {
  try {
    const body = JSON.parse(xhr.responseText);
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((item) => item?.msg ?? JSON.stringify(item)).join('；');
    }
  } catch {
    /* 非 JSON 响应，走兜底文案 */
  }
  return `${fallback}（HTTP ${xhr.status}）`;
}
