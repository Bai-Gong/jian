import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Menu, type MenuOptions, type MenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MenuEntry } from "@baigong/fang";

/** The browser preview and Windows retain Fang's in-window menus. */
export function isMacDesktop(): boolean {
  return isTauri() && typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
}

const shortcuts: Record<string, string> = {
  "新建项目": "CmdOrCtrl+N",
  "打开项目…": "CmdOrCtrl+O",
  "保存项目": "CmdOrCtrl+S",
  "项目另存为…": "CmdOrCtrl+Shift+S",
};

type NativeItem = MenuItemOptions | PredefinedMenuItemOptions;
const standardEditing: NativeItem[] = [
  { item: "Undo" }, { item: "Redo" }, { item: "Separator" },
  { item: "Cut" }, { item: "Copy" }, { item: "Paste" }, { item: "SelectAll" },
  { item: "Separator" },
];

/** Keep actions pointed at the latest model even while native IPC is in flight. */
function menuOptions(menus: MenuEntry[], latest: { current: MenuEntry[] }): MenuOptions {
  return {
    items: [
      {
        text: "百工·剪",
        items: [
          { item: { About: null } }, { item: "Separator" }, { item: "Services" },
          { item: "Separator" }, { item: "Hide" }, { item: "HideOthers" }, { item: "ShowAll" },
          { item: "Separator" },
          { text: "退出百工·剪", accelerator: "CmdOrCtrl+Q", action: () => { void getCurrentWindow().close().catch(console.error); } },
        ],
      },
      ...menus.map((menu, menuIndex) => ({
        text: menu.label,
        items: [
          ...(menu.label === "编辑" ? standardEditing : []),
          ...menu.items.map((item, itemIndex): NativeItem => item.kind === "separator" ? { item: "Separator" } : {
            text: `${item.checked ? "✓ " : ""}${item.label}`,
            enabled: !item.disabled,
            accelerator: menu.label === "文件" ? shortcuts[item.label] : undefined,
            action: () => {
              const current = latest.current[menuIndex]?.items[itemIndex];
              if (current?.kind === "item" && !current.disabled) current.onSelect?.();
            },
          }),
        ],
      })),
    ],
  };
}

/** Install serialized updates so an older asynchronous menu cannot overwrite a newer one. */
export function useNativeMenu(menus: MenuEntry[], onFailure: () => void): boolean {
  const latest = useRef(menus);
  latest.current = menus;
  const failed = useRef(onFailure);
  failed.current = onFailure;
  const version = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const installed = useRef<Menu | null>(null);
  const mounted = useRef(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isMacDesktop()) return;
    const revision = ++version.current;
    queue.current = queue.current.then(async () => {
      if (revision !== version.current) return;
      const menu = await Menu.new(menuOptions(menus, latest));
      if (revision !== version.current) { await menu.close(); return; }
      try {
        const previous = await menu.setAsAppMenu();
        const old = installed.current;
        installed.current = mounted.current ? menu : null;
        if (mounted.current && revision === version.current) {
          document.documentElement.dataset.nativeMenu = "true";
          setReady(true);
        }
        // The returned previous handle and our own handle are separate resources.
        await previous?.close().catch(console.warn);
        await old?.close().catch(console.warn);
        if (!mounted.current) await menu.close().catch(console.warn);
      } catch (error) {
        await menu.close().catch(console.warn);
        throw error;
      }
    }).catch(error => {
      console.error("无法安装系统菜单", error);
      if (revision === version.current) {
        delete document.documentElement.dataset.nativeMenu;
        setReady(false);
        failed.current();
      }
    });
    return () => { version.current++; };
  }, [menus]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      delete document.documentElement.dataset.nativeMenu;
      const menu = installed.current;
      installed.current = null;
      if (menu) void menu.close().catch(console.warn);
    };
  }, []);
  return ready;
}
