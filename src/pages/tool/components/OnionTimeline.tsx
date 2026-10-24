// src/pages/tool/components/OnionTimeline.tsx
//
// 洋葱时间轴 —— 处理链的唯一编辑界面。
//
// 这条时间轴的三条硬语义（改之前务必先看 processorChain.ts 顶部那 6 条事实）：
//
//  1. **行序 = 执行顺序 = 落库顺序**。进入段正序、⟦Tool⟧、退出段**逆序且交错**。
//     所以拖出来的顺序不需要任何二次转换，serializeChain 直接按行序吐就是 PUT 的 body。
//
//  2. **只有一条规则：AROUND 必须保持洋葱**。而洋葱是「退出 = 进入的逆序」构造性保证的，
//     重排 items 天然拖不出交叉 —— 所以除了这条之外**不设任何位置限制**，落点不分段，
//     BEFORE / AFTER 可以互相拖过去，拖过 ⟦Tool⟧ 时 hook 自动跟着落点侧切换。
//
//  3. **拖拽过程中就实时重排，松手才校验**。
//     实时重排给"磁吸"感（过了邻行中线就整体让位），
//     校验放在松手是因为拖到一半的布局本来就是中间态，中途弹提示只会打断操作；
//     不合规就整次撤销（弹回原布局 + 抖动），而不是留下一个错误状态让人自己修。
//
// 实现上没有 dnd-kit，是 pointer 事件 + 手搓 FLIP。为什么必须手搓见 chainAnim.ts 顶部。

import { DeleteOutlined, SettingOutlined } from '@ant-design/icons';
import { App } from 'antd';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  captureTops,
  type Floater,
  fadeOutFloater,
  findRow,
  flashOnce,
  flipSwap,
  makeFloater,
  moveFloater,
  playFlip,
  popOnce,
  settleFloater,
  shakeOnce,
} from '../chainAnim';
import { useEnumLabels } from '../enumLabels';
import {
  buildTimeline,
  type ChainItem,
  type DropResult,
  type ProcessorDefinition,
  type ProcessorHook,
  type RowKind,
  resolveDrop,
} from '../processorChain';
import { useStyles } from '../style';

/**
 * AROUND 配对色：按 AROUND 在链中的次序取色，同一对进/出共用一色。
 * 六个色相都取自 antd 预设色板的 6 号（饱和）/ 1 号（淡）——
 * token 里没有"第 N 个语义色"这种东西，配对色只能这么给。
 */
const PAIR_COLORS = [
  '#1677ff',
  '#722ed1',
  '#13c2c2',
  '#fa8c16',
  '#eb2f96',
  '#52c41a',
];
const PAIR_SOFT = [
  '#e6f4ff',
  '#f9f0ff',
  '#e6fffb',
  '#fff7e6',
  '#fff0f6',
  '#f6ffed',
];

interface OnionTimelineProps {
  /** 已提交的顺序。拖拽期间保持不动，预览顺序单独存在 preview 里。 */
  items: ChainItem[];
  defs: Map<string, ProcessorDefinition>;
  readOnly?: boolean;
  onReorder: (items: ChainItem[]) => void;
  onRemove: (uid: string) => void;
  onConfigure: (uid: string) => void;
}

/** 一次拖拽会话。全部放 ref —— 指针移动每帧都写，进 state 会把每帧变成一次渲染。 */
interface DragSession {
  uid: string;
  /** 抓起来的是哪一行（AROUND 有 enter / exit 两条）—— 落位动画必须回到这一行 */
  srcKind: RowKind;
  startX: number;
  startY: number;
  grabDX: number;
  grabDY: number;
  active: boolean;
  floater: Floater | null;
  res: DropResult | null;
  valid: boolean;
}

interface SettleTask {
  uid: string;
  kind: RowKind;
  ok: boolean;
  changed: boolean;
  hook?: ProcessorHook;
  reason?: string;
  floater: Floater | null;
}

/**
 * 行里那段「名称 + 类型 / hook / mode 标签」。
 *
 * ⚠️ 包这一层是为了修一个真问题：这些元素原本各自 `flex: 0 0 auto` 直接摆在行里，
 * **谁都不肯收缩** —— 面板一窄，整行内容溢出，右侧的 ⚙ / ✕ 被整个顶到行外面去。
 * 现在它们统一装进这个可收缩容器：空间不足时只有容器变窄、内容从**右端**被裁
 * （于是最先淡出的是最靠右的 mode 标签，依次向左），容器再挂遮罩做渐隐。
 *
 * 遮罩**只在真的溢出时**才挂 —— 无条件挂着会把没溢出时最后一个标签的右边缘也淡掉，
 * 那是个错误信号（看着像"后面还有内容"）。
 */
const RowBody: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { styles } = useStyles();
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  /** 只有真的翻转才 setState —— 拖拽期间每帧都重渲染，无脑 set 会多出一堆渲染。 */
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const next = el.scrollWidth > el.clientWidth + 1;
    setOverflowing((prev) => (prev === next ? prev : next));
  };

  // ResizeObserver 只建一次：它盯的是**容器**尺寸（右栏被拖宽拖窄会触发）。
  // happy-dom 里没有这个全局对象，缺了也不该让整行渲染不出来。
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 内容变了但容器尺寸没变时 observer 不会响（标签文案换了、停用标签出现/消失）——
  // 每次渲染后补量一次。
  useLayoutEffect(measure);

  return (
    <span
      ref={ref}
      data-role="body"
      className={[styles.chainBody, overflowing ? styles.chainBodyFade : '']
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
};

const OnionTimeline: React.FC<OnionTimelineProps> = ({
  items,
  defs,
  readOnly,
  onReorder,
  onRemove,
  onConfigure,
}) => {
  const { styles } = useStyles();
  const labels = useEnumLabels();
  const { message } = App.useApp();

  const rootRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<Map<string, number> | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const settleRef = useRef<SettleTask | null>(null);
  const previewRef = useRef<ChainItem[] | null>(null);

  /** 事件回调里要读的最新 props/样式 —— 见文件末尾的 useEffect。 */
  const latest = useRef({
    items,
    defs,
    onReorder,
    readOnly: Boolean(readOnly),
    floaterClass: styles.floater,
    labels,
  });

  const [drag, setDrag] = useState<{
    uid: string;
    kind: RowKind;
    valid: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<ChainItem[] | null>(null);

  useEffect(() => {
    latest.current = {
      items,
      defs,
      onReorder,
      readOnly: Boolean(readOnly),
      floaterClass: styles.floater,
      labels,
    };
  });

  /** FLIP 的播放阶段：DOM 已提交、浏览器还没绘制，这时补位移动画才不会闪。 */
  useLayoutEffect(() => {
    if (!flipRef.current) return;
    playFlip(flipRef.current, rootRef.current);
    flipRef.current = null;
  });

  const applyPreview = useCallback((next: ChainItem[] | null) => {
    flipRef.current = captureTops(rootRef.current);
    previewRef.current = next;
    setPreview(next);
  }, []);

  /**
   * 让浮层上的 hook 标签跟着落点侧实时翻转。
   * 只改 data-hook + 文本，不碰 className —— 颜色由 CSS 的
   * `[data-hook=...]` 属性选择器负责，否则翻转时得重新拼 emotion 的哈希类名。
   */
  const setFloaterHook = useCallback(
    (d: DragSession, hook: ProcessorHook, invalid: boolean) => {
      const tag =
        d.floater?.el.querySelector<HTMLElement>('[data-role="hook"]');
      if (!tag) return;
      if (tag.dataset.hook === hook && tag.dataset.invalid === String(invalid))
        return;
      flipSwap(tag, () => {
        // 翻的是**译文**：这里直接改 DOM 文本，拿不到 React 的渲染上下文，
        // 所以译文要从 latest 里取（data-hook 仍然保持原值，配色靠它）
        tag.textContent = latest.current.labels.hook(hook);
        tag.dataset.hook = hook;
        tag.dataset.invalid = String(invalid);
      });
    },
    [],
  );

  /**
   * 实时重排：按指针位置找插入点 → resolveDrop 算预览顺序 → 立刻渲染（FLIP 补间 = 磁吸让位）。
   *
   * 候选行要**排除被拖的那一项自己**：它此刻是占位槽，拿它当落点等于原地不动，
   * 而且占位槽的 rect 会随着让位来回跳，会出现"拖一下抖一下"的鬼畜。
   */
  const updatePreview = useCallback(
    (py: number) => {
      const d = dragRef.current;
      const root = rootRef.current;
      if (!d || !root) return;

      const nodes = Array.from(
        root.querySelectorAll<HTMLElement>(
          '[data-chain-uid]:not([data-floater])',
        ),
      ).filter((n) => n.dataset.chainUid !== d.uid);

      if (!nodes.length) {
        d.res = null;
        d.valid = true;
        setDrag((prev) => (prev ? { ...prev, valid: true } : prev));
        if (previewRef.current) applyPreview(null);
        return;
      }

      let target = nodes[nodes.length - 1];
      let after = true;
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        if (py < r.top + r.height / 2) {
          target = n;
          after = false;
          break;
        }
      }

      const res = resolveDrop(
        latest.current.items,
        d.uid,
        target.dataset.chainUid as string,
        after,
        target.dataset.kind as RowKind,
        latest.current.defs,
      );

      const prevValid = d.valid;
      d.res = res;
      d.valid = res.ok;
      setDrag((p) => (p && p.valid !== res.ok ? { ...p, valid: res.ok } : p));

      if (res.ok && res.items) {
        setFloaterHook(d, res.hook as ProcessorHook, false);
        const sig = (l: ChainItem[]) =>
          l.map((i) => `${i.uid}:${i.hook}`).join('|');
        // 顺序/hook 变了才重排；从"非法"转回"合法"也要重排一次（之前没让位）
        if (
          !previewRef.current ||
          sig(previewRef.current) !== sig(res.items) ||
          prevValid !== true
        ) {
          applyPreview(res.items);
        }
      } else {
        if (res.hook) setFloaterHook(d, res.hook, true);
        // 落点不合法：不让位，只把占位槽转红，松手再弹回
        if (previewRef.current || prevValid !== false) applyPreview(null);
      }
    },
    [applyPreview, setFloaterHook],
  );

  /* ---------------------------------------------------------------- 拖拽 */

  // 两个 window 监听器必须是稳定引用（add / remove 要同一个函数），
  // 但函数体每帧都要读到最新的 props —— 所以外面套一层 ref 转发。
  const handlers = useRef<{
    move: (e: PointerEvent) => void;
    up: () => void;
  }>({ move: () => {}, up: () => {} });

  const stableMove = useRef((e: PointerEvent) =>
    handlers.current.move(e),
  ).current;
  const stableUp = useRef(() => handlers.current.up()).current;

  const detach = useCallback(() => {
    window.removeEventListener('pointermove', stableMove);
    window.removeEventListener('pointerup', stableUp);
    window.removeEventListener('pointercancel', stableUp);
  }, [stableMove, stableUp]);

  const flushSettle = useCallback(() => {
    const t = settleRef.current;
    if (!t) return;
    settleRef.current = null;
    const row = findRow(rootRef.current, t.uid, t.kind);
    settleFloater(t.floater, row);
    if (!row) return;
    if (t.ok) {
      popOnce(row);
      if (t.changed) flashOnce(row);
    } else {
      shakeOnce(row);
    }
  }, []);

  handlers.current.move = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    if (!d.active) {
      // 4px 阈值：否则点一下 ⚙ / ✕ 也会被当成拖拽起点
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      const src = findRow(rootRef.current, d.uid, d.srcKind);
      if (!src) {
        dragRef.current = null;
        detach();
        return;
      }
      d.active = true;
      d.floater = makeFloater(src, latest.current.floaterClass);
      const r = src.getBoundingClientRect();
      moveFloater(d.floater, r.left, r.top, 1.03);
      setDrag({ uid: d.uid, kind: d.srcKind, valid: true });
    }

    if (d.floater) {
      moveFloater(d.floater, e.clientX - d.grabDX, e.clientY - d.grabDY, 1.03);
    }
    updatePreview(e.clientY);
  };

  handlers.current.up = () => {
    const d = dragRef.current;
    dragRef.current = null;
    detach();
    if (!d?.active) {
      // 没越过阈值 = 一次点击，什么都不做
      setDrag(null);
      previewRef.current = null;
      setPreview(null);
      return;
    }

    const res = d.res;
    const ok = Boolean(res?.ok);
    const origin = latest.current.items.find((i) => i.uid === d.uid);

    if (ok && res?.items) {
      latest.current.onReorder(res.items); // 提交（含 hook 自动切换）
    } else if (origin) {
      // 校验不通过：把浮层上的标签翻回原来的 hook，再让它飞回原位
      setFloaterHook(d, origin.hook, false);
    }

    previewRef.current = null;
    setPreview(null);
    setDrag(null);

    settleRef.current = {
      uid: d.uid,
      kind: d.srcKind,
      ok,
      changed: Boolean(res?.changed),
      hook: res?.hook,
      reason: res?.reason,
      floater: d.floater,
    };
    // 合法 → 立刻落位；非法 → 等"标签翻回去"这段动画演完再弹回
    if (ok) requestAnimationFrame(flushSettle);
    else window.setTimeout(flushSettle, 260);

    if (ok && res?.changed) {
      message.success(
        `hook 已自动切换为 ${res.hook}（落点在 ⟦Tool⟧ ${
          res.hook === 'AFTER' ? '下方' : '上方'
        }）`,
      );
    } else if (!ok && res?.reason === 'unsupported-hook') {
      const def = latest.current.defs.get(origin?.processor_key ?? '');
      message.error(
        `${def?.name ?? origin?.processor_key} 不支持 hook=${res.hook}（支持 ${
          def?.supported_hooks.join(' / ') ?? '—'
        }）—— 已恢复原布局`,
      );
    }
  };

  const beginDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    uid: string,
    kind: RowKind,
  ) => {
    if (dragRef.current || latest.current.readOnly) return;
    if ((e.button ?? 0) !== 0) return;
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return; // 点到 ⚙ / ✕ 不算拖
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      uid,
      srcKind: kind,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - rect.left,
      grabDY: e.clientY - rect.top,
      active: false,
      floater: null,
      res: null,
      valid: true,
    };
    window.addEventListener('pointermove', stableMove);
    window.addEventListener('pointerup', stableUp);
    window.addEventListener('pointercancel', stableUp);
  };

  /** ✕：这一行先浮起来淡出，剩下的行再 FLIP 补位。 */
  const removeRow = (uid: string, el: HTMLElement | null) => {
    if (el) {
      const f = makeFloater(el, latest.current.floaterClass);
      moveFloater(f, f.rect.left, f.rect.top, 1);
      fadeOutFloater(f);
    }
    flipRef.current = captureTops(rootRef.current);
    previewRef.current = null;
    setPreview(null);
    onRemove(uid);
  };

  /* --------------------------------------------------------------- 渲染 */

  const list = preview ?? items;
  const rows = useMemo(() => buildTimeline(list), [list]);

  const pairIndexOf = (uid: string) => {
    let n = -1;
    for (const it of list) {
      if (it.hook === 'AROUND') {
        n += 1;
        if (it.uid === uid) return n;
      }
    }
    return -1;
  };

  if (!items.length) {
    return (
      <div className={styles.onion} ref={rootRef}>
        <div className={styles.chainEmpty}>
          处理链是空的 —— 从左边点 <b>→</b> 挂一个处理器上来。
        </div>
      </div>
    );
  }

  let n = 0;

  return (
    <div className={styles.onion} ref={rootRef}>
      {rows.map((r) => {
        if (r.kind === 'tool') {
          return (
            <div
              key="__tool__"
              data-flip="__tool__"
              data-kind="tool"
              className={[styles.chainRow, styles.chainRowTool]
                .filter(Boolean)
                .join(' ')}
              style={{ marginLeft: r.depth * 14 }}
            >
              <span>⟦ Tool 本体执行 ⟧</span>
            </div>
          );
        }

        const it = r.item as ChainItem;
        const def = defs.get(it.processor_key);
        const pi = pairIndexOf(it.uid);
        const color = pi >= 0 ? PAIR_COLORS[pi % PAIR_COLORS.length] : null;
        const held =
          drag?.uid === it.uid && drag.kind === (r.kind as string) && !readOnly;
        n += 1;

        const cls = [
          styles.chainRow,
          r.kind === 'enter' || r.kind === 'exit' ? styles.chainRowPair : '',
          it.enabled ? '' : styles.chainRowOff,
          drag?.uid === it.uid && !readOnly ? styles.chainRowMoving : '',
          held
            ? [
                styles.chainRowSlot,
                drag?.valid ? styles.chainRowSnap : styles.chainRowBad,
              ].join(' ')
            : '',
        ]
          .filter(Boolean)
          .join(' ');

        const style: React.CSSProperties & Record<string, string | number> = {
          marginLeft: r.depth * 14,
        };
        if (color) {
          style['--pair'] = color;
          style['--pair-soft'] = PAIR_SOFT[pi % PAIR_SOFT.length];
        }

        const arrow =
          r.kind === 'enter' ? '▶ 进入' : r.kind === 'exit' ? '◀ 退出' : '';

        return (
          <div
            key={`${it.uid}:${r.kind}`}
            className={cls}
            style={style}
            data-flip={`${it.uid}:${r.kind}`}
            data-chain-uid={it.uid}
            data-kind={r.kind}
            onPointerDown={(e) => beginDrag(e, it.uid, r.kind)}
          >
            <span className={styles.chainIdx}>{n}</span>
            {color ? (
              <span className={styles.pairDot} />
            ) : (
              <span className={styles.pairDotPlaceholder} />
            )}
            {arrow ? <span className={styles.chainArrow}>{arrow}</span> : null}
            <RowBody>
              <span className={styles.chainName}>
                {def?.name ?? it.processor_key}
              </span>
              <span
                className={styles.chainTag}
                data-ptype={def?.processor_type ?? ''}
                title={def?.processor_type ?? ''}
              >
                {def ? labels.processorType(def.processor_type) : '未知'}
              </span>
              <span
                className={styles.chainTag}
                data-role="hook"
                data-hook={it.hook}
                title={it.hook}
              >
                {labels.hook(it.hook)}
              </span>
              <span
                className={styles.chainTag}
                data-mode={it.execution_mode}
                title={it.execution_mode}
              >
                {labels.mode(it.execution_mode)}
              </span>
              {it.enabled ? null : (
                <span className={styles.chainTag} data-off="1">
                  停用
                </span>
              )}
            </RowBody>
            {readOnly ? null : (
              <span className={styles.chainActions}>
                <span className={styles.chainDepth}>d{r.depth}</span>
                <button
                  type="button"
                  data-nodrag
                  className={styles.iconBtn}
                  title="绑定配置"
                  onClick={() => onConfigure(it.uid)}
                >
                  <SettingOutlined />
                </button>
                <button
                  type="button"
                  data-nodrag
                  className={[styles.iconBtn, styles.iconBtnDel].join(' ')}
                  title="从链上摘掉"
                  onClick={(e) =>
                    removeRow(
                      it.uid,
                      (e.currentTarget as HTMLElement).closest<HTMLElement>(
                        '[data-chain-uid]',
                      ),
                    )
                  }
                >
                  <DeleteOutlined />
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default OnionTimeline;
