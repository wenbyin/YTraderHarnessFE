// src/pages/retrieval_eval/index.test.tsx
//
// Bundle 列表页的**排版**回归测试。
//
// 起因：一条 bundle 覆盖 8 个 DTD 时，「覆盖 DTD」这一列被 8 个标签竖排撑开，
// **整行的高度由这一列决定**（实测 150px，别的列都是一个短值），标签还会溢出
// 到邻列 —— 用户看到的是「画面不平衡」。表格本身也不报错，所以钉两条：
//   1. 有 `scroll.x`（否则 `valueType:'option'` 的固定列会压在左边的列上）；
//   2. DTD 只平铺一个，其余折成 `+N`，点开能看全。

import { fireEvent, render, screen } from '@testing-library/react';
import { App, Table } from 'antd';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalBundleSummary } from './data';

const listBundles = vi.fn();

const seen = vi.hoisted(() => ({ tableProps: [] as any[] }));

vi.mock('@umijs/max', () => ({
  history: { push: vi.fn() },
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('@ant-design/pro-components', () => ({
  PageContainer: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ProTable: (props: any) => {
    seen.tableProps.push(props);
    const [data, setData] = React.useState<any[]>([]);
    const reqRef = React.useRef(props.request);
    React.useEffect(() => {
      let alive = true;
      reqRef
        .current({ current: 1, pageSize: 20 })
        .then((res: any) => alive && setData(res.data ?? []));
      return () => {
        alive = false;
      };
    }, []);
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

vi.mock('./service', () => ({
  listRetrievalEvalBundles: (...a: unknown[]) => listBundles(...a),
  createRetrievalEvalBundle: vi.fn(),
}));

vi.mock('./dtdOptions', () => ({
  useDtdOptions: () => [],
  dtdLabel: (id: string) => id,
}));

vi.mock('./style', () => ({
  useStyles: () => ({ styles: { mono: 'mono' } }),
}));

vi.mock('./components/BundleCreateModal', () => ({
  default: () => <button type="button">新建 bundle</button>,
}));

import RetrievalEvalBundleListPage from './index';

const DTDS = [
  'COMPANY_EVENT_RISK_COMPLIANCE',
  'COMPANY_EVENT_BUSINESS_DEVELOPMENT',
  'COMPANY_EVENT_MARKET_ACTIVITY',
  'COMPANY_EVENT_CAPITAL_OPERATIONS',
  'COMPANY_EVENT_SHAREHOLDER_GOVERNANCE',
  'COMPANY_EVENT_FINANCIAL_REPORTING',
  'COMPANY_EVENT_INVESTOR_RELATIONS',
  'COMPANY_EVENT_LEGAL_PROCEEDINGS',
];

function bundle(over: Partial<EvalBundleSummary> = {}): EvalBundleSummary {
  return {
    bundle_id: 'bundle-1',
    name: '公司事件',
    status: 'ready',
    document_type_definition_ids: DTDS,
    source_chunk_count: 40,
    case_count: 40,
    dataset_sha256: 'abcdef0123456789',
    created_at: '2026-10-16T16:47:59Z',
    ...over,
  };
}

function setup(items: EvalBundleSummary[]) {
  seen.tableProps.length = 0;
  listBundles.mockResolvedValue({
    items,
    total: items.length,
    page: 1,
    page_size: 20,
  });
  render(
    <App>
      <RetrievalEvalBundleListPage />
    </App>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Bundle 列表 · 排版', () => {
  it('必须给 scroll.x，否则超宽时列会被压回去/内容溢出到邻列', async () => {
    setup([bundle()]);
    await screen.findByText('公司事件');

    const scroll = seen.tableProps[0]?.scroll;
    expect(scroll?.x, 'scroll.x 缺失 → 表格拿不到声明宽度').toBeTruthy();
  });

  it('scroll.x 恒等于列宽之和，且总宽不至于在常见窗口下出现横向滚动', async () => {
    setup([bundle()]);
    await screen.findByText('公司事件');

    const { columns, scroll } = seen.tableProps[0];
    const total = columns.reduce(
      (sum: number, c: any) => sum + (c.width ?? 0),
      0,
    );

    // 「改了列宽忘记同步 scroll.x」= 要么白留一条滚动条，要么列又被压回去
    expect(scroll.x).toBe(total);
    // 实测：1500 宽的窗口下容器约 1085px。超了就要横向滚，而操作列会被推出
    // 可视区 —— 所以设上限，别越改越宽。
    expect(total).toBeLessThanOrEqual(1100);
  });

  it('操作列显式 fixed:right（横向滚动时也能点到「详情」）', async () => {
    setup([bundle()]);
    await screen.findByText('公司事件');

    const op = seen.tableProps[0].columns.find((c: any) => c.title === '操作');
    // ⚠️ `valueType:'option'` 并**不会**自动 fixed —— 实测编译产物里唯一的
    // `fixed:"right"` 来自 ProTable 的列设置菜单。要常驻可点只能显式写。
    expect(op?.fixed).toBe('right');
  });

  it('8 个 DTD 只平铺一个，其余折成 +7 —— 行高不被这一列顶起来', async () => {
    setup([bundle()]);
    const cell = await screen.findByText(DTDS[0]);
    // 只看**这一格**：行里还有「状态」列自己的标签，按行数会数错
    const td = cell.closest('td');
    if (!td) throw new Error('没找到单元格');

    // 这一格里只有 1 个标签 + 1 个 +N（不再是 8 个标签竖排）
    expect(td.querySelectorAll('.ant-tag').length).toBe(2);
    expect(screen.getByText('+7')).toBeTruthy();
    expect(screen.queryByText(DTDS[7])).toBeNull();
  });

  it('被折叠的 DTD 在 +N 里能点开看全', async () => {
    setup([bundle()]);
    fireEvent.click(await screen.findByText('+7'));

    // 浮层里是全部 8 个（含被折叠的那 7 个）
    for (const id of DTDS) {
      const hit = await screen.findAllByText(id);
      expect(hit.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('没有覆盖 DTD 时显示 —，不是空标签', async () => {
    setup([bundle({ document_type_definition_ids: [] })]);
    await screen.findByText('公司事件');
    expect(screen.getByText('—')).toBeTruthy();
  });
});
