// src/pages/document_retrieve/components/RouteFilter.tsx
// 定向召回路径（retrieval_types）：已选定义里所有 retrieval_type 的**并集**，
// 默认全部勾选，可逐条取消。
//
// 这个控件唯一真正危险的状态是「一条都没勾」：
//   · 契约 minItems:1，**空数组会被 422 拒绝**；
//   · 而「不传」等于「该 DTD 配的全部路」—— 与「什么都不要」正好相反。
// 所以这里不提供任何「发请求时兜底」：要么拦住不发起（index.tsx 的 run），
// 要么就如实把「0 路」摆出来。悄悄退化成不传，等于把「什么都不查」翻译成
// 「全查」，比直接报错危险得多。
//
// 只画**并集**而不是按定义分组：retrieval_types 在契约里是平铺的一维数组，
// 后端拿它跟每个 DTD 实际配的 retrieval 求交集，并不区分「这一路是谁的」。
// 前端画出请求表达不了的分组，就是在骗人。
import { Checkbox, Space, Tooltip, Typography } from 'antd';
import React from 'react';
import { retrievalTypeLabel } from '@/utils/retrievalType';
import { pathDotClass, useStyles } from '../style';

interface RouteFilterProps {
  /** 并集（已去重）。详情还没拉回来时是空数组 —— 那就是「当前无法筛选」。 */
  types: string[];
  /** 每一路出自哪几个定义，hover 时说明。没有就退化成不提示。 */
  owners?: Record<string, string[]>;
  /** 被**取消**勾选的那几路 —— 不是「选中的」，见 data.ts 的 excludedTypes。 */
  excluded: string[];
  onChange: (excluded: string[]) => void;
  /** 详情还在拉取中。 */
  pending?: boolean;
}

const RouteFilter: React.FC<RouteFilterProps> = ({
  types,
  owners,
  excluded,
  onChange,
  pending,
}) => {
  const { styles } = useStyles();

  const effective = types.filter((t) => !excluded.includes(t));

  const onChecked = (checked: (string | number | boolean)[]) => {
    const stillOn = new Set(checked.map((v) => String(v)));
    onChange(types.filter((t) => !stillOn.has(t)));
  };

  return (
    <div className={styles.routeFilter}>
      <div className={styles.routeFilterHead}>
        <Space size={6}>
          <Typography.Text strong>定向召回路径</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            retrieval_types
          </Typography.Text>
        </Space>
        {types.length ? (
          <Space size={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {`已选 ${effective.length} / ${types.length}`}
            </Typography.Text>
            {/* 只给「全选」，不给「全不选」：后者是个必然 422 的状态，
                专门摆一个按钮去制造它没意义。 */}
            {excluded.length ? (
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={() => onChange([])}
              >
                全选
              </Typography.Link>
            ) : null}
          </Space>
        ) : null}
      </div>

      {types.length ? (
        <Checkbox.Group
          value={effective}
          onChange={onChecked}
          options={types.map((type) => {
            const from = owners?.[type] ?? [];
            return {
              value: type,
              label: (
                // 出处要写清楚：交集语义下勾中「只有某一个定义配了的那一路」时，
                // 其余定义会一条都召不到。结果条数变少必须能归因到路径上。
                <Tooltip
                  title={
                    from.length
                      ? `${from.length} 个定义配了这一路：${from.join('、')}`
                      : type
                  }
                >
                  {/* 圆点保留每路的颜色身份，与全页其它路径标签同一个映射 */}
                  <span>
                    <span
                      className={`${styles.pathDot} ${pathDotClass(styles, type)}`}
                    />
                    {retrievalTypeLabel(type)}
                  </span>
                </Tooltip>
              ),
            };
          })}
        />
      ) : pending ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          正在拉取已选定义的 retrieval 配置…
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已选定义没有启用中的 retrieval —— 这一轮召不回任何东西。
        </Typography.Text>
      )}
    </div>
  );
};

export default RouteFilter;
