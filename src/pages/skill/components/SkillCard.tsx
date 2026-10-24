// src/pages/skill/components/SkillCard.tsx
//
// 一张技能卡。信息优先级（从上到下）：
//   名字 > 状态 > skill_key > 描述 > A2A tags > 绑了哪些能力 > 最近更新时间
//
// 三件在卡片上必须表达出来、否则用户会误判的事：
//   1. **没绑能力 = 子 agent 拿不到任何工具**。空绑定不能只显示一句"暂无"，
//      那看着像"还没填"，实际是"这个 skill 跑起来啥也干不了"。
//   2. **已停用的能力等于没绑**。它仍出现在返回值里，所以要划掉而不是隐藏 ——
//      隐藏会让人以为绑定丢了。
//   3. **instructions 不进卡片**。那是注入子 agent 的提示词，可能很长，
//      也不该在列表里被扫到；只在抽屉里出现。
//
// tags 是唯一定位尴尬的字段：它在 SkillSummary 里（列表拿得到），但它是
// 发布用的元数据、主 agent 选技能**不读**。所以放在描述下面、用中性色小标签，
// 只做"这条属于什么主题"的扫读线索，绝不和能力标签抢同一层注意力
// （能力标签是蓝底实心，这里是无底描边灰字）。
import { Card, Tag, Tooltip, Typography } from 'antd';
import React from 'react';
import type { CapabilityRef, SkillSummary } from '../data';
import { formatUpdatedAt, SKILL_STATUS_META } from '../data';
import { useStyles } from '../style';

/** 卡片上最多摊几个能力标签 —— 再多就把卡片撑成两行、破坏网格节奏。 */
const MAX_CAP_TAGS = 4;

/** A2A tags 比能力次要，摊得更少。 */
const MAX_META_TAGS = 3;

export interface SkillCardProps {
  skill: SkillSummary;
  /** undefined = 还没加载到（列表接口不带 capabilities，见 service.ts 头注释） */
  capabilities?: CapabilityRef[];
  capsLoading?: boolean;
  /** 已停用的 capability id，用来把对应标签划掉 */
  inactiveIds: ReadonlySet<string>;
  onOpen: (skill: SkillSummary) => void;
}

const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  capabilities,
  capsLoading,
  inactiveIds,
  onOpen,
}) => {
  const { styles } = useStyles();
  const meta = SKILL_STATUS_META[skill.status];
  const caps = capabilities ?? [];
  const shown = caps.slice(0, MAX_CAP_TAGS);
  const overflow = caps.length - shown.length;

  const metaTags = skill.tags ?? [];
  const shownTags = metaTags.slice(0, MAX_META_TAGS);
  const tagOverflow = metaTags.length - shownTags.length;

  let capArea: React.ReactNode;
  if (capabilities === undefined) {
    capArea = (
      <span className={styles.capEmpty}>
        {capsLoading ? '能力绑定加载中…' : '能力绑定未加载'}
      </span>
    );
  } else if (caps.length === 0) {
    capArea = (
      <Tooltip title="绑定为空时，子 agent 解析不到任何 tool_key —— 它会被创建起来，但什么都调不了。">
        <span className={styles.capEmpty}>未绑能力 · 无工具可用</span>
      </Tooltip>
    );
  } else {
    capArea = (
      <>
        {shown.map((cap) => {
          const inactive = inactiveIds.has(cap.id);
          const tag = (
            <Tag
              key={cap.id}
              className={inactive ? styles.capTagOff : styles.capTag}
              color={inactive ? undefined : 'blue'}
            >
              {cap.name}
            </Tag>
          );
          return inactive ? (
            <Tooltip
              key={cap.id}
              title={`${cap.code} 已停用，解析时按未绑定处理`}
            >
              {tag}
            </Tooltip>
          ) : (
            tag
          );
        })}
        {overflow > 0 ? (
          <Tooltip
            title={caps
              .slice(MAX_CAP_TAGS)
              .map((cap) => `${cap.name}（${cap.code}）`)
              .join('、')}
          >
            <Tag className={styles.capTag}>+{overflow}</Tag>
          </Tooltip>
        ) : null}
      </>
    );
  }

  return (
    <Card
      hoverable
      className={styles.card}
      data-status={skill.status}
      onClick={() => onOpen(skill)}
    >
      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <Typography.Text className={styles.cardName} ellipsis={false}>
            {skill.name}
          </Typography.Text>
          <Tooltip title={meta.hint}>
            <Tag color={meta.tag} style={{ marginInlineEnd: 0 }}>
              {meta.label}
            </Tag>
          </Tooltip>
        </div>

        <Tooltip title="skill_key 创建后不可修改，task board 用它路由">
          <code className={styles.cardKey}>{skill.skill_key}</code>
        </Tooltip>

        <div className={styles.cardDesc}>{skill.description}</div>

        {metaTags.length > 0 ? (
          <div className={styles.tagRow}>
            {shownTags.map((tag) => (
              <Tag key={tag} className={styles.metaTag}>
                {tag}
              </Tag>
            ))}
            {tagOverflow > 0 ? (
              <Tooltip title={metaTags.slice(MAX_META_TAGS).join('、')}>
                <Tag className={styles.metaTag}>+{tagOverflow}</Tag>
              </Tooltip>
            ) : null}
          </div>
        ) : null}

        <div className={styles.capRow}>{capArea}</div>

        <div className={styles.cardFoot}>
          <span>更新于 {formatUpdatedAt(skill.updated_at)}</span>
          <span className={styles.cardFootMono}>
            {capabilities === undefined ? '—' : `${caps.length} 项能力`}
          </span>
        </div>
      </div>
    </Card>
  );
};

export default SkillCard;
