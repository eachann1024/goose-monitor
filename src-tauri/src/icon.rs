//! 应用图标抓取。当前为可选增强：返回 None 时前端降级为品牌色字形方块（已足够美观）。
//! 预留接口，后续可在 macOS 用 NSWorkspace、Windows 用 win-icon-extractor 填充真实图标。

/// 尝试获取应用图标，返回 data URL（如 "data:image/png;base64,...")。
/// 目前统一返回 None —— 字形方块占位，避免引入易碎的平台原生依赖影响核心功能。
pub fn icon_data_url(_app_path: &str) -> Option<String> {
    None
}
