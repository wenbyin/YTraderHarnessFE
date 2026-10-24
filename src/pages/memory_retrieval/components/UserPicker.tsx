// src/pages/memory_retrieval/components/UserPicker.tsx
//
// 选人控件 —— 后端 `GET /api/v1/users/search`（契约 app/services/user/user.yaml）。
//
// 为什么 memory_retrieval 页面**必须**用选人而不是填字符串
// ------------------------------------------------------
//   本页的 target 里 user_id 是 **Casdoor 的用户 id（UUID）**。上一版让人手填，
//   而本页自己反复强调的那条风险恰好在这里：
//
//     「查错了人」事后没有任何办法发现 —— 两种查询在数据上都是合法的空结果。
//
//   手填一个 UUID 是这条风险的最坏形态：36 个十六进制字符打错一位，界面上
//   看不出任何异常，只是"一条都没有"。所以改成从目录里选：
//   **显示给人看的只有人名，提交出去的是 id**（下拉里不显示 UUID —— 见
//   userOptionLabel 的说明）。
//
// 只允许选、不允许输入
// ------------------
//   `Select` 单值模式 + `showSearch`：敲进去的字符串**只是服务端筛选的关键字**，
//   永远进不了 value（value 只可能来自被点的那个 option 的 `value`）。
//   这一点是刻意的，不要改成 `mode="tags"`（那个会把自由文本变成值）。
//   项目自己的 CDP 探针里有一条断言钉着它："输入文字后失焦，onChange 不该被调用"。
//
// 两条契约口径（会让人误判"这个人在不在"，所以在界面上说清楚）
// ---------------------------------------------------------
//   1. 匹配是**子串**，字段是 name / email / id 三个；
//   2. 匹配**区分大小写**（`yin` 命中，`YIN` 不命中）—— 那是 Casdoor 自己的
//      比较方式，不是后端的选择。所以"搜不到"不等于"这个人不存在"。
//
//   `keyword` 不给 = 列出该组织的前 `limit` 个用户、不做筛选。契约明说这是给
//   选择器准备的用法（"showing a picker before the user types anything"），
//   所以挂载时空关键字先拉一次是**设计好的行为**，不是浪费。
import { Select, Spin } from 'antd';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { UserOption } from '@/services/auth';
import { searchUsers } from '@/services/auth';

import { useStyles } from '../style';

/** 敲字到发请求之间的等待。选择器不该一个字一个请求。 */
export const SEARCH_DEBOUNCE_MS = 300;

/** 契约的 default。上限是 50（喂选择器的接口，不是搜索结果页）。 */
export const USER_PICKER_LIMIT = 20;

// ---------------------------------------------------------------- 纯函数

/**
 * 一行里"给人看的名字"。
 *
 * 优先级 display_name > name > email > id：前三个是人在目录里认得出的东西，
 * id 只是**最后一格兜底** —— 走到那一步说明这个用户在 Casdoor 里除了 id
 * 什么都没有（`UserOption` 只有 id 是 required）。正常数据到不了这一格：
 * Casdoor 的 userName 是必填的，`name` 一定有值。
 */
export function userPrimary(user: UserOption): string {
  return (
    user.display_name?.trim() ||
    user.name?.trim() ||
    user.email?.trim() ||
    user.id
  );
}

/**
 * 选项/选中项显示的**字符串**。
 *
 * ⚠️ 只有人名，**不带 UUID**（2026-10-11 按要求改的）。
 *    上一版把 `id` 贴在行尾当"重名时的区分手段"，现在去掉了：
 *    下拉里看一眼就是一堆 36 位十六进制字符，噪音大于信息。
 *    代价是**同名的人在这份列表里长得一样** —— 如果哪天真的撞上，
 *    再把 `email`（而不是 id）挂回来当区分位。
 *
 * 刻意返回字符串而不是 ReactNode：antd 用它做选中项的显示、`title`、
 * 以及（没关掉客户端过滤时）搜索匹配。给成节点会在这三处都变成"渲染一个东西"，
 * 收益只是样式，代价是各种说不清的行为。
 */
export function userOptionLabel(user: UserOption): string {
  return userPrimary(user);
}

/** 从错误里抠出后端的中文原因（@umijs/max 的 request 就是 axios，body 在 response.data）。 */
function readDetail(error: unknown): {
  detail?: unknown;
  status?: number;
  message?: string;
} {
  const err = (error ?? {}) as {
    response?: { status?: number; data?: { detail?: unknown } };
    data?: { detail?: unknown };
    status?: number;
    message?: string;
  };
  return {
    detail: err.response?.data?.detail ?? err.data?.detail,
    status: err.response?.status ?? err.status,
    message: err.message,
  };
}

/**
 * 搜索失败要说的话。
 *
 * ⚠️ 403 是**本地开发最可能看到的一种**（鉴权关掉时 bypass 身份里的 roles
 *    是刻意留空的）—— 所以那句提示必须点明"不是你搜错了"，
 *    否则会被读成"查无此人"。
 */
export function describeUserSearchError(error: unknown): string {
  const { detail, status, message } = readDetail(error);

  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      const msg = (item as { msg?: unknown } | null)?.msg;
      return typeof msg === 'string' ? msg : JSON.stringify(item);
    });
    if (parts.length) return parts.join('；');
  }

  if (status === 403) {
    return '403：调用者没有 Y-Trader-Admin 角色，选不了人。本地开发时鉴权开关是关的、bypass 身份里的 roles 刻意留空，所以本地也是 403 —— 这不是「查无此人」。';
  }
  if (status === 401) {
    return '401：令牌缺失 / 过期 / audience 不对 —— 重新登录后再试。';
  }
  if (status === 500) {
    return '500：Casdoor 够不着，或者应用凭据没有读用户的权限（后端日志里有原因）。';
  }
  return message || '搜索用户失败。';
}

// ---------------------------------------------------------------- 组件

export interface UserPickerProps {
  /** 选中的用户 id（UUID）。空串 = 还没选。 */
  value: string;
  /** 选中/清空时回调 —— 给出**整个选项**，调用方需要它的名字时不用再去查一遍。 */
  onChange: (user: UserOption | null) => void;
  disabled?: boolean;
  /** 一次要几个选项。默认 20（契约 default）。 */
  limit?: number;
}

type LoadStatus = 'loading' | 'done' | 'error';

/**
 * 选人控件。
 *
 * 状态都在组件里（选项、选中项、加载态）：调用方只持有**选中的 id**
 * —— 那是请求体里唯一需要的东西（见本页 utils 的 compactTarget）。
 */
export const UserPicker: React.FC<UserPickerProps> = ({
  value,
  onChange,
  disabled,
  limit = USER_PICKER_LIMIT,
}) => {
  const { styles } = useStyles();

  const [options, setOptions] = useState<UserOption[]>([]);
  /**
   * 选中的那一行**只是缓存**，用来把选中项的显示文字拼出来（见 labelRender）。
   *
   * ⚠️ 千万不要把它塞进 `options` 来保住 label。
   *    上一版就是这么干的（"列表里没有就把选中项补到最前面"），后果是
   *    **列表里永远至少有这一行** —— 而 antd 只在"没有选项"时才渲染
   *    notFoundContent，于是：
   *      · 搜不到时看不到"没有匹配的用户"；
   *      · 搜索 403 时错误信息根本露不出来（失败被静默吞掉）。
   *    列表的职责是"如实反映这次查询返回了什么"，选中项的显示交给 labelRender。
   */
  const [picked, setPicked] = useState<UserOption | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [errorText, setErrorText] = useState('');

  /** 请求序号：慢的那个响应回来时如果已经不是最新的，直接丢掉（打字快时必然发生）。 */
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (keyword: string) => {
      const seq = ++seqRef.current;
      setStatus('loading');
      try {
        const list = await searchUsers({
          // 空串与"不给"在契约里是同一件事（列出前 limit 个）——
          // 显式转成 undefined，免得请求上挂一个空的 keyword 参数。
          keyword: keyword.trim() || undefined,
          limit,
        });
        if (seq !== seqRef.current) return;
        setOptions(list);
        setStatus('done');
      } catch (error) {
        if (seq !== seqRef.current) return;
        // ⚠️ 失败时**把已有的选项清掉**。
        //    留着旧列表的后果是：用户敲了 zhang、查询 403 了，下拉里却还列着上一次
        //    那批人 —— 那份列表跟当前关键字毫无关系，而且失败被彻底吞掉
        //    （antd 只在"没有选项"时才渲染 notFoundContent，所以错误态根本露不出来）。
        //    清掉之后 notFoundContent 才有机会说话。
        setOptions([]);
        setErrorText(describeUserSearchError(error));
        setStatus('error');
      }
    },
    [limit],
  );

  // 挂载就空关键字拉一次（契约允许且推荐）—— 下拉打开时不该是空的。
  useEffect(() => {
    void load('');
  }, [load]);

  // 卸载时把还没触发的防抖清掉
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // 外部把值清掉（页面重置）时，选中项的缓存也要跟着清，否则会留下幽灵人名
  useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  const handleSearch = (keyword: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void load(keyword);
    }, SEARCH_DEBOUNCE_MS);
  };

  /**
   * 列表 = 这次查询返回的东西，**原样**。
   * 不往里掺选中项、也不掺"上次那条"—— 掺任何一条，空态与失败态就再也露不出来。
   */
  const selectOptions = useMemo(
    () =>
      options.map((user) => ({
        value: user.id,
        label: userOptionLabel(user),
      })),
    [options],
  );

  /** 按 id 找到那行（先看这次的结果，再看选中项的缓存）。 */
  const byId = (id: string): UserOption | null => {
    const hit = options.find((user) => user.id === id);
    if (hit) return hit;
    return picked && picked.id === id ? picked : null;
  };

  /**
   * 选中项的显示文字。
   *
   * 走 labelRender 而不是靠 options 里的 label：这样"选中的是谁"与
   * "这次搜到了什么"就是两件互不干扰的事 —— 搜完之后列表换了一批、甚至被清空
   * （失败态），选中的人名照样显示得出来。
   *
   * 找不到那行时（值是从外面塞进来的、本地没缓存）就照实显示 id：那是唯一还能
   * 认出这个值的东西 —— 显示成空白的话，界面会变成"看起来没选人、其实发了出去"。
   * 本页的正常路径到不了这里：值只由本组件的选择产生，选中即缓存（picked）。
   */
  const labelOf = (id: string): string => {
    const user = byId(id);
    return user ? userOptionLabel(user) : id;
  };

  const notFoundContent = () => {
    if (status === 'error') {
      return <div className={styles.userSearchError}>{errorText}</div>;
    }
    if (status === 'loading') return <Spin size="small" />;
    return (
      <div className={styles.userSearchEmpty}>
        没有匹配的用户。匹配是在 name / email / id 上做子串，而且
        <b>区分大小写</b>（yin 命中、YIN 不命中）——
        所以搜不到不等于这个人不存在。
      </div>
    );
  };

  return (
    <Select
      // ⚠️ 稳定抓手：本页现在有**两个** Select（选人 + agent_id），
      //    `.ant-select` 这种类名选择器会同时命中两个 —— 单测与探针都靠这个属性
      //    精确地问"选人控件在不在"。
      data-user-picker="true"
      value={value || undefined}
      disabled={disabled}
      style={{ width: '100%' }}
      placeholder="输入名字 / 邮箱 / id 搜索，然后选一个"
      // ⚠️ antd v6 把 filterOption / onSearch 收进了 showSearch 对象
      //    （写在 Select 上会报 deprecated；`npx antd lint ./src` 会拦下来）
      showSearch={{
        // 服务端已经筛过了；客户端再筛一遍会与"区分大小写"的口径打架
        filterOption: false,
        onSearch: handleSearch,
      }}
      allowClear
      loading={status === 'loading'}
      options={selectOptions}
      // 选中项显示的文字由这里给（不依赖 options）—— 见 labelOf 的说明
      labelRender={({ value }) => labelOf(String(value ?? ''))}
      notFoundContent={notFoundContent()}
      onClear={() => onChange(null)}
      onChange={(next) => {
        if (!next) {
          onChange(null);
          return;
        }
        const hit = byId(next);
        // 理论上到不了这里（value 只来自 options）。真到了就**什么都不做** ——
        // 宁可留着上一次的值，也不要悄悄把 target 清掉。
        if (!hit) return;
        setPicked(hit);
        onChange(hit);
      }}
      onOpenChange={(open) => {
        if (!open) return;
        // 手里**一条选项都没有**时（上次搜空了、或者上次失败了）就当没有筛选、
        // 重新列一遍。不这么做，下拉会一直空着 —— 那看起来像"这个组织里一个人
        // 都没有"，而事实只是"上一次那把关键字没搜到"。
        // 有选项时不动：用户搜完再打开，列表该保持他刚才那把筛选的结果。
        if (status === 'error' || options.length === 0) void load('');
      }}
    />
  );
};

export default UserPicker;
