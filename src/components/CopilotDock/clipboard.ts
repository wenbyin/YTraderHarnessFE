// src/components/CopilotDock/clipboard.ts
//
// 复制到剪贴板 —— 带一条退路。
//
// 为什么不用 `navigator.clipboard.writeText` 一把梭
// --------------------------------------------
//   那个 API **只在安全上下文**（https / localhost）里存在。面板既可能被嵌在
//   内网 http 页面里，也可能在 Electron/iframe 里被权限策略挡住 ——
//   这时 `navigator.clipboard` 直接是 undefined 或 reject。
//   退路是"隐藏 textarea + execCommand('copy')"这个老办法：丑，但它是那些环境里
//   唯一能用的，而"点了复制没反应"比"用了个老 API"糟得多。
//
// 返回值是"到底成没成"：调用方要据它给反馈（已复制 / 复制失败），
// 而不是无条件显示一个绿勾。

/** 复制一段文本。返回是否成功（失败不抛）。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (text === '') return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的退路（常见原因：非安全上下文、iframe 权限、用户拒绝）
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // 必须在视野里才能选中，又不能看得见：fixed + 透明。
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
