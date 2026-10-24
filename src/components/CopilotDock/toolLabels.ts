// src/components/CopilotDock/toolLabels.ts
//
// 工具调用的**展示文案**：工具名（人话）+ 四种状态各一句。
//
// 为什么需要这一层
// --------------
//   后端推来的工具名是 `tool_key`（`agent.enter_plan_mode`、
//   `document.retrieve_documents`）或者它的 wire 写法
//   （`agent_enter_plan_mode`）。直接铺在对话里，用户读到的是一个英文标识符，
//   既不知道它干了什么，也不知道它成了没有。这个模块只解决"读得懂"：
//     `agent.enter_plan_mode` -> 「正在调用：进入计划模式」
//
// 三层回落（缺一层就会出现 undefined / 空白行）
// -------------------------------------------
//   ① 找不到 `toolCall.name.<key>`  -> 显示**原值**（formatMessage 的
//      defaultMessage）。新增工具、MCP 动态工具（`<provider>.<tool>`，
//      运行时才存在，不可能提前登记）都走这条，界面上只是"还没翻译"，
//      不是报错。
//   ② 找不到 `toolCall.desc.<key>`  -> 不给悬停说明（返回原值本身）。
//   ③ 应用里没挂 IntlProvider       -> 用下面 FALLBACK 里那份中文
//      （见 useOptionalIntl 的说明）。
//
// ⚠️ 名字的三种写法要能归一到同一个 key
// ------------------------------------
//   同一个工具在链路上有三种写法（详见 toolIdentity.ts）：
//       agent.current_time   契约正名
//       agent_current_time   发给模型的 wire 名（点换下划线）
//       current_time         工具函数名
//   第一种直接命中；后两种用 `wireOf` 归一后在 KEY_BY_WIRE 里查。
//   ⚠️ 别用"包含关系"去猜 —— `search` 与 `web.search` 都能被猜中，
//      猜错的后果是把 A 工具的名字安到 B 头上（toolIdentity 里同一条纪律）。
//
// ⚠️ 为什么不直接用 umi 的 `useIntl`
// --------------------------------
//   react-intl 的 `useIntl` 在**没有 Provider** 时直接抛错（invariant），
//   而 CopilotDock 的单测一直是裸渲染（不挂 Provider，见 toolActivity.test.tsx
//   那几个"只测样式 / 行数"的用例）。为了翻译给十几个测试文件都套 Provider
//   不值得，所以这里读 `IntlContext` 本身：没 Provider 时它是 undefined，
//   于是落到 FALLBACK —— 组件不会挂，测试也还能读到"有状态词"的整行文字。
//   真实应用里 umi 一定挂了 Provider，翻译照常生效（含切语言）。

import { useContext } from 'react';
import { IntlContext, type IntlShape } from 'react-intl';

import { wireOf } from './toolIdentity';
import type { ToolCallStatus } from './useToolActivity';

/**
 * 已登记译文的所有工具（tool_key）。
 *
 * 两个来源：
 *   · **服务方法 / 图级工具**：`<域>.<函数名>`，拼法见 YTraderHarness 的
 *     `app/services/tool/registry/selection.py`，源码静态可枚举；
 *   · **MCP 工具**：`<provider>.<tool>`，运行时由 provider 的 `tools/list`
 *     决定 —— 这里登记的是后端 `app/config/mcp.yaml` 里 allowlist 放行的那些
 *     （目前是 `tdx` 的 9 个）。allowlist 改了要同步这里 + 两份 toolCall.ts。
 *
 * ⚠️ 这张表只有一个用途：把 wire 写法（下划线）归一回契约正名，
 *    让 `agent_current_time` / `tdx_get_market_info` 也能查到译文。
 *    真正的文案在 `locales/<lang>/toolCall.ts` —— **两边要同步增删**。
 * ⚠️ 没登记的（别家 MCP provider、以后新加的服务方法）不会出错，
 *    只是显示原值，等补词条即可。
 */
export const TOOL_KEYS = [
  // 图控制 / 通用
  'agent.enter_plan_mode',
  'agent.exit_plan_mode',
  'agent.create_task',
  'agent.claim_task',
  'agent.update_task',
  'agent.complete_task',
  'agent.create_team',
  'agent.current_time',
  'agent.sleep_for',
  'agent.ask_user_question',
  // 组合工具
  'agent.platform.describe_platform',
  // 联网
  'web.search',
  'web.fetch',
  // 平台服务
  'capability.list_capabilities',
  'document.retrieve_documents',
  'skill.list_skills',
  // 记忆（三层）
  'memory.search',
  'memory_atom.search',
  'memory.scene.get',
  // MCP：tdx 行情服务（后端 app/config/mcp.yaml 的 tools.allow，9 条）
  'tdx.ensure_tdx_ready',
  'tdx.get_market_info',
  'tdx.screen_stocks',
  'tdx.screen_combo',
  'tdx.run_backtest',
  'tdx.get_financial_info',
  'tdx.get_market_stats',
  'tdx.check_version',
  'tdx.list_experts',
] as const;

/** wire 写法（小写 + 非字母数字换下划线）-> 契约正名。 */
const KEY_BY_WIRE = new Map<string, string>(
  TOOL_KEYS.map((key) => [wireOf(key), key]),
);

/** 同一批 key 的 wire 形式，留给"短名"那条规则按后缀找。 */
const WIRES: Array<{ wire: string; key: string }> = TOOL_KEYS.map((key) => ({
  wire: wireOf(key),
  key,
}));

/** 后端没给名字时的占位（`mergeToolCalls` 用，渲染时换成译文）。 */
export const UNNAMED_TOOL = '(未命名工具)';

/**
 * 没有 IntlProvider 时的兜底（单测 / 极端降级）。
 *
 * ⚠️ 只有这四句 + 两条错误文案——**工具名没有兜底**：名字的兜底就是原值，
 *    给原值编一个中文等于凭空发明翻译。
 * ⚠️ 这里出现的重复不是"没走 i18n"：真实渲染永远先查语言包，这里只是
 *    "语言包压根读不到"时的那一份。改文案要**两处一起改**
 *    （`locales/<lang>/toolCall.ts` 与这里），否则测试与线上会各说一套。
 */
const FALLBACK: Record<string, string> = {
  'toolCall.state.running': '正在调用',
  'toolCall.state.done': '调用成功',
  'toolCall.state.error': '调用失败',
  'toolCall.state.none': '调用',
  'toolCall.unnamed': '未命名工具',
  'toolCall.error.unknown': '工具执行失败',
};

/**
 * 把链路上任意一种写法归一成契约正名。
 *
 * 三条规则，**从窄到宽**：
 *   ① 正好是契约正名（`agent.current_time`）；
 *   ② wire 之后相等（`agent_current_time`）；
 *   ③ **短名且唯一**：某个 key 的 wire 以 `_<短名>` 结尾，且全表只有它一个
 *      （`current_time` -> `agent.current_time`）。
 *
 * ③ 必须带"唯一"这个条件，否则 `search` 这种短名会同时命中 `web.search` 与
 * `memory.search`，随便挑一个就等于给 A 工具安上 B 的名字 —— 对话里读起来
 * 是"检索文档"、实际调的是联网搜索，比显示原值恶劣得多。
 * 认不出（含歧义）一律**原样返回**：宁可难看，也不要猜错。
 */
export function canonicalToolKey(name: string): string {
  const exact = KEY_BY_WIRE.get(name);
  if (exact) return exact;

  const wire = wireOf(name);
  const byWire = KEY_BY_WIRE.get(wire);
  if (byWire) return byWire;

  const suffixed = WIRES.filter((item) => item.wire.endsWith(`_${wire}`));
  return suffixed.length === 1 ? suffixed[0].key : name;
}

/** 一条工具调用要显示的几段文字。 */
export interface ToolLabels {
  /** 工具名（人话）；没译文就是原值。 */
  name: (name: string) => string;
  /**
   * 状态词（`正在调用` / `调用成功` / `调用失败`）。
   *
   * ⚠️ **只给读屏用**：界面上状态只由图标表达（2026-10-23 用户："正在调用、
   *    调用成功、调用失败 文字不用显示了，只要 icon 即可"）。挂到图标的
   *    `aria-label` 上，视觉上不占位置，但无障碍树里仍有信息。
   */
  state: (status?: ToolCallStatus) => string;
  /**
   * 悬停说明：一句话讲这个工具干什么 + 原值。
   * 原值必须留着 —— 排障时要拿它去对齐后端日志（与 pages/tool 的 Tag 同口径）。
   */
  hint: (name: string) => string;
  /** 失败原因；后端没给就用通用文案。 */
  error: (reason?: string) => string;
}

export function useToolLabels(): ToolLabels {
  // ⚠️ 用 useContext 而不是 useIntl：后者没有 Provider 会抛（见文件头）。
  //    hook 顺序不变 —— 无论有没有 Provider 都只调这一个 hook。
  // ⚠️ 类型断言不是可有可无：react-intl 把 Context 声明成 `Context<IntlShape>`
  //    （非空），但**运行时**没有 Provider 时拿到的就是 undefined。照着声明
  //    写，`if (!intl)` 会被读成"恒假分支"，而它恰恰是单测环境下唯一生效的分支。
  const intl = useContext(IntlContext) as IntlShape | undefined;

  const t = (id: string, fallback: string): string => {
    if (!intl) return FALLBACK[id] ?? fallback;
    return intl.formatMessage({ id, defaultMessage: fallback });
  };

  return {
    name: (raw) =>
      raw === UNNAMED_TOOL
        ? t('toolCall.unnamed', UNNAMED_TOOL)
        : // 没译文时 formatMessage 返回 defaultMessage（= 原值），正是要的
          t(`toolCall.name.${canonicalToolKey(raw)}`, raw),

    state: (status) =>
      t(status ? `toolCall.state.${status}` : 'toolCall.state.none', ''),

    hint: (raw) => {
      const key = canonicalToolKey(raw);
      const desc = t(`toolCall.desc.${key}`, '');
      return desc ? `${desc}\n${key}` : key;
    },

    error: (reason) =>
      reason && reason.trim() !== '' ? reason : t('toolCall.error.unknown', ''),
  };
}
