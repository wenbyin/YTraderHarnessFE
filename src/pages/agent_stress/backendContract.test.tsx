// src/pages/agent_stress/backendContract.test.tsx
//
// **契约测试**：数据来自真实后端（backendSample.ts 是 model_dump 导出的，
// 不是手写假数据）。两件事：
//   1. 编译期：那边的字面量标注成前端类型，字段一改 tsc 就报（本文件只是补充运行期）；
//   2. 运行期：真实快照丢进 RunMetrics 能渲染出正确单位，别等到线上白屏。
//
// v2 的快照是 12 个会话 × 平均 4.5 轮 = 54 轮，所以断言全部围绕这两组数。
import { cleanup, render, screen } from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { BACKEND_METRICS, BACKEND_PAGE, BACKEND_RUN } from './backendSample';
import { DistributionTable } from './components/DistributionTable';
import { RunMetrics } from './components/RunMetrics';
import { loadSummary, SIMULATED_ALGORITHM } from './stressMeta';

beforeEach(() => {
  cleanup();
});

describe('真实后端响应', () => {
  it('顶部状态与模拟标识对得上', () => {
    expect(BACKEND_RUN.status).toBe('completed');
    expect(BACKEND_RUN.started_at).toBeTruthy();
    expect(BACKEND_RUN.finished_at).toBeTruthy();
    expect(BACKEND_METRICS.aggregation_status).toBe('final');
    // 后端明确要求：看到 simulated-v1 就要告诉用户这不是真实压测结论
    expect(BACKEND_METRICS.aggregation_algorithm).toBe(SIMULATED_ALGORITHM);
    // v2 的 concurrency 是「在途会话数」，文案里必须出现「会话」
    expect(loadSummary(BACKEND_RUN.config.load)).toBe('6 会话并发');
  });

  it('v2 配置是嵌套结构：target 对象 + session.turns', () => {
    const cfg = BACKEND_RUN.config;
    expect(cfg.target.base_url).toBe('http://127.0.0.1:8080');
    expect(cfg.session.agent_id).toBe('stock_research');
    expect(cfg.session.turns).toMatchObject({
      mean: 4.5,
      stddev: 1.5,
      min: 1,
      max: 8,
    });
    // 契约：turn.streaming 后端强制 true
    expect(cfg.turn?.streaming).toBe(true);
    // auth 只带环境变量名，后端不会回显明文 token
    expect(cfg.auth?.token_env).toBe('STRESS_RUNNER_TOKEN');
    expect(cfg).not.toHaveProperty('agent_type');
    expect(cfg).not.toHaveProperty('payload_template');
  });

  it('Distribution 用的是 min（没有 yaml 里那个 minimum）', () => {
    const latency = BACKEND_METRICS.turns?.latency_ms;
    expect(latency?.count).toBeGreaterThan(0);
    expect(typeof latency?.min).toBe('number');
    expect(latency).not.toHaveProperty('minimum');
    // 分位数单调：p50 ≤ p90 ≤ p95 ≤ p99
    expect(latency?.p50).toBeLessThanOrEqual(latency?.p90 ?? 0);
    expect(latency?.p90).toBeLessThanOrEqual(latency?.p95 ?? 0);
    expect(latency?.p95).toBeLessThanOrEqual(latency?.p99 ?? 0);
  });

  it('会话 / 轮次两组的计数自洽', () => {
    const { sessions, turns } = BACKEND_METRICS;
    // 12 个会话都跑满了计划 N
    expect(sessions.started).toBe(12);
    expect(sessions.completed).toBe(12);
    expect(sessions.abandoned).toBe(0);
    expect(sessions.sampled_turns_per_session?.count).toBe(12);
    expect(sessions.turns_per_session?.count).toBe(12);

    expect(turns.started).toBe(54);
    expect(turns.completed).toBe((turns.succeeded ?? 0) + (turns.failed ?? 0));

    // by_index 的样本数加起来必须等于已发起轮次
    const byIndexTotal = Object.values(turns.by_index ?? {}).reduce(
      (sum, dist) => sum + (dist.count ?? 0),
      0,
    );
    expect(byIndexTotal).toBe(turns.started);
    // key 是 "1".."30" 的字符串
    for (const key of Object.keys(turns.by_index ?? {})) {
      expect(Number.parseInt(key, 10)).toBeGreaterThan(0);
    }
  });

  it('列表响应就是 { items, next_cursor }', () => {
    expect(Array.isArray(BACKEND_PAGE.items)).toBe(true);
    expect(BACKEND_PAGE.items).toHaveLength(1);
    expect(BACKEND_PAGE).toHaveProperty('next_cursor');
  });

  it('真实指标快照能渲染成表（数字不会被 null 吞掉）', () => {
    render(
      <App>
        <RunMetrics metrics={BACKEND_METRICS} status="completed" />
      </App>,
    );

    // 会话 12 / 轮次 54 都能落到计数卡里
    expect(screen.getAllByText('12').length).toBeGreaterThan(0);
    expect(screen.getAllByText('54').length).toBeGreaterThan(0);
    // achieved_sessions_per_second 0.6753 → 0.675
    expect(screen.getByText('0.675')).toBeTruthy();
    // achieved_turns_per_second 3.039 → 3.04
    expect(screen.getByText('3.04')).toBeTruthy();
    // 轮次 p50 1545.341ms → "1.55 s"（formatMs 过 1s 换单位）
    expect(screen.getAllByText('1.55 s').length).toBeGreaterThan(0);
    // 按轮次序号的表列到了第 7 轮
    expect(screen.getAllByText('第 7 轮').length).toBeGreaterThan(0);
  });

  it('真实节点 / 工具分布能进半宽表', () => {
    const nodes = Object.entries(BACKEND_METRICS.nodes ?? {}).map(
      ([name, dist]) => ({ key: `node-${name}`, label: name, dist }),
    );
    expect(nodes.length).toBeGreaterThan(0);

    render(
      <App>
        <DistributionTable series={nodes} compact />
      </App>,
    );
    expect(screen.getByText(nodes[0].label)).toBeTruthy();
    // 紧凑表只保留 p50/p95/p99 三列
    expect(screen.queryByText('p90')).toBeNull();
  });
});
