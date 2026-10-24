// src/pages/skill/components/SkillDrawer.test.tsx
//
// 这一组测的不是"抽屉能打开"，而是三个**会让后端直接 422 的提交行为**：
//
//   1. 什么都没改就点保存 → 不发 PATCH（SkillPatch 有 minProperties: 1，{} 是 422），
//      也不发 PUT 绑定；
//   2. 只改名称 → PATCH 里**只有** name，绝不能顺手带上 skill_key
//      （契约里没有这个字段，additionalProperties: false）；
//   3. 绑定没变 → 不发 PUT（全量替换接口，多发一次等于重写一遍）。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capability, SkillCreate, SkillDetail, SkillPatch } from '../data';

const DETAIL: SkillDetail = {
  id: 's1',
  skill_key: 'doc_qa_retrieval',
  name: '文档检索问答',
  description: '面向文档库的多轮检索问答。',
  tags: ['document', 'qa'],
  examples: ['这份年报里营收增长来自哪块业务？', '上一轮提到的风险有更新吗？'],
  instructions: '你是文档问答子 agent。\n1. 先改写查询。',
  status: 'ACTIVE',
  created_at: '2026-10-18T02:00:00Z',
  updated_at: '2026-10-19T02:00:00Z',
  capabilities: [
    { id: 'c1', code: 'retrieval.search', name: '全文召回' },
    { id: 'c2', code: 'llm.chat', name: '对话生成' },
  ],
};

const CAPS: Capability[] = [
  { id: 'c1', code: 'retrieval.search', name: '全文召回', parent_id: null },
  { id: 'c2', code: 'llm.chat', name: '对话生成', parent_id: null },
  {
    id: 'c3',
    code: 'ocr.text',
    name: '文字识别',
    parent_id: null,
    is_active: false,
  },
];

const getSkill = vi.fn(async (_id?: string) => DETAIL);
const updateSkill = vi.fn(async (_id?: string, _body?: SkillPatch) => ({
  ...DETAIL,
  name: '新名字',
}));
const replaceSkillCapabilities = vi.fn(
  async (_id?: string, _ids?: string[]) => DETAIL.capabilities,
);
const createSkill = vi.fn(async (body?: SkillCreate) => ({
  ...DETAIL,
  id: 's2',
  skill_key: body?.skill_key ?? 'new_skill',
  name: body?.name ?? '新技能',
  capabilities: [],
}));
const deleteSkill = vi.fn(async (_id?: string) => undefined);

vi.mock('../service', () => ({
  getSkill: (...a: unknown[]) => getSkill(...(a as [string])),
  updateSkill: (...a: unknown[]) => updateSkill(...(a as [string, SkillPatch])),
  replaceSkillCapabilities: (...a: unknown[]) =>
    replaceSkillCapabilities(...(a as [string, string[]])),
  createSkill: (...a: unknown[]) => createSkill(...(a as [SkillCreate])),
  deleteSkill: (...a: unknown[]) => deleteSkill(...(a as [string])),
  // 抽屉只在 catch 里用它，测试里给个能读的兜底就够了
  skillErrorMessage: (error: unknown, fallback = '操作失败') =>
    error instanceof Error ? error.message : fallback,
  USE_MOCK_SKILL: true,
}));

import SkillDrawer from './SkillDrawer';

/** antd v6 会给两个汉字的按钮插空格（`保 存`），比对前先抹掉空白。 */
const normText = (s: string | null | undefined) =>
  (s ?? '').replace(/\s+/g, '');

const btn = (text: string) => {
  const found = Array.from(document.querySelectorAll('button')).find(
    (item) => normText(item.textContent) === text,
  );
  if (!found) throw new Error(`找不到按钮「${text}」`);
  return found as HTMLElement;
};

const field = (name: string) =>
  document.querySelector(`#${name}`) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;

const renderDrawer = (skillId: string | null, onSaved = vi.fn()) =>
  render(
    <App>
      <SkillDrawer
        open
        skillId={skillId}
        capabilities={CAPS}
        onClose={vi.fn()}
        onSaved={onSaved}
        onDeleted={vi.fn()}
      />
    </App>,
  );

/** 等详情灌进表单（名称输入框有值即视为加载完成）。 */
const waitForDetail = () =>
  waitFor(() => {
    expect(field('name')?.value).toBe('文档检索问答');
  });

describe('SkillDrawer', () => {
  beforeEach(() => {
    getSkill.mockClear();
    updateSkill.mockClear();
    replaceSkillCapabilities.mockClear();
    createSkill.mockClear();
    deleteSkill.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('打开时拉一次详情，字段全部灌进表单（skill_key 只读）', async () => {
    renderDrawer('s1');
    await waitForDetail();

    expect(getSkill).toHaveBeenCalledWith('s1');
    expect(field('description')?.value).toBe('面向文档库的多轮检索问答。');
    expect(field('instructions')?.value).toContain('先改写查询');
    expect(field('skill_key')?.value).toBe('doc_qa_retrieval');
    expect(field('skill_key')?.disabled).toBe(true);
  });

  it('examples 灌进表单时是「一行一条」，不是 JSON 串', async () => {
    renderDrawer('s1');
    await waitForDetail();

    expect(field('examples')?.value).toBe(
      '这份年报里营收增长来自哪块业务？\n上一轮提到的风险有更新吗？',
    );
  });

  it('tags 以 chip 形式回显', async () => {
    renderDrawer('s1');
    await waitForDetail();

    expect(screen.getByText('document')).toBeTruthy();
    expect(screen.getByText('qa')).toBeTruthy();
  });

  it('⭐ 什么都没改就保存：不发 PATCH（空对象会 422）、不发 PUT', async () => {
    const onSaved = vi.fn();
    renderDrawer('s1', onSaved);
    await waitForDetail();

    fireEvent.click(btn('保存'));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect(updateSkill).not.toHaveBeenCalled();
    expect(replaceSkillCapabilities).not.toHaveBeenCalled();
  });

  it('⭐ 只改名称：PATCH 里只有 name，不带 skill_key / status', async () => {
    const onSaved = vi.fn();
    renderDrawer('s1', onSaved);
    await waitForDetail();

    fireEvent.change(field('name') as HTMLInputElement, {
      target: { value: '新名字' },
    });
    fireEvent.click(btn('保存'));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledTimes(1);
    });

    const [id, body] = updateSkill.mock.calls[0];
    expect(id).toBe('s1');
    expect(body).toEqual({ name: '新名字' });
    expect(body).not.toHaveProperty('skill_key');
    expect(body).not.toHaveProperty('status');
  });

  it('绑定没变时不会顺手重写一遍绑定', async () => {
    const onSaved = vi.fn();
    renderDrawer('s1', onSaved);
    await waitForDetail();

    fireEvent.change(field('description') as HTMLTextAreaElement, {
      target: { value: '改过的描述' },
    });
    fireEvent.click(btn('保存'));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledTimes(1);
    });
    expect(updateSkill.mock.calls[0][1]).toEqual({ description: '改过的描述' });
    expect(replaceSkillCapabilities).not.toHaveBeenCalled();
  });

  it('改 examples：文本按行拆成数组，且只发 examples', async () => {
    const onSaved = vi.fn();
    renderDrawer('s1', onSaved);
    await waitForDetail();

    fireEvent.change(field('examples') as HTMLTextAreaElement, {
      target: { value: '  第一句  \n\n第二句' },
    });
    fireEvent.click(btn('保存'));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledTimes(1);
    });
    // 空行丢掉、首尾空白去掉，顺序保持
    expect(updateSkill.mock.calls[0][1]).toEqual({
      examples: ['第一句', '第二句'],
    });
  });

  it('⭐ 清空 examples：必须发 examples: []（后端"不传"等于"不改"）', async () => {
    const onSaved = vi.fn();
    renderDrawer('s1', onSaved);
    await waitForDetail();

    fireEvent.change(field('examples') as HTMLTextAreaElement, {
      target: { value: '' },
    });
    fireEvent.click(btn('保存'));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledTimes(1);
    });
    // 不发的话后端永远不会清空 —— 这正是这个字段最容易写错的地方
    expect(updateSkill.mock.calls[0][1]).toEqual({ examples: [] });
  });

  it('新建模式：skill_key 可编辑，创建后不回填详情', async () => {
    const onSaved = vi.fn();
    renderDrawer(null, onSaved);

    expect(getSkill).not.toHaveBeenCalled();
    expect(field('skill_key')?.disabled).toBe(false);

    fireEvent.change(field('skill_key') as HTMLInputElement, {
      target: { value: 'new_skill' },
    });
    fireEvent.change(field('name') as HTMLInputElement, {
      target: { value: '新技能' },
    });
    fireEvent.change(field('description') as HTMLTextAreaElement, {
      target: { value: '描述' },
    });
    fireEvent.change(field('instructions') as HTMLTextAreaElement, {
      target: { value: '提示词' },
    });
    fireEvent.click(btn('创建'));

    await waitFor(() => {
      expect(createSkill).toHaveBeenCalledTimes(1);
    });
    expect(createSkill.mock.calls[0][0]).toMatchObject({
      skill_key: 'new_skill',
      name: '新技能',
      description: '描述',
      instructions: '提示词',
      status: 'DRAFT',
      // 没填 A2A 元数据也要发空数组（不是 undefined）—— 与后端
      // default_factory=list 对齐，日志里能看出"用户就是没填"
      tags: [],
      examples: [],
    });
    // 新建时没绑能力 → 不该发 PUT（PUT 空数组是"清空"，对新建对象没意义）
    expect(replaceSkillCapabilities).not.toHaveBeenCalled();
  });

  it('新增 tag：回车确认后进表单，提交时只发 tags', async () => {
    const onSaved = vi.fn();
    renderDrawer('s1', onSaved);
    await waitForDetail();

    const input = field('tags') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: 'legal' } });
    // rc-select 在 tags 模式下用 which/keyCode 判断回车
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 });

    fireEvent.click(btn('保存'));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledTimes(1);
    });
    expect(updateSkill.mock.calls[0][1]).toEqual({
      tags: ['document', 'qa', 'legal'],
    });
  });

  it('skill_key 格式非法时挡住提交', async () => {
    renderDrawer(null);
    fireEvent.change(field('skill_key') as HTMLInputElement, {
      target: { value: 'Bad-Key' },
    });
    fireEvent.change(field('name') as HTMLInputElement, {
      target: { value: '新技能' },
    });
    fireEvent.change(field('description') as HTMLTextAreaElement, {
      target: { value: '描述' },
    });
    fireEvent.change(field('instructions') as HTMLTextAreaElement, {
      target: { value: '提示词' },
    });
    fireEvent.click(btn('创建'));

    await waitFor(() => {
      expect(screen.getByText(/小写字母开头/)).toBeTruthy();
    });
    expect(createSkill).not.toHaveBeenCalled();
  });
});
