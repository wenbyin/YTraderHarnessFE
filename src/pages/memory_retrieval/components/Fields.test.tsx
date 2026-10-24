// src/pages/memory_retrieval/components/Fields.test.tsx
//
// ScopeFields / ScopeSwitch 这对的钉桩。
//
// 这里守的是一条**结构性**约定，不是文案：
//
//   user_id 与 team_id **恰有一个** —— 契约里"两个都给"是 400，
//   而这一版把「二选一」做成了开关：切过去就把另一侧清掉，
//   界面上也只渲染当前那一侧的控件。
//
// 所以断言的是"另一侧真的被清掉了"，而不是"校验函数返回了 both"。
// 只看校验函数的话，界面发出去一个必然 400 的请求也照样"通过"。
//
// ⚠️ 2026-10-12：开关从参数区搬到了**卡头**（与右上角的端点 Tag 同一行），于是它和
//    参数控件不再在同一个 DOM 位置 —— state 上提到父层，页面用 `useScopeSwitch`。
//    Harness 就是照页面那样接的（同一个 hook），所以在测试里跑的就是线上那套逻辑。
//
// `searchUsers` 必须换掉（真实现会走 axios 打网络，happy-dom 里必然失败）——
// 默认态渲染的选人控件一挂载就会拉一次。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/auth', () => ({ searchUsers: searchMock }));

import type { UserOption } from '@/services/auth';
import {
  AGENT_ID_OPTIONS,
  DEFAULT_PREVIEW_LAYERS,
  DEFAULT_PREVIEW_LIMITS,
  DEFAULT_TARGET_INPUT,
  EMPTY_TARGET_INPUT,
  type TargetInput,
} from '../utils';
import {
  PreviewLayersFields,
  ScopeFields,
  ScopeSwitch,
  useScopeSwitch,
} from './Fields';

const ZHANGSAN: UserOption = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'zhangsan',
  display_name: '张三',
};

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([ZHANGSAN]);
});

afterEach(() => {
  cleanup();
});

/**
 * 真实的受控父组件：本页就是这么用的 ——
 * 开关在"卡头"那个 slot、参数在"卡体"，两者共用 `useScopeSwitch` 这一份状态。
 */
const Harness: React.FC<{ initial?: TargetInput }> = ({ initial }) => {
  const [target, setTarget] = useState<TargetInput>(
    initial ?? EMPTY_TARGET_INPUT,
  );
  const { scope, change, reset } = useScopeSwitch(target, setTarget);
  return (
    <>
      <div data-testid="card-head">
        <ScopeSwitch scope={scope} onChange={change} />
      </div>
      <ScopeFields
        target={target}
        scope={scope}
        sessionId=""
        onTargetChange={setTarget}
        onSessionChange={() => {}}
      />
      <button type="button" data-testid="reset-scope" onClick={reset}>
        重置档位
      </button>
      {/* 让断言直接看"父页面手里的 target"，而不是猜控件显示成什么样 */}
      <div data-testid="target">{JSON.stringify(target)}</div>
    </>
  );
};

const targetOf = (): TargetInput =>
  JSON.parse(screen.getByTestId('target').textContent ?? '{}') as TargetInput;

const switchEl = (): HTMLElement => {
  const el = document.querySelector('.ant-switch');
  if (!el) throw new Error('没有 .ant-switch（开关没渲染出来？）');
  return el as HTMLElement;
};

/**
 * 选人控件在不在。
 *
 * ⚠️ 不能再用 `.ant-select` 判 —— 2026-10-12 起 agent_id 也是 Select，
 *    本页有**两个** `.ant-select`，拿类名问"选人控件在不在"会恒为真。
 *    所以 UserPicker 上挂了 `data-user-picker` 这个稳定抓手。
 */
const hasUserPicker = (): boolean =>
  !!document.querySelector('[data-user-picker]');

const teamInput = (): HTMLInputElement | null =>
  screen.queryByPlaceholderText('团队记忆的归属组织');

/** agent_id 那个下拉框的可见文本（当前值或 placeholder）。 */
const agentText = (): string => {
  const root = document.querySelectorAll('.ant-select')[1];
  return root?.textContent ?? '';
};

describe('target 的二选一开关', () => {
  it('默认是「个人」：只渲染选人控件，不渲染 team_id 输入框', async () => {
    render(<Harness />);
    await act(async () => {});

    expect(hasUserPicker()).toBe(true);
    expect(teamInput()).toBeNull();
    // agent_id 不是二选一的一部分，两种模式下都在（它现在是个下拉框）
    expect(document.body.textContent).toContain('选择一个 agent');
  });

  it('⚠️ 切到「团队」：选人控件消失，且**父页面的 user_id 被清空**', async () => {
    render(
      <Harness
        initial={{ user_id: ZHANGSAN.id, team_id: '', agent_id: 'd-1' }}
      />,
    );
    await act(async () => {});
    expect(hasUserPicker()).toBe(true);

    fireEvent.click(switchEl());
    await act(async () => {});

    expect(teamInput()).not.toBeNull();
    expect(hasUserPicker()).toBe(false);
    // 关键：另一侧真的空了 —— 不然请求体里就是"两个都给"那个 400
    expect(targetOf().user_id).toBe('');
    expect(targetOf().agent_id).toBe('d-1');
  });

  it('⚠️ 切回「个人」：team_id 被清空，选人控件回来', async () => {
    // 从"团队已填好"的状态出发：开关要自己处在团队那一档
    render(
      <Harness initial={{ user_id: '', team_id: 'org-a', agent_id: 'd-1' }} />,
    );
    await act(async () => {});
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(hasUserPicker()).toBe(false);

    fireEvent.click(switchEl());
    await act(async () => {});

    expect(hasUserPicker()).toBe(true);
    expect(teamInput()).toBeNull();
    expect(targetOf().team_id).toBe('');
    expect(targetOf().user_id).toBe('');
  });

  it('开关的状态跟着 target 走（外部给了 team_id 就是团队档，不靠内部猜）', async () => {
    render(
      <Harness initial={{ user_id: '', team_id: 'org-a', agent_id: 'd-1' }} />,
    );
    await act(async () => {});
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
  });

  it('反过来：外部给了 user_id 就是个人档', async () => {
    render(
      <Harness
        initial={{ user_id: ZHANGSAN.id, team_id: '', agent_id: 'd-1' }}
      />,
    );
    await act(async () => {});
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
  });

  it('团队那一档下 team_id 是**文本**（组织名不在 Casdoor 目录里，没有可查的地方）', async () => {
    render(<Harness initial={{ user_id: '', team_id: '', agent_id: 'd-1' }} />);
    await act(async () => {});
    fireEvent.click(switchEl());
    await act(async () => {});

    // 还没填：下面要如实说"归属还差一个"，而不是安静地显示一个看着合理的状态
    expect(document.body.textContent).toContain('恰有一个');
    // ⚠️ 这段说明是 JSX 文本 —— 里面写了 markdown 星号会**原样渲染**出来
    //    （这一版就踩过一次：它**不在 Casdoor 目录里**）。所以这里钉住。
    expect(document.body.textContent).not.toContain('**');

    const input = teamInput();
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, { target: { value: 'org-x' } });
    await act(async () => {});

    expect(targetOf().team_id).toBe('org-x');
    expect(document.body.textContent).toContain('team · 团队记忆');
  });
});

describe('开关搬到卡头之后（state 上提，开关与参数不在一处）', () => {
  it('开关渲染在"卡头"那个 slot 里，参数区里**没有**第二个开关', async () => {
    render(
      <Harness initial={{ user_id: '', team_id: 'org-a', agent_id: 'd' }} />,
    );
    await act(async () => {});

    expect(
      screen.getByTestId('card-head').querySelector('.ant-switch'),
    ).toBeTruthy();
    // 参数区里不该再有一份 —— 两份 state 一定会分叉
    expect(document.querySelectorAll('.ant-switch').length).toBe(1);
  });

  it('「重置」把档位拨回「个人」（页面级重置要连它一起清）', async () => {
    render(
      <Harness initial={{ user_id: '', team_id: 'org-a', agent_id: 'd' }} />,
    );
    await act(async () => {});
    expect(switchEl().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('reset-scope'));
    await act(async () => {});

    expect(switchEl().getAttribute('aria-checked')).toBe('false');
    // 只拨档位，不动 target 本身（target 由页面的重置一起清）
    expect(targetOf().team_id).toBe('org-a');
  });

  it('⚠️ 切到团队但还没填组织名时，档位**不回弹**（只靠 resolveScopeKind 推就会弹回去）', async () => {
    render(
      <Harness
        initial={{ user_id: ZHANGSAN.id, team_id: '', agent_id: 'd' }}
      />,
    );
    await act(async () => {});

    fireEvent.click(switchEl());
    await act(async () => {});

    // 这一刻 target 两个归属都是空的 → resolveScopeKind 给 null
    expect(targetOf().user_id).toBe('');
    expect(targetOf().team_id).toBe('');
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(teamInput()).not.toBeNull();
  });
});

describe('agent_id 是下拉框（只有一个候选，暂时前端写死）', () => {
  it('⚠️ 不是 Input —— 手打这个必填业务键的表现是"空结果而不是报错"', async () => {
    render(<Harness />);
    await act(async () => {});

    // agent_id 那一档是 Select（本页第二个 .ant-select），placeholder 是可见文案
    expect(document.body.textContent).toContain('选择一个 agent');
    // 它**不是**自由文本输入框：没有 agent 相关的文本 input
    expect(screen.queryByPlaceholderText('必填，例如某个 duty_key')).toBeNull();
  });

  it('候选集只有一个 general，选中它写回 target', async () => {
    render(<Harness initial={{ ...EMPTY_TARGET_INPUT }} />);
    await act(async () => {});

    const select = document.querySelectorAll('.ant-select')[1] as HTMLElement;
    // 打开下拉（mousedown 是 rc-select 认的）
    fireEvent.mouseDown(select.querySelector('.ant-select-content') ?? select);
    await act(async () => {});

    const option = Array.from(
      document.querySelectorAll('.ant-select-item-option'),
    ).find((el) => el.textContent === AGENT_ID_OPTIONS[0]);
    expect(option).toBeTruthy();

    fireEvent.click(option as HTMLElement);
    await act(async () => {});

    expect(targetOf().agent_id).toBe('general');
  });

  it('⚠️ 默认值就是 general（"刚打开的样子"）—— 与"什么都没选"不是一回事', async () => {
    render(
      <Harness initial={{ ...DEFAULT_TARGET_INPUT, user_id: ZHANGSAN.id }} />,
    );
    await act(async () => {});

    expect(targetOf().agent_id).toBe('general');
    expect(agentText()).toContain('general');
  });
});

describe('汇总的四层开关（顺序 L0 -> L3，数量跟着召回端点走）', () => {
  const noop = () => {};

  it('⚠️ 渲染顺序是 L0 -> L3（用户 2026-10-12 要求"检索条件也是排序"）', () => {
    render(
      <PreviewLayersFields
        retrieve={{ ...DEFAULT_PREVIEW_LAYERS, l0: true, l1: true }}
        limits={{ ...DEFAULT_PREVIEW_LIMITS }}
        onRetrieveChange={noop}
        onLimitsChange={noop}
      />,
    );

    // 四个层的标签在 DOM 里的先后 = 渲染顺序
    const labels = ['L0 原始对话', 'L1 原子记忆', 'L2 场景', 'L3 画像'];
    const order = labels
      .map((label) => ({
        label,
        at: (document.body.textContent ?? '').indexOf(label),
      }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.label);
    expect(order).toEqual(labels);
    expect(
      labels.every((l) => (document.body.textContent ?? '').includes(l)),
    ).toBe(true);
  });

  it('默认态：L0/L1 关、L2/L3 开（"会真的召回"那一档默认不动）', () => {
    render(
      <PreviewLayersFields
        retrieve={{ ...DEFAULT_PREVIEW_LAYERS }}
        limits={{ ...DEFAULT_PREVIEW_LIMITS }}
        onRetrieveChange={noop}
        onLimitsChange={noop}
      />,
    );

    const switches = Array.from(document.querySelectorAll('.ant-switch'));
    expect(switches.length).toBe(4);
    // 顺序即 L0 / L1 / L2 / L3 → checked 状态
    expect(switches.map((el) => el.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'true',
    ]);
  });

  it('⚠️ 打开 L0 时会明说"这次会跑一轮召回"（它与 L2/L3 不是一类东西）', () => {
    render(
      <PreviewLayersFields
        retrieve={{ ...DEFAULT_PREVIEW_LAYERS, l0: true }}
        limits={{ ...DEFAULT_PREVIEW_LIMITS }}
        onRetrieveChange={noop}
        onLimitsChange={noop}
      />,
    );

    expect(document.body.textContent).toContain('这次会跑一轮召回');
    // ⚠️ 这些说明是 JSX 文本 —— 里面写 markdown 星号会原样渲染出来
    expect(document.body.textContent).not.toContain('**');
  });

  it('关掉的层条数禁用（"关了它条数还有意义吗"在界面上自己答了）', () => {
    render(
      <PreviewLayersFields
        retrieve={{ ...DEFAULT_PREVIEW_LAYERS }}
        limits={{ ...DEFAULT_PREVIEW_LIMITS }}
        onRetrieveChange={noop}
        onLimitsChange={noop}
      />,
    );

    const disabled = Array.from(
      document.querySelectorAll('.ant-input-number-disabled'),
    );
    // L0 / L1 默认关 → 两个条数框都是禁用的；L2 开着 → 那个可用
    expect(disabled.length).toBe(2);
  });
});
