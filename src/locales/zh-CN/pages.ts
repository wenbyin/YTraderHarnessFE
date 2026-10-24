export default {
  // ---- Casdoor 统一身份登录（后端契约 app/services/user/user.yaml）----
  'pages.login.casdoor.title': '使用统一身份登录',
  'pages.login.casdoor.subTitle':
    '登录将由 Y-Trader 统一身份（Casdoor）完成，密码不会经过本系统。',
  'pages.login.casdoor.submit': '前往 Casdoor 登录',
  'pages.login.casdoor.hint':
    '如果提示「后端没能联系上 Casdoor」或授权后直接被拒，通常是服务端这两处没配好：',
  'pages.login.casdoor.hint2':
    '并且同一个地址要登记在该应用 Casdoor 控制台的 Redirect URLs 里。',
  'pages.login.casdoor.note':
    '本系统没有独立的账号体系 —— 账号、群组与权限都在 Casdoor 里维护。',
  'pages.login.callback.title': '正在完成登录',
  'pages.login.callback.failed': '登录未完成',
  'pages.login.callback.retry': '返回登录页重试',
  'pages.login.callback.hint':
    '若提示 state 校验失败：登录必须由同一个浏览器一次走完，且 redirect_uri 要在 Casdoor 里登记。',
  'pages.404.subTitle': '抱歉，您访问的页面不存在。',
  'pages.404.buttonText': '返回首页',
};
