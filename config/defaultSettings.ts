import type { ProLayoutProps } from '@ant-design/pro-components';

/**
 * @name
 */
const Settings: ProLayoutProps = {
  navTheme: 'light',
  colorPrimary: '#1677ff',
  // 侧边菜单布局（不是 mix 混合菜单）
  layout: 'side',
  // 侧边菜单用经典样式：二级菜单是弹出式子菜单（'group' 会把二级菜单铺成扁平分组）
  siderMenuType: 'sub',
  contentWidth: 'Fluid',
  fixedHeader: false,
  fixSiderbar: true,
  colorWeak: false,
  title: 'YTraderHarnessFE',
  // ⚠️ 刻意**不配 `logo`**：工作台左上角不放标识（见 src/app.tsx 的 menuHeaderRender），
  // 登录页的品牌名是文字（src/pages/user/login/index.tsx）。ProLayout 拿不到 logo 就不会画图。
  iconfontUrl: '',
  token: {
    // 参见ts声明，demo 见文档，通过token 修改样式
    //https://procomponents.ant.design/components/layout#%E9%80%9A%E8%BF%87-token-%E4%BF%AE%E6%94%B9%E6%A0%B7%E5%BC%8F
  },
};

export default Settings;
