// src/pages/skill/data.test.ts
//
// 钉住三个"后端约束的前端镜像"：
//   1. skill_key 的正则必须和后端 CHECK 约束逐字一致（前端先挡住，用户不用猜 422）；
//   2. capabilityPath 要能拼出祖先路径，脏数据成环时也不能把页面转死；
//   3. 时间格式化的边界（刚改完显示"刚刚"而不是"0 分钟前"）。
import { describe, expect, it } from 'vitest';
import type { Capability } from './data';
import {
  buildTree,
  capabilityPath,
  formatDateTime,
  formatExamples,
  formatUpdatedAt,
  normalizeTags,
  parseExamples,
  SKILL_KEY_PATTERN,
  SKILL_STATUS_META,
  SKILL_STATUS_ORDER,
  sameStringList,
  skillKeyError,
  toSummary,
} from './data';

const CAPS: Capability[] = [
  { id: 'c1', code: 'retrieval', name: '检索', parent_id: null },
  { id: 'c2', code: 'retrieval.search', name: '全文召回', parent_id: 'c1' },
  { id: 'c3', code: 'retrieval.search.deep', name: '深召回', parent_id: 'c2' },
  // 父节点缺失：脏数据 / 越权看不见父级
  { id: 'c9', code: 'orphan', name: '孤儿', parent_id: 'missing' },
];

describe('skill_key 校验', () => {
  it('正则与后端 CHECK 约束一致：小写字母开头、2~120 字符', () => {
    expect(SKILL_KEY_PATTERN.test('doc_qa_retrieval')).toBe(true);
    expect(SKILL_KEY_PATTERN.test('ab')).toBe(true);
    // 单字符不行（{1,119} 表示至少 2 位）
    expect(SKILL_KEY_PATTERN.test('a')).toBe(false);
    // 大写 / 中划线 / 点 / 空格 都不行
    expect(SKILL_KEY_PATTERN.test('Doc_QA')).toBe(false);
    expect(SKILL_KEY_PATTERN.test('doc-qa')).toBe(false);
    expect(SKILL_KEY_PATTERN.test('doc.qa')).toBe(false);
    expect(SKILL_KEY_PATTERN.test(' doc_qa')).toBe(false);
    // 数字开头不行
    expect(SKILL_KEY_PATTERN.test('1doc')).toBe(false);
    // 长度边界：120 可以，121 不行
    expect(SKILL_KEY_PATTERN.test(`a${'b'.repeat(119)}`)).toBe(true);
    expect(SKILL_KEY_PATTERN.test(`a${'b'.repeat(120)}`)).toBe(false);
  });

  it('skillKeyError 给出可直接展示的文案', () => {
    expect(skillKeyError('doc_qa')).toBeNull();
    // 前后空白会被 trim 掉，不是错误
    expect(skillKeyError('  doc_qa  ')).toBeNull();
    expect(skillKeyError('   ')).toContain('请填写');
    expect(skillKeyError('Doc_QA')).toContain('小写字母');
  });
});

describe('capabilityPath', () => {
  it('拼出「父 / 子」路径，一级能力就是自己', () => {
    expect(capabilityPath(CAPS, 'c1')).toBe('检索');
    expect(capabilityPath(CAPS, 'c2')).toBe('检索 / 全文召回');
    expect(capabilityPath(CAPS, 'c3')).toBe('检索 / 全文召回 / 深召回');
  });

  it('父节点缺失时不丢节点，只显示自己', () => {
    expect(capabilityPath(CAPS, 'c9')).toBe('孤儿');
  });

  it('id 不存在时返回空串（调用方用 name 兜底）', () => {
    expect(capabilityPath(CAPS, 'nope')).toBe('');
  });

  it('脏数据成环时不死循环', () => {
    const cyclic: Capability[] = [
      { id: 'a', code: 'a', name: 'A', parent_id: 'b' },
      { id: 'b', code: 'b', name: 'B', parent_id: 'a' },
    ];
    const path = capabilityPath(cyclic, 'a');
    // 只要求"返回了、没挂"，具体截断在哪一层不重要
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('buildTree', () => {
  it('按 parent_id 建树；孤儿（父缺失）当顶级处理，不丢节点', () => {
    const tree = buildTree(CAPS);
    // 两个一级：检索 + 孤儿
    expect(tree.map((item) => item.node.id).sort()).toEqual(['c1', 'c9']);
    const retrieval = tree.find((item) => item.node.id === 'c1');
    expect(retrieval?.children.map((item) => item.node.id).sort()).toEqual([
      'c2',
    ]);
    // 二级下面还有三级
    const search = retrieval?.children.find((item) => item.node.id === 'c2');
    expect(search?.children.map((item) => item.node.id)).toEqual(['c3']);
  });

  it('兄弟按 sort_order 再按 code 排序 —— 勾选后重渲染不能跳行', () => {
    const list: Capability[] = [
      { id: 'b', code: 'b', name: 'B', parent_id: null, sort_order: 2 },
      { id: 'a', code: 'a', name: 'A', parent_id: null, sort_order: 1 },
      { id: 'z', code: 'z', name: 'Z', parent_id: null },
      { id: 'y', code: 'y', name: 'Y', parent_id: null },
    ];
    // 没给 sort_order 的按 0 处理（与工具页 buildTree 一致），所以排在最前；
    // 同为 0 的两个再按 code：y < z。
    expect(buildTree(list).map((item) => item.node.id)).toEqual([
      'y',
      'z',
      'a',
      'b',
    ]);
  });

  it('空列表 → 空树', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('时间格式化', () => {
  const now = new Date('2026-10-20T12:00:00+08:00').getTime();
  const at = (minutesAgo: number) =>
    new Date(now - minutesAgo * 60_000).toISOString();

  it('一分钟内显示「刚刚」，避免出现「0 分钟前」', () => {
    expect(formatUpdatedAt(at(0), now)).toBe('刚刚');
    expect(formatUpdatedAt(at(0.4), now)).toBe('刚刚');
  });

  it('分级：分钟 → 小时 → 天', () => {
    expect(formatUpdatedAt(at(5), now)).toBe('5 分钟前');
    expect(formatUpdatedAt(at(59), now)).toBe('59 分钟前');
    expect(formatUpdatedAt(at(120), now)).toBe('2 小时前');
    expect(formatUpdatedAt(at(60 * 24 * 3), now)).toBe('3 天前');
  });

  it('非法输入退化成占位符，不抛异常', () => {
    expect(formatUpdatedAt('not-a-date', now)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('状态口径', () => {
  it('三种状态都有展示文案，且顺序稳定', () => {
    for (const status of SKILL_STATUS_ORDER) {
      expect(SKILL_STATUS_META[status].label.length).toBeGreaterThan(0);
      expect(SKILL_STATUS_META[status].hint.length).toBeGreaterThan(0);
    }
    expect(SKILL_STATUS_ORDER).toEqual(['ACTIVE', 'DRAFT', 'DISABLED']);
  });
});

describe('toSummary', () => {
  it('丢掉 instructions / capabilities / examples —— 列表里本来就没有这几个字段', () => {
    const summary = toSummary({
      id: 's1',
      skill_key: 'doc_qa',
      name: '文档问答',
      description: '描述',
      tags: ['document', 'qa'],
      examples: ['这份合同里的违约金上限是多少？'],
      status: 'ACTIVE',
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T01:00:00Z',
      instructions: '很长的提示词',
      capabilities: [{ id: 'c1', code: 'retrieval', name: '检索' }],
    });
    expect(Object.keys(summary).sort()).toEqual([
      'created_at',
      'description',
      'id',
      'name',
      'skill_key',
      'status',
      'tags',
      'updated_at',
    ]);
    // tags 在 SkillSummary 上，要带过去；其余三个只在 SkillDetail 上
    expect(summary.tags).toEqual(['document', 'qa']);
    expect(summary).not.toHaveProperty('instructions');
    expect(summary).not.toHaveProperty('examples');
    expect(summary).not.toHaveProperty('capabilities');
  });
});

describe('A2A 元数据的表单转换', () => {
  it('examples：一行一条，空行与首尾空白都丢掉', () => {
    expect(parseExamples('第一句\n\n  第二句  \n')).toEqual([
      '第一句',
      '第二句',
    ]);
    expect(parseExamples('')).toEqual([]);
    expect(parseExamples('   \n \n')).toEqual([]);
  });

  it('examples：数组 ↔ 文本互逆（去掉空行后）', () => {
    const list = [
      '这份合同里的违约金上限是多少？',
      '有没有和付款周期冲突的条款？',
    ];
    expect(parseExamples(formatExamples(list))).toEqual(list);
    expect(formatExamples([])).toBe('');
  });

  it('tags：去空白、去空项、去重，保持用户输入的顺序', () => {
    expect(normalizeTags(['  legal ', 'legal', '', 'contract', '  '])).toEqual([
      'legal',
      'contract',
    ]);
    // 不同大小写视为不同标签 —— 后端也不做归一化，前端别自作聪明
    expect(normalizeTags(['Legal', 'legal'])).toEqual(['Legal', 'legal']);
    expect(normalizeTags([])).toEqual([]);
  });

  it('sameStringList：顺序敏感 —— 用户调了顺序就该原样提交', () => {
    expect(sameStringList(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameStringList(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameStringList([], [])).toBe(true);
    expect(sameStringList(['a'], ['a', 'b'])).toBe(false);
  });
});
