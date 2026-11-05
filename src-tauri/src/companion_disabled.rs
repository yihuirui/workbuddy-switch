//! The focused first release excludes the optional companion runtime.
use tauri::AppHandle;
pub fn enabled<R: tauri::Runtime>(_: &AppHandle<R>) -> bool {
    false
}
#[tauri::command]
pub fn get_companion_enabled(_app: AppHandle) -> bool {
    false
}
#[tauri::command]
pub fn set_companion_enabled(_app: AppHandle, _enabled: bool) -> Result<bool, String> {
    Err("首版未打包会话悬浮窗".into())
}
#[tauri::command]
pub fn open_companion_settings(_app: AppHandle) -> Result<(), String> {
    Err("首版未打包会话悬浮窗".into())
}
pub fn toggle_rail(_: &AppHandle) {}
pub fn open_settings_from_tray(_: &AppHandle) {}
