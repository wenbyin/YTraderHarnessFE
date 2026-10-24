// src/pages/retrieval_eval/style.ts
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  sectionTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
    margin: 0 0 ${token.margin}px;
    padding-left: 8px;
    border-left: 3px solid ${token.colorPrimary};
    line-height: 1.2;
  `,

  card: css`
    background: ${token.colorBgContainer};
    border-radius: ${token.borderRadiusLG}px;
  `,

  /** 指标总览的数值卡 */
  metricValue: css`
    font-size: 26px;
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  `,

  metricLabel: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
    margin-top: 4px;
  `,

  /** 等宽字体，用于 chunk_id / hash */
  mono: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
  `,

  /** trace 的时间线竖轴 */
  traceRail: css`
    position: relative;
    padding-left: 4px;
  `,

  /** 高亮 gold 候选行的底色 */
  goldRow: css`
    background: ${token.colorWarningBg};
  `,

  /** 被丢弃候选行的底色 */
  droppedRow: css`
    background: ${token.colorErrorBg};
  `,

  /** 阶段卡片之间的连接箭头 */
  stageArrow: css`
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${token.colorTextQuaternary};
    font-size: 18px;
    padding: ${token.paddingXS}px 0;
  `,

  footerBar: css`
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: ${token.marginSM}px;
    margin-top: ${token.marginLG}px;
  `,

  /** 窗口切分示意的小方块 */
  windowBox: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 4px;
    margin: 2px;
    border-radius: ${token.borderRadiusSM}px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  `,

  // ---------- target chunk 原文卡 ----------
  //
  // 这一组是 document 页版本抽屉里 `ChunkRow` 的同款（同一个响应体、同一个
  // 读者），刻意逐条对齐而不是"长得差不多就行"：两处都在讲同一块 chunk，
  // 视觉一旦分叉，"这是同一块吗"就得多花一次比对。改这里时那边也要看。

  /** 整张卡的壳。灰底，让里面的白段浮起来（抽屉白 → 卡灰 → 段白）。 */
  chunkRow: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillTertiary};
    overflow: hidden;
    transition: all 0.2s;

    &:hover {
      border-color: ${token.colorPrimaryBorder};
      box-shadow: ${token.boxShadowSecondary};
    }
  `,

  /** 卡头：比卡身再深一档，读起来才像「头」，不然只是一根线。 */
  chunkHeader: css`
    display: flex;
    align-items: center;
    gap: ${token.marginSM}px;
    padding: ${token.paddingSM}px ${token.padding}px;
    background: ${token.colorFillSecondary};
    border-bottom: 1px solid ${token.colorBorder};
    flex-wrap: wrap;
  `,

  chunkIndex: css`
    font-family: ${token.fontFamilyCode};
    font-weight: 600;
    color: ${token.colorPrimary};
  `,

  /** 段与段之间靠 gap 分开，不再靠虚线 —— 每段自己是个白块。 */
  chunkBody: css`
    display: flex;
    flex-direction: column;
    gap: ${token.marginSM}px;
    padding: ${token.padding}px;
  `,

  chunkSection: css`
    padding: ${token.paddingSM}px ${token.padding}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
  `,

  /** 段头：左标题，右侧放该段自己的操作（展开 / 收起）。 */
  chunkSectionHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginXS}px;
    margin-bottom: 6px;
  `,

  chunkSectionTitle: css`
    font-size: 12.5px;
    font-weight: 600;
    color: ${token.colorTextSecondary};
    line-height: 1.2;
    padding-left: 6px;
    border-left: 3px solid ${token.colorBorder};
  `,

  /**
   * 正文。`pre-wrap` 是必须的：chunk 正文自带换行与 markdown 缩进，
   * 交给 HTML 折叠会把「# 标题」「> 数据来源」挤成一整行，读起来面目全非。
   */
  chunkContent: css`
    font-size: 13.5px;
    line-height: 1.7;
    color: ${token.colorText};
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    max-height: 420px;
    overflow: auto;
  `,

  /** 等宽的值（偏移区间、id） */
  monoValue: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12.5px;
  `,

  metaBlock: css`
    border-top: 1px dashed ${token.colorBorderSecondary};
    padding-top: ${token.marginSM}px;
  `,

  metaLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 4px;
    letter-spacing: 0.02em;
  `,

  /**
   * 深色的 JSON 块。**刻意不用 token 底色** —— 它要的是一块"终端"，跟正文
   * 拉开距离。底色写死就得补一条边，否则深色主题下整块会糊进背景。
   */
  metaJson: css`
    margin: 0;
    padding: 8px 10px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    background: #1f1f1f;
    color: #d4d4d4;
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.6;
    overflow: auto;
    max-height: 220px;
  `,

  /**
   * 轮次卡片里的一「步」= 一个流水线阶段，**一行一个**。
   *
   * 用 grid 而不是 flex：阶段名占固定一列，参数多于一行时（覆盖过滤展开后是 4 个控件，
   * 抽屉里一行只放得下 3 个）**换行落在参数列**，不会跑到阶段名下面去 ——
   * "这一步有哪些参数"的主从关系在任何宽度下都成立。
   */
  stageRow: css`
    display: grid;
    grid-template-columns: 104px 1fr;
    column-gap: ${token.marginSM}px;
    align-items: start;
    padding: ${token.paddingXS}px 0;

    & + & {
      border-top: 1px dashed ${token.colorBorderSecondary};
    }
  `,

  /** 轮次名那一行：它是这轮的标识，不是流水线的一步 → 居中对齐、不加序号。 */
  stageRowIdentity: css`
    align-items: center;
    padding-bottom: ${token.paddingSM}px;
  `,

  stageName: css`
    display: flex;
    align-items: center;
    gap: 6px;
    /* 与 Form.Item 的 label 行同高，阶段名才和控件标签落在同一条线上 */
    min-height: 22px;
    padding-top: 1px;
    font-size: ${token.fontSizeSM}px;
    font-weight: 500;
    color: ${token.colorTextSecondary};
    white-space: nowrap;
  `,

  stageNameMuted: css`
    font-weight: 400;
    color: ${token.colorTextTertiary};
  `,

  /** 阶段序号：小圆片，纯顺序提示，不抢控件的注意力。 */
  stageNo: css`
    flex: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: ${token.colorFillSecondary};
    color: ${token.colorTextSecondary};
    font-size: 11px;
    line-height: 18px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  `,

  /**
   * 一步的参数区。
   *
   * `align-items: flex-end` 是为了开关：Switch 只有 22px 高，InputNumber 是 32px，
   * 默认 stretch/flex-start 会让开关比输入框高出一截（原来那套 `Space align="end"`）。
   *
   * 但只对齐**外框**还不够：antd 的控件槽（`.ant-form-item-control-input`）32px，
   * 里面的 Switch 是贴顶排的 —— 外框底边对齐了，开关本体仍比输入框高 5px。
   * 所以槽里再居中一次，开关才会和同排的输入框落在同一条水平线上。
   */
  stageControls: css`
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: ${token.marginSM}px;
    min-width: 0;

    .ant-form-item-control-input {
      display: flex;
      align-items: center;
    }

    .ant-form-item-control-input-content {
      width: 100%;
    }
  `,
}));
