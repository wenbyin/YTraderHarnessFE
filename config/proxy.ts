/**
 * @name 代理的配置
 * @see 在生产环境 代理是无法生效的，所以这里没有生产环境的配置
 * -------------------------------
 * The agent cannot take effect in the production environment
 * so there is no configuration of the production environment
 * For details, please see
 * https://pro.ant.design/docs/deploy
 *
 * @doc https://umijs.org/docs/guides/proxy
 */

/**
 * ⚠️ 事件流（SSE）必须关掉压缩，否则整段响应会被攒完才一次性吐出来
 * ------------------------------------------------------------------
 * umi dev server（bundler-utoopack）里有 `app.use(compression())`，对**所有**响应开
 * gzip。而 gzip 要攒够数据才 flush —— `text/event-stream` 这种长连接于是被攒成一大坨：
 *
 *   直连 8080：1725 帧 delta，跨度 8.9 秒，帧间隔中位数 3.3ms   ← 真流式
 *   经 8000 代理：755 帧 delta，全挤在 18ms 内                   ← 一次性蹦出
 *
 * 表现就是界面上的文字要等整段收完才「啪」地一下出现。
 * 复现/验证：`curl -D - -H 'Accept-Encoding: gzip' <代理地址>/api/v1/runs/{id}/events`
 *           看响应头里有没有 `Content-Encoding: gzip`（有就是被压了）。
 *
 * 解法：给 SSE 响应加 `Cache-Control: no-transform`。这是 compression 官方留的开关
 * （`shouldTransform()`，见 node_modules/compression/index.js），命中后直接
 * `nocompress('no transform')`，不做任何压缩。
 *
 * ⚠️ 两个必须知道的细节
 *   1. 字段名是 **`onProxyRes`**（平铺），不是 http-proxy-middleware 文档里的
 *      `on.proxyRes` —— umi 的 createProxy 只透传前者，后者会被静默忽略。
 *   2. 改这个文件**必须重启 dev server**（代理在启动时构建，.ts 不走 HMR）。
 *
 * ⚠️ 回调参数类型为什么这么写
 * ---------------------------
 *   http-proxy-middleware 给的 `proxyRes.headers` 是 `IncomingHttpHeaders`
 *   （值是 `string | string[] | undefined`）。手写 `Record<string, string>`
 *   过不了类型检查；`@umijs/bundler-utils` 里有准的类型但它**不在 package.json
 *   依赖里**，不该为了一份类型去 import 它。这里声明一个**比它更宽**的结构类型 ——
 *   宽类型能被安全地赋给窄类型的参数位（函数参数双变），所以直接兼容。
 */
type ProxyResLike = {
  headers: Record<string, string | string[] | undefined>;
};

const ssePassthrough = (proxyRes: ProxyResLike) => {
  const type = proxyRes.headers['content-type'] ?? '';
  if (!String(type).includes('text/event-stream')) return;

  // no-transform → compression 放行；顺便把后端给的 no-cache 补严一点
  proxyRes.headers['cache-control'] = 'no-cache, no-transform';
  // 双保险：万一上面的判断失效，显式声明"没压过"
  delete proxyRes.headers['content-encoding'];
  proxyRes.headers['x-accel-buffering'] = 'no';
};

export default {
  // 本地开发：转发到 YTraderHarness 后端（uvicorn 默认 http://localhost:8080）
  dev: {
    '/api/': {
      target: process.env.BACKEND_URL || 'http://localhost:8080',
      changeOrigin: true,
      onProxyRes: ssePassthrough,
    },
  },
  // 如果需要自定义本地开发服务器  请取消注释按需调整
  // dev: {
  //   // localhost:8000/api/** -> https://preview.pro.ant.design/api/**
  //   '/api/': {
  //     // 要代理的地址
  //     target: 'https://preview.pro.ant.design',
  //     // 如果有 https，需要设置 secure: false
  //     // 依赖 origin 的功能可能需要这个，比如 cookie
  //     changeOrigin: true,
  //   },
  // },
  /**
   * @name 详细的代理配置
   * @doc https://github.com/chimurai/http-proxy-middleware
   */
  test: {
    '/api/': {
      target: process.env.BACKEND_URL || 'http://localhost:8080',
      changeOrigin: true,
      onProxyRes: ssePassthrough,
    },
  },
  pre: {
    '/api/': {
      target: process.env.BACKEND_URL || 'http://localhost:8080',
      changeOrigin: true,
      onProxyRes: ssePassthrough,
    },
  },
};
