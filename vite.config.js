import { defineConfig } from "vite";
import { resolve } from "node:path";

const coreRoot = resolve(__dirname, "packages/core");

// ProcKill 前端构建配置。
// - 普通 / Tauri 模式：构建到 dist/，由 Tauri 或浏览器 dev server 加载。
// - utools 模式：同样产出 dist/，再由 scripts/build-utools.mjs 包装成 uTools 插件目录。
export default defineConfig(({ mode }) => ({
  root: coreRoot,
  // uTools 插件用 file:// 加载，必须相对路径；Tauri/浏览器用绝对路径即可。
  base: mode === "utools" ? "./" : "/",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "es2020",
    // 关闭 sourcemap，保持 uTools 离线包整洁
    sourcemap: false,
    rollupOptions: {
      // 多入口：主窗口 index.html + 菜单栏 popover 窗口 tray.html
      input: {
        index: resolve(coreRoot, "index.html"),
        tray: resolve(coreRoot, "tray.html"),
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
