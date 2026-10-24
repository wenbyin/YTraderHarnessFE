// src/pages/tool/components/ProcessorLibrary.tsx
//
// 处理器库（左栏）—— GET /api/v1/processors 的**只读**呈现。
//
// 三个由契约决定的形态：
//
//  1. **只读**。处理器实现是代码里注册的（进程内注册表），管理面造不出新处理器 ——
//     所以这里没有任何"新建"，只有"挂到链上"这一个动作（→ 按钮）。
//
//  2. **同一个 key 可以挂 N 次，但 AROUND 只能挂一次**。
//     后端 validate_onion 以 processor_key 作为 AROUND 的区间标识，重复会折叠区间；
//     BEFORE / AFTER 不参与洋葱 —— 「隐私过滤前置滤一遍、后置再滤一遍」是合法用法。
//     所以已挂载**不禁用** →，只显示「已挂 ×N」；AROUND 撞车交给 validateChain 拦。
//
//  3. **registry_available = false 的挂不上**。实现已从注册表消失，
//     POST / PUT 会被 404 / 409 拒，提前禁用比事后报错好。
//
// 条目高度固定在 34px、标签一律**全称**（BEFORE / AFTER / AROUND、SYNC / ASYNC）——
// 缩成首字母（B / A / S）看着紧凑，但没人知道 B 是 BEFORE 还是"Blocked"。

import { ArrowRightOutlined, SearchOutlined } from '@ant-design/icons';
import { Empty, Input, Skeleton, Tooltip } from 'antd';
import React, { useMemo, useState } from 'react';
import { useEnumLabels } from '../enumLabels';
import { PROCESSOR_TYPES, type ProcessorDefinition } from '../processorChain';
import { useStyles } from '../style';

interface ProcessorLibraryProps {
  defs: ProcessorDefinition[];
  /** key → 已挂在链上的实例数（含停用的） */
  usedCounts: Map<string, number>;
  loading?: boolean;
  disabled?: boolean;
  onAdd: (def: ProcessorDefinition, srcEl: HTMLElement | null) => void;
}

const ProcessorLibrary: React.FC<ProcessorLibraryProps> = ({
  defs,
  usedCounts,
  loading,
  disabled,
  onAdd,
}) => {
  const { styles } = useStyles();
  const labels = useEnumLabels();
  const [keyword, setKeyword] = useState('');

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return defs;
    return defs.filter(
      (d) =>
        d.name.toLowerCase().includes(kw) ||
        d.key.toLowerCase().includes(kw) ||
        (d.description ?? '').toLowerCase().includes(kw),
    );
  }, [defs, keyword]);

  const grouped = useMemo(
    () =>
      PROCESSOR_TYPES.map((t) => ({
        type: t,
        list: filtered.filter((d) => d.processor_type === t),
      })).filter((g) => g.list.length),
    [filtered],
  );

  if (loading) {
    return <Skeleton active paragraph={{ rows: 8 }} />;
  }

  if (!defs.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="注册表里没有处理器 —— 处理器实现由代码注册，接口 /api/v1/processors 未返回数据"
      />
    );
  }

  return (
    <>
      <Input
        size="small"
        allowClear
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
        placeholder="按名称 / key 过滤"
      />

      <div className={styles.libScroll}>
        {!grouped.length ? (
          <div className={styles.chainEmpty}>没有匹配的处理器</div>
        ) : null}

        {grouped.map((g) => (
          <div key={g.type} className={styles.libGroup}>
            <div className={styles.libGroupTitle}>
              <span className={styles.chainTag} data-ptype={g.type}>
                {labels.processorType(g.type)}
              </span>
              <span className={styles.libGroupKey}>{g.type}</span>
            </div>

            {g.list.map((def) => {
              const usedCount = usedCounts.get(def.key) ?? 0;
              // 只有"实现失联"才禁 →；已挂载不禁 —— 同一个 key 可挂 N 次
              // （前置 + 后置各一遍），只有 AROUND 撞车要拦，那交给 validateChain
              const unusable = def.registry_available === false;
              const tip = unusable
                ? '实现未注册（registry_available = false）—— 挂上去会被后端拒绝'
                : `挂到处理链（默认 ${
                    def.supported_hooks.includes('AROUND')
                      ? 'AROUND'
                      : def.supported_hooks[0]
                  }）${usedCount ? `；已挂 ${usedCount} 次，可继续挂（AROUND 除外）` : ''}`;

              return (
                <Tooltip key={def.key} title={tip} mouseEnterDelay={0.4}>
                  <div
                    data-lib-item="1"
                    className={[
                      styles.libItem,
                      unusable ? styles.libItemDisabled : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className={styles.libName}>{def.name}</span>
                    <span className={styles.libKey}>{def.key}</span>
                    {usedCount ? (
                      <span className={styles.chainTag} data-used="1">
                        已挂 ×{usedCount}
                      </span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <span className={styles.libTags}>
                      {def.supported_hooks.map((h) => (
                        <span
                          key={h}
                          className={styles.chainTag}
                          data-hook={h}
                          title={h}
                        >
                          {labels.hook(h)}
                        </span>
                      ))}
                    </span>
                    <span className={styles.libSep} />
                    <span className={styles.libTags}>
                      {def.supported_execution_modes.map((m) => (
                        <span
                          key={m}
                          className={styles.chainTag}
                          data-mode={m}
                          title={m}
                        >
                          {labels.mode(m)}
                        </span>
                      ))}
                    </span>
                    <button
                      type="button"
                      className={styles.arrowBtn}
                      disabled={unusable || disabled}
                      title={tip}
                      onClick={(e) =>
                        onAdd(
                          def,
                          (e.currentTarget as HTMLElement).closest<HTMLElement>(
                            '[data-lib-item]',
                          ),
                        )
                      }
                    >
                      <ArrowRightOutlined />
                    </button>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
};

export default ProcessorLibrary;
