/* 把 vite 构建产物 dist/ 组装成 uTools 插件目录 utools-dist/。
   产物结构：index.html + assets/ + preload.js + plugin.json + logo.png
   用法：npm run utools:build （会先 vite build --mode utools） */
import { cpSync, mkdirSync, rmSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const out = resolve(root, "utools-dist");
const utoolsDir = resolve(root, "utools");

if (!existsSync(dist)) {
  console.error("✗ dist/ 不存在，请先运行 vite build --mode utools");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. 拷贝前端构建产物
cpSync(dist, out, { recursive: true });

// 2. 拷贝 preload.js + plugin.json
copyFileSync(resolve(utoolsDir, "preload.js"), resolve(out, "preload.js"));
copyFileSync(resolve(utoolsDir, "plugin.json"), resolve(out, "plugin.json"));

// 3. logo：复用 Tauri 图标
const logoSrc = resolve(root, "src-tauri/icons/icon.png");
if (existsSync(logoSrc)) {
  copyFileSync(logoSrc, resolve(out, "logo.png"));
} else {
  writeFileSync(resolve(out, "logo.png"), ""); // 占位，避免缺文件
}

// 4. 明确声明 CommonJS，保证 preload.js 在任何 Node 加载器下都按 CJS 解析
writeFileSync(
  resolve(out, "package.json"),
  JSON.stringify({ name: "prockill-utools", version: "0.1.0", type: "commonjs" }, null, 2)
);

console.log("✓ uTools 插件已生成: " + out);
console.log("  在 uTools 开发者工具中以「项目目录」方式加载该文件夹，或打包成 .upx 分发。");
