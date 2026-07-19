//! 应用图标抓取。
//! macOS：从 .app bundle 的 Info.plist 找到 .icns，用系统自带 `sips` 转成小尺寸 PNG，
//!         再 base64 成 data URL 交给前端 <img> 显示真实图标；失败则返回 None（前端降级字形方块）。
//! Windows：用内置 PowerShell + System.Drawing 从 exe 提取关联图标，转 PNG → base64。零额外依赖。
//! Linux：解析进程可执行名在标准图标主题目录（hicolor / pixmaps）查找 PNG，读回 base64。
//!
//! 三平台共用一份按路径去重的进程内缓存（含「已失败」负缓存），避免每次刷新重复抓取（开销大）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::Engine;
// Path/PathBuf 仅 macOS 与 Linux 分支用到（Windows 用临时文件 PathBuf 来自 env::temp_dir 的返回值，
// 无需显式 import 该类型名）；按平台收口，避免 Windows 上的 unused_imports 警告。
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::{Path, PathBuf};

/// 缓存：bundle/exe 路径 -> 图标 data URL（None 表示已尝试且失败，避免反复重试）。
static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// 临时文件名唯一序号：两个线程并发为同一 path 首次抓取时（缓存检查在锁外，存在重复抓取窗口），
/// 各自拿到不同序号 → 写不同临时文件，避免并发 sips/powershell 写同一文件互相污染读到半截 PNG。
/// Linux 分支不写临时文件，故那里此 static 无引用 —— allow 抑制其 dead_code 警告。
#[allow(dead_code)]
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 生成本次抓取专属的唯一临时文件名后缀（路径哈希 + 单调序号）。
#[allow(dead_code)]
fn unique_tmp_suffix(path_hash_src: &str) -> String {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}", simple_hash(path_hash_src), seq)
}

/// 尝试获取应用图标，返回 data URL（如 "data:image/png;base64,...")。
/// 失败返回 None —— 前端降级为品牌色字形方块。
pub fn icon_data_url(app_path: &str) -> Option<String> {
    if app_path.is_empty() {
        return None;
    }
    // 命中缓存（含"已失败"的负缓存）。
    {
        let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(hit) = map.get(app_path) {
            return hit.clone();
        }
    }

    let result = extract(app_path);

    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(app_path.to_string(), result.clone());
    result
}

/// 真正抓取（不走缓存）。按平台分发。
#[allow(unused_variables)]
fn extract(app_path: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        extract_macos(app_path)
    }
    #[cfg(target_os = "windows")]
    {
        extract_windows(app_path)
    }
    #[cfg(target_os = "linux")]
    {
        extract_linux(app_path)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

/// macOS：定位 .app bundle → 找 .icns → sips 转 PNG → base64 data URL。
#[cfg(target_os = "macos")]
fn extract_macos(app_path: &str) -> Option<String> {
    let bundle = bundle_root(app_path)?;
    let icns = locate_icns(&bundle)?;
    let png = icns_to_png(&icns)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 从任意路径取得 .app bundle 根（与 process.rs::app_bundle 同源逻辑，独立实现避免耦合）。
#[cfg(target_os = "macos")]
fn bundle_root(path: &str) -> Option<PathBuf> {
    if let Some(idx) = path.find(".app/") {
        return Some(PathBuf::from(&path[..idx + 4]));
    }
    if path.ends_with(".app") {
        return Some(PathBuf::from(path));
    }
    None
}

/// 在 bundle 内定位主图标 .icns：
/// 1) 读 Info.plist 的 CFBundleIconFile（用 PlistBuddy）；
/// 2) 退化为 Contents/Resources 下第一个 .icns。
#[cfg(target_os = "macos")]
fn locate_icns(bundle: &Path) -> Option<PathBuf> {
    use std::process::Command;
    let resources = bundle.join("Contents/Resources");
    let plist = bundle.join("Contents/Info.plist");

    // 1) 优先读 Info.plist 指定的图标名
    if plist.exists() {
        if let Ok(out) = Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleIconFile"])
            .arg(&plist)
            .output()
        {
            if out.status.success() {
                let mut name = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !name.is_empty() {
                    if !name.to_lowercase().ends_with(".icns") {
                        name.push_str(".icns");
                    }
                    let candidate = resources.join(&name);
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    // 2) 退化：Resources 下第一个 .icns
    if let Ok(rd) = std::fs::read_dir(&resources) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("icns"))
                .unwrap_or(false)
            {
                return Some(p);
            }
        }
    }
    None
}

/// 用系统 `sips` 把 .icns 转成 64×64 PNG 字节（菜单栏列表小图足够）。
#[cfg(target_os = "macos")]
fn icns_to_png(icns: &Path) -> Option<Vec<u8>> {
    use std::process::Command;
    // 输出到临时文件再读回（sips 不支持写 stdout）。用「路径哈希 + 单调序号」做唯一名：
    // 缓存检查在锁外，同一 icns 可能被两个线程并发抓取，序号保证各写各的文件，不互相污染。
    let tmp = std::env::temp_dir().join(format!(
        "prockill-icon-{}.png",
        unique_tmp_suffix(icns.to_string_lossy().as_ref())
    ));
    let out = Command::new("sips")
        .args(["-s", "format", "png", "-z", "64", "64"])
        .arg(icns)
        .arg("--out")
        .arg(&tmp)
        .output();
    let ok = matches!(&out, Ok(o) if o.status.success());
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    let bytes = std::fs::read(&tmp).ok();
    let _ = std::fs::remove_file(&tmp);
    bytes
}

#[allow(dead_code)]
fn simple_hash(s: &str) -> u64 {
    let mut h: u64 = 1469598103934665603;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

/// Windows：用内置 Windows PowerShell (5.1) + System.Drawing 从 exe 提取关联图标 → 64×64 PNG → base64。
/// `powershell` 在标准 Windows 上指向自带的 5.1（基于 .NET Framework，含 System.Drawing）。
/// 若环境把 `powershell` 重定向到 PowerShell 7+（.NET Core），System.Drawing.Common 可能缺失，
/// 此时脚本 catch 退出 → 静默降级字形方块（不崩溃）。这是 best-effort 抓取的已知取舍。
#[cfg(target_os = "windows")]
fn extract_windows(exe_path: &str) -> Option<String> {
    use std::process::Command;
    if !exe_path.to_lowercase().ends_with(".exe") {
        return None;
    }
    // 唯一临时名（哈希 + 单调序号）：同一 exe 被并发抓取时各写各的文件，避免互相覆盖读到半截 PNG。
    let tmp =
        std::env::temp_dir().join(format!("prockill-icon-{}.png", unique_tmp_suffix(exe_path)));
    let tmp_str = tmp.to_string_lossy().replace('\'', "''");
    let src = exe_path.replace('\'', "''");
    // 提取关联图标 → 缩放到 64×64 高质量 → 存 PNG。失败（无图标/路径无效）时退出码非 0。
    let script = format!(
        "Add-Type -AssemblyName System.Drawing; \
         try {{ \
           $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('{src}'); \
           if ($ico -eq $null) {{ exit 1 }}; \
           $bmp = New-Object System.Drawing.Bitmap 64,64; \
           $g = [System.Drawing.Graphics]::FromImage($bmp); \
           $g.InterpolationMode = 'HighQualityBicubic'; \
           $g.DrawIcon($ico, (New-Object System.Drawing.Rectangle 0,0,64,64)); \
           $bmp.Save('{tmp_str}', [System.Drawing.Imaging.ImageFormat]::Png); \
           $g.Dispose(); $bmp.Dispose(); $ico.Dispose() \
         }} catch {{ exit 1 }}"
    );
    // CREATE_NO_WINDOW：抑制 GUI 应用 spawn powershell 时一闪而过的黑色控制台窗。
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let ok = matches!(&out, Ok(o) if o.status.success());
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    let bytes = std::fs::read(&tmp).ok();
    let _ = std::fs::remove_file(&tmp);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes?);
    Some(format!("data:image/png;base64,{b64}"))
}

/// Linux：按可执行名在图标主题目录查找 PNG（hicolor 各尺寸 / pixmaps），读回 base64。
/// 尽力而为：不解析 .desktop 的 Icon= 字段，故图标名 ≠ 可执行名（如 Flatpak/Snap 包装器、
/// google-chrome vs chrome）时会 miss，命中失败则前端降级字形方块。覆盖系统级 + 用户级 +
/// Flatpak/Snap 导出的标准主题目录，但不保证抓到全部应用。
#[cfg(target_os = "linux")]
fn extract_linux(exe_path: &str) -> Option<String> {
    let stem = Path::new(exe_path).file_name()?.to_str()?.to_string();
    if stem.is_empty() {
        return None;
    }
    // 图标主题根目录：系统级 + 用户级（~/.local/share/icons、~/.icons）+ Flatpak/Snap 导出目录。
    let home = std::env::var("HOME").ok();
    let mut roots: Vec<String> = vec![
        "/usr/share/icons/hicolor".into(),
        "/usr/local/share/icons/hicolor".into(),
        "/var/lib/flatpak/exports/share/icons/hicolor".into(),
        "/var/lib/snapd/desktop/icons/hicolor".into(),
    ];
    if let Some(h) = &home {
        roots.push(format!("{h}/.local/share/icons/hicolor"));
        roots.push(format!("{h}/.icons/hicolor"));
        roots.push(format!(
            "{h}/.local/share/flatpak/exports/share/icons/hicolor"
        ));
    }

    // 候选文件：优先大尺寸（更清晰），再 pixmaps 兜底。
    let sizes = ["128x128", "64x64", "256x256", "48x48", "96x96", "32x32"];
    let mut candidates: Vec<PathBuf> = Vec::new();
    for base in &roots {
        for sz in sizes {
            candidates.push(PathBuf::from(format!("{base}/{sz}/apps/{stem}.png")));
        }
    }
    candidates.push(PathBuf::from(format!("/usr/share/pixmaps/{stem}.png")));
    candidates.push(PathBuf::from(format!("/usr/share/pixmaps/{stem}.xpm"))); // 仅探测，xpm 不嵌入

    for c in candidates {
        if c.extension().and_then(|e| e.to_str()) == Some("png") && c.exists() {
            if let Ok(bytes) = std::fs::read(&c) {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                return Some(format!("data:image/png;base64,{b64}"));
            }
        }
    }
    None
}
