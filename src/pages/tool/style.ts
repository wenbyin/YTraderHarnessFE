// src/pages/tool/style.ts
//
// 配色分层（浅色主题下最容易踩的坑，与其它页同一套规则）：
//   L0 页面底色 = colorBgLayout
//   L1 卡片     = colorBgContainer（白）—— antd Card 自带
//   L2 卡内面板 = colorFillTertiary（灰）+ 边框
//   L3 面板内块 = colorBgContainer（白）+ 边框
//
// 为什么必须分层：Card 是白的，卡里再放一个白底 + 1px 浅灰边的面板，
// 视觉上就是「白底套白底」，只剩一根几乎看不见的线。所以 L2 一律染色，
// 需要再嵌一层时回到白底 —— 靠**底色反转**而不是靠加粗边框来分层。
//
// 实测过的值（别选错）：
//   colorFillQuaternary 250 —— 贴白底只差 5，**不能当 L2**
//   colorFillTertiary    245 —— L2
//   colorBorderSecondary 240 —— 与 colorFillSecondary 同值，当边框等于没画
//   colorBorder          217 —— 需要看得见的边框用它
//
// 例外：下面几处用**语义色**（绿 / 红 / 橙）而不是灰阶 ——
// 「生效值来自覆盖」是状态而不是层级，用灰阶表达不出来。
//
// 注意：注释写在 css 模板**内部**时不能出现反引号，一个反引号就把模板提前闭合。
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  layout: css`
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
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

  // ---------------- 左侧列表 ----------------
  toolList: css`
    display: flex;
    flex-direction: column;
    gap: ${token.marginXS}px;
    /* 筛选区和列表之间必须留一档呼吸 —— classification_code 是最后一个筛选框，
       不留的话下拉框直接贴着第一张列表项，看着像是一体的 */
    margin-top: ${token.marginSM}px;
    max-height: calc(100vh - 320px);
    overflow-y: auto;
  `,

  /**
   * L2：列表项。
   *
   * 选中态换成**主色底**而不是加深边框 —— 列表项已经有很多标签在抢注意力，
   * 只改边框色在快速滚动时几乎看不出来。
   */
  toolItem: css`
    /* 列表项渲染成真 <button>：这几个属性把它 reset 回「一块可点的面板」 */
    display: block;
    width: 100%;
    text-align: left;
    font: inherit;
    color: inherit;

    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
    cursor: pointer;

    &:hover {
      border-color: ${token.colorPrimaryBorder};
    }
  `,

  /**
   * 选中态必须一眼可辨。只用 colorPrimaryBg 不够 —— 它和未选中的
   * colorFillTertiary 都是极浅的底色（#e6f4ff vs #f5f5f5），余光里分不出来，
   * 快速滚动时更是如此。所以叠三层信号：
   *   ① 左侧 3px 主色条（inset 阴影实现，不加宽 border-left，避免 1px 布局抖动）
   *   ② 主色底 + 主色边框
   *   ③ 标题换主色（[data-role='name'] 由 ToolList 标在名称上）
   */
  toolItemActive: css`
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
    box-shadow: inset 3px 0 0 0 ${token.colorPrimary};

    & [data-role='name'] {
      color: ${token.colorPrimary};
    }
  `,

  toolItemName: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 13px;
  `,

  toolItemDesc: css`
    margin-top: 2px;
    font-size: 12px;
    color: ${token.colorTextSecondary};
    /* 两行截断：描述可能很长，不截断会把列表撑成一屏一个 */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `,

  // ---------------- 详情：三态文档块 ----------------
  /** L2：一个可覆盖字段一整块。里面再嵌 L3 白底。 */
  docBlock: css`
    padding: ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};

    & + & {
      margin-top: ${token.marginSM}px;
    }
  `,

  docBlockHead: css`
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
    margin-bottom: ${token.marginXS}px;
  `,

  /**
   * L3：代码侧描述。
   *
   * 只读、灰字 —— 它与其它的区别不该靠「颜色鲜艳」，而要靠**淡**。
   * 用户在改的是下面那个框，这里要退到背景里。
   */
  sourceBox: css`
    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    color: ${token.colorTextSecondary};
    font-size: 12.5px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
  `,

  /**
   * L3：生效值。**绿**表示这段来自人工覆盖 ——
   * 这是这个页面最需要在余光里也能分辨的东西，所以给语义色而不是灰阶。
   */
  effBox: css`
    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border: 1px solid ${token.colorSuccessBorder};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorSuccessBg};
    color: ${token.colorSuccessText};
    font-size: 12.5px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
  `,

  /** 生效值回落成代码原文时：视觉上要退回中性，否则「我改了」这件事会被误报。 */
  effBoxFallback: css`
    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    color: ${token.colorTextSecondary};
    font-size: 12.5px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
  `,

  /** 三态块里的小字号行：说明这一格是什么、从哪来。 */
  caption: css`
    margin-top: 4px;
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,

  /**
   * 表格「名称」格里的**名字本体**（2026-10-21：折行时两个 span 各占一行）。
   *
   * 用户原话：「这里名称折行了直接让两个span换行显示」—— 名字**不许**在字与字
   * 之间断开（截图里那个「智能体运行时流 程编排」读不出来是一个词），放不下就
   * 把路径那一段整体挪到下一行。
   *
   * ⚠️ 用 `display: block` 而不是 inline-block
   * ---------------------------------------
   *   inline-block 是**原子**盒子，百分比宽度按单元格算（`max-width: 100%`
   *   不含树形图标占掉的那 24px），放不进"图标右边剩下那点宽度"时整块掉到
   *   浮动图标**下方** —— 正是 cellPath 注释里那个"图标孤零零留在上一行"。
   *
   * ⚠️ `overflow: hidden` 除了给省略号，还顺手建了个 BFC —— BFC 不与浮动
   *    重叠，**宽度被浮动缩窄**，于是"剩下多少就显示多少、多了就省略号"。
   *    （不建 BFC 的话块盒会盖到图标下面，字被图标压住。）
   *
   * ⚠️ `white-space: nowrap`：名字自己独占一行还放不下时**截断**，而不是再断
   *    一次字 —— 断字正是要修掉的那个观感。
   */
  cellName: css`
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  `,

  /**
   * 表格「名称」格里那个**祖先路径**后缀 —— **已废弃**（2026-10-21）。
   *
   * 用户：「直接去除下方的小字」。那行灰色的 `父 / 父父` 现在不渲染了，
   * 层级关系由树形缩进表达。样式一并删掉，免得以后有人看到它又把它挂回去。
   */

  /** 表格里的「代码描述」格。 */
  cellSource: css`
    padding: 4px 6px;
    border-radius: 4px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
    font-size: 12px;
    line-height: 1.6;
  `,

  /** 表格里的「生效」格。与主块同一个语义色成对出现。 */
  cellEffective: css`
    padding: 4px 6px;
    border-radius: 4px;
    background: ${token.colorSuccessBg};
    border: 1px solid ${token.colorSuccessBorder};
    color: ${token.colorSuccessText};
    font-size: 12px;
    line-height: 1.6;
  `,

  cellEffectiveFallback: css`
    padding: 4px 6px;
    border-radius: 4px;
    background: ${token.colorBgContainer};
    border: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
    font-size: 12px;
    line-height: 1.6;
  `,

  // ---------------- 分类树 ----------------
  /** L3：树容器。ANO 自带底色是透明的，这层白要我们来给。 */
  treePanel: css`
    padding: ${token.paddingXS}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    max-height: 360px;
    overflow: auto;
  `,

  // ---------------- 通用 ----------------
  kv: css`
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    gap: 6px ${token.marginSM}px;
    font-size: 13px;
  `,

  kvKey: css`
    color: ${token.colorTextTertiary};
  `,

  kvVal: css`
    word-break: break-all;
    min-width: 0;
  `,

  /** L2：请求体 JSON 块。原本 quaternary 在白 Card 上太淡，提到 tertiary 并补边框。 */
  jsonBlock: css`
    margin: 0;
    max-height: 300px;
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

  hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.7;
  `,

  mono: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
  `,

  /** 两个 source_type / source_state 的展示色。空串不是有效 class。 */
  sourceTypeTag: css`
    font-size: 11px;
  `,

  /* ================================================================
   * 处理链（tool_processor.yaml）
   *
   * 这一块的层级：Card(L1 白) → docBlock(L2 tertiary) → 时间轴行(L3 白 + colorBorder)。
   * 行必须回到白底 —— 行是"正在编辑的东西"，要浮在灰底面板之上，
   * 靠**底色反转**而不是靠加粗边框分层（顶部注释里那条规则）。
   * ================================================================ */

  /* ---------------- 执行顺序提示（ChainOrderHint） ----------------
   * 形态是 Alert（可关闭 / 到点自动收起），不再是常驻面板。
   * Alert 自己的底色（info 的浅蓝）就是 L2，里面的行回到白底当 L3。
   * 缩进由组件按层数算（每层 18px），所以这里不写死左边距。
   */

  /**
   * 收起动画的载体。
   *
   * 用 `grid-template-rows: 1fr → 0fr` 而不是 `max-height`：前者能精确过渡到
   * 内容的**真实高度**，后者要预先猜一个值（猜大了前 80% 的动画时间都在空转，
   * 看着像"点了没反应，最后突然跳一下"）。内层 `overflow: hidden` 负责裁切。
   *
   * ⚠️ 这里的 260ms 与 ChainOrderHint.tsx 的 COLLAPSE_MS 必须一致 ——
   *    组件靠那个计时器决定"动画跑完再卸载节点"。
   */
  orderShell: css`
    display: grid;
    grid-template-rows: 1fr;
    margin-bottom: ${token.marginSM}px;
    opacity: 1;
    transform: translateY(0);
    transition:
      grid-template-rows 260ms cubic-bezier(0.4, 0, 0.2, 1),
      opacity 200ms ease,
      margin-bottom 260ms cubic-bezier(0.4, 0, 0.2, 1),
      transform 260ms cubic-bezier(0.4, 0, 0.2, 1);
  `,

  orderShellCollapsed: css`
    grid-template-rows: 0fr;
    opacity: 0;
    margin-bottom: 0;
    transform: translateY(-4px);
    /* 塌缩过程中别接住点击（底下两栏正在上移） */
    pointer-events: none;
  `,

  orderShellInner: css`
    min-height: 0;
    overflow: hidden;
  `,

  orderAlert: css`
    /* 间距交给 orderShell（它要在收起时把 margin 一起收到 0），这里不加 margin */

    /* Alert 的 description 默认没有上间距，六行阶梯贴标题太近 */
    .ant-alert-description {
      margin-top: ${token.marginXS}px;
    }
  `,

  /** Alert 标题行：文字 + 「顺序即语义」小签，横排（Alert 标题默认不是 flex）。 */
  orderAlertTitle: css`
    display: inline-flex;
    align-items: center;
    gap: ${token.marginXS}px;
  `,

  /** 收起后那一行入口 —— 12px 的弱化链接，不抢两栏的注意力。 */
  orderReopenRow: css`
    margin-bottom: ${token.marginSM}px;
    animation: order-hint-in 200ms ease-out;

    @keyframes order-hint-in {
      from {
        opacity: 0;
        transform: translateY(-3px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `,

  orderReopen: css`
    font-size: 12px;
  `,

  /** 「顺序即语义」小签 —— 用主色描边而不是填充，别跟状态 Tag 抢注意力。 */
  orderTag: css`
    font-size: 11px;
    line-height: 18px;
    padding: 0 6px;
    border: 1px solid ${token.colorPrimaryBorder};
    border-radius: ${token.borderRadiusSM}px;
    color: ${token.colorPrimary};
  `,

  orderLadder: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,

  orderRow: css`
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
    padding: 5px 10px;
    border: 1px solid ${token.colorBorderSecondary};
    border-left: 3px solid ${token.colorPrimary};
    border-radius: ${token.borderRadiusSM}px;
    background: ${token.colorBgContainer};
    min-width: 0;
  `,

  orderRowMuted: css`
    border-left-color: ${token.colorBorder};
  `,

  /** 最内层：虚线 + 灰底，明确表示「它不是处理器，是被包住的那次调用」。 */
  orderRowTool: css`
    border-style: dashed;
    border-left-style: solid;
    border-left-color: ${token.colorText};
    background: ${token.colorFillTertiary};
  `,

  orderIdx: css`
    flex: none;
    width: 16px;
    font-size: 11px;
    text-align: center;
    color: ${token.colorTextQuaternary};
  `,

  orderKey: css`
    flex: none;
    font-size: 12.5px;
    color: ${token.colorText};
  `,

  orderName: css`
    flex: none;
    font-size: 13px;
    font-weight: 500;
    color: ${token.colorText};
  `,

  orderBadge: css`
    flex: none;
    font-size: 11px;
    line-height: 18px;
    padding: 0 6px;
    border-radius: ${token.borderRadiusSM}px;
    background: ${token.colorFillSecondary};
    color: ${token.colorTextSecondary};
    white-space: nowrap;
  `,

  /**
   * 说明文字占满剩余宽度，**单行省略** —— 六行的说明字数差得多，
   * 允许换行的话每行高度都不一样，阶梯感就没了。
   */
  orderNote: css`
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: ${token.colorTextSecondary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,

  orderFoot: css`
    margin-top: ${token.marginXS}px;
    padding-top: ${token.marginXS}px;
    border-top: 1px dashed ${token.colorBorderSecondary};
    font-size: 12px;
    line-height: 1.7;
    color: ${token.colorTextSecondary};
  `,

  chainGrid: css`
    display: grid;
    grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
    gap: ${token.marginSM}px;
    align-items: start;

    /*
     * 两栏都是 docBlock，且互为**相邻兄弟** —— 会命中 docBlock 自带的
     * & + & { margin-top } （那条规则是给「同栏纵向堆叠」用的），
     * 于是右栏被整体压低 12px，两栏不再 align-top。
     * 栅格的 gap 已经负责了全部间隔（窄屏堆叠时是行间隔），
     * 这里把栏内的 margin-top 清零。
     * && 是 emotion 的提权写法：.chainGrid.chainGrid > div (0,2,1)
     * 压过 .docBlock + .docBlock (0,2,0)，不依赖样式表先后顺序。
     */
    && > div {
      margin-top: 0;
    }

    @media (max-width: 1180px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,

  /**
   * 两栏的标题头必须**等高**。
   *
   * 右栏头里多一个「重置」按钮（24px），左栏头只有文字（约 22px）——
   * 不等高的两个头会让下面两栏正文差出几像素，看着就是"上方留白不一致"。
   * 给一个 min-height 把矮的那栏撑起来，两栏正文才在同一条基线上。
   */
  chainHead: css`
    min-height: 32px;
  `,

  // ---------------- 左：处理器库 ----------------
  libScroll: css`
    margin-top: ${token.marginXS}px;
    max-height: 460px;
    overflow-y: auto;
  `,

  libGroup: css`
    margin-bottom: 10px;
  `,

  libGroupTitle: css`
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
    font-size: 12px;
  `,

  libGroupKey: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,

  /** L3：库条目。固定 34px —— 一屏能放下十几个，扫读效率比卡片高。 */
  libItem: css`
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 4px 0 8px;
    margin-bottom: 4px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 7px;
    background: ${token.colorBgContainer};
    transition:
      border-color 0.15s ease,
      background 0.15s ease;

    &:hover {
      border-color: ${token.colorPrimaryBorder};
      background: ${token.colorPrimaryBg};
    }
  `,

  libItemDisabled: css`
    opacity: 0.55;

    &:hover {
      border-color: ${token.colorBorderSecondary};
      background: ${token.colorBgContainer};
    }
  `,

  libName: css`
    flex: 0 0 auto;
    font-weight: 600;
    font-size: 12.5px;
    white-space: nowrap;
  `,

  /** key 可压缩：全称标签比 key 更需要空间，空间不够时先牺牲 key。 */
  libKey: css`
    flex: 0 1 auto;
    min-width: 0;
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    color: ${token.colorTextTertiary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,

  libTags: css`
    display: flex;
    gap: 3px;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  `,

  libSep: css`
    width: 1px;
    height: 14px;
    flex: 0 0 auto;
    background: ${token.colorBorderSecondary};
  `,

  arrowBtn: css`
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    padding: 0;
    font: inherit;
    border: 1px solid ${token.colorPrimary};
    border-radius: 6px;
    background: ${token.colorBgContainer};
    color: ${token.colorPrimary};
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${token.colorPrimary};
      color: #fff;
    }

    &:disabled {
      border-color: ${token.colorBorder};
      color: ${token.colorTextTertiary};
      cursor: not-allowed;
    }
  `,

  // ---------------- 右：洋葱时间轴 ----------------
  onion: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,

  chainEmpty: css`
    padding: 16px;
    text-align: center;
    font-size: 12.5px;
    color: ${token.colorTextTertiary};
  `,

  chainRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 1px solid ${token.colorBorder};
    border-radius: 7px;
    background: ${token.colorBgContainer};
    cursor: grab;
    position: relative;
    /* 兜底：内容再挤也不许溢出到行外 —— 曾经把右侧的 ⚙ / ✕ 整个顶到行外面
       （行里所有子元素都是 flex: 0 0 auto，谁都不让位）。 */
    overflow: hidden;
    /* 手搓 pointer 拖拽的前提：禁掉浏览器自己的触摸滚动与文本选中 */
    touch-action: none;
    user-select: none;
    transition:
      box-shadow 0.2s ease,
      border-color 0.2s ease;

    &:hover {
      border-color: ${token.colorBorder};
      box-shadow: ${token.boxShadowTertiary};
    }
  `,

  /** AROUND 行：左边 3px 用配对色。颜色由行内 --pair 提供（配对色是成对分配的）。 */
  chainRowPair: css`
    border-left: 3px solid var(--pair, ${token.colorPrimary});
  `,

  chainRowTool: css`
    justify-content: center;
    cursor: default;
    border-style: dashed;
    /* 在 L2 tertiary 面板上用 quaternary —— 比面板浅，才看得出是"分界线" */
    background: ${token.colorFillQuaternary};
    font-weight: 600;
    color: ${token.colorTextSecondary};

    &:hover {
      box-shadow: none;
    }
  `,

  chainRowOff: css`
    opacity: 0.45;
  `,

  /** 同一对 AROUND 的进 / 出两行同时高亮 —— 说明它们是一个整体。 */
  chainRowMoving: css`
    border-color: var(--pair, ${token.colorPrimary});
    box-shadow: 0 0 0 2px var(--pair-soft, ${token.colorPrimaryBorder});
    z-index: 2;
  `,

  /** 被抓起来那一行留下的占位槽：尺寸留着，内容隐藏。 */
  chainRowSlot: css`
    background: repeating-linear-gradient(
      135deg,
      ${token.colorFillQuaternary} 0 6px,
      ${token.colorFillTertiary} 6px 12px
    );
    border: 1px dashed ${token.colorBorder};
    box-shadow: none;

    & > * {
      visibility: hidden;
    }
  `,

  /** 磁吸成功：占位槽转实线 + 主色 —— 告诉用户"松手就落这儿"。 */
  chainRowSnap: css`
    border-style: solid;
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
  `,

  /** 落点不合法：转红。松手会弹回，这里提前把"要被拒"说清楚。 */
  chainRowBad: css`
    border-style: dashed;
    border-color: ${token.colorError};
    background: repeating-linear-gradient(
      135deg,
      ${token.colorErrorBg} 0 6px,
      ${token.colorErrorBorder} 6px 12px
    );
  `,

  chainIdx: css`
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 20px;
    height: 20px;
    border-radius: 5px;
    background: ${token.colorFillSecondary};
    color: ${token.colorTextTertiary};
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
  `,

  pairDot: css`
    flex: 0 0 9px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--pair, ${token.colorPrimary});
  `,

  pairDotPlaceholder: css`
    flex: 0 0 9px;
    width: 9px;
  `,

  chainArrow: css`
    flex: 0 0 auto;
    font-family: ${token.fontFamilyCode};
    font-weight: 700;
    color: var(--pair, ${token.colorPrimary});
    white-space: nowrap;
  `,

  chainName: css`
    flex: 0 0 auto;
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
  `,

  /**
   * 名称 + 类型 / hook / mode 标签的**容器**。
   *
   * ⚠️ 这一层是必需的，不是装饰。这些子元素各自都是 `flex: 0 0 auto`（不可压缩），
   * 直接摆在 .chainRow 里时**谁都不让位** —— 面板一窄整行内容就溢出，
   * 右侧的 ⚙ / ✕ 被顶到行外面去（用户截图里的现象）。
   *
   * 装进这个 `flex: 1 1 auto; min-width: 0` 的容器后：空间不足时只有它变窄，
   * 内部内容从**右端**被裁掉（于是最先淡出的是最靠右的 mode 标签，依次向左），
   * 再配上 chainBodyFade 的遮罩做渐隐。
   */
  chainBody: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  `,

  /**
   * 真的溢出时才加这个类（JS 量 scrollWidth > clientWidth 决定）。
   * 无条件挂着遮罩的话，没溢出时也会把最后一个标签的右边缘淡掉 —— 那是个错误信号。
   */
  chainBodyFade: css`
    -webkit-mask-image: linear-gradient(
      to right,
      #000 calc(100% - 22px),
      transparent 100%
    );
    mask-image: linear-gradient(
      to right,
      #000 calc(100% - 22px),
      transparent 100%
    );
  `,

  /**
   * 右侧的 depth + ⚙ / ✕。`flex: 0 0 auto`：永远贴行尾、永远不被压缩 ——
   * 缩容时该让位的是左边那串标签，不是操作按钮。
   * 左侧 chainBody 的 `flex-grow: 1` 已经把它顶到最右边，不需要 margin-left: auto。
   */
  chainActions: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  `,

  chainDepth: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,

  /**
   * 通用小标签。具体配色交给**属性选择器**而不是再拆一堆 class ——
   * 因为拖拽时要直接改 DOM 上的 data-hook 做翻牌，
   * 而 emotion 的类名是哈希的，JS 里拼不出来；data 属性则随时可改。
   */
  chainTag: css`
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    height: 18px;
    padding: 0 6px;
    border-radius: 5px;
    font-size: 11px;
    line-height: 1;
    white-space: nowrap;
    background: ${token.colorFillSecondary};
    color: ${token.colorTextSecondary};

    &[data-ptype='INTERCEPTOR'] {
      background: #fff7e6;
      color: #d46b08;
    }
    &[data-ptype='TRANSFORMER'] {
      background: #f9f0ff;
      color: #722ed1;
    }
    &[data-ptype='OBSERVER'] {
      background: #e6fffb;
      color: #08979c;
    }

    &[data-hook='BEFORE'] {
      background: ${token.colorInfoBg};
      color: ${token.colorInfoText};
    }
    &[data-hook='AFTER'] {
      background: ${token.colorSuccessBg};
      color: ${token.colorSuccessText};
    }
    &[data-hook='AROUND'] {
      background: ${token.colorErrorBg};
      color: ${token.colorErrorText};
    }
    /* 拖到不支持的 hook 上：翻牌后标红，表示松手会被拒 */
    &[data-invalid='true'] {
      background: ${token.colorErrorBg};
      color: ${token.colorErrorText};
      box-shadow: inset 0 0 0 1px ${token.colorErrorBorder};
    }

    &[data-mode='ASYNC'] {
      background: ${token.colorWarningBg};
      color: ${token.colorWarningText};
    }

    &[data-off='1'] {
      background: ${token.colorFillTertiary};
      color: ${token.colorTextTertiary};
    }

    /* 「已挂 ×N」—— 提示可重复挂载，但不如"停用"那么需要退后 */
    &[data-used='1'] {
      background: ${token.colorPrimaryBg};
      color: ${token.colorPrimary};
    }
  `,

  iconBtn: css`
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    padding: 0;
    font: inherit;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: ${token.colorTextTertiary};
    cursor: pointer;

    &:hover {
      background: ${token.colorFillSecondary};
      color: ${token.colorPrimary};
    }
  `,

  iconBtnDel: css`
    &:hover {
      background: ${token.colorErrorBg};
      color: ${token.colorError};
    }
  `,

  /**
   * 跟随指针的浮层。position 用 !important —— 它克隆自一行 .chainRow，
   * 那条规则里的 position: relative 会盖掉 fixed。
   */
  floater: css`
    position: fixed !important;
    left: 0;
    top: 0;
    z-index: 1100;
    margin: 0 !important;
    pointer-events: none;
    transform-origin: 0 0;
    will-change: transform;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.18);
    border-radius: 7px;
  `,

  // ---------------- 校验 / 表单 ----------------
  checks: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,

  check: css`
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 7px;
    font-size: 12.5px;
    background: ${token.colorSuccessBg};
    border: 1px solid ${token.colorSuccessBorder};
    color: ${token.colorSuccessText};
  `,

  checkBad: css`
    background: ${token.colorErrorBg};
    border-color: ${token.colorErrorBorder};
    color: ${token.colorErrorText};
  `,

  checkWarn: css`
    background: ${token.colorWarningBg};
    border-color: ${token.colorWarningBorder};
    color: ${token.colorWarningText};
  `,

  field: css`
    margin-bottom: 12px;
  `,

  fieldLabel: css`
    margin-bottom: 4px;
    font-size: 12.5px;
    color: ${token.colorTextSecondary};
  `,

  fieldDesc: css`
    margin-top: 3px;
    font-size: 11.5px;
    color: ${token.colorTextTertiary};
  `,

  fieldDivider: css`
    margin: 12px 0 10px;
    border-top: 1px solid ${token.colorBorderSecondary};
  `,

  /**
   * 页签底部的操作行 —— 全页统一：左侧状态文案，右侧按钮（放弃修改 + 主按钮保存）。
   * 之前 DocEditor / ClassEditor 用 Card 的 actions（三等分摊开、按钮一左一右），
   * 处理链用右对齐行，同一个页面里两套按钮排版 —— 统一成后者。
   */
  actionsRow: css`
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
    margin-top: ${token.marginSM}px;
  `,
}));
