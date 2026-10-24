import { createStyles } from 'antd-style';

/**
 * 登录页 / 回调页共用的壳层样式。
 *
 * 两页放在一起导出，是因为它们的**骨架完全一样**（背景图 + 居中的一块内容
 * + Footer）——分成两个文件就会出现两份只差一个字段的重复。
 * 各自的**内部**内容（按钮 / 转圈 / 报错）留在各自的 index.tsx 里。
 */
export const useStyles = createStyles(({ token }) => ({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'auto',
    backgroundImage:
      "url('https://mdn.alipayobjects.com/yuyan_qk0oxh/afts/img/V-_oS6r-i7wAAAAAAAAAAAAAFl94AQBr')",
    backgroundSize: '100% 100%',
  },
  content: {
    flex: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '32px 16px',
  },
  card: {
    width: '100%',
    maxWidth: 400,
    padding: '40px 32px',
    textAlign: 'center',
    background: token.colorBgContainer,
    borderRadius: token.borderRadiusLG,
    boxShadow: token.boxShadowSecondary,
  },
  /**
   * 卡头品牌名 —— **纯文字**，不是图片。
   *
   * 字体按要求写死「微软雅黑 + 粗体 + 黑色」：这套东西的实际使用者以 Windows 客户端为主，
   * 雅黑在那边一定存在；后面的字体栈只是给 macOS / Linux 兜底（苹果没有雅黑，
   * 不写降级就会掉到浏览器默认的衬线体上）。
   * 30px 是按原来那块 22px 高标识的视觉重量调的：既压得住下面的标题，又不会在 400px
   * 的卡片里换行（"YTrader Harness" 30px 粗体约 250px 宽）。
   */
  brand: {
    marginBottom: 16,
    fontFamily:
      '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", Arial, sans-serif',
    fontSize: 30,
    fontWeight: 700,
    lineHeight: 1.2,
    color: '#000',
    wordBreak: 'keep-all',
  },
  title: {
    marginBottom: 8,
    fontSize: token.fontSizeHeading3,
    fontWeight: 600,
    color: token.colorTextHeading,
  },
  subTitle: {
    marginBottom: 28,
    color: token.colorTextSecondary,
    lineHeight: 1.6,
  },
  alert: {
    marginBottom: 20,
    textAlign: 'start',
  },
  /**
   * 提示区。
   *
   * ⚠️ 这里会给出一句**运维侧的**线索（redirect_uri 要登记成什么）。
   *    它只在配置没配合好时才有用，所以语气是"如果你看到这个错误，
   *    多半是这一处没配"，而不是把内部细节推给普通用户。
   */
  hint: {
    marginTop: 20,
    padding: '10px 12px',
    color: token.colorTextTertiary,
    fontSize: token.fontSizeSM,
    lineHeight: 1.7,
    textAlign: 'start',
    background: token.colorFillQuaternary,
    borderRadius: token.borderRadius,
  },
  hintCode: {
    fontFamily: token.fontFamilyCode ?? 'monospace',
    wordBreak: 'break-all',
  },
  lang: {
    width: 42,
    height: 42,
    lineHeight: '42px',
    position: 'fixed',
    right: 16,
    borderRadius: token.borderRadius,
    ':hover': {
      backgroundColor: token.colorBgTextHover,
    },
  },
}));
