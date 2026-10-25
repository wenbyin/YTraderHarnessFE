// src/locales/en-US/tool.ts
//
// 与 zh-CN/tool.ts 同一套 key（末段 = 契约原值，未命中自动回落到原值），
// 详见那份文件顶部的说明 —— source_type 是开放字符串，翻译不可能穷举。
export default {
  'tool.source_type.local_method': 'Local method',
  'tool.source_type.mcp': 'MCP tool',
  'tool.source_type.openapi': 'OpenAPI',

  'tool.source_state.ACTIVE': 'Active',
  'tool.source_state.MISSING': 'Missing',

  'tool.enabled.true': 'Online',
  'tool.enabled.false': 'Offline',

  'tool.hook.BEFORE': 'Before',
  'tool.hook.AFTER': 'After',
  'tool.hook.AROUND': 'Around',

  'tool.execution_mode.SYNC': 'Sync',
  'tool.execution_mode.ASYNC': 'Async',

  'tool.processor_type.INTERCEPTOR': 'Interceptor',
  'tool.processor_type.TRANSFORMER': 'Transformer',
  'tool.processor_type.OBSERVER': 'Observer',
};
