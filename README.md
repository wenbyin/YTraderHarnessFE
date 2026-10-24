# YTraderHarnessFE

Frontend console for YTrader Harness — one UI for documents, retrieval, evaluation, memory, tools and tasks.

Language: **English** | [简体中文](./README.zh-CN.md)

## Stack

| Layer | Choice |
| --- | --- |
| Framework | React 19 · Umi Max v4 |
| UI | antd v6 · ProComponents v3 · Ant Design X |
| Styling | antd-style (`createStyles`) · Tailwind CSS v4 |
| Graph | `@xyflow/react` |
| Data | `request` (`@umijs/max`) · `@tanstack/react-query` |
| Quality | Vitest · Biome · `@ant-design/cli` (`antd lint`) |

## Quick start

```bash
# Node >= 22
npm ci

# Dev server (no umi mock; /api is proxied to the backend on :8080)
npm run dev
```

Open http://localhost:8000 .

The backend URL lives in `config/proxy.ts` (default `http://localhost:8080`). Every endpoint is
authenticated: login goes through Casdoor OAuth (`/user/login` → Casdoor → `/user/callback`),
there is no local account system.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (`MOCK=none`) |
| `npm start` | Dev server (with umi mock) |
| `npm run build` | Production build (utoopack) |
| `npm run preview` | Preview the build on :8000 |
| `npm run test` | Vitest (full suite) |
| `npm run tsc` | Type-check only |
| `npm run biome` | Biome check + autofix |
| `npm run lint` | Biome + `tsc`（提交前必过） |

## Layout

```
config/            routes, layout, proxy, build config
src/pages/         one directory per module (index.tsx / service.ts / data.d.ts / style.ts)
  document/                    documents, versions, chunk projections
  document_type_definition/    document types + RAG pipeline builder (React Flow)
  document_retrieve/           interactive recall debugging
  retrieval_eval/              QA bundle building and retrieval evaluation
  memory_retrieval/            layered memory retrieval
  tool/                        tools, taxonomy, processor chains
  skill/                       skill definitions
  task/                        tasks and timeline
  agent_stress/                stress-run orchestration and metrics
  file/                        uploads and file detail
  user/                        login and OAuth callback
src/components/    shared components (CopilotDock, SchemaForm, OfflineBanner…)
src/services/      auth and generated services
src/locales/       zh-CN / en-US
```

## Must pass before committing

```bash
npx biome check src     # or npm run biome
npx tsc --noEmit
npx antd lint ./src
npm run test
```

## Conventions

- Keep page-local code together: `index.tsx` / `service.ts` / `data.d.ts` / `style.ts`.
  Fake data belongs in **`mockData.ts`** — never `_mock.ts`, which umi loads as an Express mock handler.
- Biome only — no ESLint, no Prettier.
- Run `npx antd info <Component>` before writing antd code; don't guess APIs.
- Conventional Commits (commitlint is wired up).

## License

MIT
