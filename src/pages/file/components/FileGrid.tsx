// src/pages/file/components/FileGrid.tsx
import { Checkbox, Space, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import React from 'react';

import type { FileListItem } from '../data';
import { useStyles } from '../style';
import { formatBytes, getFileTypeMeta, shortId } from '../utils';

interface FileGridProps {
  dataSource: readonly FileListItem[];
  selectedRowKeys: React.Key[];
  onSelectionChange: (keys: React.Key[], rows: FileListItem[]) => void;
  onOpenDetail: (fileId: string) => void;
  onDownload: (record: FileListItem) => void;
  onDelete: (record: FileListItem) => void;
}

/** 表格视图之外的网格视图，与 tableViewRender 配合使用。 */
const FileGrid: React.FC<FileGridProps> = ({
  dataSource,
  selectedRowKeys,
  onSelectionChange,
  onOpenDetail,
  onDownload,
  onDelete,
}) => {
  const { styles, cx } = useStyles();

  const toggle = (record: FileListItem) => {
    const checked = selectedRowKeys.includes(record.file_id);
    const nextKeys = checked
      ? selectedRowKeys.filter((key) => key !== record.file_id)
      : [...selectedRowKeys, record.file_id];
    const nextRows = dataSource.filter((item) =>
      nextKeys.includes(item.file_id),
    );
    onSelectionChange(nextKeys, nextRows);
  };

  return (
    <div className={styles.grid}>
      {dataSource.map((record) => {
        const meta = getFileTypeMeta(record.file_name);
        const IconComponent = meta.icon;
        const selected = selectedRowKeys.includes(record.file_id);

        return (
          <div
            key={record.file_id}
            className={cx(styles.gridCard, selected && styles.gridCardSelected)}
            onClick={() => onOpenDetail(record.file_id)}
          >
            <div
              className={styles.gridCheckbox}
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={selected}
                onChange={() => toggle(record)}
                aria-label={`选择 ${record.file_name}`}
              />
            </div>

            <div className={styles.gridStatus}>
              <Tag color={record.status === 'active' ? 'success' : 'default'}>
                {record.status}
              </Tag>
            </div>

            <div className={styles.gridIcon} style={{ color: meta.color }}>
              <IconComponent />
            </div>

            <div className={styles.gridName} title={record.file_name}>
              {record.file_name}
            </div>

            <div className={styles.gridMeta}>
              <span>{formatBytes(record.file_size)}</span>
              <span>·</span>
              <span>{dayjs(record.created_at).format('MM/DD HH:mm')}</span>
            </div>

            <div className={styles.gridFooter}>
              <span title={record.uploaded_by ?? undefined}>
                {shortId(record.uploaded_by)}
              </span>
              <Space size={12}>
                <Typography.Link
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload(record);
                  }}
                >
                  下载
                </Typography.Link>
                <Typography.Link
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(record);
                  }}
                >
                  删除
                </Typography.Link>
              </Space>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default FileGrid;
