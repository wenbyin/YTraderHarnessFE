// src/pages/agent_stress/style.ts
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  mono: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
  `,

  /** 卡片之间统一的竖向节奏；比裸 Row gutter 更稳（换行时也有间距） */
  section: css`
    margin-bottom: ${token.marginMD}px;
  `,

  /** 指标卡：数字要能一眼扫，标签弱化成辅助信息 */
  metricCard: css`
    height: 100%;
    .ant-card-body {
      padding: ${token.paddingSM}px ${token.padding}px;
    }
  `,

  metricValue: css`
    font-size: 22px;
    font-weight: 600;
    line-height: 1.25;
    font-variant-numeric: tabular-nums;
    color: ${token.colorText};
  `,

  metricUnit: css`
    font-size: 12px;
    font-weight: 400;
    color: ${token.colorTextTertiary};
    margin-left: 4px;
  `,

  /** 成功/失败/超时三个数字要能一眼区分，别指望用户读标签 */
  metricValueSuccess: css`
    color: ${token.colorSuccess};
  `,

  metricValueError: css`
    color: ${token.colorError};
  `,

  metricValueWarning: css`
    color: ${token.colorWarning};
  `,

  metricLabel: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};
    margin-bottom: 2px;
  `,

  /** cursor 分页条：表格下面一行，左右分布 */
  listFooter: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginSM}px;
    margin-top: ${token.marginSM}px;
  `,

  /** 运行配置里的 JSON 原文 */
  codeBlock: css`
    margin: 0;
    padding: ${token.paddingSM}px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorTextSecondary};
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.6;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  `,

  /** 详情页顶部：状态 + 进度 + 关键时间 */
  hero: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${token.marginSM}px ${token.margin}px;
  `,

  heroMeta: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};

    & + & {
      padding-left: ${token.margin}px;
      border-left: 1px solid ${token.colorSplit};
    }
  `,

  /** 集层「聚合中」的说明条，语气要弱于 Alert */
  aggHint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
}));
