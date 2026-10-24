// src/pages/document_type_definition/style.ts
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  /** 表单主体所在的白色大容器（对齐 AI 助手页的 Card 布局）。 */
  whiteCard: css`
    background: ${token.colorBgContainer};
    border-radius: ${token.borderRadiusLG}px;
  `,

  /**
   * 表单主体容器。
   * 注意：这里**刻意不覆盖控件的底色** —— 之前为了让「可编辑 / 禁用」一眼可分，
   * 把可编辑控件强制刷成纯白，结果控件底色与卡片背景同为白色、边框分辨不清。
   * 现恢复 antd 默认配色（由主题统一控制），只保留容器本身不做任何控件级覆盖。
   */
  contentWrap: css`
    /* no-op：保留占位，避免改动页面上的 className 引用 */
  `,

  /** 基础信息 / 分区标题 */
  sectionTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
    margin: 0 0 ${token.margin}px;
    padding-left: 8px;
    border-left: 3px solid ${token.colorPrimary};
    line-height: 1.2;
  `,

  /** 详情页底部操作条 */
  footerBar: css`
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: ${token.marginSM}px;
    margin-top: ${token.marginLG}px;
  `,
}));
