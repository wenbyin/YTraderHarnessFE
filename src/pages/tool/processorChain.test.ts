// src/pages/tool/processorChain.test.ts
//
// 这些断言守护的是**与后端对齐的语义**，不是实现细节。改动前先想清楚：
//   - serializeChain 的产出会被 PUT 直接当请求体发出去；
//   - validateOnionFlat 是照抄后端 validate_onion 的栈算法；
//   - resolveDrop 的方向反转来自「退出段逆序渲染」。
import { describe, expect, it } from 'vitest';

import {
  buildTimeline,
  type ChainItem,
  canDrop,
  defaultBind,
  defaultConfig,
  type ProcessorDefinition,
  parseChain,
  resolveDrop,
  rowRegion,
  serializeChain,
  type ToolProcessor,
  validateChain,
  validateOnion,
  validateOnionFlat,
} from './processorChain';

const def = (over: Partial<ProcessorDefinition> = {}): ProcessorDefinition => ({
  key: 'x',
  name: 'X',
  processor_type: 'INTERCEPTOR',
  supported_hooks: ['BEFORE', 'AFTER', 'AROUND'],
  supported_execution_modes: ['SYNC', 'ASYNC'],
  config_schema: {},
  registry_available: true,
  ...over,
});

let seq = 0;
const item = (
  processor_key: string,
  hook: ChainItem['hook'],
  over: Partial<ChainItem> = {},
): ChainItem => {
  seq += 1;
  return {
    uid: `u${seq}`,
    processor_key,
    hook,
    execution_mode: hook === 'AROUND' ? 'SYNC' : 'SYNC',
    config: {},
    enabled: true,
    ...over,
  };
};

const signature = (rows: ReturnType<typeof buildTimeline>) =>
  rows
    .map((r) =>
      r.kind === 'tool' ? 'tool' : `${r.kind}:${r.item?.processor_key}`,
    )
    .join('|');

describe('buildTimeline', () => {
  it('进入段正序、退出段逆序，AFTER 与 AROUND 退出交错', () => {
    const items = [
      item('a', 'AROUND'),
      item('b', 'AROUND'),
      item('c', 'BEFORE'),
      item('x', 'AFTER'),
      item('y', 'AFTER'),
    ];
    // 退出段逆序：y(seq5) 先出、x(seq4) 后出，再是 b、a 的退出
    expect(signature(buildTimeline(items))).toBe(
      'enter:a|enter:b|single:c|tool|single:y|single:x|exit:b|exit:a',
    );
  });

  it('depth = 前面有几个 AROUND，进/退/TOOL 三处统一', () => {
    const items = [
      item('a', 'AROUND'),
      item('b', 'AROUND'),
      item('c', 'BEFORE'),
    ];
    const rows = buildTimeline(items);
    expect(rows.filter((r) => r.kind === 'enter').map((r) => r.depth)).toEqual([
      0, 1,
    ]);
    expect(rows.filter((r) => r.kind === 'exit').map((r) => r.depth)).toEqual([
      1, 0,
    ]);
    expect(rows.find((r) => r.kind === 'tool')?.depth).toBe(2);
    expect(rows.filter((r) => r.kind === 'single').map((r) => r.depth)).toEqual(
      [2],
    );
  });

  it('AFTER 的位置是「可调」的 —— 改 items 顺序，退出段行序必须跟着变', () => {
    const a = item('a', 'AROUND');
    const x = item('x', 'AFTER');
    const y = item('y', 'AFTER');
    const first = signature(buildTimeline([a, x, y]));
    const second = signature(buildTimeline([a, y, x]));
    expect(first).not.toBe(second);
    expect(first).toBe('enter:a|tool|single:y|single:x|exit:a');
    expect(second).toBe('enter:a|tool|single:x|single:y|exit:a');
  });

  it('空链只有 ⟦Tool⟧ 一行', () => {
    expect(signature(buildTimeline([]))).toBe('tool');
  });
});

describe('rowRegion', () => {
  it('AROUND 退出行 / AFTER 单行算退出段，其余算进入段', () => {
    expect(rowRegion('exit', 'AROUND')).toBe('exit');
    expect(rowRegion('single', 'AFTER')).toBe('exit');
    expect(rowRegion('enter', 'AROUND')).toBe('enter');
    expect(rowRegion('single', 'BEFORE')).toBe('enter');
  });
});

describe('serializeChain', () => {
  it('AROUND 落成两条记录（先进 + 后出），行序即落库顺序', () => {
    const items = [
      item('a', 'AROUND'),
      item('c', 'BEFORE'),
      item('x', 'AFTER'),
    ];
    expect(serializeChain(items)).toEqual([
      {
        processor_key: 'a',
        execution_mode: 'SYNC',
        hook: 'AROUND',
        config: {},
        enabled: true,
      },
      {
        processor_key: 'c',
        execution_mode: 'SYNC',
        hook: 'BEFORE',
        config: {},
        enabled: true,
      },
      expect.objectContaining({ processor_key: 'x', hook: 'AFTER' }),
      {
        processor_key: 'a',
        execution_mode: 'SYNC',
        hook: 'AROUND',
        config: {},
        enabled: true,
      },
    ]);
  });
});

describe('parseChain', () => {
  const rec = (
    processor_key: string,
    hook: ToolProcessor['hook'],
  ): ToolProcessor => ({
    id: `${processor_key}-${hook}-${Math.random()}`,
    tool_id: 't',
    processor_key,
    sequence: 1,
    execution_mode: 'SYNC',
    hook,
    config: {},
    enabled: true,
  });

  it('能把后端扁平记录还原成 items（往返一致）', () => {
    const chain = [
      rec('a', 'AROUND'),
      rec('b', 'AROUND'),
      rec('x', 'AFTER'),
      rec('b', 'AROUND'),
      rec('a', 'AROUND'),
    ];
    const { items, ok } = parseChain(chain);
    expect(ok).toBe(true);
    expect(items.map((i) => i.processor_key)).toEqual(['a', 'b', 'x']);
    expect(
      serializeChain(items).map((r) => `${r.processor_key}:${r.hook}`),
    ).toEqual(chain.map((r) => `${r.processor_key}:${r.hook}`));
  });

  it('空链 ok', () => {
    expect(parseChain([])).toEqual({ items: [], ok: true });
  });

  it('AFTER 落在 ⟦Tool⟧ 之前 -> 报 unsupported', () => {
    const { ok, reason } = parseChain([
      rec('x', 'AFTER'),
      rec('a', 'AROUND'),
      rec('a', 'AROUND'),
    ]);
    expect(ok).toBe(false);
    expect(reason).toContain('AFTER');
  });

  it('缺「进入」那一条的 AROUND -> 报 unsupported', () => {
    const { ok } = parseChain([
      rec('a', 'AROUND'),
      rec('a', 'AROUND'),
      rec('a', 'AROUND'),
    ]);
    expect(ok).toBe(false);
  });
});

describe('validateOnionFlat', () => {
  it('嵌套合法', () => {
    expect(
      validateOnionFlat([
        { processor_key: 'a', hook: 'AROUND' },
        { processor_key: 'b', hook: 'AROUND' },
        { processor_key: 'b', hook: 'AROUND' },
        { processor_key: 'a', hook: 'AROUND' },
      ]).ok,
    ).toBe(true);
  });

  it('交叉非法（A B A B）', () => {
    const r = validateOnionFlat([
      { processor_key: 'a', hook: 'AROUND' },
      { processor_key: 'b', hook: 'AROUND' },
      { processor_key: 'a', hook: 'AROUND' },
      { processor_key: 'b', hook: 'AROUND' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.badKey).toBe('b');
    expect(r.outerKey).toBe('a');
  });

  it('只比较相邻区间不够 —— A 包 B、C 从 A 内伸出 A 外也必须抓到', () => {
    const r = validateOnionFlat([
      { processor_key: 'a', hook: 'AROUND' },
      { processor_key: 'b', hook: 'AROUND' },
      { processor_key: 'b', hook: 'AROUND' },
      { processor_key: 'c', hook: 'AROUND' },
      { processor_key: 'a', hook: 'AROUND' },
      { processor_key: 'c', hook: 'AROUND' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.badKey).toBe('c');
  });

  it('只有一条记录的 AROUND 记为 unpaired（后端视作合法中间态）', () => {
    const r = validateOnionFlat([{ processor_key: 'a', hook: 'AROUND' }]);
    expect(r.ok).toBe(true);
    expect(r.unpaired).toEqual(['a']);
    expect(r.aroundCount).toBe(0);
  });
});

describe('validateOnion', () => {
  it('items 模型下洋葱构造性成立 —— 怎么排都不交叉', () => {
    const items = [
      item('a', 'AROUND'),
      item('b', 'AROUND'),
      item('c', 'AROUND'),
    ];
    expect(validateOnion(items).ok).toBe(true);
    expect(validateOnion([items[2], items[0], items[1]]).ok).toBe(true);
  });
});

describe('resolveDrop', () => {
  const defs = new Map<string, ProcessorDefinition>([
    ['both', def({ key: 'both', supported_hooks: ['BEFORE', 'AFTER'] })],
    [
      'beforeOnly',
      def({ key: 'beforeOnly', supported_hooks: ['BEFORE', 'AROUND'] }),
    ],
    ['a', def({ key: 'a', supported_hooks: ['AROUND'] })],
    ['b', def({ key: 'b', supported_hooks: ['AROUND'] })],
  ]);

  it('进入段内换序：hook 不变', () => {
    const a = item('both', 'BEFORE');
    const b = item('both', 'BEFORE');
    const r = resolveDrop([a, b], a.uid, b.uid, true, 'single', defs);
    expect(r.ok).toBe(true);
    expect(r.items.map((i) => i.uid)).toEqual([b.uid, a.uid]);
    expect(r.changed).toBe(false);
  });

  it('拖过 ⟦Tool⟧ 到退出段：hook 自动切成 AFTER', () => {
    const a = item('both', 'BEFORE');
    const x = item('both', 'AFTER');
    const r = resolveDrop([a, x], a.uid, x.uid, false, 'single', defs);
    expect(r.ok).toBe(true);
    expect(r.hook).toBe('AFTER');
    expect(r.changed).toBe(true);
    // 退出段逆序渲染：渲染上排在 x 前面 == 数组里排在 x 后面
    expect(r.items.map((i) => i.uid)).toEqual([x.uid, a.uid]);
  });

  it('目标 hook 不支持 -> 整次拒绝，原数组不动', () => {
    const a = item('beforeOnly', 'BEFORE');
    const x = item('beforeOnly', 'AFTER');
    const items = [a, x];
    const r = resolveDrop(items, a.uid, x.uid, false, 'single', defs);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsupported-hook');
    expect(r.hook).toBe('AFTER');
    expect(r.items).toBe(items);
  });

  it('拖 AROUND 的「退出行」：方向同样反转，且 hook 恒为 AROUND', () => {
    const a = item('a', 'AROUND');
    const b = item('b', 'AROUND');
    const r = resolveDrop([a, b], a.uid, b.uid, false, 'exit', defs);
    expect(r.ok).toBe(true);
    expect(r.hook).toBe('AROUND');
    expect(r.items.map((i) => i.uid)).toEqual([b.uid, a.uid]);
  });

  it('拖到自己身上：顺序还原', () => {
    const a = item('both', 'BEFORE');
    const r = resolveDrop([a], a.uid, a.uid, false, 'single', defs);
    expect(r.items.map((i) => i.uid)).toEqual([a.uid]);
  });

  it('uid 不存在 -> 拒绝', () => {
    const a = item('both', 'BEFORE');
    expect(resolveDrop([a], 'nope', a.uid, false, 'single', defs).ok).toBe(
      false,
    );
    expect(resolveDrop([a], a.uid, 'nope', false, 'single', defs).ok).toBe(
      false,
    );
  });
});

describe('canDrop', () => {
  it('AROUND 两侧都放行；其余只看目标 hook 支不支持', () => {
    const around = item('a', 'AROUND');
    expect(canDrop(around, 'before', def({ key: 'a' }))).toBe(true);
    expect(canDrop(around, 'after', def({ key: 'a' }))).toBe(true);

    const beforeOnly = item('beforeOnly', 'BEFORE');
    expect(
      canDrop(beforeOnly, 'after', def({ supported_hooks: ['BEFORE'] })),
    ).toBe(false);
    expect(
      canDrop(beforeOnly, 'before', def({ supported_hooks: ['BEFORE'] })),
    ).toBe(true);
  });
});

describe('defaultBind / defaultConfig', () => {
  it('能 AROUND 就 AROUND，且 AROUND 强制 SYNC', () => {
    expect(defaultBind(def({ supported_hooks: ['BEFORE', 'AROUND'] }))).toEqual(
      {
        hook: 'AROUND',
        execution_mode: 'SYNC',
      },
    );
    expect(
      defaultBind(
        def({
          supported_hooks: ['AFTER'],
          supported_execution_modes: ['ASYNC'],
        }),
      ),
    ).toEqual({
      hook: 'AFTER',
      execution_mode: 'ASYNC',
    });
  });

  it('config 按 schema 的 default 生成', () => {
    const d = def({
      config_schema: {
        properties: {
          retry_times: { type: 'integer', default: 3 },
          trim: { type: 'boolean', default: true },
          scope: { type: 'string' },
        },
      },
    });
    expect(defaultConfig(d)).toEqual({ retry_times: 3, trim: true, scope: '' });
  });

  /**
   * ⚠️ 回归（2026-10-05 修的真 bug）：数组字段必须初始化成 `[]`，不能是空字符串。
   *
   * pydantic 的 `Field(default_factory=list)` **不产出 default 键**，老实现那三段
   * if 认不出来 → 落到兜底 `out[k] = ''`。于是 `list[str]` 字段初值是 `""`，
   * 用户填完提交上去就是字符串，后端 pydantic 校验必 422
   * —— `AuthConfig.require_roles` 就是这么炸的。
   *
   * 这条测试的价值在于：它断言的是**类型**，不是"默认值好不好看"。
   */
  it('数组字段初始化为 []，不是空字符串', () => {
    const d = def({
      config_schema: {
        properties: {
          // 形态照抄 pydantic：default_factory=list 没有 default 键
          require_roles: { type: 'array', items: { type: 'string' } },
          // 显式给了 default 的仍然以 default 为准
          tags: { type: 'array', items: { type: 'string' }, default: ['a'] },
        },
      },
    });
    const cfg = defaultConfig(d);
    expect(Array.isArray(cfg.require_roles)).toBe(true);
    expect(cfg.require_roles).toEqual([]);
    expect(cfg.tags).toEqual(['a']);
  });
});

describe('validateChain', () => {
  const defs = new Map<string, ProcessorDefinition>([
    [
      'a',
      def({
        key: 'a',
        supported_hooks: ['AROUND'],
        supported_execution_modes: ['SYNC'],
      }),
    ],
    [
      'b',
      def({
        key: 'b',
        supported_hooks: ['BEFORE', 'AFTER'],
        supported_execution_modes: ['SYNC', 'ASYNC'],
      }),
    ],
  ]);

  it('全绿的链', () => {
    const res = validateChain([item('a', 'AROUND')], defs);
    expect(res.filter((c) => c.level === 'bad')).toHaveLength(0);
  });

  it('AROUND + ASYNC -> bad', () => {
    const res = validateChain(
      [item('a', 'AROUND', { execution_mode: 'ASYNC' })],
      defs,
    );
    expect(res[0].level).toBe('bad');
    expect(res[0].text).toContain('ck_tool_processor_around_sync');
  });

  it('同一个 processor_key 挂两个 AROUND -> bad（洋葱校验以 key 作区间标识，会折叠区间）', () => {
    const res = validateChain([item('a', 'AROUND'), item('a', 'AROUND')], defs);
    expect(res.some((c) => c.level === 'bad' && c.text.includes('重复'))).toBe(
      true,
    );
  });

  it('同一个 key 挂 BEFORE + AFTER 各一次 -> 合法（比如隐私过滤前置后置各滤一遍）', () => {
    const res = validateChain([item('b', 'BEFORE'), item('b', 'AFTER')], defs);
    expect(res.filter((c) => c.level === 'bad')).toHaveLength(0);
    expect(res.some((c) => c.text.includes('允许同一 key 挂多次'))).toBe(true);
  });

  it('注册表里已不存在 -> warn 而不是 bad（不阻断，但提示保存会 404）', () => {
    const res = validateChain([item('gone', 'BEFORE')], defs);
    expect(
      res.some(
        (c) => c.level === 'warn' && c.text.includes('注册表中已不存在'),
      ),
    ).toBe(true);
  });
});
