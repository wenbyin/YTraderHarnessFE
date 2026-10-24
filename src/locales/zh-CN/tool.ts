// src/locales/zh-CN/tool.ts
//
// 工具定义页的枚举展示名。
//
// key 的最后一段**一律用契约原值**（`tool.<域>.<原值>`），这是为了让"没翻译的取值"
// 自动落到 defaultMessage —— 也就是原值本身。原因：
//
//   - **source_type 是开放字符串**。tool.yaml 里它是裸 string，
//     注释写的是 "local_method / mcp / openapi / ..."，那个省略号是认真的 ——
//     以后新增一种来源（比如 grpc）不可能提前在这儿等着，漏了也不能显示成 undefined。
//   - 其余几个（source_state / hook / execution_mode / processor_type）虽然是有限集，
//     但后端随时可能加值，同样要能优雅退化。
//
// 展示时统一保留**原值可见**（tag 的 title / 表里的说明），因为对接口时要按原值说话，
// 中文只是给人扫读用的。
export default {
  // ---- source_type（开放字符串，未命中的直接显示原值）----
  'tool.source_type.local_method': '本地方法',
  'tool.source_type.mcp': 'MCP 工具',
  'tool.source_type.openapi': 'OpenAPI',

  // ---- source_state ----
  'tool.source_state.ACTIVE': '生效中',
  'tool.source_state.MISSING': '已缺失',

  // ---- hook ----
  'tool.hook.BEFORE': '前置',
  'tool.hook.AFTER': '后置',
  'tool.hook.AROUND': '包围',

  // ---- execution_mode ----
  'tool.execution_mode.SYNC': '同步',
  'tool.execution_mode.ASYNC': '异步',

  // ---- processor_type ----
  'tool.processor_type.INTERCEPTOR': '拦截器',
  'tool.processor_type.TRANSFORMER': '变形器',
  'tool.processor_type.OBSERVER': '观察器',
};
