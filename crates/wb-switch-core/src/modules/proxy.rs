//! Desktop-owned CLIProxyAPI process and additive account bridge.
use super::{account, config};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

static REFRESH_LEASE: Mutex<Option<fs::File>> = Mutex::new(None);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static LAST_EXIT: Mutex<Option<String>> = Mutex::new(None);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub binary_path: String,
    pub plugin_path: String,
    pub port: u16,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            binary_path: String::new(),
            plugin_path: String::new(),
            port: 8317,
        }
    }
}
fn root() -> PathBuf {
    config::store_dir().join("proxy")
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn private_dir(path: &Path) -> Result<(), String> {
    config::private_directory(path).map_err(err)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(err)?;
    f.write_all(bytes).map_err(err)?;
    f.sync_all().map_err(err)
}
fn atomic_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    write_new(&tmp, bytes)?;
    // Windows cannot atomically replace an existing file with std::fs::rename.
    #[cfg(windows)]
    if path.exists() {
        return Err("Windows 首版请使用新的代理配置目录；不覆盖已有配置".into());
    }
    fs::rename(&tmp, path).map_err(err)
}
pub fn settings() -> Result<Settings, String> {
    match fs::read(root().join("settings.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "代理配置格式错误".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(err(e)),
    }
}
fn running(child: &mut Option<Child>) -> Result<bool, String> {
    if let Some(c) = child.as_mut() {
        match c.try_wait().map_err(err)? {
            None => return Ok(true),
            Some(exit) => {
                *LAST_EXIT.lock().map_err(err)? =
                    Some(format!("代理引擎退出（{exit}）。请检查引擎与插件兼容性。"))
            }
        }
        *child = None;
        *REFRESH_LEASE.lock().map_err(err)? = None;
    }
    Ok(false)
}
fn validate(s: &Settings) -> Result<(), String> {
    if s.port < 1024 {
        return Err("端口须在 1024–65535 之间".into());
    }
    for p in [&s.binary_path, &s.plugin_path] {
        let path = Path::new(p);
        if !path.is_absolute() || !path.is_file() {
            return Err("请选择已安装引擎和插件的绝对文件路径".into());
        }
    }
    let ext = if cfg!(target_os = "macos") {
        "dylib"
    } else if cfg!(windows) {
        "dll"
    } else {
        "so"
    };
    // Upstream Go c-shared builds use .so on macOS too.
    if Path::new(&s.plugin_path)
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| s != ext && !(cfg!(target_os = "macos") && s == "so"))
    {
        return Err("插件文件类型不匹配当前平台".into());
    }
    trusted_bytes(&s.binary_path, "engine")?;
    trusted_bytes(&s.plugin_path, "plugin")?;
    Ok(())
}
fn trusted_bytes(path: &str, kind: &str) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(err)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let manifest: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../runtime.manifest.json"
    )))
    .map_err(err)?;
    if !manifest[kind]
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v.as_str() == Some(&digest)))
    {
        return Err("运行时校验失败：请选择此版本随附的引擎与插件；文件可能已变化".into());
    }
    Ok(bytes)
}

/// Exclusive ownership shared with desktop refresh and separate app processes.
pub fn refresh_lease() -> Result<fs::File, String> {
    use fs2::FileExt;
    private_dir(&root())?;
    let path = root().join("refresh.lock");
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("拒绝符号链接锁文件".into());
    }
    let mut opts = fs::OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path).map_err(err)?;
    file.try_lock_exclusive()
        .map_err(|_| "凭据刷新正由其他操作或代理服务管理，请稍后重试".to_string())?;
    Ok(file)
}

pub fn latest_proxy_credentials(acc: &Value) -> Result<Option<Value>, String> {
    let Ok((name, _)) = convert(acc) else {
        return Ok(None);
    };
    let path = root().join("auths").join(name);
    if !path.exists() {
        return Ok(None);
    }
    config::private_file(&path).map_err(err)?;
    let value: Value =
        serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(|_| "代理凭据尚未就绪")?;
    let auth = &value["auth"];
    let exp = config::norm_ts(auth.get("expiresAt")).unwrap_or(0);
    if exp < config::norm_ts(acc.get("expiresAt")).unwrap_or(0) {
        return Ok(None);
    }
    let mut next = acc.clone();
    for (target, source) in [
        ("access_token", "accessToken"),
        ("refresh_token", "refreshToken"),
    ] {
        let token = auth[source]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("代理凭据缺失")?;
        next[target] = json!(token);
    }
    next["expiresAt"] = json!(exp);
    Ok(Some(next))
}

fn reconcile_pool() -> Result<(), String> {
    for mut acc in account::load_accounts_checked()? {
        // Start/stop holds the refresh lease, so recover an interrupted desktop
        // rotation before handing credentials back to the engine.
        super::refresh::recover_pending_refresh(&mut acc)?;
        let Ok((name, _)) = convert(&acc) else {
            continue;
        };
        let path = root().join("auths").join(name);
        if !path.exists() {
            continue;
        }
        let newest = latest_proxy_credentials(&acc)?.unwrap_or_else(|| acc.clone());
        if newest["access_token"] != acc["access_token"]
            || newest["refresh_token"] != acc["refresh_token"]
        {
            account::upsert_account(&newest).map_err(err)?;
        }
        let mut next: Value =
            serde_json::from_slice(&fs::read(&path).map_err(err)?).map_err(err)?;
        let (_, converted) = convert(&newest)?;
        // Preserve provider metadata and disabled/cooldown state.
        next["auth"] = converted["auth"].clone();
        atomic_private(&path, &serde_json::to_vec_pretty(&next).map_err(err)?)?;
    }
    Ok(())
}

pub fn rotate_client_key() -> Result<(), String> {
    let mut child = CHILD.lock().map_err(err)?;
    if running(&mut child)? {
        return Err("请先停止 API 服务，再轮换密钥".into());
    }
    let _lease = refresh_lease()?;
    private_dir(&root())?;
    let key = format!(
        "wb-{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    atomic_private(&root().join("client-key"), key.as_bytes())
}
pub fn save_settings(s: Settings) -> Result<(), String> {
    let mut child = CHILD.lock().map_err(err)?;
    if running(&mut child)? {
        return Err("请先停止 API 服务，再修改配置".into());
    }
    validate(&s)?;
    private_dir(&root())?;
    atomic_private(
        &root().join("settings.json"),
        &serde_json::to_vec_pretty(&s).map_err(err)?,
    )
}
fn key_at(dir: &Path) -> Result<String, String> {
    let path = dir.join("client-key");
    match fs::read_to_string(&path) {
        Ok(s) if s.trim().len() >= 32 => Ok(s.trim().into()),
        Ok(_) => Err("本地 API 密钥文件无效".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            private_dir(dir)?;
            let s = format!(
                "wb-{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            write_new(&path, s.as_bytes())?;
            Ok(s)
        }
        Err(e) => Err(err(e)),
    }
}
pub fn client_key() -> Result<String, String> {
    let _guard = CHILD.lock().map_err(err)?;
    key_at(&root())
}
fn yaml(s: &str) -> String {
    serde_json::to_string(s).expect("string serializes")
}
pub fn render_config(s: &Settings, dir: &Path, key: &str) -> String {
    format!("host: 127.0.0.1\nport: {}\nauth-dir: {}\napi-keys:\n  - {}\nremote-management:\n  allow-remote: false\n  secret-key: \"\"\n  disable-control-panel: true\nlogging-to-file: false\nrequest-log: false\nerror-logs-max-files: 0\nplugins:\n  enabled: true\n  dir: {}\n  configs:\n    workbuddy:\n      enabled: true\n      checkin_auto: false\n      lifecycle_auto: false\n      daily_bonus: false\n      token_keepalive: false\n      mm_live_reload: false\n", s.port, yaml(&dir.join("auths").to_string_lossy()), yaml(key), yaml(&dir.join("plugins").to_string_lossy()))
}
pub fn start() -> Result<Value, String> {
    let mut child = CHILD.lock().map_err(err)?;
    if running(&mut child)? {
        return Err("API 服务已经运行".into());
    }
    let s = settings()?;
    validate(&s)?;
    let port = TcpListener::bind(("127.0.0.1", s.port))
        .map_err(|_| "端口已占用，请修改端口；不会停止其他进程".to_string())?;
    let dir = root();
    for p in [&dir, &dir.join("plugins"), &dir.join("auths")] {
        private_dir(p)?;
    }
    let lease = refresh_lease()?;
    reconcile_pool()?;
    let plugin = trusted_bytes(&s.plugin_path, "plugin")?;
    let engine = trusted_bytes(&s.binary_path, "engine")?;
    let engine_path = dir.join("engine-verified");
    atomic_private(&engine_path, &engine)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&engine_path, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    let suffix = Path::new(&s.plugin_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("so");
    let target = dir.join("plugins").join(format!("workbuddy.{suffix}"));
    atomic_private(&target, &plugin)?;
    let key = key_at(&dir)?;
    let config = dir.join("config.yaml");
    atomic_private(&config, render_config(&s, &dir, &key).as_bytes())?;
    drop(port);
    // Keep the refresh ownership lock alive in the engine after an unexpected
    // desktop exit. Clear CLOEXEC only for the short spawn window.
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::fcntl(lease.as_raw_fd(), libc::F_SETFD, 0) } == -1 {
            return Err("无法传递刷新锁".into());
        }
    }
    let spawned = Command::new(&engine_path)
        .args(["--config", &config.to_string_lossy(), "--local-model"])
        .current_dir(&dir)
        .env("TZ", "Asia/Shanghai")
        .env_remove("MANAGEMENT_PASSWORD")
        .env_remove("USAGE_REPORT_URL")
        .env_remove("USAGE_REPORT_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::fcntl(lease.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            if let Ok(mut child) = spawned {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err("无法恢复刷新锁描述符保护".into());
        }
    }
    let c =
        spawned.map_err(|_| "无法启动引擎，请检查可执行权限、平台架构和引擎版本".to_string())?;
    *LAST_EXIT.lock().map_err(err)? = None;
    let pid = c.id();
    *child = Some(c);
    *REFRESH_LEASE.lock().map_err(err)? = Some(lease);
    Ok(json!({"pid":pid,"state":"starting"}))
}
pub fn stop() -> Result<(), String> {
    let mut child = CHILD.lock().map_err(err)?;
    if !running(&mut child)? {
        return Ok(());
    }
    if let Some(c) = child.as_mut() {
        c.kill().map_err(err)?;
        c.wait().map_err(err)?;
    }
    *child = None;
    let result = reconcile_pool();
    *REFRESH_LEASE.lock().map_err(err)? = None;
    result
}
pub fn status() -> Result<Value, String> {
    let mut child = CHILD.lock().map_err(err)?;
    let alive = running(&mut child)?;
    let s = settings()?;
    let count = fs::read_dir(root().join("auths"))
        .map(|v| {
            v.flatten()
                .filter(|e| e.path().extension().is_some_and(|s| s == "json"))
                .count()
        })
        .unwrap_or(0);
    Ok(
        json!({"running":alive,"pid":child.as_ref().map(Child::id),"baseUrl":format!("http://127.0.0.1:{}/v1",s.port),"syncedAccounts":count,"pool":pool()?,"lastError":LAST_EXIT.lock().map_err(err)?.clone(),"settings":s}),
    )
}

/// Convert only plaintext OAuth records. Encrypted desktop envelopes are not API credentials.
pub fn convert(acc: &Value) -> Result<(String, Value), String> {
    let string = |key: &str| account::get_str(acc, key).filter(|s| !s.trim().is_empty());
    let uid = string("uid").ok_or("缺少账号 UID")?;
    let token = string("access_token").ok_or("登录凭据为加密信封或为空，请使用 OAuth 重新登录")?;
    let refresh = string("refresh_token").ok_or("缺少可用刷新凭据，请使用 OAuth 重新登录")?;
    let realm = account::variant_of(acc).as_str();
    let fallback = if realm == "ai" {
        "www.codebuddy.ai"
    } else {
        "www.codebuddy.cn"
    };
    let domain = string("domain").unwrap_or(fallback.into());
    let accepted = [
        "www.codebuddy.cn",
        "copilot.tencent.com",
        "www.codebuddy.ai",
        "www.workbuddy.ai",
        "codebuddy.cn",
        "codebuddy.ai",
        "workbuddy.ai",
    ];
    if !accepted.contains(&domain.as_str()) {
        return Err("账号域名不在支持列表，请重新 OAuth 登录".into());
    }
    let intl = domain.ends_with(".ai");
    if intl != (realm == "ai") {
        return Err("账号地区与认证域名不一致".into());
    }
    let exp = acc.get("expiresAt").and_then(Value::as_i64).unwrap_or(0);
    let exp = if exp > 10_000_000_000 {
        exp / 1000
    } else {
        exp
    };
    let digest = format!("{:x}", Sha256::digest(format!("{realm}:{uid}").as_bytes()));
    let name = format!("workbuddy-{realm}-{}.json", &digest[..24]);
    Ok((
        name,
        json!({"type":"workbuddy", "auth": {"accessToken":token,"refreshToken":refresh,"expiresAt":exp,"domain":domain},"account":{"uid":uid,"nickname":string("nickname").unwrap_or_default(),"enterpriseId":account::enterprise_id_of(acc).unwrap_or_default()}}),
    ))
}
pub fn preview() -> Vec<Value> {
    account::load_accounts().iter().map(|a| {
        let converted = convert(a);
        let exists = converted.as_ref().map(|(n,_)|root().join("auths").join(n).exists()).unwrap_or(false);
        json!({"id":account::get_str(a,"id").unwrap_or_default(),"name":account::account_display_name(a),"realm":account::variant_of(a).as_str(),"eligible":converted.is_ok(),"synced":exists,"reason":converted.err()})
    }).collect()
}
pub fn sync(ids: Vec<String>) -> Result<Value, String> {
    sync_with_replace(ids, false)
}
pub fn sync_with_replace(ids: Vec<String>, replace: bool) -> Result<Value, String> {
    let mut child = CHILD.lock().map_err(err)?;
    if running(&mut child)? {
        return Err("请先停止 API 服务，再同步账号".into());
    }
    if ids.is_empty() {
        return Err("请先选择账号".into());
    }
    let _lease = refresh_lease()?;
    let accounts = account::load_accounts_checked()?;
    // Validate the entire batch before touching disk.
    let mut converted = Vec::new();
    for id in ids.iter().collect::<std::collections::BTreeSet<_>>() {
        let a = accounts
            .iter()
            .find(|a| a.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .ok_or("所选账号不存在")?;
        converted.push(convert(a)?);
    }
    let dir = root().join("auths");
    private_dir(&root())?;
    private_dir(&dir)?;
    let mut added = 0;
    let mut updated = 0;
    let mut skipped = 0;
    for (name, mut value) in converted {
        let path = dir.join(name);
        if path.exists() {
            if !replace {
                skipped += 1;
                continue;
            }
            config::private_file(&path).map_err(err)?;
            let old: Value = serde_json::from_slice(&fs::read(&path).map_err(err)?).map_err(err)?;
            value["disabled"] = json!(old["disabled"] == true);
            atomic_private(&path, &serde_json::to_vec_pretty(&value).map_err(err)?)?;
            updated += 1;
            continue;
        }
        write_new(&path, &serde_json::to_vec_pretty(&value).map_err(err)?)?;
        added += 1;
    }
    Ok(json!({"added":added,"updated":updated,"skipped":skipped}))
}
pub async fn models() -> Result<Value, String> {
    if status()?["running"] != true {
        return Err("请先启动 API 服务".into());
    }
    let s = settings()?;
    let key = client_key()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(err)?;
    let response = client
        .get(format!("http://127.0.0.1:{}/v1/models", s.port))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "引擎尚未就绪或无法连接".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "引擎返回 HTTP {}，请检查插件与账号",
            response.status().as_u16()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "引擎返回的模型列表无效".to_string())?;
    let list = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or("引擎返回的模型列表无效")?;
    Ok(
        json!({"data":list.iter().filter_map(|v| v.get("id").and_then(Value::as_str)).collect::<Vec<_>>()}),
    )
}

/// A user-triggered, bounded inference probe; credentials stay in the backend.
pub async fn test_model(model: String) -> Result<Value, String> {
    let model = model.trim();
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err("请选择有效的模型名称".into());
    }
    if status()?["running"] != true {
        return Err("请先启动 API 服务".into());
    }
    let port = settings()?.port;
    probe_model(port, &client_key()?, model).await
}

async fn probe_model(port: u16, key: &str, model: &str) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(err)?;
    let mut response = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth(key)
        .json(&json!({
            "model":model, "messages":[{"role":"user","content":"Reply with only OK."}],
            "stream":false, "max_tokens":32
        }))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "测试等待超过 60 秒；上游可能仍在处理，请稍后再试".to_string()
            } else {
                "无法连接本地 API 服务，请检查服务状态".to_string()
            }
        })?;
    if !response.status().is_success() {
        let code = response.status().as_u16();
        let hint = match code {
            401 | 403 => "鉴权失败或账号无模型权限",
            404 => "模型或接口不存在，请重新读取模型列表",
            429 => "请求受限或额度不足，请检查账号积分",
            500..=599 => "代理或上游服务异常，请检查账号、插件和网络",
            _ => "请求未被接受，该模型可能不支持此测试请求",
        };
        return Err(format!("HTTP {code}：{hint}"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "响应读取失败或超时")? {
        if bytes.len() + chunk.len() > 65536 {
            return Err("测试响应过大，已停止读取".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "服务返回的不是有效 JSON 响应")?;
    let reply = probe_reply(&body)?;
    Ok(json!({"model":model,"reply":reply,"elapsedMs":started.elapsed().as_millis()}))
}

fn probe_reply(body: &Value) -> Result<String, String> {
    let reply = body
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("接口已响应，但未返回有效文本，尚不能确认模型可用")?;
    Ok(reply.chars().take(512).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inference_probe_requires_actual_text() {
        assert_eq!(
            probe_reply(&json!({"choices":[{"message":{"content":"OK"}}]})).unwrap(),
            "OK"
        );
        assert!(probe_reply(&json!({"data":[]})).is_err());
        assert!(probe_reply(&json!({"choices":[{"message":{"content":""}}]})).is_err());
        assert!(probe_reply(&json!({"error":{"message":"failure"}})).is_err());
        assert_eq!(
            probe_reply(&json!({"choices":[{"message":{"content":"猫".repeat(700)}}]}))
                .unwrap()
                .chars()
                .count(),
            512
        );
    }
    #[tokio::test]
    async fn inference_probe_checks_http_and_completion() {
        use std::io::Read;
        for (code, body, expected) in [
            (200, r#"{"choices":[{"message":{"content":"OK"}}]}"#, None),
            (
                401,
                r#"{"error":{"message":"private upstream detail"}}"#,
                Some("HTTP 401"),
            ),
            (200, r#"{"choices":[]}"#, Some("未返回有效文本")),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0u8; 2048];
                loop {
                    let n = socket.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            assert!(headers.starts_with("post /v1/chat/completions "));
                            assert!(headers.contains("authorization: bearer test-only"));
                            let request: Value = serde_json::from_slice(&bytes[end + 4..]).unwrap();
                            assert_eq!(request["model"], "test-model");
                            assert_eq!(request["stream"], false);
                            assert_eq!(request["max_tokens"], 32);
                            break;
                        }
                    }
                }
                write!(socket,"HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            let result = probe_model(port, "test-only", "test-model").await;
            server.join().unwrap();
            if let Some(hint) = expected {
                let message = result.unwrap_err();
                assert!(message.contains(hint));
                assert!(!message.contains("private upstream detail"));
            } else {
                assert_eq!(result.unwrap()["reply"], "OK");
            }
        }
    }
    fn acc() -> Value {
        json!({"uid":"../user","access_token":"secret-access","refresh_token":"secret-refresh","variant":"cn","expiresAt":1_800_000_000_000i64})
    }
    #[test]
    fn maps_contract_without_path_traversal() {
        let (name, v) = convert(&acc()).unwrap();
        assert!(!name.contains('/'));
        assert_eq!(v["type"], "workbuddy");
        assert_eq!(v["auth"]["expiresAt"], 1_800_000_000);
        assert_eq!(v["account"]["uid"], "../user");
        assert!(v.get("access_token").is_none());
    }
    #[test]
    fn realms_do_not_collide() {
        let a = acc();
        let mut b = a.clone();
        b["variant"] = json!("ai");
        assert_ne!(convert(&a).unwrap().0, convert(&b).unwrap().0);
        assert_eq!(convert(&b).unwrap().1["auth"]["domain"], "www.codebuddy.ai");
    }
    #[test]
    fn refuses_encrypted_or_missing_credentials() {
        for key in ["access_token", "refresh_token"] {
            let mut a = acc();
            a[key] = json!({"$wbEncrypted":"data"});
            assert!(convert(&a).is_err());
        }
    }
    #[test]
    fn rejects_domain_mismatch_and_foreign_domain() {
        for domain in ["evil.example", "www.codebuddy.ai"] {
            let mut a = acc();
            a["domain"] = json!(domain);
            assert!(convert(&a).is_err());
        }
    }
    #[test]
    fn config_is_local_and_no_autonomous_rewards_or_deletion() {
        let s = Settings::default();
        let conf = render_config(&s, Path::new("/tmp/a\nb"), "test-key");
        assert!(conf.contains("host: 127.0.0.1"));
        assert!(conf.contains("lifecycle_auto: false"));
        assert!(conf.contains("daily_bonus: false"));
        assert!(conf.contains("secret-key: \"\""));
        assert!(conf.contains("/tmp/a\\nb/auths"));
    }
    #[test]
    fn private_key_and_no_overwrite() {
        let dir = std::env::temp_dir().join(format!("wbproxy-test-{}", uuid::Uuid::new_v4()));
        private_dir(&dir).unwrap();
        let key = key_at(&dir).unwrap();
        assert_eq!(key, key_at(&dir).unwrap());
        assert!(write_new(&dir.join("client-key"), b"replaced").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.join("client-key"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
}

fn pool() -> Result<Vec<Value>, String> {
    let dir = root().join("auths");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut list = Vec::new();
    for entry in fs::read_dir(&dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry.file_type().map_err(err)?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !valid_name(&name) {
            continue;
        }
        let value: Value = serde_json::from_slice(&fs::read(entry.path()).map_err(err)?)
            .map_err(|_| "代理账号文件无效")?;
        list.push(json!({"name":name,"label":value["account"]["nickname"].as_str().filter(|s|!s.is_empty()).unwrap_or("未命名账号"),"enabled":value["disabled"]!=true}));
    }
    list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(list)
}
fn valid_name(name: &str) -> bool {
    name.starts_with("workbuddy-")
        && name.ends_with(".json")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        && !name.contains("..")
}
pub fn set_enabled(name: &str, enabled: bool) -> Result<(), String> {
    let mut child = CHILD.lock().map_err(err)?;
    if running(&mut child)? {
        return Err("请先停止 API 服务，再修改账号池".into());
    }
    if !valid_name(name) {
        return Err("无效账号标识".into());
    }
    let path = root().join("auths").join(name);
    if fs::symlink_metadata(&path)
        .map_err(err)?
        .file_type()
        .is_symlink()
    {
        return Err("不支持符号链接账号文件".into());
    }
    let mut value: Value =
        serde_json::from_slice(&fs::read(&path).map_err(err)?).map_err(|_| "代理账号文件无效")?;
    value
        .as_object_mut()
        .ok_or("代理账号文件无效")?
        .insert("disabled".into(), json!(!enabled));
    atomic_private(&path, &serde_json::to_vec_pretty(&value).map_err(err)?)
}
