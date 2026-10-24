// src/pages/memory_retrieval/components/MarkdownDoc.tsx
//
// 记忆里那两份**真的是 markdown 文件**的正文的阅读器（persona.md / 场景 .md）。
//
// 为什么要单独一个组件：
//   1. 它们是文档（有标题、列表、表格），按纯文本 pre-wrap 显示时"能看但不舒服"；
//      而按 md 渲染又会把 META 块（HTML 注释）吃掉 —— 两种需求同时存在，
//      所以**不二选一，给一个右上角开关**：阅读器模式 / 原文。
//   2. ⚠️ 渲染 md 走 `@ant-design/x-markdown`（项目已有依赖），
//      它内部是 marked + DOMPurify + html-react-parser，**输出已净化**，
//      不要自己再拼 HTML。
//   3. ⚠️ 项目全局把 `ul,ol` 的 list-style 关掉了（`src/global.less`）——
//      x-markdown 靠自己的 `li` 规则恢复，这里在 style.ts 里又钉了一遍
//      （与 CopilotDock 那次是**同一个坑**）。
//
// 只有"是 md 文件的正文"才用它。消息原文（L0）与记忆陈述（L1）是数据不是文档，
// 继续走 pre-wrap。
//
// ⚠️ 右上角的切换器是**两个图标**（2026-10-12 用户要求「改图图标，象征图片和文字」）：
//    `FileImageOutlined` = 阅读器模式（这份文档被渲染成它想被读到的样子），
//    `FileTextOutlined`  = 原文（源码，含 META 块）。同一套图标族、一对视图，
//    文案退到 tooltip 里 —— 但**不能只留图标不给名字**，否则读屏软件与悬停都读不出来。
import { FileImageOutlined, FileTextOutlined } from '@ant-design/icons';
import XMarkdown from '@ant-design/x-markdown';
import '@ant-design/x-markdown/es/XMarkdown/index.css';
import { Segmented, Typography } from 'antd';
import React, { useState } from 'react';

import { useStyles } from '../style';

/** `reader` = 渲染后的 md；`raw` = 原样（含 META 块）。 */
export type DocViewMode = 'reader' | 'raw';

export const MarkdownDoc: React.FC<{
  /** 文档正文（原样传进来，含 META 块）。 */
  text: string;
  /** 切换条左边那行说明。 */
  label?: string;
  /**
   * 跟在文件名后面的那点元信息（版本 / 更新时间…）。
   *
   * 为什么放在**这一条栏**里，而不是上面再套一个头
   * --------------------------------------------------
   * persona.md 这块原来有两个头：外层一条「persona.md + version 0 + 更新时间」
   * 的灰条 + 一个灰底盒子，里面才是这个编辑器自己的「persona.md + 切换器」栏 ——
   * 同一个文件名出现两次、盒子套盒子（2026-10-17 用户：「去掉 md 编辑器嵌套，
   * 只留内层编辑器」）。并进来之后：**一层盒子、一个文件名**，版本与时间不丢。
   */
  meta?: React.ReactNode;
}> = ({ text, label, meta }) => {
  const { styles } = useStyles();
  // 默认给阅读器：这两个字段的定义就是"一篇 md 文件"，渲染后才是它想被读到的样子；
  // 想看 META / 原始缩进时再切「原文」。
  const [mode, setMode] = useState<DocViewMode>('reader');

  return (
    /* `data-md-doc` 是给单测 / 浏览器探针的稳定抓手：整块面板只有这一层，
       用例靠它断言「没有第二条外壳」（类名是 antd-style 的哈希，选择器抓不住）。 */
    <div className={styles.mdDoc} data-md-doc="panel">
      <div className={styles.mdBar}>
        <Typography.Text type="secondary" strong style={{ fontSize: 12 }}>
          {label ?? 'markdown 文档'}
        </Typography.Text>
        {meta}
        <Segmented
          size="small"
          className={styles.mdToggle}
          // 分段控制器整体没有可见文字了，给它一个组名（读屏用）。
          aria-label="正文显示方式"
          value={mode}
          onChange={(value) => setMode(value as DocViewMode)}
          options={[
            {
              value: 'reader',
              // ⚠️ `data-doc-mode` 是给单测 / 浏览器探针的稳定抓手：图标模式下
              //    这一项**没有任何可见文字**，按文案找元素的写法会全部失效
              //    （rc-segmented 的 radio 上也没有 value 属性，别想着按 value 找）。
              icon: (
                <span data-doc-mode="reader">
                  <FileImageOutlined aria-label="阅读器模式" />
                </span>
              ),
              tooltip: '阅读器模式：按 markdown 渲染（META 注释不显示）',
            },
            {
              value: 'raw',
              icon: (
                <span data-doc-mode="raw">
                  <FileTextOutlined aria-label="原文" />
                </span>
              ),
              tooltip: '原文：源码原样显示（META 块在这里看得到）',
            },
          ]}
        />
      </div>
      {mode === 'reader' ? (
        <div className={styles.mdReader}>
          <XMarkdown content={text} openLinksInNewTab />
        </div>
      ) : (
        <div className={styles.mdRaw}>{text}</div>
      )}
    </div>
  );
};
