//! 启动时的窗口适配。
//!
//! 窗口按设计稿的 1440×960 **逻辑像素**创建。高 DPI 屏幕上这个尺寸会被放大：
//! 125% 缩放时等于 1800×1200 物理像素，比 1080p 显示器去掉任务栏后的工作区
//! （约 1920×1040）还高，底部 80px 的操作条就被推到屏幕外面，看起来“不见了”。
//!
//! 这里在窗口显示前做两件事：先把尺寸钳进工作区，再最大化。先钳后放大是为了
//! “还原”时也回到钳制后的大小——直接最大化再还原会回到溢出的原始尺寸。

use tauri::{PhysicalSize, WebviewWindow};

/// 窗口是否放不进显示器工作区。两边都是物理像素，避免 DPI 换算误差。
pub fn exceeds_work_area(outer: PhysicalSize<u32>, work: PhysicalSize<u32>) -> bool {
    outer.width > work.width || outer.height > work.height
}

/// 把窗口适配到当前显示器：放不下就钳到工作区并最大化，放得下保持设计尺寸。
pub fn fit_to_work_area(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let work = monitor.work_area().size;
    let outer = window.outer_size()?;
    if !exceeds_work_area(outer, work) {
        return Ok(());
    }
    window.set_size(PhysicalSize::new(
        outer.width.min(work.width),
        outer.height.min(work.height),
    ))?;
    window.center()?;
    window.maximize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn design_size_fits_a_1080p_work_area() {
        // 1080p 去掉任务栏约 1920×1040，1440×960 放得下，保持设计尺寸不动。
        assert!(!exceeds_work_area(
            PhysicalSize::new(1440, 960),
            PhysicalSize::new(1920, 1040),
        ));
    }

    #[test]
    fn scaled_design_size_needs_maximize() {
        // 125% 缩放：1440×960 逻辑像素 = 1800×1200 物理像素，比工作区高一截，
        // 正是“底部按钮不见了”的场景。
        assert!(exceeds_work_area(
            PhysicalSize::new(1800, 1200),
            PhysicalSize::new(1920, 1040),
        ));
    }

    #[test]
    fn narrow_screen_also_needs_maximize() {
        // 仅宽度放不下时同样要放大，否则右侧参数栏会被裁掉。
        assert!(exceeds_work_area(
            PhysicalSize::new(1440, 960),
            PhysicalSize::new(1366, 728),
        ));
    }
}
