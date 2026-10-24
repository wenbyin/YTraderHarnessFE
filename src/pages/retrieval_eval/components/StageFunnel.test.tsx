// src/pages/retrieval_eval/components/StageFunnel.test.tsx
//
// 漏斗的「行距 / 折行」回归测试。
//
// 这一层纯视觉，happy-dom 不做真实布局（量不到高度），所以**不去断言行高像素**，
// 改成钉住「让行高能保持相等」的那几条样式约定 —— 它们是这次踩坑的根因，
// 一旦被改掉（比如有人觉得 150px 够用、或者把 nowrap 删了），这里立刻红。
//
// 对照组是真实跑测的截图：修复前行距实测 56/56/56/84/77/57（2x 像素），
// 修复后 56/56/56/56/56/56。
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StageStatItem } from '../data';
import StageFunnel from './StageFunnel';

/** 取自用户截图里的真实一次跑测。 */
const DATA: StageStatItem[] = [
  s('cutter', '', 40, 40, 15, 25),
  s('filter', '', 40, 40, 28, 12),
  s('fusioner', '', 40, 40, 28, 12),
  s('recall', '', 5, 5, 0, 5),
  s('recall.dense_vector', 'dense_vector', 40, 0, 9, 31),
  s('recall.keyword', 'keyword', 39, 0, 34, 5),
  s('reranker', '', 40, 40, 28, 12),
];

function s(
  stage_key: string,
  source_key: string,
  observed_cases: number,
  before: number,
  after: number,
  drop: number,
): StageStatItem {
  return {
    stage_key,
    source_key,
    observed_cases,
    gold_present_before_count: before,
    gold_present_after_count: after,
    gold_drop_count: drop,
    drop_reason_counts: {},
  };
}

const allDivs = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('div'));

describe('StageFunnel · 行距与折行', () => {
  it('每行都是固定 22px 的 flex 行 —— 行高不能由内容决定', () => {
    const { container } = render(<StageFunnel stages={DATA} />);

    // 行容器特征：display:flex + gap:8px + 固定 height:22px
    const rows = allDivs(container).filter(
      (el) =>
        el.style.display === 'flex' &&
        el.style.gap === '8px' &&
        el.style.height === '22px',
    );

    expect(rows).toHaveLength(DATA.length);
    // 7 行同高，行距才可能相等；任何一行被内容顶高都会出现「折痕」
    for (const row of rows) {
      expect(row.style.height).toBe('22px');
    }
  });

  it('标签列 200px + 文字 nowrap：`召回 · 稠密向量` 加 dense_vector 标签放得下，不折行', () => {
    const { container } = render(<StageFunnel stages={DATA} />);

    const rows = allDivs(container).filter(
      (el) =>
        el.style.display === 'flex' &&
        el.style.gap === '8px' &&
        el.style.height === '22px',
    );

    for (const row of rows) {
      const labelCol = row.firstElementChild as HTMLElement;
      // 150px 装不下「召回 · 稠密向量 + dense_vector」（约 162px）→ 曾折成两行
      expect(labelCol.style.width).toBe('200px');
      expect(labelCol.style.flexShrink).toBe('0');

      const labelText = labelCol.firstElementChild as HTMLElement;
      expect(labelText.style.whiteSpace).toBe('nowrap');
      expect(labelText.style.width).toBe('110px');
    }
  });

  it('条内数字 nowrap + 最小宽度：`0 / 5` 这种极小值不许在条里折行溢出', () => {
    const { container } = render(<StageFunnel stages={DATA} />);

    const rows = allDivs(container).filter(
      (el) =>
        el.style.display === 'flex' &&
        el.style.gap === '8px' &&
        el.style.height === '22px',
    );

    for (const row of rows) {
      const track = row.children[1] as HTMLElement;
      // Tooltip 不改结构：条是 track 的直接子元素
      const bar = track.firstElementChild as HTMLElement;
      expect(bar.style.whiteSpace).toBe('nowrap');
      // 2% 的条只有约 25px，装不下 `0 / 5` → 文字折成两行并溢出条外
      expect(bar.style.minWidth).toBe('60px');
    }
  });

  it('阶段按**真实执行顺序**渲染，而不是后端给的字母序', () => {
    // DATA 就是后端 `order_by stage_key` 的字母序产物
    expect(DATA.map((d) => d.stage_key)).toEqual([
      'cutter',
      'filter',
      'fusioner',
      'recall',
      'recall.dense_vector',
      'recall.keyword',
      'reranker',
    ]);

    const { container } = render(<StageFunnel stages={DATA} />);
    const rows = allDivs(container).filter(
      (el) =>
        el.style.display === 'flex' &&
        el.style.gap === '8px' &&
        el.style.height === '22px',
    );

    const labels = rows.map(
      (row) =>
        (row.firstElementChild as HTMLElement).firstElementChild?.textContent,
    );

    // 召回分支 → 合成 recall → 融合 → 过滤 → 重排 → 截断
    expect(labels).toEqual([
      '召回 · 稠密向量',
      '召回 · 关键词',
      'recall',
      '融合 Fusioner',
      '过滤 Filter',
      '重排 Reranker',
      '截断 Cutter',
    ]);
  });

  it('两张卡片的标签列同宽 —— 否则上下两张卡的条目起点会错位', () => {
    const { container } = render(<StageFunnel stages={DATA} />);

    const labelCols = allDivs(container).filter(
      (el) => el.style.gap === '4px' && el.style.flexShrink === '0',
    );
    // 漏斗卡 7 行 + 丢弃原因卡（只有 cutter/filter/recall/dense/keyword/reranker 有原因）
    expect(labelCols.length).toBeGreaterThanOrEqual(DATA.length);
    for (const el of labelCols) {
      expect(el.style.width).toBe('200px');
    }
  });
});
