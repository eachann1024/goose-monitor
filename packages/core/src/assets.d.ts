/* 静态资源 import 的类型声明（vite 将其解析为 URL 字符串）。 */
declare const __APP_VERSION__: string;

declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
