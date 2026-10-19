/** 顶栏：应用标识 + 工程名占位。工程操作（新建/打开/保存）随 M3 工程化落地。 */
export function TopBar() {
  return (
    <header className="top-bar">
      <span className="top-bar__app">百工·剪</span>
      <span className="top-bar__divider" aria-hidden="true" />
      <span className="top-bar__project">未命名工程</span>
    </header>
  );
}
