// src/menuGroups.tsx
//
// 侧边菜单的二级分组。
//
// 为什么分组在这做、而不是写在 config/routes.ts 的嵌套 routes 里：
//   umi 的 exportStatic 在 onGenerateFiles 里无条件遍历路由做 `route.path.includes(...)`，
//   分组节点不写 path 就是 undefined.includes → 启动崩；写了 path 又会让平铺的页面 URL
//   违反 react-router 6「绝对路径子路由必须以父路径开头」的 invariant。两条路都堵死，
//   所以路由保持平铺，分组在运行时用 ProLayout 的 menuDataRender 拼。
//   （详见 config/routes.ts 头部注释。）
//
// 这里只放**配置 + 一个纯函数**，不碰 React、不碰 window —— 可以直接在 node 里跑断言。
import {
  BulbOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FolderOutlined,
  HistoryOutlined,
  RobotOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { MenuDataItem } from '@ant-design/pro-components';
import React from 'react';

export interface MenuGroupConfig {
  /** 分组标题的 i18n key，对应各语言包 menu.ts 里的 menu.xxx（如 menu.file） */
  localeId: string;
  /** i18n 没配时的兜底文案（也是 formatMessage 的 defaultMessage） */
  fallback: string;
  icon?: React.ReactNode;
  /** 属于这个分组的页面路径。精确匹配，或「前缀 + /」匹配（详情页跟着父页走） */
  paths: string[];
}

export const MENU_GROUPS: MenuGroupConfig[] = [
  {
    localeId: 'menu.file',
    fallback: '文件管理',
    icon: <FolderOutlined />,
    paths: ['/files'],
  },
  {
    localeId: 'menu.document',
    fallback: '文档管理',
    icon: <DatabaseOutlined />,
    paths: ['/document-type-definitions', '/documents', '/document-retrieve'],
  },
  {
    localeId: 'menu.tool',
    fallback: '工具',
    icon: <ToolOutlined />,
    paths: ['/tools'],
  },
  {
    // 技能和工具不是一层的东西：工具是"能调什么"，技能是"谁来调、按什么提示词调"。
    // 单独一组，免得以后有人在工具组里找"子 agent 的提示词"。
    localeId: 'menu.agent',
    fallback: '智能体',
    icon: <RobotOutlined />,
    paths: ['/skills'],
  },
  {
    // 异步任务是观测/运维面（看状态、追执行链、取消或重跑），跟"工具定义"是
    // 两件事 —— 工具组放的是工具自身的配置，任务组放的是任务实例的运行时状态。
    localeId: 'menu.task',
    fallback: '异步任务',
    icon: <HistoryOutlined />,
    paths: ['/tasks'],
  },
  {
    // 记忆是"取谁的"这一类的运维台（管理员视图）：和文档/文件那种"资源管理"
    // 不是一回事 —— 它管理的是**数据本身**（画像、情境、事实、对话原文），
    // 而且全部要求 Y-Trader-Admin 角色。
    localeId: 'menu.memory',
    fallback: '记忆',
    icon: <BulbOutlined />,
    paths: ['/memory-retrieval'],
  },
  {
    // 评测 = 两件事：
    //   · 检索评测（离线建 QA 数据集 + 跑确定性召回测试）
    //   · Agent 压测（模型替身压全链路，看吞吐 / 时延 / 扇出）
    // 都只写**前缀**：组内露出的是功能页；带 id 的详情页是 hideInMenu，
    // 由 groupMenuData 先过滤掉、只从列表点进去。
    //
    // ⚠️ 组内两条菜单路径**不能互为前缀**（/retrieval-eval 与 /agent-stress
    //    互不前缀，安全）—— ProLayout 的高亮匹配是前缀式的，互为前缀的两条
    //    会同时高亮。详见 config/routes.ts 的注释。
    localeId: 'menu.evaluation',
    fallback: '评测',
    icon: <ExperimentOutlined />,
    paths: ['/retrieval-eval', '/agent-stress'],
  },
];

/** 某个菜单项归不归这个分组。空路径（比如纯分组节点）一律不归。 */
export function belongsToGroup(
  path: string | undefined,
  group: MenuGroupConfig,
): boolean {
  if (!path) return false;
  return group.paths.some(
    (base) => path === base || path.startsWith(`${base}/`),
  );
}

/**
 * 把平铺的菜单数据按配置重新分组。
 *
 * 两条刻意的行为：
 *   - **空分组不显示**：配了分组但一个页面都没匹配上时不留空壳；
 *   - **没被认领的项原样保留**：以后新加页面忘了配分组，也不会从菜单里凭空消失。
 */
export function groupMenuData(
  items: MenuDataItem[],
  groups: MenuGroupConfig[] = MENU_GROUPS,
): MenuDataItem[] {
  // hideInMenu 的项（如 /documents/:documentId 详情页）先扔掉。
  // ProLayout 自己也会过滤，但那是在 menuDataRender **之后** —— 不先扔的话它们会被
  // 前缀匹配认领进分组里，白占一个子项位置。
  const visible = items.filter((item) => !item.hideInMenu);

  const claimed = new Set<string>();
  const grouped: MenuDataItem[] = [];

  for (const group of groups) {
    const children = visible.filter((item) => belongsToGroup(item.path, group));
    if (children.length === 0) continue;
    for (const child of children) {
      if (child.path) claimed.add(child.path);
    }
    grouped.push({
      key: `menu-group-${group.localeId}`,
      name: group.fallback,
      locale: group.localeId,
      icon: group.icon,
      children,
    });
  }

  const rest = visible.filter((item) => !item.path || !claimed.has(item.path));
  return [...grouped, ...rest];
}
