// src/pages/file/utils.ts
import {
  CodeOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileUnknownOutlined,
  FileZipOutlined,
} from '@ant-design/icons';

import type { FileListItem } from './data';
import { downloadFile } from './service';

/** 按 1024 进制把字节数格式化为人类可读文本。 */
export const formatBytes = (bytes?: number | null): string => {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[index]}`;
};

interface FileTypeMeta {
  icon: React.ComponentType;
  color: string;
  /** antd Tag 语义色 */
  tag: 'red' | 'green' | 'blue' | 'purple' | 'orange' | 'cyan' | 'default';
}

const TYPE_META: Record<string, FileTypeMeta> = {
  pdf: { icon: FilePdfOutlined, color: '#ff4d4f', tag: 'red' },
  csv: { icon: FileExcelOutlined, color: '#52c41a', tag: 'green' },
  xls: { icon: FileExcelOutlined, color: '#52c41a', tag: 'green' },
  xlsx: { icon: FileExcelOutlined, color: '#52c41a', tag: 'green' },
  json: { icon: CodeOutlined, color: '#722ed1', tag: 'purple' },
  py: { icon: CodeOutlined, color: '#13c2c2', tag: 'cyan' },
  png: { icon: FileImageOutlined, color: '#1677ff', tag: 'blue' },
  jpg: { icon: FileImageOutlined, color: '#1677ff', tag: 'blue' },
  jpeg: { icon: FileImageOutlined, color: '#1677ff', tag: 'blue' },
  gif: { icon: FileImageOutlined, color: '#1677ff', tag: 'blue' },
  zip: { icon: FileZipOutlined, color: '#fa8c16', tag: 'orange' },
  gz: { icon: FileZipOutlined, color: '#fa8c16', tag: 'orange' },
  tar: { icon: FileZipOutlined, color: '#fa8c16', tag: 'orange' },
  txt: { icon: FileTextOutlined, color: '#595959', tag: 'default' },
  log: { icon: FileTextOutlined, color: '#595959', tag: 'default' },
  md: { icon: FileTextOutlined, color: '#595959', tag: 'default' },
};

const FALLBACK_META: FileTypeMeta = {
  icon: FileUnknownOutlined,
  color: '#595959',
  tag: 'default',
};

/** 取文件扩展名（小写，不含点）。 */
export const getFileExt = (fileName?: string | null): string => {
  if (!fileName) return '';
  const index = fileName.lastIndexOf('.');
  return index === -1 ? '' : fileName.slice(index + 1).toLowerCase();
};

/** 按扩展名返回图标、主色与 Tag 语义色。 */
export const getFileTypeMeta = (fileName?: string | null): FileTypeMeta =>
  TYPE_META[getFileExt(fileName)] ?? FALLBACK_META;

/** 把 UUID 截断为前 8 位，用于列表紧凑展示。 */
export const shortId = (id?: string | null): string =>
  id ? `${id.slice(0, 8)}…` : '-';

/**
 * 批量下载：串行触发，避免并发弹出多个下载框被浏览器拦截。
 * 单条失败不中断整体流程。
 */
export const downloadMany = async (rows: FileListItem[]) => {
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await downloadFile(row.file_id, row.file_name);
    } catch {
      /* 单个文件失败不影响其余文件 */
    }
  }
};
