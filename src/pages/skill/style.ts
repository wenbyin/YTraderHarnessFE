// src/pages/skill/style.ts
//
// 卡片页的视觉规则（和 tool / agent_stress 同一套分层）：
//   L0 页面底色 = colorBgLayout
//   L1 卡片     = colorBgContainer（antd Card 自带）
//   L2 卡内小面板（key 芯片、空绑定框）= colorFillTertiary + 虚线/无边框
//
// 两条刻意的取舍：
//   1. **状态色只落在卡片左侧那条竖线上**。卡片里已经有 badge、能力标签在抢
//      注意力，整张卡再染色的话，"状态"和"选中"就分不清了。
//   2. **描述固定三行高**（-webkit-line-clamp + min-height）。卡片放进网格后
//      高度不一致会让第二行参差，扫读成本立刻上去。
//
// 注意：注释写在 css 模板**内部**时不能出现反引号。
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  // ---------------- 工具栏 ----------------
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${token.marginSM}px;
    margin-bottom: ${token.margin}px;
  `,

  toolbarPush: css`
    margin-left: auto;
  `,

  keyword: css`
    width: 240px;
  `,

  capFilter: css`
    width: 220px;
  `,

  /** 模拟数据横幅 / 列表被 page_size 截断的提示，都要和工具栏留出距离 */
  mockAlert: css`
    margin-bottom: ${token.marginSM}px;
  `,

  gridNote: css`
    display: block;
    margin-top: ${token.marginSM}px;
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
  `,

  // ---------------- 卡片网格 ----------------
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: ${token.marginMD}px;
    align-items: stretch;

    @media (max-width: 720px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,

  card: css`
    height: 100%;
    cursor: pointer;
    border-inline-start: 3px solid ${token.colorBorderSecondary};
    transition:
      box-shadow ${token.motionDurationMid} ${token.motionEaseInOut},
      border-color ${token.motionDurationMid} ${token.motionEaseInOut};

    .ant-card-body {
      height: 100%;
      padding: ${token.padding}px ${token.padding}px ${token.paddingSM}px;
    }

    &[data-status='ACTIVE'] {
      border-inline-start-color: ${token.colorSuccess};
    }
    &[data-status='DRAFT'] {
      border-inline-start-color: ${token.colorWarning};
    }
    &[data-status='DISABLED'] {
      border-inline-start-color: ${token.colorBorder};
    }

    /* 停用的技能整体降一档对比度：它还在列表里（要能编辑回来），
       但不该和启用的抢同一层注意力。 */
    &[data-status='DISABLED'] .ant-card-body {
      opacity: 0.72;
    }
  `,

  cardBody: css`
    display: flex;
    flex-direction: column;
    gap: ${token.marginXS}px;
    height: 100%;
    min-width: 0;
  `,

  cardHead: css`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${token.marginXS}px;
  `,

  cardName: css`
    display: -webkit-box;
    overflow: hidden;
    color: ${token.colorText};
    font-size: ${token.fontSizeLG}px;
    font-weight: 600;
    line-height: 1.4;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  `,

  cardKey: css`
    align-self: flex-start;
    max-width: 100%;
    overflow: hidden;
    padding: 1px 6px;
    border-radius: ${token.borderRadiusSM}px;
    background: ${token.colorFillTertiary};
    color: ${token.colorTextSecondary};
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
    white-space: nowrap;
    text-overflow: ellipsis;
  `,

  cardDesc: css`
    display: -webkit-box;
    overflow: hidden;
    color: ${token.colorTextSecondary};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    min-height: 4.8em;
  `,

  capRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    /* 把页脚压到底：卡片高度由网格拉齐，短内容的卡片不能把页脚吊在半空 */
    margin-top: auto;
    padding-top: ${token.marginXS}px;
  `,

  /**
   * A2A tags 行。
   *
   * 与 capRow 的区别必须一眼看得出来：能力标签是**蓝底实心**（它决定子 agent
   * 能调什么），tags 是**灰字描边**（只是发布元数据）。同色系会让"绑定"和
   * "标签"混成一件事。
   */
  tagRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: ${token.marginXXS}px;
  `,

  metaTag: css`
    /* 不许被 flex 压扁：默认 flex-shrink:1 会把长 tag 挤成 "retrie…"，
       那比换行难看得多 —— 一行放不下就整体折到下一行。 */
    flex: 0 0 auto;
    max-width: 100%;
    overflow: hidden;
    margin-inline-end: 0;
    border-style: dashed;
    border-color: ${token.colorBorder};
    background: transparent;
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM - 1}px;
    line-height: 18px;
    white-space: nowrap;
    text-overflow: ellipsis;
  `,

  capTag: css`
    margin-inline-end: 0;
  `,

  /** 已停用的能力：留着可见但划掉 —— "绑了等于没绑"这件事必须看得见。 */
  capTagOff: css`
    margin-inline-end: 0;
    opacity: 0.6;
    text-decoration: line-through;
  `,

  capEmpty: css`
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border: 1px dashed ${token.colorBorder};
    border-radius: ${token.borderRadiusSM}px;
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
    line-height: 20px;
  `,

  cardFoot: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginXS}px;
    padding-top: ${token.marginXS}px;
    border-top: 1px solid ${token.colorSplit};
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
  `,

  cardFootMono: css`
    font-variant-numeric: tabular-nums;
  `,

  // ---------------- 抽屉 ----------------
  sectionTitle: css`
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: ${token.marginXS}px;
    margin: ${token.marginLG}px 0 ${token.marginSM}px;
    color: ${token.colorText};
    font-size: ${token.fontSize}px;
    font-weight: 600;
  `,

  sectionHint: css`
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
    font-weight: 400;
  `,

  monoInput: css`
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.75;
  `,

  /** 抽屉底部的只读元信息：id / 创建 / 更新，弱化到不参与决策。 */
  metaBox: css`
    margin-top: ${token.marginLG}px;
    padding: ${token.paddingSM}px ${token.padding}px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.9;
  `,

  metaKey: css`
    margin-inline-end: 6px;
    color: ${token.colorTextSecondary};
  `,

  metaValue: css`
    font-family: ${token.fontFamilyCode};
  `,

  drawerFooter: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginSM}px;
  `,

  drawerFooterRight: css`
    display: flex;
    gap: ${token.marginXS}px;
  `,

  drawerAlert: css`
    margin-bottom: ${token.marginSM}px;
  `,

  // ---------------- 能力选择器 ----------------
  /**
   * 能力树的滚动面板 —— 与工具页 ClassEditor 的 treePanel 同一套。
   *
   * 两个页面绑的是**同一棵** capability 树，长得不一样会让人以为是两套数据。
   */
  treePanel: css`
    max-height: 320px;
    overflow: auto;
    padding: ${token.paddingXS}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
  `,

  /** 正文里嵌一个字段名（`capability_id` 这种）—— 不用 code 标签，字体跳得太厉害 */
  monoKey: css`
    color: ${token.colorTextSecondary};
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
  `,

  /** 空下拉里的操作提示（tags 编辑器没有候选项，不能什么都不显示） */
  selectHint: css`
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
  `,

  option: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginSM}px;
  `,

  optionCode: css`
    color: ${token.colorTextTertiary};
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
  `,

  /** 能力绑定的"后果"提示：一行，别做成大段说明。 */
  bindHint: css`
    margin-top: ${token.marginXS}px;
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.7;
  `,

  /**
   * 一个能力都没绑。
   *
   * 用警示色而不是灰字：这不是"还没填完"，是"这个 skill 启用后什么都干不了"。
   * 但也不用 Alert —— 抽屉里已经有足够的控件了，再加一块牌子就吵。
   */
  bindWarn: css`
    margin-top: ${token.marginXS}px;
    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorWarningBg};
    color: ${token.colorWarningText};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.7;
  `,
}));
