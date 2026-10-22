import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setupWindowControls } from "./shell/windowControls";
import "./styles/global.css";

// 窗口三键适配器先于渲染注入（TitleBar 挂载帧读取一次）
setupWindowControls();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
