import { Helmet, SelectLang, useIntl, useModel } from '@umijs/max';
import { Alert, Button, Typography } from 'antd';
import React, { useEffect, useState } from 'react';

import { Footer } from '@/components';
import {
  describeAuthError,
  getSafeRedirectUrl,
  startCasdoorLogin,
} from '@/services/auth';
import Settings from '../../../../config/defaultSettings';
import { useStyles } from '../styles';

/**
 * 登录页 —— **单一登录方式：Casdoor OAuth**。
 *
 * 这一版把 Ant Design Pro 模板自带的「账号密码 / 手机号验证码」两套表单整个
 * 换掉了。原因不是"懒得留"：那两套走的是 `/api/login/account` 和
 * `/api/login/captcha`，都由模板的假数据应答，**从来就不是真的**（那份示例
 * mock 已随后续清理一并删除）；而后端现在只认 Casdoor 的 access token
 * （契约 user.yaml，没有本地用户表，yaml 里明写 User CRUD 不是它的职责）。
 * 留着两套假入口，只会让人以为系统支持密码登录。
 *
 * 流程（三步，跨两个域）
 * -------------------
 *   ① 本页 `POST /api/v1/auth/login` 拿 Casdoor 授权地址 + 一个 HttpOnly 的
 *      state cookie（cookie 由浏览器自己存，前端碰不到也不用碰）；
 *   ② `window.location.assign(authorize_url)` 把**当前浏览器**送去 Casdoor
 *      （必须同一个浏览器，否则回调时带不上那个 cookie）；
 *   ③ Casdoor 验完把人送回 `/user/callback?code=&state=`，
 *      由回调页换 token —— 本页不处理回调。
 */
const Login: React.FC = () => {
  const { styles } = useStyles();
  const { initialState } = useModel('@@initialState');
  const intl = useIntl();

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * 登录成功后的落点。
   *
   * 只认**本站相对路径**（`getSafeRedirectUrl` 挡开放重定向）——
   * 这个参数是 URL 里来的，直接 `location.href = redirect` 就是一个
   * 能把人送去钓鱼站的跳板。
   */
  const redirectTarget = getSafeRedirectUrl(
    new URLSearchParams(window.location.search).get('redirect'),
  );

  // 已经登录的人不该卡在登录页：直接去他本来要去的地方。
  useEffect(() => {
    if (initialState?.currentUser) {
      window.location.replace(redirectTarget);
    }
  }, [initialState?.currentUser, redirectTarget]);

  const handleLogin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // 成功的话这里**不会返回** —— 页面已经被送去 Casdoor 了
      await startCasdoorLogin(redirectTarget);
    } catch (e) {
      setError(describeAuthError(e));
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.container}>
      <Helmet>
        <title>
          {intl.formatMessage({ id: 'menu.login', defaultMessage: '登录' })}
          {Settings.title && ` - ${Settings.title}`}
        </title>
      </Helmet>

      <div className={styles.lang} data-lang>
        {SelectLang && <SelectLang />}
      </div>

      <div className={styles.content}>
        <div className={styles.card}>
          {/*
            品牌名**直接排版成文字**，不再用图片：
              · 字标图放进 400px 的卡片要么被缩到看不清，要么按高度撑破卡片；
              · 文字在任何 DPI、任何缩放下都清晰，也不占一次图片请求。
            样式（黑色 / 微软雅黑 / 粗体）按要求写死在 src/pages/user/styles.ts 的 brand 上。
          */}
          <div className={styles.brand}>YTrader Harness</div>
          <div className={styles.title}>
            {intl.formatMessage({
              id: 'pages.login.casdoor.title',
              defaultMessage: '使用统一身份登录',
            })}
          </div>
          <div className={styles.subTitle}>
            {intl.formatMessage({
              id: 'pages.login.casdoor.subTitle',
              defaultMessage:
                '登录将由 Y-Trader 统一身份（Casdoor）完成，密码不会经过本系统。',
            })}
          </div>

          {error && (
            <Alert
              className={styles.alert}
              type="error"
              showIcon
              title={error}
            />
          )}

          <Button
            type="primary"
            size="large"
            block
            loading={submitting}
            onClick={handleLogin}
            data-testid="casdoor-login-button"
          >
            {intl.formatMessage({
              id: 'pages.login.casdoor.submit',
              defaultMessage: '前往 Casdoor 登录',
            })}
          </Button>

          {error && (
            <div className={styles.hint}>
              <Typography.Text type="secondary">
                {intl.formatMessage({
                  id: 'pages.login.casdoor.hint',
                  defaultMessage:
                    '如果提示「后端没能联系上 Casdoor」或授权后直接被拒，通常是服务端这两处没配好：',
                })}
              </Typography.Text>
              <div className={styles.hintCode}>
                CASDOOR_REDIRECT_URI=http://localhost:8000/user/callback
              </div>
              <Typography.Text type="secondary">
                {intl.formatMessage({
                  id: 'pages.login.casdoor.hint2',
                  defaultMessage:
                    '并且同一个地址要登记在该应用 Casdoor 控制台的 Redirect URLs 里。',
                })}
              </Typography.Text>
            </div>
          )}

          <div className={styles.hint}>
            <Typography.Text type="secondary">
              {intl.formatMessage({
                id: 'pages.login.casdoor.note',
                defaultMessage:
                  '本系统没有独立的账号体系 —— 账号、群组与权限都在 Casdoor 里维护。',
              })}
            </Typography.Text>
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
};

export default Login;
