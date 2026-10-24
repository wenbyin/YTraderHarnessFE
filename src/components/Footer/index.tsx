import { GithubOutlined } from '@ant-design/icons';
import packageJson from '@root/package.json';
import { Divider } from 'antd';
import { createStyles } from 'antd-style';
import React from 'react';

/**
 * 仓库地址：**只从 package.json 推**，推不出来就是 null。
 *
 * 2026-10-24 改名 YTraderHarnessFE 时把模板里"兜底成 ant-design/ant-design-pro"
 * 的分支删掉了 —— 那会让页脚在任何情况下都链回上游模板仓库，等于把别人的地址
 * 印在自己的产品页上。没有 repository 就不显示 GitHub 入口（见下方渲染）。
 */
const getRepoUrl = (): string | null => {
  // `repository` 是可选的：package.json 里的字面量类型推不出这个键，所以显式放宽。
  const repo = (packageJson as { repository?: string | { url?: string } })
    .repository;
  if (!repo) return null;
  const url =
    typeof repo === 'string' ? repo : ((repo as { url?: string }).url ?? '');
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}`;
};

const REPO_URL = getRepoUrl();
const COMMIT_HASH = process.env.COMMIT_HASH || '';

const useStyles = createStyles(({ token, css }) => ({
  footer: css`
    padding: 16px 24px;
    text-align: center;
    color: ${token.colorTextDescription};
    font-size: ${token.fontSizeSM}px;
    line-height: ${token.lineHeight};
    background: transparent;
  `,
  copyright: css`
    margin-bottom: 6px;
  `,
  link: css`
    color: ${token.colorTextDescription};
    text-decoration: none;
    transition: color ${token.motionDurationMid};

    &:hover {
      color: ${token.colorText};
    }
  `,
  meta: css`
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM - 1}px;
  `,
  group: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
  `,
  label: css`
    color: ${token.colorTextQuaternary};
  `,
  divider: css`
    display: inline-block;
    vertical-align: middle;
  `,
}));

const Footer: React.FC = () => {
  const { styles } = useStyles();
  const year = new Date().getFullYear();

  return (
    <div className={styles.footer}>
      <div className={styles.copyright}>YTraderHarnessFE &copy; {year}</div>
      <div className={styles.meta}>
        <span className={styles.group}>
          <span className={styles.label}>ver</span>
          {REPO_URL ? (
            <a
              className={styles.link}
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {__APP_VERSION__}
            </a>
          ) : (
            <span className={styles.link}>{__APP_VERSION__}</span>
          )}
          {COMMIT_HASH && REPO_URL && (
            <a
              className={styles.link}
              href={`${REPO_URL}/commit/${COMMIT_HASH}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {COMMIT_HASH.slice(0, 7)}
            </a>
          )}
        </span>
        <Divider orientation="vertical" className={styles.divider} />
        <span className={styles.group}>
          <span className={styles.label}>Umi</span>
          <a
            className={styles.link}
            href="https://umijs.org/"
            target="_blank"
            rel="noopener noreferrer"
          >
            {__UMI_VERSION__}
          </a>
        </span>
        <Divider orientation="vertical" className={styles.divider} />
        <span className={styles.group}>
          <span className={styles.label}>Utoo</span>
          <a
            className={styles.link}
            href="https://utoo.land"
            target="_blank"
            rel="noopener noreferrer"
          >
            {__UTOO_VERSION__}
          </a>
        </span>
        <Divider orientation="vertical" className={styles.divider} />
        {REPO_URL ? (
          <a
            className={styles.link}
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <GithubOutlined style={{ marginRight: 4 }} />
            GitHub
          </a>
        ) : null}
      </div>
    </div>
  );
};

export default Footer;
