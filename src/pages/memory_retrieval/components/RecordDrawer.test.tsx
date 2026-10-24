// src/pages/memory_retrieval/components/RecordDrawer.test.tsx
//
// 右侧抽屉的钉桩。这里是 L1 / L2 卡片网格那条链路的**终点** —— 网格那一行 HBU 的
// 用例钉的是"交给上层什么"，这一份钉的是"收到之后显示什么"。
//
// 三条容易被改坏的边界：
//   1. **L1 不发请求**：浏览端点给的就是完整正文，`FactRecord` 带过来就能显示。
//      要是哪天这里开始 `await` 一个接口，record_id 在 merge 之后是变的（契约原话
//      "只在一次写入内稳定"），拿旧 id 去查只会拿回声 404。
//   2. **L2 的三态必须分开**：loading / error / data。混成一个 spinner 之后，
//      filename 被删掉时后端回的 404 会看起来永远是"正在取全文"。
//   3. **关掉 ≠ 还在**：`opened` 是 null 时抽屉必须真的关掉（`open` 为 false）。
//      原来那版用 `DetailState.open` 存开合 —— 与"看的是哪一条"是两份 state，
//      两者不同步过（点击政策不是说 === title 还在）。
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FactRecord, SceneDetail, SceneSummary } from '../data';
import {
  EMPTY_SCENE_FULL,
  RecordDrawer,
  type SceneFullState,
} from './RecordDrawer';

afterEach(() => {
  cleanup();
});

const FACT: FactRecord = {
  record_id: 'rec-0000000001',
  content: '喜欢用表格对账，但不能接受自动改数',
  type: 'episodic',
  priority: -1,
  scene_name: '对账习惯',
  version: 2,
  timestamp_str: '2026 年',
  updated_at: '2026-10-02T09:00:00Z',
};

const SUMMARY: SceneSummary = {
  filename: '2026-10-01-对账习惯.md',
  summary: '他每个月 1 号对账',
  heat: 7,
  version: 3,
  updated_at: '2026-10-01T09:00:00Z',
};

const DETAIL: SceneDetail = {
  ...SUMMARY,
  content: '<!-- META heat: 7 -->\n# 对账习惯\n\n每个月 1 号。',
};

/** antd Drawer 是否在 DOM 里且是打开的（按 `.ant-drawer` 找，别猜 DOM 结构）。 */
const drawerOpen = (): boolean => {
  const el = document.querySelector('.ant-drawer');
  if (!el) return false;
  return !el.className.includes('ant-drawer-hidden');
};

const noop = () => {};

describe('RecordDrawer（右侧抽屉：L1 / L2 共用同一个实例）', () => {
  it('关着的时候（opened 是 null）抽屉不在页面上', () => {
    render(
      <RecordDrawer opened={null} scene={EMPTY_SCENE_FULL} onClose={noop} />,
    );

    expect(drawerOpen()).toBe(false);
  });

  it('L1：直接显示完整正文 —— **不发请求**（所以用 loading / error 都是假的）', () => {
    render(
      <RecordDrawer
        opened={{ kind: 'fact', record: FACT }}
        // ⚠️ 故意塞一个 loading/error：L1 那一分支**不许**看它们
        scene={{ loading: true, error: '这���不该显示', data: null }}
        onClose={noop}
      />,
    );

    expect(drawerOpen()).toBe(true);
    expect(screen.getByText(FACT.content)).toBeTruthy();
    expect(document.body.textContent).toContain('原子记忆全文');
    expect(document.body.textContent).not.toContain('正在取全文');
    expect(document.body.textContent).not.toContain('这条不该显示');
  });

  it('L2 loading：显示"正在取全文"，并且**不是**报错', () => {
    const scene: SceneFullState = {
      loading: true,
      error: null,
      data: null,
    };
    render(
      <RecordDrawer
        opened={{ kind: 'scene', filename: SUMMARY.filename }}
        scene={scene}
        onClose={noop}
      />,
    );

    expect(document.body.textContent).toContain('正在取全文');
    expect(document.body.textContent).not.toContain('取场景全文失败');
    expect(document.body.textContent).toContain('场景全文');
  });

  it('L2 error（filename 被删了 -> 404）必须如实报出来，不能停在 spinner', () => {
    const scene: SceneFullState = {
      loading: false,
      error: '404 · 场景不存在',
      data: null,
    };
    render(
      <RecordDrawer
        opened={{ kind: 'scene', filename: SUMMARY.filename }}
        scene={scene}
        onClose={noop}
      />,
    );

    expect(document.body.textContent).toContain('取场景全文失败');
    expect(document.body.textContent).toContain('404 · 场景不存在');
    expect(document.body.textContent).not.toContain('正在取全文');
  });

  it('L2 data：把全文交给 md 阅读器（右上角那个图标切换器在）', () => {
    const scene: SceneFullState = { loading: false, error: null, data: DETAIL };
    render(
      <RecordDrawer
        opened={{ kind: 'scene', filename: SUMMARY.filename }}
        scene={scene}
        onClose={noop}
      />,
    );

    expect(document.querySelector('[data-doc-mode="reader"]')).toBeTruthy();
    expect(document.querySelector('[data-doc-mode="raw"]')).toBeTruthy();
    // 阅读器模式：META 注释被吃掉、md 被解析
    expect(document.body.textContent).not.toContain('META');
    expect(document.body.textContent).toContain('每个月 1 号。');
  });
});
