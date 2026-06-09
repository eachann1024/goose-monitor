import { defineConfig } from "vite";
import { resolve } from "node:path";

const coreRoot = resolve(__dirname, "packages/core");

// GOOSE_DEBUG=1 时进入可调试构建：保留未压缩源码 + sourcemap，
// 方便在 uTools / Tauri 开发者工具里直接看到 packages/core/src/ 原始路径。
// 不设置（正式发布）则压缩 + 不产 sourcemap，保持产物精简、离线包整洁。
const isDebug = process.env.GOOSE_DEBUG === "1";

// ProcKill 前端构建配置。
// - 普通 / Tauri 模式：构建到 dist/，由 Tauri 或浏览器 dev server 加载。
// - utools 模式：同样产出 dist/，再由 scripts/build-utools.mjs 包装成 uTools 插件目录。
// uTools 插件以 file:// 加载，不允许引用任何网络 JS/CSS（发布时会被拒）。
// 此插件在 utools 构建模式下从 HTML 中删除所有 Google Fonts <link> 标签。
function stripExternalFonts() {
  return {
    name: "strip-external-fonts",
    transformIndexHtml(html) {
      return html
        .replace(/<link[^>]+fonts\.googleapis\.com[^>]*>\s*/g, "")
        .replace(/<link[^>]+fonts\.gstatic\.com[^>]*>\s*/g, "");
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: coreRoot,
  // uTools 插件用 file:// 加载，必须相对路径；Tauri/浏览器用绝对路径即可。
  base: mode === "utools" ? "./" : "/",
  plugins: mode === "utools" ? [stripExternalFonts()] : [],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    // es2020 对齐目标 webview：Tauri 三平台（WKWebView / WebView2 / WebKitGTK）
    // 与 uTools（较新 Electron/Chromium）均稳过 es2020，无需更激进的降级。
    target: "es2020",
    // 可调试构建产出 sourcemap；正式发布关闭，保持离线包整洁。
    sourcemap: isDebug,
    // 可调试构建关闭压缩，开发者工具里直接读未混淆源码。
    minify: isDebug ? false : "esbuild",
    rollupOptions: {
      // 多入口：主窗口 index.html + 菜单栏 popover 窗口 tray.html
      input: {
        index: resolve(coreRoot, "index.html"),
        tray: resolve(coreRoot, "tray.html"),
      },
      output: {
        // 把 @tauri-apps/api 拆成独立 vendor 分包：
        // 第三方依赖与业务代码缓存边界分离，业务改动不会让 vendor 哈希失效。
        manualChunks(id) {
          if (id.includes("node_modules/@tauri-apps")) return "tauri-vendor";
          return undefined;
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: false,
    host: "127.0.0.1",
  },
}));
