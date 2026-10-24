// src/components/CopilotDock/RunResume.tsx
//
// 刷新（或切走再切回）之后，把**还在后端跑着的那一次运行**接回界面。
//
// 需求原话：「前端修改成在刷新后第一次打开某个 conversation，都自动去检测
// 有无在 run 的实例，有则直接订阅」。
//
// 这件事由三块拼图组成，本文件只是最后一块：
//   · **判据**（要不要接）—— useSessionHistory.ts 的 resumeCandidateOf：
//     读会话历史里最后一条带 run_id 的消息（后端在建运行那一刻就把用户消息
//     连同 run_id 落库了，所以它必然在）；
//   · **续订**（接到哪）—— agent.ts 的 attachRun / reopenRun：直接订阅那次运行
//     的事件流。后端**从头补发**，于是整轮内容与挂起的中断都回来了；
//   · **触发**（谁来跑）—— 本组件：`copilotkit.runAgent({ agent })`，让 agent
//     真的再跑一次，界面才会进入"正在运行"、才会把重放的内容画出来。
//
// ⚠️ 为什么借 CopilotKit 的 runAgent，而不是直接 `agent.runAgent()`
// -------------------------------------------------------------
//   两者最终都会走到 `agent.run()`，但前者还会更新 CopilotKit 自己那份
//   "这一轮正在进行"的状态（消息刷新、输入框从发送键变停止键都由它驱动）。
//   直接调 agent 的话，内容能出来，但界面不认为自己在跑 —— 用户看到一段
//   凭空冒出来的文字、而发送键还是可点的。
//   库内部（useInterrupt 的 resolve）走的也是 `copilotkit.runAgent`，与这里一致。
//
// ⚠️ 只做一次
// --------
//   effect 的依赖里有 `candidate` 对象（history 每更新一次就是新对象），
//   所以用一个 ref 兜住。candidate 表达的是"打开这个会话那一刻后端的事实"，
//   一次就够 —— 之后用户自己发的消息走正常的建运行那条路。
//   本组件挂在 `<CopilotKit key={activeId}>` **里面**，切会话会整体重挂 →
//   ref 自然重置，于是"切到另一个会话"会重新评估一次（那正是我们要的）。
//
// ⚠️ 失败不用在这里兜底
// ------------------
//   运行不存在了（404）、后端没起、Redis 流不可用 —— 这些都会在 agent.run()
//   的管道里被 catchError 收敛成对话里的一条说明（见 agent.ts）。
//   这里只接住 promise，免得它变成 unhandled rejection。
import { useCopilotKit } from '@copilotkit/react-core/v2/headless';
import React, { useEffect, useRef } from 'react';
import type { DockAgent } from './agent';
import type { ResumeCandidate } from './useSessionHistory';

export interface RunResumeProps {
  /** 当前会话的 agent —— 续订意图要挂在它身上（见 attachRun）。 */
  agent: DockAgent;
  /** 会话历史推出来的判据；undefined = 这个会话没有没跑完的运行。 */
  candidate: ResumeCandidate | undefined;
}

const RunResume: React.FC<RunResumeProps> = ({ agent, candidate }) => {
  const { copilotkit } = useCopilotKit();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current || !candidate) return;
    doneRef.current = true;

    // 顺序不能反：先声明"这次是去续订"，再让它跑 ——
    // runAgent 会同步走到 agent.run()，那里会把标记读走（见 attachRun 的说明）。
    agent.attachRun(candidate.runId);

    // ⚠️ 无论成败都要把**还没被消费**的标记清掉（`clearAttach`）
    // -------------------------------------------------------
    //   `runAgent` 可能同步抛（典型："已经有一个 run 在跑"），也可能因为别的原因
    //   没走到 `agent.run()`。那种情况下标记会留在身上，下一次用户真发消息时被
    //   劫持成"续订这个旧运行"—— 新消息根本没提交，界面只报"运行不存在"。
    //   刷新页面能好，正是因为内存里的标记没了。所以这里兜住两种情况：
    //     · 同步抛 → catch 里立刻清；
    //     · 异步落定（成功或失败）→ finally 里清。
    //   成功时这步是空操作：`run()` 的同步段早就把标记读走了。
    try {
      void copilotkit
        .runAgent({ agent })
        .catch(() => {
          // 原因已经在对话里了（见文件头），这里只吞掉 promise 的 rejection。
        })
        .finally(() => agent.clearAttach());
    } catch {
      agent.clearAttach();
    }
  }, [agent, candidate, copilotkit]);

  return null;
};

export default RunResume;
