// src/pages/tool/components/ChainOrderHint.tsx
//
// 「执行顺序」提示条 —— 纯静态说明，不读链、不参与校验。
//
// 为什么需要它：处理器链在页面上是一堆行（BEFORE / AROUND / AFTER），
// 但**用户真正要知道的是「谁包着谁」**。同一个 retry，挂在 timeout 外面还是
// 里面，语义是两个东西（每次尝试各有超时 vs 整组共享一个总预算），而页面上
// 这两条链长得几乎一样。
//
// 这里的顺序与后端实现一致（`app/agent/tools/processor/interceptor/*.py` 的
// 模块 docstring 明写了推荐挂法）：
//     retry (outer) -> guard (inner)    每次尝试都走守卫
//     retry (outer) -> timeout (inner)  每次尝试各有自己的超时
//     cache 是 AROUND 一条，命中就不进工具
// 改这里之前先对一遍后端 docstring —— 前端写反了比不写更糟。
//
// ⚠️ 形态是 **Alert**（可关闭 + 到点自动收起），不是常驻面板：
//    这块占六行，常年摆在那里会把真正要编辑的两栏挤下去。看完就该让位。
//    收起走的是"高度塌缩 + 淡出"的过渡（见 style.ts 的 orderShell），
//    不是瞬切 —— 瞬切会让下方两栏硬跳 300px。
//    收起之后留一个「执行顺序说明」的小入口 —— 它是唯一能找到这段口径的地方，
//    不给人回去的路，等于把说明删了。

import { CloseOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Button, Tooltip, Typography } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStyles } from '../style';

/**
 * 自动收起的时间。
 *
 * 20 秒是"够读一遍六行 + 底部那句"的量级，又不是"还没看完就没了"。
 * 想让它不自动收，把这里改成 0 并跳过下面那个 effect 即可。
 */
const AUTO_CLOSE_MS = 20_000;

/**
 * 收起动画时长，**必须与 style.ts 里 orderShell 的 transition 一致**。
 * 到点后还不能立刻卸载：先让 CSS 把高度压到 0，跑完这一段再摘节点，
 * 否则下方两栏会"跳"上来。
 */
const COLLAPSE_MS = 260;

interface Level {
  /** 真正的 processor_key（与注册表同名）；5/6 层不是处理器，用符号表示。 */
  key: string;
  name: string;
  badge: string;
  note: string;
  /** 渲染口味：builtin = 内置 AROUND 拦截器，muted = 其它 hook，tool = 工具本体。 */
  tone: 'builtin' | 'muted' | 'tool';
}

const LEVELS: Level[] = [
  {
    key: 'retry_interceptor',
    name: '工具重试',
    badge: '最外层',
    note: '一次工具调用试几次、退避多久 —— 它包住下面所有层',
    tone: 'builtin',
  },
  {
    key: 'execution_guard_interceptor',
    name: '执行守卫',
    badge: '每次尝试',
    note: '每试一次就过一次守卫：成功 / 失败 / 未知分别计配额',
    tone: 'builtin',
  },
  {
    key: 'timeout_interceptor',
    name: '工具超时',
    badge: '每次尝试',
    note: '每次尝试自己的预算，不是整条的；超时归 UNKNOWN 而不是普通失败',
    tone: 'builtin',
  },
  {
    key: 'cache_interceptor',
    name: '结果缓存',
    badge: '命中即返回',
    note: '命中直接返回，工具不执行；只缓存成功结果，失败原样透出',
    tone: 'builtin',
  },
  {
    key: 'BEFORE / AFTER',
    name: '其余处理器',
    badge: '按链序',
    note: '前置按链上顺序进，后置倒序出；AROUND 成对进出',
    tone: 'muted',
  },
  {
    key: '⟦Tool⟧',
    name: '工具本体',
    badge: '最内层',
    note: '真正的那次调用',
    tone: 'tool',
  },
];

const ChainOrderHint: React.FC = () => {
  const { styles, cx } = useStyles();
  /** 还在 DOM 里（含"正在收起"那一刻）。 */
  const [mounted, setMounted] = useState(true);
  /** 展开为 1，收起动画期间为 0 —— 高度/透明度都靠它过渡。 */
  const [expanded, setExpanded] = useState(true);
  const collapseTimer = useRef<number | null>(null);

  /**
   * 开始收起：先把它压扁（CSS 过渡 260ms），**动画跑完才卸载**。
   *
   * ⚠️ 不能像以前那样直接 `setMounted(false)` —— 那样是"瞬间消失"，
   * 上方两栏会"跳"上来 300px。也不能依赖 antd 自带的关闭动画：
   * 它的 `.ant-alert-motion-leave` 是从 `max-height: none` 过渡到 0，
   * 浏览器不做插值，实际还是瞬切。
   */
  const beginClose = useCallback(() => {
    setExpanded(false);
    if (collapseTimer.current !== null) return;
    collapseTimer.current = window.setTimeout(() => {
      setMounted(false);
      collapseTimer.current = null;
    }, COLLAPSE_MS);
  }, []);

  useEffect(
    () => () => {
      if (collapseTimer.current !== null) {
        window.clearTimeout(collapseTimer.current);
      }
    },
    [],
  );

  /*
   * 到点自动收起。依赖里带上 `expanded`：手动关掉再点开必须**重新计时**，
   * 否则重开的那一瞬间就会被上一轮的旧定时器关掉（看着像"点了没反应"）。
   */
  useEffect(() => {
    if (!mounted || !expanded) return;
    const timer = window.setTimeout(beginClose, AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [mounted, expanded, beginClose]);

  // 收起后的退路：整块说明只剩这一行。它不占地方，但没了就再也找不到口径。
  if (!mounted) {
    return (
      <div className={styles.orderReopenRow}>
        <Typography.Link
          className={styles.orderReopen}
          data-order-reopen
          onClick={() => {
            setMounted(true);
            setExpanded(true);
          }}
        >
          <InfoCircleOutlined /> 执行顺序说明
        </Typography.Link>
      </div>
    );
  }

  return (
    /*
     * 收起动画的载体：grid-template-rows 1fr → 0fr 能把"真实高度"过渡到 0
     * （max-height 要预先猜一个值，猜大了曲线就废了）。内层 overflow:hidden
     * 负责裁切，同时把 margin-bottom 一起收到 0，下方两栏才会跟着上移。
     */
    <div
      data-order-shell
      // 收起动画期间这里是 "true"（高度还在往 0 走），到点卸载后整个节点消失
      data-collapsed={expanded ? 'false' : 'true'}
      className={cx(styles.orderShell, !expanded && styles.orderShellCollapsed)}
    >
      <div className={styles.orderShellInner}>
        <Alert
          className={styles.orderAlert}
          type="info"
          showIcon
          /*
           * ⚠️ 这里**不用** `closable`：antd 的关闭按钮会先 setClosed(true)
           * 把 Alert 自己卸掉，我们的收起动画根本没机会播。
           * 换成 `action` 里自己放一颗 × —— 关闭时机完全由我们掌握。
           */
          action={
            <Button
              type="text"
              size="small"
              aria-label="收起执行顺序说明"
              data-order-close
              icon={<CloseOutlined />}
              onClick={beginClose}
            />
          }
          title={
            <span className={styles.orderAlertTitle}>
              执行顺序 · 外 → 内
              <span className={styles.orderTag}>顺序即语义</span>
            </span>
          }
          description={
            <div data-chain-order>
              <div className={styles.orderLadder}>
                {LEVELS.map((lv, i) => (
                  <div
                    key={lv.key}
                    // 逐层缩进 = 逐层包裹。用缩进而不是画嵌套框，是因为最里层是
                    // 工具本体（不是处理器），画框会让人以为它也是一个处理器。
                    style={{ marginLeft: i * 18 }}
                    className={[
                      styles.orderRow,
                      lv.tone === 'muted' ? styles.orderRowMuted : '',
                      lv.tone === 'tool' ? styles.orderRowTool : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-depth={i}
                  >
                    <span className={styles.orderIdx}>{i + 1}</span>
                    <span className={`${styles.mono} ${styles.orderKey}`}>
                      {lv.key}
                    </span>
                    <span className={styles.orderName}>{lv.name}</span>
                    <span className={styles.orderBadge}>{lv.badge}</span>
                    <Tooltip title={lv.note}>
                      <span className={styles.orderNote}>{lv.note}</span>
                    </Tooltip>
                  </div>
                ))}
              </div>

              <div className={styles.orderFoot}>
                越靠外层越先进入、越晚退出。<b>顺序反了语义就变了</b>：
                <span className={styles.mono}>retry</span> 在外、
                <span className={styles.mono}>timeout</span> 在内 =
                每次尝试各有超时。
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
};

export default ChainOrderHint;
