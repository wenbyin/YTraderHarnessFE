// src/pages/task/style.ts
//
// 配色分层（与 document/style.ts、document_retrieve/style.ts 同一套口径）：
//   L0 页面底   = colorBgLayout
//   L1 容器     = colorBgContainer（白）—— 卡片
//   L2 容器内板 = colorFillTertiary（灰）+ colorBorderSecondary 边框
//
// 需要强调"这是一段原样贴出来的东西"（params 的 JSON）时用 L2 着色块 ——
// 它跟周围的白色卡片形成底色反转，比加粗边框更能说明"这块是另一类内容"。
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  /** params 的 JSON 原文块。 */
  paramsBlock: css`
    margin: 0;
    padding: ${token.paddingSM}px ${token.padding}px;
    max-height: 320px;
    overflow: auto;
    background: ${token.colorFillTertiary};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.6;
    /* 长 UUID / 长路径不许顶破容器 —— 与对话区 markdown 表格同一个坑：
       break-word 不影响 min-content，只有 anywhere 能真正把宽度收住。 */
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    tab-size: 2;
  `,

  /** 顶部的"正在进行某一维过滤"提示条。 */
  filterBar: css`
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
    margin-bottom: ${token.margin}px;
    padding: ${token.paddingXS}px ${token.padding}px;
    background: ${token.colorFillTertiary};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    font-size: 13px;
  `,

  /** UUID 这类等宽短码。 */
  monoId: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,
}));
