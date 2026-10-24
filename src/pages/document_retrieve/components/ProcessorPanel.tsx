// src/pages/document_retrieve/components/ProcessorPanel.tsx
// RetrieveProcessor 运行时覆盖面板。
//
// 契约边界（改这里前请回看 document_retrieve.yaml）：
//   - 只有 Fusioner / Filter / Reranker / Cutter 可以被覆盖，Recaller 不对外暴露。
//   - 每段外层开关 = 是否覆盖；不覆盖时该段整个不传，继承所选 RetrieveProcessor。
//   - Fusioner / Filter / Reranker 有 enabled；**Cutter 没有 enabled**，只能不传或改 top_k。
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Collapse,
  Input,
  InputNumber,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import React from 'react';

import { retrievalTypeLabel } from '@/utils/retrievalType';
import {
  type CutterPanel,
  type FilterPanel,
  type FusionerPanel,
  type MetadataRow,
  RERANKER_MODEL_PRESET,
  type RerankerPanel,
  type RerankerType,
} from '../data';
import { useStyles } from '../style';

import ExtraSwitch from './ExtraSwitch';

interface ProcessorPanelProps {
  fusioner: FusionerPanel;
  filter: FilterPanel;
  reranker: RerankerPanel;
  cutter: CutterPanel;
  onChange: (
    patch: Partial<{
      fusioner: FusionerPanel;
      filter: FilterPanel;
      reranker: RerankerPanel;
      cutter: CutterPanel;
    }>,
  ) => void;
}

const ProcessorPanel: React.FC<ProcessorPanelProps> = ({
  fusioner,
  filter,
  reranker,
  cutter,
  onChange,
}) => {
  const { styles } = useStyles();
  const setMetadataRows = (rows: MetadataRow[]) =>
    onChange({ filter: { ...filter, metadataRows: rows } });

  const patchRow = (index: number, patch: Partial<MetadataRow>) =>
    setMetadataRows(
      filter.metadataRows.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    );

  const items = [
    {
      key: 'fusioner',
      label: (
        <Space size={8}>
          <Typography.Text strong>Fusioner</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {!fusioner.on
              ? '继承默认（字段不传）'
              : !fusioner.enabled
                ? 'enabled: false（显式关闭）'
                : fusioner.type === 'rrf'
                  ? `rrf · rrf_k=${fusioner.rrfK} · top_k=${fusioner.topK}`
                  : `weighted_sum · top_k=${fusioner.topK}`}
          </Typography.Text>
        </Space>
      ),
      extra: (
        <ExtraSwitch
          checked={fusioner.on}
          onChange={(on) => onChange({ fusioner: { ...fusioner, on } })}
        />
      ),
      children: (
        <Space vertical size={12} style={{ width: '100%' }}>
          <Space size={8}>
            <Typography.Text type="secondary">enabled</Typography.Text>
            <Switch
              size="small"
              checked={fusioner.enabled}
              onChange={(enabled) =>
                onChange({ fusioner: { ...fusioner, enabled } })
              }
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              false = 显式关闭融合
            </Typography.Text>
          </Space>

          <Space size={8}>
            <Typography.Text type="secondary">type</Typography.Text>
            <Segmented
              size="small"
              value={fusioner.type}
              onChange={(v) =>
                onChange({
                  fusioner: { ...fusioner, type: v as 'rrf' | 'weighted_sum' },
                })
              }
              options={[
                { label: 'rrf', value: 'rrf' },
                { label: 'weighted_sum', value: 'weighted_sum' },
              ]}
            />
          </Space>

          <Space size={8}>
            <Typography.Text type="secondary">top_k</Typography.Text>
            <InputNumber
              size="small"
              min={1}
              max={5000}
              value={fusioner.topK}
              onChange={(v) =>
                onChange({ fusioner: { ...fusioner, topK: v ?? 50 } })
              }
            />
          </Space>

          {fusioner.type === 'rrf' ? (
            <Space size={8} style={{ width: '100%' }}>
              <Typography.Text type="secondary">rrf_k</Typography.Text>
              <Slider
                min={1}
                max={200}
                value={fusioner.rrfK}
                style={{ width: 180 }}
                onChange={(v) =>
                  onChange({ fusioner: { ...fusioner, rrfK: Number(v) } })
                }
              />
              <Typography.Text style={{ fontSize: 12 }}>
                {fusioner.rrfK}
              </Typography.Text>
            </Space>
          ) : (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                weights：按召回来源分配权重（0 表示不参与融合）
              </Typography.Text>
              <Space vertical size={4} style={{ width: '100%', marginTop: 6 }}>
                {Object.keys(fusioner.weights).map((key) => (
                  <Space size={8} key={key}>
                    <Typography.Text style={{ fontSize: 12, width: 88 }}>
                      {retrievalTypeLabel(key)}
                    </Typography.Text>
                    <Slider
                      min={0}
                      max={2}
                      step={0.1}
                      value={fusioner.weights[key]}
                      style={{ width: 170 }}
                      onChange={(v) =>
                        onChange({
                          fusioner: {
                            ...fusioner,
                            weights: { ...fusioner.weights, [key]: Number(v) },
                          },
                        })
                      }
                    />
                    <Typography.Text style={{ fontSize: 12 }}>
                      {fusioner.weights[key].toFixed(1)}
                    </Typography.Text>
                  </Space>
                ))}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                契约只说 key 是「服务端定义的召回来源标识」，未给枚举。 此处按
                pipeline_keys 的取值域（retrieval_type）列出，待后端确认。
              </Typography.Text>
            </div>
          )}
        </Space>
      ),
    },
    {
      key: 'filter',
      label: (
        <Space size={8}>
          <Typography.Text strong>Filter</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {!filter.on
              ? '继承默认（字段不传）'
              : !filter.enabled
                ? 'enabled: false（显式关闭）'
                : `阈值 ${filter.scoreThreshold ?? '—'}${filter.documentIds.length ? ` · ${filter.documentIds.length} 个 doc` : ''}${filter.documentVersionIds.length ? ` · ${filter.documentVersionIds.length} 个 version` : ''}`}
          </Typography.Text>
        </Space>
      ),
      extra: (
        <ExtraSwitch
          checked={filter.on}
          onChange={(on) => onChange({ filter: { ...filter, on } })}
        />
      ),
      children: (
        <Space vertical size={12} style={{ width: '100%' }}>
          <Space size={8}>
            <Typography.Text type="secondary">enabled</Typography.Text>
            <Switch
              size="small"
              checked={filter.enabled}
              onChange={(enabled) =>
                onChange({ filter: { ...filter, enabled } })
              }
            />
          </Space>

          <Space size={8} align="center">
            <Typography.Text type="secondary">score_threshold</Typography.Text>
            <Slider
              min={0}
              max={1}
              step={0.01}
              style={{ width: 150 }}
              value={filter.scoreThreshold ?? 0}
              onChange={(v) =>
                onChange({ filter: { ...filter, scoreThreshold: Number(v) } })
              }
            />
            <Typography.Text style={{ fontSize: 12 }}>
              {(filter.scoreThreshold ?? 0).toFixed(2)}
            </Typography.Text>
            <Button
              size="small"
              type="link"
              onClick={() =>
                onChange({ filter: { ...filter, scoreThreshold: null } })
              }
            >
              不限制
            </Button>
          </Space>

          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              document_ids（UUID，回车分隔）
            </Typography.Text>
            <Select
              mode="tags"
              size="small"
              style={{ width: '100%', marginTop: 4 }}
              placeholder="粘贴 document_id 后回车，可填多个"
              value={filter.documentIds}
              tokenSeparators={[',', ' ', '\n']}
              onChange={(v) =>
                onChange({ filter: { ...filter, documentIds: v as string[] } })
              }
              open={false}
            />
          </div>

          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              document_version_ids（UUID，回车分隔）
            </Typography.Text>
            <Select
              mode="tags"
              size="small"
              style={{ width: '100%', marginTop: 4 }}
              placeholder="精确到版本级：粘贴 document_version_id 后回车"
              value={filter.documentVersionIds}
              tokenSeparators={[',', ' ', '\n']}
              onChange={(v) =>
                onChange({
                  filter: { ...filter, documentVersionIds: v as string[] },
                })
              }
              open={false}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              与 document_ids 是两个独立条件，可同时生效；两者都不填 =
              不限定文档范围。
            </Typography.Text>
          </div>

          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              metadata（精确匹配，语义由实现扩展）
            </Typography.Text>
            <Space vertical size={6} style={{ width: '100%', marginTop: 4 }}>
              {filter.metadataRows.map((row, index) => (
                <Space size={6} key={`md-${index.toString()}`}>
                  <Input
                    size="small"
                    placeholder="key，如 company_code"
                    style={{ width: 140 }}
                    value={row.key}
                    onChange={(e) => patchRow(index, { key: e.target.value })}
                  />
                  <Input
                    size="small"
                    placeholder="value"
                    style={{ width: 130 }}
                    value={row.value}
                    onChange={(e) => patchRow(index, { value: e.target.value })}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      setMetadataRows(
                        filter.metadataRows.length === 1
                          ? [{ key: '', value: '' }]
                          : filter.metadataRows.filter((_, i) => i !== index),
                      )
                    }
                  />
                </Space>
              ))}
              <Button
                size="small"
                type="link"
                icon={<PlusOutlined />}
                onClick={() =>
                  setMetadataRows([
                    ...filter.metadataRows,
                    { key: '', value: '' },
                  ])
                }
              >
                添加条件
              </Button>
            </Space>
          </div>
        </Space>
      ),
    },
    {
      key: 'reranker',
      label: (
        <Space size={8}>
          <Typography.Text strong>Reranker</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {!reranker.on
              ? '继承默认（字段不传）'
              : !reranker.enabled
                ? 'enabled: false（显式关闭）'
                : `${reranker.type} · top_n=${reranker.topN}`}
          </Typography.Text>
        </Space>
      ),
      extra: (
        <ExtraSwitch
          checked={reranker.on}
          onChange={(on) => onChange({ reranker: { ...reranker, on } })}
        />
      ),
      children: (
        <Space vertical size={12} style={{ width: '100%' }}>
          <Space size={8}>
            <Typography.Text type="secondary">enabled</Typography.Text>
            <Switch
              size="small"
              checked={reranker.enabled}
              onChange={(enabled) =>
                onChange({ reranker: { ...reranker, enabled } })
              }
            />
          </Space>

          <Space size={8}>
            <Typography.Text type="secondary">type</Typography.Text>
            <Segmented
              size="small"
              value={reranker.type}
              onChange={(v) => {
                const type = v as RerankerType;
                onChange({
                  reranker: {
                    ...reranker,
                    type,
                    model: RERANKER_MODEL_PRESET[type],
                  },
                });
              }}
              options={[
                { label: 'cross_encoder', value: 'cross_encoder' },
                { label: 'llm', value: 'llm' },
                { label: 'custom', value: 'custom' },
              ]}
            />
          </Space>

          <Space size={8}>
            <Typography.Text type="secondary">model</Typography.Text>
            <Input
              size="small"
              style={{ width: 220 }}
              value={reranker.model}
              onChange={(e) =>
                onChange({ reranker: { ...reranker, model: e.target.value } })
              }
            />
          </Space>

          <Space size={8}>
            <Typography.Text type="secondary">top_n</Typography.Text>
            <InputNumber
              size="small"
              min={1}
              max={5000}
              value={reranker.topN}
              onChange={(v) =>
                onChange({ reranker: { ...reranker, topN: v ?? 50 } })
              }
            />
          </Space>
        </Space>
      ),
    },
    {
      key: 'cutter',
      label: (
        <Space size={8}>
          <Typography.Text strong>Cutter</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {!cutter.on
              ? '继承默认（字段不传）'
              : `top_k=${cutter.topK}${cutter.maxContentChars ? ` · ${cutter.maxContentChars} 字符` : ''}`}
          </Typography.Text>
        </Space>
      ),
      extra: (
        <ExtraSwitch
          checked={cutter.on}
          onChange={(on) => onChange({ cutter: { ...cutter, on } })}
        />
      ),
      children: (
        <Space vertical size={12} style={{ width: '100%' }}>
          <Space size={8}>
            <Typography.Text type="secondary">
              top_k（最终结果条数上限）
            </Typography.Text>
            <InputNumber
              size="small"
              min={1}
              max={1000}
              value={cutter.topK}
              onChange={(v) =>
                onChange({ cutter: { ...cutter, topK: v ?? 10 } })
              }
            />
          </Space>
          <Space size={8}>
            <Typography.Text type="secondary">
              max_content_chars
            </Typography.Text>
            <InputNumber
              size="small"
              min={1}
              max={200000}
              value={cutter.maxContentChars ?? undefined}
              placeholder="不限制"
              onChange={(v) =>
                onChange({ cutter: { ...cutter, maxContentChars: v ?? null } })
              }
            />
          </Space>
          <Tag color="default">
            契约中 Cutter 没有 enabled 字段，只能不传或改 top_k
          </Tag>
        </Space>
      ),
    },
  ];

  // ghost：antd 会去掉 Collapse 自带的底色与外框，改由外层容器染色 ——
  // 这样不用去和 `.ant-collapse-item` 的选择器权重较劲，也能避免
  // 「白色 Card 里再套一层白底折叠面板」的分层消失。
  return (
    <div className={styles.overrideGroup}>
      <Collapse ghost size="small" items={items} />
    </div>
  );
};

export default ProcessorPanel;
