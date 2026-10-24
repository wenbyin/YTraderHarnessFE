// src/pages/skill/components/SkillCard.test.tsx
//
// 卡片最容易悄悄丢掉的是"没有绑定 = 没有工具"这件事 —— 它长得像一句
// "暂无数据"，但实际后果是子 agent 跑起来什么都调不了。所以这里把它钉住。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityRef, SkillSummary } from '../data';
import SkillCard from './SkillCard';

const SKILL: SkillSummary = {
  id: 's1',
  skill_key: 'doc_qa_retrieval',
  name: '文档检索问答',
  description: '面向文档库的多轮检索问答，回答必须带来源引用。',
  tags: ['document', 'qa'],
  status: 'ACTIVE',
  created_at: '2026-10-18T02:00:00Z',
  updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
};

const cap = (n: number): CapabilityRef => ({
  id: `c${n}`,
  code: `cap.${n}`,
  name: `能力${n}`,
});

const renderCard = (
  props: Partial<React.ComponentProps<typeof SkillCard>> = {},
) =>
  render(
    <SkillCard
      skill={SKILL}
      capabilities={[]}
      inactiveIds={new Set<string>()}
      onOpen={vi.fn()}
      {...props}
    />,
  );

afterEach(() => {
  cleanup();
});

describe('SkillCard', () => {
  it('展示名称、skill_key、描述、状态文案', () => {
    renderCard();
    expect(screen.getByText('文档检索问答')).toBeTruthy();
    expect(screen.getByText('doc_qa_retrieval')).toBeTruthy();
    expect(screen.getByText(/面向文档库的多轮检索问答/)).toBeTruthy();
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('更新于 2 小时前')).toBeTruthy();
  });

  it('草稿 / 停用 用各自的标签文案', () => {
    const { unmount } = renderCard({ skill: { ...SKILL, status: 'DRAFT' } });
    expect(screen.getByText('草稿')).toBeTruthy();
    unmount();

    renderCard({ skill: { ...SKILL, status: 'DISABLED' } });
    expect(screen.getByText('已停用')).toBeTruthy();
  });

  it('⭐ 没有绑定能力时说的是后果，不是"暂无"', () => {
    renderCard({ capabilities: [] });
    expect(screen.getByText('未绑能力 · 无工具可用')).toBeTruthy();
    expect(screen.getByText('0 项能力')).toBeTruthy();
  });

  it('绑定还没补到时区分"加载中"和"未加载"', () => {
    const { unmount } = renderCard({
      capabilities: undefined,
      capsLoading: true,
    });
    expect(screen.getByText('能力绑定加载中…')).toBeTruthy();
    unmount();

    renderCard({ capabilities: undefined, capsLoading: false });
    expect(screen.getByText('能力绑定未加载')).toBeTruthy();
  });

  it('最多摊 4 个标签，其余收进 +N', () => {
    renderCard({
      capabilities: [cap(1), cap(2), cap(3), cap(4), cap(5), cap(6)],
    });
    expect(screen.getByText('能力1')).toBeTruthy();
    expect(screen.getByText('能力4')).toBeTruthy();
    expect(screen.queryByText('能力5')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('6 项能力')).toBeTruthy();
  });

  it('点击卡片带出当前技能', () => {
    const onOpen = vi.fn();
    renderCard({ capabilities: [cap(1)], onOpen });
    fireEvent.click(screen.getByText('文档检索问答'));
    expect(onOpen).toHaveBeenCalledWith(SKILL);
  });

  it('A2A tags 用中性标签展示，超过 3 个收进 +N', () => {
    const { unmount } = renderCard();
    expect(screen.getByText('document')).toBeTruthy();
    expect(screen.getByText('qa')).toBeTruthy();
    unmount();

    renderCard({
      skill: {
        ...SKILL,
        tags: ['legal', 'contract', 'review', 'gdpr', 'soc2'],
      },
    });
    // 前三个摊开，后面收起来（能力绑定是空的，所以 +2 不会和 +N 撞车）
    expect(screen.getByText('review')).toBeTruthy();
    expect(screen.queryByText('gdpr')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
  });
});
