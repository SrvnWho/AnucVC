// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{thread::sleep, time::Duration};
use tauri::{
  AppHandle, CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
  SystemTrayMenuItem, WindowEvent,
};

// The web UI drives updates through these two commands (initDesktopUpdates()
// in app.js) instead of Tauri's built-in updater dialog. That dialog ran while
// the always-on-top splash screen was still up and could attach itself to the
// splash window (and close along with it), was English-only, and showed
// nothing at all while the installer downloaded - which from our own server
// can take a minute.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
  let update = app.updater().check().await.map_err(|e| e.to_string())?;
  Ok(if update.is_update_available() {
    Some(update.latest_version().to_string())
  } else {
    None
  })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
  let update = app.updater().check().await.map_err(|e| e.to_string())?;
  if !update.is_update_available() {
    return Ok(());
  }
  // Emits tauri://update-download-progress and tauri://update-status, which
  // drive the progress toast while this runs.
  update.download_and_install().await.map_err(|e| e.to_string())?;
  // Windows never gets here: the installer has been launched and this process
  // has already exited. macOS swaps the .app bundle in place instead.
  app.restart();
  Ok(())
}

// An update has to arrive in the installer format this copy was installed
// with. latest.json's plain "windows-x86_64" entry is one package for everyone,
// so a setup.exe (NSIS, per-user) install that was handed the MSI got a second,
// per-machine copy in Program Files while its own shortcuts kept starting the
// old version - which then offered the same update again. Tauri's NSIS
// installer leaves uninstall.exe next to the app; the MSI never does.
#[cfg(target_os = "windows")]
fn installer_updater_target() -> Option<String> {
  let exe = std::env::current_exe().ok()?;
  let kind = if exe.parent()?.join("uninstall.exe").exists() {
    "nsis"
  } else {
    "msi"
  };
  tauri::updater::target().map(|target| format!("{target}-{kind}"))
}

fn main() {
  let tray_menu = SystemTrayMenu::new()
    .add_item(CustomMenuItem::new("show", "AnucVC'yi Göster"))
    .add_native_item(SystemTrayMenuItem::Separator)
    .add_item(CustomMenuItem::new("quit", "Çıkış"));

  let builder = tauri::Builder::default();
  #[cfg(target_os = "windows")]
  let builder = match installer_updater_target() {
    Some(target) => builder.updater_target(target),
    None => builder,
  };

  builder
    // Must be registered first: a second launch (e.g. double-clicking the
    // desktop icon while an instance is already hidden in the tray) is
    // caught here instead of spawning a whole second process - we just
    // show/focus the existing window.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
    .system_tray(SystemTray::new().with_menu(tray_menu).with_tooltip("AnucVC"))
    .on_system_tray_event(|app, event| match event {
      SystemTrayEvent::LeftClick { .. } => {
        if let Some(window) = app.get_window("main") {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }
      SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
        "show" => {
          if let Some(window) = app.get_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
          }
        }
        "quit" => {
          app.exit(0);
        }
        _ => {}
      },
      _ => {}
    })
    // Closing the main window's titlebar X hides it to the tray instead of
    // quitting - voice chat, the socket connection and notifications all
    // keep running in the background (the webview itself is only hidden,
    // never torn down) until "Çıkış" is chosen from the tray menu above.
    .on_window_event(|event| {
      if event.window().label() == "main" {
        if let WindowEvent::CloseRequested { api, .. } = event.event() {
          let _ = event.window().hide();
          api.prevent_close();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![check_update, install_update])
    .setup(|app| {
      let splashscreen = app.get_window("splashscreen").unwrap();
      let main_window = app.get_window("main").unwrap();
      // A minimum display time so the splash reads as an actual loading
      // screen instead of a flash on a fast connection. The update check is
      // started by the web UI once it has loaded (see check_update above).
      tauri::async_runtime::spawn(async move {
        sleep(Duration::from_millis(1600));
        let _ = splashscreen.close();
        let _ = main_window.show();
        let _ = main_window.set_focus();
      });
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
