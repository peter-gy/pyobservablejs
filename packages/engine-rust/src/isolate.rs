use deno_core::{Extension, JsRuntime, PollEventLoopOptions, RuntimeOptions, url::Url, v8};
use std::{
    borrow::Cow,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{
    host::{Host, pyobservablejs_host},
    loader::{ENGINE_SCHEME, Loader},
    worker::{Error, Owner, Ports},
};

const LOCATION: &str = "https://observablehq.com/";

mod web_sources {
    include!(concat!(env!("OUT_DIR"), "/web_sources.rs"));
}

/// Rebind extension sources to the copies embedded at build time. Upstream
/// descriptors name files in the builder's Cargo registry.
fn embedded(mut extension: Extension) -> Result<Extension, Error> {
    for files in [
        &mut extension.js_files,
        &mut extension.esm_files,
        &mut extension.lazy_loaded_js_files,
        &mut extension.lazy_loaded_esm_files,
    ] {
        let sources = files
            .iter()
            .map(|file| {
                web_sources::SOURCES
                    .iter()
                    .find(|source| source.specifier == file.specifier)
                    .cloned()
                    .ok_or_else(|| {
                        Error::Runtime(format!(
                            "Embedded web source is unavailable: {}",
                            file.specifier
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        *files = Cow::Owned(sources);
    }
    Ok(extension)
}

fn runtime_error(error: impl std::fmt::Display) -> Error {
    Error::Runtime(error.to_string())
}

/// Own one isolate on the current thread until the module exits or Python stops it.
pub fn run(owner: &Arc<Owner>, ports: Ports) -> Result<(), Error> {
    let tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(runtime_error)?;
    let exhausted = Arc::new(AtomicBool::new(false));
    let result = tokio.block_on(evaluate(owner, ports, exhausted.clone()));
    // Blocking network reads finish on their own deadline after the engine stops.
    tokio.shutdown_background();
    if exhausted.load(Ordering::Acquire) {
        return Err(Error::Memory);
    }
    match result {
        Err(_) if owner.closed() => Ok(()),
        Err(Error::Runtime(message)) => {
            let logs = owner.recent_logs();
            Err(Error::Runtime(if logs.is_empty() {
                message
            } else {
                format!("{message}\n\nRecent console output:\n{logs}")
            }))
        }
        result => result,
    }
}

async fn evaluate(
    owner: &Arc<Owner>,
    ports: Ports,
    exhausted: Arc<AtomicBool>,
) -> Result<(), Error> {
    // V8 must finish creating the isolate before its heap callback is installed.
    if owner.memory_bytes < 64 * 1024 * 1024 {
        return Err(Error::Memory);
    }
    let Ports {
        inbound,
        outbound,
        network,
        cache,
    } = ports;
    let location = Url::parse(LOCATION).map_err(runtime_error)?;
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        module_loader: Some(Rc::new(Loader {
            network: network.clone(),
            cache,
        })),
        extensions: vec![
            embedded(deno_webidl::deno_webidl::init())?,
            embedded(deno_web::deno_web::init(
                Arc::new(deno_web::BlobStore::default()),
                Some(location),
                false,
                Default::default(),
            ))?,
            pyobservablejs_host::init(Host {
                owner: owner.clone(),
                network,
                outbound,
                inbound: Rc::new(tokio::sync::Mutex::new(inbound)),
            }),
        ],
        create_params: Some(v8::Isolate::create_params().heap_limits(0, owner.memory_bytes)),
        ..Default::default()
    })
    .map_err(runtime_error)?;
    let handle = runtime.v8_isolate().thread_safe_handle();
    let heap_handle = handle.clone();
    runtime.add_near_heap_limit_callback(move |current, _initial| {
        exhausted.store(true, Ordering::Release);
        heap_handle.terminate_execution();
        // Termination still needs headroom to unwind JavaScript and destroy
        // the isolate on its owning thread.
        current.saturating_add(64 * 1024 * 1024)
    });
    *owner.isolate.lock()? = Some(handle);
    if owner.closed() {
        return Err(Error::Closed);
    }
    runtime
        .execute_script("pyobservablejs:bootstrap", include_str!("bootstrap.js"))
        .map_err(runtime_error)?;
    let specifier = Url::parse(&format!("{ENGINE_SCHEME}:/engine.js")).map_err(runtime_error)?;
    let module = runtime
        .load_main_es_module(&specifier)
        .await
        .map_err(runtime_error)?;
    let evaluation = runtime.mod_evaluate(module);
    tokio::select! {
        biased;
        () = owner.shutdown.notified() => return Err(Error::Closed),
        result = runtime.run_event_loop(PollEventLoopOptions::default()) => {
            result.map_err(runtime_error)?;
        }
    }
    evaluation.await.map_err(runtime_error)
}
