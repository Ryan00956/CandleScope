use candlescope_plugin_sdk_wasm::{serve, Plugin, ProtocolError, Value, MAX_SAFE_INTEGER};
use std::env;
use std::fs;
use std::hint::black_box;
use std::io::{self, Write};
use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

const DESCRIPTOR: &str = concat!(
    r#"{"contributions":[{"entrypoint":"main","id":"wasm-hello","kind":"command/1","title":"Run deterministic Rust/WASM reference"}],"#,
    r#""entrypointId":"main","features":[],"hostApis":{"optional":[],"required":[]},"#,
    r#""permissions":{"optional":[],"required":[]},"#,
    r#""plugin":{"id":"candlescope.wasm-reference","name":"Rust WASM Reference","publisher":"candlescope","version":"0.1.0"},"#,
    r#""protocol":"candlescope.plugin/2"}"#,
);

struct WasmReference;

impl WasmReference {
    fn fault(input: &Value) -> Result<Option<&str>, ProtocolError> {
        match input.optional_field("fault")? {
            Some(value) => Ok(Some(value.as_str()?)),
            None => Ok(None),
        }
    }

    fn trigger_fault(kind: &str) -> Result<Value, ProtocolError> {
        match kind {
            "fuel" => {
                let mut state = 0x9e3779b97f4a7c15u64;
                loop {
                    state = black_box(state.rotate_left(7).wrapping_mul(0xd6e8feb86659fd93));
                }
            }
            "cancel" => loop {
                std::thread::sleep(Duration::from_secs(60));
            },
            "trap" => panic!("candlescope wasm reference trap"),
            "memory" => {
                let mut blocks: Vec<Vec<u8>> = Vec::new();
                loop {
                    blocks.push(vec![0xa5; 1024 * 1024]);
                    black_box(blocks.len());
                }
            }
            "stderr" => {
                let block = vec![b'S'; 128 * 1024];
                let mut stderr = io::stderr().lock();
                for _ in 0..16 {
                    stderr
                        .write_all(&block)
                        .map_err(|error| ProtocolError::invalid(error.to_string()))?;
                }
                stderr
                    .flush()
                    .map_err(|error| ProtocolError::invalid(error.to_string()))?;
                Ok(Value::object([("written", Value::Bool(true))]))
            }
            value => Err(ProtocolError::invalid(format!(
                "unsupported fault mode {value}"
            ))),
        }
    }

    fn sandbox_probe() -> Value {
        let external_file_read = fs::read("/etc/passwd").is_ok()
            || fs::read("C:\\Windows\\System32\\drivers\\etc\\hosts").is_ok();
        let environment_count = env::vars().count() as u64;
        let network_connected = TcpStream::connect("127.0.0.1:9").is_ok();
        let process_started = Command::new("candlescope-wasm-should-not-exist")
            .status()
            .is_ok();
        Value::object([
            ("environmentCount", Value::unsigned(environment_count)),
            ("externalFileRead", Value::Bool(external_file_read)),
            ("networkConnected", Value::Bool(network_connected)),
            ("processStarted", Value::Bool(process_started)),
        ])
    }
}

impl Plugin for WasmReference {
    fn descriptor_json(&self) -> &'static str {
        DESCRIPTOR
    }

    fn invoke(
        &mut self,
        contribution_id: &str,
        input: &Value,
        _request_context: &Value,
    ) -> Result<Value, ProtocolError> {
        if contribution_id != "wasm-hello" {
            return Err(ProtocolError::new(
                -32107,
                "CONTRIBUTION_NOT_DECLARED",
                "unknown WASM reference contribution",
            ));
        }
        if let Some(fault) = Self::fault(input)? {
            return Self::trigger_fault(fault);
        }
        if matches!(
            input.optional_field("sandboxProbe")?,
            Some(Value::Bool(true))
        ) {
            return Ok(Self::sandbox_probe());
        }
        let name = input
            .optional_field("name")?
            .map(Value::as_str)
            .transpose()?
            .unwrap_or("world")
            .trim();
        if name.len() > 1024 {
            return Err(ProtocolError::invalid("name exceeds 1024 UTF-8 bytes"));
        }
        let mut sum = 0u64;
        if let Some(numbers) = input.optional_field("numbers")? {
            for value in numbers.as_array()? {
                sum = sum
                    .checked_add(value.as_u64()?)
                    .filter(|value| *value <= MAX_SAFE_INTEGER)
                    .ok_or_else(|| ProtocolError::invalid("sum exceeds JSON safe range"))?;
            }
        }
        Ok(Value::object([
            ("message", Value::from(format!("Hello from WASM, {name}!"))),
            ("sum", Value::unsigned(sum)),
        ]))
    }
}

fn main() {
    if let Err(message) = serve(WasmReference) {
        eprintln!("WASM reference plugin failed: {message}");
        std::process::exit(2);
    }
}
