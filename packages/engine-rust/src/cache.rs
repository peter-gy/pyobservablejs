//! Remote module source shared by the engines in a process and, with a cache
//! directory, by later processes. Freshness follows the response's
//! `Cache-Control` and `Age` headers.

use deno_core::{serde_json, url::Url};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        Arc, LazyLock, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// How long a module response may be reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    /// `no-store` or `no-cache`: load again every time.
    Never,
    /// No declared lifetime: reuse within this process.
    Process,
    /// `max-age`: reuse until this time, in this and later processes.
    Until(SystemTime),
}

pub struct Module {
    /// The final URL after redirects. Relative imports resolve against it.
    pub url: Url,
    pub source: String,
    pub freshness: Freshness,
}

impl Module {
    fn fresh(&self) -> bool {
        match self.freshness {
            Freshness::Never => false,
            Freshness::Process => true,
            Freshness::Until(expires) => SystemTime::now() < expires,
        }
    }
}

/// Distinguishes temporary files written concurrently by one process.
static WRITES: AtomicU64 = AtomicU64::new(0);

static MEMORY: LazyLock<Mutex<HashMap<Url, Arc<Module>>>> = LazyLock::new(Default::default);

/// Freshness of a response from its `Cache-Control` and `Age` headers.
pub fn freshness(headers: &[(String, String)]) -> Freshness {
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };
    let Some(control) = header("cache-control") else {
        return Freshness::Process;
    };
    let mut max_age = None;
    for directive in control.split(',').map(str::trim) {
        let name = directive.split('=').next().unwrap_or_default();
        if name.eq_ignore_ascii_case("no-store") || name.eq_ignore_ascii_case("no-cache") {
            return Freshness::Never;
        }
        if name.eq_ignore_ascii_case("max-age") {
            max_age = directive
                .split_once('=')
                .and_then(|(_, seconds)| seconds.trim_matches('"').parse::<u64>().ok());
        }
    }
    let Some(max_age) = max_age else {
        return Freshness::Process;
    };
    let age = header("age")
        .and_then(|age| age.trim().parse::<u64>().ok())
        .unwrap_or(0);
    match max_age.checked_sub(age).filter(|seconds| *seconds > 0) {
        Some(seconds) => Freshness::Until(SystemTime::now() + Duration::from_secs(seconds)),
        None => Freshness::Never,
    }
}

pub struct ModuleCache {
    directory: Option<PathBuf>,
}

impl ModuleCache {
    pub fn new(directory: Option<PathBuf>) -> Self {
        Self { directory }
    }

    pub fn memory(&self, url: &Url) -> Option<Arc<Module>> {
        MEMORY
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(url)
            .filter(|module| module.fresh())
            .cloned()
    }

    pub fn remember(&self, url: Url, module: Arc<Module>) {
        if module.freshness == Freshness::Never {
            return;
        }
        MEMORY
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(url, module);
    }

    fn path(&self, url: &Url) -> Option<PathBuf> {
        let digest = Sha256::digest(url.as_str().as_bytes());
        let name = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Some(self.directory.as_ref()?.join(format!("{name}.js")))
    }

    /// Read a fresh module written by any process. Unreadable entries are misses.
    /// Blocks the calling thread.
    pub fn read(&self, url: &Url) -> Option<Arc<Module>> {
        let contents = fs::read_to_string(self.path(url)?).ok()?;
        let (header, source) = contents.split_once('\n')?;
        let header: serde_json::Value = serde_json::from_str(header).ok()?;
        let module = Module {
            url: Url::parse(header["url"].as_str()?).ok()?,
            source: source.to_owned(),
            freshness: Freshness::Until(
                UNIX_EPOCH + Duration::from_secs(header["expires"].as_u64()?),
            ),
        };
        module.fresh().then(|| Arc::new(module))
    }

    /// Persist a module that has a cache lifetime. Failures leave the cache
    /// unchanged; the module stays usable. Blocks the calling thread.
    pub fn write(&self, url: &Url, module: &Module) {
        let (Some(path), Freshness::Until(expires)) = (self.path(url), module.freshness) else {
            return;
        };
        let Ok(expires) = expires.duration_since(UNIX_EPOCH) else {
            return;
        };
        let header =
            serde_json::json!({ "url": module.url.as_str(), "expires": expires.as_secs() });
        let write = || -> std::io::Result<()> {
            let directory = path.parent().ok_or(std::io::ErrorKind::NotFound)?;
            fs::create_dir_all(directory)?;
            // Concurrent writers each rename their own complete file into place.
            let temporary = directory.join(format!(
                ".{}.{}.{}",
                std::process::id(),
                WRITES.fetch_add(1, Ordering::Relaxed),
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("module")
            ));
            let mut file = fs::File::create(&temporary)?;
            writeln!(file, "{header}")?;
            file.write_all(module.source.as_bytes())?;
            fs::rename(&temporary, &path).inspect_err(|_| {
                let _ = fs::remove_file(&temporary);
            })
        };
        let _ = write();
    }
}

#[cfg(test)]
mod tests {
    use super::{Freshness, Module, ModuleCache, freshness};
    use deno_core::url::Url;
    use std::time::{Duration, SystemTime};

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn freshness_follows_cache_control_and_age() {
        let immutable = freshness(&headers(&[
            ("Cache-Control", "public, max-age=31536000, immutable"),
            ("Age", "100"),
        ]));
        let Freshness::Until(expires) = immutable else {
            panic!("expected a lifetime, got {immutable:?}");
        };
        let remaining = expires.duration_since(SystemTime::now()).unwrap();
        assert!(remaining > Duration::from_secs(31_535_000));
        let no_cache = headers(&[("cache-control", "no-cache, max-age=60")]);
        assert_eq!(freshness(&no_cache), Freshness::Never);
        let expired = headers(&[("cache-control", "max-age=60"), ("age", "90")]);
        assert_eq!(freshness(&expired), Freshness::Never);
        assert_eq!(freshness(&headers(&[])), Freshness::Process);
    }

    #[test]
    fn fresh_entries_survive_a_new_cache_and_expired_entries_do_not() {
        let directory =
            std::env::temp_dir().join(format!("observablejs-cache-{}", std::process::id()));
        let cache = ModuleCache::new(Some(directory.clone()));
        let requested = Url::parse("https://cdn.example.com/npm/d3@7/+esm").unwrap();
        let module = Module {
            url: Url::parse("https://cdn.example.com/npm/d3@7.9.0/+esm").unwrap(),
            source: "export const answer = 42;\n".into(),
            freshness: Freshness::Until(SystemTime::now() + Duration::from_secs(60)),
        };
        cache.write(&requested, &module);
        let read = ModuleCache::new(Some(directory.clone()))
            .read(&requested)
            .expect("fresh module");
        assert_eq!(read.url, module.url);
        assert_eq!(read.source, module.source);
        let stale = Module {
            freshness: Freshness::Until(SystemTime::now() - Duration::from_secs(1)),
            ..module
        };
        cache.write(&requested, &stale);
        assert!(cache.read(&requested).is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
