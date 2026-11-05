//! Per-launch WebUI credentials. Never reusable as a proxy or upstream credential.
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::sync::Arc;

#[derive(Clone)]
pub struct Access {
    pub token: Arc<String>,
    pub port: u16,
}

pub async fn protect(State(access): State<Access>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let hosts = [
        format!("127.0.0.1:{}", access.port),
        format!("localhost:{}", access.port),
    ];
    let origin_ok = headers
        .get(header::ORIGIN)
        .map(|h| h.to_str().ok() == Some(&format!("http://{host}")))
        .unwrap_or(true);
    let site_ok = headers.get("sec-fetch-site").and_then(|h| h.to_str().ok()) != Some("cross-site");
    if !hosts.iter().any(|h| h == host) || !origin_ok || !site_ok {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"请求来源不被允许"})),
        )
            .into_response();
    }
    if request.uri().path().starts_with("/api/") {
        let supplied = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .unwrap_or("");
        // Compare every byte to avoid a per-prefix timing oracle.
        let expected = access.token.as_bytes();
        let candidate = supplied.as_bytes();
        let mut diff = expected.len() ^ candidate.len();
        for (i, b) in expected.iter().enumerate() {
            diff |= usize::from(*b ^ candidate.get(i).copied().unwrap_or(0));
        }
        if diff != 0 {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"WebUI 会话未授权，请从本次服务启动链接打开"})),
            )
                .into_response();
        }
    }
    let mut response = next.run(request).await;
    for (name, value) in [
        ("cache-control", "no-store"),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
        ("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    ] { response.headers_mut().insert(axum::http::HeaderName::from_static(name), axum::http::HeaderValue::from_static(value)); }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, middleware, routing::get, Router};
    use tower::ServiceExt;
    #[tokio::test]
    async fn requires_session_and_same_origin() {
        let app = Router::new()
            .route("/api/probe", get(|| async { "ok" }))
            .layer(middleware::from_fn_with_state(
                Access {
                    token: Arc::new("test-session".into()),
                    port: 57890,
                },
                protect,
            ));
        for (host, origin, token, status) in [
            ("127.0.0.1:57890", None, None, 401),
            ("127.0.0.1:57890", None, Some("wrong"), 401),
            ("attacker.example:57890", None, Some("test-session"), 403),
            (
                "127.0.0.1:57890",
                Some("https://attacker.example"),
                Some("test-session"),
                403,
            ),
            (
                "127.0.0.1:57890",
                Some("http://127.0.0.1:57890"),
                Some("test-session"),
                200,
            ),
        ] {
            let mut req = Request::builder().uri("/api/probe").header("host", host);
            if let Some(o) = origin {
                req = req.header("origin", o);
            }
            if let Some(t) = token {
                req = req.header("authorization", format!("Bearer {t}"));
            }
            let response = app
                .clone()
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
        }
    }
}
