import { Helmet, useIntl } from '@umijs/max';
import { Alert, Button, Result, Spin } from 'antd';
import React, { useEffect, useRef, useState } from 'react';

import { Footer } from '@/components';
import {
  completeCasdoorLogin,
  consumeRedirect,
  describeAuthError,
  describeCurrentUser,
} from '@/services/auth';
import { useStyles } from '../styles';

/**
 * OAuth 回调页 —— Casdoor 验完把人送回这里，地址上带着 `?code=&state=`。
 *
 * 它必须是一个**前端路由**，不是后端接口
 * ------------------------------------
 *   后端只有 `POST /api/v1/auth/callback`。而 Casdoor 是用**浏览器顶层导航
 *   （GET）**把人送回来的，所以 `redirect_uri` 不能指到那个 POST 上 ——
 *   实测（2026-10-04）：`GET http://localhost:8080/api/v1/auth/callback?code=…`
 *   返回 **405**，登录会在最后一步断掉。
 *
 *   因此 `CASDOOR_REDIRECT_URI` 要指到本页（默认
 *   `http://localhost:8000/user/callback`），并且要在 Casdoor 控制台
 *   该应用的 Redirect URLs 里登记同一个地址。
 *
 * 为什么换完 token 还要 `describeCurrentUser()`
 * ------------------------------------------
 *   不只为拿名字。`/auth/me` 是**受保护**接口：它同时会验群组，
 *   不在 `casdoor.yaml: required_groups` 里的人会收到 **403**。
 *   在这里就地报出来，用户看到的是「你不在允许的群组里」；
 *   如果直接跳走，他会在目标页被 `getInitialState` 弹回登录页，
 *   而且**没有任何解释** —— 同一个错误，两种体验。
 */
const Callback: React.FC = () => {
  const { styles } = useStyles();
  const intl = useIntl();
  const [error, setError] = useState<string | null>(null);

  /**
   * ⚠️ 授权码是**一次性**的，所以兑换只能发生一次。
   *
   * React 18 的 StrictMode（以及 dev 下的 HMR）会把 effect 跑两遍：
   * 第一次已经把 code 用掉了，第二次必然拿到 401
   * （users.py: "The code is single-use"）—— 表现是"明明登录成功了却报错"，
   * 而且报的是个看起来毫不相干的授权失败。用 ref 兜住，第二次直接不进去。
   *
   * 用 ref 而不是 state：state 的更新是异步的，第二次 effect 跑的时候
   * 读到的还是旧值，挡不住。
   */
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      const params = new URLSearchParams(window.location.search);

      // Casdoor 拒绝授权时不会给 code，而是给 error / error_description
      const oauthError = params.get('error');
      if (oauthError) {
        const description = params.get('error_description');
        throw new Error(`Casdoor 拒绝了这次授权：${description || oauthError}`);
      }

      const code = params.get('code');
      const state = params.get('state');
      if (!code || !state) {
        throw new Error('回调地址上缺少 code 或 state，无法完成登录');
      }

      await completeCasdoorLogin(code, state);
      // 验一下这个人能不能进（403 = 不在 required_groups 里）
      await describeCurrentUser();

      /**
       * ⚠️ 用 `window.location.replace` 整页重载，不是 `history.replace`。
       *
       * `history.replace` 会立刻触发 ProLayout 的 onPageChange，而那个回调
       * 读的是**上一次渲染闭包里的** `initialState` —— 此刻 `currentUser`
       * 还是 undefined（`setInitialState` 要等下一次渲染才生效），
       * 于是刚登录成功就被它一脚踢回登录页。
       * 整页重载让 `getInitialState` 从头跑一遍（token 已经在
       * localStorage 里），时序上没有任何可争的地方 —— 代价只是一次
       * 页面加载，和一次 /auth/me。
       */
      window.location.replace(consumeRedirect());
    };

    void run().catch((e: unknown) => {
      setError(describeAuthError(e));
    });
  }, []);

  const title = intl.formatMessage({
    id: 'pages.login.callback.title',
    defaultMessage: '正在完成登录',
  });

  return (
    <div className={styles.container}>
      <Helmet>
        <title>{title}</title>
      </Helmet>

      <div className={styles.content}>
        <div className={styles.card}>
          {error ? (
            <Result
              status="error"
              title={intl.formatMessage({
                id: 'pages.login.callback.failed',
                defaultMessage: '登录未完成',
              })}
              subTitle={error}
              extra={[
                <Button
                  type="primary"
                  key="retry"
                  onClick={() => window.location.replace('/user/login')}
                >
                  {intl.formatMessage({
                    id: 'pages.login.callback.retry',
                    defaultMessage: '返回登录页重试',
                  })}
                </Button>,
              ]}
            />
          ) : (
            <>
              <Spin size="large" />
              <div
                className={styles.subTitle}
                style={{ marginTop: 24, marginBottom: 0 }}
              >
                {title}
              </div>
            </>
          )}

          {error && (
            <Alert
              className={styles.alert}
              type="warning"
              showIcon
              title={intl.formatMessage({
                id: 'pages.login.callback.hint',
                defaultMessage:
                  '若提示 state 校验失败：登录必须由同一个浏览器一次走完，且 redirect_uri 要在 Casdoor 里登记。',
              })}
            />
          )}
        </div>
      </div>

      <Footer />
    </div>
  );
};

export default Callback;
