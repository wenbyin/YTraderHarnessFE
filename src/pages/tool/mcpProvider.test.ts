// src/pages/tool/mcpProvider.test.ts
//
// provider 的展示文本与筛选联动。这几条规则**错了不会报错** —— 后端只会
// 返回空列表，界面上跟"这个来源没有工具"长得一模一样，所以必须钉住。

import { describe, expect, it } from 'vitest';
import type { MCPProviderSummary } from './data';
import {
  applyFilterPatch,
  mcpFilterDisabled,
  mcpProviderDetail,
  mcpProviderHealth,
  mcpProviderOptionLabel,
  mcpProviderSelectLabel,
} from './mcpProvider';

const provider = (
  over: Partial<MCPProviderSummary> = {},
): MCPProviderSummary => ({
  name: 'tdx',
  enabled: true,
  transport: 'stdio',
  connected: true,
  exposed_tool_count: 9,
  tools_mode: 'allowlist',
  tool_count: 9,
  active_tool_count: 9,
  missing_tool_count: 0,
  ...over,
});

describe('状态归一', () => {
  it('启用 + 连上 = connected', () => {
    expect(mcpProviderHealth(provider())).toBe('connected');
  });

  it('启用但没连上 = offline', () => {
    expect(mcpProviderHealth(provider({ connected: false }))).toBe('offline');
  });

  it('⭐ 停用优先于连接：配置关了但会话还活着，仍然是 disabled', () => {
    // 热改配置不会自动断开连接，这时 connected 会是 true。
    // 若按"connected 优先"判断，界面会显示成"已连接"，让人以为还能调用。
    expect(
      mcpProviderHealth(provider({ enabled: false, connected: true })),
    ).toBe('disabled');
  });
});

describe('下拉文案', () => {
  it('条数用 tool_count（库里的行），不是 exposed_tool_count', () => {
    // 典型不一致：连上了但还没 sync。显示 exposed 会出现"写 9 个、点进去 0 条"
    const notSynced = provider({
      exposed_tool_count: 9,
      tool_count: 0,
      active_tool_count: 0,
      missing_tool_count: 0,
    });
    expect(mcpProviderOptionLabel(notSynced)).toBe('tdx · 尚未同步');
    // 连得上但库里没行 —— 这不是异常态，所以按"只有异常才加后缀"不加"（已连接）"
    expect(mcpProviderSelectLabel(notSynced)).toBe('tdx · 尚未同步');
  });

  it('已连接不加后缀（正常态不该占字数）', () => {
    expect(mcpProviderSelectLabel(provider())).toBe('tdx · 9 个工具');
  });

  it('异常态才加后缀', () => {
    expect(mcpProviderSelectLabel(provider({ connected: false }))).toBe(
      'tdx · 9 个工具（未连接）',
    );
    expect(mcpProviderSelectLabel(provider({ enabled: false }))).toBe(
      'tdx · 9 个工具（已停用）',
    );
  });
});

describe('选中后的明细行', () => {
  it('三组数字都摊开', () => {
    expect(mcpProviderDetail(provider())).toBe(
      '已连接 · 暴露 9 · 已同步 9（ACTIVE 9 / MISSING 0）',
    );
  });

  it('有 MISSING 时如实写出来', () => {
    expect(
      mcpProviderDetail(
        provider({
          tool_count: 9,
          active_tool_count: 7,
          missing_tool_count: 2,
        }),
      ),
    ).toContain('ACTIVE 7 / MISSING 2');
  });
});

describe('禁用判据', () => {
  it('类型不限 / mcp 时不禁用', () => {
    expect(mcpFilterDisabled('')).toBe(false);
    expect(mcpFilterDisabled('mcp')).toBe(false);
  });

  it('类型是别的来源时禁用（那种组合恒为空集）', () => {
    expect(mcpFilterDisabled('local_method')).toBe(true);
    expect(mcpFilterDisabled('openapi')).toBe(true);
  });
});

describe('⭐ 联动：applyFilterPatch', () => {
  const base = {
    keyword: '',
    source_type: '',
    source_ref: '',
    source_state: '',
    classification_code: '',
  };

  it('选了 provider → 类型自动变 mcp', () => {
    const next = applyFilterPatch(base, { source_ref: 'tdx' });
    expect(next.source_type).toBe('mcp');
    expect(next.source_ref).toBe('tdx');
  });

  it('⭐ 类型改成别的来源 → provider 被清掉', () => {
    const prev = { ...base, source_type: 'mcp', source_ref: 'tdx' };
    const next = applyFilterPatch(prev, { source_type: 'local_method' });
    expect(next.source_type).toBe('local_method');
    expect(next.source_ref).toBe('');
  });

  it('类型清空（不限）→ provider **保留**（source_ref 单独就成立）', () => {
    const prev = { ...base, source_type: 'mcp', source_ref: 'tdx' };
    const next = applyFilterPatch(prev, { source_type: '' });
    expect(next.source_ref).toBe('tdx');
  });

  it('清空 provider 不会把类型一起改掉', () => {
    const prev = { ...base, source_type: 'mcp', source_ref: 'tdx' };
    const next = applyFilterPatch(prev, { source_ref: '' });
    expect(next.source_type).toBe('mcp');
    expect(next.source_ref).toBe('');
  });

  it('类型改回 mcp 时 provider 不动', () => {
    const prev = { ...base, source_type: 'local_method' };
    const next = applyFilterPatch(prev, { source_type: 'mcp' });
    expect(next.source_type).toBe('mcp');
    expect(next.source_ref).toBe('');
  });

  it('别的键原样带过去（只补联动，不改语义）', () => {
    const prev = { ...base, keyword: 'quote', source_state: 'ACTIVE' };
    const next = applyFilterPatch(prev, { source_ref: 'tdx' });
    expect(next.keyword).toBe('quote');
    expect(next.source_state).toBe('ACTIVE');
  });
});
