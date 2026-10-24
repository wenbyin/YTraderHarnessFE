// src/pages/skill/mockData.ts
//
// 技能页的本地数据源。
//
// ⚠️ 它**不是**默认数据源
// ----------------------
//   后端 `app/api/v1/skills.py` 已落地（2026-10-20），service.ts 默认走真实
//   接口。这份内存实现只在 `localStorage['skill:mock']='1'` 时启用 ——
//   用于离线预览 / 视觉验收，页面头部会显式打「本地模拟」标签。
//
//   留着它不是"懒得删"：mock 是**契约的可执行副本**（见 mockData.test.ts），
//   字段、枚举、约束都按 schema 来 —— 包括 `skill_key` 的正则、status 三态、
//   "绑定是精确匹配"、以及 tags / examples 的"不传=不改、传 [] = 清空"。
//
// ⚠️ 它是**有状态的**：新增 / 编辑 / 删除 / 改绑定都会改这份内存数据，刷新页面
//    才复位。这样本地预览点完能看到真实反馈，而不是"点了没反应"。
import type {
  Capability,
  CapabilityRef,
  SkillCreate,
  SkillDetail,
  SkillListParams,
  SkillListResponse,
  SkillPatch,
  SkillStatus,
} from './data';
import { SKILL_KEY_PATTERN } from './data';

/** 固定 id 的能力树（模拟 `GET /api/v1/capabilities` 的扁平返回）。 */
const CAPABILITIES: Capability[] = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    code: 'retrieval',
    name: '检索',
    parent_id: null,
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000011',
    code: 'retrieval.search',
    name: '全文召回',
    parent_id: 'c0000000-0000-4000-8000-000000000001',
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000012',
    code: 'retrieval.rerank',
    name: '结果重排',
    parent_id: 'c0000000-0000-4000-8000-000000000001',
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    code: 'doc',
    name: '文档',
    parent_id: null,
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000021',
    code: 'doc.parse',
    name: '文档解析',
    parent_id: 'c0000000-0000-4000-8000-000000000002',
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000022',
    code: 'table.parse',
    name: '表格解析',
    parent_id: 'c0000000-0000-4000-8000-000000000002',
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    code: 'llm',
    name: '模型',
    parent_id: null,
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000031',
    code: 'llm.chat',
    name: '对话生成',
    parent_id: 'c0000000-0000-4000-8000-000000000003',
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000004',
    code: 'eval',
    name: '评测',
    parent_id: null,
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000041',
    code: 'eval.run',
    name: '跑测执行',
    parent_id: 'c0000000-0000-4000-8000-000000000004',
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000005',
    code: 'ocr',
    name: '多模态',
    parent_id: null,
    is_active: true,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000051',
    code: 'ocr.text',
    name: '文字识别',
    parent_id: 'c0000000-0000-4000-8000-000000000005',
    is_active: false,
  },
];

const CAP_BY_CODE = new Map(CAPABILITIES.map((item) => [item.code, item]));

function refs(codes: string[]): CapabilityRef[] {
  return codes
    .map((code) => CAP_BY_CODE.get(code))
    .filter((item): item is Capability => item !== undefined)
    .map(({ id, code, name }) => ({ id, code, name }));
}

/** 相对当前时间的前后偏移，让"x 小时前"看起来是活的。 */
function ago(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

interface SeedSkill {
  skill_key: string;
  name: string;
  description: string;
  /** A2A tags：发布 / 发现用，列表里会返回 */
  tags: string[];
  /** A2A examples：只在详情里返回 */
  examples: string[];
  instructions: string;
  status: SkillStatus;
  hoursAgo: number;
  codes: string[];
}

const SEED: SeedSkill[] = [
  {
    skill_key: 'doc_qa_retrieval',
    name: '文档检索问答',
    description:
      '面向文档库的多轮检索问答：先改写查询，再走混合召回与重排，回答必须带来源引用，追问时需要带上文。',
    tags: ['document', 'qa', 'retrieval'],
    examples: [
      '这份年报里营收增长主要来自哪块业务？',
      '上一轮提到的应收账款风险，半年报里有更新吗？',
    ],
    instructions: [
      '你是文档问答子 agent。',
      '1. 收到问题后先判断是否需要改写（指代、省略、复合问题）。',
      '2. 调用检索工具取回 top-k 片段，按主题分组；不要直接复述片段原文。',
      '3. 回答中的每个事实都必须挂到至少一个来源；没有来源就说明"文档中没有提到"。',
      '4. 追问时先结合上一轮结论，不要从头检索。',
    ].join('\n'),
    status: 'ACTIVE',
    hoursAgo: 2,
    codes: ['retrieval.search', 'retrieval.rerank', 'llm.chat'],
  },
  {
    skill_key: 'doc_summarize',
    name: '长文档摘要',
    description:
      '对超长文档做分层摘要：按章节切分后分别归纳，再合并成一段总览与要点清单，保留原文锚点。',
    tags: ['document', 'summary'],
    examples: ['把这 80 页的招标文件压成一页要点，每章留一个锚点。'],
    instructions: [
      '你是长文档摘要子 agent。',
      '1. 先取文档结构（章节树），超过单次上下文时按章节分段处理。',
      '2. 每段输出 3~5 条要点，带上原文位置（章节号 / 页码）。',
      '3. 最后合并成"总览 + 要点清单"，不要引入原文没有的信息。',
    ].join('\n'),
    status: 'ACTIVE',
    hoursAgo: 18,
    codes: ['doc.parse', 'llm.chat'],
  },
  {
    skill_key: 'table_extract',
    name: '表格结构化抽取',
    description:
      '从 PDF / 图片里识别表格结构，输出带行列坐标与表头的二维数组，合并单元格会标注 span。',
    tags: ['table', 'extraction'],
    examples: ['把这份财报 PDF 里的三张表转成带表头的二维数组。'],
    instructions: [
      '你是表格抽取子 agent。',
      '1. 识别表头行与数据行，跨页表格优先按表头对齐拼接。',
      '2. 合并单元格输出 span（rowspan / colspan），不要重复填充。',
      '3. 识别不确定的单元格标注 confidence，低于 0.6 的单独列出供人工复核。',
    ].join('\n'),
    status: 'ACTIVE',
    hoursAgo: 26,
    codes: ['doc.parse', 'table.parse'],
  },
  {
    skill_key: 'query_rewrite',
    name: '查询改写',
    description:
      '把口语化追问改写成独立可检索的查询：消解指代、补齐省略、拆分复合问题。只改写法，不回答问题。',
    tags: ['query', 'rewrite'],
    examples: ['把它换成完整问题，我要拿去检索。'],
    instructions: [
      '你是查询改写子 agent。',
      '1. 结合对话历史把指代（它 / 这个）替换成具体名词。',
      '2. 复合问题拆成 2~3 个独立查询，保留并列关系。',
      '3. 只输出改写后的查询列表，不要回答，也不要解释改写理由。',
    ].join('\n'),
    status: 'ACTIVE',
    hoursAgo: 40,
    codes: ['llm.chat'],
  },
  {
    skill_key: 'rag_eval',
    name: '检索质量评估',
    description:
      '对一套检索配置跑离线评测：命中率、MRR、逐题得分与失败归因，结果可直接回传到评测页对比。',
    tags: ['evaluation', 'retrieval'],
    examples: ['用 gold set 跑一遍当前检索配置，给出 MRR 和失败归因。'],
    instructions: [
      '你是检索评测子 agent。',
      '1. 先校验数据集与配置是否齐备，缺任何一项直接报错，不要用默认值兜底。',
      '2. 跑测时记录每题召回结果与耗时，失败题要给出归因（改写错 / 召回空 / 排序错）。',
      '3. 汇总输出命中率、MRR 与分位时延，异常值单独标注。',
    ].join('\n'),
    status: 'DRAFT',
    hoursAgo: 30,
    codes: ['eval.run', 'retrieval.search'],
  },
  {
    skill_key: 'chunk_tuning',
    name: '分块策略调优',
    description:
      '在给定语料上网格搜索分块大小与重叠率，用检索指标挑出最优组合，产出可落到文档类型的建议配置。',
    tags: ['evaluation', 'chunking'],
    examples: ['512/64 和 1024/128 哪个分块组合更划算？'],
    instructions: [
      '你是分块调优子 agent。',
      '1. 先确认语料与评测集（没有评测集就要求先建，不要凭感觉调）。',
      '2. 网格搜索按 chunk_size × overlap 组合，每组都要记录指标，不要只留最优。',
      '3. 结论必须给出"推荐配置 + 相比基线提升了多少"。',
    ].join('\n'),
    status: 'DRAFT',
    hoursAgo: 6,
    codes: ['eval.run'],
  },
  {
    skill_key: 'contract_review',
    name: '合同条款审阅',
    description:
      '按预设风险清单逐条比对合同条款，标出偏离项与建议表述，输出可直接给法务复核的批注表。',
    tags: ['legal', 'contract', 'review'],
    examples: ['按风险清单过一遍这份采购合同，缺哪些条款？'],
    instructions: [
      '你是合同审阅子 agent。',
      '1. 按风险清单逐条定位条款，找不到就标"缺失"，不要跳过。',
      '2. 每条给出：原文摘录、风险等级、建议表述。',
      '3. 不要给法律结论，只做条款层面的比对与提示。',
    ].join('\n'),
    status: 'DRAFT',
    hoursAgo: 72,
    codes: ['doc.parse', 'llm.chat'],
  },
  {
    skill_key: 'image_ocr',
    name: '图片文字识别',
    description:
      '扫描件与截图的中英文识别，输出带坐标的文本块，可选保留版式顺序。当前能力绑定的上游工具已停用。',
    tags: ['ocr', 'image'],
    examples: ['把这张扫描件的文字按阅读顺序抄出来。'],
    instructions: [
      '你是 OCR 子 agent。',
      '1. 输出文本块时保留坐标与阅读顺序。',
      '2. 识别不确定的字符用 □ 占位，不要猜测填充。',
    ].join('\n'),
    status: 'DISABLED',
    hoursAgo: 220,
    codes: ['ocr.text'],
  },
  {
    skill_key: 'stress_probe',
    name: '压测探针',
    description:
      '按给定并发与轮次对被测入口发压，回传分位时延与 token 消耗，用于回归压测基线。',
    tags: ['stress', 'performance'],
    examples: ['对 /api/chat 压 20 并发、5 轮，给 p95 时延和 token 总量。'],
    instructions: [
      '你是压测子 agent。',
      '1. 先做 1 个会话的冒烟，通过后再放开到目标并发。',
      '2. 记录每轮首 token 时延与总时延，异常轮次保留原始事件。',
      '3. 输出 p50 / p95 / p99 与 token 总量，不要只给平均值。',
    ].join('\n'),
    status: 'ACTIVE',
    hoursAgo: 3,
    codes: ['eval.run', 'llm.chat'],
  },
];

/** 稳定 id：由 skill_key 派生，刷新不变，方便对着看。 */
function idOf(skillKey: string): string {
  let hash = 0;
  for (let i = 0; i < skillKey.length; i += 1) {
    hash = (hash * 31 + skillKey.charCodeAt(i)) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${skillKey.length.toString(16).padStart(12, '0')}`;
}

function buildSeed(): SkillDetail[] {
  return SEED.map((seed) => ({
    id: idOf(seed.skill_key),
    skill_key: seed.skill_key,
    name: seed.name,
    description: seed.description,
    tags: [...seed.tags],
    examples: [...seed.examples],
    instructions: seed.instructions,
    status: seed.status,
    created_at: ago(seed.hoursAgo + 240),
    updated_at: ago(seed.hoursAgo),
    capabilities: refs(seed.codes),
  }));
}

let skills: SkillDetail[] = buildSeed();

/** 测试复位：把内存数据恢复到初始种子。 */
export function resetMockSkills(): void {
  skills = buildSeed();
}

/** 契约里的错误形状（前端把它当 `ErrorResponse` 用）。 */
export class MockApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireSkill(id: string): SkillDetail {
  const found = skills.find((item) => item.id === id);
  if (!found) {
    throw new MockApiError(404, 'SKILL_NOT_FOUND', '技能不存在或已被删除');
  }
  return found;
}

export function mockCapabilities(): Capability[] {
  return CAPABILITIES.map((item) => ({ ...item }));
}

export function mockListSkills(
  params: SkillListParams = {},
): SkillListResponse {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, params.page_size ?? 20));
  const keyword = (params.q ?? '').trim().toLowerCase();

  const filtered = skills
    .filter((item) => (params.status ? item.status === params.status : true))
    .filter((item) =>
      params.capability_id
        ? item.capabilities.some((cap) => cap.id === params.capability_id)
        : true,
    )
    .filter((item) => {
      if (keyword === '') return true;
      return [item.skill_key, item.name, item.description]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const start = (page - 1) * pageSize;
  return {
    items: filtered
      .slice(start, start + pageSize)
      // 列表里不带 instructions / examples / capabilities —— 与 SkillSummary 的
      // 形状一致（examples 只在 SkillDetail 上），免得前端在 mock 下写出
      // "列表就有 examples / capability" 的代码。
      .map(
        ({
          instructions: _instructions,
          examples: _examples,
          capabilities: _caps,
          ...rest
        }) => rest,
      ),
    page,
    page_size: pageSize,
    total: filtered.length,
  };
}

export function mockGetSkill(id: string): SkillDetail {
  const found = requireSkill(id);
  return {
    ...found,
    tags: [...found.tags],
    examples: [...found.examples],
    capabilities: found.capabilities.map((cap) => ({ ...cap })),
  };
}

export function mockCreateSkill(body: SkillCreate): SkillDetail {
  const key = body.skill_key.trim();
  if (!SKILL_KEY_PATTERN.test(key)) {
    throw new MockApiError(422, 'VALIDATION_ERROR', 'skill_key 格式不合法');
  }
  if (skills.some((item) => item.skill_key === key)) {
    throw new MockApiError(
      409,
      'SKILL_KEY_EXISTS',
      `skill_key「${key}」已存在`,
    );
  }

  const now = new Date().toISOString();
  const created: SkillDetail = {
    id: idOf(key),
    skill_key: key,
    name: body.name.trim(),
    description: body.description.trim(),
    // 与后端一致：省略 = 空数组（default_factory=list），不是 undefined
    tags: [...(body.tags ?? [])],
    examples: [...(body.examples ?? [])],
    instructions: body.instructions,
    status: body.status ?? 'DRAFT',
    created_at: now,
    updated_at: now,
    capabilities: [],
  };
  skills = [created, ...skills];
  return { ...created };
}

export function mockPatchSkill(id: string, body: SkillPatch): SkillDetail {
  requireSkill(id);
  skills = skills.map((item) =>
    item.id === id
      ? {
          ...item,
          name: body.name ?? item.name,
          description: body.description ?? item.description,
          // `??` 在语义上正好等于"不传 = 不改"：`undefined` 取旧值，
          // 而 `[]` 不是 nullish，会被原样写进去（= 清空）。
          tags: [...(body.tags ?? item.tags)],
          examples: [...(body.examples ?? item.examples)],
          instructions: body.instructions ?? item.instructions,
          status: body.status ?? item.status,
          updated_at: new Date().toISOString(),
        }
      : item,
  );
  return mockGetSkill(id);
}

export function mockDeleteSkill(id: string): void {
  requireSkill(id);
  skills = skills.filter((item) => item.id !== id);
}

/** PUT capabilities —— 全量替换（先清空再逐条写）。 */
export function mockReplaceCapabilities(
  id: string,
  capabilityIds: string[],
): CapabilityRef[] {
  requireSkill(id);
  const unique = Array.from(new Set(capabilityIds));
  const unknown = unique.filter(
    (capId) => !CAPABILITIES.some((cap) => cap.id === capId),
  );
  if (unknown.length > 0) {
    throw new MockApiError(
      422,
      'VALIDATION_ERROR',
      '包含不存在的 capability_id',
    );
  }

  const next = refs(
    unique
      .map((capId) => CAPABILITIES.find((cap) => cap.id === capId)?.code)
      .filter((code): code is string => typeof code === 'string'),
  );
  skills = skills.map((item) =>
    item.id === id
      ? { ...item, capabilities: next, updated_at: new Date().toISOString() }
      : item,
  );
  return next.map((cap) => ({ ...cap }));
}
