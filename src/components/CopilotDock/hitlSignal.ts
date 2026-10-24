// src/components/CopilotDock/hitlSignal.ts
//
// 「现在有没有待处理的人工审批」这一个布尔，在 Composer（输入框）与
// HitlInterrupt（对话区那一层）之间共享。
//
// ⚠️ 为什么不能再用 CopilotKit 的 `useCopilotChatInternal().interrupt`
// --------------------------------------------------------------
//   那个值来自 `copilotkit.interruptElement`，而只有 useInterrupt 用默认的
//   `renderInChat: true` 时它才会被发布。**问题是 renderInChat 为 true 还有第二个
//   效果：v1 的 Messages 组件也会把卡片渲染一遍。**
//   `@copilotkit/react-ui/dist/index.cjs` 里两行就是全部证据：
//       1703  const { messages: visibleMessages, interrupt } = useCopilotChatInternal();
//       1756  ...(messages 与 loading 光标之后) 直接 {interrupt}
//   → 同一个 <HitlCard> 出现在两个地方：对话流里一张、我们的浮动层一张。
//
//   我们**只要**「锁住输入框」这一个副作用，不需要库替我们排版。所以固定
//   `renderInChat: false`（hook 直接返回元素，我们挂到浮动层），这个布尔自己维护。
//
// ⚠️ 为什么是模块级状态，而不是 context
// ----------------------------------
//   两个消费点一个是库自己的输入框插槽、一个是对话区的一层，中间隔着 CopilotKit
//   的 provider；塞 context 得改 index.tsx 的树、还要把状态提到面板组件上，
//   比这里多两个文件的改动。同一时刻只会渲染一个面板实例（切会话是整棵重挂），
//   模块级够用。
//
// ⚠️ 单测要自己复位（模块级状态的代价）
//   测试之间这个值会串，Composer.test.tsx / HitlInterrupt.test.tsx 的
//   beforeEach 里都要 `setHitlPending(false)`。
import { useSyncExternalStore } from 'react';

let pending = false;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** 发布方：HitlInterrupt 拿到 / 丢掉中断元素时调用。 */
export function setHitlPending(next: boolean): void {
  if (pending === next) return;
  pending = next;
  for (const notify of listeners) notify();
}

/**
 * 消费方：Composer 用它决定要不要禁止发送。
 *
 * 等人工输入期间这个会话**建不了新运行**（后端 409），agent 的 onInitialize 也会
 * 因为「有未应答的中断」直接抛错 —— 让人能按下发送键只会换来一条报错。
 */
export function useHitlPending(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    // 服务端快照：永远「没有待办」（首屏不该把输入框锁上）
    () => false,
  );
}
