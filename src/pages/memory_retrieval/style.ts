// src/pages/memory_retrieval/style.ts
//
// 配色分层与 document_retrieve 保持一致（这是本项目里同类"查询台"页面的既有口径）：
//   L0 页面底  = colorBgLayout
//   L1 卡片    = colorBgContainer（白）—— antd Card 自带
//   L2 卡内面板 = colorFillTertiary（灰）+ colorBorderSecondary 边框
//   L3 面板内块 = colorBgContainer（白）+ colorBorderSecondary 边框
//
// 为什么要分层：Card 是白的，卡里再放一个白底 + 1px 浅灰边的面板就是"白底套白底"，
// 只剩一根几乎看不见的线。所以 L2 一律染色，需要再嵌一层时回到白底 —— 靠**底色
// 反转**分层，而不是靠加粗边框。（token 实测：colorFillQuaternary 与白只差 5 阶，
// 当第二层等于没画；colorBorderSecondary 与 colorFillSecondary 同值，当边框等于没画。）
//
// ⚠️ 本文件的注释都写在 css 模板字符串**内部**，所以注释里**不能出现反引号** ——
//    一个反引号就会把模板提前闭合，报错行号还会指向注释行，看起来完全不相干。
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => {
  /** L2 面板：白卡片里的一层浅灰容器。多处共用，抽成变量免得同层级两种灰。 */
  const l2Panel = css`
    padding: ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
  `;

  return {
    // ---------------- 页面骨架 ----------------
    layout: css`
      display: grid;
      grid-template-columns: 420px minmax(0, 1fr);
      gap: ${token.marginMD}px;
      align-items: start;

      @media (max-width: 1280px) {
        grid-template-columns: minmax(0, 1fr);
      }
    `,

    column: css`
      display: flex;
      flex-direction: column;
      gap: ${token.marginMD}px;
      min-width: 0;
    `,

    // ---------------- 表单行 ----------------
    /**
     * 一行 = 一个参数。标签定宽、控件吃满剩余空间，几行扫下来值才能竖着对齐。
     */
    fieldRow: css`
      display: flex;
      align-items: flex-start;
      gap: ${token.marginXS}px;

      & + & {
        margin-top: ${token.marginSM}px;
      }
    `,

    fieldLabel: css`
      flex: 0 0 108px;
      width: 108px;
      padding-top: 5px;
      font-size: 12px;
      color: ${token.colorTextSecondary};
      line-height: 1.4;
    `,

    fieldControl: css`
      flex: 1;
      min-width: 0;
    `,

    /** 参数下方的说明 —— 这一列是"填错也不会报错"的地方，必须留位置。 */
    fieldHint: css`
      margin-top: 2px;
      font-size: 12px;
      color: ${token.colorTextTertiary};
      line-height: 1.6;
    `,

    /** 归属栏下的档位标识：team / personal，只做提示，不参与判定。 */
    scopeCaption: css`
      font-size: 11px;
      color: ${token.colorTextQuaternary};
      letter-spacing: 0.02em;
    `,

    /** 两个小控件并排（如 limit 与 include_content）。 */
    inlineRow: css`
      display: flex;
      align-items: center;
      gap: ${token.marginXS}px;
      flex-wrap: wrap;
    `,

    /** 开关 + 文案：开关只有十几 px，不能让它跟说明文字挤在同一行里。 */
    switchRow: css`
      display: flex;
      align-items: flex-start;
      gap: ${token.marginXS}px;
    `,

    switchBody: css`
      flex: 1;
      min-width: 0;
      font-size: 12px;
      line-height: 1.6;
    `,

    // ---------------- 卡片底部的动作行：按钮贴右下 ----------------
    /**
     * 主操作（执行）挂在**最上面那张参数卡**的右下角 —— 参数填完就在原地提交，
     * 不必再滚到最下面的「请求体预览」上去找按钮。
     *
     * ⚠️ 不能用 `space-between`：这一行只有按钮一个孩子，`space-between` 会把它
     *    顶到**左边**（上一版就是这样，按钮看起来"掉"在预览卡左下角）。
     */
    cardActions: css`
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: ${token.marginXS}px;
      margin-top: ${token.marginSM}px;
    `,

    // ---------------- 请求体预览 ----------------
    requestPreview: css`
      margin: 0;
      max-height: 320px;
      overflow: auto;
      padding: ${token.paddingSM}px;
      border: 1px solid ${token.colorBorderSecondary};
      border-radius: ${token.borderRadius}px;
      background: ${token.colorFillTertiary};
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    `,

    // ---------------- 结果 ----------------
    hint: css`
      font-size: 12px;
      color: ${token.colorTextTertiary};
      line-height: 1.7;
    `,

    mono: css`
      font-family: ${token.fontFamilyCode};
      font-size: 11px;
    `,

    /** 每条记录一行 Tag —— 换行不要溢出卡片。 */
    tagRow: css`
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
    `,

    /** L2：结果条。白 Card 里的一块灰底，靠底色反转立住。 */
    recordItem: css`
      ${l2Panel}
      padding: ${token.paddingXS}px ${token.paddingSM}px;

      & + & {
        margin-top: ${token.marginXS}px;
      }

      &:hover {
        border-color: ${token.colorPrimaryBorder};
      }
    `,

    // ---------------- md 阅读器（persona.md / 场景 .md） ----------------
    /**
     * md 文档块：外框 + 右上角的「阅读器 / 原文」切换条。
     *
     * 这两份正文**本来就是 markdown 文件**（persona.md、场景 .md，都带 META 块），
     * 所以给它一个专门的阅读器；切换条留在右上角，原文（含 META）随时能看。
     */
    mdDoc: css`
      margin-top: ${token.marginXS}px;
      border: 1px solid ${token.colorBorderSecondary};
      border-radius: ${token.borderRadius}px;
      background: ${token.colorBgContainer};
      overflow: hidden;
    `,

    mdBar: css`
      display: flex;
      align-items: center;
      /* 三件了（文件名 / 元信息 / 切换器）：靠 gap 排，切换器用 margin-left:auto
         顶到右边 —— 别再写 space-between，那样三件会被摊成"左中右"。 */
      justify-content: flex-start;
      gap: ${token.marginXS}px;
      flex-wrap: wrap;
      padding: ${token.paddingXXS}px ${token.paddingXS}px;
      border-bottom: 1px solid ${token.colorBorderSecondary};
      background: ${token.colorFillQuaternary};
    `,

    mdReader: css`
      padding: ${token.paddingSM}px ${token.padding}px;
      font-size: 13px;
      line-height: 1.75;
      color: ${token.colorText};

      & .x-markdown {
        font-size: inherit;
        line-height: inherit;
      }

      & .x-markdown h1,
      & .x-markdown h2,
      & .x-markdown h3,
      & .x-markdown h4,
      & .x-markdown h5,
      & .x-markdown h6 {
        margin: 1em 0 0.5em;
        font-weight: 600;
        line-height: 1.4;
      }

      & .x-markdown h1 {
        font-size: 1.35em;
      }

      & .x-markdown h2 {
        font-size: 1.2em;
      }

      & .x-markdown h3 {
        font-size: 1.08em;
      }

      & .x-markdown > :first-child {
        margin-top: 0;
      }

      /**
       * 项目全局把列表标记关掉了（src/global.less 的 ul,ol{list-style:none}）。
       * x-markdown 自己给 li 恢复了 disc/decimal，但那靠的是它几条 :not() 的选择器
       * 堆出来的特异性 —— 这里再钉一遍，并给标记留出位置。
       */
      & .x-markdown ul,
      & .x-markdown ol {
        padding-left: 1.6em;
        list-style-position: outside;
      }

      & .x-markdown ul {
        list-style-type: disc;
      }

      & .x-markdown ol {
        list-style-type: decimal;
      }

      & .x-markdown table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }

      & .x-markdown th,
      & .x-markdown td {
        padding: 6px 8px;
        border: 1px solid ${token.colorBorderSecondary};
        text-align: left;
        overflow-wrap: anywhere;
      }

      & .x-markdown th {
        background: ${token.colorFillQuaternary};
        font-weight: 600;
      }

      & .x-markdown :not(pre) > code {
        padding: 0 4px;
        border-radius: 3px;
        background: ${token.colorFillQuaternary};
        font-family: ${token.fontFamilyCode};
        font-size: 0.9em;
      }

      & .x-markdown pre {
        margin: 0.8em 0;
        padding: ${token.paddingXS}px ${token.paddingSM}px;
        border-radius: ${token.borderRadius}px;
        background: ${token.colorFillTertiary};
        overflow: auto;
      }

      & .x-markdown blockquote {
        margin: 0.8em 0;
        padding: 2px 0 2px ${token.paddingSM}px;
        border-left: 3px solid ${token.colorBorder};
        color: ${token.colorTextSecondary};
      }
    `,

    /**
     * md 阅读器右上角的模式切换（两个图标，没有可见文字）。
     *
     * 只做两件事：不吃额外宽度；把图标两侧的默认留白收一点 —— 默认尺寸下
     * 图标左右各留一大截，那一行（说明文字 + 切换器）会显得偏高。
     */
    mdToggle: css`
      flex: 0 0 auto;
      /* 顶到栏尾。栏里现在可能还有 meta（版本 / 时间），只靠 gap 排的话
         切换器会紧贴在时间后面，看着像"时间的一部分"。 */
      margin-left: auto;

      & .ant-segmented-item-label {
        display: flex;
        align-items: center;
        justify-content: center;
        padding-inline: 6px;
      }
    `,

    /** 原文模式：与阅读器同一块地，只是不做 markdown 解析（META 块原样可见）。 */
    mdRaw: css`
      margin: 0;
      padding: ${token.paddingSM}px ${token.padding}px;
      font-size: 13px;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: break-word;
      color: ${token.colorText};
      max-height: 420px;
      overflow: auto;
    `,

    /** L3：记录正文。外面那层已经染灰，这里回到白底，且**原样保留换行**（工具产出是数据）。 */
    recordContent: css`
      margin-top: ${token.marginXS}px;
      padding: ${token.paddingXS}px ${token.paddingSM}px;
      border: 1px solid ${token.colorBorderSecondary};
      border-radius: ${token.borderRadius}px;
      background: ${token.colorBgContainer};
      color: ${token.colorText};
      font-size: 13px;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow: auto;
    `,

    /** 正文的**通用**档（L1 陈述 / L0·L1 的召回命中片段）—— 整条渲染，不加夹子。 */
    factContent: css`
      margin-top: ${token.marginXXS}px;
      font-size: 13px;
      line-height: 1.7;
      color: ${token.colorText};
      white-space: pre-wrap;
      word-break: break-word;
    `,

    /**
     * **L0 消息原文**的正文壳体：默认只显示 N 行（3 行），点「展开全部」看全文。
     *
     * ⚠️ `-webkit-line-clamp` 要求 `display: -webkit-box` + `-webkit-box-orient` +
     *    `overflow: hidden` **三件一起**才生效，缺一个就静默失效（看着像没写）。
     *    `white-space: pre-wrap` 保留消息里的换行 —— 换行**也算行**，所以"三行"是
     *    "渲染出来的前三行"，不是"前三个段落"。
     * ⚠️ 只给 L0 的**浏览记录**用：L1 是提炼过的短陈述、召回命中本身就是片段，
     *    给它们加夹子只会多一次点击。
     */
    clampText: css`
      margin-top: ${token.marginXXS}px;
      font-size: 13px;
      line-height: 1.7;
      color: ${token.colorText};
      white-space: pre-wrap;
      word-break: break-word;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
    `,

    /**
     * 展开态：把夹子整组撤掉。
     * ⚠️ 必须把 `display` 从 `-webkit-box` 还原成 `block` —— 只撤 `-webkit-line-clamp`
     *    的话它还是个 flex 盒子，段落间距/缩进会跟收起前不一样。
     */
    clampTextOpen: css`
      display: block;
      overflow: visible;
    `,

    /** 「展开全部 / 收起」那颗 link 按钮（压在正文下面，不与正文抢行）。 */
    clampToggle: css`
      padding: 0;
      height: auto;
      font-size: 12px;
    `,

    // ---------------- L1 / L2 的卡片网格（仿 file 页的「网格」视图） ----------------
    /**
     * 网格容器。
     *
     * ⚠️ `auto-fill + minmax(240px, 1fr)` 而不是固定列数：结果区的宽度随左边那
     *    420px 的参数栏与窗口变，写死"每行 N 张"在窄屏上会把卡压成一竖条。
     *    FileGrid 用的是 196px —— 这里取 240px，因为 L1 的标签行（type +
     *    priority）比文件那一行状态标签更占宽。
     */
    cardGrid: css`
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: ${token.marginSM}px;
    `,

    /**
     * 一张卡：**整张就是一个 `<button>`**（FileGrid 就是这个手感）。
     *
     * ⚠️ 用 button 是为了拿到免费的键盘与读屏语义（`div + role="button"` 那条路要自己
     *    补 tabIndex 与 onKeyDown，漏一次就是"只能鼠标点"）。代价是子元素只能是
     *    `<span>` → 那几个 `cardXxx` 样式**自己带 display**，别指望它们是块级。
     * ⚠️ `text-align: left` 与 `font-*: inherit` 必须显式写：button 有 UA 默认的居中
     *    与系统字体，不还原的话卡里的字会跟整页不一样、并且居中对齐。
     */
    recordCard: css`
      position: relative;
      width: 100%;
      padding: ${token.paddingSM}px;
      border: 1px solid ${token.colorBorderSecondary};
      border-radius: ${token.borderRadiusLG}px;
      background: ${token.colorBgContainer};
      text-align: left;
      font-family: inherit;
      font-size: inherit;
      color: inherit;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: all 0.2s;

      &:hover {
        border-color: ${token.colorPrimaryBorder};
        box-shadow: ${token.boxShadowSecondary};
        transform: translateY(-2px);
      }

      &:focus-visible {
        outline: 2px solid ${token.colorPrimary};
        outline-offset: 2px;
      }
    `,

    /**
     * 卡脚**右侧**那组 Tag（L1：type + priority；L2：heat + version）。
     *
     * ⚠️ 2026-10-12 之前这组是**绝对定位在右上角**的，标题为了避让写了
     *    `padding-right: 96px` —— 结果是标题只剩半行（用户拿截图指出"排版显示不全"）。
     *    现在它回到正常的文档流里（卡脚的右侧一格），标题整行可用。
     * ⚠️ antd 的 `Tag` 自带 `margin-inline-end: 8px`，在 flex + gap 里会与 `gap` 叠加成
     *    双倍间距 → 这里把它按回 0，间距只由 `gap` 决定（否则同一张卡里两枚 Tag 的
     *    间距和"Tag 与左边文字"的间距对不上）。
     * ⚠️ `flex: 0 0 auto` 是必需的：不是 0 的话它会被左边的长文本压扁。
     */
    cardTags: css`
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;

      .ant-tag {
        margin-inline-end: 0;
      }
    `,

    /**
     * 卡脚**左侧**那组标识（L1：record_id + version）。
     * ⚠️ `min-width: 0` + 里面的 `overflow: hidden` 才让长 id 能省略，不然它会把
     *    右侧那组 Tag 顶出卡片（flex 的默认 `min-width: auto` 不允许收缩）。
     */
    cardMeta: css`
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
    `,

    /**
     * 卡标题：**整行可用**（原来的 `padding-right: 96px` 是给右上角那组绝对定位的 Tag
     * 让位的，Tag 挪到卡脚之后那个魔法数字就没意义了）。
     * ⚠️ `display: block` 是**必需的**：外层是 `<button>`，里面只能是 span，而
     *    `text-overflow: ellipsis` 对 inline 元素不生效。
     */
    cardTitle: css`
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: ${token.colorText};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `,

    cardTitleMono: css`
      font-family: ${token.fontFamilyCode};
      font-size: 12px;
    `,

    /**
     * 卡里的缩略正文（L1 的 content / L2 的 summary）。
     *
     * ⚠️ 与 `clampText` 是**同一套三件缺一不可**的组合（`-webkit-box` +
     *    `-webkit-box-orient` + `overflow:hidden`）：少一件就静默失效，看着像没写。
     *    行数由 `WebkitLineClamp` 内联给（两张卡都要能改这个值），这里不写死。
     * ⚠️ `min-height` 而不是 `height`：这个字段的作用是让"没有 summary 的存量场景"
     *    那张卡不至于比邻居矮一截 —— 写成固定高度的话，短内容会被撑出大片空白。
     */
    cardClamp: css`
      flex: 1 1 auto;
      min-height: 66px;
      margin: 0;
      font-size: 13px;
      line-height: 1.7;
      color: ${token.colorTextSecondary};
      white-space: pre-wrap;
      word-break: break-word;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
    `,

    /**
     * 卡脚：左边是标识（L1 的 record_id+version / L2 的更新时间），右边是状态 Tag。
     */
    cardFooter: css`
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${token.marginXS}px;
      padding-top: ${token.paddingXS}px;
      border-top: 1px dashed ${token.colorBorderSecondary};
      font-size: 12px;
      color: ${token.colorTextTertiary};
      min-width: 0;
    `,

    metaGrid: css`
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 2px ${token.margin}px;
      margin-top: ${token.marginXXS}px;
      font-size: 12px;
      color: ${token.colorTextTertiary};
    `,

    metaItem: css`
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `,

    /**
     * 列表页脚：左边一句"本页几条 / 还有没有下一页"，右边「加载更多」。
     *
     * ⚠️ v2 把列表改成**不透明游标分页**之后，这里不再有"上一页 / 下一页"——
     *    游标算不出上一页，界面用的又是"卡片流 + 加载更多"（条目累积）。
     *    所以页脚只往前看：一条统计 + 一个按钮。
     */
    listFooter: css`
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: ${token.marginXS}px;
      margin-top: ${token.marginSM}px;
      padding-top: ${token.marginXS}px;
      border-top: 1px dashed ${token.colorBorderSecondary};
    `,

    // ---------------- sections（汇总） ----------------
    /** L2：一段一个容器。与结果条同一档灰 —— 在白色 Card 里它们是一类东西。 */
    sectionBox: css`
      ${l2Panel}
      padding: ${token.paddingSM}px;

      & + & {
        margin-top: ${token.marginSM}px;
      }
    `,

    sectionHead: css`
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${token.marginXS}px;
      flex-wrap: wrap;
      margin-bottom: ${token.marginXS}px;
    `,

    /**
     * 列表 / 详情页的「头」：scope_kind + 已加载条数 + 一段口径说明。
     *
     * ⚠️ 它与后面的卡片流是**两个灰底面板贴在一起**（边界只靠 padding，没有线），
     *    而 `sectionBox` 的 `& + &` 间距只在"两块 sectionBox 相邻"时生效 ——
     *    头后面跟的是 recordItem / emptyBox，命中不了那一条 → 视觉上粘死。
     *    所以这里单独补一档 margin-bottom，把这个缝封掉。
     */
    listHeadBox: css`
      ${l2Panel}
      margin-bottom: ${token.marginSM}px;
    `,

    sectionTitle: css`
      display: flex;
      align-items: center;
      gap: ${token.marginXXS}px;
      font-size: 13px;
      font-weight: 600;
    `,

    // ---------------- 降级 ----------------
    degradedList: css`
      display: flex;
      flex-direction: column;
      gap: ${token.marginXS}px;
    `,

    degradedItem: css`
      padding: ${token.paddingXS}px ${token.paddingSM}px;
      border-radius: ${token.borderRadius}px;
      background: ${token.colorFillQuaternary};
      font-size: 12px;
      line-height: 1.6;
    `,

    /** 空状态块：与卡内面板同级，虚线边表明"这里现在没东西"。 */
    emptyBox: css`
      border: 1px dashed ${token.colorBorder};
      border-radius: ${token.borderRadiusLG}px;
      padding: ${token.paddingLG}px;
      background: ${token.colorFillTertiary};
    `,

    /** 403 / 表单校验失败时的告警块 —— 用 Alert，这里只留一处间距。 */
    alertGap: css`
      margin-bottom: ${token.marginSM}px;
    `,

    /** 403 的说明正文（里面要列角色门槛与 dev-bypass 的关系，需要多行排版）。 */
    roleNote: css`
      font-size: 12px;
      line-height: 1.8;

      code {
        padding: 0 4px;
        border-radius: 3px;
        background: ${token.colorFillQuaternary};
        font-family: ${token.fontFamilyCode};
      }
    `,

    /** 表单里那行"会被解析成哪种 scope"的实时预览。 */
    scopePreview: css`
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: ${token.marginXS}px;
      font-size: 12px;
      line-height: 1.7;
    `,

    /**
     * L3：拼装好的 prompt 文本。
     *
     * 用一条**左侧竖线**跟数据段区分开 —— 它是渲染产物（"勾了这些之后会拼出
     * 什么"），不是一份数据；靠加底色区分会和 sections 的灰底打架（白底套白底
     * 那类问题），竖线是最省事且不会误读的一种。
     */
    promptText: css`
      margin-top: 6px;
      max-height: 420px;
      overflow: auto;
      padding: ${token.paddingXS}px ${token.paddingSM}px;
      border-left: 3px solid ${token.colorPrimaryBorder};
      border-radius: 0 ${token.borderRadius}px ${token.borderRadius}px 0;
      background: ${token.colorBgContainer};
      color: ${token.colorText};
      font-size: 13px;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: break-word;
    `,

    // ---------------- 选人控件（UserPicker） ----------------
    /**
     * 下拉里的空态：说清"为什么没有"，而且要有地方把它说完（默认是 nowrap）。
     */
    userSearchEmpty: css`
      max-width: 340px;
      padding: ${token.paddingXXS}px 0;
      color: ${token.colorTextTertiary};
      font-size: 12px;
      line-height: 1.7;
      white-space: normal;
      text-align: left;
    `,

    /** 下拉里的失败态：403 是本地最可能看到的一种，得能放下一整句话。 */
    userSearchError: css`
      max-width: 340px;
      padding: ${token.paddingXXS}px 0;
      color: ${token.colorErrorText};
      font-size: 12px;
      line-height: 1.7;
      white-space: normal;
      text-align: left;
    `,
  };
});

export type MemoryStyles = ReturnType<typeof useStyles>['styles'];
