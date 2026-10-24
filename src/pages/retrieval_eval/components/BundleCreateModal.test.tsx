// src/pages/retrieval_eval/components/BundleCreateModal.test.tsx
//
// 新建 Bundle 弹窗的接线条测试。专盯「跨块金标裁决」这个开关，因为它同时挂在
// 三条线上，任何一条断了都只能靠跑起来才发现：
//
//   1. **UI**：开关真的渲染出来，默认关（契约 default=false），文案不含糊。
//   2. **表单**：`Form.useWatch('enable_cross_chunk_judge')` 必须真的订阅到值 ——
//      否则预估调用次数不会随开关变化，用户看到的成本估算是错的。
//   3. **提交**：开关的值必须原样进入 onSubmit 的 payload。这一条最要命 ——
//      契约字段名写错一个字母，后端 `extra="forbid"` 直接 422；
//      而「没传」与「传 false」在后端是两种语义（前者会用默认值，后者是显式声明）。
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// 刻意挡掉 dtdOptions：它链到 service → `@umijs/max` 的 request，
// 在这个单测里没有运行时。弹窗只用到 useDtdOptions() 的返回值。
vi.mock('../dtdOptions', () => ({
  useDtdOptions: () => [
    {
      document_type_definition_id: 'dtd-1',
      type_key: 'company_announcement',
      name: '公告',
      modality_type: 'text',
    },
  ],
  dtdLabel: (id: string) => id,
}));

import BundleCreateModal from './BundleCreateModal';

/** 打开弹窗，返回 OK 按钮。 */
async function openModal() {
  render(<BundleCreateModal onSubmit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /新建 Bundle/ }));
  const ok = await screen.findByRole('button', { name: '创建并开始生成' });
  return ok;
}

/** Alert 里的预估文案被 <strong> 切碎，按整段 textContent 断言最稳。 */
function alertText(): string {
  const el = document.querySelector('.ant-alert');
  if (!el) throw new Error('预估 Alert 没渲染出来');
  return (el.textContent ?? '').replace(/\s+/g, '');
}

describe('BundleCreateModal · 跨块金标裁决开关', () => {
  it('默认关：开关渲染出来、为关闭态、预估里不含裁决调用', async () => {
    await openModal();

    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');

    // 默认 N=100 / L=5 / M=3 → 窗口 20、调用 20、用例 300
    expect(alertText()).toContain('预计窗口数：20');
    expect(alertText()).toContain('预计LLM调用：20次');
    expect(alertText()).toContain('预计用例上限：300条');
    // 关着的时候不该出现"其中跨块裁决"，否则等于谎报有这笔开销
    expect(alertText()).not.toContain('其中跨块裁决');
  });

  it('打开后：文案切到「由模型评判」，预估追加每题一次的裁决调用', async () => {
    await openModal();

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(screen.getByRole('switch')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    // 裁决是**每题**一次 → 用例 300 条 = 300 次，总调用 20 + 300 = 320
    expect(alertText()).toContain('预计LLM调用：320次');
    expect(alertText()).toContain('其中跨块裁决300次');
  });

  it('提交时把开关值带进 payload（显式 true / 显式 false 都能到）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<BundleCreateModal onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /新建 Bundle/ }));
    const ok = await screen.findByRole('button', { name: '创建并开始生成' });

    fireEvent.change(
      screen.getByPlaceholderText('例如 company-announcement-retrieval-v1'),
      { target: { value: 'judge-on-bundle' } },
    );

    // antd Select：mouseDown 展开，点选项选中
    fireEvent.mouseDown(screen.getByText('选择一个或多个 DTD'));
    fireEvent.click(await screen.findByTitle('company_announcement · 公告'));

    fireEvent.click(screen.getByRole('switch')); // 打开裁决
    fireEvent.click(ok);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe('judge-on-bundle');
    expect(payload.document_type_definition_ids).toEqual(['dtd-1']);
    // 字段名必须与契约一致，且是显式布尔值（不是 undefined）
    expect(payload.enable_cross_chunk_judge).toBe(true);
  });
});
