use std::collections::BTreeMap;
use std::env;
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::process::Command;
use std::thread;
use std::time::Duration;

const DESCRIPTOR: &str = concat!(
    r#"{"contributions":[{"entrypoint":"main","id":"hello","kind":"command/1","title":"Say hello"}],"#,
    r#""entrypointId":"main","features":[],"hostApis":{"optional":[],"required":[]},"#,
    r#""permissions":{"optional":[],"required":[]},"#,
    r#""plugin":{"id":"candlescope.native-reference","name":"CandleScope Native Reference","#,
    r#""publisher":"candlescope","version":"0.1.0"},"protocol":"candlescope.plugin/2"}"#,
);

#[derive(Clone, Debug)]
enum Json {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array,
    Object(BTreeMap<String, Json>),
}

struct Parser<'a> {
    source: &'a str,
    offset: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self { source, offset: 0 }
    }

    fn parse(mut self) -> Result<Json, String> {
        self.skip_whitespace();
        let value = self.value()?;
        self.skip_whitespace();
        if self.offset != self.source.len() {
            return Err("trailing JSON content".into());
        }
        Ok(value)
    }

    fn value(&mut self) -> Result<Json, String> {
        self.skip_whitespace();
        match self.peek() {
            Some('n') => {
                self.literal("null")?;
                Ok(Json::Null)
            }
            Some('t') => {
                self.literal("true")?;
                Ok(Json::Bool(true))
            }
            Some('f') => {
                self.literal("false")?;
                Ok(Json::Bool(false))
            }
            Some('"') => Ok(Json::String(self.string()?)),
            Some('[') => self.array(),
            Some('{') => self.object(),
            Some('-' | '0'..='9') => self.number(),
            _ => Err("invalid JSON value".into()),
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.expect('{')?;
        self.skip_whitespace();
        let mut values = BTreeMap::new();
        if self.take('}') {
            return Ok(Json::Object(values));
        }
        loop {
            self.skip_whitespace();
            let key = self.string()?;
            self.skip_whitespace();
            self.expect(':')?;
            let value = self.value()?;
            if values.insert(key, value).is_some() {
                return Err("duplicate JSON object key".into());
            }
            self.skip_whitespace();
            if self.take('}') {
                return Ok(Json::Object(values));
            }
            self.expect(',')?;
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.expect('[')?;
        self.skip_whitespace();
        if self.take(']') {
            return Ok(Json::Array);
        }
        loop {
            self.value()?;
            self.skip_whitespace();
            if self.take(']') {
                return Ok(Json::Array);
            }
            self.expect(',')?;
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut output = String::new();
        loop {
            let value = self.next().ok_or("unterminated JSON string")?;
            match value {
                '"' => return Ok(output),
                '\\' => match self.next().ok_or("unterminated JSON escape")? {
                    '"' => output.push('"'),
                    '\\' => output.push('\\'),
                    '/' => output.push('/'),
                    'b' => output.push('\u{0008}'),
                    'f' => output.push('\u{000c}'),
                    'n' => output.push('\n'),
                    'r' => output.push('\r'),
                    't' => output.push('\t'),
                    'u' => {
                        let first = self.hex_quad()?;
                        if (0xD800..=0xDBFF).contains(&first) {
                            self.expect('\\')?;
                            self.expect('u')?;
                            let second = self.hex_quad()?;
                            if !(0xDC00..=0xDFFF).contains(&second) {
                                return Err("invalid JSON surrogate pair".into());
                            }
                            let scalar = 0x10000
                                + (((first as u32) - 0xD800) << 10)
                                + ((second as u32) - 0xDC00);
                            output.push(char::from_u32(scalar).ok_or("invalid Unicode scalar")?);
                        } else if (0xDC00..=0xDFFF).contains(&first) {
                            return Err("unpaired JSON low surrogate".into());
                        } else {
                            output.push(
                                char::from_u32(first as u32).ok_or("invalid Unicode scalar")?,
                            );
                        }
                    }
                    _ => return Err("unsupported JSON escape".into()),
                },
                character if character <= '\u{001f}' => {
                    return Err("control character in JSON string".into())
                }
                character => output.push(character),
            }
        }
    }

    fn hex_quad(&mut self) -> Result<u16, String> {
        let mut value = 0u16;
        for _ in 0..4 {
            let digit = self.next().and_then(|item| item.to_digit(16));
            value = value
                .checked_mul(16)
                .and_then(|item| item.checked_add(digit? as u16))
                .ok_or("invalid JSON Unicode escape")?;
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.offset;
        self.take('-');
        if self.take('0') {
            if matches!(self.peek(), Some('0'..='9')) {
                return Err("JSON number has a leading zero".into());
            }
        } else {
            self.digits(true)?;
        }
        if self.take('.') {
            self.digits(true)?;
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.next();
            if matches!(self.peek(), Some('+' | '-')) {
                self.next();
            }
            self.digits(true)?;
        }
        Ok(Json::Number(self.source[start..self.offset].to_string()))
    }

    fn digits(&mut self, required: bool) -> Result<(), String> {
        let start = self.offset;
        while matches!(self.peek(), Some('0'..='9')) {
            self.next();
        }
        if required && start == self.offset {
            return Err("JSON number requires a digit".into());
        }
        Ok(())
    }

    fn literal(&mut self, expected: &str) -> Result<(), String> {
        if self.source[self.offset..].starts_with(expected) {
            self.offset += expected.len();
            Ok(())
        } else {
            Err("invalid JSON literal".into())
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(' ' | '\n' | '\r' | '\t')) {
            self.next();
        }
    }

    fn expect(&mut self, expected: char) -> Result<(), String> {
        if self.take(expected) {
            Ok(())
        } else {
            Err(format!("expected JSON character {expected:?}"))
        }
    }

    fn take(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.next();
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<char> {
        self.source[self.offset..].chars().next()
    }

    fn next(&mut self) -> Option<char> {
        let value = self.peek()?;
        self.offset += value.len_utf8();
        Some(value)
    }
}

fn object(value: &Json) -> Result<&BTreeMap<String, Json>, String> {
    match value {
        Json::Object(value) => Ok(value),
        _ => Err("JSON value must be an object".into()),
    }
}

fn object_field<'a>(
    value: &'a BTreeMap<String, Json>,
    key: &str,
) -> Result<&'a BTreeMap<String, Json>, String> {
    object(
        value
            .get(key)
            .ok_or_else(|| format!("missing field {key}"))?,
    )
}

fn string_field(value: &BTreeMap<String, Json>, key: &str) -> Result<String, String> {
    match value.get(key) {
        Some(Json::String(value)) => Ok(value.clone()),
        _ => Err(format!("field {key} must be a string")),
    }
}

fn optional_string(value: &BTreeMap<String, Json>, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(Json::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("field {key} must be a string")),
    }
}

fn optional_bool(value: &BTreeMap<String, Json>, key: &str) -> Result<bool, String> {
    match value.get(key) {
        None => Ok(false),
        Some(Json::Bool(value)) => Ok(*value),
        _ => Err(format!("field {key} must be a boolean")),
    }
}

fn integer_field(value: &BTreeMap<String, Json>, key: &str) -> Result<u64, String> {
    match value.get(key) {
        Some(Json::Number(value)) => value
            .parse::<u64>()
            .map_err(|_| format!("field {key} must be an unsigned integer")),
        _ => Err(format!("field {key} must be an integer")),
    }
}

fn quote(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if value <= '\u{001f}' => {
                output.push_str(&format!("\\u{:04x}", value as u32));
            }
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

fn success(id: &str, generation: u64, result: &str) -> String {
    format!(
        r#"{{"generation":{generation},"id":{},"jsonrpc":"2.0","result":{result}}}"#,
        quote(id)
    )
}

fn failure(id: &str, generation: u64, rpc_code: i64, code: &str, message: &str) -> String {
    format!(
        concat!(
            r#"{{"error":{{"code":{rpc_code},"data":{{"code":{code}}},"message":{message}}},"#,
            r#""generation":{generation},"id":{id},"jsonrpc":"2.0"}}"#
        ),
        rpc_code = rpc_code,
        code = quote(code),
        message = quote(message),
        generation = generation,
        id = quote(id),
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Good,
    CrashStart,
    CrashInvoke,
    HangStart,
    HangInvoke,
    InvalidUtf8,
    SpawnChild,
    SandboxProbe,
    StderrFlood,
    StdoutPollution,
}

fn arguments() -> Result<(Mode, bool, Option<String>, Option<String>), String> {
    let values: Vec<String> = env::args().skip(1).collect();
    if values == ["--child"] {
        return Ok((Mode::Good, true, None, None));
    }
    let mut mode = Mode::Good;
    let mut outside_executable = None;
    let mut outside_file = None;
    let mut index = 0;
    while index < values.len() {
        match values[index].as_str() {
            "--jsonl" => index += 1,
            "--mode" if index + 1 < values.len() => {
                mode = match values[index + 1].as_str() {
                    "good" => Mode::Good,
                    "crash-start" => Mode::CrashStart,
                    "crash-invoke" => Mode::CrashInvoke,
                    "hang-start" => Mode::HangStart,
                    "hang-invoke" => Mode::HangInvoke,
                    "invalid-utf8" => Mode::InvalidUtf8,
                    "spawn-child" => Mode::SpawnChild,
                    "sandbox-probe" => Mode::SandboxProbe,
                    "stderr-flood" => Mode::StderrFlood,
                    "stdout-pollution" => Mode::StdoutPollution,
                    value => return Err(format!("unsupported --mode {value}")),
                };
                index += 2;
            }
            "--outside-executable" if index + 1 < values.len() => {
                outside_executable = Some(values[index + 1].clone());
                index += 2;
            }
            "--outside-file" if index + 1 < values.len() => {
                outside_file = Some(values[index + 1].clone());
                index += 2;
            }
            value => return Err(format!("unsupported argument {value}")),
        }
    }
    if mode == Mode::SandboxProbe && (outside_executable.is_none() || outside_file.is_none()) {
        return Err("sandbox-probe requires outside executable and file paths".into());
    }
    Ok((mode, false, outside_executable, outside_file))
}

fn run() -> Result<i32, String> {
    let (mode, child, outside_executable, outside_file) = arguments()?;
    if child {
        thread::sleep(Duration::from_secs(120));
        return Ok(0);
    }
    if mode == Mode::CrashStart {
        return Ok(17);
    }
    if mode == Mode::StdoutPollution {
        println!("native plugin wrote a log to stdout");
    }
    if mode == Mode::InvalidUtf8 {
        io::stdout()
            .write_all(&[0xff, b'\n'])
            .map_err(|error| error.to_string())?;
        return Ok(0);
    }
    if mode == Mode::StderrFlood {
        io::stderr()
            .write_all(&vec![b'S'; 200_000])
            .map_err(|error| error.to_string())?;
        io::stderr().flush().map_err(|error| error.to_string())?;
    }

    let child_pid = if mode == Mode::SpawnChild {
        Command::new(env::current_exe().map_err(|error| error.to_string())?)
            .arg("--child")
            .spawn()
            .map(|process| process.id())
            .unwrap_or(0)
    } else {
        0
    };
    let sandbox_evidence = if mode == Mode::SandboxProbe {
        let external_file_read = File::open(
            outside_file
                .as_deref()
                .ok_or("sandbox-probe outside file is unavailable")?,
        )
        .is_ok();
        let external_executable_started = match Command::new(
            outside_executable
                .as_deref()
                .ok_or("sandbox-probe outside executable is unavailable")?,
        )
        .arg("--child")
        .spawn()
        {
            Ok(mut process) => {
                let _ = process.kill();
                let _ = process.wait();
                true
            }
            Err(_) => false,
        };
        Some((external_executable_started, external_file_read))
    } else {
        None
    };
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut pending: Option<String> = None;
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        let request_value = Parser::new(&line).parse()?;
        let request = object(&request_value)?;
        if string_field(request, "jsonrpc")? != "2.0" {
            return Err("unsupported JSON-RPC version".into());
        }
        let id = string_field(request, "id")?;
        let method = string_field(request, "method")?;
        let generation = integer_field(request, "generation")?;
        let params = object_field(request, "params")?;
        if mode == Mode::HangStart && method == "handshake" {
            thread::sleep(Duration::from_secs(30));
        }
        if mode == Mode::HangInvoke && method == "invoke" {
            thread::sleep(Duration::from_secs(30));
        }
        if mode == Mode::CrashInvoke && method == "invoke" {
            return Ok(23);
        }
        let mut responses = Vec::new();
        let shutdown = method == "shutdown";
        match method.as_str() {
            "handshake" => responses.push(success(
                &id,
                0,
                &format!(
                    concat!(
                        r#"{{"descriptor":{DESCRIPTOR},"negotiatedHostApis":[],"#,
                        r#""protocol":"candlescope.plugin/2","transport":"jsonl/1"}}"#
                    ),
                    DESCRIPTOR = DESCRIPTOR,
                ),
            )),
            "describe" => responses.push(success(&id, 0, DESCRIPTOR)),
            "activate" => {
                let instance_id = string_field(params, "instanceId")?;
                let activated_generation = integer_field(params, "generation")?;
                responses.push(success(
                    &id,
                    generation,
                    &format!(
                        r#"{{"generation":{activated_generation},"instanceId":{},"ok":true}}"#,
                        quote(&instance_id)
                    ),
                ));
            }
            "invoke" => {
                let contribution_id = string_field(params, "contributionId")?;
                if contribution_id != "hello" {
                    responses.push(failure(
                        &id,
                        generation,
                        -32602,
                        "INVALID_CONTRACT",
                        "unknown contribution",
                    ));
                } else {
                    let input = object_field(params, "input")?;
                    let defer = optional_bool(input, "defer")?;
                    if defer {
                        pending = Some(id.clone());
                    } else {
                        let name = optional_string(input, "name")?
                            .unwrap_or_else(|| "world".into())
                            .trim()
                            .to_string();
                        let child_field = if mode == Mode::SpawnChild {
                            format!(r#","childPid":{child_pid}"#)
                        } else if let Some((external_executable_started, external_file_read)) =
                            sandbox_evidence
                        {
                            format!(
                                concat!(
                                    r#","externalExecutableStarted":{},"#,
                                    r#""externalFileRead":{}"#
                                ),
                                if external_executable_started {
                                    "true"
                                } else {
                                    "false"
                                },
                                if external_file_read { "true" } else { "false" },
                            )
                        } else {
                            String::new()
                        };
                        responses.push(success(
                            &id,
                            generation,
                            &format!(
                                r#"{{"contributionId":"hello"{child_field},"message":{}}}"#,
                                quote(&format!("Hello, {name}!"))
                            ),
                        ));
                    }
                }
            }
            "healthCheck" => responses.push(success(
                &id,
                generation,
                &format!(
                    r#"{{"pending":{},"status":"ready"}}"#,
                    usize::from(pending.is_some())
                ),
            )),
            "cancel" => {
                let request_id = string_field(params, "requestId")?;
                let cancelled = pending.as_deref() == Some(request_id.as_str());
                if cancelled {
                    responses.push(failure(
                        &request_id,
                        generation,
                        -32800,
                        "REQUEST_CANCELLED",
                        "The invocation was cancelled by the host.",
                    ));
                    pending = None;
                }
                responses.push(success(
                    &id,
                    generation,
                    &format!(
                        r#"{{"cancelled":{},"requestId":{}}}"#,
                        if cancelled { "true" } else { "false" },
                        quote(&request_id)
                    ),
                ));
            }
            "deactivate" => {
                pending = None;
                responses.push(success(&id, generation, r#"{"ok":true}"#));
            }
            "shutdown" => responses.push(success(&id, 0, r#"{"ok":true}"#)),
            _ => responses.push(failure(
                &id,
                generation,
                -32601,
                "METHOD_NOT_FOUND",
                "unsupported method",
            )),
        }
        for response in responses {
            writeln!(stdout, "{response}").map_err(|error| error.to_string())?;
        }
        stdout.flush().map_err(|error| error.to_string())?;
        if shutdown {
            return Ok(0);
        }
    }
    Ok(0)
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("native reference plugin failed: {message}");
            std::process::exit(2);
        }
    }
}
