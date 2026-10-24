# YTraderHarnessFE

YTrader Harness 的前端控制台 —— 文档 / 检索 / 评测 / 记忆 / Tool / 任务 的统一操作界面。

Language : [English](./README.md) | **简体中文**

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | React 19 · Umi Max v4 |
| 组件 | antd v6 · ProComponents v3 · Ant Design X |
| 样式 | antd-style（`createStyles`）· Tailwind CSS v4 |
| 图 / 画布 | `@xyflow/react` |
| 数据 | `request`（`@umijs/max`）· `@tanstack/react-query` |
| 质量 | Vitest · Biome · `@ant-design/cli`（`antd lint`） |

## 快速开始

```bash
# Node ≥ 22
npm ci

# 开发（不走 umi mock，/api 经 proxy 转发到后端 :8080）
npm run dev
```

打开 http://localhost:8000 。

后端地址在 `config/proxy.ts` 里配置，默认 `http://localhost:8080`。所有接口都要鉴权：
登录走 Casdoor OAuth（`/user/login` → Casdoor → `/user/callback` 换 token），没有本地账号体系。

## 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器（`MOCK=none`） |
| `npm start` | 开发服务器（带 umi mock） |
| `npm run build` | 生产构建（utoopack） |
| `npm run preview` | 预览构建产物（:8000） |
| `npm run test` | Vitest 全量 |
| `npm run tsc` | 仅类型检查 |
| `npm run biome` | Biome 检查并自动修复 |
| `npm run lint` | Biome + `tsc`（提交前必过） |

## 目录

```
config/            路由、布局、代理、构建配置
src/pages/         一个业务模块一个目录（index.tsx / service.ts / data.d.ts / style.ts）
  document/                    文档与版本、chunk 投影
  document_type_definition/    文档类型定义 + RAG 流水线编排（React Flow）
  document_retrieve/           在线召回调试
  retrieval_eval/              QA 集构建与检索评测（bundle / run / 分析）
  memory_retrieval/            分层记忆检索
  tool/                        Tool / 分类法 / 处理器链
  skill/                       技能定义
  task/                        任务与时间线
  agent_stress/                压测编排与指标
  file/                        文件上传与详情
  user/                        登录与回调
src/components/    跨页面组件（CopilotDock、SchemaForm、OfflineBanner…）
src/services/      鉴权与生成式服务
src/locales/       zh-CN / en-US
```

## 提交前必须通过

```bash
npx biome check src     # 或 npm run biome
npx tsc --noEmit
npx antd lint ./src
npm run test
```

## 约定

- 每页同目录放 `index.tsx` / `service.ts` / `data.d.ts` / `style.ts`；假数据放 **`mockData.ts`**，
  **不要叫 `_mock.ts`** —— 那个名字会被 umi 当成 Express mock handler 加载。
- 只用 Biome，不引入 ESLint / Prettier。
- 写 antd 代码前先 `npx antd info <Component>`，不要凭记忆猜 API。
- 提交信息遵循 Conventional Commits（commitlint 已配置）。

## License

MIT
