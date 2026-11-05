//! All operations use a dedicated home; never inspect workstation accounts.
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use wb_switch_core::modules::{config, proxy};
struct Sandbox(PathBuf);
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = proxy::stop();
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn additive_sync_preserves_refreshed_credentials_and_disable_state() {
    let tmp =
        Sandbox(std::env::temp_dir().join(format!("wbproxy-bridge-{}", uuid::Uuid::new_v4())));
    std::env::set_var("WB_SWITCH_HOME", &tmp.0);
    fs::create_dir_all(config::store_dir()).unwrap();
    let a = json!({"id":"selected","uid":"u1","variant":"cn","nickname":"Test only","access_token":"original-token","refresh_token":"test-refresh","expiresAt":1800000000000i64});
    let mut b = a.clone();
    b["id"] = json!("unselected");
    b["uid"] = json!("u2");
    fs::write(
        config::accounts_file(),
        serde_json::to_vec(&json!([a, b])).unwrap(),
    )
    .unwrap();
    assert!(proxy::sync(vec!["missing".into()]).is_err());
    assert_eq!(proxy::sync(vec!["selected".into()]).unwrap()["added"], 1);
    let dir = config::store_dir().join("proxy/auths");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    let path = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
    let mut stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    stored["auth"]["accessToken"] = json!("refreshed-token");
    stored["disabled"] = json!(true);
    fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert_eq!(proxy::sync(vec!["selected".into()]).unwrap()["skipped"], 1);
    let after: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(after, stored);
    proxy::stop().unwrap(); // No owned process: leave the independent pool unchanged.
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
        stored
    );
    let public = serde_json::to_string(&proxy::status().unwrap()).unwrap();
    assert!(
        !public.contains("original-token")
            && !public.contains("refreshed-token")
            && !public.contains("test-refresh")
    );
    let name = path.file_name().unwrap().to_str().unwrap();
    proxy::set_enabled(name, true).unwrap();
    let toggled: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(toggled["disabled"], false);
    assert_eq!(toggled["auth"], stored["auth"]);
    proxy::set_enabled(name, false).unwrap();
    assert_eq!(
        proxy::sync_with_replace(vec!["selected".into()], true).unwrap()["updated"],
        1
    );
    let replaced: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(replaced["auth"]["accessToken"], "original-token");
    assert_eq!(replaced["disabled"], true);
    assert!(proxy::set_enabled("../accounts.json", false).is_err());
    assert!(proxy::set_enabled("workbuddy-../../escape.json", false).is_err());
    assert!(!serde_json::to_string(&proxy::preview())
        .unwrap()
        .contains("original-token"));
    let key = proxy::client_key().unwrap();
    assert_eq!(key, proxy::client_key().unwrap());
}
