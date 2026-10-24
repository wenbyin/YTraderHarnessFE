// src/locales/en-US/toolCall.ts
//
// Same key set as `zh-CN/toolCall.ts` (the last segment is always the backend
// `tool_key`, so anything untranslated falls back to the raw value instead of
// rendering `undefined`).
//
// The state prefixes are written so that `prefix + tool name` reads as one
// sentence — "Calling: web search" / "Call failed: web search".
export default {
  // ---- state prefixes ----
  'toolCall.state.running': 'Calling',
  'toolCall.state.done': 'Call succeeded',
  'toolCall.state.error': 'Call failed',
  'toolCall.state.none': 'Call',

  'toolCall.unnamed': 'Unnamed tool',
  'toolCall.error.unknown': 'The tool call failed',

  // ---- agent: graph control / generic tools ----
  'toolCall.name.agent.enter_plan_mode': 'Enter plan mode',
  'toolCall.desc.agent.enter_plan_mode':
    'Break the work into a plan first, then execute it step by step',
  'toolCall.name.agent.exit_plan_mode': 'Exit plan mode',
  'toolCall.desc.agent.exit_plan_mode':
    'Leave plan mode and restore the full set of capabilities',
  'toolCall.name.agent.create_task': 'Create task',
  'toolCall.desc.agent.create_task':
    'Add a task to the plan (placeholder tool)',
  'toolCall.name.agent.claim_task': 'Claim task',
  'toolCall.desc.agent.claim_task': 'Claim a pending task (placeholder tool)',
  'toolCall.name.agent.update_task': 'Update task',
  'toolCall.desc.agent.update_task':
    'Update a task in place (placeholder tool)',
  'toolCall.name.agent.complete_task': 'Complete task',
  'toolCall.desc.agent.complete_task':
    'Mark a task as done and record the result (placeholder tool)',
  'toolCall.name.agent.create_team': 'Create team',
  'toolCall.desc.agent.create_team':
    'Create a group of parallel workers (placeholder tool)',
  'toolCall.name.agent.current_time': 'Check the current time',
  'toolCall.desc.agent.current_time':
    'Look up the current date, time, weekday and UTC offset',
  'toolCall.name.agent.sleep_for': 'Wait',
  'toolCall.desc.agent.sleep_for':
    'Test-only tool: sleep for a number of seconds, no side effects',
  'toolCall.name.agent.ask_user_question': 'Ask you a question',
  'toolCall.desc.agent.ask_user_question':
    'Ask you 1–4 multiple-choice questions and wait for your answer',

  // ---- agent.platform: composite tools ----
  'toolCall.name.agent.platform.describe_platform': 'Inspect platform',
  'toolCall.desc.agent.platform.describe_platform':
    'Summarise the tools and document capabilities currently available',

  // ---- web ----
  'toolCall.name.web.search': 'Search the web',
  'toolCall.desc.web.search':
    'Search public web pages and return titles, links and snippets',
  'toolCall.name.web.fetch': 'Fetch a web page',
  'toolCall.desc.web.fetch':
    'Fetch a public web page and return its title and body',

  // ---- platform services ----
  'toolCall.name.capability.list_capabilities': 'List capabilities',
  'toolCall.desc.capability.list_capabilities':
    'List the platform capability tree',
  'toolCall.name.document.retrieve_documents': 'Search documents',
  'toolCall.desc.document.retrieve_documents':
    'Run one retrieval pass over the document library (RAG)',
  'toolCall.name.skill.list_skills': 'List skills',
  'toolCall.desc.skill.list_skills': 'List the skills available right now',

  // ---- memory: three levels ----
  'toolCall.name.memory.search': 'Search conversation memory',
  'toolCall.desc.memory.search':
    'Search past conversation text (full-text + vector)',
  'toolCall.name.memory_atom.search': 'Search structured memory',
  'toolCall.desc.memory_atom.search':
    'Search the structured facts distilled from past conversations',
  'toolCall.name.memory.scene.get': 'Read scene memory',
  'toolCall.desc.memory.scene.get': 'Read one scene memory in full by name',

  // ---- MCP: the `tdx` market-data service ----
  // Provider + `tools.allow` from the backend's `app/config/mcp.yaml`.
  'toolCall.name.tdx.ensure_tdx_ready': 'Start the market-data service',
  'toolCall.desc.tdx.ensure_tdx_ready':
    'Check and start the local market-data service',
  'toolCall.name.tdx.get_market_info': 'Look up market info',
  'toolCall.desc.tdx.get_market_info': 'Fetch market and index quotes',
  'toolCall.name.tdx.screen_stocks': 'Screen stocks',
  'toolCall.desc.tdx.screen_stocks': 'Screen stocks by conditions',
  'toolCall.name.tdx.screen_combo': 'Combined screening',
  'toolCall.desc.tdx.screen_combo':
    'Screen stocks with several conditions combined',
  'toolCall.name.tdx.run_backtest': 'Run a backtest',
  'toolCall.desc.tdx.run_backtest': 'Run a historical backtest for a strategy',
  'toolCall.name.tdx.get_financial_info': 'Look up financials',
  'toolCall.desc.tdx.get_financial_info':
    'Fetch the financial indicators of a stock',
  'toolCall.name.tdx.get_market_stats': 'Look up market stats',
  'toolCall.desc.tdx.get_market_stats': 'Fetch market statistics',
  'toolCall.name.tdx.check_version': 'Check data version',
  'toolCall.desc.tdx.check_version':
    'Check the version and update time of the local market data',
  'toolCall.name.tdx.list_experts': 'List experts',
  'toolCall.desc.tdx.list_experts': 'List the available experts',
};
