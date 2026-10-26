use crate::cache::{Freshness, Module, ModuleCache, freshness};
use base64::{
    Engine as _, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use deno_core::url::Url;
use deno_error::JsErrorBox;
use percent_encoding::percent_decode_str;
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use ureq::{
    Agent,
    http::{self, header},
    tls::{RootCerts, TlsConfig},
};

const MAX_BODY: u64 = 1024 * 1024 * 1024;
const MAX_REDIRECTS: usize = 20;
const REQUEST_LIMIT: Duration = Duration::from_secs(300);

/// Hosts that notebook fetches and module imports may reach.
#[derive(Debug, Clone)]
pub enum Network {
    All,
    /// Host names, which allow every port, or `host:port` pairs. Matching
    /// ignores case and fills in the scheme's default port. An empty list
    /// keeps the engine offline.
    Hosts(Vec<String>),
}

impl Network {
    pub fn check(&self, url: &Url) -> Result<(), JsErrorBox> {
        let host = url.host_str().unwrap_or_default();
        let allowed = match self {
            Self::All => true,
            Self::Hosts(hosts) => hosts.iter().any(|allowed| {
                let allowed = allowed.to_ascii_lowercase();
                allowed == host
                    || url
                        .port_or_known_default()
                        .is_some_and(|port| allowed == format!("{host}:{port}"))
            }),
        };
        if allowed {
            return Ok(());
        }
        let authority = match url.port_or_known_default() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        Err(JsErrorBox::new(
            "NotCapable",
            format!("Requires net access to \"{authority}\""),
        ))
    }
}

pub struct Request {
    pub method: String,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

pub struct Response {
    pub status: u16,
    pub status_text: String,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Decode a `data:` URL into its media type and bytes.
pub fn data_url(url: &Url) -> Result<(String, Vec<u8>), JsErrorBox> {
    let invalid = || JsErrorBox::type_error(format!("Invalid data URL: {url}"));
    let (meta, data) = url.path().split_once(',').ok_or_else(invalid)?;
    let (media_type, base64) = match meta.len().checked_sub(7) {
        Some(split) if meta[split..].eq_ignore_ascii_case(";base64") => (&meta[..split], true),
        _ => (meta, false),
    };
    let media_type = if media_type.is_empty() {
        "text/plain;charset=US-ASCII".to_owned()
    } else {
        percent_decode_str(media_type)
            .decode_utf8_lossy()
            .into_owned()
    };
    let mut bytes: Vec<u8> = percent_decode_str(data).collect();
    if let Some(query) = url.query() {
        bytes.push(b'?');
        bytes.extend(percent_decode_str(query));
    }
    if base64 {
        static FORGIVING: GeneralPurpose = GeneralPurpose::new(
            &alphabet::STANDARD,
            GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
        );
        bytes.retain(|byte| !byte.is_ascii_whitespace());
        bytes = FORGIVING.decode(&bytes).map_err(|_| invalid())?;
    }
    Ok((media_type, bytes))
}

fn agent() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_LIMIT))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .into()
    })
}

fn http_error(error: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::type_error(format!("Network request failed: {error}"))
}

/// Send one HTTP request, following redirects that the policy allows.
/// Blocks the calling thread.
pub fn send(network: &Network, mut request: Request) -> Result<Response, JsErrorBox> {
    for _ in 0..=MAX_REDIRECTS {
        network.check(&request.url)?;
        let mut builder = http::Request::builder()
            .method(request.method.as_str())
            .uri(request.url.as_str());
        for (name, value) in &request.headers {
            // The client negotiates and decodes content encodings itself.
            if !name.eq_ignore_ascii_case(header::ACCEPT_ENCODING.as_str()) {
                builder = builder.header(name, value);
            }
        }
        let response = match &request.body {
            Some(body) => agent().run(builder.body(body.clone()).map_err(http_error)?),
            None => agent().run(builder.body(()).map_err(http_error)?),
        }
        .map_err(http_error)?;
        let status = response.status();
        if status.is_redirection()
            && let Some(location) = response.headers().get(header::LOCATION)
        {
            let location = location.to_str().map_err(http_error)?;
            let target = request.url.join(location).map_err(http_error)?;
            // Credentials stay with their origin, as in WHATWG fetch.
            if target.origin() != request.url.origin() {
                request.headers.retain(|(name, _)| {
                    !["authorization", "cookie", "proxy-authorization"]
                        .iter()
                        .any(|credential| name.eq_ignore_ascii_case(credential))
                });
            }
            request.url = target;
            if status == http::StatusCode::SEE_OTHER
                || (matches!(status.as_u16(), 301 | 302) && request.method == "POST")
            {
                request.method = "GET".into();
                request.body = None;
                request.headers.retain(|(name, _)| {
                    !name.eq_ignore_ascii_case("content-type")
                        && !name.eq_ignore_ascii_case("content-length")
                });
            }
            continue;
        }
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| {
                // The body below is already decoded and complete.
                *name != header::CONTENT_ENCODING && *name != header::CONTENT_LENGTH
            })
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let mut body = response.into_body();
        let body = body
            .with_config()
            .limit(MAX_BODY)
            .read_to_vec()
            .map_err(http_error)?;
        return Ok(Response {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or_default().to_owned(),
            url: request.url,
            headers,
            body,
        });
    }
    Err(JsErrorBox::type_error(
        "Network request exceeded 20 redirects",
    ))
}

/// Load ES module source from `data:` or HTTP(S) URLs under the network policy.
/// The policy applies to the requested and final URLs before any cache use.
pub async fn module(
    network: Arc<Network>,
    cache: Arc<ModuleCache>,
    url: Url,
) -> Result<Arc<Module>, JsErrorBox> {
    match url.scheme() {
        "data" => {
            let (_, bytes) = data_url(&url)?;
            let source = String::from_utf8(bytes)
                .map_err(|_| JsErrorBox::type_error(format!("Module is not UTF-8: {url}")))?;
            Ok(Arc::new(Module {
                url,
                source,
                freshness: Freshness::Never,
            }))
        }
        "http" | "https" => {
            network.check(&url)?;
            if let Some(module) = cache.memory(&url) {
                network.check(&module.url)?;
                return Ok(module);
            }
            let (task_network, task_cache, requested) =
                (network.clone(), cache.clone(), url.clone());
            let module = tokio::task::spawn_blocking(move || {
                if let Some(module) = task_cache.read(&requested) {
                    return Ok(module);
                }
                let response = send(
                    &task_network,
                    Request {
                        method: "GET".into(),
                        url: requested.clone(),
                        headers: vec![],
                        body: None,
                    },
                )?;
                if !(200..300).contains(&response.status) {
                    return Err(JsErrorBox::type_error(format!(
                        "Module not found \"{requested}\" (HTTP {})",
                        response.status
                    )));
                }
                let freshness = freshness(&response.headers);
                let source = String::from_utf8(response.body).map_err(|_| {
                    JsErrorBox::type_error(format!("Module is not UTF-8: {requested}"))
                })?;
                let module = Module {
                    url: response.url,
                    source,
                    freshness,
                };
                task_cache.write(&requested, &module);
                Ok(Arc::new(module))
            })
            .await
            .map_err(http_error)??;
            network.check(&module.url)?;
            cache.remember(url, module.clone());
            Ok(module)
        }
        scheme => Err(JsErrorBox::type_error(format!(
            "Unsupported module URL scheme \"{scheme}:\""
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{Network, data_url};
    use deno_core::url::Url;
    use std::error::Error;

    type TestResult = Result<(), Box<dyn Error>>;

    #[test]
    fn host_lists_match_names_and_explicit_ports() -> TestResult {
        let network = Network::Hosts(vec!["example.com".into(), "127.0.0.1:8000".into()]);
        let allows = |url: &str| -> Result<bool, Box<dyn Error>> {
            Ok(network.check(&Url::parse(url)?).is_ok())
        };
        assert!(allows("https://example.com/a.js")?);
        assert!(allows("http://example.com:9000/a.js")?);
        assert!(allows("http://127.0.0.1:8000/data.json")?);
        assert!(!allows("http://127.0.0.1:8001/data.json")?);
        let default_port = Network::Hosts(vec!["Example.COM:443".into()]);
        assert!(
            default_port
                .check(&Url::parse("https://example.com/a.js")?)
                .is_ok()
        );
        assert!(
            default_port
                .check(&Url::parse("http://example.com/a.js")?)
                .is_err()
        );
        let offline = Network::Hosts(vec![]);
        assert!(offline.check(&Url::parse("https://example.com/")?).is_err());
        assert!(
            Network::All
                .check(&Url::parse("https://example.com/")?)
                .is_ok()
        );
        Ok(())
    }

    #[test]
    fn data_urls_decode_percent_and_forgiving_base64() -> TestResult {
        let (media_type, bytes) =
            data_url(&Url::parse("data:text/javascript,export%20const%20a%3D1")?)?;
        assert_eq!(media_type, "text/javascript");
        assert_eq!(bytes, b"export const a=1");
        let (media_type, bytes) =
            data_url(&Url::parse("data:application/json;base64,eyJ hIjox fQ")?)?;
        assert_eq!(media_type, "application/json");
        assert_eq!(bytes, br#"{"a":1}"#);
        assert!(data_url(&Url::parse("data:text/plain")?).is_err());
        Ok(())
    }
}
