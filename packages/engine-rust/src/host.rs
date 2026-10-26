use deno_core::{JsBuffer, OpState, ToV8, convert::Uint8Array, op2, url::Url};
use deno_error::JsErrorBox;
use serde::Deserialize;
use std::{cell::RefCell, rc::Rc, sync::Arc, sync::mpsc::Sender};
use tokio::sync::{Mutex, mpsc::UnboundedReceiver};

use crate::{
    network::{self, Network},
    worker::{MAX_MESSAGE, Message, Owner},
};

/// Per-isolate state behind the host operations.
pub struct Host {
    pub owner: Arc<Owner>,
    pub network: Arc<Network>,
    pub outbound: Sender<Message>,
    pub inbound: Rc<Mutex<UnboundedReceiver<String>>>,
}

#[op2]
fn op_engine_send(
    state: &mut OpState,
    #[string] header: String,
    #[serde] buffers: Vec<JsBuffer>,
) -> Result<(), JsErrorBox> {
    let size = buffers.iter().fold(header.len(), |total, buffer| {
        total.saturating_add(buffer.len())
    });
    if size > MAX_MESSAGE {
        return Err(JsErrorBox::range_error(
            "Notebook response exceeds the transport limit",
        ));
    }
    // A send fails only after Python closed the engine; the isolate stops next.
    let _ = state.borrow::<Host>().outbound.send(Message {
        header: header.into_bytes(),
        buffers: buffers.iter().map(|buffer| buffer.to_vec()).collect(),
    });
    Ok(())
}

#[op2]
#[string]
async fn op_engine_receive(state: Rc<RefCell<OpState>>) -> Option<String> {
    let inbound = state.borrow().borrow::<Host>().inbound.clone();
    let mut inbound = inbound.lock().await;
    inbound.recv().await
}

#[derive(Deserialize)]
struct FetchRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<JsBuffer>,
}

#[derive(ToV8)]
struct FetchResponse {
    status: u16,
    status_text: String,
    url: String,
    /// Alternating header names and values.
    headers: Vec<String>,
    body: Uint8Array,
}

#[op2]
async fn op_engine_fetch(
    state: Rc<RefCell<OpState>>,
    #[serde] request: FetchRequest,
) -> Result<FetchResponse, JsErrorBox> {
    let url = Url::parse(&request.url)
        .map_err(|_| JsErrorBox::type_error(format!("Invalid URL: {}", request.url)))?;
    let response = match url.scheme() {
        "data" => {
            let (media_type, body) = network::data_url(&url)?;
            network::Response {
                status: 200,
                status_text: "OK".into(),
                url,
                headers: vec![("content-type".into(), media_type)],
                body,
            }
        }
        "http" | "https" => {
            let network = state.borrow().borrow::<Host>().network.clone();
            let request = network::Request {
                method: request.method,
                url,
                headers: request.headers,
                body: request.body.map(|body| body.to_vec()),
            };
            tokio::task::spawn_blocking(move || network::send(&network, request))
                .await
                .map_err(|error| JsErrorBox::generic(error.to_string()))??
        }
        scheme => {
            return Err(JsErrorBox::type_error(format!(
                "Unsupported fetch URL scheme \"{scheme}:\""
            )));
        }
    };
    Ok(FetchResponse {
        status: response.status,
        status_text: response.status_text,
        url: response.url.into(),
        headers: response
            .headers
            .into_iter()
            .flat_map(|(name, value)| [name, value])
            .collect(),
        body: response.body.into(),
    })
}

#[op2(fast)]
fn op_engine_random(#[buffer] bytes: &mut [u8]) -> Result<(), JsErrorBox> {
    getrandom::fill(bytes).map_err(|error| JsErrorBox::generic(error.to_string()))
}

#[op2(fast)]
fn op_engine_log(state: &mut OpState, #[string] message: &str) {
    state.borrow::<Host>().owner.log(message);
}

deno_core::extension!(
    pyobservablejs_host,
    ops = [
        op_engine_send,
        op_engine_receive,
        op_engine_fetch,
        op_engine_random,
        op_engine_log,
    ],
    options = { host: Host },
    state = |state, options| {
        state.put(options.host);
    },
);
