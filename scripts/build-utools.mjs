/* 把 vite 构建产物 dist/ 组装成 uTools 插件目录 utools-dist/。
   产物结构：index.html + assets/ + preload.js + plugin.json + logo.png
   用法：npm run utools:build （会先 vite build --mode utools） */
import { cpSync, mkdirSync, rmSync, existsSync, copyFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const out = resolve(root, "utools-dist");
const utoolsDir = resolve(root, "utools");

// GOOSE_DEBUG=1：保留 .map，方便在 uTools 开发者工具里调试未压缩源码。
// 正式发布（未设置）：剥离 .map，保持离线包整洁、不外泄源码映射。
const isDebug = process.env.GOOSE_DEBUG === "1";

if (!existsSync(dist)) {
  console.error("✗ dist/ 不存在，请先运行 vite build --mode utools");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. 拷贝前端构建产物
cpSync(dist, out, { recursive: true });

// 1b. 正式发布剥离 sourcemap（debug 构建保留）
if (!isDebug) {
  const assetsDir = resolve(out, "assets");
  if (existsSync(assetsDir)) {
    let removed = 0;
    for (const f of readdirSync(assetsDir)) {
      if (f.endsWith(".map")) {
        unlinkSync(resolve(assetsDir, f));
        removed++;
      }
    }
    if (removed) console.log(`  ↳ 已剥离 ${removed} 个 sourcemap（正式发布）`);
  }
}

// 2. 拷贝 preload.js + plugin.json
copyFileSync(resolve(utoolsDir, "preload.js"), resolve(out, "preload.js"));
copyFileSync(resolve(utoolsDir, "plugin.json"), resolve(out, "plugin.json"));

// 3. logo：复用 Tauri 图标（512×512），uTools 要求 logo ≤ 256×256，故用 sips 缩放后再写入。
const logoSrc = resolve(root, "src-tauri/icons/icon.png");
const logoOut = resolve(out, "logo.png");
if (existsSync(logoSrc)) {
  try {
    execFileSync("sips", ["-z", "256", "256", logoSrc, "--out", logoOut], { stdio: "ignore" });
  } catch (_) {
    // sips 不可用（非 macOS）时退化为直接拷贝，发布前需自行确保尺寸 ≤256。
    copyFileSync(logoSrc, logoOut);
  }
} else {
  writeFileSync(logoOut, ""); // 占位，避免缺文件
}

// 4. 明确声明 CommonJS，保证 preload.js 在任何 Node 加载器下都按 CJS 解析
writeFileSync(
  resolve(out, "package.json"),
  JSON.stringify({ name: "prockill-utools", version: "0.1.0", type: "commonjs" }, null, 2)
);

console.log("✓ uTools 插件已生成: " + out);
console.log("  在 uTools 开发者工具中以「项目目录」方式加载该文件夹，或打包成 .upx 分发。");
