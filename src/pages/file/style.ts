// src/pages/file/style.ts
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  /** 文件名单元格：图标 + 名称 + 短 ID */
  fileNameCell: css`
    display: flex;
    align-items: center;
    gap: ${token.marginSM}px;
    min-width: 0;
  `,

  fileIconBox: css`
    width: 40px;
    height: 40px;
    flex: 0 0 40px;
    border-radius: ${token.borderRadius}px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
  `,

  fileNameText: css`
    font-weight: 500;
    color: ${token.colorText};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;

    &:hover {
      color: ${token.colorPrimary};
    }
  `,

  monoText: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-top: 2px;
  `,

  /** SHA-256 摘要，点击可复制完整值 */
  checksum: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusSM}px;
    background: ${token.colorBgLayout};
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    color: ${token.colorTextTertiary};
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
      color: ${token.colorPrimary};
      border-color: ${token.colorPrimary};
    }
  `,

  /** 网格视图 */
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
    gap: ${token.marginMD}px;
    padding: ${token.paddingSM}px ${token.paddingLG}px ${token.paddingLG}px;
  `,

  gridCard: css`
    position: relative;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    padding: ${token.padding}px;
    cursor: pointer;
    background: ${token.colorBgContainer};
    transition: all 0.2s;

    &:hover {
      box-shadow: ${token.boxShadowSecondary};
      border-color: transparent;
      transform: translateY(-2px);
    }
  `,

  gridCardSelected: css`
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
  `,

  gridCheckbox: css`
    position: absolute;
    top: 10px;
    left: 10px;
    opacity: 0;
    transition: opacity 0.2s;

    div:hover > &,
    div[class*='gridCardSelected'] > & {
      opacity: 1;
    }
  `,

  gridStatus: css`
    position: absolute;
    top: 10px;
    right: 10px;
  `,

  gridIcon: css`
    height: 96px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: ${token.marginSM}px;
    font-size: 44px;
  `,

  gridName: css`
    font-size: 14px;
    font-weight: 500;
    color: ${token.colorText};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 6px;
  `,

  gridMeta: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    display: flex;
    gap: 6px;
    align-items: center;
  `,

  gridFooter: css`
    margin-top: ${token.marginSM}px;
    padding-top: ${token.marginSM}px;
    border-top: 1px solid ${token.colorBorderSecondary};
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,

  /** 详情抽屉 */
  previewHero: css`
    display: flex;
    align-items: center;
    gap: ${token.margin}px;
    padding: ${token.padding}px;
    border-radius: ${token.borderRadiusLG}px;
    margin-bottom: ${token.paddingLG}px;
    background: linear-gradient(
      135deg,
      ${token.colorPrimaryBg} 0%,
      ${token.colorFillQuaternary} 100%
    );
  `,

  previewHeroIcon: css`
    width: 64px;
    height: 64px;
    flex: 0 0 64px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${token.colorBgContainer};
    box-shadow: ${token.boxShadowTertiary};
    font-size: 34px;
  `,

  sectionTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
    margin: 0 0 ${token.margin}px;
    padding-left: 8px;
    border-left: 3px solid ${token.colorPrimary};
    line-height: 1.2;
  `,

  jsonBlock: css`
    margin: 0;
    padding: ${token.padding}px;
    border-radius: ${token.borderRadiusLG}px;
    background: #1f1f1f;
    color: #d4d4d4;
    font-family: ${token.fontFamilyCode};
    font-size: 12.5px;
    line-height: 1.7;
    overflow: auto;
  `,

  /** 上传弹窗内的文件队列项 */
  queueItem: css`
    display: flex;
    align-items: center;
    gap: ${token.marginSM}px;
    padding: 8px ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
  `,

  queueName: css`
    flex: 1;
    min-width: 0;
    font-size: 13px;
  `,

  queueNameText: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  queueMeta: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
}));
