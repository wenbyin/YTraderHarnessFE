// src/components/SchemaForm/style.ts
// SchemaForm 的字段卡片样式（从 pages/document_type_definition/components/CapabilityConfigModal.tsx 抽出）。

import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  // 字段卡片：对齐离线 demo 的 .fld —— 浅底 + 边框 + 圆角；
  // 嵌套子卡片用纯白 + 彩色左边框，靠底色差区分层级。
  field: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
    margin-bottom: 10px;
    background: ${token.colorFillQuaternary};
  `,
  fieldTop: css`
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  `,
  label: css`
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
  `,
  // 英文 key：两侧留空隙，中英混排时更好读
  keyName: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    font-family: Consolas, monospace;
    margin: 0 2px;
  `,
  desc: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-top: 3px;
    margin-bottom: 8px;
  `,
  subCard: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-left: 3px solid ${token.colorPrimary};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
    margin-top: 8px;
    background: ${token.colorBgContainer};
  `,
  subCardD1: css`
    border-left-color: #722ed1;
  `,
  subCardD2: css`
    border-left-color: ${token.colorWarning};
  `,
  subHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  `,
  subName: css`
    font-size: 12px;
    font-weight: 600;
    color: ${token.colorTextSecondary};
  `,
  row: css`
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
  `,
  disabledArea: css`
    opacity: 0.5;
    pointer-events: none;
  `,
  placeholder: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    padding: 2px 0;
  `,
  emptyCfg: css`
    font-size: 13px;
    color: ${token.colorTextTertiary};
    padding: 24px 0;
    text-align: center;
  `,
  /** 子表单折叠把手：向下箭头，展开后旋转 180°（与流水线卡片一致）。 */
  collapseBtn: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
}));
