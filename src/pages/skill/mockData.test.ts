// src/pages/skill/mockData.test.ts
//
// mock 存在的意义不是"让页面有东西显示"，而是**照契约把语义钉住**，
// 这样 UAT 时点出来的行为就是接口上线后的行为。所以这里测的是契约，
// 不是实现细节：
//
//   · 列表项里**没有** instructions / examples / capabilities（SkillSummary 就是这么
//     定义的，examples 只在 SkillDetail 上）；
//   · skill_key 重复 → 409，格式非法 → 422；
//   · 能力绑定是 **PUT 全量替换**，不是增量；
//   · tags / examples 的 PATCH 语义是"不传 = 不改、传 [] = 清空"；
//   · 删掉之后详情 404。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MockApiError,
  mockCapabilities,
  mockCreateSkill,
  mockDeleteSkill,
  mockGetSkill,
  mockListSkills,
  mockPatchSkill,
  mockReplaceCapabilities,
  resetMockSkills,
} from './mockData';

beforeEach(() => {
  resetMockSkills();
});

/** 断言抛出的确实是 MockApiError 且状态码对得上。 */
function expectApiError(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MockApiError);
    expect((error as MockApiError).status).toBe(status);
    return;
  }
  throw new Error(`期望抛 ${status}，实际没有抛`);
}

describe('mockListSkills', () => {
  it('列表项只有 SkillSummary 的字段，不带 instructions / examples / capabilities', () => {
    const page = mockListSkills({ page_size: 50 });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item).not.toHaveProperty('instructions');
      expect(item).not.toHaveProperty('examples');
      expect(item).not.toHaveProperty('capabilities');
      // tags 在 SkillSummary 上（A2A 标准必填，允许空数组）
      expect(Array.isArray(item.tags)).toBe(true);
      expect(item.skill_key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('按状态过滤；未指定时返回全部', () => {
    const all = mockListSkills({ page_size: 100 });
    const active = mockListSkills({ status: 'ACTIVE', page_size: 100 });
    const draft = mockListSkills({ status: 'DRAFT', page_size: 100 });
    const disabled = mockListSkills({ status: 'DISABLED', page_size: 100 });

    expect(active.total + draft.total + disabled.total).toBe(all.total);
    expect(active.items.every((item) => item.status === 'ACTIVE')).toBe(true);
    expect(disabled.items.every((item) => item.status === 'DISABLED')).toBe(
      true,
    );
  });

  it('关键词同时命中 skill_key / 名称 / 描述', () => {
    const byKey = mockListSkills({ q: 'query_rewrite', page_size: 100 });
    expect(byKey.items.map((item) => item.skill_key)).toEqual([
      'query_rewrite',
    ]);

    const byName = mockListSkills({ q: '表格结构化', page_size: 100 });
    expect(byName.items.map((item) => item.skill_key)).toEqual([
      'table_extract',
    ]);

    // 只出现在描述里的词
    const byDesc = mockListSkills({ q: 'MRR', page_size: 100 });
    expect(byDesc.total).toBeGreaterThan(0);

    // tags 不参与关键词 —— 后端列表搜索只覆盖 skill_key / 名称 / 描述。
    // 页面上的搜索框文案也必须与这一条一致，否则用户会以为搜不到是 bug。
    expect(mockListSkills({ q: 'legal', page_size: 100 }).total).toBe(0);
  });

  it('按能力过滤走的是"已绑定"，不是"能力树可达"', () => {
    const caps = mockCapabilities();
    const ocr = caps.find((item) => item.code === 'ocr.text');
    const retrievalRoot = caps.find((item) => item.code === 'retrieval');
    expect(ocr && retrievalRoot).toBeTruthy();

    const byOcr = mockListSkills({ capability_id: ocr?.id, page_size: 100 });
    expect(byOcr.items.map((item) => item.skill_key)).toEqual(['image_ocr']);

    // 绑的是 retrieval.search，不是父级 retrieval —— 精确匹配，父级查不到
    const byRoot = mockListSkills({
      capability_id: retrievalRoot?.id,
      page_size: 100,
    });
    expect(byRoot.total).toBe(0);
  });

  it('按 updated_at 倒序（最近动过的在最前面）', () => {
    const items = mockListSkills({ page_size: 100 }).items;
    const times = items.map((item) => item.updated_at);
    expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times);
  });
});

describe('create / patch / delete', () => {
  it('创建时 status 默认 DRAFT，且初始没有绑定', () => {
    const created = mockCreateSkill({
      skill_key: 'brand_new',
      name: '新技能',
      description: '描述',
      instructions: '提示词',
    });
    expect(created.status).toBe('DRAFT');
    expect(created.capabilities).toEqual([]);
    // 省略 tags / examples 等于空数组（后端的 default_factory=list），不是 undefined
    expect(created.tags).toEqual([]);
    expect(created.examples).toEqual([]);
  });

  it('创建时带上 tags / examples 会原样落库', () => {
    const created = mockCreateSkill({
      skill_key: 'tagged_skill',
      name: '带标签的技能',
      description: '描述',
      instructions: '提示词',
      tags: ['legal', 'review'],
      examples: ['这份合同缺哪些条款？'],
    });
    expect(created.tags).toEqual(['legal', 'review']);
    expect(created.examples).toEqual(['这份合同缺哪些条款？']);
  });

  it('skill_key 重复 → 409', () => {
    expectApiError(
      () =>
        mockCreateSkill({
          skill_key: 'doc_qa_retrieval',
          name: '重名',
          description: '描述',
          instructions: '提示词',
        }),
      409,
    );
  });

  it('skill_key 格式非法 → 422', () => {
    expectApiError(
      () =>
        mockCreateSkill({
          skill_key: 'Doc-QA',
          name: '非法 key',
          description: '描述',
          instructions: '提示词',
        }),
      422,
    );
  });

  it('PATCH 只改传入的字段，其余保持不变', () => {
    const id = mockListSkills({ q: 'doc_qa_retrieval' }).items[0].id;
    const before = mockGetSkill(id);
    const after = mockPatchSkill(id, { status: 'DISABLED' });

    expect(after.status).toBe('DISABLED');
    expect(after.name).toBe(before.name);
    expect(after.instructions).toBe(before.instructions);
    expect(after.capabilities).toEqual(before.capabilities);
    // 不传 tags / examples = 不改
    expect(after.tags).toEqual(before.tags);
    expect(after.examples).toEqual(before.examples);
  });

  it('PATCH tags / examples：传了就是整体替换，传 [] 就是清空', () => {
    const id = mockListSkills({ q: 'contract_review' }).items[0].id;
    expect(mockGetSkill(id).tags.length).toBeGreaterThan(1);

    const replaced = mockPatchSkill(id, {
      tags: ['legal'],
      examples: ['换一条示例'],
    });
    expect(replaced.tags).toEqual(['legal']);
    expect(replaced.examples).toEqual(['换一条示例']);

    const cleared = mockPatchSkill(id, { tags: [], examples: [] });
    expect(cleared.tags).toEqual([]);
    expect(cleared.examples).toEqual([]);
  });

  it('删除后详情 404', () => {
    const id = mockListSkills({ q: 'doc_summarize' }).items[0].id;
    mockDeleteSkill(id);
    expectApiError(() => mockGetSkill(id), 404);
  });
});

describe('能力绑定是 PUT 全量替换', () => {
  it('传一项就只剩一项 —— 不是增量追加', () => {
    const id = mockListSkills({ q: 'doc_qa_retrieval' }).items[0].id;
    const before = mockGetSkill(id).capabilities;
    expect(before.length).toBeGreaterThan(1);

    const llm = mockCapabilities().find((item) => item.code === 'llm.chat');
    const after = mockReplaceCapabilities(id, [llm?.id as string]);

    expect(after.map((item) => item.code)).toEqual(['llm.chat']);
    expect(mockGetSkill(id).capabilities.map((item) => item.code)).toEqual([
      'llm.chat',
    ]);
  });

  it('空数组 = 清空绑定', () => {
    const id = mockListSkills({ q: 'doc_summarize' }).items[0].id;
    expect(mockReplaceCapabilities(id, [])).toEqual([]);
    expect(mockGetSkill(id).capabilities).toEqual([]);
  });

  it('去重：同一个 id 传两次只落一条', () => {
    const id = mockListSkills({ q: 'doc_summarize' }).items[0].id;
    const llm = mockCapabilities().find((item) => item.code === 'llm.chat');
    const after = mockReplaceCapabilities(id, [
      llm?.id as string,
      llm?.id as string,
    ]);
    expect(after.length).toBe(1);
  });

  it('不存在的 capability_id → 422', () => {
    const id = mockListSkills({ q: 'doc_summarize' }).items[0].id;
    expectApiError(
      () =>
        mockReplaceCapabilities(id, ['00000000-0000-0000-0000-000000000000']),
      422,
    );
  });

  it('不存在的 skill → 404', () => {
    expectApiError(() => mockReplaceCapabilities('nope', []), 404);
  });
});

describe('mockCapabilities', () => {
  it('返回扁平列表（靠 parent_id 建树），并且包含一个已停用项', () => {
    const caps = mockCapabilities();
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((item) => typeof item.parent_id !== 'undefined')).toBe(
      true,
    );
    expect(caps.filter((item) => item.is_active === false).length).toBe(1);
  });

  it('返回的是副本：改返回值不会污染内部字典', () => {
    const first = mockCapabilities();
    first[0].name = '被改了';
    expect(mockCapabilities()[0].name).not.toBe('被改了');
  });
});
