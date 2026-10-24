import { LogoutOutlined } from '@ant-design/icons';
import { history, useModel } from '@umijs/max';
import type { MenuProps } from 'antd';
import { Spin } from 'antd';
import React, { startTransition } from 'react';
import { logout } from '@/services/auth';
import HeaderDropdown from '../HeaderDropdown';

type GlobalHeaderRightProps = {
  children?: React.ReactNode;
};

const menuItems: MenuProps['items'] = [
  {
    key: 'logout',
    icon: <LogoutOutlined />,
    label: '退出登录',
  },
];

/**
 * 退出登录：**只清本地 token**，然后回登录页。
 *
 * ⚠️ 这里**不会**结束 Casdoor 那边的单点登录会话
 * -------------------------------------------------
 *   契约（user.yaml）没有登出端点 —— 它的四个接口是 login / callback /
 *   refresh / me。所以"退出"的含义是"这块浏览器不再持有令牌"，
 *   而不是"在 Casdoor 里登出"。直接后果：退出后再点登录，
 *   如果 Casdoor 那边的 SSO 会话还在，会**不再要求输入密码**直接回来。
 *   这是 SSO 的正常行为，不是 bug。
 *
 *   要让"退出"同时结束 Casdoor 会话，得让浏览器去访问 Casdoor 的登出地址
 *   （形如 `{front_endpoint}/login/oauth/logout?client_id=…&post_logout_redirect_uri=…`）。
 *   那需要后端把它作为配置暴露出来（前端不该自己拼 Casdoor 的地址），
 *   目前契约里没有，所以不做 —— 不猜。
 *
 * ⚠️ 这里不调 `POST /api/login/outLogin`。那个接口后端从来没有过，只在模板自带的
 *    根目录 `mock/user.ts` 里存在过（该示例数据已随其余 sample 代码一并删除）；
 *    调它只会让"登出到底做了什么"变得含糊。
 */
const loginOut = () => {
  // 先清 token：即使下面的跳转因为任何原因没发生，本地也已经是登出态
  logout();

  const { search, pathname } = window.location;
  const urlParams = new URL(window.location.href).searchParams;
  const searchParams = new URLSearchParams({
    redirect: pathname + search,
  });
  const redirect = urlParams.get('redirect');
  if (window.location.pathname !== '/user/login' && !redirect) {
    history.replace({
      pathname: '/user/login',
      search: searchParams.toString(),
    });
  }
};

export const AvatarDropdown: React.FC<GlobalHeaderRightProps> = ({
  children,
}) => {
  const { initialState, setInitialState } = useModel('@@initialState');

  const onMenuClick: MenuProps['onClick'] = (event) => {
    if (event.key === 'logout') {
      startTransition(() => {
        setInitialState((s) => ({ ...s, currentUser: undefined }));
      });
      loginOut();
    }
  };

  if (!initialState) {
    return <Spin size="small" />;
  }

  const { currentUser } = initialState;

  if (!currentUser) {
    return <Spin size="small" />;
  }

  return (
    <HeaderDropdown
      placement="bottomRight"
      menu={{
        selectedKeys: [],
        onClick: onMenuClick,
        items: menuItems,
      }}
      arrow
    >
      {children}
    </HeaderDropdown>
  );
};
