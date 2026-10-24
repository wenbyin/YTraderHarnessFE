// src/pages/retrieval_eval/mockData.ts
// 检索评测的本地假数据层。
// 按 retrieval_eval_openapi.yaml 的响应结构造数，并把 demo 想演示的关键语义都埋进去：
//   1. 一题多 gold（逆向提问时别的 chunk 也含正确答案）；
//   2. gold 在某个阶段被 score_threshold 丢弃（trace 要能解释清）；
//   3. 并行召回分支：dense 没召回、keyword 召回了 → 不算最终 miss；
//   4. M 个问题 / L 个窗口 的切分与 partial_failed 窗口重试。
//
// ⚠️ 开关按**后端实现进度**分两半，不是一个总开关
// -------------------------------------------------
// 后端的评测接口是分两批实现的（见 app/api/v1/retrieval_eval.py）：
//
//   数据集侧  bundles / generation-runs    已实现 → 走真实接口
//   执行侧    runs / stage-stats / trace   **已实现** → 走真实接口
//
// 两侧现在都接真接口了，`USE_MOCK_*` 保留着是为了独立预览 demo —— 它没有后端，
// 必须能一键切回假数据。项目内两个开关都是 false，页面不会碰到 mock。
//
//   USE_MOCK_BUNDLES = false   数据集侧：真接口（依赖 :8080/:8000 后端在跑）
//   USE_MOCK_RUNS    = false   执行侧：真接口（后端 2026-10-15 补齐）
//
// 独立预览（retrieval-eval-demo/ 的单文件 demo）**没有后端**，所以在它的入口
// （src/demo-entry.tsx）调一次 `enableDemoMocks()` 把两个开关都打开。
// 用 `let` + 函数而不是构建期常量：service.ts 是在**调用时**读这两个绑定的
// （ESM live binding），所以入口里先打开、再渲染，就一定能生效；项目内不调用，
// 行为与写死 false/false 完全一致。

/** 数据集侧（bundles / generation-runs / cases / export）是否走假数据。 */
export let USE_MOCK_BUNDLES = false;

/**
 * 执行侧（runs / stage-stats / case trace / run cases）是否走假数据。
 *
 * 下面那些 `mock.*EvalRun*` 函数因此在本项目里**不可达** —— 留着是为了让
 * demo 那份副本仍然成立，而不是给页面用的兜底。真正的数据源是
 * `app/api/v1/retrieval_eval.py` 上的 5 个执行侧端点。
 *
 * ⚠️ 必须是 `let`：`enableDemoMocks()` 要能把它打开。曾经写成 `const false`
 * 且 enableDemoMocks 只翻 bundles —— 于是离线 demo 的**跑测页全部落到
 * "拉不到详情"**（没后端就请求失败），而它自己的注释还写着「两个开关全开」。
 * 注释与代码不一致时，信代码：这里就是那个不一致。
 */
export let USE_MOCK_RUNS = false;

/**
 * 把两个开关全部打开 —— **只有独立预览 demo 该调它**。
 *
 * 放在这里而不是各自写死，是为了让「项目里走真接口 / demo 里走假数据」
 * 共用同一份源码（README 承诺过），不必维护第二份 mock 开关。
 */
export function enableDemoMocks(): void {
  USE_MOCK_BUNDLES = true;
  USE_MOCK_RUNS = true;
}

import {
  attemptsFromSnapshot,
  defaultRounds,
  type RewriteKind,
  rewriteKindOf,
  roundsToAttempts,
} from './attemptLadder';
import type {
  CreateEvalBundleAcceptedResponse,
  CreateEvalBundleRequest,
  CreateEvalRunAcceptedResponse,
  CreateEvalRunRequest,
  DocumentChunkText,
  DtdOption,
  EvalAttemptSpec,
  EvalBundleDetail,
  EvalBundleExport,
  EvalBundleListResponse,
  EvalCase,
  EvalCaseListResponse,
  EvalCaseTraceResponse,
  EvalRunCase,
  EvalRunCaseListResponse,
  EvalRunDetail,
  GenerationRetryAcceptedResponse,
  GenerationRunDetail,
  ListBundleCasesParams,
  ListBundlesParams,
  ListRunCasesParams,
  StageStatsResponse,
} from './data';

// ------------------------------------------------------------
// 通用工具
// ------------------------------------------------------------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 稳定伪随机：同一 seed + 同一序号必得同一结果，呼应 bundle 的可复现语义。 */
function seeded(seed: number, i: number): number {
  const x = Math.sin(seed * 9301 + i * 49297) * 233280;
  return x - Math.floor(x);
}

const HEX = '0123456789abcdef';
function uuidLike(seedNum: number): string {
  let s = '';
  for (let i = 0; i < 32; i += 1) {
    s += HEX[Math.floor(seeded(seedNum, i) * 16)];
    if (i === 7 || i === 11 || i === 15 || i === 19) s += '-';
  }
  return s;
}

function sha256Like(seedNum: number): string {
  let s = '';
  for (let i = 0; i < 64; i += 1)
    s += HEX[Math.floor(seeded(seedNum + 99, i) * 16)];
  return s;
}

// ------------------------------------------------------------
// DTD 选项（假数据版）
// ------------------------------------------------------------

/**
 * 演示用的 DTD 列表。
 *
 * ⚠️ 真实模式下 `listDtdOptions()` 走 `/api/v1/document-type-definitions`，
 * 返回的 id 与这里无关；这份表只剩两个用途：mock 模式的选择器、以及
 * `dtdLabel()` 在真实数据到位前的兜底查询表。
 *
 * `chunk_count` 只有这里有 —— 真实 DTD 列表项没有这个字段。
 */
export const DTD_OPTIONS: DtdOption[] = [
  {
    document_type_definition_id: '1d2b1f04-f4d1-4587-8a0f-5fc1c7c51e15',
    type_key: 'company_announcement',
    name: '公司公告',
    modality_type: 'text',
    chunk_count: 4820,
  },
  {
    document_type_definition_id: 'a3bcde91-7b0f-4c83-b921-e6e4c7ab9e12',
    type_key: 'research_report',
    name: '券商研究报告',
    modality_type: 'text',
    chunk_count: 3157,
  },
  {
    document_type_definition_id: 'b7e1c2aa-90d4-4f16-8c2e-1a7f5d3b6e08',
    type_key: 'financial_statement',
    name: '财务报表',
    modality_type: 'text',
    chunk_count: 2064,
  },
  {
    document_type_definition_id: 'c4f8d3bb-a1e5-4a27-9d3f-2b8e6c4a5f19',
    type_key: 'regulatory_policy',
    name: '监管政策文件',
    modality_type: 'text',
    chunk_count: 1188,
  },
];

// DTD 的 id → 可读标签**不在这里**：真实模式下 id 来自后端，名字要去
// `/api/v1/document-type-definitions` 拉。见 ./dtdOptions.ts 的 dtdLabel()。
// 这里的 DTD_OPTIONS 只作为「演示数据表」被它当兜底查询用。

// ------------------------------------------------------------
// 源 chunk 与 QA 语料（demo 用，真实场景来自 document_chunk 抽样）
// ------------------------------------------------------------

interface MockSourceChunk {
  chunk_id: string;
  document_type_definition_id: string;
  document_version_id: string;
  /** 源 chunk 所属 Document（源文档身份三件套之一） */
  document_id: string;
  /** 源文档标题 = 主体名称（本语料里是公司名）；政策类文档没有主体，为 null */
  document_title: string | null;
  /** 源文档业务标识 = 证券代码；政策类文档没有，为 null */
  document_key: string | null;
  /** 源 chunk 正文快照 */
  content: string;
}

/**
 * 一小批「源 chunk + 从中生成的 QA」。
 * text 里刻意包含可直接问的事实，用于演示「答案必须是原文精确子串」。
 *
 * 每个 seed 额外带**源文档身份**（公司名 + 证券代码）：正文里常写「本公司」，
 * 问题里的主体只能从文档级信息取；复核对得上「问题写的主体 = 该 chunk 所属公司」。
 * 政策类文档（regulatory_policy）刻意留 null，用于覆盖"该字段可为空"的边界。
 */
const SOURCE_SEEDS: {
  dtd: string;
  /** 源文档标题（公司名） */
  title: string | null;
  /** 源文档业务标识（证券代码） */
  key: string | null;
  content: string;
  qa: { question: string; answer: string; extraGold?: string[] }[];
}[] = [
  {
    dtd: DTD_OPTIONS[0].document_type_definition_id,
    title: '特锐德',
    key: '300001.SZ',
    content:
      '第八届董事会第十二次会议决议公告：公司于2024年3月18日审议通过《关于回购公司股份的议案》，拟使用自有资金不低于人民币2亿元、不超过人民币4亿元，通过集中竞价方式回购公司股份，回购价格不超过每股28.50元，回购期限为自董事会审议通过之日起12个月内。截至2024年6月30日，公司已累计回购股份1,240万股，占公司总股本的1.03%，已支付资金总额人民币2.87亿元。',
    qa: [
      {
        question: '特锐德本次回购股份的资金总额下限是多少？',
        answer: '不低于人民币2亿元',
      },
      {
        question: '特锐德回购股份的价格上限是多少？',
        answer: '不超过每股28.50元',
      },
      {
        question: '截至2024年6月30日特锐德已累计回购股份数量是多少？',
        answer: '1,240万股',
      },
      {
        question: '本次回购的期限是多久？',
        answer: '自董事会审议通过之日起12个月内',
      },
    ],
  },
  {
    dtd: DTD_OPTIONS[1].document_type_definition_id,
    title: '宁德时代',
    key: '300750.SZ',
    content:
      '行业深度报告指出，2024年国内新能源汽车销量达到949.5万辆，同比增长37.9%，渗透率提升至35.8%。报告认为，插电式混合动力车型增速显著高于纯电动车型，全年插混销量同比增长81.2%。展望2025年，报告预计在购置税优惠政策延续的背景下，新能源乘用车销量有望达到1,180万辆。报告同时提示，若上游碳酸锂价格出现大幅反弹，将对企业盈利形成压力。',
    qa: [
      {
        question: '宁德时代研报中2024年国内新能源汽车销量是多少？',
        answer: '949.5万辆',
      },
      {
        question: '宁德时代研报中2024年新能源汽车的渗透率是多少？',
        answer: '35.8%',
      },
      {
        question: '宁德时代研报预计2025年新能源乘用车销量将达到多少？',
        answer: '1,180万辆',
      },
      {
        question: '报告提示的盈利压力来源是什么？',
        answer: '若上游碳酸锂价格出现大幅反弹',
      },
    ],
  },
  {
    dtd: DTD_OPTIONS[2].document_type_definition_id,
    title: '中国平安',
    key: '601318.SH',
    content:
      // 这块刻意写得比别处长（>220 字符）：真实年报 chunk 本来就是几百字的
      // 表格段落（线上实测一块 476 字符），而「折叠 / 展开全文」这条路径
      // 只有超过阈值才走得到 —— 全是 180 字的小块，演示里永远看不到它。
      '合并资产负债表（单位：人民币元）：截至2024年12月31日，公司资产总计128,640,000,000元，负债合计71,830,000,000元，其中短期借款8,420,000,000元，长期借款15,600,000,000元，应付账款22,150,000,000元；所有者权益合计56,810,000,000元，其中归属于母公司所有者权益54,230,000,000元。合并利润表：2024年度实现营业收入102,440,000,000元，同比增长6.8%；营业成本68,910,000,000元，销售费用9,760,000,000元，管理费用7,320,000,000元；利润总额15,830,000,000元，所得税费用3,140,000,000元，净利润12,690,000,000元，其中归属于母公司股东的净利润11,820,000,000元。合并现金流量表：经营活动产生的现金流量净额18,450,000,000元，投资活动产生的现金流量净额-6,270,000,000元，筹资活动产生的现金流量净额-4,180,000,000元。',
    qa: [
      {
        question: '截至2024年12月31日中国平安的资产总计是多少？',
        answer: '128,640,000,000元',
      },
      {
        question: '中国平安的短期借款金额是多少？',
        answer: '8,420,000,000元',
      },
      {
        question: '中国平安归属于母公司所有者权益是多少？',
        answer: '54,230,000,000元',
      },
    ],
  },
  {
    dtd: DTD_OPTIONS[3].document_type_definition_id,
    // 政策文件不是「某家公司」的文档，天然没有主体与证券代码 —— 刻意留 null
    title: null,
    key: null,
    content:
      '关于规范上市公司信息披露的监管指引：上市公司应当在每个会计年度的上半年结束之日起两个月内披露半年度报告，在每个会计年度结束之日起四个月内披露年度报告。对于季度报告，应当在每个会计年度前三个月、前九个月结束后的一个月内披露，且第一季度报告的披露时间不得早于上一年度年度报告的披露时间。',
    qa: [
      {
        question: '上市公司应当在何时披露半年度报告？',
        answer: '上半年结束之日起两个月内',
      },
      {
        question: '年度报告的披露时限是多久？',
        answer: '每个会计年度结束之日起四个月内',
      },
      {
        question: '第一季度报告的披露有何时间约束？',
        answer: '不得早于上一年度年度报告的披露时间',
      },
    ],
  },
];

/** 展开成完整的 chunk 列表（每个 seed 复制若干份，凑出可观的数量）。 */
function buildSourceChunks(): MockSourceChunk[] {
  const out: MockSourceChunk[] = [];
  let n = 0;
  for (const seed of SOURCE_SEEDS) {
    // 每个种子复制 6 份，chunk 内容相同但 chunk_id 不同
    for (let k = 0; k < 6; k += 1) {
      out.push({
        chunk_id: uuidLike(1000 + n),
        document_type_definition_id: seed.dtd,
        document_version_id: uuidLike(2000 + (n % 4)),
        // 同一 seed 的 6 份 chunk 视为同一篇文档的不同版本快照
        document_id: uuidLike(1500 + SOURCE_SEEDS.indexOf(seed)),
        document_title: seed.title,
        document_key: seed.key,
        content: seed.content,
      });
      n += 1;
    }
  }
  return out;
}

const SOURCE_CHUNKS = buildSourceChunks();

// ------------------------------------------------------------
// Bundle 列表
// ------------------------------------------------------------

interface MockBundle extends EvalBundleDetail {
  generation_run_id: string;
}

const BUNDLES: MockBundle[] = [
  {
    bundle_id: 'd23e3d88-4fe5-4e24-a65a-b53bc4208e4f',
    name: 'company-announcement-retrieval-v1',
    description: '针对公司公告与研报的直接事实型 QA，用于确定性 chunk 召回测试',
    status: 'ready',
    // 刻意覆盖**全部** DTD：真实场景里一条 bundle 覆盖到 8 个 DTD 很常见
    // （截图里那条「公司事件」就是 8 个）。这里只到 4 是因为 mock 只有 4 种
    // DTD 类型 + 与之匹配的语料种子（`buildCases` 按 dtd 过滤 seed，配不上的
    // 只会得到 0 条 case）—— 排版问题的规模在 4 上完全一样：标签竖排会把
    // 行高顶到 4 行，而列表页现在把它折成「1 个 + +3」。
    document_type_definition_ids: DTD_OPTIONS.map(
      (d) => d.document_type_definition_id,
    ),
    source_chunk_count: 24,
    case_count: 84,
    latest_generation_status: 'completed',
    dataset_sha256: sha256Like(5000),
    created_at: '2026-10-14T09:12:30+08:00',
    completed_at: '2026-10-14T09:19:44+08:00',
    updated_at: '2026-10-14T09:19:44+08:00',
    schema_version: '1.0',
    selection_config: {
      sampled_chunk_count: 24,
      sampling_strategy: 'balanced_by_dtd',
      seed: 20261015,
    },
    generation_config: {
      questions_per_chunk: 4,
      chunks_per_window: 5,
      max_input_tokens: 12000,
      // 这份刻意开着跨块裁决：详情页要能演示「由模型评判」那一支
      enable_cross_chunk_judge: true,
      model_role: 'eval.qa_generation',
      model_name: 'qwen2.5-72b-instruct',
    },
    latest_generation_run_id: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f601',
    generation_run_id: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f601',
  },
  {
    bundle_id: 'e8c9a011-2b3d-4e5f-8a70-1c2d3e4f5a6b',
    name: 'financial-statement-v2-partial',
    description: '财务报表专用 QA；第 3 个窗口生成超时，待重试',
    status: 'partial_failed',
    document_type_definition_ids: [DTD_OPTIONS[2].document_type_definition_id],
    source_chunk_count: 18,
    case_count: 47,
    latest_generation_status: 'partial_failed',
    dataset_sha256: null,
    created_at: '2026-10-15T08:40:11+08:00',
    completed_at: null,
    updated_at: '2026-10-15T08:52:03+08:00',
    schema_version: '1.0',
    selection_config: {
      sampled_chunk_count: 18,
      sampling_strategy: 'uniform_all',
      seed: 771,
    },
    generation_config: {
      questions_per_chunk: 3,
      chunks_per_window: 6,
      max_input_tokens: 12000,
      enable_cross_chunk_judge: false,
      model_role: 'eval.qa_generation',
      model_name: 'qwen2.5-72b-instruct',
    },
    latest_generation_run_id: 'a7b8c9d0-e1f2-4a3b-9c8d-7e6f5a4b3c21',
    generation_run_id: 'a7b8c9d0-e1f2-4a3b-9c8d-7e6f5a4b3c21',
  },
  {
    bundle_id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
    name: 'regulatory-policy-full-100',
    description: '监管政策文件全量抽样 100 chunk，5 题/块，正在生成',
    status: 'generating',
    document_type_definition_ids: [DTD_OPTIONS[3].document_type_definition_id],
    source_chunk_count: 100,
    case_count: 0,
    latest_generation_status: 'running',
    dataset_sha256: null,
    created_at: '2026-10-15T11:01:02+08:00',
    completed_at: null,
    updated_at: '2026-10-15T11:01:02+08:00',
    schema_version: '1.0',
    selection_config: {
      sampled_chunk_count: 100,
      sampling_strategy: 'balanced_by_dtd',
      seed: 20261015,
    },
    generation_config: {
      questions_per_chunk: 5,
      chunks_per_window: 5,
      max_input_tokens: 16000,
      enable_cross_chunk_judge: false,
      model_role: 'eval.qa_generation',
    },
    latest_generation_run_id: 'cc11dd22-ee33-4f44-8a55-66bb77cc88dd',
    generation_run_id: 'cc11dd22-ee33-4f44-8a55-66bb77cc88dd',
  },
];

// ------------------------------------------------------------
// Bundle API
// ------------------------------------------------------------

export async function listRetrievalEvalBundles(
  params: ListBundlesParams = {},
): Promise<EvalBundleListResponse> {
  await delay(280);
  const {
    status,
    document_type_definition_id: dtd,
    page = 1,
    page_size = 20,
  } = params;
  let items = [...BUNDLES];
  if (status) items = items.filter((b) => b.status === status);
  if (dtd)
    items = items.filter((b) => b.document_type_definition_ids.includes(dtd));
  const total = items.length;
  const start = (page - 1) * page_size;
  return {
    items: items.slice(start, start + page_size),
    page,
    page_size,
    total,
  };
}

export async function getRetrievalEvalBundle(
  bundleId: string,
): Promise<EvalBundleDetail> {
  await delay(220);
  const found = BUNDLES.find((b) => b.bundle_id === bundleId);
  if (!found) throw { code: 'not_found', message: `bundle ${bundleId} 不存在` };
  return found;
}

export async function createRetrievalEvalBundle(
  body: CreateEvalBundleRequest,
): Promise<CreateEvalBundleAcceptedResponse> {
  await delay(600);
  const id = uuidLike(Date.now() % 100000);
  const runId = uuidLike((Date.now() % 100000) + 7);
  const dtdCount = Math.max(1, body.document_type_definition_ids.length);
  BUNDLES.unshift({
    bundle_id: id,
    name: body.name,
    description: body.description ?? null,
    status: 'generating',
    document_type_definition_ids: body.document_type_definition_ids,
    source_chunk_count: body.sampled_chunk_count,
    case_count: 0,
    latest_generation_status: 'queued',
    dataset_sha256: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    updated_at: new Date().toISOString(),
    schema_version: '1.0',
    selection_config: {
      sampled_chunk_count: body.sampled_chunk_count,
      sampling_strategy: body.sampling_strategy ?? 'balanced_by_dtd',
      seed: body.seed ?? 20261015,
      dtd_count: dtdCount,
    },
    generation_config: {
      questions_per_chunk: body.questions_per_chunk ?? 3,
      chunks_per_window: body.chunks_per_window ?? 5,
      max_input_tokens: body.max_input_tokens ?? 12000,
      // 与后端一致：契约默认 false，且落进快照
      enable_cross_chunk_judge: body.enable_cross_chunk_judge ?? false,
      model_role: 'eval.qa_generation',
      model_name: 'qwen2.5-72b-instruct',
    },
    latest_generation_run_id: runId,
    generation_run_id: runId,
  });
  return {
    bundle_id: id,
    generation_run_id: runId,
    status: 'generating',
    message: '已创建 bundle，QA 生成任务已入队',
  };
}

// ------------------------------------------------------------
// Case 列表（按 bundle 展开 SOURCE_SEEDS）
// ------------------------------------------------------------

/** 为某个 bundle 生成稳定的 QA 用例集合。 */
function buildCases(bundle: MockBundle, caseCount: number): EvalCase[] {
  const out: EvalCase[] = [];
  let order = 0;
  // 按 bundle 选取的 DTD 匹配 seed
  const seeds = SOURCE_SEEDS.filter((s) =>
    bundle.document_type_definition_ids.includes(s.dtd),
  );
  if (seeds.length === 0) return out;
  for (let i = 0; out.length < caseCount; i += 1) {
    const seed = seeds[i % seeds.length];
    const qa = seed.qa[Math.floor(i / seeds.length) % seed.qa.length];
    // 同一 seed 的 chunk 轮换，让 chunk_id 分散
    const chunk = SOURCE_CHUNKS.filter(
      (c) => c.document_type_definition_id === seed.dtd,
    )[i % 6];
    // 演示「一题多 gold」：部分用例额外挂一个别的 chunk 作为可回答的 gold
    const gold = [chunk.chunk_id];
    if (seeded(7000 + i, i) > 0.55) {
      const alt = SOURCE_CHUNKS.filter(
        (c) =>
          c.document_type_definition_id === seed.dtd &&
          c.chunk_id !== chunk.chunk_id,
      )[i % 5];
      if (alt) gold.push(alt.chunk_id);
    }
    // answer_original 在源 chunk 中的精确位置（后端真实返回；这里按 substring 实算）
    const answerStart = chunk.content.indexOf(qa.answer);
    out.push({
      eval_case_id: uuidLike(9000 + out.length),
      document_type_definition_id: seed.dtd,
      document_version_id: chunk.document_version_id,
      document_retrieval_definition_id: null,
      // 源文档身份（复核用：问题里的主体应当就是它）
      document_id: chunk.document_id,
      document_title: chunk.document_title,
      document_key: chunk.document_key,
      chunk_id: chunk.chunk_id,
      gold_chunk_ids: gold,
      question: qa.question,
      answer_original: qa.answer,
      answer_start_offset: answerStart >= 0 ? answerStart : null,
      answer_end_offset:
        answerStart >= 0 ? answerStart + qa.answer.length : null,
      question_order: order % 5,
      validation_status:
        out.length % 17 === 0
          ? 'rejected'
          : out.length % 11 === 0
            ? 'pending'
            : 'validated',
      validation_error:
        out.length % 17 === 0
          ? 'answer_original 未在源 chunk 中找到精确子串'
          : null,
    });
    order += 1;
  }
  return out;
}

const CASE_CACHE = new Map<string, EvalCase[]>();
function casesOf(bundle: MockBundle): EvalCase[] {
  const cached = CASE_CACHE.get(bundle.bundle_id);
  if (cached) return cached;
  const built = buildCases(bundle, bundle.case_count);
  CASE_CACHE.set(bundle.bundle_id, built);
  return built;
}

export async function listRetrievalEvalCases(
  bundleId: string,
  params: ListBundleCasesParams = {},
): Promise<EvalCaseListResponse> {
  await delay(260);
  const bundle = BUNDLES.find((b) => b.bundle_id === bundleId);
  if (!bundle) return { items: [], page: 1, page_size: 50, total: 0 };
  let items = casesOf(bundle);
  const {
    document_type_definition_id: dtd,
    validation_status,
    page = 1,
    page_size = 50,
  } = params;
  if (dtd) items = items.filter((c) => c.document_type_definition_id === dtd);
  if (validation_status)
    items = items.filter((c) => c.validation_status === validation_status);
  const total = items.length;
  const start = (page - 1) * page_size;
  return {
    items: items.slice(start, start + page_size),
    page,
    page_size,
    total,
  };
}

export async function exportRetrievalEvalBundle(
  bundleId: string,
): Promise<EvalBundleExport> {
  await delay(400);
  const bundle = BUNDLES.find((b) => b.bundle_id === bundleId);
  if (!bundle) throw { code: 'not_found', message: 'bundle 不存在' };
  if (bundle.status !== 'ready')
    throw { code: 'conflict', message: 'bundle 尚未就绪，无法导出' };
  // 导出物必须**确定性**（同数据两次导出字节相同），条目顺序有固定口径：
  // 按 (DTD, 源 chunk, 题序)，不依赖数据库返回顺序 —— 与后端 dataset_sha256 口径一致。
  const items = casesOf(bundle)
    .filter((c) => c.validation_status === 'validated')
    .slice()
    .sort(
      (a, b) =>
        a.document_type_definition_id.localeCompare(
          b.document_type_definition_id,
        ) ||
        a.chunk_id.localeCompare(b.chunk_id) ||
        a.question_order - b.question_order,
    )
    .map((c) => ({
      chunk_id: c.chunk_id,
      gold_chunk_ids: c.gold_chunk_ids,
      document_type_definition_id: c.document_type_definition_id,
      document_version_id: c.document_version_id ?? null,
      // 源文档身份随导出物一起走
      document_id: c.document_id ?? null,
      document_title: c.document_title ?? null,
      document_key: c.document_key ?? null,
      question: c.question,
      answer_original: c.answer_original,
    }));
  return {
    schema_version: '1.0',
    bundle_id: bundle.bundle_id,
    bundle_name: bundle.name,
    dataset_sha256: bundle.dataset_sha256 ?? null,
    generation_config: bundle.generation_config,
    document_type_definition_ids: bundle.document_type_definition_ids,
    items,
  };
}

// ------------------------------------------------------------
// Generation run（窗口切分演示）
// ------------------------------------------------------------

export async function getRetrievalEvalGenerationRun(
  generationRunId: string,
): Promise<GenerationRunDetail> {
  await delay(240);
  const bundle =
    BUNDLES.find((b) => b.generation_run_id === generationRunId) ?? BUNDLES[0];
  const L = Number(bundle.generation_config.chunks_per_window ?? 5);
  const totalChunks = bundle.source_chunk_count || 24;
  const totalWindows = Math.ceil(totalChunks / L);
  const windows = Array.from({ length: totalWindows }, (_, i) => {
    const isFailed = bundle.status === 'partial_failed' && i === 2;
    const isDone =
      bundle.status === 'ready' ||
      (bundle.status === 'partial_failed' && i < totalWindows - 1 && i !== 2);
    const size = Math.min(L, totalChunks - i * L);
    return {
      generation_window_id: uuidLike(3000 + i),
      window_index: i,
      status: isFailed ? 'failed' : isDone ? 'completed' : 'running',
      input_chunk_count: size,
      input_token_estimate: 1100 + Math.floor(seeded(400 + i, i) * 1800),
      attempt_count: isFailed ? 2 : 1,
      valid_case_count: isDone
        ? size * Number(bundle.generation_config.questions_per_chunk ?? 3)
        : 0,
      error_code: isFailed ? 'llm_timeout' : null,
      error_message: isFailed
        ? '模型响应超时（>120s），窗口未产出有效用例'
        : null,
    } as GenerationRunDetail['windows'][number];
  });
  const completed = windows.filter((w) => w.status === 'completed').length;
  const failed = windows.filter((w) => w.status === 'failed').length;
  const running = windows.filter((w) => w.status === 'running').length;
  return {
    generation_run_id: generationRunId,
    bundle_id: bundle.bundle_id,
    status:
      running > 0 ? 'running' : failed > 0 ? 'partial_failed' : 'completed',
    model_role: 'eval.qa_generation',
    model_name: String(
      bundle.generation_config.model_name ?? 'qwen2.5-72b-instruct',
    ),
    sample_seed: Number(bundle.selection_config.seed ?? 20261015),
    total_chunks: totalChunks,
    total_windows: totalWindows,
    completed_windows: completed,
    failed_windows: failed,
    generated_cases: windows.reduce((s, w) => s + w.valid_case_count, 0),
    error_message: failed > 0 ? `${failed} 个窗口生成失败，可重试` : null,
    windows,
    started_at: bundle.created_at,
    completed_at: bundle.completed_at,
  };
}

/**
 * 重试未成功的窗口。
 *
 * 没有可重试窗口时**抛一个带 409 语义的错误**（后端就是这个行为），
 * 而不是返回 0 —— 返回 0 会让调用方以为"重试成功了，只是没窗口"。
 * 之所以伪造出 `response` 形状：全局 errorHandler 只在"有响应"那条分支里
 * 读 FastAPI 的 detail，否则它会退化成一句 "Request error, please retry."，
 * 把这句中文解释吞掉。
 */
export async function retryRetrievalEvalGenerationWindows(
  generationRunId: string,
): Promise<GenerationRetryAcceptedResponse> {
  await delay(500);
  const bundle = BUNDLES.find((b) => b.generation_run_id === generationRunId);
  const count = bundle?.status === 'partial_failed' ? 1 : 0;
  if (count === 0) {
    const err = new Error('没有可重试的窗口（幂等：已完成的窗口不会再跑）');
    throw Object.assign(err, {
      response: { status: 409, data: { detail: err.message } },
    });
  }
  return {
    generation_run_id: generationRunId,
    status: 'running',
    retried_window_count: count,
  };
}

// ------------------------------------------------------------
// Runs（跑测 + 指标 + 阶段统计 + trace）
// ------------------------------------------------------------

/**
 * 内置三档阶梯的**契约形态**（`effective_config_snapshot.attempts`）。
 *
 * 它直接复用表单层的 `defaultRounds()` —— 不是偷懒，而是**必须**同源：
 * 详情页的阶梯表从快照读「这一轮的查询改写是什么」，而抽屉的预填也从
 * 同一份常量读。两处各写一份的话，演示数据会显示一套、预填另一套，
 * 而两者都不会报错。
 */
const MOCK_LADDER_ATTEMPTS = roundsToAttempts(defaultRounds());

/** 把中文日期补成 `YYYY-MM-DD`（与 `retrieve/rewrite.py` 的 common 同姿态）。 */
function normCnDate(cn: string): string {
  const m = cn.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return cn;
  const pad = (s: string) => s.padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
}

/** 阶梯（`attempts`）的第 N 轮用的改写档位（快照里没记录 = 不改写）。 */
function kindOfLadder(
  ladder: EvalAttemptSpec[] | undefined | null,
  attemptNo: number,
): RewriteKind {
  return rewriteKindOf(ladder?.[attemptNo - 1]?.query_rewriter);
}

/**
 * 某一轮**实际发给检索**的文本（改写之后）。
 *
 * 为什么 mock 必须造出差异：真后端把 `query_text` 落库，逐题结果与 trace
 * 都靠它回答「这条命中的是哪句话」。mock 若一律回题干，「实际查询」这一列
 * 永远显示「原文」—— 功能看着像没做。
 *
 * 逐轮姿态与真实现对齐（这是**口径**，不是随便加的）：
 *   第 1 轮 common —— 只把日期两种写法都展开；问题里没日期则**原样返回**
 *                     （真实现同样如此，`changed=false`）；
 *   第 2 轮 llm    —— 换个说法再查一次；
 *   第 3 轮 不改     —— 原句。
 */
function queryTextFor(
  question: string,
  attemptNo: number,
  ladder: EvalAttemptSpec[] | undefined | null,
): string {
  const kind = kindOfLadder(ladder, attemptNo);
  if (kind === 'common') {
    const date = question.match(/\d{4}年\d{1,2}月\d{1,2}日/);
    return date ? `${question} ${normCnDate(date[0])}` : question;
  }
  if (kind === 'llm') {
    return `${question}（同一问题的另一种问法）`;
  }
  return question;
}

export interface MockRun extends EvalRunDetail {
  bundle_name: string;
}

const RUNS: MockRun[] = [
  {
    eval_run_id: 'aa112233-bb44-4c55-8d66-77ee8899ff00',
    bundle_id: BUNDLES[0].bundle_id,
    bundle_name: BUNDLES[0].name,
    status: 'completed',
    max_k: 10,
    include_stage_trace: true,
    query_processor_override: {
      fusioner: { enabled: true, type: 'rrf', top_k: 50, rrf_k: 60 },
      filter: { enabled: true, score_threshold: 0.3 },
      reranker: { enabled: true, type: 'cross_encoder', top_n: 50 },
      cutter: { top_k: 10 },
    },
    effective_config_snapshot: {
      // 逐轮的参数 —— 详情页的「查询改写」列与 trace 抽屉的轮次改写标签
      // 都从这里读（指标里只有结果、没有参数）。
      attempts: MOCK_LADDER_ATTEMPTS,
      attempts_source: 'request',
      recall: ['dense_vector', 'keyword'],
      fusioner: 'rrf',
      filter: 'score_threshold=0.3',
      reranker: 'cross_encoder',
      cutter: 'top_k=10',
    },
    total_cases: 84,
    completed_cases: 84,
    failed_cases: 0,
    metrics: {
      total_cases: 84,
      completed_cases: 84,
      failed_cases: 0,
      hit_count: 76,
      miss_count: 8,
      hit_rate_at_1: 0.7262,
      hit_rate_at_5: 0.8571,
      hit_rate_at_k: 0.9048,
      mrr_at_k: 0.7963,
      // 召回率曲线（最终口径）：单条最多取回 50 条，所以 20/50 两个点有效
      hit_rate_curve: {
        '1': 0.5357,
        '5': 0.75,
        '10': 0.9048,
        '20': 0.9048,
        '50': 0.9048,
      },
      retrieved_max: 50,
      // 逐轮：第 N 轮只跑上一轮没命中的（84 → 22 → 14），
      // 各轮 hit_count 互不重叠，累加 62+8+6 = 76 = 顶层 hit_count
      by_attempt: {
        '1': {
          total_cases: 84,
          completed_cases: 84,
          failed_cases: 0,
          cases: 84,
          input_share: 1,
          hit_count: 62,
          miss_count: 22,
          hit_rate_at_1: 0.4524,
          hit_rate_at_5: 0.6429,
          hit_rate_at_k: 0.7381,
          mrr_at_k: 0.6131,
          p50_latency_ms: 214,
          p95_latency_ms: 683,
          max_k: 10,
        },
        '2': {
          total_cases: 22,
          completed_cases: 22,
          failed_cases: 0,
          cases: 22,
          input_share: 0.261905,
          hit_count: 8,
          miss_count: 14,
          hit_rate_at_1: 0.1818,
          hit_rate_at_5: 0.2727,
          hit_rate_at_k: 0.3636,
          mrr_at_k: 0.2424,
          p50_latency_ms: 268,
          p95_latency_ms: 742,
          max_k: 10,
        },
        '3': {
          total_cases: 14,
          completed_cases: 14,
          failed_cases: 0,
          cases: 14,
          input_share: 0.166667,
          hit_count: 6,
          miss_count: 8,
          hit_rate_at_1: 0.2143,
          hit_rate_at_5: 0.3571,
          hit_rate_at_k: 0.4286,
          mrr_at_k: 0.2857,
          p50_latency_ms: 7310,
          p95_latency_ms: 9480,
          max_k: 10,
        },
      },
      p50_latency_ms: 214,
      p95_latency_ms: 683,
      max_k: 10,
    },
    created_at: '2026-10-15T09:30:00+08:00',
    started_at: '2026-10-15T09:30:02+08:00',
    completed_at: '2026-10-15T09:33:41+08:00',
  },
  {
    eval_run_id: 'bb223344-cc55-4d66-8e77-88ff9900aa11',
    bundle_id: BUNDLES[0].bundle_id,
    bundle_name: BUNDLES[0].name,
    status: 'completed',
    max_k: 10,
    include_stage_trace: true,
    query_processor_override: {
      filter: { enabled: false },
      reranker: { enabled: false },
    },
    effective_config_snapshot: {
      // ⚠️ 这份是**旧结果**：单轮跑测、且快照里**没有** attempts
      // （查询改写是 2026-10-16 才加的，这份跑测在那之前）。
      // 刻意保留成"缺字段"的形态 —— 详情页的阶梯表要能显示「未记录」
      // 而不是猜一个，逐题结果那一列也要如实显示「原文」。
      recall: ['dense_vector', 'keyword'],
      fusioner: 'rrf',
      filter: 'disabled',
      reranker: 'disabled',
      cutter: 'top_k=10',
    },
    total_cases: 84,
    completed_cases: 84,
    failed_cases: 0,
    metrics: {
      total_cases: 84,
      completed_cases: 84,
      failed_cases: 0,
      hit_count: 71,
      miss_count: 13,
      hit_rate_at_1: 0.5833,
      hit_rate_at_5: 0.7381,
      hit_rate_at_k: 0.8452,
      mrr_at_k: 0.6804,
      // 单轮跑测：只取回 10 条，所以 20/50 两个点恒为 0 ——
      // 那是「根本没取回来」而不是「召回差」，UI 会灰显成「无意义」
      hit_rate_curve: {
        '1': 0.4881,
        '5': 0.6905,
        '10': 0.8452,
        '20': 0,
        '50': 0,
      },
      retrieved_max: 10,
      // 只跑了一轮，所以只有 by_attempt["1"]
      by_attempt: {
        '1': {
          total_cases: 84,
          completed_cases: 84,
          failed_cases: 0,
          cases: 84,
          input_share: 1,
          hit_count: 71,
          miss_count: 13,
          hit_rate_at_1: 0.5833,
          hit_rate_at_5: 0.7381,
          hit_rate_at_k: 0.8452,
          mrr_at_k: 0.6804,
          p50_latency_ms: 138,
          p95_latency_ms: 402,
          max_k: 10,
        },
      },
      p50_latency_ms: 138,
      p95_latency_ms: 402,
      max_k: 10,
    },
    created_at: '2026-10-15T10:05:00+08:00',
    started_at: '2026-10-15T10:05:02+08:00',
    completed_at: '2026-10-15T10:07:12+08:00',
  },
];

export async function createRetrievalEvalRun(
  body: CreateEvalRunRequest,
): Promise<CreateEvalRunAcceptedResponse> {
  await delay(650);
  const bundle = BUNDLES.find((b) => b.bundle_id === body.bundle_id);
  if (!bundle) throw { code: 'not_found', message: 'bundle 不存在' };
  const id = uuidLike((Date.now() % 100000) + 31);
  const totalCases = bundle.case_count;
  // ⚠️ 真实后端**会**把阶梯原样写进 `effective_config_snapshot.attempts`
  // （`create_eval_run`，且按 `exclude_unset` 存 —— 所以"没发的字段"在快照
  // 里真的不存在）。这里必须照做：详情页的「查询改写」列要从快照读每一轮
  // 的参数，mock 不写的话，从 demo 里发起一次跑测后那一列全是「未记录」，
  // 看起来像功能坏了。
  const ladder = body.attempts?.length
    ? body.attempts
    : roundsToAttempts(defaultRounds());
  const firstRound = ladder[0];
  const roundCount = ladder.length;
  RUNS.unshift({
    eval_run_id: id,
    bundle_id: body.bundle_id,
    bundle_name: bundle.name,
    status: 'queued',
    max_k: body.max_k ?? 10,
    include_stage_trace: body.include_stage_trace ?? true,
    query_processor_override: {},
    effective_config_snapshot: {
      attempts: ladder,
      attempts_source: body.attempts?.length ? 'request' : 'default',
      recall: ['dense_vector', 'keyword'],
      ladder: `${roundCount} 轮`,
      recall_top_k: `每路 ${firstRound?.recall_top_k ?? 200}`,
      query_rewriter: kindOfLadder(ladder, 1),
      fusioner: `top_k=${firstRound?.retrieve_processor?.fusioner?.top_k ?? 50}`,
      filter: firstRound?.retrieve_processor?.filter
        ? `score_threshold=${firstRound.retrieve_processor.filter.score_threshold ?? 0.3}`
        : 'inherit',
      reranker: firstRound?.retrieve_processor?.reranker
        ? (firstRound.retrieve_processor.reranker.type ?? 'cross_encoder')
        : 'inherit',
      cutter: `top_k=${firstRound?.retrieve_processor?.cutter?.top_k ?? 10}`,
    },
    total_cases: totalCases,
    completed_cases: 0,
    failed_cases: 0,
    metrics: {
      total_cases: totalCases,
      completed_cases: 0,
      failed_cases: 0,
      hit_count: 0,
      miss_count: 0,
      hit_rate_at_1: null,
      hit_rate_at_5: null,
      hit_rate_at_k: null,
      mrr_at_k: null,
      hit_rate_curve: {},
      retrieved_max: null,
      by_attempt: {},
      p50_latency_ms: null,
      p95_latency_ms: null,
      max_k: body.max_k ?? 10,
    },
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  });
  return {
    eval_run_id: id,
    bundle_id: body.bundle_id,
    status: 'queued',
    message: '跑测已入队',
  };
}

export async function getRetrievalEvalRun(
  evalRunId: string,
): Promise<EvalRunDetail> {
  await delay(200);
  const run = RUNS.find((r) => r.eval_run_id === evalRunId);
  if (!run) throw { code: 'not_found', message: '跑测不存在' };
  return run;
}

export function listMockRuns() {
  return RUNS;
}

// ------------------------------------------------------------
// 阶段统计：gold chunk 在哪里被丢弃（宏观）
// ------------------------------------------------------------

/**
 * 关键口径（对齐 schema.sql + codegen prompt）：
 *  - 一条 stage/source 只在「gold 进入前存在、离开后消失」时才算它丢的；
 *  - 并行召回分支各自独立：dense 没召回不等于最终 miss（keyword 可能召回）；
 *  - drop_reason_counts 用固定枚举。
 */
export async function getRetrievalEvalStageStats(
  evalRunId: string,
): Promise<StageStatsResponse> {
  await delay(320);
  const run = RUNS.find((r) => r.eval_run_id === evalRunId) ?? RUNS[0];
  const denom = run.metrics.completed_cases || 84;
  const stages: StageStatsResponse['stages'] = [
    {
      stage_key: 'recall.dense_vector',
      source_key: 'dense_vector',
      observed_cases: denom,
      executed_cases: denom,
      average_input_count: 0,
      average_output_count: 50,
      gold_present_before_count: 0,
      gold_present_after_count: 72,
      gold_drop_count: 0,
      gold_pass_rate: null,
      drop_reason_counts: {},
    },
    {
      stage_key: 'recall.keyword',
      source_key: 'keyword',
      observed_cases: denom,
      executed_cases: denom,
      average_input_count: 0,
      average_output_count: 50,
      gold_present_before_count: 0,
      gold_present_after_count: 58,
      gold_drop_count: 0,
      gold_pass_rate: null,
      drop_reason_counts: {},
    },
    {
      stage_key: 'fusioner',
      source_key: '',
      observed_cases: denom,
      executed_cases: denom,
      average_input_count: 100,
      average_output_count: 50,
      gold_present_before_count: 79,
      gold_present_after_count: 77,
      gold_drop_count: 2,
      gold_pass_rate: 0.9747,
      drop_reason_counts: { top_k_cutoff: 2 },
    },
    {
      stage_key: 'filter',
      source_key: '',
      observed_cases: denom,
      executed_cases: denom,
      average_input_count: 50,
      average_output_count: 41,
      gold_present_before_count: 77,
      gold_present_after_count: 70,
      gold_drop_count: 7,
      gold_pass_rate: 0.9091,
      drop_reason_counts: { score_threshold: 7 },
    },
    {
      stage_key: 'reranker',
      source_key: '',
      observed_cases: denom,
      executed_cases: denom,
      average_input_count: 41,
      average_output_count: 30,
      gold_present_before_count: 70,
      gold_present_after_count: 69,
      gold_drop_count: 1,
      gold_pass_rate: 0.9857,
      drop_reason_counts: { rerank_cutoff: 1 },
    },
    {
      stage_key: 'cutter',
      source_key: '',
      observed_cases: denom,
      executed_cases: denom,
      average_input_count: 30,
      average_output_count: 10,
      gold_present_before_count: 69,
      gold_present_after_count: 68,
      gold_drop_count: 1,
      gold_pass_rate: 0.9855,
      drop_reason_counts: { final_top_k_cutoff: 1 },
    },
  ];
  return { eval_run_id: evalRunId, stages };
}

// ------------------------------------------------------------
// 单 case trace：分阶段 top5 候选 + gold 迁移
// ------------------------------------------------------------

export async function getRetrievalEvalCaseTrace(
  evalRunId: string,
  evalCaseId: string,
  attemptNo?: number,
): Promise<EvalCaseTraceResponse> {
  await delay(300);
  const run = RUNS.find((r) => r.eval_run_id === evalRunId) ?? RUNS[0];
  const bundle =
    BUNDLES.find((b) => b.bundle_id === run.bundle_id) ?? BUNDLES[0];
  const cases = casesOf(bundle).filter(
    (c) => c.validation_status === 'validated',
  );
  const index = Math.max(
    0,
    cases.findIndex((c) => c.eval_case_id === evalCaseId),
  );
  const target = cases[index] ?? cases[0];
  const goldIds = target.gold_chunk_ids;
  const gold = goldIds[0];

  // 轮次必须和列表里那一行同源，否则「点开抽屉发现是第 3 轮的参数、
  // 列表却说第 1 轮就命中了」—— 同一份拼牌逻辑，见 mockLadder。
  const slot = mockLadder(cases.length, run)[index];
  const runLadder = attemptsFromSnapshot(run.effective_config_snapshot);
  const attempt = attemptNo ?? slot.attempt_no;
  const withReranker = attempt >= 3;

  // 造一批「陪跑」候选，保证 gold 在不同阶段位置不同，能演示 cutoff 丢弃
  const makeCands = (
    offset: number,
    goldRank: number,
    scoreName: string,
    dir: 'higher_is_better' | 'lower_is_better',
  ) =>
    Array.from({ length: 5 }, (_, i) => {
      const rank = i + 1;
      const isGold = rank === goldRank;
      const id = isGold ? gold : uuidLike(offset + i);
      return {
        chunk_id: id,
        rank,
        score: Number((0.95 - i * 0.07).toFixed(4)),
        score_name: scoreName,
        score_direction: dir,
        source_key: '',
        selected: true,
        drop_reason: null,
        metadata: isGold ? { is_gold: true } : undefined,
      };
    });

  const stages: EvalCaseTraceResponse['stages'] = [
    {
      stage_key: 'recall.dense_vector',
      source_key: 'dense_vector',
      input_count: 0,
      output_count: 50,
      gold_present_before: false,
      gold_present_after: true,
      gold_ranks_before: {},
      gold_scores_before: {},
      gold_ranks_after: { [gold]: 3 },
      gold_scores_after: { [gold]: 0.8123 },
      drop_reason: null,
      top_candidates: makeCands(
        100,
        3,
        'cosine_similarity',
        'higher_is_better',
      ),
    },
    {
      stage_key: 'recall.keyword',
      source_key: 'keyword',
      input_count: 0,
      output_count: 50,
      gold_present_before: false,
      gold_present_after: false,
      gold_ranks_before: {},
      gold_scores_before: {},
      gold_ranks_after: {},
      gold_scores_after: {},
      drop_reason: 'not_recalled',
      top_candidates: makeCands(200, -1, 'bm25', 'higher_is_better'),
    },
    {
      stage_key: 'fusioner',
      source_key: '',
      input_count: 100,
      output_count: 50,
      gold_present_before: true,
      gold_present_after: true,
      gold_ranks_before: { [gold]: 3 },
      gold_scores_before: { [gold]: 0.0164 },
      gold_ranks_after: { [gold]: 12 },
      gold_scores_after: { [gold]: 0.0139 },
      drop_reason: null,
      top_candidates: makeCands(300, -1, 'rrf_score', 'higher_is_better').map(
        (c) => ({
          ...c,
          rank: c.rank,
        }),
      ),
    },
    {
      stage_key: 'filter',
      source_key: '',
      input_count: 50,
      output_count: 41,
      gold_present_before: true,
      gold_present_after: false,
      gold_ranks_before: { [gold]: 12 },
      gold_scores_before: { [gold]: 0.2871 },
      gold_ranks_after: { [gold]: null },
      gold_scores_after: { [gold]: 0.2871 },
      drop_reason: 'score_threshold',
      top_candidates: [
        ...makeCands(400, -1, 'rrf_score', 'higher_is_better'),
        // 关键：被阈值丢弃的 gold 即使不在 top5 也必须保留
        {
          chunk_id: gold,
          rank: 12,
          score: 0.2871,
          score_name: 'rrf_score',
          score_direction: 'higher_is_better' as const,
          source_key: '',
          selected: false,
          drop_reason: 'score_threshold',
          metadata: { is_gold: true, note: '低于阈值 0.3，被 filter 丢弃' },
        },
      ],
    },
    {
      stage_key: 'reranker',
      source_key: '',
      input_count: 41,
      // 第 3 轮才挂精排（`retrieve_processor` 的第 4 段），前两轮这一段是空的
      output_count: withReranker ? 30 : 41,
      gold_present_before: false,
      gold_present_after: false,
      gold_ranks_before: {},
      gold_scores_before: {},
      gold_ranks_after: {},
      gold_scores_after: {},
      drop_reason: withReranker ? 'rerank_cutoff' : 'not_applicable',
      top_candidates: makeCands(500, -1, 'reranker_score', 'higher_is_better'),
    },
    {
      stage_key: 'cutter',
      source_key: '',
      input_count: withReranker ? 30 : 41,
      output_count: 10,
      gold_present_before: false,
      gold_present_after: false,
      gold_ranks_before: {},
      gold_scores_before: {},
      gold_ranks_after: {},
      gold_scores_after: {},
      drop_reason: 'not_applicable',
      top_candidates: makeCands(600, -1, 'reranker_score', 'higher_is_better'),
    },
  ];

  return {
    eval_run_id: evalRunId,
    eval_case_id: evalCaseId,
    attempt_no: attempt,
    available_attempts: slot.available_attempts,
    // 这一轮实际发给检索的那句话。**随轮次变**（第 1 轮日期展开、第 2 轮
    // 大模型改写、第 3 轮原句）—— 抽屉里切换轮次时这一项也要跟着变，
    // 否则「这份痕迹是哪句话跑出来的」这个唯一答案就丢了。
    query_text: queryTextFor(target.question, attempt, runLadder),
    gold_chunk_ids: goldIds,
    stages,
  };
}

// ------------------------------------------------------------
// 逐题结果
// ------------------------------------------------------------

/**
 * 某条 case 的**轮次归属**：`hit=false` 表示三轮都没找到。
 *
 * 为什么不让「列表里的 hit」和「阶梯里的 hit_count」各抽各的
 * ----------------------------------------------------------
 * 逐轮阶梯（`by_attempt[r].hit_count`）与逐题结果回答的是同一个问题的两个
 * 视角。两处各写一套抽样，很容易抽出「阶梯说第 2 轮救回 8 条，可列表里
 * 第 2 轮找到的一条都没有」这种自相矛盾的演示数据 —— 一旦出现，看的人
 * 会先怀疑页面算错了，而不是怀疑 mock。
 *
 * 所以这里**只按桶大小发牌**：62 张「第 1 轮命中」、8 张「第 2 轮」、
 * 6 张「第 3 轮」，剩下的全是「没找到」，最后用固定种子打乱顺序 —— 桶的
 * 大小直接取自上面那份 by_attempt，两边永远对得上。
 */
interface MockCaseLadder {
  /** 这条 case 的代表行来自哪一轮（命中=救回它的那轮；没命中=最后一轮）。 */
  attempt_no: number;
  /** 它实际跑过的轮次，升序（逐轮放宽只会往后跑）。 */
  available_attempts: number[];
  /** 最终找到没有（与表头 hit_rate_at_k 同口径）。 */
  hit: boolean;
}

/** 按 run 的逐轮命中**占比**铺牌，返回 `count` 条 case 的轮次归属。 */
function mockLadder(count: number, run: EvalRunDetail): MockCaseLadder[] {
  const byAttempt = run.metrics.by_attempt ?? {};
  const rounds = Object.keys(byAttempt)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  // 没有逐轮数据（不该发生）时退化成「一轮里全部命中」，而不是抛错：
  // mock 只是演示数据，缺字段就少一种形态，别把整个页面带崩。
  if (rounds.length === 0) {
    return Array.from({ length: count }, () => ({
      attempt_no: 1,
      available_attempts: [1],
      hit: true,
    }));
  }

  const lastRound = rounds[rounds.length - 1];

  // ⚠️ 分母用 run 的 `total_cases`，**不是** `count`。
  // bundle 里的 validated 用例数未必等于跑测当时的用例数（造题会增删），
  // 按 `count` 归一化会把每一档都放大，最靠后的「未命中」那一档直接被
  // 挤没 —— 表现是整张逐题结果全是「命中」、「仅未命中」筛出空表，
  // 而表头还写着有 8 条没命中。
  const denom = Math.max(run.metrics.total_cases ?? 0, 1);
  const buckets: Array<{ upTo: number; slot: MockCaseLadder }> = [];
  let acc = 0;

  for (const r of rounds) {
    acc += (byAttempt[String(r)]?.hit_count ?? 0) / denom;
    buckets.push({
      upTo: acc,
      slot: {
        attempt_no: r,
        available_attempts: rounds.filter((x) => x <= r),
        hit: true,
      },
    });
  }

  // 兜底那一档：所有轮次都没命中。占比 = 1 - Σ各轮命中占比。
  buckets.push({
    upTo: 1,
    slot: { attempt_no: lastRound, available_attempts: rounds, hit: false },
  });

  // 分层铺牌：第 i 条取分布的第 (i+0.5)/count 分位。按比例铺而不是「前
  // 62 条发第 1 轮」，所以 count 再小也不会把某一档整档挤掉。
  const deck = Array.from({ length: count }, (_, i) => {
    const u = (i + 0.5) / count;
    const bucket =
      buckets.find((b) => u < b.upTo) ?? buckets[buckets.length - 1];
    return { ...bucket.slot };
  });

  // 固定种子 Fisher-Yates：同一份数据每次刷新顺序一致（可复现），但不会
  // 出现「前 62 条全是第 1 轮命中、后面全是失败」这种一眼假的分组。
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(seeded(8300, i * 31 + 7) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

/**
 * 单条 chunk 的正文（demo 用）。
 *
 * 真实数据来自 `GET /document-chunks/{document_chunk_id}`（见 service 的
 * `getDocumentChunk`）。这里从 `SOURCE_CHUNKS` 反查 —— demo 里的金标 id
 * 本来就是从这批 chunk 生成的，所以点开任何一颗金标都一定取得到；演示里
 * 最不该出现的假故障就是「查不到正文」。
 *
 * 取不到**抛错**（与后端 404 同义），而不是回一个 `content: ''` 的空壳 ——
 * 界面上「这块取不到」与「这块正文本来为空」是两种提示，mock 把它们抹平
 * 就等于把这个边界藏掉了。
 *
 * `chunk_index` 是 `% 6` 的产物：`buildSourceChunks` 把一个 seed 复制 6 份
 * 当作同一篇文档的不同版本快照，所以同一 seed 的 6 个 id 恰好落在 0..5。
 */
export async function getDocumentChunk(
  documentChunkId: string,
): Promise<DocumentChunkText> {
  await delay(200);

  const chunk = SOURCE_CHUNKS.find((c) => c.chunk_id === documentChunkId);

  if (!chunk) {
    throw new Error(`DocumentChunk not found: ${documentChunkId}`);
  }

  return {
    document_chunk_id: chunk.chunk_id,
    chunk_index: SOURCE_CHUNKS.indexOf(chunk) % 6,
    content: chunk.content,
    content_truncated: false,
    char_count: chunk.content.length,
    token_count: null,
    start_index: 0,
    end_index: chunk.content.length,
    locator: null,
  };
}

export async function listRetrievalEvalRunCases(
  evalRunId: string,
  params: ListRunCasesParams = {},
): Promise<EvalRunCaseListResponse> {
  await delay(260);
  const run = RUNS.find((r) => r.eval_run_id === evalRunId) ?? RUNS[0];
  const bundle =
    BUNDLES.find((b) => b.bundle_id === run.bundle_id) ?? BUNDLES[0];
  const base = casesOf(bundle).filter(
    (c) => c.validation_status === 'validated',
  );
  const {
    hit,
    document_type_definition_id: dtd,
    page = 1,
    page_size = 50,
  } = params;

  const ladder = mockLadder(base.length, run);
  const runLadder = attemptsFromSnapshot(run.effective_config_snapshot);

  let rows: EvalRunCase[] = base.map((c, i) => {
    const slot = ladder[i];
    const rank = slot.hit
      ? 1 + Math.floor(seeded(8500 + i, i) * (run.max_k - 1))
      : null;
    return {
      eval_case_id: c.eval_case_id,
      question: c.question,
      chunk_id: c.chunk_id,
      document_type_definition_id: c.document_type_definition_id,
      status: 'completed',
      attempt_no: slot.attempt_no,
      // 代表行那一轮实际发给检索的那句话 —— 与 trace 里同源，两处必须一致，
      // 否则会出现「列表说已改写、点开抽屉说原文」。
      query_text: queryTextFor(c.question, slot.attempt_no, runLadder),
      gold_hit: slot.hit,
      gold_rank: rank,
      gold_chunk_ids: c.gold_chunk_ids,
      retrieved_chunk_ids: Array.from({ length: run.max_k }, (_, k) =>
        k === 0 && rank ? c.gold_chunk_ids[0] : uuidLike(11000 + i * 10 + k),
      ),
      latency_ms: 120 + Math.floor(seeded(9000 + i, i) * 500),
      error_code: null,
      error_message: null,
    } as EvalRunCase;
  });

  if (typeof hit === 'boolean') rows = rows.filter((r) => r.gold_hit === hit);
  if (dtd) rows = rows.filter((r) => r.document_type_definition_id === dtd);
  const total = rows.length;
  const start = (page - 1) * page_size;
  return {
    items: rows.slice(start, start + page_size),
    page,
    page_size,
    total,
  };
}

// ------------------------------------------------------------
// DTD 选项
// ------------------------------------------------------------

export async function listDtdOptions() {
  await delay(200);
  return { items: DTD_OPTIONS };
}

// ------------------------------------------------------------
// 供 UI 复用的元数据映射
// ------------------------------------------------------------

export const BUNDLE_STATUS_META: Record<
  string,
  { text: string; color: string }
> = {
  draft: { text: '草稿', color: 'default' },
  generating: { text: '生成中', color: 'processing' },
  ready: { text: '就绪', color: 'success' },
  partial_failed: { text: '部分失败', color: 'warning' },
  failed: { text: '失败', color: 'error' },
  archived: { text: '已归档', color: 'default' },
};

export const JOB_STATUS_META: Record<string, { text: string; color: string }> =
  {
    queued: { text: '排队中', color: 'default' },
    running: { text: '运行中', color: 'processing' },
    completed: { text: '已完成', color: 'success' },
    partial_failed: { text: '部分失败', color: 'warning' },
    failed: { text: '失败', color: 'error' },
    cancelled: { text: '已取消', color: 'default' },
  };

export const DROP_REASON_META: Record<string, { text: string; color: string }> =
  {
    not_recalled: { text: '未召回', color: 'default' },
    top_k_cutoff: { text: 'TopK 截断', color: 'gold' },
    score_threshold: { text: '分数阈值', color: 'volcano' },
    metadata_filter: { text: '元数据过滤', color: 'purple' },
    rerank_cutoff: { text: '重排截断', color: 'blue' },
    final_top_k_cutoff: { text: '最终 TopK 截断', color: 'geekblue' },
    deduplicated: { text: '去重', color: 'cyan' },
    permission_filter: { text: '权限过滤', color: 'magenta' },
    processor_error: { text: '处理异常', color: 'red' },
    unknown: { text: '未知', color: 'default' },
    not_applicable: { text: '不适用', color: 'default' },
  };
