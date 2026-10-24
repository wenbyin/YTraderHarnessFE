// src/components/CopilotDock/streamingMarkdown.tsx
//
// 流式正文的「逐字淡入」—— 一次 delta 里的 N 个字**一个一个**出现。
//
// 需求原话：「新文字出现，比如 message.delta 里面有七个文字。要一个一个淡入出现」。
//
// 为什么只能在 markdown 组件这一层做
// --------------------------------
//   正文是 `@copilotkit/react-ui` 的 AssistantMessage 里那块 `<Markdown>` 渲染的，
//   而它**写死**成库内私有的 Markdown（没有 props 能换掉它）：
//
//       const Markdown = ({ content, components }) => (
//         <div className="copilotKitMarkdown">
//           <ReactMarkdown components={{...defaultComponents, ...components}} .../>
//         </div>
//       );
//
//   但 `components` 是**能传进去的**：CopilotChat 的 `markdownTagRenderers` 一路
//   透传到 Markdown 的 components（见 DockRenderMessage 里那几个 prop 的注解）。
//   于是不改库、不重写气泡，只把「块级容器」换成"先切字、再交给原来的实现"。
//
// 为什么切字发生在 markdown 解析**之后**
// ------------------------------------
//   在原始字符串上插 `<span>` 会毁掉 markdown 语法（`**bo<span>l</span>d**` 不再是
//   粗体）。而 components 拿到的 children 已经是解析结果 —— 文字节点切碎只影响
//   渲染，不影响语义。所以 p / li / h1-h6 / blockquote / td / th 这些"直接装文字
//   的块"由我们接管，inline 元素（strong / em / a …）靠 cloneElement 递归下去。
//
// 哪些字要淡入：用「上一次渲染到第几个字」做水位线
// ----------------------------------------------
//   cursor.index 是**文档顺序**的字号（跨块连续）。`from` 是上一次渲染结束时的
//   总数，于是 `index >= from` 就是"这一帧新来的字"。水位线由 DockRenderMessage
//   在渲染提交后记下（readCount()）。
//
//   ⚠️ 不能拿 content.length 当水位线：markdown 会吃掉 `**`、`#`、列表符号，
//      文档顺序的字数**小于**原文长度，两者一对比就整体错位（表现是"永远有几
//      十个字在反复淡入"）。
//
// 为什么每个字要留一个 span、且延迟必须"记住"
// -----------------------------------------
//   ① 延迟不能每次渲染重算：`from` 每帧都在长，`(index - from) * 28` 会从 168ms
//      一路缩到 0 —— React 把新的 animation-delay 写进同一个 DOM 节点上，动画
//      时间轴被反复平移，看着像抽搐。所以每个字的延迟在**第一次出现时**定下来，
//      存进 Map（delayFor）。
//   ② 也不能下一帧就把 span 换回纯文本：换掉等于把还在淡入的字直接显示出来
//      （淡入被截断）。所以最近 KEEP 个字的 span 要留着 —— 它们的动画早跑完了，
//      留着只是"没有视觉变化"，却能让 React 复用同一个节点、不重启动画。
//      更早的字回到纯文本（一个字符串节点），DOM 里最多 KEEP + 一个 delta 的 span。
import React from 'react';

/** 相邻两个字之间的间隔。7 个字 ≈ 0 → 168ms，尾巴刚好接上 200ms 的淡入。 */
const STAGGER_MS = 28;
/** 单个字最多等这么久：一次给 40 个字时，不能让最后一个等到 1.1 秒后。 */
const MAX_STAGGER_MS = 280;
/** 已经淡入完、但仍保留 span 的字数窗口（见文件头 ②）。 */
const KEEP = 200;

/**
 * 每个字的淡入延迟，按"文档顺序字号"记。
 *
 * ⚠️ 模块级而不是组件级：水位线跨渲染、跨 React 重挂都要连续。同一时刻只有一条
 *    正文在流（面板只有一个对话区），所以一份全局表就够；`delayFor` 会在字号
 *    突然回退（新的一轮 / 重新生成）时自己清空。
 */
const delays = new Map<number, number>();
let maxSeen = -1;

/**
 * 每条消息的"已经渲染到第几个字"。
 *
 * ⚠️ 按 **message.id** 存，不是放到组件的 useRef 里：库的 `Messages` 是按
 *    **数组下标**给 key 的（`}, index)`），历史被整份替换（setMessages）之后，
 *    同一个组件实例可能已经换成另一条消息了。按 id 存才不会把上一条的水位线
 *    套到这条上。
 */
const watermarks = new Map<string, number>();

/** 这条消息上一次渲染走到第几个字；没渲染过是 `undefined`。 */
export function revealFromOf(id: string): number | undefined {
  return watermarks.get(id);
}

/** 记下这一次渲染走到哪 —— 下一次的 `from`。 */
export function commitRevealCount(id: string, count: number): void {
  watermarks.set(id, count);
}

/** 测试用：把模块级状态清空（用例之间不能互相污染）。 */
export function resetStreamingChars(): void {
  delays.clear();
  watermarks.clear();
  maxSeen = -1;
}

function delayFor(index: number, from: number): number {
  // 字号突然回到很小的值 → 这是新的一轮（或内容被换掉），旧表全部作废。
  if (maxSeen > KEEP && index < maxSeen - 4 * KEEP) {
    delays.clear();
    maxSeen = -1;
  }

  const known = delays.get(index);
  if (known !== undefined) return known;

  const delay = Math.min(
    Math.max(index - from, 0) * STAGGER_MS,
    MAX_STAGGER_MS,
  );
  delays.set(index, delay);
  maxSeen = Math.max(maxSeen, index);

  // 只留窗口内的 —— 否则一轮长回答下来这张表会跟正文一样长。
  if (delays.size > 4 * KEEP) {
    for (const key of delays.keys()) {
      if (key < maxSeen - 4 * KEEP) delays.delete(key);
    }
  }

  return delay;
}

/** 渲染一趟用的游标。`index` 会**在渲染过程中**自增（文档顺序）。 */
interface Cursor {
  /** 上一次渲染到这里为止（`index >= from` 就是新字）。 */
  from: number;
  /** 已经走过的字数。 */
  index: number;
  /** 淡入动画的 class（见 style.ts 的 charIn，keyframes 也在那里）。 */
  className: string;
}

/**
 * 这些标签下面的文字**不切**：代码块的等宽排版、复制行为、行内代码的底色都
 * 经不起"一个字一个 span"（还会让 `overflow-x` 的滚动宽度变得很奇怪）。
 */
const SKIP_TAGS = new Set(['pre', 'code', 'script', 'style', 'textarea']);

/** 把一段文字切成「新字 → 带动画的 span」「窗口内的旧字 → 无动画 span」「更旧 → 纯文本」。 */
function revealText(text: string, cursor: Cursor): React.ReactNode {
  const out: React.ReactNode[] = [];
  /** 连续的老字攒成一个字符串再 push —— 一个字符一个字符串节点太碎。 */
  let plain = '';

  for (const char of Array.from(text)) {
    const index = cursor.index;
    cursor.index += 1;

    if (index >= cursor.from) {
      if (plain !== '') {
        out.push(plain);
        plain = '';
      }
      out.push(
        <span
          key={index}
          className={cursor.className}
          style={{ animationDelay: `${delayFor(index, cursor.from)}ms` }}
        >
          {char}
        </span>,
      );
      continue;
    }

    if (index >= cursor.from - KEEP) {
      // 窗口内：已经是老字了，**不给动画类**（给了就等于又淡入一次）。
      if (plain !== '') {
        out.push(plain);
        plain = '';
      }
      out.push(<span key={index}>{char}</span>);
      continue;
    }

    plain += char;
  }

  if (plain !== '') out.push(plain);
  return out.length === 1 ? out[0] : out;
}

/**
 * 递归处理 children：字符串切字，元素用 cloneElement 换掉它的 children。
 *
 * 这里**不判断"是不是认识的标签"** —— 只要拿到元素就往下走，是因为
 * `p > strong > 文字` 这种嵌套里文字挂在 strong 上，而 strong 没有单独的
 * components 覆盖项（库的 defaultComponents 里也没有），只能靠递归。
 */
function revealNode(node: React.ReactNode, cursor: Cursor): React.ReactNode {
  if (typeof node === 'string') return revealText(node, cursor);
  if (typeof node === 'number' || typeof node === 'boolean') return node;
  if (node === null || node === undefined) return node;

  if (Array.isArray(node)) {
    return React.Children.map(node, (child) => revealNode(child, cursor));
  }

  if (React.isValidElement(node)) {
    const element = node as React.ReactElement<{ children?: React.ReactNode }>;
    if (SKIP_TAGS.has(String(element.type))) return node;

    const children = element.props?.children;
    if (children === undefined) return node;
    return React.cloneElement(element, undefined, revealNode(children, cursor));
  }

  return node;
}

/**
 * 一个 markdown 组件（p / li / …）的宽松签名。
 *
 * ⚠️ children 单独声明成 `React.ReactNode`：只写 `Record<string, unknown>` 的话
 *    解构出来的 children 是 `unknown`，每个 `<h1>{children}</h1>` 都会被 tsc 顶回来。
 */
type ComponentProps = Record<string, unknown> & {
  children?: React.ReactNode;
};
type Component = React.ComponentType<ComponentProps>;

function childrenOf(props: Record<string, unknown>): React.ReactNode {
  return (props as { children?: React.ReactNode }).children;
}

/** 把一个容器组件包成"先切字再交给它"。 */
function wrap(base: Component, cursor: Cursor): Component {
  const Wrapped = (props: ComponentProps) =>
    // children 走 createElement 的第三个参数（不塞进 props）：
    // 一来 biome 的 lint 要求如此，二来它会覆盖 props 里那份原始 children。
    React.createElement(base, props, revealNode(childrenOf(props), cursor));

  Wrapped.displayName = `Streaming(${base.displayName || base.name || 'tag'})`;
  return Wrapped as Component;
}

/**
 * 库的 defaultComponents（`@copilotkit/react-ui` dist 里 src/components/chat/Markdown.tsx）。
 *
 * ⚠️ 必须逐条照抄，尤其是 `p` 渲染成 **div**（带 `copilotKitParagraph`）——
 *    style.ts 里正文的段落间距是按这个类名写的，换成 `<p>` 会让行距与段距全变；
 *    `className` 少一个 `copilotKitMarkdownElement`，代码块 / 行内代码的底色、
 *    圆角那几条覆盖样式会静默失效。
 */
const libraryDefaults: Record<string, Component> = {
  a: ({ children, ...props }) => (
    <a
      className="copilotKitMarkdownElement"
      {...props}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  code: ({ children, className, ...props }) => (
    <code
      className={`copilotKitMarkdownElement copilotKitInlineCode ${String(className ?? '')}`}
      {...props}
    >
      {children}
    </code>
  ),
  h1: ({ children, ...props }) => (
    <h1 className="copilotKitMarkdownElement" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="copilotKitMarkdownElement" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="copilotKitMarkdownElement" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="copilotKitMarkdownElement" {...props}>
      {children}
    </h4>
  ),
  h5: ({ children, ...props }) => (
    <h5 className="copilotKitMarkdownElement" {...props}>
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6 className="copilotKitMarkdownElement" {...props}>
      {children}
    </h6>
  ),
  // ⚠️ 库这里就是 div，不是 p（理由见上面那段）。
  p: ({ children, ...props }) => (
    <div className="copilotKitMarkdownElement copilotKitParagraph" {...props}>
      {children}
    </div>
  ),
  pre: ({ children, ...props }) => (
    <pre className="copilotKitMarkdownElement" {...props}>
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="copilotKitMarkdownElement" {...props}>
      {children}
    </blockquote>
  ),
  ul: ({ children, ...props }) => (
    <ul className="copilotKitMarkdownElement" {...props}>
      {children}
    </ul>
  ),
  li: ({ children, ...props }) => (
    <li className="copilotKitMarkdownElement" {...props}>
      {children}
    </li>
  ),
};

/**
 * "直接装文字"的块 —— 只有它们需要接管；其余（strong / em / a / del …）由
 * revealNode 递归处理。`td` / `th` 库没有默认实现，照原样渲染即可。
 *
 * ⚠️ `code` / `pre` 不在这里：代码块要整块出现（见 SKIP_TAGS）。
 */
const CONTAINERS = [
  'p',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'td',
  'th',
] as const;

export interface StreamingRenderers {
  /** 交给 `markdownTagRenderers` 的那份 components。 */
  components: Record<string, Component>;
  /** 这一次渲染一共走过多少字 —— 调用方提交后读它，当下一次的水位线。 */
  readCount: () => number;
}

/**
 * 造一份"会逐字淡入"的 markdown components。
 *
 * @param base      调用方原本的 `markdownTagRenderers`（可以没有）——
 *                  我们只在它**外面**加一层切字，不替换它的实现。
 * @param className 淡入动画的 class。
 * @param from      水位线：上一次渲染结束时走到第几个字。
 */
export function makeStreamingRenderers(options: {
  base?: Record<string, unknown> | null;
  className: string;
  from: number;
}): StreamingRenderers {
  const cursor: Cursor = {
    from: options.from,
    index: 0,
    className: options.className,
  };

  const components: Record<string, Component> = { ...libraryDefaults };

  // 调用方给了就以它为准（我们只在它外面切字）。
  for (const [tag, component] of Object.entries(options.base ?? {})) {
    if (typeof component === 'function')
      components[tag] = component as Component;
  }

  for (const tag of CONTAINERS) {
    const base =
      components[tag] ??
      (({ children, ...props }) =>
        React.createElement(tag, props, children as React.ReactNode));
    components[tag] = wrap(base, cursor);
  }

  return { components, readCount: () => cursor.index };
}
