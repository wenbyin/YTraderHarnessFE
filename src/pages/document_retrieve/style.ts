// src/pages/document_retrieve/style.ts
//
// 配色分层（浅色主题下最容易踩的坑）：
//   L0 页面底色 = colorBgLayout
//   L1 卡片     = colorBgContainer（白）—— antd Card 自带
//   L2 卡内面板 = colorFillTertiary（灰）+ colorBorderSecondary 边框
//   L3 面板内块 = colorBgContainer（白）+ colorBorderSecondary 边框
//
// 为什么必须分层：Card 是白的，卡里再放一个白底 + 1px 浅灰边的面板，
// 视觉上就是「白底套白底」，只剩一根几乎看不见的线。所以 L2 一律染色，
// 需要再嵌一层时回到白底 —— 靠**底色反转**而不是靠加粗边框来分层。
//
// 注意：这个文件里的注释都写在 css 模板**内部**，所以正文里不能出现反引号 ——
// 一个反引号就会把模板字符串提前闭合。
import { createStyles, keyframes } from 'antd-style';
import { PIPELINE_KEY_COLOR } from './data';

/**
 * 覆盖提示自动淡出的时长。
 * CSS 动画时长与 index.tsx 里「动画播完再卸载节点」的定时器共用这一个值，
 * 改这里两边同时生效，不会出现动画没播完节点就被摘掉的错位。
 */
export const OVERRIDE_TIP_FADE_MS = 420;

/**
 * 淡出 + 收拢高度。只做 opacity 的话高度会一直占着，最后被 JS 摘掉时
 * 下面的内容会突然往上跳一段；把 max-height 和 margin 一起收到 0，
 * 高度就是平滑让位给兜底提示行的。
 */
const overrideTipLeave = keyframes`
  from {
    opacity: 1;
    transform: translateY(0);
    max-height: 220px;
    margin-bottom: 12px;
  }
  to {
    opacity: 0;
    transform: translateY(-6px);
    max-height: 0;
    margin-bottom: 0;
  }
`;

export const useStyles = createStyles(({ css, token, prefixCls }) => {
  /**
   * L2 面板：白卡片里的一层浅灰容器。
   *
   * 抽成变量而不是每处各写一遍：这一档底色与描边在「运行时覆盖」「定向召回路径」
   * 「每路召回参数」「执行链路节点」四处都出现（见文件头的分层说明），改一处忘
   * 一处，同一个层级就会在同一屏上变成两种灰 —— 那正是这份配色要解决的问题。
   */
  const l2Panel = css`
    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
  `;

  return {
    layout: css`
    display: grid;
    grid-template-columns: 400px minmax(0, 1fr);
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

    // ---------------- 召回范围：已选列表 ----------------
    selectedList: css`
    display: flex;
    flex-direction: column;
    gap: ${token.marginXS}px;
    margin-top: ${token.marginSM}px;
    max-height: 260px;
    overflow-y: auto;
  `,

    /** L2：卡内面板。白色 Card 里再放白底 = 看不出边界，所以染一层灰。 */
    selectedItem: css`
    display: flex;
    align-items: flex-start;
    gap: ${token.marginXS}px;
    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};

    &:hover {
      border-color: ${token.colorPrimaryBorder};
    }
  `,

    selectedMain: css`
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,

    removeBtn: css`
    flex: 0 0 auto;
    color: ${token.colorTextQuaternary};
    &:hover {
      color: ${token.colorError};
    }
  `,

    // ---------------- 执行链路 ----------------
    flow: css`
    display: flex;
    align-items: stretch;
    gap: 0;
    overflow-x: auto;
    padding-bottom: 2px;
  `,

    /** L2：链路节点。与结果条同一档灰，四个阶段才立得住。 */
    flowNode: css`
    ${l2Panel}
    flex: 1 1 0;
    min-width: 132px;
  `,

    /** 覆盖提示被手动关掉后的兜底行（说明边界还在，别让人以为恢复默认了）。 */
    overrideTipHint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 12px;
  `,

    /**
     * 覆盖提示在「可见」状态下的常规样式。
     * 间距放 class 而不是 inline style：淡出动画要连 margin 一起收，
     * inline style 会和动画抢同一个属性。
     */
    overrideTip: css`
    margin-bottom: 12px;
  `,

    /**
     * 覆盖提示的离场动画（5 秒后自动播，播完由 JS 卸载节点）。
     * forwards 锁住终态，避免动画结束后 opacity 弹回 1。
     */
    overrideTipLeaving: css`
    overflow: hidden;
    animation: ${overrideTipLeave} ${OVERRIDE_TIP_FADE_MS}ms ease-in forwards;

    @media (prefers-reduced-motion: reduce) {
      animation-duration: 1ms;
    }
  `,

    /**
     * L2：运行时覆盖的分组容器。
     * Collapse 用 ghost（antd 会去掉自带底色与外框），把这层染色交给我们，
     * 免得去跟折叠面板的选择器权重较劲。
     */
    overrideGroup: css`
    ${l2Panel}

    /**
     * ghost 会把每个折叠项的 border-bottom 一起清零，四段之间就没有分隔线了，
     * 这里补一条自己的。
     *
     * 用 border-top 而不是 border-bottom：ghost 只声明了 border-bottom: 0，
     * 没有任何规则跟 border-top 抢 —— 这样就不必靠重复 class 去提权。
     *
     * 类名走 prefixCls 而不是写死前缀：antd-style 会把 ConfigProvider 的
     * 组件前缀传进来，将来换前缀这里不用改。
     */
    & .${prefixCls}-collapse-item + .${prefixCls}-collapse-item {
      border-top: 1px dashed ${token.colorBorderSecondary};
    }
  `,

    flowArrow: css`
    flex: 0 0 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${token.colorTextQuaternary};
  `,

    // ---------------- 结果卡片 ----------------
    /** L2：结果条。同样染灰，让每条结果在白色 Card 里立得住。 */
    resultItem: css`
    display: flex;
    gap: ${token.marginSM}px;
    padding: ${token.paddingSM}px ${token.padding}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillTertiary};
    margin-bottom: ${token.marginSM}px;

    &:hover {
      border-color: ${token.colorPrimaryBorder};
    }
  `,

    rank: css`
    flex: 0 0 32px;
    height: 32px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillSecondary};
    color: ${token.colorTextSecondary};
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
  `,

    resultMain: css`
    flex: 1;
    min-width: 0;
  `,

    /** L3：结果正文块。外面那层已经染灰，这里回到白底 —— 靠反转分层，不靠加粗边。 */
    content: css`
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
  `,

    /**
     * 命中描出：直接盖在正文的字上，不额外占版面。
     *
     * 暖黄底 + 继承字色 —— mark 的浏览器默认样式是「黄底黑字」，
     * 深色主题下那个黑色会看不清，所以颜色必须显式继承正文。
     *
     * 切换路径的动画就压在同一个属性上，靠**目标状态**决定走哪条过渡：
     *   变亮 → 用本类，带 180ms delay，等旧的先淡完再亮起来；
     *   变暗 → 用 markOff，无 delay，立刻开始淡。
     * 于是「先渐隐、再渐亮」是这个类对自然产生的顺序，不需要定时器，
     * 也不需要把正文渲染两遍做交叉淡入。
     */
    mark: css`
    border-radius: 2px;
    color: inherit;
    background: ${token.colorWarningBgHover};
    transition: background-color 180ms ease-out 180ms;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

    /**
     * 未命中态：跟 mark 是**同一批元素**（见 data.ts 的 markCells），
     * 只是底色透明 —— 元素不重挂，过渡才有得跑。
     *
     * 两边都不给左右 padding：非命中的单元也带 padding 的话，会在正文里
     * 每隔一段就插进 2px 空隙，整句看起来像被拆开了。底色的边界贴着字就行。
     */
    markOff: css`
    border-radius: 2px;
    color: inherit;
    background: transparent;
    transition: background-color 180ms ease-out;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

    /** 结果条头部一行：路径切换控件 + 说明，窄了能换行。 */
    routeSwitch: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${token.marginXS}px;
  `,

    /** 路径标记点：6px 圆点，比 Tag 轻 —— 控件里再套 Tag 会变成双重边框。 */
    pathDot: css`
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  `,

    /**
     * 圆点的几个色值 —— 与 data.ts 的 PIPELINE_KEY_COLOR 一一对应。
     * 不写死在组件里是因为那需要一个 token；色板值只有这里拿得到。
     */
    pathDotBlue: css`
    background: ${token.blue};
  `,

    pathDotOrange: css`
    background: ${token.orange};
  `,

    pathDotPurple: css`
    background: ${token.purple};
  `,

    pathDotCyan: css`
    background: ${token.cyan};
  `,

    pathDotNeutral: css`
    background: ${token.colorTextQuaternary};
  `,

    contentClamp: css`
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `,

    /** 结果条底部一行：左边「展开全文」，右边「这一档没标到」的结论。 */
    resultFooter: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginSM}px;
    margin-top: 6px;
  `,

    /**
     * 右下角那行结论。
     *
     * 作为 flex 子项会被块化，text-align 才生效 —— 直接给 Typography.Text
     * 写 text-align 是不起作用的（它渲染成行内 span）。
     * 原因说明放进 title：结论要短，但「为什么」不能丢。
     */
    footerNote: css`
    font-size: 11px;
    text-align: right;
    color: ${token.colorTextTertiary};
  `,

    scoreTrack: css`
    width: 80px;
    height: 6px;
    border-radius: 999px;
    background: ${token.colorFillSecondary};
    overflow: hidden;
  `,

    scoreFill: css`
    height: 100%;
    border-radius: 999px;
    background: ${token.colorPrimary};
  `,

    metaGrid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 2px ${token.margin}px;
    margin-top: ${token.marginXS}px;
  `,

    metaItem: css`
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

    /** L2：请求体 JSON 块。原本 quaternary 在白 Card 上太淡，提到 tertiary 并补边框。 */
    requestPreview: css`
    margin: 0;
    max-height: 280px;
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

    /** 查询输入框下方一行：计数在左，按钮贴右。 */
    inputActions: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginXS}px;
    margin-top: ${token.marginSM}px;
  `,

    hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.7;
  `,

    /** 开关 + 说明的两列排布：开关只有十几 px，不能让它跟文字挤在一行里。 */
    switchRow: css`
    display: flex;
    align-items: flex-start;
    gap: ${token.marginXS}px;
    margin-top: ${token.marginSM}px;
    padding-top: ${token.paddingSM}px;
    border-top: 1px dashed ${token.colorBorderSecondary};
  `,

    switchBody: css`
    flex: 1;
    min-width: 0;
  `,

    mono: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
  `,

    // ---------------- 路由降级 ----------------
    degradedList: css`
    display: flex;
    flex-direction: column;
    gap: ${token.marginXS}px;
  `,

    degradedItem: css`
    padding: ${token.paddingXS}px ${token.paddingSM}px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
  `,

    // ---------------- Agentic 占位（空置） ----------------
    /** L2：与其它卡内面板同一档灰，靠虚线边表明这里还没实现。 */
    placeholder: css`
    border: 1px dashed ${token.colorBorder};
    border-radius: ${token.borderRadiusLG}px;
    padding: ${token.paddingLG}px;
    background: ${token.colorFillTertiary};
  `,

    // ---------------- 定向召回路径（retrieval_types） ----------------
    /** L2：与「已选定义」同一档灰 —— 它同样躺在白色 Card 里。 */
    routeFilter: css`
    ${l2Panel}
    margin-top: ${token.marginSM}px;
  `,

    /** 标题行：左标题，右「已选 N / M」+ 全选。 */
    routeFilterHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginXS}px;
    margin-bottom: ${token.marginXXS}px;
  `,

    /** 一路都没勾时的告警：契约 minItems:1，这个状态发出去必然 422。 */
    routeWarn: css`
    font-size: 12px;
    color: ${token.colorError};
  `,

    // ---------------- 每路召回参数（retrieval_config） ----------------
    /** L2：与「定向召回路径」同一档灰 —— 两者是相邻的一对，必须同级。 */
    recallConfig: css`
    ${l2Panel}
    margin-top: ${token.marginSM}px;
  `,

    /** 一行 = 一个参数。标签定宽，四个参数的值才能竖着对齐扫下来。 */
    recallRow: css`
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
  `,

    recallLabel: css`
    flex: 0 0 84px;
    width: 84px;
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,

    /** 参数右侧的量纲/后果说明 —— 这一列是 retrieval_config 最容易填错的地方。 */
    recallNote: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.6;
  `,

    /** 单行填不下时的次级说明，压暗一档，不与主说明抢视线。 */
    recallSub: css`
    font-size: 12px;
    color: ${token.colorTextQuaternary};
    line-height: 1.6;
  `,
  };
});

export type RetrieveStyles = ReturnType<typeof useStyles>['styles'];

/**
 * 路径圆点的配色类。
 *
 * 颜色身份跟着 data.ts 的 PIPELINE_KEY_COLOR 走（换控件不能让配色断掉），
 * 但不能拿那个值直接当 CSS 颜色 —— 它是 antd 的**预设色名**，里面还有
 * 'default' 这种根本不是颜色的值。所以这里把名字翻成上面定义的类。
 *
 * 放在 style.ts 而不是组件里：色板值只有这里拿得到，而且「已选定义」、
 * 「定向召回路径」、「结果卡片」三处都要用同一个映射 —— 各写一份 switch，
 * 改一处忘一处，同一个 retrieval_type 就会在两屏上变成两种颜色。
 */
export function pathDotClass(styles: RetrieveStyles, key: string): string {
  switch (PIPELINE_KEY_COLOR[key]) {
    case 'blue':
      return styles.pathDotBlue;
    case 'orange':
      return styles.pathDotOrange;
    case 'purple':
      return styles.pathDotPurple;
    case 'cyan':
      return styles.pathDotCyan;
    default:
      return styles.pathDotNeutral;
  }
}
