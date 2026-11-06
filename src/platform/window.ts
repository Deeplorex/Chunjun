import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';

type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

export async function windowAction(action: WindowAction) {
  if (!isTauri()) return;
  const current = getCurrentWindow();
  try {
    if (action === 'minimize') await current.minimize();
    if (action === 'toggleMaximize') await current.toggleMaximize();
    if (action === 'close') await current.close();
  } catch {
    // Window commands can be denied by capability policy; never fail the UI over chrome.
  }
}

/** 任务栏进度状态：percent 为 0..1 的整体进度；结束后清除。 */
export type TaskbarProgress =
  | { kind: 'progress'; fraction: number }
  | { kind: 'paused'; fraction: number }
  | { kind: 'none' };

/** 把任务事件映射为任务栏进度状态；数值钳到 0..1，越界不更新。 */
export function taskbarProgress(
  fraction: number,
  paused: boolean,
): TaskbarProgress {
  if (!Number.isFinite(fraction)) return { kind: 'none' };
  const clamped = Math.min(1, Math.max(0, fraction));
  return paused
    ? { kind: 'paused', fraction: clamped }
    : { kind: 'progress', fraction: clamped };
}

/** 更新 Windows 任务栏上的进度条；失败只忽略，不影响处理流程。 */
export async function setTaskbarProgress(state: TaskbarProgress) {
  if (!isTauri()) return;
  const current = getCurrentWindow();
  try {
    if (state.kind === 'none') {
      await current.setProgressBar({ status: ProgressBarStatus.None });
    } else if (state.kind === 'paused') {
      await current.setProgressBar({ status: ProgressBarStatus.Paused });
    } else {
      await current.setProgressBar({
        status: ProgressBarStatus.Normal,
        progress: Math.round(state.fraction * 100),
      });
    }
  } catch {
    // 进度条被权限策略拒绝或系统不支持时静默忽略。
  }
}

/**
 * 跟随窗口的最大化状态。
 *
 * 启动时后端可能主动最大化（屏幕放不下设计尺寸），之后用户也可能点标题栏或
 * 双击拖动区，所以不能只在点击时切换图标，要监听 resize 并回读真实状态。
 * 返回取消订阅的函数；不在桌面壳里时什么都不做。
 */
export async function watchMaximized(
  onChange: (maximized: boolean) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const current = getCurrentWindow();
  let alive = true;

  async function sync() {
    try {
      const maximized = await current.isMaximized();
      if (alive) onChange(maximized);
    } catch {
      // 读不到状态就保持上一个值，不至于让图标乱跳。
    }
  }

  await sync();
  const unlisten = await current
    .onResized(() => void sync())
    .catch(() => () => {});

  return () => {
    alive = false;
    unlisten();
  };
}
