// src/pages/retrieval_eval/components/DtdTagList.tsx
// DTD 标签的**唯一**渲染实现：单个标签截断 + tooltip，多个标签折叠成 +N。
//
// 为什么需要它
// ------------
// `dtdLabel()` 返回的是 `type_key`（`COMPANY_EVENT_RISK_COMPLIANCE` 这种长标识）。
// 一张列表里「覆盖 DTD」可能有 8 个 —— 直接把 8 个标签平铺进单元格，会让**这一行
// 的高度由这一列决定**：别的列都是一个短值，它却有 8 行，整行 150px 高、表格
// 看着头重脚轻；而且标签宽度超过列宽时会溢出到邻列上去。
//
// 表格里只平铺 `max`（默认 1）个、其余折进 `+N`，行高就回到单行；
// 要全量就悬浮/点击那个 `+N`（Popover 列出全部，不打折扣）。
//
// ⚠️ 别在页面里再手写一遍 `<Tag color="blue">{dtdLabel(id)}</Tag>` —— 那样的写法
// 不会截断、也不会折叠，上面两个问题会逐个回来。
import { Popover, Tag, Tooltip, Typography } from 'antd';
import React from 'react';
import { dtdLabel } from '../dtdOptions';

const { Text } = Typography;

/** 单个 DTD 标签：超宽截断，悬浮看全称。 */
export const DtdTag: React.FC<{ id: string; maxWidth?: number }> = ({
  id,
  maxWidth,
}) => {
  const label = dtdLabel(id);
  // 拿不到名字时 dtdLabel 会退化成长 UUID —— 仍要能悬浮看全，否则用户只看到
  // 一串被截断的 hex，无从判断这是哪个类型。
  return (
    <Tooltip title={label}>
      <Tag
        color="blue"
        style={{
          margin: 0,
          maxWidth,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'inline-block',
          verticalAlign: 'bottom',
        }}
      >
        {label}
      </Tag>
    </Tooltip>
  );
};

interface DtdTagListProps {
  ids: string[];
  /** 平铺几个，其余折进 `+N`。表格里用 1（行高单行），页头这类宽松处可用 3。 */
  max?: number;
  /** 单个标签的最大宽度（px）；不传则不截断。 */
  tagMaxWidth?: number;
}

/**
 * DTD 标签组。数量为 0 时显示 `—`（与其它「缺失值」列的写法一致，
 * 不显示空标签 —— 空标签看着像一个真实取值）。
 */
const DtdTagList: React.FC<DtdTagListProps> = ({
  ids,
  max = 1,
  tagMaxWidth,
}) => {
  if (ids.length === 0) return <Text type="secondary">—</Text>;

  const shown = ids.slice(0, Math.max(1, max));
  const rest = ids.slice(shown.length);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: '100%',
      }}
    >
      {shown.map((id) => (
        <DtdTag key={id} id={id} maxWidth={tagMaxWidth} />
      ))}
      {rest.length > 0 && (
        <Popover
          placement="bottom"
          // click 与 hover **都**要：表格里 hover 要精确停在小小的 `+N` 上，
          // 点一下更确定（也让这段能被单测触发 —— 本仓没有 user-event，
          // hover 类浮层在 jsdom 里打不开）。
          trigger={['click', 'hover']}
          title={`覆盖 ${ids.length} 个 DTD`}
          content={
            // 全量列表：这里给**完整**名字（上面那个标签是截断的），
            // 所以它是「被折叠掉的信息」的出口，不是装饰。
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 320,
                overflowY: 'auto',
                maxWidth: 420,
              }}
            >
              {ids.map((id) => (
                <DtdTag key={id} id={id} />
              ))}
            </div>
          }
        >
          <Tag
            style={{
              margin: 0,
              cursor: 'pointer',
              display: 'inline-block',
              verticalAlign: 'bottom',
            }}
          >
            +{rest.length}
          </Tag>
        </Popover>
      )}
    </span>
  );
};

export default DtdTagList;
