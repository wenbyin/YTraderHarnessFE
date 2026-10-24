import type { RequestOptions } from '@@/plugin-request/request';
import type { RequestConfig } from '@umijs/max';
import { getIntl, request } from '@umijs/max';
import { message, notification } from 'antd';

import {
  authHeaders,
  isPublicAuthPath,
  redirectToLogin,
  refreshAccessToken,
} from '@/services/auth';

// 错误处理方案： 错误类型
enum ErrorShowType {
  SILENT = 0,
  WARN_MESSAGE = 1,
  ERROR_MESSAGE = 2,
  NOTIFICATION = 3,
  REDIRECT = 9,
}
// 与后端约定的响应数据格式
interface ResponseStructure {
  success: boolean;
  data: unknown;
  errorCode?: number;
  errorMessage?: string;
  showType?: ErrorShowType;
}

/**
 * 给请求挂上 `Authorization: Bearer <access_token>`。
 *
 * 契约见 app/services/user/user.yaml：受保护接口唯一认的凭据就是它
 * （`securitySchemes.bearerAuth`）。唯一的例外是 SSE 端点
 * `GET /api/v1/runs/{run_id}/events` —— 浏览器的 EventSource 发不了请求头，
 * 那个端点额外接受 `?access_token=`（见 CopilotDock/agentRuntime.ts，
 * 它是自己 fetch 的，不走这里）。
 *
 * ⚠️ `authHeaders()` 在没有 token 时返回 `{}`，不是抛错
 * ---------------------------------------------------
 *   请求**照发**。理由：401 的处理只能有一处（下面那个响应拦截器），
 *   在请求侧提前拦下来就会分叉成两套逻辑，而且会拦掉
 *   `/auth/login` 这类本来就不需要 token 的请求。
 *
 * 公开的三个 auth 接口（login / callback / refresh）**不挂**：
 *   它们要么是拿 token 之前调的，要么是靠 refresh_token 认证的，
 *   挂一个可能已经过期的 access token 过去只会让日志更难读。
 */
function attachAuthHeader(config: RequestOptions) {
  const url = (config as { url?: string }).url;
  if (isPublicAuthPath(url)) return config;

  const headers = authHeaders();
  if (!Object.keys(headers).length) return config;

  return {
    ...config,
    headers: { ...(config.headers as Record<string, string>), ...headers },
  };
}

/**
 * 401 时刷新 token 并**重试一次**。
 *
 * 为什么必须放在响应拦截器而不是 errorHandler
 * ------------------------------------------
 *   umi 的 `errorConfig.errorHandler` 在 `.catch()` 里被调用，**返回值被忽略**，
 *   之后无条件 `reject(error)`（见 @umijs/plugins/dist/request.js）——
 *   也就是说 errorHandler **没有能力**把一次失败的请求救回来。
 *   能救回来的位置只有 axios 响应拦截器的 onRejected。
 *
 * ⚠️ 三个必须守住的边界
 * -------------------
 *   ① **只重试一次**（`__authRetried`）。刷新出来的 token 仍然 401，
 *      说明问题不在过期（比如 audience 配错了），再刷就是死循环。
 *   ② **公开的 auth 接口不参与**。`/auth/refresh` 自己 401 时去"刷新再重试"
 *      是自指；`/auth/callback` 的 401 是 code/state 有问题，刷 token 解决不了。
 *   ③ 重试要用 `getResponse: true` 取回**整个响应对象**。
 *      umi 的 `request()` 默认已经帮你脱了一层 `data`；重试若也用默认行为，
 *      外层 `.then((res) => res.data)` 会在同一层上再脱一次，
 *      结果是**静默的 undefined**（页面拿到 undefined，不报错）。
 */
async function retryAfterRefresh(error: unknown) {
  const err = error as {
    response?: { status?: number };
    config?: RequestOptions & {
      url?: string;
      method?: string;
      data?: unknown;
      params?: unknown;
      responseType?: string;
      skipErrorHandler?: boolean;
      __authRetried?: boolean;
    };
  };

  const config = err?.config;
  const status = err?.response?.status;

  // 不是 401，或者这次请求已经在重试路上了 —— 原样抛
  if (status !== 401 || !config?.url) throw error;
  if (config.__authRetried) {
    redirectToLogin();
    throw markAuthHandled(error);
  }
  if (isPublicAuthPath(config.url)) throw error;

  let token: string;
  try {
    token = await refreshAccessToken();
  } catch {
    // 刷不出来（没有 refresh token / 被拒 / Casdoor 挂了）→ 回登录页。
    // 这里不区分原因：对用户来说都是"这个会话不能继续了"。
    redirectToLogin();
    throw markAuthHandled(error);
  }

  return request(config.url, {
    method: config.method,
    data: config.data,
    params: config.params,
    responseType: config.responseType,
    headers: {
      ...(config.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
    },
    // 见上面 ③：必须拿回整个响应，否则外层会多脱一层 data
    getResponse: true,
    skipErrorHandler: config.skipErrorHandler,
    // 自定义标记。IRequestOptions 里没有这个键，用断言而不是新建 interface ——
    // 它同时要求"能被 axios 原样带在 config 上"，加类型只会多一层要维护的映射。
    __authRetried: true,
  } as RequestOptions & { __authRetried?: boolean });
}

/**
 * 给错误盖一个"已经处理过了"的戳。
 *
 * 为的是让 errorHandler 别再多弹一条 `Response status:401` ——
 * 那次 401 的归宿是登录页，不是弹窗。两个提示同时出现只会让人以为
 * "登录页是弹窗跳出来的"。
 */
function markAuthHandled(error: unknown) {
  if (error && typeof error === 'object') {
    (error as { __authHandled?: boolean }).__authHandled = true;
  }
  return error;
}

/**
 * @name 错误处理
 * pro 自带的错误处理， 可以在这里做自己的改动
 * @doc https://umijs.org/docs/max/request#配置
 */
export const errorConfig: RequestConfig = {
  // 错误处理： umi@3 的错误处理方案。
  errorConfig: {
    // 错误抛出
    errorThrower: (res) => {
      const { success, data, errorCode, errorMessage, showType } =
        res as unknown as ResponseStructure;
      if (!success) {
        const error: any = new Error(errorMessage);
        error.name = 'BizError';
        error.info = { errorCode, errorMessage, showType, data };
        throw error; // 抛出自制的错误
      }
    },
    // 错误接收及处理
    errorHandler: (error: any, opts: any) => {
      if (opts?.skipErrorHandler) throw error;
      // 401 的归宿是登录页（上面那个拦截器已经跳过了），不要再弹一条状态码
      if (error?.__authHandled) throw error;

      // 我们的 errorThrower 抛出的错误。
      if (error.name === 'BizError') {
        const errorInfo: ResponseStructure | undefined = error.info;
        if (errorInfo) {
          const { errorMessage, errorCode } = errorInfo;
          switch (errorInfo.showType) {
            case ErrorShowType.SILENT:
              // do nothing
              break;
            case ErrorShowType.WARN_MESSAGE:
              message.warning(errorMessage);
              break;
            case ErrorShowType.ERROR_MESSAGE:
              message.error(errorMessage);
              break;
            case ErrorShowType.NOTIFICATION:
              notification.open({
                title: errorCode,
                description: errorMessage,
              });
              break;
            case ErrorShowType.REDIRECT:
              window.location.href = '/user/login';
              break;
            default:
              message.error(errorMessage);
          }
        }
      } else if (error.response) {
        // Axios 的错误
        // 请求成功发出且服务器也响应了状态码，但状态代码超出了 2xx 的范围
        //
        // ⚠️ 后端（FastAPI）把原因写在 `detail` 里，状态码本身说明不了问题：
        //    "会话不存在：xxx" / "运行不存在" / 403 的"不在 required_groups 里"
        //    都被这一行吞掉过。能读到 detail 就优先用它。
        const detail = error.response.data?.detail;
        if (typeof detail === 'string' && detail) {
          message.error(detail);
        } else {
          message.error(`Response status:${error.response.status}`);
        }
      } else if (typeof navigator !== 'undefined' && !navigator.onLine) {
        message.error(
          getIntl().formatMessage({
            id: 'app.request.offline',
            defaultMessage:
              'Network unavailable. Please check your connection and try again.',
          }),
        );
      } else if (error.request) {
        message.error('None response! Please retry.');
      } else {
        message.error('Request error, please retry.');
      }
    },
  },

  // 请求拦截器
  requestInterceptors: [
    (config: RequestOptions) => {
      // 拦截请求配置，进行个性化处理：挂上 Casdoor 的 access token。
      return attachAuthHeader(config);
    },
  ],

  // 响应拦截器
  //
  // ⚠️ 这里**必须**写成 [onFulfilled, onRejected] 的二元组
  // -----------------------------------------------------
  //   umi 的 request.js 对数组形态就是 `interceptors.response.use(a[0], a[1])`，
  //   而 errorHandler 是救不回请求的（返回值被丢掉）—— 想"刷新后重试"只能靠
  //   onRejected。写成单函数形态的话它只会被当成 onFulfilled，401 永远走不到。
  //
  // ⚠️ 断言是因为**库的类型写窄了**
  // -----------------------------
  //   umi 把第二个位置声明成 `IErrorInterceptor = (error: Error) => Promise<Error>`
  //   （"把错误加工一下再抛"），但运行期它就是 axios 的 onRejected ——
  //   那里**允许返回到一个正常结果**，请求会就此恢复成功。
  //   我们要的正是这个能力（刷新 → 重试 → 返回响应），
  //   所以只能断言过去；不改用"两面都失败"的写法。
  responseInterceptors: [
    [
      (response: unknown) => response,
      (error: unknown) => retryAfterRefresh(error),
    ],
  ] as unknown as RequestConfig['responseInterceptors'],
};
