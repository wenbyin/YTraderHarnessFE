// src/pages/document/style.ts
//
// 配色分层（与 document_retrieve/style.ts 同一套口径）：
//   L0 页面底   = colorBgLayout
//   L1 容器     = colorBgContainer（白）—— 卡片、抽屉底
//   L2 容器内板 = colorFillTertiary（灰）+ colorBorderSecondary 边框
//   L3 板内块   = colorBgContainer（白）+ colorBorderSecondary 边框
//
// 为什么必须分层：抽屉底是白的，里面再放一块白底（只有一根几乎看不见的线）
// 就是「白底套白底」，用户分不出哪儿是哪儿。所以 L2 一律染色，需要再嵌一层
// 时回到白底 —— 靠**底色反转**分层，不靠加粗边框。
//
// 半透明的 colorFillQuaternary（0.02）在白底上几乎等于白，不能当 L2 用；
// L2 起步就是 colorFillTertiary（0.04）。
import { createStyles } from 'antd-style';

export const useStyles = createStyles(({ css, token }) => ({
  // 详情页控制条：版本下拉 + 处理器下拉 + 操作按钮
  controlBar: css`
    display: flex;
    align-items: center;
    gap: ${token.marginMD}px;
    flex-wrap: wrap;
    padding: ${token.padding}px ${token.paddingLG}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    margin-bottom: ${token.marginMD}px;
  `,

  controlItem: css`
    display: flex;
    align-items: center;
    gap: ${token.marginXS}px;
  `,

  controlLabel: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
    white-space: nowrap;
  `,

  // 处理状态区（进度条 / 完成 / 失败）
  statusBox: css`
    padding: ${token.paddingLG}px;
    border-radius: ${token.borderRadiusLG}px;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorBgContainer};
    margin-bottom: ${token.marginMD}px;
  `,

  indeterminateTrack: css`
    position: relative;
    height: 8px;
    border-radius: 999px;
    overflow: hidden;
    background: ${token.colorFillSecondary};

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      width: 40%;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        transparent,
        ${token.colorPrimary},
        transparent
      );
      animation: document-indeterminate 1.2s ease-in-out infinite;
    }

    @keyframes document-indeterminate {
      0% {
        transform: translateX(-120%);
      }
      100% {
        transform: translateX(320%);
      }
    }
  `,

  statusTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
    margin: 0 0 ${token.margin}px;
    padding-left: 8px;
    border-left: 3px solid ${token.colorPrimary};
  `,

  // Chunk 列表
  chunkList: css`
    display: flex;
    flex-direction: column;
    gap: ${token.marginSM}px;
  `,

  /**
   * L2：一条 chunk。抽屉底是白的，这里必须染灰 —— 原来给的白底只有一圈
   * 浅边，在抽屉里等于是「白底套白底」，一条 chunk 的边界根本看不出来。
   */
  chunkRow: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillTertiary};
    overflow: hidden;
    transition: all 0.2s;

    &:hover {
      border-color: ${token.colorPrimaryBorder};
      box-shadow: ${token.boxShadowSecondary};
    }
  `,

  /**
   * 卡头：比卡身再深一档，读起来才像「头」，不然只是一根线。
   *
   * 下面那条线必须用 colorBorder（而不是 Secondary）：卡头自己就是
   * colorFillSecondary，而 colorBorderSecondary 跟它**是同一个值**，
   * 线会完全消失。
   */
  chunkHeader: css`
    display: flex;
    align-items: center;
    gap: ${token.marginSM}px;
    padding: ${token.paddingSM}px ${token.padding}px;
    background: ${token.colorFillSecondary};
    border-bottom: 1px solid ${token.colorBorder};
    flex-wrap: wrap;
  `,

  chunkIndex: css`
    font-family: ${token.fontFamilyCode};
    font-weight: 600;
    color: ${token.colorPrimary};
  `,

  /** 段与段之间靠 gap 分开，不再靠虚线 —— 每段自己是个白块，见 chunkSection。 */
  chunkBody: css`
    display: flex;
    flex-direction: column;
    gap: ${token.marginSM}px;
    padding: ${token.padding}px;
  `,

  /**
   * L3：chunk 面板内的三段 —— 预览 / 投影 / 元数据。
   *
   * 外面那层（chunkRow）已经染灰，这三段回到**白底 + 边**，于是三层关系是
   * 抽屉白 → chunk 灰 → 段白，一路反转着分下去。原来三段只靠一条虚线分隔，
   * 在灰底上勉强能看；换成白块之后，「这一段到哪儿为止」不用猜。
   */
  chunkSection: css`
    padding: ${token.paddingSM}px ${token.padding}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
  `,

  /** 段头：左标题，右侧放该段自己的操作（展开 / 查询）。 */
  chunkSectionHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginXS}px;
    margin-bottom: 6px;
  `,

  chunkSectionTitle: css`
    font-size: 12.5px;
    font-weight: 600;
    color: ${token.colorTextSecondary};
    line-height: 1.2;
    padding-left: 6px;
    border-left: 3px solid ${token.colorBorder};
  `,

  chunkContent: css`
    font-size: 13.5px;
    line-height: 1.7;
    color: ${token.colorText};
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0 0 ${token.margin}px;
  `,

  // 每个 chunk 的 metadata 区块
  metaBlock: css`
    border-top: 1px dashed ${token.colorBorderSecondary};
    padding-top: ${token.marginSM}px;
  `,

  metaLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 4px;
    letter-spacing: 0.02em;
  `,

  /**
   * 深色的 JSON 块。**刻意不用 token 底色** —— 它要的是一块"终端"，
   * 跟正文拉开距离。但底色写死就意味着在深色主题下它跟页面同色，
   * 所以必须补一条边，否则整块会糊进背景里。
   */
  metaJson: css`
    margin: 0;
    padding: 8px 10px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    background: #1f1f1f;
    color: #d4d4d4;
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.6;
    overflow: auto;
    max-height: 220px;
  `,

  // 通用空状态
  emptyBox: css`
    padding: ${token.paddingLG}px 0;
    text-align: center;
  `,

  // 详情页基础信息
  infoGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: ${token.margin}px ${token.marginLG}px;
    margin-bottom: ${token.marginMD}px;
  `,

  infoItem: css`
    min-width: 0;
  `,

  infoLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 4px;
  `,

  infoValue: css`
    font-size: 13.5px;
    color: ${token.colorText};
    word-break: break-all;
  `,

  monoValue: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12.5px;
  `,

  // ---------- 处理进度（横向 Steps） ----------
  stepsPanel: css`
    padding: ${token.paddingLG}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorBgContainer};
    margin-bottom: ${token.marginMD}px;
  `,

  stepsHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.margin}px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  `,

  progressBar: css`
    height: 8px;
    border-radius: 999px;
    background: ${token.colorFillSecondary};
    overflow: hidden;
    margin: 12px 0 26px;
  `,

  progressFill: css`
    display: block;
    height: 100%;
    border-radius: 999px;
    transition:
      width 0.4s ease,
      background 0.3s ease;
  `,

  fillSuccess: css`
    background: ${token.colorSuccess};
  `,

  fillProcessing: css`
    background: ${token.colorPrimary};
  `,

  fillError: css`
    background: ${token.colorError};
  `,

  /** 多路 retrieval 部分成功，业务层按 failed 算，观测层单独给一色。 */
  fillWarning: css`
    background: ${token.colorWarning};
  `,

  fillNeutral: css`
    background: ${token.colorTextQuaternary};
  `,

  steps: css`
    display: flex;
    align-items: flex-start;
    overflow-x: auto;
    /* overflow-x:auto 会连带在竖直方向裁剪，hover 的放大与光晕会被切掉，
       顶部留出 6px 缓冲 */
    padding-top: 6px;
    padding-bottom: 2px;
  `,

  /**
   * 所有节点常驻 DOM，展开 / 收起只切 class —— 重建 DOM 会让 CSS transition
   * 直接跳到终态、看不到动画。宽度用 flex-grow 过渡（收起时 1 → 0），
   * 不设 max-width，保证可见节点始终横向铺满整行。
   */
  step: css`
    flex: 1 1 0;
    min-width: 0;
    text-align: center;
    padding: 0 6px;
    /**
     * max-height 必须给一个「够用但不影响观感」的上限：
     * 折叠时宽度趋近 0，文字会逐字换行把元素撑到几百 px 高，
     * 而 overflow:hidden 只裁横向溢出、管不了自身高度 —— 下面就会留出大片空白。
     * 把 max-height 一起过渡即可（height:auto 无法动画，这是标准做法）。
     */
    max-height: 200px;
    transition:
      flex-grow 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      padding 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.25s ease,
      transform 0.3s cubic-bezier(0.34, 1.4, 0.64, 1);
  `,

  /** 收起态：宽度归零 + 高度归零 + 淡出 + 轻微缩放。 */
  stepHidden: css`
    flex-grow: 0;
    max-height: 0;
    padding: 0;
    opacity: 0;
    transform: scale(0.72) translateY(-4px);
    overflow: hidden;
    pointer-events: none;
  `,

  stepClickable: css`
    cursor: pointer;

    // 属性选择器不会被 hash，可以稳定命中圆点
    &:hover [data-role='dot'] {
      transform: scale(1.12);
      box-shadow: 0 0 0 4px ${token.colorPrimaryBg};
    }
  `,

  stepSelected: css`
    [data-role='dot'] {
      box-shadow: 0 0 0 4px ${token.colorPrimaryBorder};
    }
  `,

  /** 右上角展开 / 收起按钮里的箭头：展开态旋转 180°。 */
  toggleIcon: css`
    transition: transform 0.32s cubic-bezier(0.4, 0, 0.2, 1);
  `,

  toggleIconExpanded: css`
    transform: rotate(180deg);
  `,

  // 轨道 = 左线段 + 圆点 + 右线段，三者都是真实 flex 元素，
  // 不用绝对定位，避免首尾节点隐藏连线后圆点错位。
  stepTrack: css`
    display: flex;
    align-items: center;
    height: 22px;
  `,

  seg: css`
    flex: 1;
    height: 2px;
    background: ${token.colorBorder};
  `,

  // 连线颜色只由左侧那一步是否完成决定，保证一条连线只有一种颜色
  segPassed: css`
    background: ${token.colorSuccess};
  `,

  segHidden: css`
    visibility: hidden;
  `,

  segDashed: css`
    background: transparent;
    height: 0;
    border-top: 2px dashed ${token.colorBorder};
  `,

  stepDot: css`
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    margin: 0 4px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    line-height: 1;
    border: 2px solid ${token.colorBorder};
    background: ${token.colorBgContainer};
    color: ${token.colorTextTertiary};
  `,

  dotCompleted: css`
    background: ${token.colorSuccess};
    border-color: ${token.colorSuccess};
    color: #fff;
  `,

  dotProcessing: css`
    border-color: ${token.colorPrimary};
    color: ${token.colorPrimary};
  `,

  dotFailed: css`
    background: ${token.colorError};
    border-color: ${token.colorError};
    color: #fff;
  `,

  // 被条件边跳过：不计入分母，但连线仍按「已通过」上色，
  // 否则会出现「进度 100% 但连线断开」的矛盾。
  dotSkipped: css`
    background: ${token.colorFill};
    border-color: ${token.colorBorder};
    color: ${token.colorTextTertiary};
  `,

  /** 扇出节点的圆点里显示 "3/4" 这类分支计数，字号要再小一点。 */
  dotFanout: css`
    font-size: 10px;
    letter-spacing: -0.4px;
  `,

  stepBody: css`
    margin-top: 10px;
  `,

  stepName: css`
    font-size: 13px;
    color: ${token.colorText};
    line-height: 1.4;
  `,

  stepNameMuted: css`
    color: ${token.colorTextTertiary};
  `,

  stepNameProcessing: css`
    color: ${token.colorPrimary};
    font-weight: 600;
  `,

  stepNameFailed: css`
    color: ${token.colorError};
    font-weight: 600;
  `,

  stepActor: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-top: 2px;
  `,

  stepTime: css`
    font-size: 11.5px;
    color: ${token.colorTextTertiary};
    margin-top: 4px;
    font-family: ${token.fontFamilyCode};
  `,

  stepEllipsis: css`
    flex: 0 0 72px;
  `,

  ellipsisDot: css`
    border: 0;
    background: transparent;
    color: ${token.colorTextTertiary};
    font-size: 16px;
  `,

  /**
   * 执行信息卡。它在 stepsPanel（白）**里面**，所以是 L2 —— 原来给的是
   * colorFillQuaternary，那在白底上几乎看不出底色，等于又一块白板。
   */
  currentStepCard: css`
    margin-top: ${token.marginMD}px;
    padding: ${token.padding}px ${token.paddingLG}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillTertiary};
    /* hover 切换节点时整卡重新挂载（key=nodeId），入场动画随之重放 */
    animation: step-card-in 0.25s ease both;

    @keyframes step-card-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
  `,

  currentTitle: css`
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
  `,

  currentSub: css`
    font-size: 12.5px;
    color: ${token.colorTextSecondary};
    margin-top: 4px;
  `,

  chips: css`
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  `,

  /** 扇出分支明细：一路一行。 */
  branchList: css`
    margin-top: 10px;
    border-top: 1px dashed ${token.colorBorderSecondary};
    padding-top: 8px;
  `,

  branchRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 3px 0;
    font-size: 12.5px;
    color: ${token.colorTextSecondary};
  `,

  branchName: css`
    font-family: ${token.fontFamilyCode};
    color: ${token.colorText};
    min-width: 96px;
  `,

  /** 提示条：分母跳变解释、旧版流水线提示等。 */
  noticeBox: css`
    margin-top: 10px;
    padding: 8px 12px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorWarningBg};
    border: 1px solid ${token.colorWarningBorder};
    color: ${token.colorWarningText};
    font-size: 12.5px;
  `,

  /**
   * output_summary.preview：这一步产出了什么。
   *
   * L3：它要么在 currentStepCard（灰）里，要么在节点抽屉（白）里 ——
   * 白底两边都立得住，但边框得用 colorBorder 而不是 Secondary：
   * 在抽屉那份白底上，Secondary 太浅，框等于没有。
   */
  previewBox: css`
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    border: 1px dashed ${token.colorBorder};
    color: ${token.colorTextSecondary};
    font-size: 12.5px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 120px;
    overflow: auto;
  `,

  errorBox: css`
    margin-top: 10px;
    padding: 8px 12px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorErrorBg};
    border: 1px solid ${token.colorError};
    color: ${token.colorErrorText};
    font-size: 13px;
  `,

  /**
   * 页面向下滚动时，把「基础信息 + 处理进度」钉在顶部，只有下方版本表跟着滚。
   *
   * 必须给不透明背景（页面底色 colorBgLayout）—— 卡片之间有缝隙，
   * 透明的话表格行会从缝里透上来。上下各留一点缓冲，避免表格贴着卡片边缘滑过。
   */
  stickyTop: css`
    position: sticky;
    top: 0;
    z-index: 5;
    background: ${token.colorBgLayout};
    padding-top: ${token.paddingXS}px;
    padding-bottom: ${token.paddingSM}px;
  `,

  // ---------- 版本表 ----------
  statusCell: css`
    cursor: pointer;
    border: none !important;
    outline: none;
    background: transparent;
    padding: 0;
  `,

  selectedRow: css`
    background: ${token.controlItemBgActive};

    td {
      border-bottom-color: transparent;
    }

    /*
     * ⚠️ fixed 列的单元格自带白底（position: sticky 必须有不透明背景），
     * 会把整行的选中蓝底盖掉 —— 于是「当前查看的那一行」在操作列看着是白的。
     * 单独补一次，特异性 (0,2,1) 压过 .ant-table-cell-fix-right (0,1,0)。
     * antd v6 的类名是 -fix-right 加方向无关的 -fix-end，两个都要写。
     */
    td.ant-table-cell-fix-right,
    td.ant-table-cell-fix-end,
    td.ant-table-cell-fix-left,
    td.ant-table-cell-fix-start {
      background: ${token.controlItemBgActive};
    }
  `,

  // ---------- 抽屉 ----------
  drawerSection: css`
    margin-bottom: ${token.marginLG}px;
  `,

  drawerTitle: css`
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
    margin: 0 0 8px;
    padding-left: 8px;
    border-left: 3px solid ${token.colorPrimary};
  `,

  /** 段落标题行：左侧标题，右侧操作（如文件下载按钮）。 */
  sectionHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginSM}px;
    margin-bottom: 8px;
  `,

  drawerMeta: css`
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    color: ${token.colorTextSecondary};
    font-size: 12.5px;
  `,

  // ---------- 节点详情抽屉：概览 → 执行明细（Tab）→ 三段 JSON ----------
  detailHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 13px;
    font-weight: 600;
    color: ${token.colorText};
    margin-bottom: ${token.marginXS}px;
  `,

  kvGrid: css`
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 4px 12px;
    font-size: 12.5px;
  `,

  kvLabel: css`
    color: ${token.colorTextTertiary};
  `,

  kvValue: css`
    color: ${token.colorText};
    word-break: break-all;
  `,

  jsonBlock: css`
    margin: 0;
    padding: 10px 12px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillTertiary};
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 260px;
    overflow: auto;
  `,

  /**
   * 投影面板里**每一路 retrieval** 的条目。
   * 与 chunkSection 同一套手法：靠相邻兄弟加虚线，不用判断首尾。
   */
  projEntry: css`
    & + & {
      margin-top: ${token.marginSM}px;
      padding-top: ${token.paddingSM}px;
      border-top: 1px dashed ${token.colorBorderSecondary};
    }
  `,

  /** L2：接口未返回该段时的空态容器（保持与 JSON 块一致的视觉体量）。 */
  emptyInline: css`
    padding: ${token.paddingSM}px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
  `,

  divider: css`
    height: 1px;
    background: ${token.colorBorderSecondary};
    margin: ${token.marginSM}px 0 ${token.marginMD}px;
  `,

  // ---------- QA 数据集生成弹窗 ----------
  /**
   * 结果区容器。L2：弹窗 body 是白的（colorBgContainer），
   * 里面这块染色才分得出来是「另一层」。
   */
  qaResult: css`
    padding: ${token.paddingSM}px ${token.padding}px;
    border: 1px solid ${token.colorBorder};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillTertiary};
  `,

  /**
   * 六个数一块儿给：保留样本 / 窗口成功 / 窗口失败 / 出题 / 保留 / 丢弃。
   * 为什么不用 Statistic：这里要的是「一眼扫过六个数的对比」，
   * 卡片的体量会把对比切成六次阅读。
   */
  qaStatGrid: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: ${token.marginSM}px ${token.marginXS}px;
  `,

  qaStatLabel: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    margin-bottom: 2px;
  `,

  qaStatValue: css`
    font-size: 20px;
    font-weight: 600;
    line-height: 1.2;
    color: ${token.colorText};
    font-variant-numeric: tabular-nums;
  `,

  /** 分母（如窗口总数）贴着数字走，不另起一行 —— 它只是个参照。 */
  qaStatUnit: css`
    font-size: 12px;
    font-weight: 400;
    color: ${token.colorTextTertiary};
    margin-left: 2px;
  `,

  /** 失败数 / 丢弃数：非零时要跳出来，但不能看着像「出错」。 */
  qaStatWarn: css`
    color: ${token.colorWarningText};
  `,

  /** 为零的那几个：压下去，视线自然落到有问题的那几个上。 */
  qaStatMuted: css`
    color: ${token.colorTextQuaternary};
  `,

  qaPath: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    word-break: break-all;
  `,

  qaFailureList: css`
    margin-top: 6px;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    max-height: 160px;
    overflow: auto;
  `,

  qaFailureRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${token.marginXS}px;
    padding: 6px 10px;

    & > span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    & + & {
      border-top: 1px dashed ${token.colorBorderSecondary};
    }
  `,
}));
