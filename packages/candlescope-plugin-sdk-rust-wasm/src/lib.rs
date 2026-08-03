//! Dependency-free CandleScope Plugin Platform v2 server for `wasm32-wasip2`.

use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

pub const PROTOCOL: &str = "candlescope.plugin/2";
pub const TRANSPORT: &str = "jsonl/1";
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_DEPTH: usize = 32;
pub const MAX_CONTAINER_ITEMS: usize = 10_000;
pub const MAX_STRING_BYTES: usize = 256 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    pub fn object(items: impl IntoIterator<Item = (impl Into<String>, Value)>) -> Self {
        let mut output = BTreeMap::new();
        for (key, value) in items {
            output.insert(key.into(), value);
        }
        Self::Object(output)
    }

    pub fn array(items: impl IntoIterator<Item = Value>) -> Self {
        Self::Array(items.into_iter().collect())
    }

    pub fn string(value: impl Into<String>) -> Self {
        Self::String(value.into())
    }

    pub fn integer(value: i64) -> Self {
        Self::Number(value.to_string())
    }

    pub fn unsigned(value: u64) -> Self {
        Self::Number(value.to_string())
    }

    pub fn as_object(&self) -> Result<&BTreeMap<String, Value>, ProtocolError> {
        match self {
            Self::Object(value) => Ok(value),
            _ => Err(ProtocolError::invalid("JSON value must be an object")),
        }
    }

    pub fn as_array(&self) -> Result<&[Value], ProtocolError> {
        match self {
            Self::Array(value) => Ok(value),
            _ => Err(ProtocolError::invalid("JSON value must be an array")),
        }
    }

    pub fn as_str(&self) -> Result<&str, ProtocolError> {
        match self {
            Self::String(value) => Ok(value),
            _ => Err(ProtocolError::invalid("JSON value must be a string")),
        }
    }

    pub fn as_bool(&self) -> Result<bool, ProtocolError> {
        match self {
            Self::Bool(value) => Ok(*value),
            _ => Err(ProtocolError::invalid("JSON value must be a boolean")),
        }
    }

    pub fn as_u64(&self) -> Result<u64, ProtocolError> {
        match self {
            Self::Number(value)
                if !value.is_empty()
                    && value.bytes().all(|item| item.is_ascii_digit())
                    && !(value.len() > 1 && value.starts_with('0')) =>
            {
                let parsed = value
                    .parse::<u64>()
                    .map_err(|_| ProtocolError::invalid("integer is out of range"))?;
                if parsed <= MAX_SAFE_INTEGER {
                    Ok(parsed)
                } else {
                    Err(ProtocolError::invalid("integer exceeds JSON safe range"))
                }
            }
            _ => Err(ProtocolError::invalid(
                "JSON value must be an unsigned safe integer",
            )),
        }
    }

    pub fn field<'a>(&'a self, key: &str) -> Result<&'a Value, ProtocolError> {
        self.as_object()?
            .get(key)
            .ok_or_else(|| ProtocolError::invalid(format!("missing field {key}")))
    }

    pub fn optional_field<'a>(&'a self, key: &str) -> Result<Option<&'a Value>, ProtocolError> {
        Ok(self.as_object()?.get(key))
    }

    pub fn to_canonical_json(&self) -> String {
        let mut output = String::new();
        self.write_json(&mut output);
        output
    }

    fn write_json(&self, output: &mut String) {
        match self {
            Self::Null => output.push_str("null"),
            Self::Bool(true) => output.push_str("true"),
            Self::Bool(false) => output.push_str("false"),
            Self::Number(value) => output.push_str(value),
            Self::String(value) => write_quoted(output, value),
            Self::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index != 0 {
                        output.push(',');
                    }
                    value.write_json(output);
                }
                output.push(']');
            }
            Self::Object(values) => {
                output.push('{');
                for (index, (key, value)) in values.iter().enumerate() {
                    if index != 0 {
                        output.push(',');
                    }
                    write_quoted(output, key);
                    output.push(':');
                    value.write_json(output);
                }
                output.push('}');
            }
        }
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

fn write_quoted(output: &mut String, value: &str) {
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
}

struct Parser<'a> {
    source: &'a str,
    offset: usize,
    items: usize,
}

impl<'a> Parser<'a> {
    fn parse(source: &'a str) -> Result<Value, ProtocolError> {
        if source.len() > MAX_MESSAGE_BYTES {
            return Err(ProtocolError::invalid("JSON message exceeds 1 MiB"));
        }
        let mut parser = Self {
            source,
            offset: 0,
            items: 0,
        };
        parser.skip_whitespace();
        let value = parser.value(0)?;
        parser.skip_whitespace();
        if parser.offset != source.len() {
            return Err(ProtocolError::invalid("trailing JSON content"));
        }
        Ok(value)
    }

    fn value(&mut self, depth: usize) -> Result<Value, ProtocolError> {
        if depth > MAX_DEPTH {
            return Err(ProtocolError::invalid("JSON nesting exceeds 32 levels"));
        }
        self.skip_whitespace();
        match self.peek() {
            Some('n') => {
                self.literal("null")?;
                Ok(Value::Null)
            }
            Some('t') => {
                self.literal("true")?;
                Ok(Value::Bool(true))
            }
            Some('f') => {
                self.literal("false")?;
                Ok(Value::Bool(false))
            }
            Some('"') => Ok(Value::String(self.string()?)),
            Some('[') => self.array(depth + 1),
            Some('{') => self.object(depth + 1),
            Some('-' | '0'..='9') => self.number(),
            _ => Err(ProtocolError::invalid("invalid JSON value")),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, ProtocolError> {
        self.expect('{')?;
        self.skip_whitespace();
        let mut values = BTreeMap::new();
        if self.take('}') {
            return Ok(Value::Object(values));
        }
        loop {
            self.add_item()?;
            self.skip_whitespace();
            let key = self.string()?;
            self.skip_whitespace();
            self.expect(':')?;
            let value = self.value(depth)?;
            if values.insert(key, value).is_some() {
                return Err(ProtocolError::invalid("duplicate JSON object key"));
            }
            self.skip_whitespace();
            if self.take('}') {
                return Ok(Value::Object(values));
            }
            self.expect(',')?;
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, ProtocolError> {
        self.expect('[')?;
        self.skip_whitespace();
        let mut values = Vec::new();
        if self.take(']') {
            return Ok(Value::Array(values));
        }
        loop {
            self.add_item()?;
            values.push(self.value(depth)?);
            self.skip_whitespace();
            if self.take(']') {
                return Ok(Value::Array(values));
            }
            self.expect(',')?;
        }
    }

    fn add_item(&mut self) -> Result<(), ProtocolError> {
        self.items += 1;
        if self.items > MAX_CONTAINER_ITEMS {
            Err(ProtocolError::invalid(
                "JSON containers exceed 10000 total items",
            ))
        } else {
            Ok(())
        }
    }

    fn string(&mut self) -> Result<String, ProtocolError> {
        self.expect('"')?;
        let mut output = String::new();
        loop {
            let value = self
                .next()
                .ok_or_else(|| ProtocolError::invalid("unterminated JSON string"))?;
            match value {
                '"' => {
                    if output.len() > MAX_STRING_BYTES {
                        return Err(ProtocolError::invalid("JSON string exceeds 256 KiB"));
                    }
                    return Ok(output);
                }
                '\\' => {
                    match self
                        .next()
                        .ok_or_else(|| ProtocolError::invalid("unterminated JSON escape"))?
                    {
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
                                    return Err(ProtocolError::invalid(
                                        "invalid JSON surrogate pair",
                                    ));
                                }
                                let scalar = 0x10000
                                    + (((first as u32) - 0xD800) << 10)
                                    + ((second as u32) - 0xDC00);
                                output.push(char::from_u32(scalar).ok_or_else(|| {
                                    ProtocolError::invalid("invalid Unicode scalar")
                                })?);
                            } else if (0xDC00..=0xDFFF).contains(&first) {
                                return Err(ProtocolError::invalid("unpaired JSON low surrogate"));
                            } else {
                                output.push(char::from_u32(first as u32).ok_or_else(|| {
                                    ProtocolError::invalid("invalid Unicode scalar")
                                })?);
                            }
                        }
                        _ => return Err(ProtocolError::invalid("unsupported JSON escape")),
                    }
                }
                character if character <= '\u{001f}' => {
                    return Err(ProtocolError::invalid("control character in JSON string"));
                }
                character => output.push(character),
            }
            if output.len() > MAX_STRING_BYTES {
                return Err(ProtocolError::invalid("JSON string exceeds 256 KiB"));
            }
        }
    }

    fn hex_quad(&mut self) -> Result<u16, ProtocolError> {
        let mut value = 0u16;
        for _ in 0..4 {
            let digit = self.next().and_then(|item| item.to_digit(16));
            value = value
                .checked_mul(16)
                .and_then(|item| item.checked_add(digit? as u16))
                .ok_or_else(|| ProtocolError::invalid("invalid JSON Unicode escape"))?;
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<Value, ProtocolError> {
        let start = self.offset;
        self.take('-');
        if self.take('0') {
            if matches!(self.peek(), Some('0'..='9')) {
                return Err(ProtocolError::invalid("JSON number has a leading zero"));
            }
        } else {
            self.digits()?;
        }
        if self.take('.') {
            self.digits()?;
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.next();
            if matches!(self.peek(), Some('+' | '-')) {
                self.next();
            }
            self.digits()?;
        }
        Ok(Value::Number(self.source[start..self.offset].to_owned()))
    }

    fn digits(&mut self) -> Result<(), ProtocolError> {
        let start = self.offset;
        while matches!(self.peek(), Some('0'..='9')) {
            self.next();
        }
        if start == self.offset {
            Err(ProtocolError::invalid("JSON number requires a digit"))
        } else {
            Ok(())
        }
    }

    fn literal(&mut self, expected: &str) -> Result<(), ProtocolError> {
        if self.source[self.offset..].starts_with(expected) {
            self.offset += expected.len();
            Ok(())
        } else {
            Err(ProtocolError::invalid("invalid JSON literal"))
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(' ' | '\n' | '\r' | '\t')) {
            self.next();
        }
    }

    fn expect(&mut self, expected: char) -> Result<(), ProtocolError> {
        if self.take(expected) {
            Ok(())
        } else {
            Err(ProtocolError::invalid(format!(
                "expected JSON character {expected:?}"
            )))
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

pub fn parse_json(source: &str) -> Result<Value, ProtocolError> {
    Parser::parse(source)
}

#[derive(Clone, Debug)]
pub struct ProtocolError {
    pub rpc_code: i64,
    pub code: &'static str,
    pub message: String,
}

impl ProtocolError {
    pub fn new(rpc_code: i64, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            rpc_code,
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(-32602, "INVALID_CONTRACT", message)
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProtocolError {}

pub trait Plugin {
    fn descriptor_json(&self) -> &'static str;

    fn activate(&mut self, _params: &Value) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn invoke(
        &mut self,
        contribution_id: &str,
        input: &Value,
        request_context: &Value,
    ) -> Result<Value, ProtocolError>;

    fn event_batch(&mut self, params: &Value) -> Result<Value, ProtocolError> {
        let count = params.field("events")?.as_array()?.len() as u64;
        Ok(Value::object([("accepted", Value::unsigned(count))]))
    }

    fn health_check(&mut self) -> Result<Value, ProtocolError> {
        Ok(Value::object([("status", Value::from("ready"))]))
    }

    fn cancel(&mut self, _request_id: &str) -> Result<bool, ProtocolError> {
        Ok(false)
    }

    fn prepare_upgrade(&mut self) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn deactivate(&mut self, _reason: &str) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), ProtocolError> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum State {
    Created,
    Handshaken,
    Active,
    Quiescing,
    Closed,
}

struct Server<P: Plugin> {
    plugin: P,
    descriptor: Value,
    state: State,
    generation: u64,
    highest_generation: u64,
}

impl<P: Plugin> Server<P> {
    fn new(plugin: P) -> Result<Self, ProtocolError> {
        let descriptor = parse_json(plugin.descriptor_json())?;
        descriptor.as_object()?;
        Ok(Self {
            plugin,
            descriptor,
            state: State::Created,
            generation: 0,
            highest_generation: 0,
        })
    }

    fn handle(&mut self, request: Value) -> Result<(Value, bool), ProtocolError> {
        let object = request.as_object()?;
        if field_string(object, "jsonrpc")? != "2.0" {
            return Err(ProtocolError::invalid("jsonrpc must be 2.0"));
        }
        let id = field_string(object, "id")?.to_owned();
        let method = field_string(object, "method")?.to_owned();
        let generation = field_u64(object, "generation")?;
        let params = object
            .get("params")
            .ok_or_else(|| ProtocolError::invalid("missing field params"))?;
        params.as_object()?;
        let result = match method.as_str() {
            "handshake" => self.handshake(params, generation)?,
            "describe" => {
                self.require_handshake()?;
                self.require_control_generation(generation)?;
                self.descriptor.clone()
            }
            "activate" => self.activate(params, generation)?,
            "invoke" => self.invoke(params, generation)?,
            "eventBatch" => {
                self.require_active(generation)?;
                self.plugin.event_batch(params)?
            }
            "healthCheck" => {
                self.require_active(generation)?;
                self.plugin.health_check()?
            }
            "cancel" => {
                self.require_active(generation)?;
                let target = params.field("requestId")?.as_str()?;
                let cancelled = self.plugin.cancel(target)?;
                Value::object([
                    ("cancelled", Value::Bool(cancelled)),
                    ("requestId", Value::from(target)),
                ])
            }
            "prepareUpgrade" => {
                self.require_active(generation)?;
                self.state = State::Quiescing;
                self.plugin.prepare_upgrade()?;
                Value::object([("ok", Value::Bool(true))])
            }
            "deactivate" => {
                self.require_active(generation)?;
                let reason = params.field("reason")?.as_str()?;
                self.plugin.deactivate(reason)?;
                self.state = State::Handshaken;
                self.generation = 0;
                Value::object([("ok", Value::Bool(true))])
            }
            "shutdown" => {
                if matches!(self.state, State::Active | State::Quiescing) {
                    self.require_current_generation(generation)?;
                } else if generation != 0 {
                    return Err(ProtocolError::new(
                        -32104,
                        "GENERATION_MISMATCH",
                        "inactive shutdown must use generation 0",
                    ));
                }
                self.plugin.shutdown()?;
                self.state = State::Closed;
                Value::object([("ok", Value::Bool(true))])
            }
            _ => {
                return Err(ProtocolError::new(
                    -32601,
                    "METHOD_NOT_FOUND",
                    format!("unknown Plugin Platform method: {method}"),
                ));
            }
        };
        Ok((
            success(&id, generation, result),
            self.state == State::Closed,
        ))
    }

    fn handshake(&mut self, params: &Value, generation: u64) -> Result<Value, ProtocolError> {
        if self.state != State::Created {
            return Err(ProtocolError::new(
                -32103,
                "HANDSHAKE_ALREADY_COMPLETED",
                "handshake may only complete once",
            ));
        }
        if generation != 0 {
            return Err(ProtocolError::new(
                -32104,
                "GENERATION_MISMATCH",
                "handshake must use generation 0",
            ));
        }
        if !string_array_contains(params.field("protocols")?, PROTOCOL)? {
            return Err(ProtocolError::new(
                -32102,
                "PROTOCOL_UNSUPPORTED",
                "host did not offer candlescope.plugin/2",
            ));
        }
        if !string_array_contains(params.field("transports")?, TRANSPORT)? {
            return Err(ProtocolError::new(
                -32102,
                "TRANSPORT_UNSUPPORTED",
                "host did not offer jsonl/1",
            ));
        }
        let requested_entrypoint = params.field("entrypointId")?.as_str()?;
        if self.descriptor.field("entrypointId")?.as_str()? != requested_entrypoint {
            return Err(ProtocolError::new(
                -32107,
                "ENTRYPOINT_MISMATCH",
                "host requested a different entrypoint",
            ));
        }
        self.state = State::Handshaken;
        Ok(Value::object([
            ("descriptor", self.descriptor.clone()),
            ("negotiatedHostApis", Value::Array(Vec::new())),
            ("protocol", Value::from(PROTOCOL)),
            ("transport", Value::from(TRANSPORT)),
        ]))
    }

    fn activate(&mut self, params: &Value, generation: u64) -> Result<Value, ProtocolError> {
        if self.state != State::Handshaken {
            return Err(ProtocolError::new(
                -32103,
                "ACTIVATION_STATE_INVALID",
                "activate requires a handshaken inactive session",
            ));
        }
        let requested_generation = params.field("generation")?.as_u64()?;
        if generation != requested_generation || generation <= self.highest_generation {
            return Err(ProtocolError::new(
                -32104,
                "GENERATION_MISMATCH",
                "activation generation is stale or inconsistent",
            ));
        }
        params.field("capabilities")?.as_array()?;
        let instance_id = params.field("instanceId")?.as_str()?.to_owned();
        self.plugin.activate(params)?;
        self.generation = generation;
        self.highest_generation = generation;
        self.state = State::Active;
        Ok(Value::object([
            ("generation", Value::unsigned(generation)),
            ("instanceId", Value::from(instance_id)),
            ("ok", Value::Bool(true)),
        ]))
    }

    fn invoke(&mut self, params: &Value, generation: u64) -> Result<Value, ProtocolError> {
        self.require_active(generation)?;
        if self.state == State::Quiescing {
            return Err(ProtocolError::new(
                -32103,
                "PLUGIN_QUIESCING",
                "new invocations are rejected while preparing upgrade",
            ));
        }
        let contribution_id = params.field("contributionId")?.as_str()?;
        let input = params.field("input")?;
        input.as_object()?;
        let request_context = params.field("requestContext")?;
        request_context.as_object()?;
        self.plugin.invoke(contribution_id, input, request_context)
    }

    fn require_handshake(&self) -> Result<(), ProtocolError> {
        if self.state == State::Created {
            Err(ProtocolError::new(
                -32101,
                "HANDSHAKE_REQUIRED",
                "handshake must complete before other methods",
            ))
        } else if self.state == State::Closed {
            Err(ProtocolError::new(
                -32103,
                "SESSION_CLOSED",
                "plugin session is closed",
            ))
        } else {
            Ok(())
        }
    }

    fn require_control_generation(&self, generation: u64) -> Result<(), ProtocolError> {
        if matches!(self.state, State::Active | State::Quiescing) {
            self.require_current_generation(generation)
        } else if generation == 0 {
            Ok(())
        } else {
            Err(ProtocolError::new(
                -32104,
                "GENERATION_MISMATCH",
                "inactive control request must use generation 0",
            ))
        }
    }

    fn require_active(&self, generation: u64) -> Result<(), ProtocolError> {
        self.require_handshake()?;
        if !matches!(self.state, State::Active | State::Quiescing) {
            return Err(ProtocolError::new(
                -32103,
                "PLUGIN_NOT_ACTIVE",
                "method requires an active plugin generation",
            ));
        }
        self.require_current_generation(generation)
    }

    fn require_current_generation(&self, generation: u64) -> Result<(), ProtocolError> {
        if generation == self.generation {
            Ok(())
        } else {
            Err(ProtocolError::new(
                -32104,
                "GENERATION_MISMATCH",
                "request generation does not match the active generation",
            ))
        }
    }
}

fn field_string<'a>(
    value: &'a BTreeMap<String, Value>,
    key: &str,
) -> Result<&'a str, ProtocolError> {
    value
        .get(key)
        .ok_or_else(|| ProtocolError::invalid(format!("missing field {key}")))?
        .as_str()
}

fn field_u64(value: &BTreeMap<String, Value>, key: &str) -> Result<u64, ProtocolError> {
    value
        .get(key)
        .ok_or_else(|| ProtocolError::invalid(format!("missing field {key}")))?
        .as_u64()
}

fn string_array_contains(value: &Value, expected: &str) -> Result<bool, ProtocolError> {
    for item in value.as_array()? {
        if item.as_str()? == expected {
            return Ok(true);
        }
    }
    Ok(false)
}

fn success(id: &str, generation: u64, result: Value) -> Value {
    Value::object([
        ("generation", Value::unsigned(generation)),
        ("id", Value::from(id)),
        ("jsonrpc", Value::from("2.0")),
        ("result", result),
    ])
}

fn failure(id: &str, generation: u64, error: ProtocolError) -> Value {
    Value::object([
        (
            "error",
            Value::object([
                ("code", Value::integer(error.rpc_code)),
                ("data", Value::object([("code", Value::from(error.code))])),
                ("message", Value::from(error.message)),
            ]),
        ),
        ("generation", Value::unsigned(generation)),
        ("id", Value::from(id)),
        ("jsonrpc", Value::from("2.0")),
    ])
}

pub fn serve<P: Plugin>(plugin: P) -> Result<(), String> {
    let mut server = Server::new(plugin).map_err(|error| error.to_string())?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = io::BufWriter::new(stdout.lock());
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = input
            .read_until(b'\n', &mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        if buffer.len() > MAX_MESSAGE_BYTES + 2 {
            return Err("JSONL frame exceeds 1 MiB".into());
        }
        if buffer.last() == Some(&b'\n') {
            buffer.pop();
        }
        if buffer.last() == Some(&b'\r') {
            buffer.pop();
        }
        let source = std::str::from_utf8(&buffer)
            .map_err(|_| "JSONL frame is not valid UTF-8".to_owned())?;
        let request = parse_json(source).map_err(|error| error.to_string())?;
        let request_id = request
            .optional_field("id")
            .ok()
            .flatten()
            .and_then(|value| value.as_str().ok())
            .unwrap_or("unknown")
            .to_owned();
        let generation = request
            .optional_field("generation")
            .ok()
            .flatten()
            .and_then(|value| value.as_u64().ok())
            .unwrap_or(0);
        let (response, closed) = match server.handle(request) {
            Ok(value) => value,
            Err(error) => (failure(&request_id, generation, error), false),
        };
        writeln!(output, "{}", response.to_canonical_json()).map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        if closed {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_json_rejects_duplicate_keys() {
        assert!(parse_json(r#"{"a":1,"a":2}"#).is_err());
    }

    #[test]
    fn canonical_json_sorts_object_keys_and_preserves_unicode() {
        let value = Value::object([("z", Value::integer(1)), ("a", Value::from("波浪\n"))]);
        assert_eq!(value.to_canonical_json(), r#"{"a":"波浪\n","z":1}"#);
    }

    #[test]
    fn generation_is_bounded_to_safe_integer() {
        assert!(Value::Number(MAX_SAFE_INTEGER.to_string()).as_u64().is_ok());
        assert!(Value::Number((MAX_SAFE_INTEGER + 1).to_string())
            .as_u64()
            .is_err());
    }
}
