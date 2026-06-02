/* 环境探测：按运行宿主选择合适的 bridge 实现。
   优先级：Tauri > uTools（带 services）> 浏览器 mock。 */
import type { PlatformBridge } from "../types";
import { TauriBridge } from "./tauri";
import { UtoolsBridge } from "./utools";
import { BrowserBridge } from "./browser";

export function detectBridge(): PlatformBridge {
  const g = window as any;
  // Tauri：注入 __TAURI__ 或 __TAURI_INTERNALS__
  if (g.__TAURI__ || g.__TAURI_INTERNALS__) {
    return new TauriBridge();
  }
  // uTools：window.utools 存在且 preload 暴露了 services
  if (g.utools && g.services) {
    return new UtoolsBridge();
  }
  // 兜底：浏览器 mock（也覆盖 uTools preload 尚未就绪的开发态）
  return new BrowserBridge();
}

export type { PlatformBridge };
