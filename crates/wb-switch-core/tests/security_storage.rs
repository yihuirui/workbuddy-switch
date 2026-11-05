use serde_json::json;
use std::{fs, path::Path, sync::Arc};
use wb_switch_core::modules::{account, config, export_import, proxy};

#[test]
fn private_transactional_storage_survives_failures_and_regions() {
    let home = std::env::temp_dir().join(format!("wb-storage-security-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&home).unwrap();
    std::env::set_var("WB_SWITCH_HOME", &home);
    let records = json!([{"id":"cn-1","uid":"same","variant":"cn","access_token":"synthetic","refresh_token":"synthetic"}]);
    export_import::import_accounts(&records.to_string(), &[0]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(config::accounts_file(), fs::Permissions::from_mode(0o644)).unwrap();
        export_import::import_accounts(&records.to_string(), &[0]).unwrap();
        assert_eq!(
            fs::metadata(config::accounts_file())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(config::store_dir())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    export_import::import_accounts(
        &json!([{"id":"cn-1","uid":"same","variant":"ai","access_token":"synthetic-ai"}])
            .to_string(),
        &[0],
    )
    .unwrap();
    let accounts = account::load_accounts_checked().unwrap();
    assert_eq!(accounts.len(), 2);
    assert_ne!(accounts[0]["id"], accounts[1]["id"]);
    assert!(account::find_account("same").is_none()); // ambiguous legacy UID
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let threads:Vec<_>=(0..8).map(|i| {let b=barrier.clone();std::thread::spawn(move||{
        b.wait();account::save_collected_account(json!({"id":format!("id-{i}"),"uid":format!("uid-{i}"),"variant":"cn","access_token":"synthetic"})).unwrap();
    })}).collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(account::load_accounts_checked().unwrap().len(), 10);
    let backup = config::store_dir().join("accounts.last-good.json");
    assert!(
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&backup).unwrap())
            .unwrap()
            .is_array()
    );
    fs::write(config::accounts_file(), "[broken").unwrap();
    assert!(account::load_accounts_checked().is_err());
    assert!(export_import::import_accounts(&records.to_string(), &[0]).is_err());
    assert!(account::save_accounts(&[]).is_err());
    assert_eq!(
        fs::read_to_string(config::accounts_file()).unwrap(),
        "[broken"
    );
    account::restore_last_good().unwrap();
    assert!(!account::load_accounts_checked().unwrap().is_empty());
    assert!(fs::read_dir(config::store_dir())
        .unwrap()
        .flatten()
        .any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("accounts.corrupt-")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let external = home.join("external");
        fs::write(&external, "keep").unwrap();
        let link = home.join("linked");
        symlink(&external, &link).unwrap();
        assert!(config::atomic_write(&link, "replace").is_err());
        assert_eq!(fs::read_to_string(external).unwrap(), "keep");
    }
    let key = proxy::client_key().unwrap();
    proxy::rotate_client_key().unwrap();
    assert_ne!(key, proxy::client_key().unwrap());
    assert!(proxy::save_settings(proxy::Settings {
        binary_path: home.join("unknown").to_string_lossy().into(),
        plugin_path: home.join("bad.so").to_string_lossy().into(),
        port: 8317
    })
    .is_err());
    assert!(Path::new(&home).exists());
    fs::remove_dir_all(home).unwrap();
}
