use deno_core::{JsRuntime, v8};
use std::{
    collections::VecDeque,
    fmt,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex, OnceLock, PoisonError,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tokio::sync::{Notify, mpsc::UnboundedSender};

use crate::{cache::ModuleCache, network::Network};

pub(crate) const MAX_MESSAGE: usize = 64 * 1024 * 1024;
const CLOSE_LIMIT: Duration = Duration::from_secs(5);
const LOG_LINES: usize = 32;

static PROCESS: AtomicU32 = AtomicU32::new(0);
static PLATFORM: OnceLock<Result<SyncSender<Spawn>, String>> = OnceLock::new();

/// Why an engine operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The engine stopped and accepts no further requests.
    Closed,
    /// The engine was created in another process. A forked child inherits the
    /// handle without the threads that serve it.
    Fork,
    /// The caller passed an unusable request.
    Invalid(String),
    /// The isolate stopped on a JavaScript or host failure.
    Runtime(String),
    /// The isolate exceeded its JavaScript heap limit.
    Memory,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => formatter.write_str("Notebook engine is closed"),
            Self::Fork => formatter.write_str(
                "A notebook engine cannot be used after fork. Start a fresh process with spawn.",
            ),
            Self::Invalid(message) | Self::Runtime(message) => formatter.write_str(message),
            Self::Memory => {
                formatter.write_str("Notebook engine exceeded its JavaScript heap limit")
            }
        }
    }
}

impl std::error::Error for Error {}

impl<T> From<PoisonError<T>> for Error {
    fn from(_: PoisonError<T>) -> Self {
        Self::Runtime("Engine state lock is poisoned".into())
    }
}

/// Engine handles stay bound to the process that created them.
fn process_check() -> Result<(), Error> {
    let pid = std::process::id();
    match PROCESS.compare_exchange(0, pid, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => Ok(()),
        Err(previous) if previous == pid => Ok(()),
        Err(_) => Err(Error::Fork),
    }
}

/// One engine message: a JSON header and its binary buffers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub header: Vec<u8>,
    pub buffers: Vec<Vec<u8>>,
}

/// Settings for one engine.
#[derive(Debug, Clone)]
pub struct EngineOptions {
    /// Hosts that notebook fetches and imports may reach.
    pub network: Network,
    /// Directory that keeps remote module source across processes.
    pub cache_dir: Option<PathBuf>,
    /// JavaScript heap limit of the isolate.
    pub memory_bytes: usize,
}

impl EngineOptions {
    /// Options with no disk cache and a 4 GiB heap limit.
    pub fn new(network: Network) -> Self {
        Self {
            network,
            cache_dir: None,
            memory_bytes: 4 * 1024 * 1024 * 1024,
        }
    }
}

/// The channels an isolate thread owns for its lifetime.
pub(crate) struct Ports {
    pub inbound: tokio::sync::mpsc::UnboundedReceiver<String>,
    pub outbound: Sender<Message>,
    pub network: Arc<Network>,
    pub cache: Arc<ModuleCache>,
}

/// State shared by an engine handle and its isolate thread.
pub(crate) struct Owner {
    pub memory_bytes: usize,
    pub stopping: AtomicBool,
    pub shutdown: Notify,
    pub isolate: Mutex<Option<v8::IsolateHandle>>,
    inbound: Mutex<Option<UnboundedSender<String>>>,
    outbound: Mutex<Receiver<Message>>,
    exit: Mutex<Option<Error>>,
    done: (Mutex<bool>, Condvar),
    join: Mutex<Option<JoinHandle<()>>>,
    logs: Mutex<VecDeque<String>>,
}

type Task = Box<dyn FnOnce() + Send>;

struct Spawn {
    task: Task,
    reply: SyncSender<std::io::Result<JoinHandle<()>>>,
}

/// Spawn every isolate thread from one platform owner thread. The unprotected
/// platform permits isolate creation off that thread on Linux CPUs with memory
/// protection keys, where V8 otherwise requires a common thread ancestor.
fn spawn_isolate_thread(task: Task) -> Result<JoinHandle<()>, Error> {
    let platform = PLATFORM
        .get_or_init(|| {
            let (tx, rx) = mpsc::sync_channel::<Spawn>(32);
            thread::Builder::new()
                .name("observablejs-v8-platform".into())
                .spawn(move || {
                    JsRuntime::init_platform(Some(
                        v8::new_unprotected_default_platform(0, false).make_shared(),
                    ));
                    for Spawn { task, reply } in rx {
                        let handle = thread::Builder::new()
                            .name("observablejs-engine".into())
                            .stack_size(8 * 1024 * 1024)
                            .spawn(task);
                        let _ = reply.send(handle);
                    }
                })
                .map(|_| tx)
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| Error::Runtime(format!("Could not start the V8 platform: {error}")))?;
    let (reply, handle) = mpsc::sync_channel(1);
    platform
        .send(Spawn { task, reply })
        .map_err(|_| Error::Runtime("The V8 platform thread exited".into()))?;
    handle
        .recv()
        .map_err(|_| Error::Runtime("The V8 platform thread exited".into()))?
        .map_err(|error| Error::Runtime(format!("Could not start an engine thread: {error}")))
}

impl Owner {
    fn start(options: EngineOptions) -> Result<Arc<Self>, Error> {
        process_check()?;
        let EngineOptions {
            network,
            cache_dir,
            memory_bytes,
        } = options;
        let (inbound_tx, inbound) = tokio::sync::mpsc::unbounded_channel();
        let (outbound, outbound_rx) = mpsc::channel();
        let owner = Arc::new(Self {
            memory_bytes,
            stopping: AtomicBool::new(false),
            shutdown: Notify::new(),
            isolate: Mutex::new(None),
            inbound: Mutex::new(Some(inbound_tx)),
            outbound: Mutex::new(outbound_rx),
            exit: Mutex::new(None),
            done: (Mutex::new(false), Condvar::new()),
            join: Mutex::new(None),
            logs: Mutex::new(VecDeque::with_capacity(LOG_LINES)),
        });
        let ports = Ports {
            inbound,
            outbound,
            network: Arc::new(network),
            cache: Arc::new(ModuleCache::new(cache_dir)),
        };
        let task_owner = owner.clone();
        let handle = spawn_isolate_thread(Box::new(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::isolate::run(&task_owner, ports)
            }))
            .unwrap_or_else(|_| Err(Error::Runtime("The engine thread panicked".into())));
            task_owner.finish(result);
        }))?;
        *owner.join.lock()? = Some(handle);
        Ok(owner)
    }

    fn finish(&self, result: Result<(), Error>) {
        *self.isolate.lock().unwrap_or_else(PoisonError::into_inner) = None;
        self.stopping.store(true, Ordering::Release);
        if let Err(error) = result {
            *self.exit.lock().unwrap_or_else(PoisonError::into_inner) = Some(error);
        }
        let (lock, condition) = &self.done;
        *lock.lock().unwrap_or_else(PoisonError::into_inner) = true;
        condition.notify_all();
    }

    fn send(&self, message: String) -> Result<(), Error> {
        process_check()?;
        if message.len() > MAX_MESSAGE {
            return Err(Error::Invalid(
                "Notebook request exceeds the transport limit".into(),
            ));
        }
        let inbound = self.inbound.lock()?;
        inbound
            .as_ref()
            .and_then(|sender| sender.send(message).ok())
            .ok_or_else(|| self.exit_error())
    }

    fn receive(&self, timeout: Option<Duration>) -> Result<Option<Message>, Error> {
        process_check()?;
        let outbound = self.outbound.lock()?;
        let received = match timeout {
            Some(timeout) => outbound.recv_timeout(timeout),
            None => outbound
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(message) => Ok(Some(message)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // The isolate drops its sender before the thread records why it stopped.
                self.wait_finished(CLOSE_LIMIT)?;
                Err(self.exit_error())
            }
        }
    }

    fn exit_error(&self) -> Error {
        self.exit
            .lock()
            .ok()
            .and_then(|exit| exit.clone())
            .unwrap_or(Error::Closed)
    }

    fn stop(&self) -> Result<(), Error> {
        process_check()?;
        self.stopping.store(true, Ordering::Release);
        self.inbound.lock()?.take();
        if let Some(handle) = self.isolate.lock()?.as_ref() {
            handle.terminate_execution();
        }
        self.shutdown.notify_one();
        Ok(())
    }

    fn wait_finished(&self, duration: Duration) -> Result<bool, Error> {
        let (lock, condition) = &self.done;
        let done = lock.lock()?;
        if *done {
            return Ok(true);
        }
        Ok(*condition.wait_timeout(done, duration)?.0)
    }

    fn join(&self) -> Result<(), Error> {
        if let Some(join) = self.join.lock()?.take() {
            join.join()
                .map_err(|_| Error::Runtime("The engine thread panicked".into()))?;
        }
        Ok(())
    }

    pub fn closed(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    pub fn log(&self, message: &str) {
        let mut logs = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        if logs.len() == LOG_LINES {
            logs.pop_front();
        }
        logs.push_back(message.to_owned());
    }

    pub fn recent_logs(&self) -> String {
        let logs = self.logs.lock().unwrap_or_else(PoisonError::into_inner);
        logs.iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// One V8 isolate that runs the notebook engine bundle on its own thread.
///
/// Send JSON requests with [`Engine::send`] and read replies with
/// [`Engine::receive`]. Dropping the handle stops the isolate.
pub struct Engine {
    owner: Arc<Owner>,
}

impl Engine {
    /// Start an isolate. It sends `{"type": "ready"}` once the bundle loads.
    pub fn start(options: EngineOptions) -> Result<Self, Error> {
        Ok(Self {
            owner: Owner::start(options)?,
        })
    }

    /// Queue one JSON request.
    pub fn send(&self, request: String) -> Result<(), Error> {
        self.owner.send(request)
    }

    /// Wait for the next message. `Ok(None)` means `timeout` elapsed. After the
    /// isolate stops, returns the error that stopped it.
    pub fn receive(&self, timeout: Option<Duration>) -> Result<Option<Message>, Error> {
        self.owner.receive(timeout)
    }

    /// Terminate running JavaScript and leave the event loop without waiting.
    pub fn stop(&self) -> Result<(), Error> {
        self.owner.stop()
    }

    /// Stop the isolate and join its thread, waiting at most five seconds.
    pub fn close(&self) -> Result<(), Error> {
        self.owner.stop()?;
        if !self.owner.wait_finished(CLOSE_LIMIT)? {
            return Err(Error::Runtime(
                "Notebook engine teardown exceeded five seconds".into(),
            ));
        }
        self.owner.join()
    }

    /// Whether the isolate stopped or is stopping.
    pub fn is_closed(&self) -> bool {
        self.owner.closed()
    }
}

impl fmt::Debug for Engine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Engine")
            .field("closed", &self.is_closed())
            .finish()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // An inherited handle has no isolate thread to stop in this process.
        let _ = self.owner.stop();
    }
}
