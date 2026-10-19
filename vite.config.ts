import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// fang 本地联调轨（fang README「消费方式」）：alias 直连 src，不经构建产物。
// tsconfig.json 的 paths 与此双轨同源；registry 搭建后切换为正式依赖（开发方案 3.4）。
const fangSrc = fileURLToPath(new URL("../fang/src", import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  resolve: {
    alias: [
      // 先长后短：tokens.css 子路径必须先于主入口匹配
      { find: /^@baigong\/fang\/tokens\.css$/, replacement: `${fangSrc}/theme/tokens.css` },
      { find: /^@baigong\/fang$/, replacement: `${fangSrc}/index.ts` },
    ],
    // fang src 经 alias 进包后，其内部 `import "react"` 会解析到 fang 自己的 node_modules，
    // 与 jian 侧形成两份 react 实例（hooks 崩溃）。dedupe 强制统一解析到本项目根的副本。
    dedupe: ["react"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //    （1420 为 zhi 占用，剪用 1430，同机双开不冲突）
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
