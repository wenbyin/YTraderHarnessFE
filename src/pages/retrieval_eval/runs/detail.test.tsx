// src/pages/retrieval_eval/runs/detail.test.tsx
//
// 「逐题结果」表的**可读性**回归测试。
//
// 起因是一张截图：整张表读不了 —— 同一道题重复三行、其中两行整行是空的，
// DTD 的标签与右侧「阶段 trace」叠在同一片像素里互相穿模，gold rank 那一列
// 显示成一个内容为 "#-" 的空标签（看着像"名次就是横杠"这个真实取值）。
//
// 这三条都是**静默**的：表格照样渲染、控制台不报错，所以各留一条断言钉住：
//   1. `scroll.x` 必须存在 —— 否则 `valueType:'option'`（ProTable 默认
//      `fixed:'right'`）会盖在左边的列上；
//   2. gold_rank 缺失/非数字时必须是纯文本，不能是 Tag；
//   3. 同一条 case 收到多行时必须折叠成一行，并且**显式提示**后端版本。
//
// 另外一条（本文件下半部分）钉的是**时序**：跑测是后台任务，进页面时它还在
// 跑，逐题结果表拿不到东西；轮询到终态后必须自动补拉一次，否则表格永远停在
// 进页面那一刻的空快照上 —— 同样是静默的（既不报错，界面也不残缺，就是空）。

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { App, Table } from 'antd';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentChunkText, EvalRunCase } from '../data';

const getRun = vi.fn();
const getStageStats = vi.fn();
const listRunCases = vi.fn();
const getCaseTrace = vi.fn();
const getChunk = vi.fn();

/** 记录 ProTable 收到的 props —— 断言 `scroll` 得从这里看。 */
const seen = vi.hoisted(() => ({ tableProps: [] as any[] }));

vi.mock('@umijs/max', () => ({
  history: { push: vi.fn() },
  useParams: () => ({ evalRunId: 'run-1' }),
}));

/**
 * ⚠️ pro-components 必须挡掉（它内部会引 `antd/es/locale/zh_CN` 那条
 * 无扩展名相对导入，vitest 下整文件起不来，见 runs/index.test.tsx 的说明）。
 * 但这里不能像那个文件一样把 ProTable 换成空 div —— 本用例要看的正是
 * **传进去的 columns 与 scroll**，所以换成一层真 antd `Table`。
 */
vi.mock('@ant-design/pro-components', () => ({
  PageContainer: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ProTable: (props: any) => {
    seen.tableProps.push(props);
    const [data, setData] = React.useState<any[]>([]);
    // 只在挂载时取一次：`request` 每次渲染都是新函数，放进依赖会自激循环。
    const reqRef = React.useRef(props.request);
    const load = React.useCallback(async () => {
      const res = await reqRef.current({ current: 1, pageSize: 20 });
      setData(res.data ?? []);
    }, []);
    React.useEffect(() => {
      load();
    }, [load]);
    /**
     * 把 `reload()` 挂到页面传进来的 `actionRef` 上 —— 「跑测完成后自动
     * 拉取逐题结果」这条需求，页面就是靠 `actionRef.current?.reload()`
     * 触发的；代理不实现它，那条用例就永远测不到真东西。
     */
    React.useImperativeHandle(props.actionRef, () => ({ reload: load }), [
      load,
    ]);
    return (
      <Table
        rowKey={props.rowKey}
        columns={props.columns}
        dataSource={data}
        scroll={props.scroll}
        pagination={false}
      />
    );
  },
}));

vi.mock('../service', () => ({
  getRetrievalEvalRun: (...a: unknown[]) => getRun(...a),
  getRetrievalEvalStageStats: (...a: unknown[]) => getStageStats(...a),
  listRetrievalEvalRunCases: (...a: unknown[]) => listRunCases(...a),
  getRetrievalEvalCaseTrace: (...a: unknown[]) => getCaseTrace(...a),
  // trace 抽屉现在会顺带取目标 chunk 的正文（TargetChunkText）。挡掉它，
  // 否则抽屉一开就是一条真请求，用例会挂在"后端不可达"而不是自己的断言上。
  getDocumentChunk: (...a: unknown[]) => getChunk(...a),
}));

vi.mock('../components/AttemptLadder', () => ({
  default: () => <div data-testid="ladder" />,
}));
vi.mock('../components/StageFunnel', () => ({
  default: () => <div data-testid="funnel" />,
}));
vi.mock('../components/StageTraceTimeline', () => ({
  default: () => <div data-testid="trace-timeline" />,
}));
vi.mock('../dtdOptions', () => ({
  dtdLabel: (id: string) => (id ? 'DTD_LABEL' : '-'),
  useDtdOptions: () => [],
}));
vi.mock('../style', () => ({
  useStyles: () => ({ styles: { sectionTitle: 'st', mono: 'mono' } }),
}));

import RetrievalEvalRunDetailPage from './detail';

const RUN = {
  eval_run_id: 'run-1',
  bundle_id: 'bundle-1',
  status: 'completed',
  max_k: 10,
  include_stage_trace: true,
  total_cases: 2,
  completed_cases: 2,
  failed_cases: 0,
  created_at: '2026-10-16T00:00:00Z',
  effective_config_snapshot: {},
  metrics: {
    total_cases: 2,
    completed_cases: 2,
    failed_cases: 0,
    hit_count: 1,
    miss_count: 1,
    hit_rate_at_1: 0.5,
    hit_rate_at_5: 0.5,
    hit_rate_at_k: 0.5,
    mrr_at_k: 0.5,
    hit_rate_curve: { '1': 0.5, '5': 0.5, '10': 0.5 },
    retrieved_max: 10,
    by_attempt: {},
  },
};

function caseRow(
  over: Partial<EvalRunCase> & { eval_case_id: string },
): EvalRunCase {
  return {
    question: '占位题',
    chunk_id: 'chunk-1',
    document_type_definition_id: 'dtd-1',
    status: 'completed',
    attempt_no: 1,
    gold_hit: false,
    gold_rank: null,
    gold_chunk_ids: ['g1'],
    retrieved_chunk_ids: [],
    latency_ms: 123,
    ...over,
  };
}

/**
 * 目标 chunk 的正文。
 *
 * `char_count` 用 `length` 算而不是手写常量：手写一个数就会在改正文时
 * 静默过期，而界面正好拿它显示「共 N 字符」。
 */
const CHUNK_CONTENT =
  '合并资产负债表（单位：人民币元）：截至2024年12月31日，公司资产总计128,640,000,000元，负债合计71,830,000,000元。';

const CHUNK: DocumentChunkText = {
  document_chunk_id: 'g1',
  chunk_index: 0,
  content: CHUNK_CONTENT,
  content_truncated: false,
  char_count: CHUNK_CONTENT.length,
  token_count: null,
  start_index: 0,
  end_index: CHUNK_CONTENT.length,
  locator: null,
};

function setup(rows: EvalRunCase[]) {
  seen.tableProps.length = 0;
  getRun.mockResolvedValue(RUN);
  getStageStats.mockResolvedValue({ eval_run_id: 'run-1', stages: [] });
  listRunCases.mockResolvedValue({
    items: rows,
    page: 1,
    page_size: 20,
    total: rows.length,
  });
  getChunk.mockResolvedValue(CHUNK);
  render(
    <App>
      <RetrievalEvalRunDetailPage />
    </App>,
  );
}

/** 等到表格里出现第一行说明数据已到位。 */
async function firstRow(question: string) {
  const cell = await screen.findByText(question);
  const tr = cell.closest('tr');
  if (!tr) throw new Error('没找到行');
  return tr;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('逐题结果表 · 排版', () => {
  it('必须给 scroll.x，否则固定的操作列会盖住 DTD 列', async () => {
    setup([caseRow({ eval_case_id: 'c1', question: '栅格是否重叠' })]);
    await firstRow('栅格是否重叠');

    const scroll = seen.tableProps[0]?.scroll;
    expect(
      scroll?.x,
      'scroll.x 缺失 → 操作列(fixed:right) 会压在 DTD 列上',
    ).toBeTruthy();
    // 定值列之和（92+104+100+88+150+96+110）+ 问题列最小宽度
    expect(scroll.x).toBeGreaterThanOrEqual(740);
  });

  it('DTD 列截断显示并带全称 tooltip，不再撑破列宽', async () => {
    setup([caseRow({ eval_case_id: 'c1', question: 'DTD 有多长' })]);
    const tr = await firstRow('DTD 有多长');
    expect(within(tr).getByText('DTD_LABEL')).toBeTruthy();
  });
});

describe('逐题结果表 · gold rank', () => {
  it('未命中（gold_rank=null）渲染纯文本 —，不残留空标签', async () => {
    setup([
      caseRow({ eval_case_id: 'c1', question: '没命中的题', gold_rank: null }),
      caseRow({
        eval_case_id: 'c2',
        question: '命中的题',
        gold_hit: true,
        gold_rank: 4,
      }),
    ]);

    const missRow = await firstRow('没命中的题');
    expect(within(missRow).getByText('—')).toBeTruthy();
    expect(within(missRow).queryByText(/^#/)).toBeNull();

    const hitRow = await firstRow('命中的题');
    expect(within(hitRow).getByText('#4')).toBeTruthy();
  });

  it('后端/脏数据给了字符串 "-" 时也退化成 —，不会渲染成 "#-" 标签', async () => {
    setup([
      caseRow({
        eval_case_id: 'c1',
        question: '脏数据的题',
        // 类型上不该出现，但旧后端/脏数据确实能送进来 —— 这正是截图里
        // 那个 "#-" 的来源：`#{v}` 把非数字原样拼进标签。
        gold_rank: '-' as unknown as number,
      }),
    ]);

    const tr = await firstRow('脏数据的题');
    expect(within(tr).getByText('—')).toBeTruthy();
    expect(screen.queryByText('#-')).toBeNull();
  });
});

describe('逐题结果表 · 多轮口径', () => {
  it('显示「第 N 轮」：命中=救回它的那一轮，未命中=最后跑的一轮', async () => {
    setup([
      caseRow({
        eval_case_id: 'c1',
        question: '第三轮才找到',
        gold_hit: true,
        gold_rank: 30,
        attempt_no: 3,
      }),
      caseRow({
        eval_case_id: 'c2',
        question: '三轮都没找到',
        gold_hit: false,
        attempt_no: 3,
      }),
    ]);

    expect(
      within(await firstRow('第三轮才找到')).getByText('第 3 轮'),
    ).toBeTruthy();
    expect(
      within(await firstRow('三轮都没找到')).getByText('第 3 轮'),
    ).toBeTruthy();
  });

  it('同一条 case 收到多行（旧后端一轮一行）→ 折叠成一行并提示后端版本', async () => {
    setup([
      caseRow({
        eval_case_id: 'c1',
        question: '重复出现的题',
        gold_hit: false,
        attempt_no: 1,
      }),
      caseRow({
        eval_case_id: 'c1',
        question: '重复出现的题',
        gold_hit: true,
        gold_rank: 30,
        attempt_no: 3,
      }),
      caseRow({
        eval_case_id: 'c1',
        question: '重复出现的题',
        gold_hit: false,
        attempt_no: 2,
      }),
    ]);

    // 折叠：只剩一行，且留下来的是命中那一行
    expect(await screen.findAllByText('重复出现的题')).toHaveLength(1);
    expect(screen.getByText(/已折叠 2 行展示/)).toBeTruthy();
    expect(screen.getByText('第 3 轮')).toBeTruthy();
  });
});

describe('跑测完成后自动拉取逐题结果', () => {
  it('轮询读到终态那一刻自动重发请求，不再停在进页面时的空快照', async () => {
    seen.tableProps.length = 0;
    // 进来时跑测还在跑：逐题结果此刻什么都取不到（case 还没跑完）
    getRun.mockResolvedValue({ ...RUN, status: 'running' });
    getStageStats.mockResolvedValue({ eval_run_id: 'run-1', stages: [] });
    listRunCases.mockResolvedValue({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });

    render(
      <App>
        <RetrievalEvalRunDetailPage />
      </App>,
    );

    // 挂载时表自己发过一次
    await waitFor(() => expect(listRunCases).toHaveBeenCalledTimes(1));

    // 后端那边跑完了，结果也已落库
    getRun.mockResolvedValue({ ...RUN, status: 'completed' });
    listRunCases.mockResolvedValue({
      items: [caseRow({ eval_case_id: 'c1', question: '跑完才出现的题' })],
      page: 1,
      page_size: 20,
      total: 1,
    });

    // 过一个轮询周期（3s）：读到终态 → 轮询停 → 顺手补拉逐题结果
    expect(
      await screen.findByText('跑完才出现的题', undefined, { timeout: 8000 }),
    ).toBeTruthy();
    expect(listRunCases.mock.calls.length).toBeGreaterThanOrEqual(2);
    // 补拉给用户一个明确交代，避免"我没点任何东西，它怎么自己刷了"
    expect(screen.getByText(/已自动拉取最新逐题结果/)).toBeTruthy();
  });

  it('跑测未结束时在标题旁说明「完成后自动拉取」，空表才不会被当成没数据', async () => {
    seen.tableProps.length = 0;
    getRun.mockResolvedValue({ ...RUN, status: 'running' });
    getStageStats.mockResolvedValue({ eval_run_id: 'run-1', stages: [] });
    listRunCases.mockResolvedValue({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });

    render(
      <App>
        <RetrievalEvalRunDetailPage />
      </App>,
    );

    expect(await screen.findByText('跑测进行中，完成后自动拉取')).toBeTruthy();
  });
});

describe('逐题结果表 · 实际查询（2026-10-16 新增）', () => {
  it('改写过的行标「已改写」，未改写的行标「原文」', async () => {
    setup([
      caseRow({
        eval_case_id: 'c1',
        question: '截至2024年12月31日中国平安的资产总计是多少？',
        query_text: '截至2024年12月31日中国平安的资产总计是多少？ 2024-12-31',
        attempt_no: 1,
      }),
      caseRow({
        eval_case_id: 'c2',
        question: '没有日期的题',
        query_text: '没有日期的题',
        attempt_no: 1,
      }),
    ]);

    const rewritten = await firstRow(
      '截至2024年12月31日中国平安的资产总计是多少？',
    );
    expect(within(rewritten).getByText('已改写')).toBeTruthy();

    // 与题干相同 → 说「原文」，不能说「已改写」（改写器可以原样返回）
    const original = await firstRow('没有日期的题');
    expect(within(original).getByText('原文')).toBeTruthy();
  });

  it('query_text 缺失（旧后端）时也显示「原文」，不崩也不编造', async () => {
    setup([caseRow({ eval_case_id: 'c1', question: '旧后端没有这个字段' })]);
    const tr = await firstRow('旧后端没有这个字段');
    expect(within(tr).getByText('原文')).toBeTruthy();
  });

  it('scroll.x = 各定值列之和 + 问题列最小宽（加了新列必须同步）', async () => {
    setup([caseRow({ eval_case_id: 'c1', question: '列宽' })]);
    await firstRow('列宽');

    const scroll = seen.tableProps[0]?.scroll;
    // 92 + 104 + 100(实际查询) + 100 + 88 + 150 + 96 + 110 + 245
    expect(scroll.x).toBe(1085);
  });
});

describe('阶段 trace 抽屉', () => {
  it('抽屉里的「实际查询」随轮次切换 —— 每一轮的改写器不同', async () => {
    const Q = '截至2024年12月31日中国平安的资产总计是多少？';
    setup([caseRow({ eval_case_id: 'c1', question: Q, attempt_no: 1 })]);
    getCaseTrace.mockImplementation(
      async (_run: string, _case: string, attemptNo?: number) => ({
        eval_run_id: 'run-1',
        eval_case_id: 'c1',
        attempt_no: attemptNo ?? 1,
        available_attempts: [1, 2, 3],
        // 第 1 轮不改写（原句）、第 2 轮大模型改写 —— 与内置阶梯同姿态
        query_text: attemptNo === 2 ? `${Q}（同一问题的另一种问法）` : Q,
        gold_chunk_ids: ['g1'],
        stages: [],
      }),
    );

    fireEvent.click(await screen.findByText('阶段 trace'));
    await waitFor(() => {
      expect(getCaseTrace).toHaveBeenCalledWith('run-1', 'c1', 1);
    });

    // 第 1 轮不改写 → 明说"原文"，而不是留空让人猜
    expect(
      await screen.findByText('原文（这一轮没有改动 query）'),
    ).toBeTruthy();

    // 切到第 2 轮 → 必须换成那一轮改写后的句子。
    // 改写不可复现，所以「这段痕迹是哪句话跑出来的」只能靠这一项回答。
    fireEvent.click(await screen.findByText('第 2 轮'));
    expect(
      await screen.findByText(`${Q}（同一问题的另一种问法）`),
    ).toBeTruthy();
  });

  it('按那一行的轮次取，并且能逐轮切换（第 1 轮和第 3 轮参数不同）', async () => {
    setup([
      caseRow({
        eval_case_id: 'c1',
        question: '第三轮才找到',
        gold_hit: true,
        gold_rank: 30,
        attempt_no: 3,
      }),
    ]);
    getCaseTrace.mockResolvedValue({
      eval_run_id: 'run-1',
      eval_case_id: 'c1',
      attempt_no: 3,
      available_attempts: [1, 2, 3],
      gold_chunk_ids: ['g1'],
      stages: [],
    });

    fireEvent.click(await screen.findByText('阶段 trace'));

    // 代表行的轮次先进去 —— 与列表、表头三处一致
    await waitFor(() => {
      expect(getCaseTrace).toHaveBeenCalledWith('run-1', 'c1', 3);
    });

    // 逐轮看：切到第 1 轮必须**重新取**，不能拿第 3 轮的痕迹当它
    fireEvent.click(await screen.findByText('第 1 轮'));
    await waitFor(() => {
      expect(getCaseTrace).toHaveBeenCalledWith('run-1', 'c1', 1);
    });
  });

  it('抽屉里给出目标 chunk 的原文 —— 只看一串 UUID 判断不出"丢得冤不冤"', async () => {
    setup([caseRow({ eval_case_id: 'c1', question: '正文明细' })]);
    getCaseTrace.mockResolvedValue({
      eval_run_id: 'run-1',
      eval_case_id: 'c1',
      attempt_no: 1,
      available_attempts: [1],
      gold_chunk_ids: ['g1'],
      stages: [],
    });

    fireEvent.click(await screen.findByText('阶段 trace'));

    expect(await screen.findByText('target chunk 原文')).toBeTruthy();
    // 金的 id 是按 chunk_id 取的（评测侧没有"版本 + retrieval"那两个 id）
    await waitFor(() => {
      expect(getChunk).toHaveBeenCalledWith('g1');
    });
    expect(await screen.findByText(/合并资产负债表/)).toBeTruthy();
  });
});
