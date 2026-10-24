// src/pages/retrieval_eval/runRegistry.ts
// 本机跑测登记表 —— 「跑测列表」页的数据来源。
//
// 为什么需要它
// ------------
// 契约（`rag_eval_design/retrieval_eval_openapi.yaml`）与后端
// （`app/api/v1/retrieval_eval.py`）都**没有**「列出跑测」这个端点：
// 11 条路由里只有 `POST /runs` 与按 id 取详情（`/runs/{id}`、
// `/runs/{id}/stage-stats`、`/runs/{id}/cases`、`/runs/{id}/cases/{cid}/trace`）。
//
// 所以「跑测历史」在前端**没有服务端来源**，只有两条路：
//   1. 后端补一个列表端点（本轮不动后端）；
//   2. 本机记住自己发起过的 run id，再逐个拉详情 —— 就是这里。
//
// 代价（已如实写在页面上，不要悄悄去掉）
// ------------------------------------
// 换浏览器 / 换机器 / 清了站点数据，旧记录就没了；别人用 API 直接发起的
// 跑测也不会出现在这个列表里。它是一个**本机视图**，不是"全部跑测"。

/** localStorage 键。`ytrader.` 前缀避免与站点上其它 demo 撞名。 */
const KEY = 'ytrader.retrieval_eval.run_ids';

/** 上限：一个 id 一个详情请求，留太多会让列表页首屏拖慢。 */
const MAX_IDS = 100;

/**
 * 读一次 localStorage。
 *
 * 单独包 try：`localStorage` 在隐私模式 / 站点数据被禁时**取值就会抛**，
 * 不兜住的话整个列表页白屏 —— 而它只是一份锦上添花的记录。
 */
function readRaw(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX_IDS)));
  } catch {
    // 写不进去（配额满 / 被禁）只是丢历史，不该让发起跑测这件事失败。
  }
}

/** 已记住的 run id，**新的在前**。 */
export function getRememberedEvalRunIds(): string[] {
  return readRaw();
}

/** 记下一个刚发起的跑测。重复 id 会被挪到最前，不产生重复项。 */
export function rememberEvalRun(evalRunId: string): void {
  if (!evalRunId) return;
  const rest = readRaw().filter((id) => id !== evalRunId);
  write([evalRunId, ...rest]);
}

/**
 * 忘掉一个跑测。
 *
 * 用途是清理**拉不到详情**的 id（后端 404：被删了、或换了库）——
 * 留着它只会让列表页每次白跑一个必败的请求。
 */
export function forgetEvalRun(evalRunId: string): void {
  write(readRaw().filter((id) => id !== evalRunId));
}
