// src/components/CopilotDock/toolIdentity.ts
//
// 「这两个名字是不是同一个工具」—— 整个面板里唯一一处判据。
//
// 为什么单独一个文件（2026-10-20）
// ----------------------------
//   判据有两个使用者，而它们**不该互相依赖**：
//     · useToolActivity（实时通道）—— 一次调用的 start / end 配对、双通道去重；
//     · history + ToolActivityRow（历史通道）—— 同一条记录里重复落库的调用归并。
//   历史那条路以前只能从 useToolActivity 里拿 `sameTool`，而那是个 hook 文件：
//   import 它会把 runEventStream → agentRuntime（含请求层与常量）整条链拖进
//   纯数据层的单测里。判据本身只是两个字符串的比较，没有任何理由挂在那条链上。
//   （`useToolActivity` 仍然 re-export 这两个函数，别处老的 import 不用改。）
//
// ⚠️ 判据必须**窄**
// ----------------
//   同一工具在链路上有三种写法（后端 `wire_name` 只改发给 provider 的字符串，
//   tool_key 本身不动）：
//
//       agent.current_time   tool_key（点分，库里 / 事件里的正名）
//       agent_current_time   发给模型的 wire 名（点换成下划线）
//       current_time         工具函数名（langgraph `tools` 通道报的就是它）
//
//   两条窄规则就够覆盖它们：wire 之后相等；短名正好是长名末尾的一段。
//   不能放宽成"包含关系"或"前缀相同" —— `web.search` 与 `doc.search` 一合并
//   就等于凭空吞掉一次真调用。

/** 与后端 `wire_name` 同一条规则：非 `[A-Za-z0-9_-]` 一律换成下划线。 */
export function wireOf(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase();
}

/**
 * 两个名字是不是**同一个工具**的两种写法。
 *
 * 判据两条，都很窄：
 *   · **wire 之后相等**（点 ↔ 下划线只是同一个名字的两种写法）；
 *   · **短名正好是长名末尾的一段**（`web.search` ⊃ `search`）。
 *
 * 这样 `web.search` 与 `doc.search` **不会**被合并（wire 后 `web_search` ≠
 * `doc_search`，谁也不是谁的后缀）—— 合并它们等于凭空吞掉一次调用。
 * 代价是"真有一对 `search` 与 `web.search` 同时存在"时会被认作同一行，而那
 * 本身就说明注册表里两个工具在抢同一个短名（后端 `tool_key_of` 会对这种
 * 情况打 WARNING），界面上多一行少一行都不是主要矛盾。
 *
 * 空串不与任何东西相等（含空串自己）：没名字的两条记录不能因为"都没名字"
 * 就被并成一行。
 */
export function sameTool(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;

  const wireA = wireOf(a);
  const wireB = wireOf(b);
  if (wireA === wireB) return true;

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const [shortWire, longWire] =
    wireA.length <= wireB.length ? [wireA, wireB] : [wireB, wireA];
  return (
    long.endsWith(`.${short}`) ||
    long.endsWith(`_${short}`) ||
    longWire.endsWith(`_${shortWire}`)
  );
}
