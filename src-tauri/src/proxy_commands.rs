use serde_json::Value;
use wb_switch_core::modules::proxy;
fn guard() -> Result<(), String> {
    if crate::is_screenshot_demo() {
        Err("演示模式下不可操作".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub fn proxy_status() -> Result<Value, String> {
    guard()?;
    proxy::status()
}
#[tauri::command]
pub fn proxy_save_settings(settings: proxy::Settings) -> Result<(), String> {
    guard()?;
    proxy::save_settings(settings)
}
#[tauri::command]
pub async fn proxy_start() -> Result<Value, String> {
    guard()?;
    tauri::async_runtime::spawn_blocking(proxy::start)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn proxy_stop() -> Result<(), String> {
    guard()?;
    tauri::async_runtime::spawn_blocking(proxy::stop)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn proxy_preview() -> Result<Vec<Value>, String> {
    guard()?;
    Ok(proxy::preview())
}
#[tauri::command]
pub async fn proxy_sync(ids: Vec<String>, replace: Option<bool>) -> Result<Value, String> {
    guard()?;
    tauri::async_runtime::spawn_blocking(move || {
        proxy::sync_with_replace(ids, replace.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn proxy_client_key() -> Result<String, String> {
    guard()?;
    proxy::client_key()
}
#[tauri::command]
pub async fn proxy_models() -> Result<Value, String> {
    guard()?;
    proxy::models().await
}

#[tauri::command]
pub async fn proxy_test_model(model: String) -> Result<Value, String> {
    guard()?;
    proxy::test_model(model).await
}

#[tauri::command]
pub fn proxy_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    guard()?;
    proxy::set_enabled(&name, enabled)
}

fn bundled_runtime_dir(settings: &proxy::Settings) -> Option<std::path::PathBuf> {
    use std::path::Path;

    let binary = Path::new(&settings.binary_path);
    let plugin = Path::new(&settings.plugin_path);
    let binary_name = binary.file_name()?.to_str()?;
    if !matches!(binary_name, "cli-proxy-api-wb" | "cli-proxy-api") {
        return None;
    }
    let expected_plugin = if cfg!(target_os = "macos") {
        "workbuddy.dylib"
    } else {
        "workbuddy.so"
    };
    if plugin.file_name()?.to_str()? != expected_plugin || binary.parent()? != plugin.parent()? {
        return None;
    }

    let runtime = binary.parent()?;
    if runtime.file_name()?.to_str()? != "runtime" {
        return None;
    }
    let resources = runtime.parent()?;
    if resources.file_name()?.to_str()? != "Resources" {
        return None;
    }
    let contents = resources.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let app_bundle = contents.parent()?;
    if app_bundle.extension()?.to_str()? != "app"
        || !matches!(
            app_bundle.file_name()?.to_str()?,
            "WB ProxyAPI.app" | "Workbuddy-Switch2.app"
        )
    {
        return None;
    }
    Some(runtime.to_path_buf())
}

fn runtime_paths(runtime: &std::path::Path) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let patched = runtime.join("cli-proxy-api-wb");
    let binary = if patched.is_file() {
        patched
    } else {
        runtime.join("cli-proxy-api")
    };
    let plugin = runtime.join(if cfg!(target_os = "macos") {
        "workbuddy.dylib"
    } else {
        "workbuddy.so"
    });
    if !binary.is_file() || !plugin.is_file() {
        return None;
    }
    Some((binary.canonicalize().ok()?, plugin.canonicalize().ok()?))
}

fn rebind_bundled_runtime(
    settings: &proxy::Settings,
    runtime: &std::path::Path,
) -> Option<proxy::Settings> {
    let previous_runtime = bundled_runtime_dir(settings)?;
    if previous_runtime == runtime {
        return None;
    }
    let (binary, plugin) = runtime_paths(runtime)?;
    Some(proxy::Settings {
        binary_path: binary.to_string_lossy().into_owned(),
        plugin_path: plugin.to_string_lossy().into_owned(),
        port: settings.port,
    })
}

pub fn init_runtime(app: &tauri::App) -> Result<(), String> {
    use tauri::Manager;
    if crate::is_screenshot_demo() {
        return Ok(());
    }

    let settings = proxy::settings()?;
    let app_runtime = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("runtime");
    if !settings.binary_path.is_empty() || !settings.plugin_path.is_empty() {
        if let Some(updated) = rebind_bundled_runtime(&settings, &app_runtime) {
            proxy::save_settings(updated)?;
        }
        return Ok(());
    }

    let roots = [
        app_runtime,
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime"),
    ];
    for root in roots {
        if let Some((binary, plugin)) = runtime_paths(&root) {
            proxy::save_settings(proxy::Settings {
                binary_path: binary.to_string_lossy().into_owned(),
                plugin_path: plugin.to_string_lossy().into_owned(),
                port: settings.port,
            })?;
            break;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn proxy_rotate_key() -> Result<(), String> {
    guard()?;
    proxy::rotate_client_key()
}

#[cfg(test)]
mod tests {
    use super::{rebind_bundled_runtime, runtime_paths};
    use std::path::Path;
    use wb_switch_core::modules::proxy::Settings;

    fn old_bundle_settings() -> Settings {
        Settings {
            binary_path:
                "/Applications/WB ProxyAPI.app/Contents/Resources/runtime/cli-proxy-api-wb".into(),
            plugin_path: "/Applications/WB ProxyAPI.app/Contents/Resources/runtime/workbuddy.dylib"
                .into(),
            port: 8317,
        }
    }

    #[test]
    fn moved_or_renamed_bundled_runtime_rebinds_and_keeps_the_port() {
        let scratch =
            std::env::temp_dir().join(format!("workbuddy-runtime-rebind-{}", uuid::Uuid::new_v4()));
        let runtime = scratch.join("Workbuddy-Switch2.app/Contents/Resources/runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("cli-proxy-api-wb"), b"test engine").unwrap();
        std::fs::write(runtime.join("workbuddy.dylib"), b"test plugin").unwrap();

        let mut saved = old_bundle_settings();
        saved.port = 9123;
        let updated =
            rebind_bundled_runtime(&saved, &runtime).expect("bundled runtime should rebind");
        let (binary, plugin) = runtime_paths(&runtime).unwrap();
        assert_eq!(updated.binary_path, binary.to_string_lossy());
        assert_eq!(updated.plugin_path, plugin.to_string_lossy());
        assert_eq!(updated.port, 9123);

        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn custom_external_runtime_is_never_replaced_by_the_bundled_runtime() {
        let runtime = Path::new("/Applications/Workbuddy-Switch2.app/Contents/Resources/runtime");
        let custom = Settings {
            binary_path: "/opt/workbuddy-custom/bin/custom-proxy-engine".into(),
            plugin_path: "/opt/workbuddy-custom/lib/custom-provider.dylib".into(),
            port: 9876,
        };
        assert!(rebind_bundled_runtime(&custom, runtime).is_none());
    }
}
