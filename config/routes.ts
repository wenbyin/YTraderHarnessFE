/**
 * @name umi 的路由配置
 * @description 只支持 path,component,routes,redirect,wrappers,name,icon 的配置
 * @param path  path 只支持两种占位符配置，第一种是动态参数 :id 的形式，第二种是 * 通配符，通配符只能出现路由字符串的最后。
 * @param component 配置 location 和 path 匹配后用于渲染的 React 组件路径。可以是绝对路径，也可以是相对路径，如果是相对路径，会从 src/pages 开始找起。
 * @param routes 配置子路由，通常在需要为多个路径增加 layout 组件时使用。
 * @param redirect 配置路由跳转
 * @param wrappers 配置路由组件的包装组件，通过包装组件可以为当前的路由组件组合进更多的功能。 比如，可以用于路由级别的权限校验
 * @param name 配置路由的标题，默认读取国际化文件 menu.ts 中 menu.xxxx 的值，如配置 name 为 login，则读取 menu.ts 中 menu.login 的取值作为标题
 * @param icon 配置路由的图标，取值参考 https://ant.design/components/icon-cn， 注意去除风格后缀和大小写，如想要配置图标为 <StepBackwardOutlined /> 则取值应为 stepBackward 或 StepBackward
 * @doc https://umijs.org/docs/guides/routes
 *
 * ⚠️ 菜单的二级折叠**不是在这里做的**，见 src/app.tsx 的 menuDataRender。这里刻意保持
 * 路由平铺（每个页面一条顶层路由，都带 path），原因有两个：
 *
 *   1. **umi 要求每条路由都有 path。** preset-umi 的 exportStatic 在 onGenerateFiles
 *      里无条件遍历路由并调用 `route.path.includes(...)`，分组节点一旦没有 path 就是
 *      `undefined.includes` → 启动直接崩（TypeError: Cannot read properties of
 *      undefined）。这个 hook 不看 exportStatic 开关，躲不掉。
 *   2. **react-router 6 不允许「不共享前缀的绝对路径子路由」。** 我们的页面 URL 是平铺的
 *      （/documents、/document-type-definitions、/document-retrieve 互不为前缀），
 *      给分组写上 path 之后子项就违反 RR 6 的 invariant，运行时白屏。
 *
 * 两条夹逼下来：路由必须平铺，菜单分组只能在运行时用 menuDataRender 拼。
 * 详情页（:typeId / :documentId）标 hideInMenu —— 它们从列表页点进去，不该在菜单里占位置。
 */
export default [
  {
    path: '/user',
    layout: false,
    routes: [
      {
        path: '/user/login',
        name: 'login',
        component: './user/login',
      },
      {
        // Casdoor 授权后的落点，地址上带 ?code=&state=。
        //
        // ⚠️ 它必须是一个**前端路由**：Casdoor 是用浏览器顶层导航（GET）把人
        //    送回来的，而后端的 /api/v1/auth/callback 只有 POST ——
        //    把 redirect_uri 指到后端会直接 405（实测，见 pages/user/callback）。
        //    后端的环境变量 CASDOOR_REDIRECT_URI 要指到这里，Casdoor 控制台的
        //    Redirect URLs 也要登记同一个地址。
        //
        // name 只是为了有个标题（菜单里看不到它：整个 /user 组是 layout:false）。
        path: '/user/callback',
        name: 'callback',
        component: './user/callback',
      },
      {
        path: '/user',
        redirect: '/user/login',
      },
      {
        name: '404',
        component: './exception/404',
        path: '/user/*',
      },
    ],
  },
  {
    path: '/files',
    name: 'files',
    icon: 'folder',
    component: './file',
  },
  {
    path: '/document-type-definitions',
    name: 'document-type-definitions',
    icon: 'file-text',
    component: './document_type_definition',
  },
  {
    path: '/document-type-definitions/:typeId',
    name: 'document-type-definition-detail',
    component: './document_type_definition/detail',
    hideInMenu: true,
  },
  {
    path: '/documents',
    name: 'documents',
    icon: 'file-done',
    component: './document',
  },
  {
    path: '/documents/:documentId',
    name: 'document-detail',
    component: './document/detail',
    hideInMenu: true,
  },
  {
    path: '/document-retrieve',
    name: 'document-retrieve',
    icon: 'search',
    component: './document_retrieve',
  },
  {
    path: '/tools',
    name: 'tools',
    icon: 'tool',
    component: './tool',
  },
  {
    // 技能 = 子 agent 的定义（契约见 YTraderHarness/design_skills/openapi.yaml）。
    //
    // 和 /tools 是两个东西，别混：
    //   · 工具定义 是"某个 tool 长什么样、怎么调"
    //   · 技能     是"子 agent 是谁、读什么提示词、能看见哪些工具"
    // 技能通过 capability 绑定间接指向工具，绑定本身不是授权。
    //
    // 页面是卡片式（一次取满 + 前端筛选），没有详情路由 —— 详情走抽屉。
    path: '/skills',
    name: 'skills',
    icon: 'robot',
    component: './skill',
  },
  {
    // 异步任务：看（列表 / 详情）、追（执行链）、干预（取消 / 重试）。
    // ⚠️ 没有"提交任务"这条路 —— 后端刻意不提供 POST /tasks
    //    （理由见 src/pages/task/service.ts 的头注释）。
    path: '/tasks',
    name: 'tasks',
    icon: 'history',
    component: './task',
  },
  {
    path: '/tasks/:taskId',
    name: 'task-detail',
    component: './task/detail',
    hideInMenu: true,
  },
  {
    // 记忆检索 / 评测 —— 平铺路由，分组在 menuGroups.tsx 里拼。
    path: '/memory-retrieval',
    name: 'memory-retrieval',
    icon: 'bulb',
    component: './memory_retrieval',
  },
  {
    // 检索评测：从 DTD 抽样 chunk 逆向生成 QA → 冻结 bundle → 跑确定性召回测试。
    // 五条路都是平铺的绝对路径，理由见文件头注释。
    //
    // ⚠️ 两个菜单项的路径**不能互为前缀**，所以是 `/bundles` + `/runs`，
    //    而不是 `/retrieval-eval` + `/retrieval-eval/runs`。
    //    原因：ProLayout 用 @umijs/route-utils 的 getMatchMenu 算高亮，它对每条菜单
    //    路径做「精确 或 前缀 或 前缀/(.*)」三种匹配 —— 一旦一条菜单路径是另一条的
    //    前缀，进到子页时**两条会同时高亮**（实测 `/retrieval-eval/runs` 同时选中
    //    `["/retrieval-eval","/retrieval-eval/runs"]`）。把父路径 `/retrieval-eval`
    //    降级成只做重定向、不上菜单，两条高亮就互斥了。
    //
    //   /retrieval-eval                  → 重定向到 /retrieval-eval/bundles（hideInMenu）
    //   /retrieval-eval/bundles          Bundle 列表（菜单项「检索评测」）
    //   /retrieval-eval/runs             跑测列表（菜单项「召回跑测」）
    //   /retrieval-eval/bundles/:bundleId   Bundle 详情（hideInMenu）
    //   /retrieval-eval/runs/:evalRunId     跑测分析（hideInMenu）
    //
    // 静态段优先于动态段：`/retrieval-eval/runs` 与 `/retrieval-eval/bundles/:bundleId`
    // 不会互相抢（RR6 给静态段更高权重；已用 matchRoutes 实测确认）。
    //
    // ⚠️ 顺序 = 菜单顺序（menuData 保序），别随手挪。
    path: '/retrieval-eval',
    // 无 name / 无 component 的重定向路由不会进菜单（同文件末尾的 `/` → `/files` 同理）
    hideInMenu: true,
    redirect: '/retrieval-eval/bundles',
  },
  {
    path: '/retrieval-eval/bundles',
    name: 'retrieval-eval',
    icon: 'experiment',
    component: './retrieval_eval',
  },
  {
    path: '/retrieval-eval/runs',
    name: 'retrieval-eval-runs',
    icon: 'lineChart',
    component: './retrieval_eval/runs',
  },
  {
    path: '/retrieval-eval/bundles/:bundleId',
    name: 'retrieval-eval-bundle-detail',
    component: './retrieval_eval/detail',
    hideInMenu: true,
  },
  {
    path: '/retrieval-eval/runs/:evalRunId',
    name: 'retrieval-eval-run-detail',
    component: './retrieval_eval/runs/detail',
    hideInMenu: true,
  },
  {
    // Agent 压测：用可控的模型替身（mock_model）打 Agent 全链路，
    // 契约见 YTraderHarness/design_agent_eval/openapi.yaml。
    //
    // 列表 + 详情都是平铺绝对路径；详情 hideInMenu，只从列表点进去。
    // 菜单分组挂在 menuGroups.tsx 的「评测」里（和检索评测同组）。
    path: '/agent-stress',
    name: 'agent-stress',
    icon: 'thunderbolt',
    component: './agent_stress',
  },
  {
    path: '/agent-stress/:runId',
    name: 'agent-stress-detail',
    component: './agent_stress/detail',
    hideInMenu: true,
  },
  {
    path: '/',
    redirect: '/files',
  },
  {
    component: './exception/404',
    path: '/*',
  },
];
