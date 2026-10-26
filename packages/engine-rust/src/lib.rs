//! Notebook engine that hosts the pyobservablejs JavaScript bundle in V8 isolates.
//!
//! Each [`Engine`] owns one isolate on its own thread. The isolate loads the
//! `@pyobservablejs/engine-ts` bundle with `deno_web` globals and serves JSON
//! requests. Replies are [`Message`]s: a JSON header plus binary buffers.
//!
//! ```no_run
//! use pyobservablejs_engine_rust::{Engine, EngineOptions, Network};
//!
//! let engine = Engine::start(EngineOptions::new(Network::Hosts(vec![])))?;
//! let ready = engine.receive(None)?;
//! engine.close()?;
//! # Ok::<(), pyobservablejs_engine_rust::Error>(())
//! ```

mod cache;
mod host;
mod isolate;
mod loader;
mod network;
mod worker;

pub use network::Network;
pub use worker::{Engine, EngineOptions, Error, Message};
