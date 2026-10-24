// src/pages/agent_stress/routes.test.ts
//
// 集成层的两个回归点：
//   1. 路由**平铺**（config/routes.ts 的硬约束：分组节点没 path 会让 umi 启动崩，
//      有 path 又违反 RR6 的绝对路径子路由 invariant）；
//   2. `/agent-stress` 真的被分到「评测」组里 —— 忘了改 menuGroups 的话页面能打开
//      但菜单里找不到（这种"功能在、入口没了"的问题最难被自测发现）。
import { describe, expect, it } from 'vitest';

import routes from '../../../config/routes';
import { groupMenuData } from '../../menuGroups';

interface RouteNode {
  path?: string;
  name?: string;
  component?: string;
  hideInMenu?: boolean;
  routes?: RouteNode[];
}

function flatten(nodes: RouteNode[]): RouteNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.routes ? flatten(node.routes) : []),
  ]);
}

const all = flatten(routes as RouteNode[]);

describe('agent-stress 路由', () => {
  it('列表页是可见的顶层路由', () => {
    const route = all.find((r) => r.path === '/agent-stress');
    expect(route).toBeTruthy();
    expect(route?.component).toBe('./agent_stress');
    expect(route?.name).toBe('agent-stress');
    expect(route?.hideInMenu).toBeFalsy();
  });

  it('详情页 hideInMenu，且所有路由都有 path', () => {
    const detail = all.find((r) => r.path === '/agent-stress/:runId');
    expect(detail?.component).toBe('./agent_stress/detail');
    expect(detail?.hideInMenu).toBe(true);

    // 任何一个没 path 的分组节点都会让 preset-umi 的 exportStatic 直接崩
    for (const route of all) {
      expect(route.path, `路由 ${route.name ?? '?'} 缺少 path`).toBeTruthy();
    }
  });
});

describe('菜单分组', () => {
  it('agent-stress 与检索评测同属「评测」组', () => {
    const grouped = groupMenuData([
      { path: '/unknown-page', name: 'unknown' },
      { path: '/retrieval-eval/bundles', name: 'retrieval-eval' },
      { path: '/retrieval-eval/runs', name: 'retrieval-eval-runs' },
      { path: '/agent-stress', name: 'agent-stress' },
      // hideInMenu 的详情页不该被前缀匹配认领进分组
      {
        path: '/agent-stress/:runId',
        name: 'agent-stress-detail',
        hideInMenu: true,
      },
    ]);

    const evaluation = grouped.find(
      (item) => item.locale === 'menu.evaluation',
    );
    expect(evaluation).toBeTruthy();
    const paths = (evaluation?.children ?? []).map((child) => child.path);
    expect(paths).toContain('/agent-stress');
    expect(paths).toContain('/retrieval-eval/bundles');
    expect(paths).not.toContain('/agent-stress/:runId');

    // 没被任何分组认领的项原样保留（新页面忘配分组也不会从菜单里消失）
    expect(grouped.some((item) => item.path === '/unknown-page')).toBe(true);
  });
});
