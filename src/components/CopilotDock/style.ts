// src/components/CopilotDock/style.ts
//
// 形态：**固定在视口右侧、贯穿整高的常驻面板** —— 左侧菜单的镜像。
//
// 三条关键约定，改的时候别破：
//
//   1. **收起 = 完全不占位**。面板宽度走 `--copilot-dock-w`，收起时这个变量是 0，
//      内容区的 `padding-right` 也是 0（src/global.less），右侧只剩一个浮动展开图标
//      （`expandTab`）。展开时占可视宽度的 1/3。
//   2. 面板是 `position: fixed`、**不占文档流**；「挤开内容」这件事属于布局层，
//      由 index.tsx 把宽度写到 :root 上、global.less 里的 `.ant-pro-layout` 消费。
//      用固定像素（clientWidth/3）而不是 vw，是为了和布局的实际宽度同源 —— 有滚动条时
//      vw 会把滚动条算进去，导致内容和面板之间裂出一条缝。
//   3. 消息保持 **CopilotKit 原生结构**（气泡、对齐、hover 出现的操作按钮都是它自己的），
//      这里只做两件事：把它的 CSS 变量接到 antd 主题上、把消息外观改成卡片。
//      所以下面的 `.copilotKit*` 选择器全是**覆盖**，不是重写。
import { createStyles } from 'antd-style';

/* 退场动画的时长与 usePlanFeed 的移除定时器**共用同一个数** ——
 * 分开写两个魔数迟早会错位（动画没播完就消失 / 淡完了还杵着）。 */
import { PLAN_RETIRE_MS, PLAN_RISE_MS } from './planTasks';

/**
 * 推理折叠区展开/收起的动画时长（毫秒）。
 *
 * ⚠️ **必须只有这一处**：CSS 用它定过渡时长，`ReasoningBlock` 用它定"收起后
 *    多久把推理原文从 DOM 里摘掉" —— 两个数一旦不同，就会出现"动画还没播完
 *    文字先没了"（或反之，收起后 DOM 里留着一份看不见的原文）。
 */
export const REASONING_ANIM_MS = 220;

/**
 * 审批卡"内容折进标题行"的动画时长（毫秒）。
 *
 * ⚠️ 与 `REASONING_ANIM_MS` 分开写而不是复用它：两者是**两种不同的动效**
 *    （推理区是"展开一段文字"，这里是"整块控件收进一条状态栏"），
 *    将来调其中一个不该连带动另一个。
 */
const HITL_ANIM_MS = 220;

/**
 * 对话区的**三档间距** —— 全局只有这三种。
 *
 * 需求原话（2026-10-20）：「section 内 思考过程正文工具调用 间距全部相同
 * 为最小挡位；消息卡片和下方复制编辑返回 icon 间距 为中档；卡片与卡片之间
 * 间距相当 为最大档。一共只有这三种间距规格。消除所有元素自带的 margin，
 * padding 改为固定」。
 *
 *   ① SPACE_TIGHT  12px   section 内部（思考 / 正文 / 工具卡，含并行工具卡之间）
 *   ② SPACE_MID    12px   卡片 ↔ 卡片下方那行图标（复制 / 编辑 / 反馈）
 *   ③ SPACE_WIDE   48px   卡片 ↔ 卡片（section ↔ section）
 *
 * ⚠️ 取值来历（连着调了几轮，别再凭感觉改）
 * -------------------------------------
 *   初版 4 / 8 / 16 → 「一档翻三倍、二三相都加同一份差分 x」得 12 / 16 / 24
 *   （x = 8）→ 「三档再翻倍」得 24 / 32 / 48 → 2026-10-21 收尾一条：
 *   「二档间距和一档相同即可」→ 二档落回 24，与一档同值；
 *   同日再补一条：「一二挡间距全部减半」→ 24 / 24 减半成 12 / 12
 *   （三档不动 —— 需求只点名一二挡）。
 *
 *   ⚠️ 二档虽然现在**等于**一档，仍然保留成独立常量：它俩语义不同
 *      （"同一张卡片里的两段"vs"卡片与它的操作行"），哪天要重新拉开就只改一个数；
 *      直接写死同一个 12 会让"本来是两档"这件事从代码里消失。
 *   现在实际只剩两种视觉间距：卡片内部（含图标行）12、卡片之间 48。
 *
 * ⚠️ 三个值**只在这里出现一次**：组件类与 chatPane 的规则都引用它们，
 *    要调整就改这里（index.test.tsx 也按它们断言，一改两边同步）。
 * ⚠️ 别在别处写"这里再补 2px"之类的第四档 —— 需求明确只有三种。
 */
export const SPACE_TIGHT = 12;
/** 与一档同值（用户 2026-10-21：「二档间距和一档相同即可」），语义仍是独立的一档。 */
export const SPACE_MID = SPACE_TIGHT;
export const SPACE_WIDE = 48;

/**
 * 「从消息栏上移入对话」那个进入动画的位移（像素）与时长（毫秒）。
 *
 * ⚠️ 它们**不是**第四种间距：这是动画的行程，不参与任何元素之间的留白
 *    （卡片的落点与平时完全一样）。取值理由见 style.ts 里 cardEnter 的注释。
 */
export const CARD_ENTER_TRAVEL = 96;
export const CARD_ENTER_MS = 300;

export const useStyles = createStyles(({ css, token }) => ({
  /** 面板本体。宽度走变量 —— 展开是 1/3 屏宽，收起是 0（不可见，但**不卸载**）。 */
  panel: css`
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0; /* 跟左侧 sider 同级（sider 也是 100），且低于 antd 的弹层（1000+） */
    z-index: 100;
    display: flex;
    flex-direction: column;
    width: var(--copilot-dock-w, 0px);
    min-width: 0;
    overflow: hidden;
    background: ${token.colorBgContainer};
    border-inline-start: 1px solid ${token.colorBorderSecondary};
    box-shadow: -8px 0 24px -16px rgba(0, 0, 0, 0.28);
    transition:
      width 0.24s ease,
      box-shadow 0.24s ease;

    /* 头部高度。**这里和 historyPane 的上偏移必须同源** ——
       历史抽屉是 absolute 定位、靠 inset-block-start 让开头，
       两处各写一个 48px 的话，改了标题栏高度就会露出一条缝 / 反过来盖住标题。 */
    --dock-head-h: 56px;
  `,

  /**
   * 收起态。宽度已经被变量压到 0，但 1px 边框和投影还是会被画出来（0 宽元素照样有阴影），
   * 所以这里显式抹掉 —— 不然右侧会留一条头发丝细的线。
   */
  panelCollapsed: css`
    border-inline-start: 0;
    box-shadow: none;
  `,

  /**
   * 收起后留在右下角的展开按钮（悬浮圆球）。
   *
   * 为什么从"贴边竖中"改成右下角：竖中那圈把手会压在**内容区右下角的操作区**
   * 上（表格页脚、分页器那一带），点都点不准。挪到右下角后：
   *   · 底部本来就是空白区，不与任何内容重叠；
   *   · 距页脚也有一段距离，鼠标移过去才出现，不干扰阅读。
   *
   * 用圆形 + 投影（而不是原来那个"拉手"形状）是因为它现在是**独立悬浮球**
   * 而非边缘把手，圆形更符合"浮动按钮"的语义。
   * 偏移 20px 是为了不贴死屏幕边（贴死会显得像被切掉了）。
   */
  expandTab: css`
    position: fixed;
    inset-block-end: 20px;
    inset-inline-end: 20px;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 50%;
    background: ${token.colorBgContainer};
    color: ${token.colorPrimary};
    font-size: 19px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 6px 16px -6px rgba(0, 0, 0, 0.24);
    transition:
      background 0.2s ease,
      box-shadow 0.2s ease,
      transform 0.2s ease;

    &:hover {
      background: ${token.colorPrimaryBg};
      box-shadow: 0 8px 20px -6px rgba(0, 0, 0, 0.3);
      transform: translateY(-1px);
    }

    &:focus-visible {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: 2px;
    }
  `,

  /** 展开态的外壳：head / 对话区 两段纵向排（历史列表收进抽屉，不占位）。 */
  inner: css`
    position: relative;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  `,

  /**
   * 收起时把整块内容藏起来 —— 用 `display: none` 而**不是卸载**。
   * 卸载会连带把 CopilotKit 里的消息一起清掉，收起再展开对话就没了。
   */
  innerHidden: css`
    display: none;
  `,

  head: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: ${token.marginXS}px;
    height: var(--dock-head-h);
    padding-inline: ${token.padding}px ${token.paddingSM}px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    /* 高度给的是内容盒；抽屉的偏移要按「内容盒 + 这 1px 边框」算，
       见 historyPane 那条 ⚠️。 */
    box-sizing: content-box;
  `,

  /**
   * 左上角的「放大」标签 —— 只切换 1/3 ↔ 半屏（不碰折叠，见 index.tsx 的注释）。
   *
   * 为什么长得跟右侧那排动作按钮一样、而不是做成 antd 的 Tag：
   *   用户原话是「仿照菜单栏的扩大标签即可」—— 左侧菜单栏那个折叠把手就是
   *   一枚**无边框的图标按钮**。做成彩色 Tag 会跟"新建 / 历史 / 收起"那排
   *   变成两种视觉语言，同一个标题栏里并排出现会很吵。
   *
   * ⚠️ 图标尺寸走那两个 CSS 变量，理由与 headActions 那条完全相同。
   *    这枚**不在** headActions 容器里，所以得自己再给一遍 ——
   *    不给就退回 antd 默认的 14px，比右边三枚小一圈，看着像没对齐。
   */
  wideTab: css`
    flex: 0 0 auto;
    /*
     * ⚠️ 14px，与标题文字同字号（2026-10-22 用户：「缩小刚才添加的纵向高度」）。
     *    原来跟着右侧那排动作给的是 16px —— 但那排是**纯图标**，看着要够重；
     *    这枚是**标题的图标**，站在 14px 的文字旁边，16px 会显得比字还高一头，
     *    整行读起来"上重下轻"。图标本身就是宽的（斜向箭头），缩一档更稳。
     */
    --ant-button-only-icon-size: 14px;
    --ant-button-only-icon-size-sm: 14px;
  `,

  /**
   * 放大标签的外壳 —— 只为一件事存在：**收起时能把宽度平滑地收成 0**。
   *
   * 为什么不直接在按钮上写 `width: 0`：antd 的 icon-only 按钮自带
   *   `min-width: max(var(--ant-control-height-sm), …)`（24px），
   * 我们那条单类名（0,1,0）打不过它（0,3,0）—— 写了也不生效。
   * 包一层自己的盒子，宽度就归我们管了。
   *
   * 横向间距挂在这层上、不挂在按钮上：按钮被 `overflow: hidden` 夹在 24px 里，
   * 给它加 margin 只会把自己推出可视区，看着像被切掉一半。
   */
  wideTabSlot: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    /* antd small icon-only 按钮的边长（--ant-control-height-sm） */
    width: 24px;
    overflow: hidden;
    /* 图标 → 标题文字之间再补一段（2026-10-22 用户：「继续添加间距，只要横向」）。
       加上按钮自带的 4px 内边距与 head 的 8px gap，图标笔画到文字共 20px。 */
    margin-inline-end: ${token.marginXS}px;
    transition:
      width 0.22s ease,
      opacity 0.22s ease,
      margin-inline-end 0.22s ease;
  `,

  /**
   * 展开历史时：这枚标签**收掉**（需求：「展开对话历史的时候，扩大全屏就隐藏掉，
   * 只留 ‹ 历史对话」）。
   *
   * 用"宽度收到 0"而不是 `display: none`：后者会让标题栏左侧整块内容**瞬间左移**
   * 32px，和标题两态的淡入撞在一起，看着像闪了一下。
   */
  wideTabSlotClosed: css`
    width: 0;
    opacity: 0;
    margin-inline-end: 0;
    pointer-events: none;
  `,

  /** 兜底字号（真正生效的是上面两个变量，见 headActionIcon 的同一条说明）。 */
  wideTabIcon: css`
    font-size: 14px;
    line-height: 1;
  `,

  /**
   * 标题槽：把「YTrader Harness」和「历史对话」两态**叠在同一个位置**上。
   *
   * 为什么叠而不是换：需求要的是一个"转换动画"。用两态交叉淡入 + 横向位移，
   * 切换时是一段连续运动，而不是整块内容被替换掉（那样只会闪一下）。
   *
   * 两态都常驻 DOM —— 卸载再挂载就没有过渡可做了（元素是"新"的，
   * 不会从旧位置运动过来）。看不见的那一态用 opacity 0 + 一点点位移藏起来。
   */
  headTitleSlot: css`
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
  `,

  /** 标题层通用样式。absolute 叠放 + 过渡，具体显隐由 headTitleOn/Off 给。 */
  headTitleLayer: css`
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
    min-width: 0;
    /* ⚠️ 就是正文默认字号（14px）—— 不要"顺手"放大。
       面板只有屏宽 1/3，标题大字会挤掉右侧那排动作按钮的间距；
       而真正需要视觉重量的是**图标区**，那边单独放大（见 headActionIcon）。 */
    font-size: ${token.fontSize}px;
    font-weight: 600;
    color: ${token.colorText};
    white-space: nowrap;
    transition:
      opacity 0.24s ease,
      transform 0.24s ease;
  `,

  /** 显隐两态：位移只给 6px。太大就成了"飞进来"，不像标题在原地切换。 */
  headTitleOn: css`
    opacity: 1;
    transform: translateX(0);
  `,

  headTitleOff: css`
    opacity: 0;
    /* 藏起来的那一层往**来时的反方向**退，读起来才像"被换掉了" */
    transform: translateX(-8px);
    pointer-events: none;
  `,

  /**
   * 历史态的标题本身就是一个返回按钮。
   *
   * 做成 `<button>` 而不是 `<span>` + onClick：它要能被 Tab 到、能被 Enter/Space 触发。
   * 样式里把 button 的默认外观全部抹掉（跟 convItem 一个套路）。
   */
  headTitleBack: css`
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;

    &:hover {
      color: ${token.colorPrimary};
    }

    &:focus-visible {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: 4px;
      border-radius: ${token.borderRadiusSM}px;
    }
  `,

  /**
   * 标题前的图标（🤖 / ‹）。
   *
   * **不设 font-size** —— 跟文字一起用默认的正文 14px。
   * 之前放大到 fontSizeHeading3(24px) 配20px 标题，整行看着头重脚轻；
   * 而面板宽度只有 1/3 屏，右侧还要塞三个动作按钮，标题区不能抢。
   *
   * ⚠️ 只补**横向**间距（`margin-inline-end`），不碰行高 ——
   *    用户原话：「只要横向间距，不要纵向」。
   *    为什么不改 headTitleLayer 的 `gap`：那个 gap 同时管
   *    「历史对话 ↔ 共 N 个」，一起拉开会让计数飘远。
   */
  headTitleIcon: css`
    line-height: 1;
    margin-inline-end: ${token.marginXXS}px;
  `,

  headActions: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;

    /* ⚠️ 放大图标**必须走这两个 CSS 变量**，别在图标类上写 font-size。
       antd 给图标尺寸的规则长这样（用 :where 伪类，权重为 0）：
         .ant-btn.ant-btn-icon-only .anticon { font-size: var(--ant-button-only-icon-size) }
       —— :where() 不计权重，剩下那串已经是 0,3,0，
         emotion 的单类名（0,1,0）**稳输**给它（实测：图标类里写了 font-size:16px，
         computed 仍是 14px）。
       而这两个变量就是 antd 自己留的正规入口：设在这里、让它的规则去读，
       不用打特异性官司，也不会在 antd 后续版本改权重时突然失效。
       ⚠️ sm 与非 sm 两个都要给 —— size="small" 走 -sm 那条。 */
    --ant-button-only-icon-size: 16px;
    --ant-button-only-icon-size-sm: 16px;
  `,

  /**
   * 右侧动作按钮里的图标：比默认（14px）放大一档。
   *
   * 为什么放大的是**它们**而不是标题：这三枚是纯图标，没有文字标签，
   * 尺寸就是它们唯一的 affordance —— 14px 在 1/3 屏的窄面板里偏小、
   * 尤其「历史对话」那枚时钟图标细笔画多，14px 下几乎糊成一团。
   *
   * 16px 是"明显更大但还没到抢戏"的那一档。想再大要连按钮的 width/height
   * 一起放（`size="small"` 的按钮只有 24×24，图标撑到 20px 就顶到按钮边缘），
   * 那就变成"图标按钮"而不是"文字按钮"了，得整体重新设计。
   *
   * 这条 font-size 是**兜底**：真正生效的是上面 headActions 里那两个变量。
   * 万一哪天图标被挪到不受那两个变量管的位置（比如直接放一个裸图标），
   * 至少不会退回 14px。
   */
  headActionIcon: css`
    font-size: 16px;
    line-height: 1;
  `,

  /**
   * 历史抽屉：覆盖在对话区**之上**的一层。
   *
   * 为什么覆盖而不是并排：面板只有屏宽 1/3，聊天才是主角 ——
   * 常驻一条会话列表会吃掉 1/3 ~ 1/2 的高度，聊天被压得没法看。
   * 覆盖式（absolute）让对话区始终满高，点开历史是"临时看一眼"。
   *
   * 定位用 absolute 而不是 fixed：面板本身是 fixed，用 fixed 会跑到视口最右侧
   * 脱离这个 aside，收起态（宽度 0 + overflow hidden）时也藏不住。
   *
   * ⚠️ inset-block-start 是 --dock-head-h（head 的高度），**故意不盖住标题栏**
   *   盖住的话标题栏上的「返回对话」按钮连同它一起被遮掉，用户就只剩
   *   "怎么关掉这个全屏层" 一个疑问（实测踩过）。
   *   —— 需求要的正是「返回按钮就在一级标题上」，所以这个偏移是硬约束。
   *
   * ⚠️ z-index: 3 —— 只要 > 0 就够，因为 chatPane 是层叠上下文（见 chatPane
   *   那条注释）。**不要**以为需要跟 CopilotKit 的 30 比大小：那个 30 已经被
   *   关在对话区里了。这里给 3 只是为了「抽屉压住对话区」这一件事。
   */
  historyPane: css`
    position: absolute;
    /* ⚠️ 那个 +1px 是 head 的 border-bottom：
       head 的 height 是**内容盒** 56px，加上 1px 边框实际占 57px。
       偏移只写 56 的话抽屉会盖掉那条分隔线 —— 视觉上就是「标题栏下面那根线
       忽然没了」，而那根线正是「下面这一层是覆盖上来的」这个信息的唯一提示。
       与其把 head 的 height 改成 57（含边框）、让内容多出一像素，
       不如在这里显式补上，两边各自的需求都不被扭曲。 */
    inset-block: calc(var(--dock-head-h) + 1px) 0;
    inset-inline: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    background: ${token.colorBgContainer};

    /*
     * 页面切换动画（2026-10-22 用户：「点击新页面 / 历史页面，页面切换全部添加动画效果」）
     * ------------------------------------------------------------------------------
     * 这里是**关闭态**：往右退 24px + 透明。
     * 打开时由 historyPaneOpen 拉回原位 —— 两个方向都有动画，因为这一层
     * 现在**常驻挂载**（见 index.tsx 那条注释：条件渲染就没有退出动画了）。
     *
     * ⚠️ visibility 那条是故意带延迟了：
     *    关闭时先让 opacity 走完 0.22s 再变 hidden（否则元素当场消失，等于没动画）；
     *    打开时必须立刻 visible，所以 historyPaneOpen 里把它改回 0s。
     *    同时它也是"关着的时候里面那些按钮点不到、Tab 不到"的保证 ——
     *    比 display: none 温和，且不影响过渡。
     */
    opacity: 0;
    visibility: hidden;
    transform: translateX(24px);
    transition:
      opacity 0.22s ease,
      transform 0.22s ease,
      visibility 0s linear 0.22s;
  `,

  /** 打开态：拉回原位。`visibility` 立刻生效（见 historyPane 的 ⚠️）。 */
  historyPaneOpen: css`
    opacity: 1;
    visibility: visible;
    transform: translateX(0);
    transition:
      opacity 0.22s ease,
      transform 0.22s ease,
      visibility 0s linear 0s;
  `,

  /** 「共 N 个」：跟在标题右侧，弱化到不跟标题抢。 */
  historyCount: css`
    flex: 0 0 auto;
    /* 12 → 13：整块列表放大一档（2026-10-18 需求：字体放大）。写死 13 是因为
       antd 的 token 只有 12 / 14 两档，这里要的正好是"比标题小一档"。 */
    font-size: 13px;
    font-weight: 400;
    color: ${token.colorTextQuaternary};
  `,

  /**
   * 滚动列表。
   *
   * ⚠️ **上下不许留内边距**（2026-10-17 修「中间漏缝」踩实）
   * --------------------------------------------------
   *   吸顶标题的 `top: 0` 是相对**滚动容器**说的，但它同时被自己的**包含块**
   *   （`section`）夹住 —— 标题永远没法跑到 section 顶边之上。原来这里是
   *   `padding: 8px`，于是 section 的顶边在 8px 处，标题吸顶时只能停在 **8px**，
   *   0~8px 那条带子没有任何东西覆盖 → 滚过去的那一行会从缝里露出半截字。
   *   探针实测：`top=250` 时标题 pin 在 relTop **8**（不是 0）。
   *
   *   所以纵向间距一律由**标题自己的 padding-top** 出（见 historyGroupTitle），
   *   横向内边距留着（行本来就左右缩进，没有东西会露出来）。
   *   底下那 8px 是安全的：吸顶只会发生在顶部，底部没有东西会从下面穿过去。
   */
  historyList: css`
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 0 ${token.paddingXS}px ${token.paddingXS}px;
  `,

  /**
   * 一个分组（置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更久以前）。
   *
   * 标题吸顶：滚动长列表时始终知道当前这段是"7 天内"还是"30 天内"。
   * position: sticky; top: 0 生效的前提是滚动容器是 historyList 本身（sticky 相对最近的
   * 滚动祖先）—— 别给中间层加 overflow，那会把吸顶关掉。
   *
   * ⚠️ 组与组之间**不要用 `margin-top`**（2026-10-17 修「中间漏缝」踩实）：
   *   margin 在 section **外面**，标题吸顶时盖不住它，那 8px 会变成一个透明白条
   *   （上一组滚过去的行从缝里露出来）。间隔改由标题的 `padding-top` 出 ——
   *   那一段在 section **里面**，标题的底色能完整盖住。
   */
  historyGroup: css`
    display: flex;
    flex-direction: column;
  `,

  historyGroupTitle: css`
    position: sticky;
    top: 0;
    z-index: 1;
    /* 上 16 = 原来的「列表内边距 8 + 组间距 8」合并进来：间距必须在标题盒子**里面**，
       吸顶时才能被自己的底色盖住（见上面两条 ⚠️）。 */
    padding: ${token.padding}px ${token.paddingSM}px 4px;
    background: ${token.colorBgContainer};
    /* 分组标题只起"分隔"作用：比会话标题（14px）小两档，层级才读得出来。
       2026-10-18 整体放大一档：11 → 12（会话标题同时 12.5 → 14）。 */
    font-size: 12px;
    color: ${token.colorTextQuaternary};
  `,

  /**
   * 空状态。
   *
   * 为什么必须加：会话列表为空时用户看到的是**一片纯白**，
   * 配合"点了没反应"的错觉会以为功能坏了 —— 实测就踩到过这个
   * （截图里只有标题，看不出是列表还是空列表）。
   */
  historyEmpty: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
    padding: ${token.paddingXL}px ${token.padding}px;
    text-align: center;
  `,

  historyEmptyTitle: css`
    font-size: ${token.fontSize}px;
    color: ${token.colorTextSecondary};
  `,

  historyEmptyHint: css`
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextQuaternary};
  `,

  /**
   * 会话行 = 一个按钮（标题 + 时间）+ 一个「更多」按钮。
   *
   * **底色挂在「行」上，不挂在按钮上。** 原来 `convItem` 自己染蓝，于是选中的
   * 那一条只有标题那半截是蓝的、「⋯」吊在蓝条外的白底上，看着像按钮飘出来了。
   * 行染蓝之后，标题、时间、「⋯」都在同一条蓝条里（需求：拓展按钮在蓝条内部）。
   *
   * 「更多」仍是 convItem 的**兄弟节点**而不是子节点：convItem 自己是 button，
   * button 里再套 button 是非法 HTML，点击行为也会打架。
   */
  convRow: css`
    display: flex;
    align-items: center;
    gap: 2px;
    /* ⋯ 不贴蓝条右缘；左边留白交给 convItem 自己的 padding */
    padding-right: ${token.paddingXS}px;
    margin-bottom: 2px;
    border-radius: ${token.borderRadius}px;
    background: transparent;
    transition: background 0.2s ease;

    &:hover {
      background: ${token.colorFillSecondary};
    }

    /* 这一行 hover 时才把「更多」亮出来（按钮自己带 .yt-copilot-more）——
       面板经不起每行常驻一个图标。 */
    &:hover .yt-copilot-more {
      opacity: 1;
    }
  `,

  /**
   * 选中行。
   *
   * `&&` 是把特异性抬到 `convRow:hover` 之上：两者本来同级（都是 0,2,0），
   * 只写 `background` 的话 hover 会把蓝底盖成灰底 —— 鼠标停在当前会话上，
   * 那一条就"看起来没选中"了。
   */
  convRowActive: css`
    && {
      background: ${token.colorPrimaryBg};
    }

    &&:hover {
      background: ${token.colorPrimaryBg};
    }
  `,

  /**
   * 抽屉里的会话条目（按钮本体）。
   *
   * ⚠️ 这里**不能有底色**：底色在 convRow 上（见上）。留 `background: transparent`
   * 是为了压住 button 的 UA 底色 —— 不写的话 hover 时行灰、按钮白，又是一条断层。
   * 高度给到 42px（10px 上下 padding + 14px 正文），一行才像"可点的列表项"
   * 而不是一行文字。2026-10-18 字体放大一档后 padding 跟着 9 → 10，
   * 免得字变大了行反而显得更挤。
   */
  convItem: css`
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
    flex: 1 1 auto;
    min-width: 0;
    padding: 10px ${token.paddingSM}px;
    border: 0;
    border-radius: ${token.borderRadius}px;
    background: transparent;
    font: inherit;
    color: ${token.colorText};
    text-align: start;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: -2px;
    }
  `,

  /**
   * 选中态**只改文字颜色**，底色由 `convRowActive` 负责。
   * 两边都染一次就会出现"行是蓝的、按钮是另一层蓝"，中间还会有一条圆角缝。
   */
  convItemActive: css`
    color: ${token.colorPrimaryText};
  `,

  convTitle: css`
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* 12.5 → 14（2026-10-18 需求）：抽屉是"找上一条对话"的地方，标题是主信息，
       12.5px 在 1/3 屏宽的面板里偏小。 */
    font-size: ${token.fontSize}px;
  `,

  /**
   * 最后对话时间：行尾那一格，**贴右**、单行、不被标题挤掉。
   *
   * `tabular-nums` 是必须的：等宽数字才能让一列时间右缘对齐成一条竖线，
   * 否则 `11:11` 比 `10:00` 窄，看着像排版歪了。
   * `flex: 0 0 auto` 挡住标题的挤压 —— 标题自己会 ellipsis，时间是定宽信息。
   */
  convTime: css`
    flex: 0 0 auto;
    /* 11 → 12：跟着标题一起放大一档，仍然比标题小、颜色更淡（次级信息）。 */
    font-size: ${token.fontSizeSM}px;
    line-height: 1.4;
    color: ${token.colorTextTertiary};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,

  /**
   * 「更多」按钮：平时藏着，行 hover / 键盘聚焦时才亮。
   *
   * 需求把原来那个删除图标换成了「⋯」—— 一个入口挂多个操作
   * （删除 / 置顶 / 重命名 / 分享）。面板宽度只有 1/3 屏，四个图标常驻
   * 会把标题挤成两行，所以「⋯ + 悬停显示」是唯一能放下的排法。
   */
  convMore: css`
    flex: 0 0 auto;
    opacity: 0;
    transition: opacity 0.15s ease;

    &:focus-visible {
      opacity: 1;
    }
  `,

  /**
   * 置顶标记。
   *
   * 目前置顶动作还没接（菜单里是 disabled），所以正常情况下这一枚不会出现 ——
   * 留着它是因为数据层已经有 pinned 字段、解析也已经认它了（见 data.ts），
   * 一接上置顶就该立刻有视觉反馈，而不是那时候再回头补样式。
   */
  convPin: css`
    flex: 0 0 auto;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextQuaternary};
  `,

  /**
   * 历史加载态 / 失败态的提示条。
   *
   * 放在 chatPane 直属的子元素上（不是 CopilotKit 里面 —— 它是绝对定位的一层，
   * 塞进去会被聊天界面的布局当成消息区的一部分）。
   *
   * 用 absolute 而不占位：加载历史期间聊天区可能正在显示流式回复，
   * 冒出一个占位的条会把内容整体顶下去；"正在加载"这件事以叠加层告知更合适。
   * 前提是 chatPane 是定位上下文（它是 position: relative）。
   */
  historyTip: css`
    position: absolute;
    top: 8px;
    left: 50%;
    z-index: 2;
    display: flex;
    gap: 6px;
    align-items: center;
    max-width: calc(100% - 24px);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    background: ${token.colorBgElevated};
    box-shadow: ${token.boxShadowTertiary};
    transform: translateX(-50%);
  `,

  /** 失败态用错误色，跟"加载中"一眼能分开。 */
  historyTipError: css`
    color: ${token.colorError};
  `,

  /**
   * 空对话的问候语（「你好，我能帮什么忙吗？」）：**居中 + 加粗**。
   *
   * 它替代了 CopilotKit 的 labels.initial（那条假助手消息），见 index.tsx。
   *
   * ⚠️ inset-block-end: var(--dock-input-h) 是必须的
   * -------------------------------------------------
   *   对话区（chatPane）下面那 186px 是输入框 + Powered by，**不属于消息可视区**。
   *   直接 inset: 0 居中会落在整个对话区的中心，比消息区的中心**低 60px**
   *   （实测：消息区 48~780 → 中心 414；对话区 48~900 → 中心 474）。
   *   压掉输入区那一条，居中的才是"看起来该在的位置"。
   *
   * pointer-events: none：这层铺满整块消息区，底下就是消息 / 输入区的命中范围，
   *   一个纯展示层没理由抢点击。
   */
  emptyHint: css`
    position: absolute;
    inset-block: 0 var(--dock-input-h, 0px);
    inset-inline: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-inline: ${token.paddingLG}px;
    font-size: ${token.fontSizeHeading4}px;
    font-weight: 600;
    line-height: 1.5;
    color: ${token.colorText};
    text-align: center;
    pointer-events: none;
  `,

  /**
   * 「正在整理上下文…」那一层（看不见正文的模型调用还在跑）。
   *
   * ⚠️ 与 `hitlLayer` 同款手法（absolute + 压掉输入框那条 + 贴底），
   *    但 **z-index 比它低**：审批卡是要你动手的东西，它出现时必须在上面 ——
   *    而这段时间模型通常已经被拦下来了，两层同时出现反而说明别的地方有问题。
   *
   * ⚠️ pointer-events: none 同 hitlLayer：这一层铺在消息区上面，
   *    不关掉命中就没法滚动消息去读上文。
   */
  hiddenWorkLayer: css`
    position: absolute;
    inset-block: 0 var(--dock-input-h, 0px);
    inset-inline: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: flex-start;
    /* 左右与**输入框**同一条边（2026-10-21 用户：「正在组织回答胶囊和下面
     * 对话框左对齐」）：.copilotKitInput 的左右外边距是 token.padding（16），
     * 所以这里也用 16，胶囊的左边缘正好落在灰框的左边缘上。
     *
     * ⚠️ 以前用的是 --dock-text-inset（56 = 正文那条线）：那时这一层里还画
     *    着"已跑完的工具记录"，它们必须与消息流里的同一张卡对齐。工具记录
     *    搬进消息流之后（见文件头），这一层只剩胶囊 —— 胶囊属于输入区那一族，
     *    跟正文对齐反而会左突 40px。
     *
     * ⚠️ 底边从 12 收到 8（2026-10-22）
     * ------------------------------
     *   这一层最下面现在是那条「任务 / 子代理」dock，它的视觉语义是
     *   **输入框的第二行**（同底色、同圆角）。12px 的缝会让它看起来像浮在
     *   消息上的另一块卡片；8px 才接近参考里那种"贴在输入框上沿"的关系。
     *
     * ⚠️ 这个 8 同时是「胶囊 ↔ dock」的间距（用户 2026-10-22：
     *   「将 task board 和状态胶囊的间距和下方 input 框做成一样」）。
     *   所以它写成一个变量，hiddenWorkStack 的 gap 也读它 —— 两处一个数。 */
    --dock-gap: 8px;
    padding: ${token.paddingSM}px ${token.padding}px var(--dock-gap);
    pointer-events: none;
  `,

  /**
   * 这一层里的**内容**（工具记录 + 胶囊）。
   *
   * ⚠️⚠️ 这一层是必须的，不是多包一层
   * ------------------------------
   *   `--dock-tool-feed-h`（消息区的底部留白）必须等于"内容有多高"。
   *   外框 hiddenWorkLayer 是 `inset-block: 0 …` 铺满整块消息区的 —— 量它
   *   得到的是"消息区的高度"（实测 663px），写进 padding-bottom 就等于在
   *   消息底下塞一整屏空白：CopilotKit 收到用户消息时 `scrollTop = scrollHeight`
   *   正好滚到那片空白上，**已有消息全被顶出可视区，面板看起来一片空白**，
   *   只剩输入框上沿那枚「正在整理上下文…」胶囊（absolute，不受 padding 影响）。
   *   用户报的"发送消息之后对话框先全部变空"就是它。
   *   所以内容单独一层、高度自适应，量的是这一层（见 LiveActivityOverlay 的
   *   useReservedSpace）。别把这里拍平回外框直属子元素。
   *
   * ⚠️ max-height: 45% 必须挂在这里，不能留在 toolFeed 上
   * ------------------------------------------------
   *   百分比高度要对着**确定的**包含块才生效。外框高度是确定的（铺满消息区），
   *   45% 才有意义；toolFeed 现在挂在"内容自适应"的这一层下面，写 45% 会被
   *   当成 auto，限高直接失效（一屏十几个工具记录全铺出来，盖住正文）。
   *   45% 是"够看三四条、又至少留一半给正文"的位置，与原来同一个数。
   */
  hiddenWorkStack: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    align-self: stretch;
    max-height: 45%;
    min-height: 0;
    /* ⚠️ 与「dock ↔ 输入框」那条缝**必须是同一个数**（用户 2026-10-22：
     *   「将 task board 和状态胶囊的间距和下方 input 框做成一样」）。
     *   外框的 padding-bottom 用的是同一个变量，改一处两处一起动。 */
    gap: var(--dock-gap, 8px);
  `,

  /** 那枚胶囊。与 historyTip 同一个视觉语言（浮起的次要提示）。 */
  hiddenWorkChip: css`
    display: flex;
    gap: 6px;
    align-items: center;
    max-width: 100%;
    padding: 3px 10px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 999px;
    background: ${token.colorBgElevated};
    box-shadow: ${token.boxShadowTertiary};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
  `,

  /* ================================================================
   * 任务计划：输入框上方那一条左右两栏的 dock（PlanStatusBars）
   *
   * 它是 hiddenWorkStack 的成员（贴输入框上沿、absolute 那一摞里的最后一项），
   * 所以**宽度得自己撑满**（stack 是 align-items: flex-start），
   * 点按也要自己把 pointer-events 打开（外框是 none，不挡消息里的链接）。
   *
   * ⚠️ 视觉语言 = **输入框**
   * ---------------------
   *   需求原话："做成和输入框一样的风格，边角要有弧度"。
   *   所以底色 / 圆角 / 边框直接照抄 .copilotKitInput 那三行
   *   （见下面 chatPane 里 `& .copilotKitInput` 的注释）：
   *     background: colorFillQuaternary · border-radius: borderRadiusLG
   *     border: 1px solid transparent
   *   它看起来就是输入框往上长出来的第二行，而不是浮在消息上的另一块卡片。
   *   别改成白底 + 实边框：那样一眼就是"另一个控件"，断开视觉上的一体感。
   * ================================================================ */

  /**
   * 整条 dock 的外框：上圆角、下圆角，装「展开面板 + 标题行」。
   *
   * ⚠️⚠️ 底色必须**不透明**，否则消息正文会从框里透出来（2026-10-22 用户
   *   报的"task board 重叠"就是它）
   * ---------------------------------------------------------------
   *   输入框那套 `background: colorFillQuaternary` 是 `rgba(0,0,0,0.02)` ——
   *   在**白底**的输入区里没问题，但这条 dock 是 absolute 压在**消息**上的：
   *   2% 的黑盖不住任何字，底下那几行正文原样透出来，和后端推来的任务列表
   *   交错在一起，看上去就是"两个列表重叠"。
   *   这里改成两层：**不透明的白**打底 + 2% 黑叠在上面 —— 合成出来与输入框
   *   同色（都是 #fafafa 那个调子），但完全挡住后面的字。
   *   （不能只写 colorFillQuaternary，也不能用 opacity/半透明层。）
   */
  planDock: css`
    align-self: stretch;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    /*
     * ⚠️ 这条 dock 是一个**一格网格**，内容全在 planDockBody 那一格里
     * ------------------------------------------------
     *   入场动画要"从底部长出来、把上面的状态胶囊顶上去"，而 CSS 里能平滑
     *   过渡到**真实高度**的写法只有 grid-template-rows 的 0fr → 1fr
     *   （height: auto 不可过渡，max-height 过渡的是上限而不是实际高度，
     *   内容只有 24px 时前 9% 的时间就长满了 —— 看着像瞬间出现）。
     *   所以要有一个单独的格子来装内容：body 那一层，见 planDockBody。
     */
    display: grid;
    grid-template-rows: 1fr;
    border: 1px solid transparent;
    border-radius: ${token.borderRadiusLG}px;
    background-color: ${token.colorBgElevated};
    background-image: linear-gradient(
      ${token.colorFillQuaternary},
      ${token.colorFillQuaternary}
    );
    font-size: ${token.fontSizeSM}px;
    /* ⚠️ 外框（hiddenWorkLayer）是 pointer-events: none —— 不打开这里，
       两半边都点不动，展开功能等于不存在。 */
    pointer-events: auto;
    /*
     * ⚠️ max-height 常态给一个**够用的上限**（而不是 none）
     * ------------------------------------------------
     *   它是"退场"动画的终点：max-height 写成 none 就没法过渡到 0。
     *   260 = 标题行 23 + 面板 200（planDockPanel 的上限）+ 边框 2，留了余量。
     *   常态下它比内容高，所以平时完全不影响布局。
     */
    max-height: 260px;
    transition:
      background 0.2s ease,
      box-shadow 0.2s ease,
      max-height ${PLAN_RETIRE_MS}ms ease,
      opacity ${PLAN_RETIRE_MS - 60}ms ease,
      transform ${PLAN_RETIRE_MS}ms ease,
      grid-template-rows ${PLAN_RISE_MS}ms cubic-bezier(0.32, 0.72, 0, 1);

    /*
     * 入场：「从底部附上来」（用户 2026-10-22）。
     *
     * 起点是**真的零高度**（0fr）—— 因为栈是 flex-end 贴底排的，高度从 0 长
     * 到真实值的过程中，上面的状态胶囊被**均匀地**顶上去，而不是先出现再挤。
     * translateY 给一点方向感（它是"从下面浮上来"而不是"向上展开"），
     * 透明度让它在零高度那一瞬不至于看起来像一条 1px 的横线。
     *
     * ⚠️ 0fr 那一帧状态由渲染层给（PlanStatusBars 的 data-plan-rise），
     *    别改成纯 CSS 的 animation —— 它得等"计划第一次出现"那一刻才开始，
     *    而那件事只有 React 知道。
     * ⚠️ 浏览器不支持 grid-template-rows 过渡时，这里退化成"直接出现"，
     *    不会错位（该属性本身仍然生效）。
     */
    &[data-plan-rise='enter'] {
      grid-template-rows: 0fr;
      opacity: 0;
      transform: translateY(6px);
    }

    /* 展开时抬一层投影：它此刻盖着消息，得让人一眼看出"这是浮在正文上的一片"，
       而不是又一段正文。收起态不加 —— 那时它贴着输入框，本来就该平的。 */
    &[data-plan-open='task'],
    &[data-plan-open='agent'] {
      box-shadow: ${token.boxShadowSecondary};
    }

    /*
     * 退场：下一轮运行开始了（见 usePlanFeed 的 retire）。
     *
     * 三个属性一起收，读起来是"往下沉进输入框里、同时淡掉"：
     *   · max-height → 0 —— 高度也一起收，否则它消失的那一刻消息区会跳一下
     *     （--dock-tool-feed-h 突然归零，底部留白凭空少了 30px）；
     *   · opacity → 0；
     *   · translateY(6px) —— 顺着"往上展开"的反方向缩回去，方向感一致。
     * ⚠️ pointer-events 必须关：一个正在淡出的框还能点，点下去动的是
     *    马上要被删掉的计划。
     * ⚠️ 时长由 PLAN_RETIRE_MS 统一给（usePlanFeed 也在用同一个数做移除定时器）。
     */
    &[data-plan-state='retiring'] {
      max-height: 0;
      opacity: 0;
      transform: translateY(6px);
      pointer-events: none;
    }
  `,

  /**
   * 那条 dock 的**内容格** —— 高度过渡的载体（见 planDock 的 grid 说明）。
   *
   * ⚠️ 两个属性都是必须的，少一个 0fr 就压不下去：
   *   · `min-height: 0` —— 网格项的默认最小尺寸是 auto（= 内容高），
   *     不归零的话行高永远不会小于内容，0fr 等于没写；
   *   · `overflow: hidden` —— 挤到 0 的过程中内容要能被裁掉，否则它会
   *     溢出到输入框上去。
   * 它自己不画任何东西（底色 / 圆角 / 边框都在外层）。
   */
  planDockBody: css`
    min-height: 0;
    overflow: hidden;
  `,

  /**
   * 标题行：左右两栏 + 中间一条竖线。
   * `align-items: stretch` 让竖线能按分隔符自己的高（14px）居中。
   */
  planDockRow: css`
    display: flex;
    align-items: stretch;
    min-width: 0;
  `,

  /**
   * 半边（真 button，样式 reset 回"一行可点的条"）。
   *
   * ⚠️ `flex: 1 1 0` + `min-width: 0` 才是真正的"各占一半"：
   *    `flex: 1` 的基准是内容宽度，两边文案长短不同（"任务 1/3" vs "子代理"）
   *    就会一边宽一边窄，中间那条竖线跟着偏 —— 用户要的是"左半边 / 右半边"。
   *    min-width: 0 让里面的长文本能省略，而不是把宽度顶开。
   */
  planDockSeg: css`
    flex: 1 1 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    /* 上下内边距压到 2/3：整条 ≈23px，与 cc-gui 那一条同高（参考截图实测
     * 约 22px）。再高就变成"第二行控件"，会把输入框上方的留白吃掉。 */
    padding: 2px 12px 3px;
    border: 0;
    background: transparent;
    font: inherit;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;

    &:hover {
      background: ${token.colorFillTertiary};
    }

    &:focus-visible {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: -2px;
    }
  `,

  /**
   * 收起态那枚状态图标。颜色按语义态给（与任务行同一套规则）：
   * 在跑 = 主色（且 LoadingOutlined 自己转）、完成 = 成功、失败 = 错误，
   * 其余一律最次级灰（它们都是"没在动"）。
   */
  planDockIcon: css`
    flex: none;
    display: inline-flex;
    align-items: center;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextTertiary};

    &[data-phase='running'] {
      color: ${token.colorPrimary};
    }

    &[data-phase='done'] {
      color: ${token.colorSuccess};
    }

    &[data-phase='failed'] {
      color: ${token.colorError};
    }
  `,

  /**
   * 名字后面那枚小 loading（只在真有东西在跑时出现）。
   *
   * 比语义图标小一档、用次级色：它是"此刻在转"的旁注，不是主语。
   * ⚠️ 别把它做回图标位 —— 图标要说"这一栏是什么"（三条横杠 / 分叉），
   *    被 loading 顶掉之后就只剩"在忙"，看不出在忙什么。
   */
  planDockSpin: css`
    flex: none;
    font-size: 10px;
    color: ${token.colorTextTertiary};
  `,

  /** 「任务」/「子代理」这两个词。用主文本色 —— 它是这一栏的主语。 */
  planDockLabel: css`
    flex: none;
    font-weight: 600;
    color: ${token.colorText};
  `,

  /** 栏内计数（3/5）。等宽数字，避免 9/10 抖动。 */
  planDockCount: css`
    flex: none;
    font-variant-numeric: tabular-nums;
    color: ${token.colorTextTertiary};
  `,

  /** 把箭头顶到栏尾的占位。 */
  planDockGrow: css`
    flex: 1 1 auto;
    min-width: 0;
  `,

  /** 箭头：收起时朝上（提示"往上展开"），展开后转 180°。 */
  planDockCaret: css`
    flex: none;
    font-size: 9px;
    color: ${token.colorTextTertiary};
    transition: transform 180ms ease;
  `,

  planDockCaretOpen: css`
    transform: rotate(180deg);
  `,

  /** 两栏之间的分割线。高度 14px 居中，不铺满整行（那会像表格边框）。 */
  planDockDivider: css`
    flex: none;
    align-self: center;
    width: 1px;
    height: 14px;
    background: ${token.colorSplit};
  `,

  /**
   * 展开面板。**在标题行上方** → 整条框向上长（见 PlanStatusBars 文件头）。
   *
   * ⚠️ 用 max-height 做动画，不用 grid-template-rows
   * --------------------------------------------
   *   0fr → 1fr 的写法更优雅，但要 Chrome 117+ 才支持（而且和 overflow
   *   一起用时有已知的求值问题）。max-height 从 0 到一个确定的上限，
   *   是这套代码里其它地方（如抽屉）也在用的写法，稳。
   *   上限给 200px：它只是动画的终点，真正的限高在内层（见下一条）。
   *
   * ⚠️ 收起态 height 为 0 但**不 display: none**：display 一切换就没了过渡。
   *    内容里没有可聚焦元素（都是文本行），不需要额外的 inert。
   */
  planDockPanel: css`
    max-height: 0;
    overflow: hidden;
    opacity: 0;
    /* 收起时往下挪 6px —— 展开时它从下往上滑进位置，这就是"向上滑动"的手感 */
    transform: translateY(6px);
    transition:
      max-height 220ms ease,
      opacity 160ms ease,
      transform 220ms ease;

    &[data-open='true'] {
      max-height: 200px;
      opacity: 1;
      transform: translateY(0);
    }
  `,

  /**
   * 面板内层：负责内边距、与标题行的那条分隔线，以及**真正的限高 + 滚动**。
   * ⚠️ 任务可能有十几条，全铺出来会盖住大半消息区，而这一层没有滚动条托管
   *    （它贴在输入框上沿）。
   *
   * ⚠️ 底色比标题行**更白**（colorBgElevated，不叠那 2% 黑）
   * -----------------------------------------------------
   *   标题行还是"输入框第二行"的浅灰，展开出来的这块是**读内容的纸**：
   *   十几行描述压在上面，底色越干净越好读。两者之间靠 border-bottom 分开，
   *   圆角由外框裁 —— 别给这里单独加圆角（会在左上/右上露出直角）。
   */
  planDockPanelInner: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 192px;
    overflow-y: auto;
    padding: 8px 12px 6px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorBgElevated};
  `,

  /** 计划目标（goal）那一行。最次级色：它是背景，不是当前进度。 */
  planGoal: css`
    margin: 0 0 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextTertiary};
  `,

  planEmpty: css`
    margin: 0;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextTertiary};
  `,

  /**
   * 展开后的一个任务行：图标 + 标题（可省略）+ 元信息。
   *
   * ⚠️ 「现在跑的是哪一条」靠 `data-current` 高亮，不靠图标颜色
   * -------------------------------------------------------
   *   图标色说的是"任务状态"，current 说的是"后端此刻的执行焦点"。
   *   两者会短暂不同步（续租 / 切换到下一条的那一帧），混用一个信号会让
   *   用户看到"两个任务同时是执行中"。
   *   底色用 colorPrimaryBg（淡淡的主色），在 colorFillQuaternary 的面板里
   *   刚好够显眼、又不至于像一条错误提示。
   */
  planTaskRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 1px 4px;
    border-radius: ${token.borderRadiusSM}px;
    line-height: 1.7;
    color: ${token.colorText};
    transition: background 0.15s ease;

    &[data-current='true'] {
      background: ${token.colorPrimaryBg};
    }
  `,

  /**
   * 状态图标。
   *
   * ⚠️ 颜色由**图标自己**的 data-phase 决定，不从父行继承 ——
   *   父行一旦也带上 data-phase，后面想给"整行"加底色时就会连带把图标色
   *   一起改掉（两个规则抢同一个属性，谁赢看注入顺序）。
   *   现在只有三种有语义的颜色：在跑（主色）、完成（成功）、失败（错误）；
   *   排队 / 取消 / 未知一律最次级灰 —— 它们都是"没在动"。
   */
  planTaskIcon: css`
    flex: none;
    display: inline-flex;
    width: 12px;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextTertiary};

    &[data-phase='running'] {
      color: ${token.colorPrimary};
    }

    &[data-phase='done'] {
      color: ${token.colorSuccess};
    }

    &[data-phase='failed'] {
      color: ${token.colorError};
    }
  `,

  planTaskTitle: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  /** 右侧那一小串：技能 / 执行者 / 状态词。 */
  planTaskMeta: css`
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextTertiary};
  `,

  planTaskSkill: css`
    font-family: ${token.fontFamilyCode};
  `,

  /** 执行者名（主代理就是 main）。等宽 —— 它是标识符，不是人话。 */
  planTaskOwner: css`
    font-family: ${token.fontFamilyCode};
  `,

  planTaskPhase: css`
    white-space: nowrap;
  `,

  planAgentList: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,

  planAgentRow: css`
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    line-height: 1.7;
  `,

  planAgentName: css`
    flex: none;
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorText};
  `,

  planAgentTask: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextSecondary};
  `,

  /**
   * 「第 2 次尝试」那枚小标（`claim.attempt > 1` 才出现）。
   *
   * ⚠️ 只在**重试过**的时候画：第一次尝试挂一个"第 1 次"是纯噪音，
   *   而重试是要紧信息 —— 同一个任务被重跑，说明上一次没成。
   * ⚠️ 用警告色而不是错误色：重试不是"失败"，是"正在恢复"。
   */
  planAgentAttempt: css`
    flex: none;
    padding: 0 6px;
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorWarning};
    background: ${token.colorWarningBg};
    border-radius: 999px;
    white-space: nowrap;
  `,

  /**
   * 流式正文里**新出现的那一个字**（见 streamingMarkdown.tsx）。
   *
   * 一次 delta 通常带好几个字，它们各自带一个递增的 `animation-delay`
   * （0 / 28 / 56 …ms），于是看起来是"一个一个"冒出来的。
   *
   * ⚠️ `both` 是必须的：延迟期间元素停在 `from`（opacity: 0），否则那几十毫秒里
   *    字已经以全亮的状态显示出来了，"淡入"就没了。
   * ⚠️ 但 `prefers-reduced-motion` 下要把动画整个关掉 —— 只关时长、留着 fill-mode
   *    的话字会**永远停在 opacity: 0**（等于文字消失）。
   * ⚠️ 200ms 别再拉长：下一个 delta 通常 40~80ms 就到了，太长会和下一批的淡入
   *    叠在一起，正文看起来"发虚"。
   */
  charIn: css`
    display: inline;
    animation: dockCharIn 200ms ease-out both;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }

    @keyframes dockCharIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  `,

  /**
   * 「从消息栏上移入对话」—— 刚发出去的那张卡（我发的消息 / 刚答完的问答）
   * 从输入区的位置向上位移 + 淡入。
   *
   * 需求原话（2026-10-21）：「我从消息栏发送卡片的时候，卡片要有一个从消息栏
   * 上移至对话框中的动画效果」。
   *
   * ⚠️ 动画挂在**直接子项**上、容器自己只负责裁切
   * --------------------------------------------
   *   transform 会**算进滚动溢出区**：把容器自己往下偏，消息容器的
   *   scrollHeight 会跟着涨 —— 滚动条闪一下还是小事，useSmoothFollow 每帧
   *   把 scrollTop 追向 scrollHeight，于是它会先追下去 96px、再被"卡片升上来"
   *   拽回来，一次肉眼可见的抖动。
   *   所以：容器 `overflow: hidden` 把位移的那部分裁掉（滚动区因此完全不变），
   *   动画给它的**子项** —— 子项一起动，看起来就是整张卡在升。
   *
   * ⚠️ 位移取 96px，不是输入区整高（186px）
   * -----------------------------------
   *   卡片最终落在消息列表底部、输入区紧贴其下。位移按整个输入区算的话，
   *   起点完全在裁切区之外 —— 前 40% 的时间什么都不动，观感是"卡了一下
   *   然后蹦出来"，不是"移上来"。96px 大约到输入区中部：起点被裁掉、
   *   中途从底边冒出来，读起来就是"从下面那栏升上来"。
   */
  cardEnter: css`
    overflow: hidden;

    @keyframes dockCardUp {
      from {
        opacity: 0;
        transform: translateY(${CARD_ENTER_TRAVEL}px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }

    & > * {
      animation: dockCardUp ${CARD_ENTER_MS}ms cubic-bezier(0.22, 1, 0.36, 1)
        both;
    }

    @media (prefers-reduced-motion: reduce) {
      & > * {
        animation: none;
      }
    }
  `,

  /**
   * 已跑完的工具记录（历史遗留：早先贴输入框上沿的浮层）。
   *
   * ⚠️ 这一段目前**没有使用者**了（2026-10-18）：工具记录搬进了消息流，
   *    作为每条消息 section 的最后一段（深度思考 → 正文 → 工具行，
   *    见 DockRenderMessage.tsx / liveToolFeed.ts）。样式留在这里是因为
   *    `[data-kind='tool_activity']` 那几条相邻规则仍然按"卡片"处理它；
   *    等确认不需要"浮层里再列一遍"这条路，可以连 `toolFeed` 一起删掉。
   */
  toolFeed: css`
    display: flex;
    flex-direction: column;
    align-self: stretch;
    flex: 0 1 auto;
    min-height: 0;
    overflow: hidden;
    justify-content: flex-end;

    /* 卡片在消息流里自带 margin-inline: token.padding（那边是为了跟正文对齐）；
     * 这一层已经用 --dock-text-inset 让开过一次，别再叠第二次，否则卡片会比
     * 正文右移 16px。同理清掉 margin-top —— 这里没有"上面的问题"要推开。 */
    & > [data-kind='tool_activity'] {
      margin: 0 0 4px;
    }

    & > [data-kind='tool_activity']:last-child {
      margin-bottom: 0;
    }
  `,

  /**
   * 推理区的外壳（助手气泡正上方）。它是气泡的**兄弟节点** ——
   * 为什么不用库的 `subComponent`／`generativeUIPosition`，见 DockRenderMessage 的注释。
   *
   * ⚠️ 下边距：**这里不写** —— 折叠行与正文之间的留白由库那条 before 分支的
   *    空 div（自带 margin-bottom: 0.5rem）+ 气泡自己的 padding-top 组成，
   *    而这两段现在被下面「紧跟折叠行的助手消息」那条规则一起收到 8px。
   *    在这里再补 margin 只会叠加，且改不动"气泡那半边"。
   *
   * ⚠️⚠️ 左内边距必须与**正文的左边线同源**
   * ------------------------------------
   *   气泡自己的内边距是 `.copilotKitMessage { padding: … ${token.padding}px }`，
   *   而我们是它的**兄弟**、吃不到那份内边距 —— 不补的话折叠行会比正文左出一截
   *   （用户截图里正是「思考过程」比「题目：…」更靠左；截图是 2x 的，
   *    量出来差 ~29 图像像素 = 16 CSS 像素 = 正好一个 token.padding）。
   *   所以这里**引用同一个 token**：将来令牌改了，两处一起动，不会只歪一边。
   *   动这条之前先看 `.copilotKitMessage` 的内边距。
   */
  reasoningBlock: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    /* ⚠️ 这里**不能**用 gap 给"折叠行 → 展开的正文"留位：
     *    收起时那层 grid 壳高度是 0，gap 照样生效 —— 于是"思考过程 → 正文"
     *    会变成 gap(4) + section 的 4 = 8px，而需求要求 section 内一律最小档。
     *    所以 gap 记 0，展开后的间距由 reasoningBody 自己的 padding-top 给
     *    （padding 只在展开后可见，收起时那份 0 高度里看不出任何多余空隙）。 */
    gap: 0;
    max-width: 100%;
    padding-inline-start: ${token.padding}px;
  `,

  /**
   * 「思考过程」那一行 —— 需求要的"默认灰色隐藏"里的**灰色**就在这一行上。
   *
   * 素按钮（无边框、无底）：它是一条**次要信息**的把手，不该跟正文抢视觉
   * 重量。展开状态由 `aria-expanded` 与 `data-reasoning-open` 表意，
   * 不只靠图标转一下（读屏也报得出来）。
   */
  reasoningToggle: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    /* 2026-10-21 用户要求「思考过程字体加大 2px」：12 → 14（= token.fontSize）。
     * ⚠️ 展开后的推理原文同步提到 14（见 reasoningBody）—— 标签比自己的正文还大
     *    会读成"标题压着内容"，两处必须一起动。 */
    font-size: ${token.fontSize}px;
    line-height: 1.6;
    color: ${token.colorTextTertiary};
    cursor: pointer;

    &:hover {
      color: ${token.colorTextSecondary};
    }

    &:focus-visible {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: 2px;
      border-radius: ${token.borderRadiusSM}px;
    }
  `,

  /**
   * 折叠箭头。展开时转 90°。
   *
   * ⚠️ **自己写 transform，不用 antd 图标的 `rotate` 属性**：那个属性是换
   *    class（`anticon-rotate-90`），能不能过渡取决于库那条规则怎么写；
   *    自己写一条类，度数、时长、缓动都在本文件里，一眼看得全。
   */
  reasoningCaret: css`
    font-size: 10px;
    transition: transform ${REASONING_ANIM_MS}ms ease;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

  reasoningCaretOpen: css`
    transform: rotate(90deg);
  `,

  /**
   * 展开/收起的高度动画壳。**常驻** DOM（里面的正文才按需挂载）。
   *
   * ⚠️ 为什么用 `grid-template-rows: 0fr ↔ 1fr`，而不是过渡 `max-height`
   * ---------------------------------------------------------------
   *   `max-height` 得先猜一个"够大"的值：短推理会猛一下到底再停住，
   *   长推理又慢得不自然 —— 而且它和内容长度无关，表现完全由猜的那个数决定。
   *   `0fr ↔ 1fr` 过渡的是**行高比例**，任何内容长度都是同一个时长，
   *   也不需要 JS 去量高度（量高度要 ResizeObserver，还要处理滚动位置）。
   *   不支持的浏览器只是"没有过渡、直接展开"，收起态仍然是 0fr —— 不会坏。
   *
   * ⚠️ 内层 `reasoningBodyClip` 的 `min-height: 0` 不能省：grid 子项默认
   *    `min-height: auto`，它会顶着内容高度、不让行压到 0。
   */
  reasoningBodyWrap: css`
    display: grid;
    grid-template-rows: 0fr;
    width: 100%;
    opacity: 0;
    transition:
      grid-template-rows ${REASONING_ANIM_MS}ms ease,
      opacity ${REASONING_ANIM_MS}ms ease;

    &[data-reasoning-open='true'] {
      grid-template-rows: 1fr;
      opacity: 1;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

  reasoningBodyClip: css`
    min-height: 0;
    overflow: hidden;
  `,

  /**
   * 展开后的推理原文。
   *
   * ⚠️ `white-space: pre-wrap` 而不是 markdown —— 与 hitlRaw 同一条理由：
   *    这是模型流式吐出来的原文，按 md 渲染会把 `_` / `*` / 缩进改掉。
   *
   * ⚠️ **必须封顶 + 可滚**：思维链动辄几千字，不封顶它会把整段对话顶到
   *    屏幕外（与 hitlArgs / hitlRaw 是同一条理由）。
   */
  reasoningBody: css`
    max-width: 100%;
    max-height: 240px;
    overflow: auto;
    /* 与上面那条折叠行之间留最小档（展开后才看得见，见 reasoningBlock 的说明）。 */
    padding-top: ${SPACE_TIGHT}px;
    padding-left: 10px;
    border-left: 2px solid ${token.colorBorderSecondary};
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    /* 与「思考过程」那行同字号（14）—— 见 reasoningToggle 的说明。 */
    font-size: ${token.fontSize}px;
    line-height: 1.7;
    color: ${token.colorTextTertiary};
  `,

  /**
   * 人工审批（HITL）那一层的定位壳。里面的卡片由 HitlInterrupt.tsx 决定。
   *
   * ⚠️ 与 emptyHint 同款手法（absolute + 压掉输入区那条），但方向相反
   * ------------------------------------------------------------
   *   问候语是"居中"，审批卡片是**贴着输入框上沿**（justify-content: flex-end）——
   *   它是一张要你动手的卡，应该出现在你视线落到输入框的路径上，而不是屏幕正中。
   *
   * ⚠️ pointer-events: none 是必须的
   * ------------------------------
   *   这一层铺满整块消息区。不关掉命中，用户就没法**滚动消息去读上文**
   *   （审批前往往要看看模型到底说了什么）。卡片自己再打开（hitlCard）。
   *
   * z-index: 3 —— 大于历史提示条（2）、也大于 emptyHint（2）；
   *   chatPane 是层叠上下文（z-index: 0），所以这个 3 只在对话区内部比较。
   */
  hitlLayer: css`
    position: absolute;
    inset-block: 0 var(--dock-input-h, 0px);
    inset-inline: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: ${token.paddingSM}px ${token.padding}px;
    pointer-events: none;
  `,

  /**
   * 审批 / 提问卡片本体 —— **标题行（工具调用状态栏）+ 内容（审批控件）**两段式
   * （2026-10-23 用户：「直接把审批控件作为 content，工具调用状态栏作为 title」）。
   *
   * ⚠️ 底色必须**不透明** —— 这一条是用户截图报的 bug
   * -------------------------------------------------
   *   这一层（hitlLayer）铺在**消息文本上面**。上一版卡片用 colorFillQuaternary
   *   （2% 黑），一个半透明色压在别人的字上 → 自己的字和底下的字叠在一起，
   *   整张卡读起来是"透明的"（用户截图里正文透出了下面那条消息）。
   *   工具调用卡用同一个色却没问题：它不在任何文字上面。
   *
   *   所以这里用**实底** colorBgContainer（= 面板底色）+ 一条细边：不透明、
   *   与对话区同色系、边界靠边框给。**仍然不要阴影** —— 阴影是"弹窗"的语义，
   *   而这张卡属于输入区那一族（2026-10-21 那条决定不变，改的是透明度）。
   *
   * 宽度跟着 hitlLayer 的内边距（与输入框同为 16），比消息卡（40）宽 ——
   * 因为它属于输入区那一族。
   *
   * ⚠️ padding 为 0（原来是一圈 16）：内边距现在由标题行与内容各自持有 ——
   *   内容折到 0 之后，卡片自己的 padding 会在标题下面留一条空白带。
   * ⚠️ overflow: hidden：内容折到 0 时要裁干净，且标题行的 hover 底色不能
   *   溢出圆角。
   */
  hitlCard: css`
    pointer-events: auto;
    max-width: 100%;
    /* 这层是 <fieldset>（一组相关控件 + 一个组名，给读屏用；
       div+role="group" 会被 biome 的 useSemanticElements 判错）。
       它自带三个浏览器默认值必须清掉：
         · margin-inline: 2px  —— 会让卡片比对话区窄一圈、对不齐；
         · min-inline-size: min-content —— 卡住收缩，窄对话区里卡片会溢出；
         · border: 2px groove —— 下面这行已经覆盖，写在一起是为了说明来由。 */
    margin: 0;
    min-inline-size: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    /* 显式 none 而不是"不写"：这是**刻意的决定**（见上面那段），
       写成默认值才能被断言钉住 —— 不写的话哪天有人加回一条 boxShadow，
       计算值从 none 变成一个真值，回归测试才抓得到"本来就不该有"。 */
    box-shadow: none;
  `,

  /**
   * 标题行 = **工具调用状态栏**（外观与 ToolActivityRow 那一行对齐）。
   *
   * ⚠️ 是**真 button**，不是 div + onClick
   * -----------------------------------
   *   aria-expanded / 键盘（Enter、Space）/ 焦点框 / focus-visible 全是白拿的。
   *   手搓一遍等于重写浏览器已有的行为，而且一定会漏掉其中一两项。
   *
   * ⚠️ 三处必须手写的重置（button 自带的东西）：字体（不吃 UA 的 13px 系统字
   *   体）、文字色、text-align（UA 默认居中）。width: 100% 让整行可点。
   *   内边距 8/10 直接取自 toolActivity —— "看着是同一条状态栏"靠的就是这组数。
   */
  hitlTitle: css`
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    font: inherit;
    font-size: ${token.fontSizeSM}px;
    color: inherit;
    text-align: start;
    cursor: pointer;
    transition: background ${HITL_ANIM_MS}ms ease;

    &:hover {
      background: ${token.colorFillQuaternary};
    }

    /* 焦点框画在**里面**（offset 负值）：卡片 overflow: hidden，画在外面会被裁掉。 */
    &:focus-visible {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: -2px;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

  /**
   * 标题行左端那枚形状图标。
   *
   * 审批/选项 = 警告色（"要你动手"）；提问 = 主色（只是问你一句话，不是危险
   * 动作）；unknown = 灰（"我还不认识它" —— 用醒目的色会骗人）。
   */
  hitlTitleIcon: css`
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorWarning};

    &[data-variant='question'] {
      color: ${token.colorPrimary};
    }

    &[data-variant='unknown'] {
      color: ${token.colorTextTertiary};
    }
  `,

  /**
   * 标题行主语：工具名（i18n 成的人话，见 toolLabels.ts）。
   *
   * ⚠️ 单行省略：工具名 + 位次 + 倒计时挤在一行，长工具名必须能截 ——
   *   否则右端那两枚药丸会被顶出卡片。完整值仍在 title 属性里。
   */
  hitlTitleName: css`
    min-width: 0;
    overflow: hidden;
    font-size: ${token.fontSizeSM}px;
    font-weight: 500;
    color: ${token.colorText};
    white-space: nowrap;
    text-overflow: ellipsis;
  `,

  /**
   * 主语后面那句旁注（「需要你的审批」「请选择」…）。
   *
   * ⚠️ 只在**有工具名**时才画：没有工具名的中断拿这句话当主语
   *   （见 HitlInterrupt.tsx 的 title/note），两段都画就是同一句话重复两遍。
   */
  hitlTitleNote: css`
    flex: 0 0 auto;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextTertiary};
    white-space: nowrap;

    /* 前面那枚间隔点用 ::before，不在文案里拼字符 ——
       文案要能被 i18n 替换，标点是**版式**，不该混进译文。 */
    &::before {
      margin-inline-end: 4px;
      content: '·';
    }
  `,

  /**
   * 折叠箭头：展开时转 180°（内容在标题**下面**展开，箭头朝下 → 展开后朝上）。
   *
   * ⚠️ 自己写 transform，不用 antd 图标自带的 `rotate` 属性：那个是换 class
   *   （anticon-rotate-180），能不能过渡取决于库那条规则怎么写 —— 与
   *   reasoningCaret 同一个理由。
   */
  hitlCaret: css`
    flex: 0 0 auto;
    font-size: 10px;
    color: ${token.colorTextQuaternary};
    transition: transform ${HITL_ANIM_MS}ms ease;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

  hitlCaretOpen: css`
    transform: rotate(180deg);
  `,

  /**
   * 内容区的**高度动画壳**（审批控件本体 = content）。
   *
   * ⚠️ 用 `grid-template-rows: 0fr ↔ 1fr`，理由与 reasoningBodyWrap 那条相同：
   *   max-height 得先猜一个上限（猜小了裁内容，猜大了动画在末尾空转），
   *   而 grid 过渡的是**行高比例** —— 内容长短都是同一个时长，也不用 JS 量高度。
   *   不支持过渡的浏览器只是"没有动画、直接展开"，收起态仍是 0fr，不会坏。
   *
   * ⚠️ 这一折就是需求里那句「点了允许/拒绝之后，动画融合进 title 栏」：
   *   内容收到 0，卡片只剩上面那一行 —— 随后中断被清空，整块卸载。
   */
  hitlBody: css`
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows ${HITL_ANIM_MS}ms ease;

    &[data-open='true'] {
      grid-template-rows: 1fr;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

  /**
   * 内层裁剪壳（grid 子项）。
   *
   * ⚠️ `min-height: 0` 不能省：grid 子项默认 `min-height: auto`，它会顶着
   *   内容高度、不让那一行压到 0 —— 收起就没效果了。
   *
   * ⚠️ 内边距在这里而**不在** hitlCard：折起来时这片 padding 要一起归零，
   *   否则标题下面留一条 10px 空白带（看着"没收干净"）。
   *
   * ⚠️ `visibility: hidden` 是给键盘的：高度 0 + overflow: hidden 只是**看不见**，
   *   里面那排按钮仍然在 tab 序里 —— Tab 会落到一个看不见的「允许」上。
   *   延迟到动画结束再藏（transition-delay），否则折叠过程中按钮会先消失。
   */
  hitlBodyInner: css`
    min-height: 0;
    padding: 0 10px;
    overflow: hidden;
    visibility: hidden;
    transition:
      padding ${HITL_ANIM_MS}ms ease,
      visibility 0s linear ${HITL_ANIM_MS}ms;

    /* 顶部 8px 与标题行隔开：正文第一段（hitlAsk）自己没有上外边距。 */
    &[data-open='true'] {
      padding: 8px 10px 10px;
      visibility: visible;
      /* 展开时立刻可见（delay 0）—— 否则要等动画播完内容才出现。 */
      transition:
        padding ${HITL_ANIM_MS}ms ease,
        visibility 0s linear 0s;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

  /**
   * 卡片头部右端的那一组状态（位次 + 倒计时）。
   *
   * ⚠️ `margin-inline-start: auto` 从 hitlQueue **搬到这里**：两个药丸要作为
   *   一个**组**一起靠右；各自带 auto 会把剩余空白平分，把它们推到两个位置。
   *   搬到容器上之后，"只有一个药丸"时的外观与原来完全一致。
   */
  hitlHeadSide: css`
    margin-inline-start: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  `,

  /**
   * 一次派发带了多个待办中断时的位次（并行工具各停一次 → 聚成一组）。
   *
   * ⚠️ 原来只是一行最次级色的小字（那时它被当成"防御性代码"，后端一次只问一个）。
   *   现在并行工具会让它**经常**出现，所以给成一个小药丸：它得能一眼读到
   *   "后面还有几条"，否则用户不知道答完这条还会不会再弹。
   *   靠右由父容器 hitlHeadSide 负责（见上）。
   */
  hitlQueue: css`
    padding: 1px 8px;
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    background: ${token.colorFillQuaternary};
    border-radius: 999px;
    white-space: nowrap;
  `,

  /**
   * 审批窗口的倒计时（**纯显示**，见 HitlInterrupt.tsx 的文件头）。
   *
   * ⚠️ `tabular-nums` 是必须的：默认的比例数字里 "1" 比 "8" 窄，秒数往下跳
   *   时整行会跟着抖一下 —— 一个每秒抖一次的元素很显眼。
   * ⚠️ 超时**不用**危险色：那个红在这个项目里代表"出错了"，而超时既不是
   *   运行失败、也不是用户的错。用警告色 + 加粗，够醒目又不喊"出事了"。
   */
  hitlCountdown: css`
    padding: 1px 8px;
    font-size: ${token.fontSizeSM}px;
    font-variant-numeric: tabular-nums;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    background: ${token.colorFillQuaternary};
    border-radius: 999px;
    white-space: nowrap;

    &[data-hitl-countdown='overdue'] {
      color: ${token.colorWarning};
      font-weight: 600;
    }
  `,

  /** 后端给的那句话（审批拦截器的 prompt）。正文色，它是这张卡的主语。 */
  hitlAsk: css`
    margin: 0 0 8px;
    font-size: ${token.fontSize}px;
    line-height: 1.6;
    color: ${token.colorText};
  `,

  /** 「工具 / 参数 / 审批角色」那个两列的键值表。 */
  hitlMeta: css`
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    margin: 0 0 10px;
  `,

  hitlMetaLabel: css`
    font-size: ${token.fontSizeSM}px;
    line-height: 1.7;
    color: ${token.colorTextTertiary};
    white-space: nowrap;
  `,

  hitlMetaValue: css`
    min-width: 0;
    margin: 0;
    font-size: ${token.fontSizeSM}px;
    line-height: 1.7;
    color: ${token.colorText};
    overflow-wrap: anywhere;
  `,

  /** 工具名用等宽：它是 `agent.platform.describe_platform` 这种点分标识符。 */
  hitlTool: css`
    margin: 0;
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
  `,

  /**
   * 调用参数。
   *
   * ⚠️ max-height + overflow: auto：参数可能很长（一次查询带几十个条件），
   *   不封顶会把按钮顶出可视区 —— 那就变成了"看得见问什么、够不着答"。
   */
  hitlArgs: css`
    max-height: 132px;
    margin: 0;
    padding: 6px 8px;
    overflow: auto;
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorText};
    background: ${token.colorFillQuaternary};
    border-radius: ${token.borderRadius}px;
  `,

  /**
   * unknown 形状的兜底：把原始载荷摊开。
   *
   * ⚠️ 同样必须封顶，理由与 hitlArgs 一样（而且这个更容易失控 ——
   *   后端给一个很大的 metadata 就完了）。
   * 正文色退一级、等宽：这是"给你排查用的"，不是卡片想要你读的东西。
   */
  hitlRaw: css`
    max-height: 160px;
    margin: 0 0 10px;
    padding: 6px 8px;
    overflow: auto;
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    background: ${token.colorFillQuaternary};
    border-radius: ${token.borderRadius}px;
  `,

  /**
   * 卡片底部那排按钮。
   *
   * ⚠️ 一律**靠右**（2026-10-21 用户：「按钮都右对齐」）。之前是默认的靠左，
   *    而「跳过」自己带一个 margin-inline-start: auto 被推到最右 —— 于是
   *    「提交」孤零零贴在左边、「跳过」贴在右边，中间一条大空白（截图）。
   *    现在整排靠右、彼此只隔 8px：主操作与次操作在同一个视觉组里。
   *
   * ⚠️ DOM 顺序保持"主操作在前、跳过在后"，只改对齐 —— 读屏与 Tab 顺序
   *    仍然是"提交 → 跳过"，与用户看到的左右顺序一致。
   */
  hitlActions: css`
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  `,

  /** 「始终允许」的作用域说明。小字、最次级色 —— 是提醒，不是要求。 */
  hitlNote: css`
    margin: 8px 0 0;
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextTertiary};
  `,

  /* ================================================================== *
   * 提问控件（ask_user_question）—— 与审批卡共用外壳，只换中间那段
   *
   * 一次只显示一道题（理由见 AskUserQuestionBody.tsx 的文件头）：
   * 头部一行（短标题 + 第几题 +「可多选」），题面，选项列表，底部按钮。
   * 选项行是「指示器 + 选项名 + 说明」，说明折行时指示器贴第一行。
   * ================================================================== */

  /** 头部那一行：短标题（后端限 12 字）+ 第几题 + 可多选提示。 */
  auqHead: css`
    display: flex;
    align-items: center;
    gap: 6px;
    margin-block-end: 6px;
  `,

  /** 后端给的短标题。Tag 自带外边距，在这里清掉（它现在是行内第一个元素）。 */
  auqHeader: css`
    && {
      margin: 0;
    }
  `,

  /** 「第 1 / 3 题」。靠右 —— 与审批卡的位次药丸同一个位置感。 */
  auqProgress: css`
    margin-inline-start: auto;
    font-size: ${token.fontSizeSM}px;
    font-variant-numeric: tabular-nums;
    color: ${token.colorTextSecondary};
    white-space: nowrap;
  `,

  /** 「可多选」。没有它，用户会以为只能勾一个。 */
  auqHint: css`
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextTertiary};
    white-space: nowrap;
  `,

  /**
   * 题面 + 选项那一块（按钮在外层，不跟着滚）。
   *
   * ⚠️ `max-height` + `overflow: auto` 是必须的：四个选项各带一段说明时
   *   这块能到几百像素，而浮层只能占对话区下方那一段 —— 不封顶就被顶出
   *   可视区，用户够不着"下一题"。按钮放在这块**外面**，滚到底也不用找。
   */
  auqBody: css`
    max-height: 42vh;
    margin-block-end: 10px;
    padding-inline-end: 2px;
    overflow-y: auto;
  `,

  /** 题面。比选项重一档 —— 它是这一屏的主语。 */
  auqQuestion: css`
    margin: 0 0 8px;
    font-size: ${token.fontSize}px;
    font-weight: 500;
    line-height: 1.6;
    color: ${token.colorText};
    overflow-wrap: anywhere;
  `,

  /**
   * 选项列表的行容器。
   *
   * ⚠️ 它同时是 `Radio.Group`（antd 给 `.ant-radio-group` 写了
   *   `display: inline-block`）和 `<fieldset>`（多选那一支，自带 border /
   *   padding / min-inline-size）。两边的默认值都得清掉，而对方的规则也是
   *   单类名 —— 所以照样套 `&&`（理由同 userAction 那条注释）。
   */
  auqGroup: css`
    && {
      display: flex;
      flex-direction: column;
      width: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      min-inline-size: 0;
    }
  `,

  /** 一个选项 = 一行选择 +（可选）示例开关 +（可选）示例正文。 */
  auqOption: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding-block: 2px;
  `,

  /**
   * 选项本体（Radio / Checkbox 的 label）。
   *
   * ⚠️ `width: 100%` + `margin-inline-end: 0`：整行都要能点，而且不能因为
   *   antd 给的 8px 右外边距把最后一行挤窄。两个都是覆盖 antd 自己的单类名
   *   规则，所以套 `&&`（理由同 userAction 那条注释）。
   */
  auqChoice: css`
    && {
      width: 100%;
      margin-inline-end: 0;
    }
  `,

  /** 选项名 + 说明的竖排容器。`min-width: 0` 让长说明能折行而不是撑宽。 */
  auqOptionText: css`
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  `,

  auqOptionLabel: css`
    font-size: ${token.fontSize}px;
    line-height: 1.6;
    color: ${token.colorText};
    overflow-wrap: anywhere;
  `,

  auqOptionDesc: css`
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    overflow-wrap: anywhere;
  `,

  /**
   * 「查看示例 / 收起示例」。
   *
   * ⚠️ 缩进 24px 对齐**选项文字**（跳过指示器的宽度）：它是选项的附属物，
   *   跟圆点对齐会让人以为它是另一个选项。
   * ⚠️ 用原生 button 而不是 antd 的 link Button：这里是正文里的一个行内开关，
   *   antd 按钮自带高度与内边距，会把选项行的行距撑开。
   */
  auqPreviewToggle: css`
    margin-inline-start: 24px;
    padding: 0;
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorLink};
    background: none;
    border: 0;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
    }

    &:disabled {
      color: ${token.colorTextQuaternary};
      cursor: not-allowed;
    }
  `,

  /** 示例正文。与 hitlRaw / hitlArgs 同一套处理：等宽、淡底、**封顶**。 */
  auqPreview: css`
    max-height: 140px;
    margin: 2px 0 2px 24px;
    padding: 6px 8px;
    overflow: auto;
    align-self: stretch;
    font-family: ${token.fontFamilyCode};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    white-space: pre-wrap;
    background: ${token.colorFillQuaternary};
    border-radius: ${token.borderRadius}px;
  `,

  /**
   * 「其他」的输入框：缩进对齐选项文字，右边缘与卡片内容区齐平。
   *
   * ⚠️ 用 `align-self: stretch` + `width: auto`，**不要** `width: 100%`：
   *   父容器有 24px 的左缩进，100% 是在缩进**之后**再算满宽，
   *   右边会溢出卡片（实测截图见过）。
   */
  auqOtherInput: css`
    && {
      width: auto;
      margin-block-start: 4px;
      margin-inline-start: 24px;
      align-self: stretch;
      font-size: ${token.fontSizeSM}px;
    }
  `,

  /**
   * 「跳过」按钮 —— **不再单独把自己推到最右**。
   *
   * 那枚 `margin-inline-start: auto` 已删（2026-10-21「按钮都右对齐」）：
   * 「提交」留在左边、「跳过」飞到右边，中间空出一大条 —— 正是要修的那个观感。
   * 对齐交给父级 hitlActions 的 justify-content: flex-end，整排一起靠右。
   * 按钮形态仍由 `type="text"` 决定，这里不需要再挂样式。
   */

  /* ================================================================== *
   * 工具活动记录（tool_activity）—— **一行「工具调用：<名字>」**
   *
   * 它出现在**消息流里**（由 DockRenderMessage 按 metadata.kind 分流渲染），
   * 但**不套 .copilotKitMessage 外壳**（它是裸 div 直接挂在
   * .copilotKitMessagesContainer 下）—— 于是库给每条消息的 margin /
   * padding 它一样都没有，横向对齐与上下间距都得在这里自己补。补成什么样、
   * 为什么，见下面 css 里那两段注释。
   *
   * ⚠️ 这一块**只有一行**：参数与工具产出按需求都不再展示（见
   *    ToolActivityRow.tsx 的文件头）。所以下面只有"淡底 + 前缀 + 名字"
   *    三个样式键，原来那些封顶滚动的参数框/产出框已经删掉了 ——
   *    留着它们会有"这里本该显示点什么"的误导。
   *    ⚠️ 2026-10-20 起**模型旁白**不在这一块里，而是作为 section 的"正文"
   *    画在它**上面**（同一个 section 内顺序：思考 → 正文 → 工具框）。
   *
   * 视觉上仍要一眼看出"这是过程记录、不是回答"：退一级的文字色 + 淡底 +
   * 等宽的工具名，没有头像、没有反馈按钮。
   * ================================================================== */

  /**
   * ⚠️ 这里原来有一条 `taskInstructionBody`（淡一档 + 小一档），**2026-10-22 已删**。
   *
   *   留着这段注释是因为"删掉的理由"比"那三行 css"值钱：
   *   第一版把任务说明的全文当正文渲染（就是靠这条样式淡一档、小一档），
   *   但实时通道上根本没有这条消息（后端注入的 HumanMessage 不经过模型流式
   *   输出），于是刷新前后两个样子 —— 用户截图报的"刷新前后不一致"。
   *   现在节点标题直接就是那段人话任务说明（见 taskTimeline.taskDescriptionOf），
   *   任务说明那一行**不再有正文**。
   *   哪天真的要把整段提示词再显示出来，先把实时侧的来源解决了再加样式，
   *   否则一致性会再破一次。
   */

  toolActivity: css`
    /* ---- 左右对齐 ----
     * 这一层是**裸 div**（外面那层 [data-section-view] 才是消息容器的直接
     * 子节点），所以比正文少了那 16px 的内边距：
     * 卡片边框会左突、右溢，看着像"贴歪了"（用户截图反馈的就是这个）。
     * 用 margin 让开而不是 padding —— 要对齐的是**边框**与正文左边缘，
     * 内容再在卡片自己的 10px 里缩进。
     * 数值来自 --dock-text-inset 的同一笔账（见 chatPane 里的注释）。
     *
     * ⚠️ 右侧**不再是 16**（2026-10-21，用户截图「右侧没有对齐」）：
     *    助手正文的右边缘与我的气泡右边缘是同一条线（.copilotKitMessage
     *    的外框右缘），而卡片在右边多让开 16px，于是它比气泡短一截。
     *    现在所有卡片的右边缘都落在同一条线上。 */
    margin-inline: ${token.padding}px 0;
    /* ---- 上下 ----
     * 0，且**只留 0**：卡片是 section 的直接子项，"与上一个子项之间"这一件事
     * 由 chatPane 的 [data-section-view] 规则统一给最小档。这里自己再写一个
     * margin-top 就等于第四种间距（旧版正是 12px + 8px 两层叠出来的）。
     * 并行调用的多行也是 section 的直接子项，同样吃那一条。 */
    margin-block: 0;
    max-width: 100%;
    padding: 8px 10px;
    background: ${token.colorFillQuaternary};
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;

    /* 状态图标取色集中在状态上（data-status 由实时那一份给出）。
       历史记录是 data-status="none" —— 它不知道成败，所以既不画图标也不取色。 */
    &[data-status='running'] .anticon {
      color: ${token.colorPrimary};
    }
    &[data-status='done'] .anticon {
      color: ${token.colorSuccess};
    }
    &[data-status='error'] .anticon {
      color: ${token.colorError};
    }

    /* 并行调用时这里是**一摞**行（ToolActivityRow 一次调用返回一个 div）。
     * ⚠️ 这里**不再**写相邻兄弟的间距规则：那几行都是 section 的直接子项，
     *    由 chatPane 的"相邻子项 = 最小档"统一管 —— 一处定义，一条规则。 */
  `,

  /**
   * 行首那枚状态图标。
   *
   * `vertical-align` 微调 1px：图标是高 1em 的方形，而正文是 12px 的中文，
   * 不调的话图标会明显"坐在字上面"。
   */
  toolActivityStatus: css`
    display: inline-flex;
    align-items: center;
    margin-inline-end: 6px;
    font-size: ${token.fontSizeSM}px;
    vertical-align: -1px;
  `,

  /**
   * 工具名。
   *
   * ⚠️ 不再是等宽字体（2026-10-23）：这一行现在印的是**中文人话**
   *   （「检索文档」），等宽是它在印 `agent.platform.describe_platform`
   *   那个年代留下的。中文字形在等宽字体里会被拉宽、字重也发虚。
   *   没译文时仍然可能落到原值（MCP / 新工具），所以保留 overflow-wrap:
   *   anywhere —— 长标识符要能断。
   */
  toolActivityName: css`
    min-width: 0;
    font-size: ${token.fontSizeSM}px;
    color: ${token.colorTextSecondary};
    overflow-wrap: anywhere;
  `,

  /* ================================================================== *
   * HITL 问答记录（kind: interaction）—— "我发出的那条消息"
   *
   * 形态照用户气泡（右对齐 / 主色淡底 / 大圆角），内容是**微信「回复某条
   * 消息」**那种结构：一条引用块（我在回答什么）+ 我下面说的话。
   * 为什么不用库的 UserMessage 见 InteractionMessage.tsx 的文件头。
   *
   * ⚠️ 右对齐靠 margin-inline-start: auto + max-width
   * ------------------------------------------------
   *   它现在是 section 里的一个 flex 子项（align-items: stretch），
   *   不写 max-width 会被拉到满宽，"我发的"这层语义就没了。
   *   88% 与用户气泡同源（.copilotKitUserMessage 也是 88%）。
   * ================================================================== */
  interactionCard: css`
    display: flex;
    flex-direction: column;
    /* 多题之间：同一张卡片内部，用最小档。 */
    gap: ${SPACE_TIGHT}px;
    align-self: flex-end;
    max-width: 88%;
    margin-inline-start: auto;
    /* 固定内边距（不随内容 / 是否多题变化），与用户气泡同一组数。 */
    padding: ${token.paddingSM}px ${token.padding}px;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorPrimaryBg};
    color: ${token.colorText};
  `,

  /** 一问一答（引用 + 我的话）。多题时它们各自成组，组间用卡片自己的 gap 分开。 */
  interactionItem: css`
    display: flex;
    flex-direction: column;
    /* 引用块与我的回答**贴住**：这是"一句话的两半"，用卡片内部的固定间距
     * （8px），不参与消息流那三档 —— 那三档管的是"卡片与卡片之间"。 */
    gap: 8px;
    min-width: 0;
  `,

  /**
   * 引用块 —— 微信「回复某条消息」里那块灰底小字。
   *
   * 三件套缺一不可：
   *   · 淡底（比气泡底色深一档）→ 一眼看出"这是被引用的内容，不是我说的话"；
   *   · 左侧 3px 竖线 → 微信那条竖线，把引用与正文在视觉上绑成一组；
   *   · 小一号 + 次要色 → 层级让给我的回答。
   *
   * ⚠️ 底色用 colorFillSecondary 而不是 colorFillQuaternary：卡片本身已经是
   *    colorPrimaryBg（淡蓝），quaternary 的灰在上面几乎看不见，引用块就散了。
   */
  interactionQuote: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 6px 10px;
    /* 竖线用 colorTextQuaternary 而不是 colorBorder：后者在灰底上几乎看不见
     * （实测截图里那条线整个消失了，引用块就退化成"一块灰"）。 */
    border-inline-start: 3px solid ${token.colorTextQuaternary};
    border-radius: ${token.borderRadiusSM}px;
    background: ${token.colorFillSecondary};
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
  `,

  /** 引用块顶部那行来源（微信里是昵称）：短标题，或「问题」兜底。 */
  interactionQuoteLabel: css`
    font-size: ${token.fontSizeSM}px;
    line-height: 1.6;
    color: ${token.colorTextTertiary};
  `,

  /** 被引用的那一问。可换行、长英文能断。 */
  interactionQuoteText: css`
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,

  /** 我的回答 —— 卡片里最重的一段（正常正文大小、正常字重，像一条发出去的话）。 */
  interactionAnswer: css`
    font-size: ${token.fontSize}px;
    line-height: 1.6;
    color: ${token.colorText};
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,

  /** 跳过没答（`answers` 里没有这一题的 key）：灰字占位，不要留白。 */
  interactionAnswerEmpty: css`
    font-size: ${token.fontSize}px;
    line-height: 1.6;
    color: ${token.colorTextQuaternary};
  `,

  /**
   * 我的消息卡片下方那一行（复制 / 编辑）。
   *
   * 布局：跟气泡一样**贴右边**。气泡自己用 `margin-inline-start: auto` 右对齐，
   * 这一行是 full-width 的 flex、`justify-content: flex-end` —— 于是按钮的
   * 右边缘与气泡右边缘齐平（气泡靠 auto margin 顶到容器右侧，两者同一个边界）。
   *
   * 间距：**这里不写 margin**。它与气泡都带着 data-* 标记，纵向间距由
   * chatPane 的三档表统一给 —— 卡片 ↔ 图标行是中档（SPACE_MID）。上一版
   * 用 -8px 负 margin 去"抵掉"库的 .5rem + 自己再垫 8px，两个数都是第四种
   * 间距的来源，已删。
   *
   * 常显而不是 hover 才显：触摸设备上没有 hover，而"按钮藏在悬停里"对
   * 一次性使用的面板来说太难发现。用退一级的文字色压住存在感。
   */
  userMessageActions: css`
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${token.marginSM}px;
    margin: 0;
  `,

  /**
   * 那两枚图标按钮：24×24 的方形热区、16px 图标、无内边距。
   *
   * ⚠️ 这一组数是**双方共用**的基准（2026-10-21「双方 icon 统一效果样式大小」）：
   *    助手消息那行（库的 .copilotKitMessageControlButton）在 chatPane 里逐条
   *    抄了同样四个值（controlHeightSM / fontSizeLG / colorTextTertiary / hover
   *    colorText）。改这里就要改那里，否则两条消息下面又会长得不一样。
   *
   * 仿 DeepSeek：**只有图标**，不写文字（文案会把按钮撑宽），悬停只是加深
   * 颜色、**不加底色** —— 一条消息下面浮出两枚灰图标，不该有任何"按钮块"的观感。
   *
   * ⚠️ 用 `&&`（双类名）而不是单个 `&`：antd 的 `.ant-btn-text` 会给按钮
   *    自己上色、悬停时还会铺一层底色，同一元素上两个单类名谁赢取决于样式
   *    注入顺序 —— 而那个顺序在开发/生产构建里不一定一样。加一层特异性把
   *    "退一级的灰 + 透明底"钉住。
   */
  userAction: css`
    && {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: ${token.controlHeightSM}px;
      height: ${token.controlHeightSM}px;
      padding: 0;
      color: ${token.colorTextTertiary};
    }

    && .anticon {
      font-size: ${token.fontSizeLG}px;
    }

    /* 复制成功态：messageActionIcons.copied 镜像的是**库**那份加粗「✓」
     * （内联 10px bold），这里照 chatPane 里 .copilotKitMessageControlButton
     * 的同一条规则把它规范成 16px / 常规字重 —— 两边点完复制是**同一个**
     * 观感。选择器带 [style] 是刻意的：只有那个「✓」带内联样式，
     * antd 图标的 anticon 不带，不会误伤。 */
    && > span[style] {
      font-size: ${token.fontSizeLG}px;
      font-weight: 400;
    }

    &&:hover {
      color: ${token.colorText};
      background: transparent;
    }
  `,

  /**
   * 对话区。CopilotChat 用**原生样式**，这里只负责四件事：
   *   ① 给它一个确定高度（min-height: 0 必需，否则内部滚动条不出现、内容会撑破面板）；
   *   ② 把它的主题变量接到 antd 上，免得整块面板里只有对话区是另一套配色；
   *   ③ 把消息与输入框调成 DeepSeek 的极简风格；
   *   ④ **关住 CopilotKit 的 z-index**（见下面那条 ⚠️）。
   *
   * ⚠️ z-index: 0 是必须的，不是可有可无的
   * ------------------------------------------------
   *   CopilotKit 给 .copilotKitChat 写了 z-index: 30（**没有 position**）。
   *   通常 static 元素的 z-index 会被忽略，但 .copilotKitChat 是 chatPane 的
   *   **flex item** —— 按 Flexbox 规范，flex item 上 z-index ≠ auto 照样生效
   *   并创建层叠上下文。于是整个对话区被抬到 z=30，**压住了面板里所有
   *   z-index 更小的覆盖层**：
   *     · 历史抽屉（z=3）→ 看着渲染正常，但返回按钮和会话条目点不动
   *       （实测 elementFromPoint 命中的是 copilotKitMessagesContainer）；
   *     · 加载提示（z=2）→ 一直就没显示过。
   *
   *   给 chatPane 一个 z-index: 0，它就成了层叠上下文，把 CopilotKit 内部
   *   那些 1 / 2 / 10 / 30 全关在对话区这一层里、不再外溢。之后覆盖层
   *   只要 z-index > 0 就能稳稳盖住对话区。
   *
   *   顺带把 .copilotKitChat 的 z-index 归 auto：它在 chatPane 里是独苗，
   *   那个 30 除了"外溢"没任何作用；清掉之后加载提示 z=2 就够，
   *   不必去追一个比 30 更大的魔法数。
   */
  chatPane: css`
    position: relative;
    /* 见上面 ⚠️：成为层叠上下文，关住对话区内部的 z-index */
    z-index: 0;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: ${token.colorBgLayout};

    /* CopilotKit 自带 :root 默认值，这里按 antd token 覆盖 —— 它整套 UI 都读这些变量 */
    --copilot-kit-primary-color: ${token.colorPrimary};
    --copilot-kit-contrast-color: ${token.colorWhite};
    --copilot-kit-background-color: ${token.colorBgContainer};
    --copilot-kit-input-background-color: ${token.colorBgContainer};
    --copilot-kit-secondary-color: ${token.colorBgContainer};
    --copilot-kit-secondary-contrast-color: ${token.colorText};
    --copilot-kit-separator-color: ${token.colorBorderSecondary};
    --copilot-kit-muted-color: ${token.colorTextQuaternary};

    /* 输入区那一整条的高度的**兜底值**（186 = 输入框 146 + Powered by 24 +
     * 下外边距 16）。
     *
     * ⚠️⚠️ 2026-10-22 起它只是兜底，运行时会被**实测值**覆盖
     * ------------------------------------------------------
     *   上面那个算式里有两截不由我们决定：Powered by 不渲染时少 24，
     *   正文写满一屏时 textarea 长到 240（多 144）。常数一旦偏大，贴输入框
     *   上沿的那几层（任务 dock / 审批卡 / 问候语）就会被顶上去几十像素 ——
     *   用户报的"dock 下方和 input 框间距太大"就是它。
     *   真正的值由 useInputRegionHeight（index.tsx 里调）量
     *   「对话区底边 − 输入框上沿」后写回这个变量；这里保留常数是为了
     *   jsdom / happy-dom（没有布局，量不出来）以及首帧。
     *   下面那两处（.copilotKitInput 的 min-height、textarea 的 min-height）
     *   仍然要和它同口径，改了行数就一起改。 */
    --dock-input-h: 186px;

    /* 消息**正文**的左边缘（相对对话区左边界）＝ 16 + 24 + 16 = 56px：
     *   · 16 —— 上面 .copilotKitMessages 的左右 padding（token.padding）；
     *   · 24 —— 库自己的 .copilotKitMessagesContainer { padding: 1rem 24px }
     *           （**不是**我们的值，改它要连着下面一起改）；
     *   · 16 —— 每条消息 .copilotKitMessage 的左右 padding（token.padding）。
     *
     * 谁要用它：那些**不套 .copilotKitMessage 外壳**的裸 div —— 工具记录
     * （ToolActivityRow）与输入框上方的状态浮层。它们若从对话区左边界起排，
     * 就会比正文左突 56px，看着像"没对齐"（用户就是这么反馈的）。
     * 卡片用 margin、浮层用 padding 让开这一段，两种做法都指向这一个值。 */
    --dock-text-inset: calc(${token.padding}px * 2 + 24px);

    /* CopilotChat 的根撑满对话区。
     * 只针对 .copilotKitChat 而不是裸的 "& > div" —— 提示条也是 chatPane 的
     * 直属 div，用裸选择器会把 flex 规则套到那个绝对定位的提示条上（虽然
     * absolute 子元素会忽略 flex 属性，但那是"碰巧没事"，不该靠它）。 */
    & > .copilotKitChat {
      flex: 1 1 auto;
      min-height: 0;
      /* 原生 z-index: 30 —— 见上面 ⚠️，它会把整个对话区抬出去压住覆盖层。
       * 这里靠 (0,2,0) > (0,1,0) 稳赢，不需要 !important。 */
      z-index: auto;
    }

    /* ---- 消息样式：参考 DeepSeek 前端 ----
     *
     * DeepSeek 的做法是「几乎不卡片」：没有边框、没有投影，靠**留白**和
     * **极浅的底色**分层次。我们之前的版本给每条消息都加了边框 + 投影，
     * 一屏下来全是盒子，视觉噪音很大（用户反馈"卡片太丑"）。
     *
     * 三条原则：
     *   ① 助手消息**不画框** —— 它是主角，靠留白跟灰底区分就够了；
     *   ② 用户消息用主色**实心**气泡（DeepSeek 就是实心），右对齐；
     *   ③ 层次靠 background 差值，不靠 box-shadow。
     *
     * 反馈按钮那一段有非常长的踩坑注释（absolute 两端对齐 / 特异性 / 反引号），
     * 别删 —— 见下面那条选择器上的说明。 */
    & .copilotKitMessages {
      padding: ${token.paddingSM}px ${token.padding}px;
      /* 底部再让开一层：输入框上沿那圈状态层（工具记录 / 正在…）是 absolute 的，
       * 不预留的话它会盖住最后一条消息的末尾。高度由 LiveActivityOverlay
       * 量出来写到 --dock-tool-feed-h（没有那一层时是 0）。 */
      padding-bottom: calc(
        ${token.paddingSM}px + var(--dock-tool-feed-h, 0px)
      );
      background: transparent;
    }

    & .copilotKitMessage {
      /* 纵向 padding **固定为 0**：助手消息是没有底色的纯文字块，给它上下
       * 内边距等于凭空多出一种"看不见的间距"—— 折叠行与正文之间会凭空
       * 多出 12px，而需求要求 section 内一律最小档。左右 16px 保留：正文
       * 左边缘 = 16 + 24 + 16 = 56（见 --dock-text-inset 的那笔账）。
       * 有气泡的用户消息自己补纵向 padding（见下），它需要"文字离边框"。 */
      padding: 0 ${token.padding}px;
      margin: 0;
      border-radius: ${token.borderRadiusLG}px;
      /* 卡片感全靠这个色阶差，不加边框也不加投影 */
      background: ${token.colorFillQuaternary};
      box-shadow: none;
      border: 0;
    }

    /* ================================================================== *
     * 库自带的「三点跳动」loading —— **不显示**
     *
     * 2026-10-21 用户：「去掉这个 loading icon」。它有两个出现点（都在库里）：
     *   · AssistantMessage 的 isLoading（气泡下方）；
     *   · Messages 末尾那条"inProgress 且最后一条是 user / tool"（列表末尾）。
     *
     * ⚠️ 为什么用 display:none，而不是给它传 icons.activityIcon = null
     * ----------------------------------------------------------
     *   icons 只换**图标节点**，那个带 data-testid 的 span 还在，库还给它
     *   留了尺寸与行高 —— 界面上会剩一块空位（比三个点更难解释）。
     *
     * ⚠️ 为什么可以安全去掉
     * -----------------------
     *   输入框上沿那枚胶囊（LiveActivityOverlay）已经在报「正在组织回答」/
     * 「正在调用工具」，同一件事不必说两遍；而「正在思考」那一行自己也有文案。
     *
     * ⚠️ 本段在 CSS 模板字符串里 —— 注释中不能出现反引号（会提前闭合模板）。
     * ================================================================== */
    & [data-testid='copilot-loading-cursor'] {
      display: none;
    }

    /* 助手消息：连底色都不要，纯靠留白（DeepSeek 就是这样，干净）。 */
    & .copilotKitMessage.copilotKitAssistantMessage {
      max-width: 100%;
      /* ⚠️ 库把它写成 padding-left: 0（同为 (0,2,0)，和上面那条打平 —— 赢不赢
       *    取决于样式表注入顺序）。这里明确写回来：正文左边缘必须和"思考过程"
       *    那一行同一条竖线（56px，见 --dock-text-inset 的那笔账）。 */
      padding-left: ${token.padding}px;
      /* 右侧**不留内边距**（2026-10-21 需求原话：「AI 消息卡片不再需要居左，
       * 居中即可，右侧间距和用户消息卡片的右间距是相同的」）。
       * 原来左右都留 16，于是正文右边缘（338）比我的气泡右边缘（354）短一截，
       * 一段话在视觉上像没写完就断了；现在正文右边缘与气泡右边缘齐平，
       * 整块正文在"左 56 / 右 46"之间，重心落在中间。 */
      padding-right: 0;
      background: transparent;
      color: ${token.colorText};
    }

    /* 用户消息：主色实心 + 右对齐。这是 DeepSeek 最标志性的一处。
     * 纵向 12px 是**固定的内边距**（文字与气泡边缘的距离），不参与三档间距 —
     * 气泡是画出来的盒子，边到字必须有呼吸；而"盒子到盒子"的距离仍然只由
     * chatPane 的三档表决定。 */
    & .copilotKitMessage.copilotKitUserMessage {
      max-width: 88%;
      margin-inline-start: auto;
      padding-block: ${token.paddingSM}px;
      background: ${token.colorPrimaryBg};
      color: ${token.colorText};
    }

    /* ================================================================== *
     * 一条消息 = 一个 section：深度思考 → 正文 → 工具调用状态框
     *
     * 需求原话（2026-10-20）：
     *   ① 「sse 事件渲染和 message 渲染必须保持一致……不区分 chat 还是
     *      tool_activity，都按照 深度思考 → 正文 → tool 调用状态提示框
     *      作为一个 section 来渲染」；
     *   ② 「section 内 思考过程正文工具调用 间距全部相同 为最小挡位；消息卡片
     *      和下方复制编辑返回 icon 间距 为中档；卡片与卡片之间 间距相当 为
     *      最大档。一共只有这三种间距规格。消除所有元素自带的 margin，
     *      padding 改为固定」。
     *
     * 做法：**不用 gap**，先统一归零、再按"谁跟谁相邻"给三档之一
     * -------------------------------------------------------
     *   为什么不用 gap：section 是 flex 列，gap 对**所有**相邻子项一视同仁，
     *   而这里"卡片 ↔ 图标行"要中档、其余要最小档。上一版就是 gap:2px +
     *   负 margin 往回收，越改越多第四种间距（2 / 4 / 8 / 12 同时存在）。
     *
     *   ① 归零：直接子项 margin-block 一律 0 —— 库给 .copilotKitMessage 的
     *      .5rem、给图标行的、以及我们自己的负 margin 全部作废。
     *   ② 最小档 SPACE_TIGHT：任意两个相邻子项之间（思考 / 正文 / 工具框 /
     *      并行调用的多行）。
     *   ③ 中档 SPACE_MID：卡片与它下面那行图标（data-user-actions）。
     *   ④ 最大档 SPACE_WIDE：section 与 section 之间。
     *
     * ⚠️ 归零那条必须写在档位几条**之前**：③ 与 ② 特异性相同，靠顺序取胜，
     *    把归零放到后面会把它俩一起盖回 0。
     * ⚠️ 本段在 CSS 模板字符串里，注释中**不能出现反引号**。
     * ================================================================== */
    & [data-section-view] {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      min-width: 0;
    }

    /* ① 归零 —— 消除所有元素自带的 margin，间距只可能来自下面三条。 */
    & [data-section-view] > * {
      margin-block: 0;
    }

    /* ② 最小档 —— section 内部一律相同。 */
    & [data-section-view] > * + * {
      margin-top: ${SPACE_TIGHT}px;
    }

    /* ③ 中档 —— 卡片与下方那行图标（复制 / 编辑）。 */
    & [data-section-view] > [data-user-actions='true'] {
      margin-top: ${SPACE_MID}px;
    }

    /* ④ 最大档 —— section 与 section。 */
    & [data-section-view] + [data-section-view] {
      margin-top: ${SPACE_WIDE}px;
    }

    /* ================================================================== *
     * ⑤ 工具卡：与**它自己这一步**之间一律最小档（2026-10-21）
     *
     * 用户原话：「这里 ABCD 的间距不是应该都一样吗？都属于统一挡位的」
     * ——  思考过程 / 正文 / 工具卡 这四道缝是一个挡位（最小档），
     * 只有"这一步 → 下一步"（两条消息之间）才走最大档。
     *
     * ⚠️ 为什么需要两个标记，而不是一条"tool 后面一律最小档"
     * ---------------------------------------------
     *   CSS 只看**相邻**，分不出这两张卡是不是同一条消息：
     *     · 同一条消息：正文卡 → 工具卡（最小档）
     *     · 两条消息之间：上一条的正文卡 → 这一组工具卡（最大档）
     *   所以由渲染层标出组首（data-section-step-attached，紧跟自己那条
     *   消息的正文卡）与组尾（data-section-step-end，它后面是另一条消息）。
     *   见 ToolActivityCards 的注释。
     *
     * ⚠️ 本段在 CSS 模板字符串里 —— 注释中不能出现反引号（会提前闭合模板）。
     *
     * ⚠️ 特异性：这三条与上面 ④ 同为"两个属性选择器"，靠**写在后面**取胜
     *    （别把它们挪到 ④ 前面）；最后那条组尾有三个属性选择器，压得住
     *    本段里所有两条 —— 顺序再怎么动它都赢。
     * ================================================================== */
    & [data-section-view='chat'] + [data-section-view='tool'][data-section-step-attached='true'] {
      margin-top: ${SPACE_TIGHT}px;
    }

    & [data-section-view='tool'] + [data-section-view='tool'] {
      margin-top: ${SPACE_TIGHT}px;
    }

    /* 一组工具卡的最后一张 -> 下一步（另一条消息）：回到最大档。 */
    & [data-section-view='tool'][data-section-step-end='true'] + [data-section-view] {
      margin-top: ${SPACE_WIDE}px;
    }

    /* ================================================================== *
     * 任务时间线（2026-10-22）
     *
     * 需求原话：「task 相关的内容左侧添加纵向 timeline，灰色节点以 task 为单位」。
     * 参考图（用户截图）：一条**连续的浅灰竖线**，每个任务一个**空心圆点**
     * （灰边、白心），圆点与第一行内容齐平，内容在轨道右侧。
     *
     * 结构（由 DockRenderMessage / ToolActivityCards 输出）：
     *   [data-task-id] 这一行属于某个任务
     *     ├ span[data-task-rail]    竖线（绝对定位，1px）
     *     └ span[data-task-node]    空心圆点（只有组首那一行有）
     *   data-task-open-top / -bottom  竖线要不要往上下各探出一段
     *   data-task-linked              这一行接着上一行走（间距也收到最小档）
     *
     * ⚠️ 为什么竖线要往两头**探出**一段（--task-rail-gap）
     * -------------------------------------------------
     *   每一行是自己的 section，行与行之间那段缝不属于任何一行 —— 只在行内
     *   画线的话，线会在每一条缝处断开，视觉上变成一串短横线。
     *   而"这段缝有多宽"是个常量（最小档 12px，见上面那条 linked 规则），
     *   所以非组首的行往上探一格、非组尾的行往下探一格，相邻两行正好接上。
     *   **不需要测量真实高度**，也就没有 ResizeObserver 与重排抖动。
     *
     * ⚠️ 圆点的底色**必须是实色**
     * -------------------------
     *   它压在竖线上（用来"打断"线条，做出节点的观感）。用透明底的话线会
     *   从圆圈中间穿过去，看起来像个箭头而不是节点。
     *
     * ⚠️ 不要给 [data-task-id] 之外的 section 加 padding-left
     * --------------------------------------------------
     *   时间线是**嵌套块**：任务内的正文整体右移 20px，与"思考 → 正文"那条
     *   竖线不再对齐是**故意的**（缩进本身就是"这段属于上面那个节点"的信号）。
     *   任务外的消息一个字都不能挪 —— 那才是用户反复要求的对齐。
     *
     * ⚠️ 本段在 CSS 模板字符串里，注释中**不能出现反引号**。
     * ================================================================== */
    & [data-task-id] {
      /* 行与行之间那段缝的宽度 —— 竖线往两头探出的量，两处必须同一个值。 */
      --task-rail-gap: ${SPACE_TIGHT}px;
      position: relative;
      /* 让开轨道：圆点在 2..11，正文从 20 起排。 */
      padding-left: 20px;
    }

    /* 同一个任务里相邻的两行：最小档（默认是 section 之间的最大档）。
     * 特异性与上面那条 step-end 打平（都是三个属性），靠**写在后面**取胜。 */
    & [data-section-view][data-task-id][data-task-linked='true'] {
      margin-top: var(--task-rail-gap);
    }

    & [data-task-rail] {
      position: absolute;
      /* 1px 宽的线，圆心在 6.5 —— 与下面圆点的圆心同一条竖线。 */
      left: 6px;
      /* 默认从节点中心起（组首那一行）；非组首由 open-top 改写成往上探。 */
      top: 9px;
      bottom: 0;
      width: 1px;
      background: ${token.colorBorderSecondary};
      pointer-events: none;
    }

    & [data-task-open-top='true'] > [data-task-rail] {
      top: calc(-1 * var(--task-rail-gap));
    }

    & [data-task-open-bottom='true'] > [data-task-rail] {
      bottom: calc(-1 * var(--task-rail-gap));
    }

    & [data-task-node] {
      position: absolute;
      left: 2px;
      top: 5px;
      width: 9px;
      height: 9px;
      box-sizing: border-box;
      border: 1px solid ${token.colorBorder};
      border-radius: 50%;
      /* 实色（见上面 ⚠️）：它要盖住竖线，做成"线上的节点"。 */
      background: ${token.colorBgContainer};
      pointer-events: none;
    }

    /* 组首那行小标题：「任务 3 · 获取并整理 A 公司本季度财报」。
     *
     * ⚠️⚠️ 必须**一行截断**（2026-10-22 用户截图：标题铺成 5 行灰字）
     * ------------------------------------------------------
     *   标题取自任务指令里的 description，而那是**一整段**说明
     *   （「目标：… 输入：… 约束：… 预期产出：… 验收标准：…」）。
     *   照原样放出来，一个任务的头就是一个五行的灰块 —— 它压过了下面真正的
     *   正文，还把下一条任务挤到屏幕外。
     *   一个节点只需要回答"这是哪个任务"，完整描述走 title 属性悬停（见
     *   DockRenderMessage 的 taskHead）。所以这里 nowrap + 省略号。
     *   ⚠️ 别改成 line-clamp 两行：两行的头在半宽面板里会变成"半截句子"，
     *      比一行更难读，而且不同任务的头部高度会忽高忽低。
     * ⚠️ 本段在 CSS 模板字符串里 —— 注释中不能出现反引号。
     */
    & [data-task-head] {
      /* 撑满一行：不写 min-width: 0 的话 flex 子项会被内容顶开，
       * 省略号永远不会出现（section 是 flex 列，这里是它的直接子项）。 */
      min-width: 0;
      overflow: hidden;
      font-size: ${token.fontSizeSM}px;
      line-height: ${token.lineHeightSM};
      color: ${token.colorTextTertiary};
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* 任务行的正文块（Markdown）。
     *
     * ⚠️ 这 16px 是**对齐**用的，不是留白
     * ------------------------------
     *   同一任务里的其它行都走库的 .copilotKitMessage，它自带 padding-left: 16px；
     *   工具卡的 .toolActivity 也是 margin-inline: 16px。任务行的正文是裸
     *   div（不套气泡），不补这一下就会比上下两行左突 16px —— 一段话单独往左
     *   戳出来，看着像排版坏了。
     *
     * ⚠️ 本段在 CSS 模板字符串里，注释中**不能出现反引号**。 */
    & [data-task-body]
    {
      padding-left: ${token.padding}px;
    }

/* ================================================================== *
 * 思考过程 → 正文之间那个**空 div**
 *
 * 结构（库的 before 分支 + 我们的折叠行）：
 *   [折叠行]  [库的 coagent bridge 空 div]  [.copilotKitMessage]
 * 那个空 div 自带**内联** style marginBottom .5rem —— 它夹在两者之间就是
 * 一条额外的 8px，属于需求要消灭的"元素自带的 margin"。但 class 规则压
 * 不住内联，只能 !important。
 *
 * ⚠️ 用 :empty 认它 —— 本面板没注册 coagent state render，它必然为空；
 *    将来真往里塞了内容，这条自然不生效（留白回到库给的值，不算错）。
 * ⚠️ 上下都要清：它是 section 的直接子项，会被"相邻子项 = 最小档"那条
 *    规则补上 margin-top —— 而它高度是 0，那 4px 就是纯多余的空隙。
 * ================================================================== */
  & [data-section-view] > div:empty
  {
    margin-block: 0 !important;
  }

/* ---- 反馈按钮（重新生成 / 复制 / 赞 / 踩）----
 *
 * ⚠️ 这段的血泪史，别"顺手简化"（每一条都实测过）：
 *
 * 1. 原生是 absolute + left:0 且**没有 top/bottom**（top 来自静态位置）。
 *    我们给消息加了背景之后按钮会掉出消息块。
 *    → 解法是**改用 relative 回到正常流**。
 * 2. 试过 absolute + bottom 的各种写法，全部失败：
 *    top:auto 无效（auto 就是"回到静态位置"）；
 *    top:具体值 + bottom → CSS 2.1 §10.6.4 两端对齐，按钮被拉成整条。
 * 3. relative 下**不能写 left** —— 那是"相对原位置偏移"，会叠加成双倍。
 * 4. relative 会让元素变块级占满整行，要 width: fit-content 收回来。
 *
 * ⚠️ 消息**不再**留 padding-bottom 给这一行（旧版是 12px，另外还会在
 *    "正文下面紧跟工具框"时收成 4px —— 那份条件 padding 正是第四种间距）。
 *    现在助手消息纵向 padding 固定 0，图标行与正文的间距只由下面的
 *    margin-top 给（中档），图标行下方就是消息底，间距归 section 那条。
 *
 * ⚠️ 本段在 CSS 模板字符串里，**注释中不能出现反引号** ——
 *   会提前闭合模板字符串，报 TS1005 且行号指向注释行，极难定位。 */

  & .copilotKitMessage.copilotKitAssistantMessage .copilotKitMessageControls
  {
    position: relative;
    width: fit-content;
  /* 与「我的消息」那行按钮同一个横向间距（userMessageActions 的 gap）。
   * 原生 gap 是 1rem，这个窄面板里太散 —— 两行按钮必须看起来是同一套。 */
    gap: ${token.marginSM}px;
  /* 原生给的是 padding: 5px 0 0 0 —— 那 5px 会叠加在 margin 之上，
   * 又是一条"元素自带的内边距"。归零，间距只认下面那一条。 */
    padding: 0;
  /* 与正文（也就是"卡片"）之间：**中档**（三档见文件顶部常量）。
   *
   * ⚠️ 用 margin 而**不是** top 偏移：top 不改布局，消息外框不会跟着
   *   变高，偏移会让图标行直接**溢出**消息块、压到下面那条消息上。 */
    margin-top: ${SPACE_MID}px;
  /* 反馈图标本身也压暗一点：它是辅助操作，不该跟正文抢注意力 */
    opacity: 0;
    transition: opacity 0.2s ease;

  /* ============================================================== *
   * 按钮本体：与「我的消息」的 userAction **逐条对齐**
   *
   * 需求原话（2026-10-21）：「双方消息卡片下方 icon 统一来源和效果样式
   * 大小，相同功能要用相同 icon」。
   * 图标来源已统一到 messageActionIcons.tsx，这里对齐的是"效果 / 大小"：
   *   热区 24×24（= controlHeightSM，与 antd size=small 的按钮同高）
   *   图标 16px（= fontSizeLG）
   *   静止 colorTextTertiary、悬停 colorText、**不铺底色**
   * 库默认是 20×20 + 主色 + 圆角hover，和我的消息那两枚明显不是一套。
   * ============================================================== */
  & .copilotKitMessageControlButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: ${token.controlHeightSM}px;
    height: ${token.controlHeightSM}px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: ${token.colorTextTertiary};
    transition: color 0.2s ease;

    & .anticon {
      font-size: ${token.fontSizeLG}px;
    }

    &:hover {
      color: ${token.colorText};
      background: transparent;
    }
  }
}

  /* 复制成功后库自己塞一个**内联** style 的 10px 加粗「✓」
   * （dist/index.mjs：fontSize 10 / fontWeight bold），和我的消息那边换成
   * CheckOutlined（16px）的状态长得不一样。内联压不住，只能 !important；
   * 选择器带 [style] 是刻意的 —— 只有那个「✓」带内联样式，
   * antd 图标的 anticon 不带，不会误伤。 */
  & .copilotKitMessageControlButton > span[style] {
    font-size: ${token.fontSizeLG}px !important;
    font-weight: 400 !important;
  }

/* ================================================================== *
 * 反馈图标行**只在最后一条 AIMessage 下面出现**
 *
 * 需求原话：「一轮次对话中，只在最后一条 AIMessage 下方加上反馈按钮，
 * 前面的都是思考过程带上 tool call」。
 *
 * currentMessage 这个类由我们的 DockRenderMessage 挂上来 —— 它把库的
 * 「数组最后一个元素」改判成「最后一条 AIMessage」（推导见 finalAnswer.ts）。
 * 库自己那条 .copilotKitMessageControls.currentMessage{opacity:1!important}
 * 负责**显形**，这里这条负责**其余一律不显**。
 *
 * ⚠️ 必须用 display:none，**不能只按 opacity**
 * ------------------------------------------
 *   原本有三条规则会把它点亮，而且都作用于**每一条**助手消息：
 *     · 库的 .copilotKitAssistantMessage:hover … { opacity: 1 }
 *     · 库的 @media (max-width: 768px) … { opacity: 1 }（窄屏常显）
 *     · 本项目自己补的 :focus-within 与 @media (hover: none)
 *   只把 opacity 按下去的话，鼠标一悬停、键盘一聚焦、或窗口一窄，
 *   **过程消息**上就又冒出这一行 —— 那正是要修掉的观感。
 *   display:none 把元素整个摘掉，上面任何一条都点不亮它。
 *
 * ⚠️ 已知副作用（与需求一致，不改）：**历史消息不再能悬停复制 / 重新生成**。
 *   要恢复的话得把这些按钮从"反馈行"里拆出来单独渲染，那是另一件事。
 *
 * ⚠️ 本段在 CSS 模板字符串里，注释中**不能出现反引号**（会提前闭合模板，
 *   报一堆莫名其妙的 TS1005）。上面那些选择器都不要加引号包裹。
 * ================================================================== */
  & .copilotKitMessage.copilotKitAssistantMessage .copilotKitMessageControls:not(.currentMessage)
  {
    display: none;
  }

/* ================================================================== *
 * Markdown 正文：为**这条窄面板**重做排版
 *
 * 为什么必须做（下面每个数都是 CDP 实测，不是猜）：
 *   1. 库的 markdown 样式（node_modules/@copilotkit/react-ui/dist/index.css
 *      1076-1225 行）有 h1~h6 / 段落 / 引用 / 列表 / 行内代码 / 代码块，
 *      **唯独没有任何 table / th / td 规则**；defaultComponents 也没映射表格
 *      （只映射 a/code/h1~h6/p/pre/blockquote/ul/li，见 index.cjs 1300+）。
 *      于是 GFM 表格直接落到**浏览器默认样式**：实测 border-collapse:separate、
 *      边框 0、th padding 1px，宽度还被内容撑到 **417px > 容器 372px**，
 *      右列文字糊出消息框 —— 用户说的"显示非常乱"主因就是它，**不是没渲染 md**。
 *   2. 库给 h1 1.5em / h2 1.25em，在 372px 的面板里像大字报。
 *
 * ⚠️ 标题那几条**故意多带一个 .copilotKitMarkdownElement**：
 *   库的 margin 规则是 h1.copilotKitMarkdownElement:not(:last-child)，
 *   特异性 (0,2,1) 跟「& .copilotKitMarkdown h1」**(0,2,1) 打平** —— 平局就由
 *   样式表先后顺序决定，赢不赢不保险。带上元素类变 (0,3,1) 才稳。
 *   （跟上面消息选择器把 copilotKitAssistantMessage 写两遍是同一个坑。）
 *
 * ⚠️⚠️ 本段在 CSS 模板字符串里 —— **注释里绝不能出现反引号**（下面那种
 *   「」引号可以）。反引号会提前闭合模板、报 "Expected } but found ..."，
 *   且行号指向注释本身，极难定位。本轮实测又踩了一次。
 * ================================================================== */

/* ---- 表格：撑满容器 + 固定列宽 + 折叠边框 ----
 * table-layout: fixed 是**故意的**：自动布局按内容比例分宽度，一串长行内代码
 * 能把"工具"列吃到大半、把说明列挤到很窄；fixed 让各列等宽、结果可预期，
 * 长内容在单元格内换行，彻底消灭 417 > 372 那 45px 的溢出。 */
  & .copilotKitMarkdown table
  {
    width: 100%;
    max-width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
  /* 比正文小一档：窄栏里密一点更好读 */
    font-size: 0.85em;
    margin: 0 0 1em;
  }

  & .copilotKitMarkdown th,
    & .copilotKitMarkdown td
  {
    border: 1px solid ${token.colorBorderSecondary};
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  /* 长 token（接口名 / 路径）必须在窄列里能断；否则单元格的 min-content
   * 会把列宽顶回去、重新撑破容器（overflow-wrap: break-word 压不住
   * min-content，得用 anywhere）。 */
    overflow-wrap: anywhere word-break : break-word;
  }

  & .copilotKitMarkdown th
  {
    background: ${token.colorFillTertiary};
    font-weight: 600;
  }

/* 表格里的行内代码别再带库那份绝对字号（15px）+ 内边距 ——
 * 它是把"工具"那一列顶宽的主要推手。 */
  & .copilotKitMarkdown th .copilotKitInlineCode,
    & .copilotKitMarkdown td .copilotKitInlineCode
  {
    font-size: inherit;
    padding: 0 3px;
  }

/* ---- 有序列表的编号（必须自己补）----
 *
 * ⚠️ 库**没有** ol 的规则，编号会被项目全局重置吃掉
 * ------------------------------------------------
 *   库的 defaultComponents 只映射了 ul / li，**没有 ol**
 *   （index.cjs 1340+）。所以有序列表的 ol 是个裸元素，拿不到
 *   .copilotKitMarkdownElement 那个类，也就没有对应的库样式。
 *
 *   而库把 li.copilotKitMarkdownElement 设成 list-style-type: inherit
 *   —— 编号取的是**它父级列表**的值。两件事凑一起就出事：
 *     · ul 侥幸活下来：库有 ul.copilotKitMarkdownElement{list-style-type:disc}
 *       （特异性 (0,1,1)），压过了全局那条 ul, ol { list-style: none }（(0,0,1)）；
 *     · ol 没有对应的库规则 → 被全局那条重置成 none → 每个 li 继承 none
 *       → **编号整排消失**，只剩下缩进（看起来像普通段落）。
 *   CDP 实测过：ol.listStyleType === "none"、ol > li 也是 "none"，
 *   而同屏的 ul / ul > li 都是 "disc"。全局那条重置在
 *   src/global.less（脚手架带的），**不动它** —— 它是给布局用的，
 *   在聊天区里按组件收口才是对的。
 *
 *   这里补的选择器是 (0,2,1)，稳定赢过全局那条。 */
  & .copilotKitMarkdown ol
  {
    list-style-type: decimal;
  /* 缩进对齐 ul（库给 ul 的是 20px）。不设的话用 UA 的 40px，
   * 同一个回答里两种列表会一个缩进一个不缩进。 */
    padding-left: 20px;
    overflow: visible;
  }

/* ---- 标题：整体收一档 + 补上间距 ----
 * 库只给了 margin-bottom: 1rem、**没有 margin-top**，标题会贴住上一段。 */
  & .copilotKitMarkdown h1.copilotKitMarkdownElement,
    & .copilotKitMarkdown h2.copilotKitMarkdownElement,
    & .copilotKitMarkdown h3.copilotKitMarkdownElement,
    & .copilotKitMarkdown h4.copilotKitMarkdownElement,
    & .copilotKitMarkdown h5.copilotKitMarkdownElement,
    & .copilotKitMarkdown h6.copilotKitMarkdownElement
  {
    margin-top: 1.25em;
    margin-bottom: 0.5em;
  }

  & .copilotKitMarkdown h1.copilotKitMarkdownElement
  {
    font-size: 1.25em;
  }
  & .copilotKitMarkdown h2.copilotKitMarkdownElement
  {
    font-size: 1.125em;
  }
  & .copilotKitMarkdown h3.copilotKitMarkdownElement
  {
    font-size: 1em;
  }
  & .copilotKitMarkdown h4.copilotKitMarkdownElement,
    & .copilotKitMarkdown h5.copilotKitMarkdownElement,
    & .copilotKitMarkdown h6.copilotKitMarkdownElement
  {
    font-size: 0.9375em;
  }

/* ---- 正文的第一块 / 最后一块：不许自带 margin ----
 *
 * ⚠️ 这就是用户截图里"思考过程 → 大标题"那一大段空白（约 30px）的来源：
 *    标题那条规则是 (0,3,1)，而旧的「> :first-child」只有 (0,2,0) ——
 *    因此 h1 的 margin-top: 1.25em 赢了，正文第一块照样被推下去一截。
 *    带上元素类后是 (0,4,0)（& + .copilotKitMarkdown + :first-child +
 *    .copilotKitMarkdownElement），稳定赢过标题规则。
 *
 * 最后一块同理：「p:not(:last-child)」给的是 1.25em，正文收尾时会在
 * section 末尾多出一段 —— 之后紧跟工具框，就又是一条额外间距。
 */
  & .copilotKitMarkdown > :first-child,
    & .copilotKitMarkdown > :first-child.copilotKitMarkdownElement
  {
    margin-top: 0;
  }

  & .copilotKitMarkdown > :last-child,
    & .copilotKitMarkdown > :last-child.copilotKitMarkdownElement
  {
    margin-bottom: 0;
  }

/* ---- 行内代码：窄栏里允许在任意位置断，避免整行被顶出去 ---- */
  & .copilotKitMarkdown .copilotKitInlineCode
  {
    overflow-wrap: anywhere word-break : break-word;
  }

/* ---- 围栏代码块：修库的**工具栏**溢出 ----
 * 长代码行本身没问题：高亮容器自带 overflow-x:auto（实测 scrollW 1202 /
 * clientW 372，内部滚动正常）。真正溢出的是工具栏 —— 库给了
 * 「width: 100%」+「padding-left: 1rem」却没设 box-sizing（默认 content-box），
 * 盒子变成 372 + 16 = **388**，比圆角外框宽 16px，复制/下载按钮跟着右移出去。
 * border-box 一处修好。 */
  & .copilotKitMarkdown .copilotKitCodeBlockToolbar
  {
    box-sizing: border-box;
  }

/* ---- 输入框：DeepSeek 那种圆角胶囊 ----
 *
 * 高度按「**正文 4 行**」定（需求：对话框 4 row 高）。实测拆解：
 *   · textarea             96px = 4 × 24px（库的 line-height 是 1.5rem）
 *   · 控件行               28px
 *   · 胶囊上下内边距        20px
 *   · 胶囊上下 1px 边框      2px   ← 就是它让"算出来的 144"变成实测 146
 *   · 小计（胶囊外框高）    146px
 *   · Powered by           24px
 *   · 胶囊下外边距          16px
 *   · 合计（输入区总高）    186px  ← 就是 --dock-input-h 要的值
 * 拿掉任何一个都会让问候语的垂直居中偏掉，改行数时这一组一起改。
 *
 * ⚠️ 为什么还要留在容器上（而不是只给 textarea）
 * --------------------------------------------
 *   库的默认输入框里 textarea 自身 height 是 **0**（实测），可视高度全靠
 *   容器 min-height 撑；压到 56px 时容器里只剩 padding、按钮行被挤出可视区。
 *   我们现在是自研 Composer，textarea 有真实高度（行内 style = scrollHeight，
 *   见 Composer.tsx 的 resizeTextarea），所以容器这条 min-height 是"地板"
 *   而不是"撑起"：textarea 万一塌了，按钮行也还在原位。
 *
 * 高度仍然是**弹性**的：空的时候停在 5 行，写超了就涨到 max-height 为止
 * （textarea 内部滚动），胶囊跟着往上长、底边不动。
 */
  & .copilotKitInput
  {
  /* ⚠️ width: auto 不是可省的
   * ------------------------
   * 库给的是 width: 95% + margin: 0 auto；我们把它改成左右等距的 margin。
   * 但**只改 margin 不改 width** 会踩 CSS 2.1 的「过度约束」：块级元素同时
   * 有确定的 width 和两个非 auto 的 margin 时，LTR 下 margin-inline-end 会被
   * 丢掉重算 —— 实测左边距 16px、右边只剩 5px（输入框看着偏左）。
   * width: auto 让宽度自己吃掉剩余空间，两边才都是 16px。 */
    width: auto;
  /* 库没给这个盒子设 box-sizing（默认 content-box）。设成 border-box 之后
   * min-height / max-height 才是"**看得见的外框高**"，跟上面那串算式同口径；
   * 否则 min-height 只管内容盒，实际外框还要再加 2px 边框 —— 那正是第一版
   * 把 168 写成"实测 168"、实际量到 170 的原因。 */
    box-sizing: border-box;
    min-height: 146px;
  /* 上限只管"逃逸"：真正的高度天花板是 textarea 自己的 max-height
   * （到顶后它内部滚动），留 50px 余量免得胶囊被内容顶破。 */
    max-height: 340px;
    margin: 0 ${token.padding}px ${token.padding}px;
    padding: 10px 14px;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    border: 1px solid transparent;
    transition: border-color 0.2s ease, background 0.2s ease;
  }

/* 正文的 5 行地板 + 天花板。
 * ⚠️ 这两个值必须与上面 --dock-input-h 的算式一致（index.test.tsx 有断言钉着）。 */
  & .copilotKitInput textarea
  {
    min-height: 96px;
    max-height: 240px;
  }

/* 聚焦时才显出边框：平时是干净的浅灰胶囊，聚焦提示"可以输入了" */
  & .copilotKitInput:focus-within
  {
    background: ${token.colorBgContainer};
    border-color: ${token.colorPrimaryBorder};
  }

/* 原生 InputContainer 底部有 15px padding + 一条分隔色的底边 ——
 * 胶囊风格下这条边会割裂视觉，去掉；padding 交给 Input 自己的 margin。 */
  & .copilotKitInputContainer
  {
    padding-bottom: 0;
    background: transparent;
    border-bottom: 0;
  }

/* 控件行：垂直居中对齐 + 拉开一点间距。
 * 库给的是 display:flex; gap:3px，**没有 align-items** —— 默认 stretch 对
 * "高度已确定"的子项等于 flex-start，于是「深度思考」（24px）和图标按钮
 * （28px）只是顶边对齐，圆心差 2px，一排看过去是歪的（实测 827 vs 829）。
 * gap 3px 也太挤：附件和发送是两个圆按钮，挨在一起像连体。 */
  & .copilotKitInputControls
  {
    align-items: center;
    gap: 6px;
  }
`,

  /* ================================================================== *
   * 下面这些属于 Composer.tsx（DeepSeek 风的输入框，走 CopilotChat 的
   * Input 插槽换掉了库的默认实现）。它们**不在 chatPane 里**：Composer 的
   * 元素直接带着这些 emotion 类名，不靠祖先选择器命中。
   * ================================================================== */

  /**
   * 输入用的 textarea。
   *
   * 只补库没给的三条 —— 字体、颜色、行高、去掉边框/外框、去掉右下角的
   * 拖动把手，库的 `.copilotKitInput >
  textarea` 已经写全了，别重复。
   *
   * ⚠️ 高度**不在这里**：它由 Composer 的 resizeTextarea 逐次写成行内 style
   *   （跟着内容长高），上限由 chatPane 里那条 max-height: 240px 兜住，
   *   超出后 textarea 自己内部滚动。这里写死高度会和行内 style 打架。
   */
  composerTextarea: css`
    display: block;
    box-sizing: border-box;
    width: 100%;
    overflow-y: auto;
/* 原生 textarea 在右下角有个可拖拽的把手，胶囊风格里很突兀 */
    resize: none;
`,

  /**
   * 附件芯片行。夹在正文与控件行之间 —— DeepSeek 就是这么放的
   * （芯片属于"这一条消息"而不是"输入框的某个按钮"）。
   * 换行而不是横向滚动：面板只有屏宽 1/3，横向滚动条在这里很碍事。
   */
  attachChips: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
/* 与下面的控件行拉开一点，不然芯片会贴着按钮 */
    margin: 8px 0 6px;
`,

  attachChip: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    box-sizing: border-box;
    height: 24px;
    padding: 0 4px 0 8px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: 999px;
    background: ${token.colorBgContainer};
    font-size: ${token.fontSizeSM}px;
    line-height: 1;
    color: ${token.colorTextSecondary};
`,

  /** 文件名：长名字截断（面板窄，一个长文件名能把整行撑爆）。 */
  attachChipName: css`
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`,

  attachChipDel: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: ${token.colorTextQuaternary};
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover
    {
      background: ${token.colorFillSecondary};
      color: ${token.colorText};
    }

    &:focus-visible
    {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: 1px;
    }
`,

  /**
   * 「深度思考」胶囊开关。
   *
   * 高度跟输入框里那两个图标按钮**对齐到同一行**，所以取 24px（图标按钮 28px
   * 更高，但它们并不同高也不会错位 —— 控件行 align-items 默认 stretch，
   * 而两者都有显式高度，不会被拉伸）。
   *
   * ⚠️ box-sizing: border-box 必须写：默认是 content-box，
   *   height 24 + 上下各 1px 边框 = 26px，控件行就被撑高 2px，
   *   连带 inputContainer 的总高（--dock-input-h: 186px）也不准了。
   *
   * 两态：关 = 素胶囊（描边 + 次要文字色），开 = 主色淡底（DeepSeek 就是
   * 用一个蓝色调的胶囊表示"这一轮带思考"）。不靠颜色单独表意：
   * aria-pressed 让读屏也能报出状态。
   */
  thinkToggle: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    height: 24px;
    padding: 0 8px;
    border: 1px solid ${token.colorBorder};
    border-radius: 999px;
    background: transparent;
    font-family: inherit;
    font-size: ${token.fontSizeSM}px;
    line-height: 1;
    color: ${token.colorTextSecondary};
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;

    &:hover
    {
      background: ${token.colorFillSecondary};
      color: ${token.colorText};
    }

    &:focus-visible
    {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: 1px;
    }
`,

  thinkToggleOn: css`
    border-color: ${token.colorPrimaryBorder};
    background: ${token.colorPrimaryBg};
    color: ${token.colorPrimary};

    &:hover
    {
      background: ${token.colorPrimaryBgHover};
      color: ${token.colorPrimary};
    }
`,

  /**
   * 附件按钮（回形针）。
   *
   * ⚠️ 故意**不带**库的 copilotKitInputControlButton 类
   * ------------------------------------------------
   *   带上就要跟库那一长串规则打特异度官司（它给未禁用态直接刷成主色、
   *   hover 还要 scale(1.05)），而我们要的是"安静的次要图标"。
   *   这个按钮的外观由本文件全权负责，库的类一个都不加，就没有输赢问题。
   */
  attachButton: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: ${token.colorTextTertiary};
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease;

    &:hover
    {
      background: ${token.colorFillSecondary};
      color: ${token.colorText};
    }

    &:focus-visible
    {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: 1px;
    }
`,

  /**
   * 发送/停止按钮：主色实心圆（DeepSeek 的标志性一处）。
   *
   * 图标是库的 SendIcon（一支向上的箭头）/ StopIcon（方块）/ 未就绪时的
   * spinnerIcon，都是 24px 的 svg —— 塞进 28px 的圆里必须缩到 16px，
   * 否则箭头会顶到圆边。
   */
  sendButton: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: ${token.colorPrimary};
    color: ${token.colorWhite};
    line-height: 1;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.15s ease;

    & svg
    {
      width: 16px;
      height: 16px;
    }

    &:hover:not(:disabled)
    {
      background: ${token.colorPrimaryHover};
    }

    &:active:not(:disabled)
    {
      transform: scale(0.94);
    }

    &:focus-visible
    {
      outline: 2px solid ${token.colorPrimaryBorder};
      outline-offset: 2px;
    }

/* ---- 停止态（发了消息之后按钮变"停止生成"）：整颗变红 ----
 *
 * 为什么用 data-stop 属性而不是再加一个 emotion 类名
 * ------------------------------------------------------
 *   两个类名会**同元素共存**，于是两条规则要按特异性打架：
 *   .sendButton:hover:not(:disabled) 是 (0,3,0)，而停止态若只写
 *   .sendButtonStop:hover 就是 (0,2,0) —— **蓝底会赢**，鼠标一放上去
 *   就又变回主色，看着像"点不动"。带上属性选择器后是 (0,4,0)，稳赢。
 *   （这跟"消息选择器要把 copilotKitAssistantMessage 写两遍"是同一类坑。）
 *   本仓库已有同款做法：data-hitl-countdown 驱动卡片的倒计时配色。
 *
 * 为什么红色：停止是**破坏性**动作 —— 已经发出去的那一轮不会回来了。
 * 主色（发送/继续）是"往前走"，红色（停止）是"到此为止"，两者必须在
 * 一眼可辨的色相上分开，否则用户会在还没反应过来时把它按下去。 */
    &[data-stop='true']
    {
      background: ${token.colorError};
    }

    &[data-stop='true']:hover:not(:disabled)
    {
      background: ${token.colorErrorHover};
    }

    &[data-stop='true']:active:not(:disabled)
    {
      background: ${token.colorErrorActive};
    }

    &[data-stop='true']:focus-visible
    {
      outline-color: ${token.colorErrorBorder};
    }

/* 没得发（空文本 / 未就绪 / 正在生成但不是"可停止"）→ 素圆 + 灰箭头 */
    &:disabled
    {
      background: ${token.colorFillTertiary};
      color: ${token.colorTextTertiary};
      cursor: default;
    }
`,
}));
