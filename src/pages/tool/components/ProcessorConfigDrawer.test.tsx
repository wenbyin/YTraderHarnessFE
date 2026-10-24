// src/pages/tool/components/ProcessorConfigDrawer.test.tsx
//
// ⚠️ 回归测试（2026-10-05）：`list[str]` 字段必须渲染成「数组编辑器」，不是单行 Input。
//
// 起因：这个抽屉以前自己写了一份简化的字段 if 链，只有 enum / boolean / number 三支 +
// 兜底 Input，**没有 array**。于是 `AuthConfig.require_roles: list[str]` 掉进兜底，
// 用户在里面填 "Y-Trader-Admin"，提交上去是**字符串**，后端 pydantic 直接 422。
//
// 现在字段渲染统一走 @/components/SchemaForm（与文档类型定义的能力配置共用一份），
// 下面这几条断言把「类型」钉住 —— 断言的是 `Array.isArray`，不是"好不好看"。

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainItem, ProcessorDefinition } from '../processorChain';
import ProcessorConfigDrawer, {
  type ProcessorConfigDraft,
} from './ProcessorConfigDrawer';

vi.mock('@umijs/max', () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage?: string }) =>
      defaultMessage ?? '',
  }),
}));

/** schema 形态照抄后端 AuthConfig（app/agent/tools/processor/interceptor/auth.py）。 */
const DEF: ProcessorDefinition = {
  key: 'auth_interceptor',
  name: '调用者鉴权',
  description: '按调用者的角色 / 群组放行或拒绝这次工具调用。',
  processor_type: 'INTERCEPTOR',
  supported_hooks: ['BEFORE', 'AFTER', 'AROUND'],
  supported_execution_modes: ['SYNC'],
  registry_available: true,
  config_schema: {
    type: 'object',
    properties: {
      require_roles: {
        type: 'array',
        items: { type: 'string' },
        title: '要求的角色',
        description: '命中其中任意一个即通过。留空 = 不按角色限制。',
      },
      require_group: { type: 'string', title: '要求的群组' },
      on_missing: {
        type: 'string',
        enum: ['deny', 'allow'],
        title: '拿不到身份时',
      },
    },
  },
};

const ITEM: ChainItem = {
  uid: 'u1',
  processor_key: 'auth_interceptor',
  hook: 'BEFORE',
  execution_mode: 'SYNC',
  // 初值由 defaultConfig 生成，数组字段应当是 []
  config: { require_roles: [], require_group: '', on_missing: 'deny' },
  enabled: true,
};

const renderDrawer = () => {
  const onSave = vi.fn((_d: ProcessorConfigDraft) => {});
  render(
    <ProcessorConfigDrawer
      open
      item={ITEM}
      def={DEF}
      onCancel={() => {}}
      onSave={onSave}
    />,
  );
  return onSave;
};

/**
 * 「要求的角色」这张字段卡片内部的 antd Input。
 *
 * ⚠️ 不能直接 `document.querySelectorAll('input.ant-input')` —— config 区里
 * `require_group`（string）用的是同一个类名，而 properties 的顺序是
 * require_roles → require_group，取「最后一个」会填到 require_group 上去。
 * （写这条测试时就这么错过一次，表现是「保存后数组里仍是空串」。）
 * 也不能靠哈希类名定位，所以按 title 文本往上找那张卡片。
 */
const rolesInputs = (): HTMLInputElement[] => {
  const card = screen.queryByText('要求的角色')?.closest('div')?.parentElement;
  if (!card) return [];
  return Array.from(card.querySelectorAll<HTMLInputElement>('input.ant-input'));
};

afterEach(cleanup);

describe('ProcessorConfigDrawer · config 字段渲染', () => {
  it('list[str] 渲染成数组编辑器：带 array[] 类型标签与「+ 添加一项」', () => {
    renderDrawer();

    // title 与 description 都来自 schema（老实现只显示 title，description 被整个丢掉）
    expect(screen.getByText('要求的角色')).toBeTruthy();
    expect(screen.getByText(/命中其中任意一个即通过/)).toBeTruthy();
    // 一眼能看出这是数组
    expect(screen.getByText('array[]')).toBeTruthy();
    // 数组编辑器特有的按钮 —— 这就是「input 列表」与「单个 input」的分水岭
    expect(screen.getByText('+ 添加一项')).toBeTruthy();
  });

  it('enum 字段仍然是下拉，别的类型没被改坏', () => {
    renderDrawer();
    expect(screen.getByText('拿不到身份时')).toBeTruthy();
    // enum 走 Select：它的 input 不是 ant-input
    expect(screen.getByText('要求的群组')).toBeTruthy();
  });

  it('点「+ 添加一项」多一行输入框，填完保存 → 是数组而不是字符串', () => {
    const onSave = renderDrawer();

    const before = rolesInputs().length;
    fireEvent.click(screen.getByText('+ 添加一项'));
    expect(rolesInputs().length).toBe(before + 1);

    const inputs = rolesInputs();
    fireEvent.change(inputs[inputs.length - 1], {
      target: { value: 'Y-Trader-Admin' },
    });

    // antd v6 给两个汉字的按钮插了空格，所以按正则可选空格
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const draft = onSave.mock.calls[0][0];
    // ★ 这条就是用户报的 bug：以前这里是 "Y-Trader-Admin"（字符串），后端必 422
    expect(Array.isArray(draft.config.require_roles)).toBe(true);
    expect(draft.config.require_roles).toEqual(['Y-Trader-Admin']);
  });

  it('数组项可以逐行删掉，删空后回到空数组', () => {
    const onSave = renderDrawer();

    fireEvent.click(screen.getByText('+ 添加一项'));
    fireEvent.click(screen.getByRole('button', { name: /删\s*除/ }));

    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));
    expect(onSave.mock.calls[0][0].config.require_roles).toEqual([]);
  });
});
