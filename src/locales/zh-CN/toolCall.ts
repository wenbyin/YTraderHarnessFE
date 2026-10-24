// src/locales/zh-CN/toolCall.ts
//
// **聊天里「工具调用」那一行的文案** —— 工具名 + 四种状态的措辞。
//
// 与 `tool.ts`（工具定义页的枚举）分开成两个文件：那个是给"配置工具的人"看的
// 元数据枚举（source_type / hook / execution_mode），这个是给"读对话的人"看的
// 动作名。两者唯一的共同点是都按契约原值做 key 末段。
//
// ⚠️ key 的末段**一律是后端 tool_key 原值**
// ------------------------------------------
//   `toolCall.name.<tool_key>` 与 `toolCall.desc.<tool_key>`。
//   服务方法的拼法见 `app/services/tool/registry/selection.py`
//   （`<域>.<函数名>`）；MCP 工具是 `<provider>.<tool>`，按后端
//   `app/config/mcp.yaml` 的 allowlist 登记（tdx 那 9 个）。
//   清单见 toolLabels.ts 的 TOOL_KEYS。
//   **未命中的 key 一律回落成原值**（`formatMessage` 的 defaultMessage），
//   所以新增工具 / 没登记过的 MCP provider 不会显示 undefined ——
//   只是暂时没中文，等补词条。
//
// ⚠️ 名字是**动词短语，不带状态词**
// ------------------------------
//   界面上状态只由图标表达（转圈 / 绿勾 / 红叉，2026-10-23 用户：
//   "正在调用、调用成功、调用失败 文字不用显示了，只要 icon 即可"），
//   所以名字自己必须干净：`检索文档`，不能再写成「工具调用：检索文档」。
//   状态词仍然留着 —— 但只作为图标的 `aria-label`（给读屏）。
//   desc 才是"这个工具到底干什么"的一句话，挂在悬停提示上。
export default {
  // ---- 状态词（**只给读屏**，不在界面上显示）----
  // 四种状态各一个词，不共用：`调用成功` 与 `调用失败` 对称，
  // `正在调用` 表示进行中，`调用` 是"不知道结果"时的中性说法
  // （state 缺省 = 历史里补不到成败，见 ToolActivityRow 的文件头）。
  'toolCall.state.running': '正在调用',
  'toolCall.state.done': '调用成功',
  'toolCall.state.error': '调用失败',
  'toolCall.state.none': '调用',

  /** 后端没给名字时的占位（极少见，但不能显示空字符串）。 */
  'toolCall.unnamed': '未命名工具',
  /** 失败但没给原因时的兜底（有 reason 就显示 reason 原文）。 */
  'toolCall.error.unknown': '工具执行失败',

  // ---- 图控制 / 通用工具（域 agent）----
  'toolCall.name.agent.enter_plan_mode': '进入计划模式',
  'toolCall.desc.agent.enter_plan_mode': '先把任务拆成计划再逐条执行',
  'toolCall.name.agent.exit_plan_mode': '退出计划模式',
  'toolCall.desc.agent.exit_plan_mode': '退出计划模式，恢复完整的执行能力',
  'toolCall.name.agent.create_task': '创建任务',
  'toolCall.desc.agent.create_task': '在计划里新建一条任务（占位工具）',
  'toolCall.name.agent.claim_task': '领取任务',
  'toolCall.desc.agent.claim_task': '领取一条待执行的任务（占位工具）',
  'toolCall.name.agent.update_task': '更新任务',
  'toolCall.desc.agent.update_task': '就地修改一条任务的状态或说明（占位工具）',
  'toolCall.name.agent.complete_task': '完成任务',
  'toolCall.desc.agent.complete_task': '把任务标记为完成并写入结果（占位工具）',
  'toolCall.name.agent.create_team': '创建执行团队',
  'toolCall.desc.agent.create_team': '创建一组并行执行者（占位工具）',
  'toolCall.name.agent.current_time': '查询当前时间',
  'toolCall.desc.agent.current_time': '查询当前日期、时间、星期与 UTC 偏移',
  'toolCall.name.agent.sleep_for': '等待指定时长',
  'toolCall.desc.agent.sleep_for': '实验工具：等待若干秒后返回，没有业务副作用',
  'toolCall.name.agent.ask_user_question': '向你提问',
  'toolCall.desc.agent.ask_user_question':
    '向你提出 1–4 个带选项的问题，等你回答后继续',

  // ---- 组合工具（域 agent.platform）----
  'toolCall.name.agent.platform.describe_platform': '查看平台能力',
  'toolCall.desc.agent.platform.describe_platform':
    '汇总平台当前可用的工具与文档处理能力',

  // ---- 联网（域 web）----
  'toolCall.name.web.search': '搜索网页',
  'toolCall.desc.web.search': '搜索公开网页，返回标题、链接与摘要',
  'toolCall.name.web.fetch': '抓取网页',
  'toolCall.desc.web.fetch': '抓取指定公开网页，返回标题与正文',

  // ---- 平台服务（服务方法）----
  'toolCall.name.capability.list_capabilities': '列出能力',
  'toolCall.desc.capability.list_capabilities': '列出平台的能力清单与分组',
  'toolCall.name.document.retrieve_documents': '检索文档',
  'toolCall.desc.document.retrieve_documents':
    '在文档库里做一轮检索（RAG 召回）',
  'toolCall.name.skill.list_skills': '列出技能',
  'toolCall.desc.skill.list_skills': '列出当前可用的技能',

  // ---- 记忆（三个层级）----
  'toolCall.name.memory.search': '检索对话记忆',
  'toolCall.desc.memory.search': '检索历史对话原文（全文 + 向量双路）',
  'toolCall.name.memory_atom.search': '检索结构化记忆',
  'toolCall.desc.memory_atom.search': '检索从对话里提炼出的结构化事实',
  'toolCall.name.memory.scene.get': '读取场景记忆',
  'toolCall.desc.memory.scene.get': '按名称读取一份场景记忆的全文',

  // ---- MCP：tdx 行情服务 ----
  // 来自后端 `app/config/mcp.yaml` 的 provider `tdx` + `tools.allow` 那 9 条
  // （tool_key = `<provider>.<tool>`，链路上会看到 `tdx_get_market_info` 这种
  // wire 写法，toolLabels 会归一到 `tdx.get_market_info`）。
  // ⚠️ 这个 server 的实现**不在本仓**（`tdx-link-mcp.exe` 是独立产物），
  //    名字按工具名如实翻，说明只写"它做什么"这一层，不替它编业务语义。
  //    allowlist 变了要同步这里 + TOOL_KEYS。
  'toolCall.name.tdx.ensure_tdx_ready': '初始化行情服务',
  'toolCall.desc.tdx.ensure_tdx_ready':
    '检查并启动本地行情服务，确保后续查询可用',
  'toolCall.name.tdx.get_market_info': '查询市场信息',
  'toolCall.desc.tdx.get_market_info': '获取市场与指数的行情信息',
  'toolCall.name.tdx.screen_stocks': '筛选股票',
  'toolCall.desc.tdx.screen_stocks': '按条件筛选个股',
  'toolCall.name.tdx.screen_combo': '组合选股',
  'toolCall.desc.tdx.screen_combo': '多条件组合筛选个股',
  'toolCall.name.tdx.run_backtest': '运行回测',
  'toolCall.desc.tdx.run_backtest': '按策略跑一次历史回测',
  'toolCall.name.tdx.get_financial_info': '查询财务数据',
  'toolCall.desc.tdx.get_financial_info': '查询个股的财务指标',
  'toolCall.name.tdx.get_market_stats': '查询市场统计',
  'toolCall.desc.tdx.get_market_stats': '获取市场的统计数据',
  'toolCall.name.tdx.check_version': '检查数据版本',
  'toolCall.desc.tdx.check_version': '查询本地行情数据的版本与更新时间',
  'toolCall.name.tdx.list_experts': '列出专家',
  'toolCall.desc.tdx.list_experts': '列出可用的专家清单',
};
