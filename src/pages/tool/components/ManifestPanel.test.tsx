// src/pages/tool/components/ManifestPanel.test.tsx
//
// 只钉一件事：概览表里 `source_state` 那一格必须跟着运行时开关走。
//
// 2026-10-25 用户截图指出：详情头已经显示「已下线」，表格里却还写着「生效中」——
// 同一屏自相矛盾。根因是标题用了状态槽、这格却还在直接渲染 source_state 原值。
// 这三个断言把「同一套优先级」钉在组件层（MISSING > 已下线 > 生效中）。
//
// ⚠️ 断言按**类名**判色、按**契约原值**判文案：本文件 mock 掉 useIntl（回落
//    defaultMessage），`labels.sourceState('ACTIVE')` 在这里渲染出的就是 "ACTIVE"，
//    而不是「生效中」。想断言中文就得去加载真 locale，得不偿失。

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolManifest } from '../data';
import ManifestPanel from './ManifestPanel';

vi.mock('@umijs/max', () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));

const manifest = (over: Partial<ToolManifest> = {}): ToolManifest => ({
  id: 'm1',
  tool_key: 'agent.current_time',
  name: 'current_time',
  source_type: 'local_method',
  source_ref: 'agent',
  entrypoint: 'app.agent.tools.time_tool:current_time',
  input_schema: { type: 'object', properties: {} },
  output_schema: null,
  source_docstring: null,
  manifest_hash: '6966477d1d535fe',
  source_state: 'ACTIVE',
  discovered_at: '2026-10-10T08:34:47Z',
  last_synced_at: '2026-10-23T10:55:11Z',
  ...over,
});

afterEach(() => cleanup());

describe('概览表的 source_state 行', () => {
  it('⭐ 下线后这一行跟着变「已下线」，不能还写着「生效中」', () => {
    render(<ManifestPanel manifest={manifest()} enabled={false} />);

    expect(screen.queryByText('ACTIVE')).toBeNull();
    expect(document.querySelector('.ant-tag-warning')).not.toBeNull();
  });

  it('在线时仍是「生效中」', () => {
    render(<ManifestPanel manifest={manifest()} enabled />);

    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(document.querySelector('.ant-tag-warning')).toBeNull();
  });

  it('MISSING 优先于下线（与列表卡、详情头同一套优先级）', () => {
    render(
      <ManifestPanel
        manifest={manifest({ source_state: 'MISSING' })}
        enabled={false}
      />,
    );

    expect(screen.getByText('MISSING')).toBeInTheDocument();
    expect(document.querySelector('.ant-tag-warning')).toBeNull();
  });

  it('老后端没有 enabled 字段时按在线处理（fail-open）', () => {
    render(<ManifestPanel manifest={manifest()} />);

    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });
});
