// 验证 macOS 真实应用图标抽取：对若干已安装 app 跑 icon_data_url，打印结果摘要。
#[path = "../src/icon.rs"]
mod icon;

fn main() {
    let candidates = [
        "/Applications/Google Chrome.app",
        "/System/Applications/Music.app",
        "/System/Library/CoreServices/Finder.app",
        "/Applications/Safari.app",
        "/System/Applications/Notes.app",
    ];
    let mut ok = 0;
    for p in candidates {
        if !std::path::Path::new(p).exists() {
            println!("skip (不存在): {p}");
            continue;
        }
        match icon::icon_data_url(p) {
            Some(url) => {
                ok += 1;
                let head: String = url.chars().take(40).collect();
                println!("OK  {p}  len={} prefix={head}...", url.len());
            }
            None => println!("MISS 无图标: {p}"),
        }
    }
    // 第二次调用应命中缓存（不再跑 sips）
    let _ = icon::icon_data_url(candidates[0]);
    println!("\n抓到图标的 app 数: {ok}");
    if ok == 0 {
        std::process::exit(1);
    }
}
