// src/components/CopilotDock/toolLabels.test.tsx
//
// 工具调用文案（toolLabels）的**翻译真的加载了**这件事，钉在这里。
//
// 背景：`pages/tool` 的枚举翻译文件写好后一直**没被注册**进 locales/zh-CN.ts
// （formatMessage 每一条都落到 defaultMessage = 原值），等于"翻译写了、
// 界面还是英文"。所以这里除了测 hook，还要测**语言包真的被挂上去**
// —— 否则同样的坑会再踩一次，而且踩了没人发现（界面只是"没翻译"，
// 不会报错、不会白屏）。
//
// 覆盖：
//   ① 注册：zh-CN / en-US 的默认导出里真的有 toolCall.* 与 tool.* 的 key；
//   ② 命中文案：`agent.enter_plan_mode` -> 「进入计划模式」；
//   ③ 三种写法归一：点分 / 下划线 / 短名 —— 同一个工具不能有两个名字；
//   ④ 四态措辞：running / done / error / 缺省，各一句；
//   ⑤ 回落：没登记的 key（MCP 动态工具）显示**原值**，不是 undefined；
//   ⑥ 中英两份 key 集合一致（漏一条英文就会在英文界面里露中文）。
import { render } from '@testing-library/react';
import { createIntl, IntlContext } from 'react-intl';
import { describe, expect, it } from 'vitest';

import enUS from '../../locales/en-US';
import enToolCall from '../../locales/en-US/toolCall';
import zhCN from '../../locales/zh-CN';
import zhToolCall from '../../locales/zh-CN/toolCall';
import {
  canonicalToolKey,
  TOOL_KEYS,
  UNNAMED_TOOL,
  useToolLabels,
} from './toolLabels';
import type { ToolCallStatus } from './useToolActivity';

/** 探针：把 hook 返回的四段文字摊平，便于逐条断言。 */
function Probe({
  name,
  status,
  error,
}: {
  name: string;
  status?: ToolCallStatus;
  error?: string;
}) {
  const labels = useToolLabels();
  return (
    <div>
      <span data-testid="state">{labels.state(status)}</span>
      <span data-testid="name">{labels.name(name)}</span>
      <span data-testid="hint">{labels.hint(name)}</span>
      <span data-testid="error">{labels.error(error)}</span>
    </div>
  );
}

const mount = (
  name: string,
  options: {
    status?: ToolCallStatus;
    error?: string;
    /** 不传 = 裸渲染（不挂 Provider，模拟单测/降级环境）。 */
    messages?: Record<string, string>;
    locale?: string;
  } = {},
) => {
  const ui = (
    <Probe name={name} status={options.status} error={options.error} />
  );
  /*
   * 用 `createIntl` + `IntlContext.Provider` 而不是 `<IntlProvider>`：
   *   · 前者正好是 hook 实际读的那个 context，"挂了语言包就生效"验得更直接；
   *   · 后者的类型声明（PureComponent<OptionalIntlConfig>）在 React 18 的
   *     JSX 检查下**不接受 children**，写出来 tsc 会红。
   */
  const { container } = options.messages
    ? render(
        <IntlContext.Provider
          value={createIntl({
            locale: options.locale ?? 'zh-CN',
            messages: options.messages,
          })}
        >
          {ui}
        </IntlContext.Provider>,
      )
    : render(ui);
  return container;
};

const text = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

describe('语言包确实被注册（防"翻译写了没挂上"）', () => {
  it('⭐ zh-CN 的默认导出里有 toolCall.* 与 tool.* —— 少一个就是没生效', () => {
    const messages = zhCN as Record<string, string>;
    expect(messages['toolCall.state.running']).toBe('正在调用');
    expect(messages['toolCall.name.agent.enter_plan_mode']).toBe(
      '进入计划模式',
    );
    // 同一个坑的另一半：工具定义页的枚举（2026-10-22 之前一直没注册）
    expect(messages['tool.source_state.ACTIVE']).toBe('生效中');
  });

  it('⭐ en-US 同样注册了，且不是把中文抄过去', () => {
    const messages = enUS as Record<string, string>;
    expect(messages['toolCall.state.running']).toBe('Calling');
    expect(messages['toolCall.name.agent.enter_plan_mode']).toBe(
      'Enter plan mode',
    );
  });

  it('中英两份的 key 集合完全一致（漏一条 = 英文界面露中文）', () => {
    expect(Object.keys(enToolCall).sort()).toEqual(
      Object.keys(zhToolCall).sort(),
    );
  });

  it('⭐ TOOL_KEYS 里的每个工具都有名字与说明（加了工具忘了翻译会红）', () => {
    const zh = zhToolCall as Record<string, string>;
    const en = enToolCall as Record<string, string>;
    for (const key of TOOL_KEYS) {
      expect(zh[`toolCall.name.${key}`], `zh 缺 ${key} 的名字`).toBeTruthy();
      expect(zh[`toolCall.desc.${key}`], `zh 缺 ${key} 的说明`).toBeTruthy();
      expect(en[`toolCall.name.${key}`], `en 缺 ${key} 的名字`).toBeTruthy();
    }
  });
});

describe('命中文案', () => {
  it('⭐ 工具名翻成人话：agent.enter_plan_mode -> 进入计划模式', () => {
    const container = mount('agent.enter_plan_mode', { messages: zhToolCall });
    expect(text(container, 'name')).toBe('进入计划模式');
  });

  it('英文界面走 en-US 那份', () => {
    const container = mount('document.retrieve_documents', {
      messages: enToolCall,
      locale: 'en-US',
    });
    expect(text(container, 'name')).toBe('Search documents');
  });

  it('悬停说明带着原值（排障要按原值对齐后端日志）', () => {
    const container = mount('web.search', { messages: zhToolCall });
    const hint = text(container, 'hint');
    expect(hint).toContain('搜索公开网页');
    expect(hint).toContain('web.search');
  });
});

describe('同一个工具的三种写法只能有一个名字', () => {
  it('⭐ 点分 / 下划线 / 短名都归一到同一段译文', () => {
    expect(canonicalToolKey('agent.current_time')).toBe('agent.current_time');
    expect(canonicalToolKey('agent_current_time')).toBe('agent.current_time');
    expect(canonicalToolKey('current_time')).toBe('agent.current_time');

    for (const raw of [
      'agent.current_time',
      'agent_current_time',
      'current_time',
    ]) {
      expect(text(mount(raw, { messages: zhToolCall }), 'name')).toBe(
        '查询当前时间',
      );
    }
  });

  it('⚠️ 短名有歧义就不认（search 同时能对上 web.search 与 memory.search）', () => {
    // 唯一后缀才归一；有歧义时宁可显示原值，也不要给 A 工具安 B 的名字
    expect(canonicalToolKey('search')).toBe('search');
    expect(text(mount('search', { messages: zhToolCall }), 'name')).toBe(
      'search',
    );
  });

  it('⚠️ 相近但不是同一个工具：不许互相顶替（web.search ≠ doc.search）', () => {
    expect(canonicalToolKey('doc.search')).toBe('doc.search');
    const container = mount('doc.search', { messages: zhToolCall });
    expect(text(container, 'name')).toBe('doc.search');
  });
});

describe('四态措辞', () => {
  const STATE: Array<[ToolCallStatus | undefined, string]> = [
    ['running', '正在调用'],
    ['done', '调用成功'],
    ['error', '调用失败'],
    [undefined, '调用'],
  ];

  for (const [status, expected] of STATE) {
    it(`${status ?? '缺省'} -> ${expected}`, () => {
      const container = mount('document.retrieve_documents', {
        status,
        messages: zhToolCall,
      });
      expect(text(container, 'state')).toBe(expected);
    });
  }

  it('⭐ 状态词不带标点：它现在只当 aria-label，不再拼在名字前面', () => {
    // 2026-10-23 起界面上不印状态词（只要图标），这几个词只喂给 aria-label。
    // 带个冒号去念"调用成功："很奇怪，所以这里把"必须是干净的词"钉住。
    for (const status of ['running', 'done', 'error'] as const) {
      const state = text(
        mount('web.search', { status, messages: zhToolCall }),
        'state',
      );
      expect(state).not.toMatch(/[：:]/);
      expect(state.trim()).toBe(state);
    }
  });

  it('英文同理（一个词，不带冒号）', () => {
    const container = mount('document.retrieve_documents', {
      status: 'error',
      messages: enToolCall,
      locale: 'en-US',
    });
    expect(text(container, 'state')).toBe('Call failed');
    expect(text(container, 'name')).toBe('Search documents');
  });
});

/**
 * MCP 工具（`<provider>.<tool>`）不在源码里，只能按后端 `app/config/mcp.yaml`
 * 的 allowlist 登记。链路上报的是 **wire 写法**（`tdx_get_market_info`），
 * 所以要靠归一才查得到译文 —— 这条是用户 2026-10-23 直接报的那一个。
 */
describe('MCP 工具（tdx）', () => {
  it('⭐ tdx_get_market_info -> 查询市场信息（wire 写法也要命中）', () => {
    for (const raw of ['tdx.get_market_info', 'tdx_get_market_info']) {
      expect(text(mount(raw, { messages: zhToolCall }), 'name')).toBe(
        '查询市场信息',
      );
    }
  });

  it('allowlist 里 9 个都有名字（漏一个就会露原值）', () => {
    const zh = zhToolCall as Record<string, string>;
    for (const tool of [
      'ensure_tdx_ready',
      'get_market_info',
      'screen_stocks',
      'screen_combo',
      'run_backtest',
      'get_financial_info',
      'get_market_stats',
      'check_version',
      'list_experts',
    ]) {
      expect(zh[`toolCall.name.tdx.${tool}`], `缺 tdx.${tool}`).toBeTruthy();
      expect(TOOL_KEYS).toContain(`tdx.${tool}`);
    }
  });
});

describe('回落（缺一层就会露 undefined）', () => {
  it('⭐ 没登记的工具（MCP 动态）显示原值，不是 undefined', () => {
    const container = mount('acme.do_thing', { messages: zhToolCall });
    const name = text(container, 'name');
    expect(name).toBe('acme.do_thing');
    expect(name).not.toContain('undefined');
  });

  it('没名字那条：占位换成译文，不带括号', () => {
    const container = mount(UNNAMED_TOOL, { messages: zhToolCall });
    expect(text(container, 'name')).toBe('未命名工具');
  });

  it('失败原因：有就给原文，没有给通用文案', () => {
    expect(
      text(
        mount('web.search', { messages: zhToolCall, error: '429 限流' }),
        'error',
      ),
    ).toBe('429 限流');
    expect(text(mount('web.search', { messages: zhToolCall }), 'error')).toBe(
      '工具执行失败',
    );
    // 只有空白也算没给
    expect(
      text(mount('web.search', { messages: zhToolCall, error: '  ' }), 'error'),
    ).toBe('工具执行失败');
  });

  it('⭐ 整个应用没挂 Provider 也不崩：用内置兜底那份中文', () => {
    const container = mount('web.search', { status: 'running' });
    expect(text(container, 'state')).toBe('正在调用');
    // 名字没有兜底译文 —— 原值就是兜底
    expect(text(container, 'name')).toBe('web.search');
  });
});
