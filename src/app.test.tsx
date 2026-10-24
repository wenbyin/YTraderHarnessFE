import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all heavy dependencies before importing app
const mockReplace = vi.fn();
const mockHistory = {
  location: {
    pathname: '/documents',
    search: '',
    hash: '',
  },
  replace: mockReplace,
};

const auth = vi.hoisted(() => ({
  describeCurrentUser: vi.fn(),
  getAccessToken: vi.fn(() => 'access-token' as string | null),
  getRefreshToken: vi.fn(() => 'refresh-token' as string | null),
  redirectToLogin: vi.fn(),
}));

vi.mock('@umijs/max', () => ({
  history: mockHistory,
  Link: ({ children }: any) => children,
}));

/**
 * 只替换**有副作用**的那几个（发请求 / 跳转 / 读存储），
 * `toProCurrentUser`、`CALLBACK_PATH` 用真的 —— 不然映射逻辑就没被测到了。
 */
vi.mock('@/services/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/auth')>();
  return {
    ...actual,
    describeCurrentUser: auth.describeCurrentUser,
    getAccessToken: auth.getAccessToken,
    getRefreshToken: auth.getRefreshToken,
    redirectToLogin: auth.redirectToLogin,
  };
});

vi.mock('@/components', () => ({
  AvatarDropdown: () => null,
  ErrorBoundary: ({ children }: any) => children,
  Footer: () => null,
  LangDropdown: () => null,
  OfflineBanner: () => null,
}));

// 注意：这里**不能**只 mock 几个图标。app.tsx 的模块图里有在模块作用域就用图标的文件
// （src/menuGroups.tsx 的菜单图标），vitest 的 mock 是个 Proxy，访问缺失的导出会直接抛
// 「No "XXXOutlined" export is defined」。所以干脆不 mock，用真图标 —— 反正这个测试
// 只跑 getInitialState，不渲染任何东西。
vi.mock('./requestErrorConfig', () => ({
  errorConfig: {},
}));

vi.mock('../config/defaultSettings', () => ({
  default: { navTheme: 'light' },
}));

// ⚠️ 单个用例给到 60s：这个 describe 里每条都要 `await import('./app')`，
// 第一次 import 要拉 app.tsx 整条模块图（KaTeX / lit / 全量图标），单机约 5s，
// 全量并行跑时会被压过默认 15s —— 那是冷启动成本，不是逻辑失败。
describe('app getInitialState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistory.location = {
      pathname: '/documents',
      search: '',
      hash: '',
    };
    auth.getAccessToken.mockReturnValue('access-token');
    auth.getRefreshToken.mockReturnValue('refresh-token');
  });

  it('非登录页会拉当前用户，并把契约字段映射成布局要的形状', async () => {
    const { getInitialState } = await import('./app');
    auth.describeCurrentUser.mockResolvedValue({
      subject: 'u-1',
      display_name: 'Test User',
      groups: ['Y-Trader-User'],
    });

    const state = await getInitialState();

    expect(auth.describeCurrentUser).toHaveBeenCalled();
    expect(state.currentUser).toEqual({
      name: 'Test User',
      userid: 'u-1',
      group: 'Y-Trader-User',
    });
    expect(state.fetchUserInfo).toBeDefined();
  });

  it('本地一个 token 都没有 → 连 /auth/me 都不发，直接跳登录', async () => {
    const { getInitialState } = await import('./app');
    auth.getAccessToken.mockReturnValue(null);
    auth.getRefreshToken.mockReturnValue(null);

    const state = await getInitialState();

    // 不发那次注定 401 的请求
    expect(auth.describeCurrentUser).not.toHaveBeenCalled();
    expect(auth.redirectToLogin).toHaveBeenCalled();
    expect(state.currentUser).toBeUndefined();
  });

  it('取用户失败（401/403）→ 跳登录且 currentUser 为空', async () => {
    const { getInitialState } = await import('./app');
    auth.describeCurrentUser.mockRejectedValue(new Error('401 Unauthorized'));

    const state = await getInitialState();

    expect(auth.redirectToLogin).toHaveBeenCalled();
    expect(state.currentUser).toBeUndefined();
  });

  it('登录页不拉用户', async () => {
    const { getInitialState } = await import('./app');
    mockHistory.location = {
      pathname: '/user/login',
      search: '',
      hash: '',
    };

    const state = await getInitialState();

    expect(auth.describeCurrentUser).not.toHaveBeenCalled();
    expect(state.currentUser).toBeUndefined();
    expect(state.fetchUserInfo).toBeDefined();
  });

  it('⚠️ 回调页不拉用户 —— 此刻还没有 token，拉一次就是把人踢走、code 白拿', async () => {
    const { getInitialState } = await import('./app');
    mockHistory.location = {
      pathname: '/user/callback',
      search: '?code=abc&state=xyz',
      hash: '',
    };

    const state = await getInitialState();

    expect(auth.describeCurrentUser).not.toHaveBeenCalled();
    // 更不能跳登录：回调页的活儿就是拿 code 换 token
    expect(auth.redirectToLogin).not.toHaveBeenCalled();
    expect(state.currentUser).toBeUndefined();
    expect(state.fetchUserInfo).toBeDefined();
  });

  it('初始 state 里带默认布局设置', async () => {
    const { getInitialState } = await import('./app');
    auth.describeCurrentUser.mockResolvedValue({ subject: 'u-1' });

    const state = await getInitialState();

    expect(state.settings).toEqual({ navTheme: 'light' });
  });

  it('fetchUserInfo 返回映射后的用户', async () => {
    const { getInitialState } = await import('./app');
    auth.describeCurrentUser.mockResolvedValue({
      subject: 'u-2',
      name: 'Fetched User',
    });

    const state = await getInitialState();

    const user = await state.fetchUserInfo?.();
    expect(user).toEqual({ name: 'Fetched User', userid: 'u-2' });
  });
}, 60_000);

/**
 * 侧栏左上角**不放任何标识**（品牌只出现在登录页文字与标签页图标上）。
 *
 * 钉的是 ProLayout 的一条约定：`menuHeaderRender` 返回 null 时，SiderMenu 里的
 * `headerDom && <div className="ant-pro-sider-logo">` 整块不渲染 —— 也就是不会
 * 留下一条 64px 的空白带。顺带钉住 `settings` 里不再有 logo（否则登录页的
 * `Settings.logo ?? '/logo.svg'` 会把 Ant Design 的旧图又捡回来）。
 */
describe('layout: 左上角不留 logo', () => {
  it('menuHeaderRender 恒为 null，且 settings 不再配 logo', async () => {
    const { layout } = await import('./app');
    const { default: settings } = await import('../config/defaultSettings');

    const props = layout({ initialState: {} } as never) as Record<
      string,
      unknown
    >;
    const render = props.menuHeaderRender as (
      logo: unknown,
      title: unknown,
      p: unknown,
    ) => unknown;

    expect(typeof render).toBe('function');
    expect(render('<logo/>', '<h1/>', { collapsed: false })).toBeNull();
    expect(render('<logo/>', null, { collapsed: true })).toBeNull();
    expect(settings.logo).toBeUndefined();
  });
}, 60_000);

/**
 * 侧栏头像：ProLayout 是**有条件**才画 `<Avatar>` 的。
 *
 * `SiderMenu.js` 里写着：
 *   rest.src || rest.srcSet || rest.icon || rest.children
 *     ? <Avatar size={28} {...rest} />
 *     : null                            // 四者皆空 → 连 <Avatar> 都不渲染
 *   avatarProps.title && !collapsed     // 旁边那行名字，收起态被挡掉
 *
 * 后端 `/auth/me` 没有头像字段（`toProCurrentUser` 只映射 name/email/group），
 * 所以 `src` 恒为 undefined —— 不给 `children` 兜底的话，**收起态那块是空的**
 * （但仍是 Dropdown 的触发器，于是"点得到、看不见"）。
 */
describe('layout: 侧栏头像要有兜底', () => {
  it('登录后至少有一个渲染条件成立（这里靠 children 的首字）', async () => {
    const { layout } = await import('./app');
    const props = layout({
      initialState: { currentUser: { name: '尹文彬', userid: 'u-1' } },
    } as never) as { avatarProps?: Record<string, unknown> };

    const avatar = props.avatarProps ?? {};
    expect(avatar.src).toBeUndefined();
    expect(Boolean(avatar.src || avatar.srcSet || avatar.icon)).toBe(false);
    expect(avatar.children).toBe('尹');
  });

  it('没有名字时不给空字符串（交给 ProLayout 走 null 分支）', async () => {
    const { layout } = await import('./app');
    const props = layout({ initialState: {} } as never) as {
      avatarProps?: Record<string, unknown>;
    };

    expect(props.avatarProps?.children).toBeUndefined();
  });
}, 60_000);
