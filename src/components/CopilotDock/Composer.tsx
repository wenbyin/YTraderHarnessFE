// src/components/CopilotDock/Composer.tsx
//
// DeepSeek 风的输入框 —— 通过 CopilotChat 的 `Input` 插槽替换掉库的默认实现。
//
// 为什么要替换默认实现（而不是在它上面盖一层）
// ------------------------------------------
//   需求是「输入框**内部**加上附件和深度思考按钮」，也就是三个控件要跟发送按钮
//   排在同一行。库的默认 Input 只留了两处扩展位：`onUpload`（渲染一个 **加号**
//   图标，还会把附件塞进它自己的附件管线）和「完全没有」的深度思考。
//   想在那一行里塞第三个控件，只剩两条路：
//     · 在 `.copilotKitInput` 上绝对定位盖一层 —— 位置全靠"输入框 padding +
//       Powered by 高度"这类布局常数硬算，库一改就静默错位；
//     · 换成自己的 Input（本文件）—— 用的是**公开契约** `InputProps`
//       （CopilotChat 的 `Input` 属性类型），一行都不用猜 DOM。
//   选了后者。
//
// 代价与对策：库默认实现里的行为必须一条不落搬过来，否则就是"为了好看把功能弄丢"。
//   逐条对照（默认实现在 node_modules/@copilotkit/react-ui 的 Input 组件）：
//     · 自动增高 textarea（到 CSS 的 max-height 为止，超出就内部滚动）
//     · Enter 发送 / Shift+Enter 换行
//     · **IME 组合期间 Enter 不下发**（中文输入法选词那一下会带上 Enter 键，
//       不拦住就会"选个字把半句话发出去"）—— 靠 composition 事件，不是靠 keyCode
//     · inProgress → 按钮变停止（可中途打断）；chatReady=false → 转圈且不可发
//     · 点空白处（非按钮/非 textarea）聚焦输入框
//     · 两个 data-testid（copilot-chat-textarea / copilot-send-button）原样保留，
//       免得外面按 testid 写的测试/脚本失联
//     · Powered by CopilotKit 署名照旧（它跟着库的 CSS 一起，别顺手删）
//
// ⚠️ 附件与深度思考**今天都只是 UI**
// ---------------------------------
//   按与用户确认过的口径：两个控件都只做前端切换态，不联网、不提交。
//   为什么不能"顺手接上"：
//     · `POST /sessions/{id}/runs` 的 input 是 `additionalProperties: false`
//       且只允许 text（session.yaml v1.0.0）—— 附件和开关**没有任何字段可塞**，
//       多给键会被 422 拒掉，不是被忽略；
//     · 后端的 `POST /api/v1/files` 虽然真存在（返回 file_id），但 file_id 同样
//       没有通道能交给这一轮的图，接了也只是"上传了但模型看不到"。
//   所以这里**不假装**：附件选了之后留在芯片上，发送后**不清空** ——
//   清空会让人以为它被发出去了；芯片上的 ✕ 才是唯一的移除方式。
//   将来后端开了字段，要改的是"提交时把它带上"那一步，不是这段 UI。

import {
  BulbOutlined,
  CloseOutlined,
  PaperClipOutlined,
} from '@ant-design/icons';
import { useCopilotContext } from '@copilotkit/react-core';
import { type InputProps, useChatContext } from '@copilotkit/react-ui';
import { Tooltip } from 'antd';
import { cx } from 'antd-style';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerDraft } from './composerDraft';
import { readDeepThink, writeDeepThink } from './composerPrefs';
import { useHitlPending } from './hitlSignal';
import { useStyles } from './style';

/**
 * 一个文件的身份。用于去重和做 React key。
 * 不用 `File` 对象本身当 key：同一个文件选两次是两个不同的对象，
 * 但它们对用户来说就是"同一个文件"，重复列出来很奇怪。
 */
export function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

const Composer: React.FC<InputProps> = ({
  inProgress,
  onSend,
  onStop,
  chatReady = false,
  hideStopButton = false,
}) => {
  const { styles } = useStyles();
  const { labels, icons } = useChatContext();
  // 有没有待处理的人工审批 → 有就不让再发新消息。
  // ⚠️ 这个值**不能**再读 `useCopilotChatInternal().interrupt`：那个来自
  //    `copilotkit.interruptElement`，只有 useInterrupt 用默认的
  //    `renderInChat: true` 时才发布 —— 而那个默认值会让库在对话流里也把卡片
  //    画一遍（两张卡片的来源）。现在固定 false，改由 HitlInterrupt 发布、
  //    这里订阅。完整来龙去脉见 hitlSignal.ts 文件头。
  const hitlPending = useHitlPending();
  // 有 publicApiKey（Copilot Cloud）时才不显示署名 —— 与默认实现同款判据
  const { copilotApiConfig } = useCopilotContext();
  const showPoweredBy = !copilotApiConfig?.publicApiKey;

  const [text, setText] = useState('');
  /** IME 组合中。见文件头：组合期间的 Enter 是"选词"，不是"发送"。 */
  const [composing, setComposing] = useState(false);
  const [deepThink, setDeepThink] = useState(readDeepThink);
  /** 已选的附件。**只在内存里**：File 没法从存储恢复，持久化没意义。 */
  const [files, setFiles] = useState<File[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 跟着内容长高。上限交给 CSS 的 max-height，超出后 textarea 自己内部滚动。 */
  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    // 先归零再读 scrollHeight：否则高度只会涨不会落（scrollHeight 是"内容的
    // 需求高度"，跟当前 height 无关，但 height:auto 能让它算准行数）。
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  /**
   * 「编辑」按钮的落点：把那条消息的原文灌进输入框。
   *
   * 为什么不能只 setText：用户点了编辑却看不到光标在哪，还得自己点一下输入框
   * —— 焦点与光标位置都是"这次操作的一部分"，一起给到位。
   *
   * cursor 放到末尾用 `requestAnimationFrame` 等一帧：`setText` 触发的 DOM
   * value 更新发生在本轮渲染之后，此时 setSelectionRange 才会生效（立刻设会
   * 被随后的 value 覆盖，光标跳回 0）。
   *
   * ⚠️ 依赖是整个 `draft` 对象（含 nonce）：连续编辑**同一段文本**时 text 不变、
   *    nonce 变，effect 必须重跑。见 composerDraft.ts。
   */
  const draft = useComposerDraft();
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    const element = textareaRef.current;
    element?.focus();
    window.requestAnimationFrame?.(() => {
      element?.setSelectionRange(draft.text.length, draft.text.length);
    });
  }, [draft]);

  const showStop = inProgress && !hideStopButton;
  const canSend =
    chatReady && !inProgress && !hitlPending && text.trim().length > 0;
  const sendDisabled = !canSend && !showStop;

  const send = useCallback(() => {
    if (inProgress) return;
    if (!text.trim()) return;
    // 与默认实现同款：不清空附件（见文件头），只清空输入框
    setText('');
    textareaRef.current?.focus();
    // onSend 的失败由 CopilotKit 自己在对话里呈现（它已经吞过一层），
    // 这里只负责不让一个 rejected promise 冒成 unhandled rejection。
    void onSend(text).catch(() => {});
  }, [inProgress, onSend, text]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !composing) {
        event.preventDefault();
        if (canSend) send();
      }
    },
    [canSend, composing, send],
  );

  /**
   * 点输入框空白处聚焦 textarea（默认实现的行为）。
   * 点在控件上时不抢焦点 —— 否则点「附件」会先把光标吸回输入框。
   */
  const handleBubbleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('button')) return;
      if (target.tagName === 'TEXTAREA') return;
      textareaRef.current?.focus();
    },
    [],
  );

  const toggleDeepThink = useCallback(() => {
    setDeepThink((on) => !on);
  }, []);

  /**
   * 状态一变就落盘 —— 跟 index.tsx 落 DockState 是同一个手法（少一处遗漏的可能）。
   * 副作用不写在 setState 的 updater 里：StrictMode 下 updater 会被调用两次，
   * 虽然写的是同一个布尔值、结果一样，但那是"碰巧没事"，不该靠它。
   */
  useEffect(() => {
    writeDeepThink(deepThink);
  }, [deepThink]);

  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const handlePicked = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []);
      if (picked.length) {
        setFiles((prev) => {
          const seen = new Set(prev.map(fileKey));
          return [...prev, ...picked.filter((f) => !seen.has(fileKey(f)))];
        });
      }
      // 清掉 value：不然连着选**同一个**文件不会再触发 change（浏览器认为没变）
      event.target.value = '';
    },
    [],
  );

  const removeFile = useCallback((key: string) => {
    setFiles((prev) => prev.filter((f) => fileKey(f) !== key));
  }, []);

  const sendIcon = !chatReady
    ? icons.spinnerIcon
    : showStop
      ? icons.stopIcon
      : icons.sendIcon;
  const sendLabel = !chatReady ? '正在连接' : showStop ? '停止生成' : '发送';

  return (
    <div
      className={cx(
        'copilotKitInputContainer',
        showPoweredBy && 'poweredByContainer',
      )}
    >
      <div className="copilotKitInput" onClick={handleBubbleClick}>
        <textarea
          ref={textareaRef}
          data-testid="copilot-chat-textarea"
          className={styles.composerTextarea}
          placeholder={labels.placeholder}
          /*
            rows 只是"首帧的高度"（4 行 = 需求要的对话框高度）：CSS 给了
            textarea min-height: 96px，所以从第一帧起就是 4 行，写完一屏
            不用等 effect。真高度由下面 resizeTextarea 的行内 style 接管。
            ⚠️ 改行数要同步 style.ts 的三个数（textarea / 容器 min-height、
            chatPane 的 --dock-input-h），改完跑一遍 CDP 量几何。
          */
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={handleKeyDown}
        />

        {/* 附件芯片行。排在正文与控件行之间 —— DeepSeek 就是这么放的。 */}
        {files.length > 0 ? (
          <div className={styles.attachChips}>
            {files.map((file) => (
              <span className={styles.attachChip} key={fileKey(file)}>
                <PaperClipOutlined />
                <span className={styles.attachChipName} title={file.name}>
                  {file.name}
                </span>
                <button
                  type="button"
                  className={styles.attachChipDel}
                  onClick={() => removeFile(fileKey(file))}
                  aria-label={`移除附件 ${file.name}`}
                >
                  <CloseOutlined />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="copilotKitInputControls">
          <Tooltip title={deepThink ? '深度思考：已开启' : '深度思考：已关闭'}>
            <button
              type="button"
              data-testid="copilot-deep-think"
              className={cx(
                styles.thinkToggle,
                deepThink && styles.thinkToggleOn,
              )}
              // 切换型按钮 —— 让读屏能报出"当前是开还是关"
              aria-pressed={deepThink}
              onClick={toggleDeepThink}
            >
              <BulbOutlined />
              <span>深度思考</span>
            </button>
          </Tooltip>

          {/* 占位：把下面两个按钮顶到右边（默认实现里也是这个手法） */}
          <div style={{ flexGrow: 1 }} />

          <Tooltip title="添加附件">
            <button
              type="button"
              data-testid="copilot-attach"
              className={styles.attachButton}
              onClick={pickFiles}
              aria-label="添加附件"
            >
              <PaperClipOutlined />
            </button>
          </Tooltip>

          <button
            type="button"
            disabled={sendDisabled}
            onClick={showStop ? onStop : send}
            data-copilotkit-in-progress={inProgress}
            data-testid="copilot-send-button"
            data-test-id={
              inProgress
                ? 'copilot-chat-request-in-progress'
                : 'copilot-chat-ready'
            }
            className={styles.sendButton}
            aria-label={sendLabel}
            /*
             * 停止态标记 —— 红色由 style.ts 的 `&[data-stop='true']` 负责。
             * 为什么打 data 属性而不是加个类名：见 style.ts 那段注释（同元素上
             * 两个类名会按特异性打架，hover 时蓝底会赢）。
             * 只在 showStop 时为 true，所以 CSS 里的 `[data-stop='true']`
             * 正好只在"按钮真的是停止按钮"时命中。
             */
            data-stop={showStop}
          >
            {sendIcon}
          </button>
        </div>
      </div>

      {/* 真正的文件选择器，隐藏。附件只做 UI，选中的文件不外发（见文件头）。 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={handlePicked}
      />
    </div>
  );
};

export default Composer;
