// src/pages/tool/chainAnim.ts
//
// 处理链那几处「只能用 Web Animations API 手搓」的动画，以及为什么必须手搓。
//
// 项目里**没有 dnd-kit**（package.json 确认过），拖拽是 pointer 事件自己实现的。
// 而下面这四种动画都有一个共同点：它们的起点和终点是**两个由布局决定的屏幕坐标**，
// 而且终点只有在 React 把新顺序提交到 DOM 之后才存在 ——
//
//   1. 磁吸让位  ：条目顺序实时变化，需要把"从旧位置滑到新位置"补出来 → FLIP
//   2. 变形飞入  ：左侧条目 → 右侧时间轴上的新条目，跨容器补间
//   3. 落位回弹  ：松手后浮层飞回真实条目所在的位置
//   4. 翻牌切换  ：拖过 ⟦Tool⟧ 时 BEFORE ⇄ AFTER 标签实时翻转
//
// CSS 过渡做不到这些：它只能过渡"属性值的变化"，而布局跳变（reflow）不产生属性变化。
// 所以统一走 el.animate()，并且严格遵守「先量旧位置 → 改数据 → 提交后量新位置 → 补动画」。
//
// 兼容性：el.animate 在老环境和 jsdom 里不存在，全部做了 typeof 守卫 ——
// 守卫掉时行为退化成"直接跳到终态"，不会报错，只是没有动画。

/** 跟随指针的浮层：本体是源节点的一个 detached-safe 克隆，挂在 body 上。 */
export interface Floater {
  el: HTMLElement;
  rect: DOMRect;
}

const canAnimate = (el: HTMLElement): boolean =>
  typeof el.animate === 'function';

/**
 * 把一个元素克隆成 fixed 浮层。
 *
 * 为什么用 cloneNode 而不是直接把真节点 position:fixed ——
 * 真节点一脱离文档流，后面的条目就会整体往上挤，拖拽过程中布局会塌；
 * 而且源节点还得留在原地当占位槽（视觉上说明"是从这儿抓走的"）。
 *
 * @param floaterClass 由调用方把 antd-style 生成的类名传进来 ——
 *   本文件拿不到 useStyles()，而 emotion 的类名是哈希的，写死字符串会失配。
 */
export function makeFloater(src: HTMLElement, floaterClass: string): Floater {
  const rect = src.getBoundingClientRect();
  const el = src.cloneNode(true) as HTMLElement;
  el.classList.add(floaterClass);
  el.removeAttribute('data-flip');
  // 标记成浮层：DOM 查询一律要排除它，否则"找目标行"会找到浮层自己
  el.dataset.floater = '1';
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.margin = '0';
  document.body.appendChild(el);
  return { el, rect };
}

export function moveFloater(f: Floater, x: number, y: number, scale = 1) {
  f.el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

/** 兜底清理：动画没触发 / onfinish 没回调时也要把浮层摘掉，不能留在 body 上。 */
function scheduleRemove(f: Floater, delay: number) {
  window.setTimeout(() => f.el.remove(), delay);
}

/**
 * 变形飞入：左栏条目 → 右栏新条目。
 *
 * 必须在**渲染前**克隆源节点（render 会把左栏整段重建，源节点随即变成游离节点，
 * 那时再量 rect 全是 0），所以调用顺序永远是 makeFloater → setItems → 本函数。
 */
export function morphInto(f: Floater, target: HTMLElement) {
  const a = f.rect;
  const b = target.getBoundingClientRect();
  const sx = a.width ? b.width / a.width : 1;
  const sy = a.height ? b.height / a.height : 1;
  popOnce(target);
  if (!canAnimate(f.el)) {
    f.el.remove();
    return;
  }
  const anim = f.el.animate(
    [
      {
        transform: `translate(${a.left}px, ${a.top}px) scale(1, 1)`,
        opacity: 1,
      },
      {
        transform: `translate(${b.left}px, ${b.top}px) scale(${sx}, ${sy})`,
        opacity: 0.9,
      },
    ],
    { duration: 380, easing: 'cubic-bezier(.2,.85,.25,1)' },
  );
  anim.onfinish = () => f.el.remove();
  scheduleRemove(f, 600);
}

/**
 * 落位 / 回弹：把浮层补间回目标行的位置再销毁。
 *
 * 提交成功 = 落位（目标行是落点）；校验失败 = 弹回原位（目标行就是原行）。
 * 两种情况共用这一条补间，区别只在于目标行是谁 —— 视觉语言统一成"飞回轨道"。
 */
export function settleFloater(f: Floater | null, row: HTMLElement | null) {
  if (!f) return;
  if (!row || !canAnimate(f.el)) {
    f.el.remove();
    return;
  }
  const r = row.getBoundingClientRect();
  const anim = f.el.animate(
    [
      { transform: f.el.style.transform || 'none', opacity: 1 },
      { transform: `translate(${r.left}px, ${r.top}px) scale(1)`, opacity: 1 },
    ],
    { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  anim.onfinish = () => f.el.remove();
  scheduleRemove(f, 500);
}

/** ✕ 移除：这一行先浮起来淡出，剩下的行再 FLIP 补位。 */
export function fadeOutFloater(f: Floater) {
  if (!canAnimate(f.el)) {
    f.el.remove();
    return;
  }
  const anim = f.el.animate(
    [
      {
        transform: `translate(${f.rect.left}px, ${f.rect.top}px) scale(1)`,
        opacity: 1,
      },
      {
        transform: `translate(${f.rect.left + 30}px, ${f.rect.top}px) scale(.94)`,
        opacity: 0,
      },
    ],
    { duration: 220, easing: 'cubic-bezier(.4,0,1,1)' },
  );
  anim.onfinish = () => f.el.remove();
  scheduleRemove(f, 420);
}

/**
 * 入场 / 落位的一次性弹一下。
 *
 * 三个"一次性反馈"动画（pop / shake / flash）都**不用 CSS 类**实现 ——
 * antd-style 走 emotion，类名是哈希的，往 DOM 上 add 一个裸字符串类名匹配不上。
 * 所以统一在 WAAPI 里播完即走，不留任何需要清理的类名。
 */
export function popOnce(el: HTMLElement) {
  if (!canAnimate(el)) return;
  el.animate(
    [
      { transform: 'scale(.92)', opacity: 0.3, offset: 0 },
      { transform: 'scale(1.03)', opacity: 1, offset: 0.62 },
      { transform: 'none', opacity: 1, offset: 1 },
    ],
    { duration: 360, easing: 'cubic-bezier(.2,.9,.25,1)' },
  );
}

/** 校验失败弹回原位时的横向抖动 —— 用"否定"的肢体语言，比 toast 更即时。 */
export function shakeOnce(el: HTMLElement) {
  if (!canAnimate(el)) return;
  el.animate(
    [
      { transform: 'none', offset: 0 },
      { transform: 'translateX(-6px)', offset: 0.22 },
      { transform: 'translateX(6px)', offset: 0.66 },
      { transform: 'none', offset: 1 },
    ],
    { duration: 360, easing: 'ease' },
  );
}

/** hook 被自动改过 → 淡黄底渐隐。 */
export function flashOnce(el: HTMLElement) {
  if (!canAnimate(el)) return;
  el.animate(
    [
      { backgroundColor: '#fffbe6', offset: 0 },
      { backgroundColor: 'rgba(255,251,230,0)', offset: 1 },
    ],
    { duration: 900, easing: 'ease' },
  );
}

/**
 * 翻牌：绕 X 轴转走 → 换内容 → 转回来。
 *
 * 用在拖拽过程中 BEFORE ⇄ AFTER 标签的实时切换上。
 * 来回跨越分界线时会有多次翻转排队，用 token 作废旧的那次 ——
 * 否则先发起的那次会在 onfinish 里把新值覆盖回旧值，标签就卡住了。
 */
export function flipSwap(el: HTMLElement, apply: () => void) {
  if (!canAnimate(el)) {
    apply();
    return;
  }
  const token = `${Date.now()}_${Math.random()}`;
  el.dataset.flipToken = token;
  const out = el.animate(
    [
      { transform: 'rotateX(0deg) scale(1)', opacity: 1 },
      { transform: 'rotateX(88deg) scale(.92)', opacity: 0.15 },
    ],
    { duration: 110, easing: 'cubic-bezier(.4,0,1,1)' },
  );
  out.onfinish = () => {
    if (el.dataset.flipToken !== token) return;
    apply();
    el.animate(
      [
        { transform: 'rotateX(-88deg) scale(.92)', opacity: 0.15 },
        { transform: 'rotateX(0deg) scale(1)', opacity: 1 },
      ],
      { duration: 160, easing: 'cubic-bezier(0,0,.2,1)' },
    );
  };
}

/* ==========================================================================
 * FLIP：先把旧位置量下来，等 React 提交后再补一段位移动画
 * ========================================================================== */

/**
 * 捕获阶段 —— 必须在触发 setState **之前**调用（在事件处理函数里）。
 * 以 data-flip 为键：同一个条目（uid + 行类型）在重排前后是同一个 DOM 节点，
 * 用它当键才能算得出位移。
 */
export function captureTops(root?: HTMLElement | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!root) return map;
  root
    .querySelectorAll<HTMLElement>('[data-flip]:not([data-floater])')
    .forEach((el) => {
      const key = el.dataset.flip;
      if (key) map.set(key, el.getBoundingClientRect().top);
    });
  return map;
}

/** 播放阶段 —— 在 useLayoutEffect 里（DOM 已提交、浏览器还没绘制）调用。 */
export function playFlip(
  before: Map<string, number>,
  root?: HTMLElement | null,
) {
  if (!root || !before.size) return;
  root
    .querySelectorAll<HTMLElement>('[data-flip]:not([data-floater])')
    .forEach((el) => {
      const key = el.dataset.flip;
      if (!key) return;
      const from = before.get(key);
      if (from === undefined) return;
      const dy = from - el.getBoundingClientRect().top;
      if (!dy || !canAnimate(el)) return;
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        {
          duration: 260,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        },
      );
    });
}

/** 在 root 里精确找一行：同一个 AROUND 有 enter / exit 两条，必须靠 kind 区分。 */
export function findRow(
  root: HTMLElement | null,
  uid: string,
  kind: string,
): HTMLElement | null {
  if (!root) return null;
  return (
    root.querySelector<HTMLElement>(
      `[data-chain-uid="${uid}"][data-kind="${kind}"]:not([data-floater])`,
    ) ??
    root.querySelector<HTMLElement>(
      `[data-chain-uid="${uid}"]:not([data-floater])`,
    )
  );
}
