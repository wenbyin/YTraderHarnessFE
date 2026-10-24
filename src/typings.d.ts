declare module '*.css';
declare module '*.less';
declare module '*.scss';
declare module '*.sass';
declare module '*.svg';
declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.gif';
declare module '*.bmp';
declare module '*.tiff';
declare module '*.md' {
  const content: string;
  export default content;
}
declare module 'mockjs';

declare const __APP_VERSION__: string;
declare const __UMI_VERSION__: string;
declare const __UTOO_VERSION__: string;

/**
 * Pro 布局认识的用户形状。
 *
 * 这个全局命名空间原来由 openapi 插件生成在
 * `src/services/ant-design-pro/typings.d.ts` —— 那个目录是模板的假接口产物，
 * 2026-10-24 改名 YTraderHarnessFE 时已删除，但 `access.ts` / `app.tsx` /
 * `services/auth/session.ts` 仍以 `API.CurrentUser` 引用它，所以在这里接手声明。
 *
 * 字段取 Pro 模板的标准集合；**实际填充的只有 name / userid / email / group**
 * （见 `services/auth/session.ts` 的 `toProCurrentUser`，那里刻意不填 access）。
 */
declare namespace API {
  type CurrentUser = {
    name?: string;
    avatar?: string;
    userid?: string;
    email?: string;
    signature?: string;
    title?: string;
    group?: string;
    tags?: { key?: string; label?: string }[];
    notifyCount?: number;
    unreadCount?: number;
    country?: string;
    access?: string;
    geographic?: {
      province?: { label?: string; key?: string };
      city?: { label?: string; key?: string };
    };
    address?: string;
    phone?: string;
  };
}
