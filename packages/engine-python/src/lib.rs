//! CPython extension `observablejs._engine` over [`pyobservablejs_engine_rust`].

use pyo3::{
    create_exception,
    exceptions::{PyMemoryError, PyRuntimeError, PyValueError},
    prelude::*,
    types::PyBytes,
};
use pyobservablejs_engine_rust::{EngineOptions, Error, Network};
use std::{path::PathBuf, time::Duration};

create_exception!(
    _engine,
    EngineStopped,
    PyRuntimeError,
    "The engine isolate stopped and accepts no further messages."
);

fn python_error(error: Error) -> PyErr {
    let message = error.to_string();
    match error {
        Error::Closed | Error::Runtime(_) => EngineStopped::new_err(message),
        Error::Fork => PyRuntimeError::new_err(message),
        Error::Invalid(_) => PyValueError::new_err(message),
        Error::Memory => PyMemoryError::new_err(message),
    }
}

#[derive(FromPyObject)]
enum NetworkArg {
    Flag(bool),
    Hosts(Vec<String>),
}

/// One engine message: a JSON header and its binary buffers.
type Message<'py> = (Bound<'py, PyBytes>, Vec<Bound<'py, PyBytes>>);

/// One V8 isolate that runs the notebook engine bundle on its own thread.
#[pyclass(module = "observablejs._engine", frozen)]
struct Engine {
    engine: pyobservablejs_engine_rust::Engine,
}

#[pymethods]
impl Engine {
    #[new]
    #[pyo3(signature = (*, network, cache_dir = None, memory_mb = 4096))]
    fn new(network: NetworkArg, cache_dir: Option<PathBuf>, memory_mb: usize) -> PyResult<Self> {
        let network = match network {
            NetworkArg::Flag(true) => Network::All,
            NetworkArg::Flag(false) => Network::Hosts(vec![]),
            NetworkArg::Hosts(hosts) => Network::Hosts(hosts),
        };
        let memory_bytes = memory_mb
            .checked_mul(1024 * 1024)
            .ok_or_else(|| PyValueError::new_err("memory_mb is too large"))?;
        let options = EngineOptions {
            network,
            cache_dir,
            memory_bytes,
        };
        let engine = pyobservablejs_engine_rust::Engine::start(options).map_err(python_error)?;
        Ok(Self { engine })
    }

    /// Queue one JSON request for the engine.
    fn send(&self, message: String) -> PyResult<()> {
        self.engine.send(message).map_err(python_error)
    }

    /// Return the next `(header, buffers)` message, or `None` after `timeout` seconds.
    #[pyo3(signature = (timeout = None))]
    fn receive<'py>(
        &self,
        py: Python<'py>,
        timeout: Option<f64>,
    ) -> PyResult<Option<Message<'py>>> {
        let timeout = timeout
            .map(|seconds| {
                Duration::try_from_secs_f64(seconds)
                    .map_err(|_| PyValueError::new_err("timeout must be finite and nonnegative"))
            })
            .transpose()?;
        let message = py
            .detach(|| self.engine.receive(timeout))
            .map_err(python_error)?;
        Ok(message.map(|message| {
            (
                PyBytes::new(py, &message.header),
                message
                    .buffers
                    .iter()
                    .map(|buffer| PyBytes::new(py, buffer))
                    .collect(),
            )
        }))
    }

    /// Terminate running JavaScript, stop the event loop, and join the isolate thread.
    fn close(&self, py: Python<'_>) -> PyResult<()> {
        py.detach(|| self.engine.close()).map_err(python_error)
    }

    #[getter]
    fn closed(&self) -> bool {
        self.engine.is_closed()
    }
}

#[pymodule]
fn _engine(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<Engine>()?;
    module.add("EngineStopped", module.py().get_type::<EngineStopped>())?;
    Ok(())
}
