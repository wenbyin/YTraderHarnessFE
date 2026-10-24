import menu from './en-US/menu';
import network from './en-US/network';
import pages from './en-US/pages';
import tool from './en-US/tool';
import toolCall from './en-US/toolCall';

export default {
  // umi 内置 SelectLang 的菜单标题
  'navBar.lang': 'Languages',
  ...pages,
  ...menu,
  ...network,
  // Tool-definition page enums (source_type / hook / execution_mode …).
  // ⚠️ Was never registered before, so every lookup fell through to the raw
  //    contract value. Registered here so the translations actually apply.
  ...tool,
  // The "tool call" row in chat: tool names + the four state prefixes.
  ...toolCall,
};
