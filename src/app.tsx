import type { Settings as LayoutSettings } from '@ant-design/pro-components';
import type { RequestConfig, RunTimeLayoutConfig } from '@umijs/max';
import { history, Link } from '@umijs/max';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import React from 'react';

// Initialize dayjs plugins globally
dayjs.extend(relativeTime);

import {
  AvatarDropdown,
  ErrorBoundary,
  Footer,
  LangDropdown,
  OfflineBanner,
} from '@/components';
import CopilotDock from '@/components/CopilotDock';
import { groupMenuData } from '@/menuGroups';
import {
  CALLBACK_PATH,
  describeCurrentUser,
  getAccessToken,
  getRefreshToken,
  redirectToLogin,
  toProCurrentUser,
} from '@/services/auth';
import defaultSettings from '../config/defaultSettings';
import { errorConfig } from './requestErrorConfig';

const isDev = process.env.NODE_ENV === 'development';
const loginPath = '/user/login';

/**
 * 这些路径**不做登录校验**（`getInitialState` 与 `onPageChange` 共用一份）。
 *
 * ⚠️ `/user/callback` 必须在这里，否则登录永远走不完
 * -------------------------------------------------
 *   回调页此刻**还没有 token** —— 它的工作就是用地址上的 code 去换 token。
 *   如果对它跑一次"有没有登录"的检查：
 *     · `getInitialState` 会调 `/auth/me` 拿 401 → 把人踢回登录页，
 *       而 code 已经在 URL 里等着了，一步都没走到就废了；
 *     · 就算不踢，`onPageChange` 也会在渲染后立刻再踢一次。
 *   两个地方都要放行，缺一个都能让登录流程在最后一步断掉。
 */
const NO_AUTH_PATHS = [loginPath, CALLBACK_PATH];

/**
 * 两块侧栏的默认形态：左侧菜单展开、右侧 AI 助手收起。
 *
 * 为什么两块状态都放在这里（而不是各自组件内部）：它们**互斥** —— 同一时刻最多只有一边
 * 展开，谁展开就要把另一边收起来。左侧菜单的折叠必须是 ProLayout 的受控 prop
 * （`collapsed` + `onCollapse`），所以它天然属于布局层的 React 状态；把面板的折叠也放进来，
 * 「改另一边」就只是同一个 updater 里的两个字段，不用跨组件广播事件。
 * 另外：这样折叠状态天然不落盘，刷新后一定是「菜单展开 + 面板收起」这个合法组合。
 */
const INITIAL_PANEL_STATE = {
  menuCollapsed: false,
  dockCollapsed: true,
} as const;

/**
 * @see https://umijs.org/docs/api/runtime-config#getinitialstate
 * */
export async function getInitialState(): Promise<{
  settings?: Partial<LayoutSettings>;
  currentUser?: API.CurrentUser;
  loading?: boolean;
  fetchUserInfo?: () => Promise<API.CurrentUser | undefined>;
  /** 左侧菜单是否收起 */
  menuCollapsed?: boolean;
  /** 右侧 AI 助手面板是否收起 */
  dockCollapsed?: boolean;
}> {
  /**
   * 取当前用户：`GET /api/v1/auth/me`（契约 user.yaml）。
   *
   * 它返回的是 `{ subject, name, display_name, email, groups }` —— 全部来自
   * access token 的 claims，后端**没有本地用户表**。所以这里要过一次
   * `toProCurrentUser` 映射成布局要的形状（ProLayout 读 `name` / `avatar`）。
   *
   * 失败时不一定落到这里：401 已经由请求层统一处理（刷新 → 重试 → 跳登录，
   * 见 requestErrorConfig）。这里只兜住"跳不过去"的收尾，并返回 undefined，
   * 让布局层按未登录渲染。
   */
  const fetchUserInfo = async () => {
    try {
      const me = await describeCurrentUser();
      return toProCurrentUser(me);
    } catch (_error) {
      redirectToLogin();
      return undefined;
    }
  };

  const baseState = {
    fetchUserInfo,
    settings: defaultSettings as Partial<LayoutSettings>,
    ...INITIAL_PANEL_STATE,
  };

  const { location } = history;

  // 登录页 / 回调页 / 注册页：不校验（理由见 NO_AUTH_PATHS）
  if (NO_AUTH_PATHS.includes(location.pathname)) {
    return baseState;
  }

  // 本地连 token 的影子都没有 → 不必白跑一次 /auth/me（它必然 401，
  // 而那次 401 只会在网络面板里留下一行没人看的红字）。
  if (!getAccessToken() && !getRefreshToken()) {
    redirectToLogin();
    return baseState;
  }

  const currentUser = await fetchUserInfo();
  return { ...baseState, currentUser };
}

/**
 * 头像里显示的字（后端没有头像图片时的兜底）。
 *
 * 取显示名的首字：中文取第一个字（"尹文彬" → "尹"），拉丁名取首字母大写。
 * 故意**不做**"两字取后两个字"之类的中文习惯处理 —— 名字可能是邮箱/拼音，
 * 规则一多就越界，而这里只需要一个能看出来的字。
 */
function avatarInitial(name?: string): string | undefined {
  const text = name?.trim();
  if (!text) return undefined;
  const first = Array.from(text)[0];
  return first ? first.toUpperCase() : undefined;
}

// ProLayout 支持的api https://procomponents.ant.design/components/layout
export const layout: RunTimeLayoutConfig = ({
  initialState,
  setInitialState,
}) => {
  const menuCollapsed =
    initialState?.menuCollapsed ?? INITIAL_PANEL_STATE.menuCollapsed;
  const dockCollapsed =
    initialState?.dockCollapsed ?? INITIAL_PANEL_STATE.dockCollapsed;

  /**
   * 左侧菜单与右侧 AI 助手面板**互斥**：同一时刻最多只有一边展开。
   * 两条规则完全对称 —— 「谁展开，就把另一边收起来；谁收起，不动另一边」：
   *   - 菜单展开（next=false）-> 面板收起；
   *   - 面板展开（next=false）-> 菜单收起。
   *
   * 不会互相触发成死循环：ProLayout 只在**用户点折叠触发器**时回调 onCollapse，
   * 受控 collapsed 变化本身不会再回调（见 @ant-design/pro-components 的 ProLayout 实现）。
   *
   * ⚠️ 有一路 onCollapse 不是用户点的：ProLayout 把 `breakpoint` 透传给了 antd 的 Sider，
   *    **窗口宽度跨过断点**（默认 'lg' = 992px）时 Sider 会自己回调 onCollapse ——
   *    变窄时 onCollapse(true)（菜单收起，面板不动），变宽时 onCollapse(false)（菜单展开，
   *    于是按规则把面板收起来）。所以「拖窗口变宽后面板自己关了」是这个断点行为导致的，
   *    不是 bug。要改的话得在 config/defaultSettings.ts 里给 ProLayout 传 `breakpoint: false`。
   */
  const setMenuCollapsed = (next: boolean) => {
    setInitialState((s) => ({
      ...s,
      menuCollapsed: next,
      dockCollapsed: next ? s?.dockCollapsed : true,
    }));
  };
  const setDockCollapsed = (next: boolean) => {
    setInitialState((s) => ({
      ...s,
      dockCollapsed: next,
      menuCollapsed: next ? s?.menuCollapsed : true,
    }));
  };

  return {
    // 受控折叠。必须显式给 collapsed，否则 ProLayout 走内部状态，
    // 面板展开时就没法把菜单收起来了。
    collapsed: menuCollapsed,
    onCollapse: setMenuCollapsed,
    // 菜单的二级折叠在这里做，不在 config/routes.ts 里（原因见那两个文件的头注释）：
    // 路由保持平铺，运行时再把菜单项按业务域收进 file / document / tool 三个分组。
    menuDataRender: (menuData) => groupMenuData(menuData),
    menuItemRender: (item, dom) => {
      if (item.path) {
        return (
          <Link to={item.path} prefetch>
            {dom}
          </Link>
        );
      }
      return dom;
    },
    actionsRender: () => {
      // `locale: false` opts out of the language switcher. ProLayout's own
      // `locale` prop is a locale string, so narrow to the boolean toggle here.
      const localeEnabled =
        (initialState?.settings as { locale?: boolean })?.locale !== false;
      return [localeEnabled && <LangDropdown key="lang" />].filter(Boolean);
    },
    avatarProps: {
      src: initialState?.currentUser?.avatar,
      // ⚠️ `children` 不是装饰，是**让头像在收起态也存在**的唯一办法。
      //
      // 后端 /auth/me 没有头像字段（services/auth 的 toProCurrentUser 只映射
      // name / email / group），所以 `src` 恒为 undefined。而 ProLayout 的侧栏头像是
      // 有条件的（SiderMenu.js 的 avatarDom）：
      //
      //   rest.src || rest.srcSet || rest.icon || rest.children
      //     ? <Avatar size={28} {...rest} />     // 四者皆空 → 连 <Avatar> 都不渲染
      //     : null
      //   旁边那行名字：avatarProps.title && !collapsed
      //
      // 结果就是：展开态只剩一行用户名；**收起态名字也被 !collapsed 挡掉**，
      // 那块区域彻底空白（但仍然是 Dropdown 的触发区，所以盲点也能弹出「退出登录」）。
      // 给一个首字兜底后，两种形态都有一个 28px 的头像可点。
      children: avatarInitial(initialState?.currentUser?.name),
      // 名字来自 /auth/me（display_name → name → email → subject，
      // 见 services/auth 的 toProCurrentUser）。这里不再写死占位名。
      title: initialState?.currentUser?.name ?? '未登录',
      render: (_, avatarChildren) => (
        <AvatarDropdown>{avatarChildren}</AvatarDropdown>
      ),
    },
    // waterMarkProps: {
    //   content: initialState?.currentUser?.name,
    // },
    footerRender: () => <Footer />,
    onPageChange: () => {
      const { location } = history;
      // 放行白名单里的页面（登录页自身、回调页）—— 对回调页做登录校验
      // 会让登录在最后一步永远走不完，理由见 NO_AUTH_PATHS。
      if (NO_AUTH_PATHS.includes(location.pathname)) return;
      // 如果没有登录，重定向到 login
      if (!initialState?.currentUser) {
        history.replace(
          `${loginPath}?redirect=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
        );
      }
    },
    bgLayoutImgList: [
      {
        src: 'https://mdn.alipayobjects.com/yuyan_qk0oxh/afts/img/D2LWSqNny4sAAAAAAAAAAAAAFl94AQBr',
        left: 85,
        bottom: 100,
        height: '303px',
      },
      {
        src: 'https://mdn.alipayobjects.com/yuyan_qk0oxh/afts/img/C2TWRpJpiC0AAAAAAAAAAAAAFl94AQBr',
        bottom: -68,
        right: -45,
        height: '303px',
      },
      {
        src: 'https://mdn.alipayobjects.com/yuyan_qk0oxh/afts/img/F6vSTbj8KpYAAAAAAAAAAAAAFl94AQBr',
        bottom: 0,
        left: 0,
        width: '331px',
      },
    ],
    // Replace ProLayout's default ErrorBoundary with our offline-aware version,
    // so chunk load errors show friendly messages instead of "Something went wrong."
    ErrorBoundary,
    /**
     * 左上角**不放 logo**。
     *
     * 品牌标识现在只在登录页（纯文字）和浏览器标签页图标（`public/favicon.ico`）上出现，
     * 工作台侧栏顶部保持干净 —— 菜单本身已经是导航的视觉起点，再压一个标识只是挤占行高。
     *
     * 实现上返回 `null` 而不是留一个空 logo 图：ProLayout 会先算 `headerDom`，
     * 为假时整块 `.ant-pro-sider-logo` 都不渲染（见 SiderMenu 的 `headerDom && <div>`），
     * 所以不会留下一条 64px 的空白带。这也顺带让 `Settings.logo` 彻底不再参与布局。
     */
    menuHeaderRender: () => null,
    // 自定义 403 页面
    // unAccessible: <div>unAccessible</div>,
    // 增加一个 loading 的状态
    childrenRender: (children) => {
      // if (initialState?.loading) return <PageLoading />;
      //
      // children 是 ProLayout 渲染出来的**路由内容**。CopilotDock 与它**并列**，
      // 不包裹它 —— AI 助手是固定在视口右侧的常驻面板（左侧菜单的镜像），
      // 它给内容区腾出来的宽度由自己写在 :root 上的 --copilot-dock-w 配合
      // src/global.less 里的 `.ant-pro-layout { padding-right }` 一起完成。
      // 挂在这里（而不是页面内部）是为了：切页面时它不卸载，对话窗口不受影响。
      //
      // 折叠状态从 initialState 读、写回 initialState —— 这样它才能跟左侧菜单互斥
      // （见上面 setMenuCollapsed / setDockCollapsed）。
      //
      // 布局设置抽屉（SettingDrawer）已按需求移除：布局参数写死在
      // config/defaultSettings.ts 里，不再给用户现场改。
      return (
        <>
          {children}
          <CopilotDock
            collapsed={dockCollapsed}
            onCollapsedChange={setDockCollapsed}
          />
        </>
      );
    },
    ...initialState?.settings,
  };
};

/**
 * @name request 配置，可以配置错误处理
 * 它基于 axios 提供了一套统一的网络请求和错误处理方案。
 * @doc https://umijs.org/docs/max/request#配置
 */
export const request: RequestConfig = {
  baseURL: isDev ? '' : 'https://pro-api.ant-design-demo.workers.dev',
  ...errorConfig,
};

export function rootContainer(container: React.ReactNode) {
  return (
    <>
      <OfflineBanner />
      <ErrorBoundary>{container}</ErrorBoundary>
    </>
  );
}
