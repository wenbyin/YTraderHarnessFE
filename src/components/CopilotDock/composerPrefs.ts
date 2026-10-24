// src/components/CopilotDock/composerPrefs.ts
//
// 输入框上的**用户偏好**（今天只有一个：深度思考开关）。
//
// 为什么跟 data.ts 分开、不走 DockState
// ------------------------------------
//   data.ts 里那一坨是**会话数据**：它一变就要写回存储、还要参与「历史列表 /
//   当前会话」的推导。深度思考是个纯 UI 偏好，跟"哪条会话"完全无关 ——
//   塞进 DockState 会让每切一次开关都重写整个会话数组，还会连带跑一遍
//   pruneEmptyConversations 那套逻辑，纯属给纯函数加噪声。
//   所以它自己一个 key、自己一条读写路径。
//
// ⚠️ 这里存的是「开关状态」，**不是**「模型真的会深度思考」
// ----------------------------------------------------
//   后端 `POST /sessions/{id}/runs` 的 input 是 `additionalProperties: false`
//   且只允许 text（session.yaml v1.0.0），这个开关**今天没有任何通道能送到模型**。
//   按与用户约定的口径，它目前就是个纯前端切换态（记住选择）。
//   将来后端开了字段，改的是 Composer 提交时带上它的那一步 ——
//   不是把这里改成"假装已经生效"。

/** 存「深度思考」开关的 key。全局一个：它是用户偏好，不区分会话。 */
export const DEEP_THINK_KEY = 'ytrader.copilot.deepThink';

/**
 * 存的字符串 -> 布尔。**只认 '1' 是开**，其余（'0' / null / 脏数据）一律关。
 *
 * 为什么不 JSON.parse：存的就是一个字符，用 JSON 反而多一层能报错的地方。
 * 为什么脏数据回落 false（而不是 true）：默认关是安全的 ——
 * 万一以后这个开关真的会被送到模型，读到脏数据时"不额外要求"比
 * "莫名其妙地给每一轮都打开"更不容易让人困惑。
 */
export function parseDeepThink(raw: string | null): boolean {
  return raw === '1';
}

/** 读偏好。存储不可用（隐私模式 / SSR）时回落「关」，绝不抛。 */
export function readDeepThink(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return parseDeepThink(window.localStorage.getItem(DEEP_THINK_KEY));
  } catch {
    return false;
  }
}

/** 写偏好。写不进去（配额满 / 隐私模式）就算了，不能让一次点击把面板拖挂。 */
export function writeDeepThink(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEEP_THINK_KEY, on ? '1' : '0');
  } catch {
    return;
  }
}
