// src/pages/task/components/TaskActions.tsx
// 立即执行 / 取消 / 重试三个动作。列表页与详情页共用。
//
// 三条契约决定了这里**不能**做成"点了 → 弹成功"：
//
//  ⓪ invoke 只是"把 execute_at 提前到现在"，**不新建任务、不动 attempt**；
//     返回 200 也只代表"已投递"，执行仍异步 —— 所以提示语不能写成"已执行完成"。
//     它只对 pending / retryable 生效，running 与终态都 409。
//  ① cancel 是**协作式**的，返回的是取消之后它真实所处的位置。
//     返回 running = 正在收尾（不是失败）；返回终态 = 取消来晚了（不是错误）。
//     所以成功/提示/警告三档由返回的 status 决定，见 describeCancelResult。
//  ② retry 只对 failed / cancelled 合法，其余后端回 **409**（中文原因）。
//     409 的文案由全局 errorHandler 弹出，这里**不再补一条** toast —— 两条一起弹
//     会让用户以为出了两个错。
//
// 确认面统一走**全局 modal**（App.useApp().modal.confirm），不再用挂在按钮上的
// Popconfirm 气泡：表格行只有几像素高，气泡被行高挤住，`description` 那段
// （"同一个 run、attempt 不变"这类关键前提）根本读不全。modal 走 onOk 返回的
// Promise，提交期间 OK 按钮自己转圈，且不会因为列表滚动/刷新而跟着动。
import { App, Button } from 'antd';
import React, { useState } from 'react';
import type { TaskStatus } from '../data';
import { cancelTask, invokeTask, retryTask } from '../service';
import {
  canCancel,
  canInvoke,
  canRetry,
  describeCancelResult,
  invokeConfirmText,
} from '../utils';

interface TaskActionsProps {
  taskId: string;
  status: TaskStatus;
  /** 可执行时刻。只有它非空时才可能画「立即执行」（见 canInvoke）。 */
  executeAt?: string | null;
  /** 动作成功后调用（通常是刷新列表 / 重新拉详情）。 */
  onDone?: () => void;
  /** link 用于表格操作列；button 用于详情页头部。 */
  mode?: 'link' | 'button';
}

/** 取消确认框里那句话得跟着状态变 —— 对 running 说"不会再被认领"是错的。 */
function cancelConfirmText(status: TaskStatus): string {
  if (status === 'running') {
    return '协作式取消：正在跑的 Handler 不会被强杀，它会在下次写回结果时停住。';
  }
  if (status === 'retryable') {
    return '它会停在已取消，不再等下一次调度。';
  }
  return '它还没被认领，取消后不会再被调度。';
}

const TaskActions: React.FC<TaskActionsProps> = ({
  taskId,
  status,
  executeAt,
  onDone,
  mode = 'link',
}) => {
  const { message, modal } = App.useApp();
  // 哪一颗在提交。存名字而不是布尔：否则几颗按钮会一起转圈，看着像几个请求在飞。
  const [pending, setPending] = useState<'cancel' | 'retry' | 'invoke' | null>(
    null,
  );

  const handleInvoke = async () => {
    if (pending !== null) return;
    setPending('invoke');
    try {
      await invokeTask(taskId);
      // ⚠️ 200 只代表"已投递"：execute_at 清空了，但 Handler 还没跑完。
      //    写成"已执行"就是在替后端撒谎。
      message.success(
        '已提前触发：execute_at 已清空，执行是异步的，稍后刷新看结果。',
      );
      onDone?.();
    } catch {
      // 409（在跑 / 已终结）的原因由全局 errorHandler 弹出，这里不重复弹。
      onDone?.();
    } finally {
      setPending(null);
    }
  };

  const handleCancel = async () => {
    if (pending !== null) return;
    setPending('cancel');
    try {
      const result = await cancelTask(taskId);
      // ⚠️ 按**返回的**状态说话，不按"请求没报错"说话
      const outcome = describeCancelResult(result.status);
      message[outcome.level](outcome.text);
      onDone?.();
    } catch {
      // 404 之类由全局 errorHandler 弹（含 FastAPI 的 detail）。
      // 这里仍然刷新一次：状态可能已经在别处变了。
      onDone?.();
    } finally {
      setPending(null);
    }
  };

  const handleRetry = async () => {
    if (pending !== null) return;
    setPending('retry');
    try {
      await retryTask(taskId);
      message.success('已重新排队：attempt 已清零，立即执行。');
      onDone?.();
    } catch {
      // 409（在跑 / 排队 / 已成功）的 reason 由全局 errorHandler 弹出，这里不重复。
      onDone?.();
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      {/*
        立即执行放在最左：它是"把这个任务往前推"的唯一主动作，
        与右边的取消/重试不是一类（那两个是善后）。
        只在延迟任务上出现 —— 已到点（execute_at 为空）的任务本来就会被认领。
      */}
      {canInvoke(status, executeAt) ? (
        <Button
          type={mode === 'link' ? 'link' : 'default'}
          size={mode === 'link' ? 'small' : 'middle'}
          loading={pending === 'invoke'}
          disabled={pending !== null && pending !== 'invoke'}
          onClick={() =>
            modal.confirm({
              title: '提前执行这条任务？',
              // 这段是"同一个 run、attempt 不变"的前提说明，必须读得全，
              // 所以放在 content 里而不是挤在按钮气球上。
              content: (
                <div style={{ fontSize: 13, opacity: 0.75 }}>
                  {invokeConfirmText(executeAt)}
                </div>
              ),
              okText: '立即执行',
              cancelText: '再等等',
              onOk: handleInvoke,
            })
          }
        >
          立即执行
        </Button>
      ) : null}

      {canCancel(status) ? (
        <Button
          type={mode === 'link' ? 'link' : 'default'}
          size={mode === 'link' ? 'small' : 'middle'}
          danger
          loading={pending === 'cancel'}
          disabled={pending !== null && pending !== 'cancel'}
          onClick={() =>
            modal.confirm({
              title: '取消这条任务？',
              content: (
                <div style={{ fontSize: 13, opacity: 0.75 }}>
                  {cancelConfirmText(status)}
                </div>
              ),
              okText: '取消任务',
              okButtonProps: { danger: true },
              cancelText: '再想想',
              onOk: handleCancel,
            })
          }
        >
          取消
        </Button>
      ) : null}

      {canRetry(status) ? (
        <Button
          type={mode === 'link' ? 'link' : 'default'}
          size={mode === 'link' ? 'small' : 'middle'}
          loading={pending === 'retry'}
          disabled={pending !== null && pending !== 'retry'}
          onClick={() =>
            modal.confirm({
              title: '重跑这条任务？',
              content: (
                <div style={{ fontSize: 13, opacity: 0.75 }}>
                  会开一轮新的执行：attempt
                  清零、立即执行，上一条失败原因仍然保留。
                </div>
              ),
              okText: '重跑',
              cancelText: '再想想',
              onOk: handleRetry,
            })
          }
        >
          重试
        </Button>
      ) : null}
    </>
  );
};

export default TaskActions;
