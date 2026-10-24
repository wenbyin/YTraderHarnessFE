// src/pages/document_retrieve/components/ScopeSelect.tsx
// 召回范围选择：关键字异步搜索下拉 + 下方已选列表（可单独移除）。
//
// 为什么不用多选 Select 的 tag 直接承载已选项：
// 定义可能有几百个，tag 挤在输入框里放不下 modality / 编码等信息，
// 也没法逐个精确移除。所以下拉只负责「选」，已选项单独成列。
import { CloseOutlined } from '@ant-design/icons';
import { Empty, Select, Space, Spin, Tag, Typography } from 'antd';
import React, { useEffect, useMemo, useState } from 'react';
import { retrievalTypeLabel } from '@/utils/retrievalType';
import type {
  DocumentTypeDefinitionDetail,
  DocumentTypeDefinitionResponse,
} from '../../document_type_definition/data';
import { listDocumentTypeDefinitions } from '../../document_type_definition/service';
import { PIPELINE_KEY_COLOR, unionRetrievalTypes } from '../data';
import { useStyles } from '../style';

interface ScopeSelectProps {
  value: string[];
  onChange: (ids: string[]) => void;
  /** 已选 / 搜索命中过的定义详情，由父级持有，结果卡片也要用它显示名称 */
  cache: Record<string, DocumentTypeDefinitionResponse>;
  onCache: (items: DocumentTypeDefinitionResponse[]) => void;
  /**
   * 已选定义的**详情**（含 retrievals），由父级持有。
   *
   * 上提到页面是因为「定向召回的可选项」要用同一份数据 —— 各自拉一遍会
   * 变成两次详情请求，而且两份并集可能因为到达时序不同短暂不一致。
   */
  details: Record<string, DocumentTypeDefinitionDetail>;
  /** 详情还在拉取中的 id。 */
  pendingIds: string[];
  disabled?: boolean;
}

const PAGE_SIZE = 20;

const ScopeSelect: React.FC<ScopeSelectProps> = ({
  value,
  onChange,
  cache,
  onCache,
  details,
  pendingIds,
  disabled,
}) => {
  const { styles } = useStyles();
  const [keyword, setKeyword] = useState('');
  const [options, setOptions] = useState<DocumentTypeDefinitionResponse[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // 简单防抖：贴合后端关键字检索的往返
    const timer = setTimeout(async () => {
      try {
        const res = await listDocumentTypeDefinitions({
          keyword: keyword.trim() || undefined,
          status: 'active',
          page: 1,
          page_size: PAGE_SIZE,
        });
        const items = res?.items ?? [];
        if (cancelled) return;
        setOptions(items);
        onCache(items);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [keyword, onCache]);

  const selectedOptions = useMemo(
    () =>
      options
        .filter((o) => !value.includes(o.document_type_definition_id))
        .map((o) => ({
          value: o.document_type_definition_id,
          label: (
            <Space size={6}>
              <Typography.Text strong>{o.name}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {o.type_key} · {o.modality_type}
              </Typography.Text>
            </Space>
          ),
        })),
    [options, value],
  );

  const add = (id: string) => {
    if (value.includes(id)) return;
    onChange([...value, id]);
    setKeyword('');
  };

  const remove = (id: string) => onChange(value.filter((x) => x !== id));

  return (
    <div>
      <Select
        showSearch={{ filterOption: false, onSearch: setKeyword }}
        disabled={disabled}
        loading={loading}
        placeholder="搜索文档类型定义：名称 / 编码 / 关键字"
        // 单选语义：选中后立即进入下方已选列表，输入框回到占位态
        value={undefined}
        onChange={add}
        options={selectedOptions}
        notFoundContent={
          loading ? (
            '搜索中…'
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="没有匹配的定义"
            />
          )
        }
        style={{ width: '100%' }}
      />

      {value.length ? (
        <div className={styles.selectedList}>
          {value.map((id) => {
            const item = cache[id];
            const detail = details[id];
            // 与「定向召回路径」同一份口径（过滤已删除的 + 去重）—
            // 两处各写一遍的话，标签上有、勾选项里没有，就成了对不上的鬼影。
            const paths = unionRetrievalTypes([id], details);
            return (
              <div className={styles.selectedItem} key={id}>
                <div className={styles.selectedMain}>
                  {item ? (
                    <Space size={6} wrap>
                      <Typography.Text strong>{item.name}</Typography.Text>
                      <Tag>{item.modality_type}</Tag>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {item.type_key}
                      </Typography.Text>
                    </Space>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {id}
                    </Typography.Text>
                  )}
                  {paths.length ? (
                    <Space size={4} wrap>
                      {paths.map((p) => (
                        // 与结果卡片同一套配色：同一个 retrieval_type 在
                        // 「已选定义」和「召回结果」里必须是同一个颜色。
                        <Tag key={p} color={PIPELINE_KEY_COLOR[p] ?? 'default'}>
                          {retrievalTypeLabel(p)}
                        </Tag>
                      ))}
                    </Space>
                  ) : detail ? (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      该定义未配置 retrieval
                    </Typography.Text>
                  ) : pendingIds.includes(id) ? (
                    <Space size={4}>
                      <Spin size="small" />
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11 }}
                      >
                        拉取检索路径…
                      </Typography.Text>
                    </Space>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {id}
                  </Typography.Text>
                </div>
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => remove(id)}
                  aria-label={`移除 ${item?.name ?? id}`}
                  style={{
                    border: 0,
                    background: 'none',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <CloseOutlined />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚未选择，请在上方搜索并添加"
          />
        </div>
      )}
    </div>
  );
};

export default ScopeSelect;
