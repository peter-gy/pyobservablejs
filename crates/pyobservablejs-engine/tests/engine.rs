#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test helpers fail the test on an unexpected engine reply"
)]

use pyobservablejs_engine::{Engine, EngineOptions, Error, Network};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(30);

fn offline() -> Engine {
    let engine = Engine::start(EngineOptions::new(Network::Hosts(vec![]))).unwrap();
    assert_eq!(header(&engine), json!({"type": "ready", "protocol": 1}));
    engine
}

fn header(engine: &Engine) -> Value {
    let message = engine.receive(Some(WAIT)).unwrap().expect("engine reply");
    serde_json::from_slice(&message.header).unwrap()
}

fn request(engine: &Engine, id: &str, operation: &str, fields: Value) -> Value {
    let mut message = json!({"type": "request", "id": id, "operation": operation});
    message
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    engine.send(message.to_string()).unwrap();
    let reply = header(engine);
    assert_eq!(reply["id"], id);
    reply
}

fn notebook(source: &str) -> Value {
    json!({"cells": [{"id": 1, "mode": "js", "value": source}]})
}

#[test]
fn inspection_reports_cell_definitions_without_evaluating() {
    let engine = offline();
    let reply = request(
        &engine,
        "1",
        "inspect",
        json!({"source": notebook("throw new Error('unused'); const x = 3"), "options": {}}),
    );
    assert_eq!(reply["result"]["cells"][0]["defines"], json!(["x"]));
    engine.close().unwrap();
    assert!(engine.is_closed());
}

#[test]
fn close_terminates_a_busy_isolate() {
    let engine = offline();
    // The cell starts evaluating after the open reply and never yields.
    let opened = request(
        &engine,
        "1",
        "open",
        json!({"source": notebook("while (true) {} const done = 1"), "options": {"selection": [0]}}),
    );
    assert!(opened.get("result").is_some(), "{opened}");
    let started = Instant::now();
    engine.close().unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(engine.send(String::from("{}")), Err(Error::Closed));
}

#[test]
fn offline_engines_reject_remote_imports() {
    let engine = offline();
    let opened = request(
        &engine,
        "1",
        "open",
        json!({
            "source": notebook("const {a} = await import('https://example.com/a.js')"),
            "options": {"selection": [0]},
        }),
    );
    assert!(opened.get("result").is_some(), "{opened}");
    let read = request(
        &engine,
        "2",
        "read",
        json!({"selector": {"name": "a"}, "options": {"format": "python"}}),
    );
    let failure = read["error"].to_string();
    assert!(
        failure.contains("Requires net access to \\\"example.com:443\\\""),
        "{failure}"
    );
    engine.close().unwrap();
}
