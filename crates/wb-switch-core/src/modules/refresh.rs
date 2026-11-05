//! Token 刷新与保活。
//!
//! 对照 server.py `refresh_account_token` / `ensure_fresh_token` /
//! `run_keepalive_cycle`。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use crate::modules::account::build_auth_headers;
use crate::modules::config::{http_request, load_checkin_config, norm_ts, now_ms, RunFlagGuard};

static REFRESH_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static KEEPALIVE_RUNNING: AtomicBool = AtomicBool::new(false);

/// 刷新接口 URL：域名与路径前缀都按账号自身档位选（缺档位字段 → 国内版，零回归）。
fn refresh_url(account: &Value) -> String {
    let variant = crate::modules::account::variant_of(account);
    format!(
        "{}{}/auth/token/refresh",
        variant.api_endpoint(),
        variant.api_prefix()
    )
}

/// 构造刷新请求头：鉴权头 + 刷新会话头。
///
/// `X-Auth-Refresh-Source: plugin` 必须保留：两个档位的官方客户端刷新时都发送该头，
/// 缺失时网关会把这次刷新判定成另一个 client 来源，国际版实测返回
/// `invalid_grant: Invalid refresh token`（code 12153）。抽成纯函数是为了让单测
/// 能把这个头固定住，避免将来被顺手删掉。
fn refresh_headers(account: &Value, refresh_token: &str) -> HashMap<String, String> {
    let mut headers = build_auth_headers(account);
    headers.insert("X-Refresh-Token".to_string(), refresh_token.to_string());
    headers.insert("X-Auth-Refresh-Source".to_string(), "plugin".to_string());
    headers
}

/// 刷新单账号 token（POST /v2/plugin/auth/token/refresh），成功则落盘并返回新账号。
///
/// 刷新失败（refresh token 失效等）时给账号标记 needs_relogin，避免无限重试。
pub async fn refresh_account_token(mut account: Value) -> Value {
    let _gate = REFRESH_GATE.lock().await;
    let supplied_token = account.get("access_token").cloned();
    if let Some(id) = crate::modules::account::get_str(&account, "id") {
        match crate::modules::account::load_accounts_checked() {
            Ok(accounts) => {
                if let Some(latest) = accounts.into_iter().find(|a| a["id"] == id) {
                    account = latest;
                    // A concurrent refresh already completed while this call waited.
                    if account.get("access_token") != supplied_token.as_ref() {
                        return account;
                    }
                }
            }
            Err(_) => {
                account["refresh_error"] = json!("账号库不可读，刷新已取消，避免丢失轮换凭据");
                return account;
            }
        }
    }
    if account
        .get("refresh_retry_at")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        > now_ms()
    {
        return account;
    }
    let _lease = match crate::modules::proxy::refresh_lease() {
        Ok(lease) => lease,
        Err(_) => {
            // The proxy owns refresh while it is alive. Read its latest token but
            // never rotate another copy concurrently.
            match crate::modules::proxy::latest_proxy_credentials(&account) {
                Ok(Some(latest)) => return latest,
                _ => {
                    account["refresh_error"] =
                        json!("代理正在管理凭据刷新；请停止代理后重试桌面刷新");
                    return account;
                }
            }
        }
    };
    match recover_pending_refresh(&mut account) {
        Ok(true) => return account,
        Err(error) => {
            account["refresh_error"] = json!(error);
            return account;
        }
        Ok(false) => {}
    }
    if let Ok(Some(latest)) = crate::modules::proxy::latest_proxy_credentials(&account) {
        if latest["access_token"] != account["access_token"] {
            let previous = account["access_token"].as_str().unwrap_or("").to_string();
            account = latest;
            if save_refresh_fields(&account, &previous).is_err() {
                account["refresh_error"] = json!("代理凭据写回失败，请稍后重试");
            }
            return account;
        }
    }
    let previous_access_token = account
        .get("access_token")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let rt = account
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    if rt.is_empty() {
        account["needs_relogin"] = json!(true);
        account["needs_relogin_reason"] = json!("缺少 refresh token，无法刷新，需重新登录");
        persist_refresh(&mut account);
        return account;
    }

    let headers = refresh_headers(&account, &rt);
    // 刷新必须走账号自身档位的域名：把国际版 token 打到国内网关等于登录失效。
    let url = refresh_url(&account);
    let resp = http_request(&url, "POST", Some(json!({})), Some(&headers)).await;
    let code = resp.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 && code != 200 {
        apply_refresh_failure(&mut account, &resp, code);
        persist_refresh(&mut account);
        return account;
    }

    let data = resp.get("data").cloned().unwrap_or_else(|| json!({}));
    let new_at = data
        .get("accessToken")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("access_token").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let Some(new_at) = new_at else {
        account["refresh_error"] = json!("刷新响应缺少 accessToken，请稍后重试");
        account["refresh_retry_at"] = json!(now_ms() + 60_000);
        persist_refresh(&mut account);
        return account;
    };

    account["access_token"] = json!(new_at);
    if let Some(new_rt) = data
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("refresh_token").and_then(|v| v.as_str()))
    {
        account["refresh_token"] = json!(new_rt);
    }
    // 官方接口只返回相对 expiresIn（秒），需换算为绝对时间戳
    let new_exp = norm_ts(data.get("expiresAt").or_else(|| data.get("expires_at")));
    let new_exp = match new_exp {
        Some(v) => Some(v),
        None => data
            .get("expiresIn")
            .and_then(|v| v.as_i64())
            .map(|e| now_ms() + e * 1000),
    };
    if let Some(v) = new_exp {
        account["expiresAt"] = json!(v);
    }
    let fallback_rt_exp = norm_ts(
        account
            .get("auth_raw")
            .and_then(|a| a.get("refreshExpiresAt")),
    );
    let mut new_rt_exp = norm_ts(
        data.get("refreshExpiresAt")
            .or_else(|| data.get("refresh_expires_at")),
    );
    if new_rt_exp.is_none() {
        new_rt_exp = fallback_rt_exp;
    }
    let new_rt_exp = match new_rt_exp {
        Some(v) => Some(v),
        None => data
            .get("refreshExpiresIn")
            .and_then(|v| v.as_i64())
            .map(|e| now_ms() + e * 1000),
    };
    if let Some(v) = new_rt_exp {
        account["refreshExpiresAt"] = json!(v);
    }
    account["refreshedAt"] = json!(now_ms());
    let map = account.as_object_mut().unwrap();
    map.remove("needs_relogin");
    map.remove("needs_relogin_reason");
    map.remove("refresh_error");
    map.remove("refresh_retry_at");
    map.remove("refresh_failures");
    persist_rotated_refresh(&mut account, previous_access_token.as_deref().unwrap_or(""));
    // Windows 不执行 apiKeyHelper；当前 CLI 账号刷新后同步 settings env。
    // 同步失败不阻断 WorkBuddy 保活；状态接口会根据 settings 与账号库是否
    // 一致显示“待同步”，避免把认证配置错误混入账号数据。
    if cfg!(windows) {
        let _ = crate::modules::codebuddy_cli::sync_windows_env_for_account(
            &account,
            previous_access_token.as_deref(),
        );
    }
    account
}

fn save_refresh_fields(account: &Value, expected_token: &str) -> Result<(), String> {
    crate::modules::account::mutate_accounts(|accounts| {
        let current = accounts
            .iter_mut()
            .find(|a| {
                a["id"] == account["id"]
                    && crate::modules::account::variant_of(a)
                        == crate::modules::account::variant_of(account)
            })
            .ok_or("账号已删除，未写回凭据")?;
        if current["access_token"].as_str().unwrap_or("") != expected_token {
            return Err("账号授权已变化，未覆盖新凭据".into());
        }
        for key in [
            "access_token",
            "refresh_token",
            "expiresAt",
            "refreshExpiresAt",
            "refreshedAt",
            "needs_relogin",
            "needs_relogin_reason",
            "refresh_error",
            "refresh_retry_at",
            "refresh_failures",
        ] {
            if let Some(value) = account.get(key) {
                current[key] = value.clone();
            } else {
                current.as_object_mut().unwrap().remove(key);
            }
        }
        Ok(())
    })
}

fn persist_refresh(account: &mut Value) {
    if save_refresh_fields(account, account["access_token"].as_str().unwrap_or("")).is_err() {
        account["refresh_error"] = json!("账号状态保存失败，请检查账号库、磁盘与权限");
    }
}

fn recovery_path(account: &Value) -> std::path::PathBuf {
    let identity = format!(
        "{}:{}",
        crate::modules::account::variant_of(account).as_str(),
        account["id"]
    );
    crate::modules::config::store_dir().join(format!(
        "refresh-recovery-{:x}.json",
        Sha256::digest(identity.as_bytes())
    ))
}

fn token_digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn persist_rotated_refresh(account: &mut Value, previous_token: &str) {
    let path = recovery_path(account);
    // Journal a rotated credential before replacing the main store. Independent
    // account journals cannot overwrite one another after a disk failure.
    let journal = json!({"previous_access_sha256":token_digest(previous_token), "account":account});
    let saved = crate::modules::config::atomic_write(&path, &journal.to_string()).is_ok();
    if save_refresh_fields(account, previous_token).is_ok() {
        if saved {
            let _ = std::fs::remove_file(path);
        }
    } else {
        account["refresh_error"] = json!(if saved {
            "凭据保存失败；已保留私有恢复记录，下次刷新将先恢复，避免重复轮换"
        } else {
            "凭据保存失败且无法写入恢复记录，请检查磁盘与权限；可能需要重新授权"
        });
    }
}

pub(super) fn recover_pending_refresh(account: &mut Value) -> Result<bool, String> {
    let path = recovery_path(account);
    if !path.exists() {
        return Ok(false);
    }
    crate::modules::config::private_file(&path).map_err(|_| "凭据恢复记录不可读")?;
    let journal: Value =
        serde_json::from_slice(&std::fs::read(&path).map_err(|_| "凭据恢复记录不可读")?)
            .map_err(|_| "凭据恢复记录损坏，已暂停刷新")?;
    let pending = &journal["account"];
    if pending["id"] != account["id"]
        || crate::modules::account::variant_of(pending)
            != crate::modules::account::variant_of(account)
    {
        return Err("凭据恢复记录身份不符，已暂停刷新".into());
    }
    let token = account["access_token"].as_str().unwrap_or("");
    if journal["previous_access_sha256"] == token_digest(token) {
        let mut restored = account.clone();
        for key in [
            "access_token",
            "refresh_token",
            "expiresAt",
            "refreshExpiresAt",
            "refreshedAt",
        ] {
            if let Some(value) = pending.get(key) {
                restored[key] = value.clone();
            }
        }
        for key in [
            "needs_relogin",
            "needs_relogin_reason",
            "refresh_error",
            "refresh_retry_at",
            "refresh_failures",
        ] {
            restored.as_object_mut().unwrap().remove(key);
        }
        save_refresh_fields(&restored, token)?;
        *account = restored;
        std::fs::remove_file(path).map_err(|_| "凭据已恢复，但恢复记录清理失败")?;
        return Ok(true);
    }
    // Already persisted, or superseded by a new OAuth login: never overwrite it.
    std::fs::remove_file(path).map_err(|_| "过期凭据恢复记录清理失败")?;
    Ok(false)
}

fn apply_refresh_failure(account: &mut Value, response: &Value, code: i64) {
    let message = response
        .get("message")
        .or_else(|| response.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let permanent = code == 12153
        || response.get("error").and_then(Value::as_str) == Some("invalid_grant")
        || message.to_ascii_lowercase().contains("invalid_grant");
    if permanent {
        account["needs_relogin"] = json!(true);
        account["needs_relogin_reason"] = json!("上游已拒绝刷新授权，请重新登录");
    } else {
        let failures = account
            .get("refresh_failures")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1)
            .min(6);
        let delay = (30_000i64 * (1i64 << failures)).min(1_800_000);
        account["refresh_failures"] = json!(failures);
        account["refresh_retry_at"] = json!(now_ms() + delay);
        account["refresh_error"] = json!(format!(
            "临时刷新失败（code={code}），请稍后重试（已启用退避保护）"
        ));
    }
}

/// 惰性刷新：expiresAt 缺失或剩余 < lazy_refresh_hours 则刷新。返回最新账号。
pub async fn ensure_fresh_token(mut account: Value, cfg: &Value) -> Value {
    let lazy_h = cfg
        .get("lazy_refresh_hours")
        .and_then(|v| v.as_i64())
        .unwrap_or(24);
    let exp = account.get("expiresAt").and_then(|v| v.as_i64());
    let stale = match exp {
        Some(e) => now_ms() >= e || e - now_ms() < lazy_h * 3600 * 1000,
        None => true,
    };
    let has_rt = !account
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty();
    if stale && has_rt {
        account = refresh_account_token(account).await;
    }
    account
}

/// 保活检查：每天由后台循环调用一次，默认（keepalive_days <= 0）无条件刷新
/// 全部带 refresh token 的账号；keepalive_days > 0 时仅刷新剩余不足该天数的账号。
///
/// 高频保活是为了避免官方服务端清理闲置的 refresh 会话——曾出现闲置数天后
/// 刷新返回 12153 invalid_grant（Session doesn't have required client）导致
/// 账号被迫重新登录。
pub async fn run_keepalive_cycle() -> Value {
    let Some(_guard) = RunFlagGuard::try_acquire(&KEEPALIVE_RUNNING) else {
        return json!({"skipped": "already_running"});
    };
    let cfg = load_checkin_config();
    let keep_days = cfg
        .get("keepalive_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let accounts = crate::modules::account::load_accounts();
    let total = accounts.len();
    let mut results: Vec<Value> = Vec::new();
    for mut acc in accounts {
        let exp = acc.get("expiresAt").and_then(|v| v.as_i64());
        let stale = keep_days <= 0
            || match exp {
                Some(e) => now_ms() >= e || e - now_ms() < keep_days * 24 * 3600 * 1000,
                None => true,
            };
        if !stale {
            continue;
        }
        if acc
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            acc["needs_relogin"] = json!(true);
            acc["needs_relogin_reason"] = json!("缺少 refresh token，无法保活，需重新登录");
            persist_refresh(&mut acc);
            results.push(json!({
                "email": crate::modules::account::account_display_name(&acc),
                "status": "missing_rt",
            }));
            continue;
        }
        let fresh = refresh_account_token(acc).await;
        let failed = fresh.get("needs_relogin").and_then(|v| v.as_bool()) == Some(true)
            || fresh.get("refresh_error").is_some();
        results.push(json!({
            "email": crate::modules::account::account_display_name(&fresh),
            "status": if failed { "failed" } else { "ok" },
            "error": if failed {
                fresh.get("refresh_error").or_else(|| fresh.get("needs_relogin_reason")).and_then(|v| v.as_str()).map(|s| s.to_string())
            } else {
                None
            },
        }));
    }
    json!({"checked": total, "refreshed": results})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_url_follows_account_variant() {
        // 旧账号（无档位字段）→ 国内版，与改造前逐字一致。
        assert_eq!(
            refresh_url(&json!({"uid": "u-1"})),
            format!(
                "{}/v2/plugin/auth/token/refresh",
                crate::modules::variant::WbVariant::Cn.api_endpoint()
            )
        );
        assert_eq!(
            refresh_url(&json!({"uid": "u-1", "access_token": "t"})),
            "https://www.codebuddy.cn/v2/plugin/auth/token/refresh"
        );
        // 国际版账号 → 国际版域名。
        assert_eq!(
            refresh_url(&json!({"uid": "u-2", "variant": "ai"})),
            format!(
                "{}/v2/plugin/auth/token/refresh",
                crate::modules::variant::WbVariant::Ai.api_endpoint()
            )
        );
        assert_ne!(
            refresh_url(&json!({"variant": "ai"})),
            refresh_url(&json!({"variant": "cn"}))
        );
    }

    /// AC11：刷新请求头必须带 `X-Auth-Refresh-Source: plugin`，两个档位都覆盖。
    ///
    /// 断言为 `Some("plugin")`：头被删掉时为 `None`，用例立即失败，不会被写成恒真。
    #[test]
    fn refresh_headers_always_declare_plugin_refresh_source() {
        let cases = [
            // 国内版：旧账号（无档位字段）与显式档位各一例。
            json!({"uid": "u-cn", "access_token": "at", "refresh_token": "rt"}),
            json!({"uid": "u-cn", "access_token": "at", "variant": "cn"}),
            // 国际版：D1 的失败现场。
            json!({"uid": "u-ai", "access_token": "at", "variant": "ai"}),
        ];
        for account in cases {
            let headers = refresh_headers(&account, "rt-value");
            assert_eq!(
                headers.get("X-Auth-Refresh-Source").map(String::as_str),
                Some("plugin"),
                "刷新请求头缺少 X-Auth-Refresh-Source: plugin（{account}）"
            );
            // 刷新会话头不能被这次改动挤掉。
            assert_eq!(
                headers.get("X-Refresh-Token").map(String::as_str),
                Some("rt-value")
            );
            // 刷新不带 platform 查询参数/头：官方刷新同样不带（research §2 已推翻旧假设）。
            assert!(!headers.contains_key("platform"));
        }
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    #[test]
    fn transient_errors_never_revoke_authorization() {
        for code in [-1, 429, 500, 502, 503, 401, 403] {
            let mut a = json!({"access_token":"synthetic"});
            apply_refresh_failure(
                &mut a,
                &json!({"message":"temporary upstream failure"}),
                code,
            );
            assert_ne!(a["needs_relogin"], true);
            assert!(a["refresh_retry_at"].as_i64().unwrap() > now_ms());
            assert!(a["refresh_error"].as_str().unwrap().contains("临时"));
        }
        let mut a = json!({});
        apply_refresh_failure(&mut a, &json!({"error":"invalid_grant"}), 12153);
        assert_eq!(a["needs_relogin"], true);
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::modules::{account, config};
    #[test]
    fn interrupted_rotation_recovers_without_overwriting_new_login() {
        let old_home = std::env::var_os("WB_SWITCH_HOME");
        let home =
            std::env::temp_dir().join(format!("wb-refresh-recovery-{}", uuid::Uuid::new_v4()));
        std::env::set_var("WB_SWITCH_HOME", &home);
        let old = json!({"id":"test", "uid":"test", "variant":"cn", "access_token":"old-test-token", "refresh_token":"old-refresh", "note":"keep"});
        account::save_accounts(&[old.clone()]).unwrap();
        std::fs::write(config::accounts_file(), "[broken").unwrap();
        let mut rotated = old.clone();
        rotated["access_token"] = json!("new-test-token");
        rotated["refresh_token"] = json!("new-refresh");
        persist_rotated_refresh(&mut rotated, "old-test-token");
        assert!(rotated.get("refresh_error").is_some());
        assert!(recovery_path(&old).exists());
        config::atomic_write(&config::accounts_file(), &json!([old.clone()]).to_string()).unwrap();
        let mut next = old.clone();
        assert!(recover_pending_refresh(&mut next).unwrap());
        assert_eq!(next["access_token"], "new-test-token");
        assert_eq!(account::load_accounts_checked().unwrap()[0]["note"], "keep");
        assert!(!recovery_path(&old).exists());
        // An independent login supersedes the failed rotation receipt.
        let journal =
            json!({"previous_access_sha256":token_digest("old-test-token"), "account":rotated});
        config::atomic_write(&recovery_path(&old), &journal.to_string()).unwrap();
        next["access_token"] = json!("new-oauth-login");
        assert!(!recover_pending_refresh(&mut next).unwrap());
        assert_eq!(next["access_token"], "new-oauth-login");
        assert!(save_refresh_fields(&old, "old-test-token").is_err());
        if let Some(value) = old_home {
            std::env::set_var("WB_SWITCH_HOME", value);
        } else {
            std::env::remove_var("WB_SWITCH_HOME");
        }
        std::fs::remove_dir_all(home).unwrap();
    }
}
