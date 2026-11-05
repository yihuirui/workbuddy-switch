//! Real pinned runtime; empty isolated account pool, no upstream inference.
use std::{fs, net::TcpListener, path::PathBuf, time::Duration};
use wb_switch_core::modules::{config, proxy};
struct Sandbox(PathBuf);
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = proxy::stop();
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[tokio::test]
#[ignore = "Requires the pinned runtime; the preview build workflow runs this after fetching it."]
async fn verified_runtime_requires_key_and_holds_refresh_ownership() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if !root.join("runtime/cli-proxy-api-wb").exists() {
        panic!("pinned runtime required for security acceptance");
    }
    let home =
        Sandbox(std::env::temp_dir().join(format!("wb-secure-runtime-{}", uuid::Uuid::new_v4())));
    std::env::set_var("WB_SWITCH_HOME", &home.0);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let settings = proxy::Settings {
        binary_path: root
            .join("runtime/cli-proxy-api-wb")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into(),
        plugin_path: root
            .join("runtime/workbuddy.dylib")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into(),
        port,
    };
    fs::create_dir_all(&home.0).unwrap();
    let tampered = home.0.join("tampered.dylib");
    fs::write(&tampered, "not a trusted library").unwrap();
    let bad = proxy::Settings {
        plugin_path: tampered.to_string_lossy().into(),
        ..settings.clone()
    };
    assert!(proxy::save_settings(bad).unwrap_err().contains("校验失败"));
    proxy::save_settings(settings).unwrap();
    let started = proxy::start().unwrap();
    #[cfg(target_os = "macos")]
    {
        let pid = started["pid"].as_u64().unwrap().to_string();
        let files = std::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid, "-Fn"])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&files.stdout).contains("/proxy/refresh.lock"),
            "engine must inherit the refresh ownership descriptor"
        );
    }
    assert!(proxy::refresh_lease().is_err());
    assert!(proxy::rotate_client_key().is_err());
    let key = proxy::client_key().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let mut ready = false;
    for _ in 0..40 {
        if let Ok(response) = client
            .get(format!("{base}/v1/models"))
            .bearer_auth(&key)
            .send()
            .await
        {
            if response.status().is_success() {
                ready = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(ready, "engine did not become ready");
    assert_eq!(
        client
            .get(format!("{base}/v1/models"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/models"))
            .bearer_auth("invalid")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .get(format!("{base}/v0/management/config"))
            .bearer_auth(&key)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        fs::read_dir(config::store_dir().join("proxy/auths"))
            .unwrap()
            .count(),
        0
    );
    proxy::stop().unwrap();
    assert!(proxy::refresh_lease().is_ok());
}
