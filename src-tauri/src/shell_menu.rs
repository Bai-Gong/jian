//! Native macOS Quit must ask the project UI before terminating AppKit.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    App, Emitter, Manager,
};

pub fn install(app: &App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let quit = MenuItem::with_id(app, "quit-project", "退出百工·剪", true, Some("CmdOrCtrl+Q"))?;
    let application = Submenu::with_items(
        app,
        "百工·剪",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    // The default macOS menu's first submenu is the application menu. Keep the
    // standard Edit, View and Window commands, replacing only the direct Quit.
    menu.remove_at(0)?;
    menu.insert(&application, 0)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "quit-project" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("project-close-requested", ());
            }
        }
    });
    Ok(())
}
