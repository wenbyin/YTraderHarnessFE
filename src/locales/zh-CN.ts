import menu from './zh-CN/menu';
import network from './zh-CN/network';
import pages from './zh-CN/pages';
import tool from './zh-CN/tool';
import toolCall from './zh-CN/toolCall';

export default {
  // umi 内置 SelectLang 的菜单标题
  'navBar.lang': '语言',
  ...pages,
  ...menu,
  ...network,
  // 工具定义页的枚举展示名（source_type / hook / execution_mode …）。
  // ⚠️ 这个文件此前**没被注册**：`useEnumLabels` 的 formatMessage 每一条都
  //    落到 defaultMessage（= 契约原值），等于"翻译写了、界面还是原值"。
  //    注册进来才真的生效。
  ...tool,
  // 聊天里「工具调用」那一行：工具名 + 四态措辞（见 toolCall.ts）。
  ...toolCall,
};
