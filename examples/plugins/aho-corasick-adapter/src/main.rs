use aho_corasick::{AhoCorasick, AhoCorasickBuilder, Match, MatchKind};
use candlescope_plugin_sdk::{serve, Plugin, ProtocolError, Value};

const MAX_PATTERNS: usize = 1_024;
const MAX_PATTERN_BYTES: usize = 256 * 1_024;
const MAX_HAYSTACK_BYTES: usize = 256 * 1_024;
const MAX_MATCHES: usize = 10_000;

const DESCRIPTOR: &str = concat!(
    r#"{"contributions":[{"entrypoint":"main","id":"candlescope-aho-corasick","kind":"command/1","title":"Run aho-corasick Search"}],"#,
    r#""entrypointId":"main","features":[],"hostApis":{"optional":[],"required":[]},"#,
    r#""permissions":{"optional":[],"required":[]},"#,
    r#""plugin":{"id":"candlescope.aho-corasick","name":"aho-corasick Search","publisher":"candlescope-contributors","version":"0.1.0"},"#,
    r#""protocol":"candlescope.plugin/2"}"#,
);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SearchKind {
    Standard,
    LeftmostFirst,
    LeftmostLongest,
}

impl SearchKind {
    fn parse(value: Option<&Value>) -> Result<Self, ProtocolError> {
        match value.map(Value::as_str).transpose()?.unwrap_or("standard") {
            "standard" => Ok(Self::Standard),
            "leftmost-first" => Ok(Self::LeftmostFirst),
            "leftmost-longest" => Ok(Self::LeftmostLongest),
            _ => Err(ProtocolError::invalid(
                "matchKind must be standard, leftmost-first, or leftmost-longest",
            )),
        }
    }

    fn upstream(self) -> MatchKind {
        match self {
            Self::Standard => MatchKind::Standard,
            Self::LeftmostFirst => MatchKind::LeftmostFirst,
            Self::LeftmostLongest => MatchKind::LeftmostLongest,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::LeftmostFirst => "leftmost-first",
            Self::LeftmostLongest => "leftmost-longest",
        }
    }
}

struct SearchInput {
    patterns: Vec<String>,
    haystack: String,
    match_kind: SearchKind,
    ascii_case_insensitive: bool,
    overlapping: bool,
    max_matches: usize,
}

impl SearchInput {
    fn parse(input: &Value) -> Result<Self, ProtocolError> {
        let object = input.as_object()?;
        for key in object.keys() {
            if !matches!(
                key.as_str(),
                "patterns"
                    | "haystack"
                    | "matchKind"
                    | "asciiCaseInsensitive"
                    | "overlapping"
                    | "maxMatches"
            ) {
                return Err(ProtocolError::invalid(format!(
                    "unknown search input field {key}"
                )));
            }
        }
        let pattern_values = input.field("patterns")?.as_array()?;
        if pattern_values.is_empty() || pattern_values.len() > MAX_PATTERNS {
            return Err(ProtocolError::invalid(
                "patterns must contain between 1 and 1024 strings",
            ));
        }
        let mut patterns = Vec::with_capacity(pattern_values.len());
        let mut pattern_bytes = 0usize;
        for value in pattern_values {
            let pattern = value.as_str()?;
            if pattern.is_empty() {
                return Err(ProtocolError::invalid(
                    "patterns must not contain empty strings",
                ));
            }
            pattern_bytes = pattern_bytes
                .checked_add(pattern.len())
                .ok_or_else(|| ProtocolError::invalid("pattern byte count overflowed"))?;
            if pattern_bytes > MAX_PATTERN_BYTES {
                return Err(ProtocolError::invalid("patterns exceed 256 KiB in total"));
            }
            patterns.push(pattern.to_owned());
        }
        let haystack = input.field("haystack")?.as_str()?;
        if haystack.len() > MAX_HAYSTACK_BYTES {
            return Err(ProtocolError::invalid("haystack exceeds 256 KiB"));
        }
        let match_kind = SearchKind::parse(input.optional_field("matchKind")?)?;
        let ascii_case_insensitive = input
            .optional_field("asciiCaseInsensitive")?
            .map(Value::as_bool)
            .transpose()?
            .unwrap_or(false);
        let overlapping = input
            .optional_field("overlapping")?
            .map(Value::as_bool)
            .transpose()?
            .unwrap_or(false);
        if overlapping && match_kind != SearchKind::Standard {
            return Err(ProtocolError::invalid(
                "overlapping search is supported only with standard matchKind",
            ));
        }
        let max_matches = input
            .optional_field("maxMatches")?
            .map(Value::as_u64)
            .transpose()?
            .unwrap_or(1_000);
        if max_matches == 0 || max_matches > MAX_MATCHES as u64 {
            return Err(ProtocolError::invalid(
                "maxMatches must be between 1 and 10000",
            ));
        }
        Ok(Self {
            patterns,
            haystack: haystack.to_owned(),
            match_kind,
            ascii_case_insensitive,
            overlapping,
            max_matches: max_matches as usize,
        })
    }

    fn automaton(&self) -> Result<AhoCorasick, ProtocolError> {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(self.ascii_case_insensitive)
            .match_kind(self.match_kind.upstream())
            .build(&self.patterns)
            .map_err(|error| ProtocolError::invalid(format!("aho-corasick build failed: {error}")))
    }
}

fn collect_matches(matches: impl Iterator<Item = Match>, maximum: usize) -> (Vec<Value>, bool) {
    let mut output = Vec::with_capacity(maximum.min(1_024));
    let mut truncated = false;
    for item in matches {
        if output.len() == maximum {
            truncated = true;
            break;
        }
        output.push(Value::object([
            ("endByte", Value::unsigned(item.end() as u64)),
            (
                "patternIndex",
                Value::unsigned(item.pattern().as_usize() as u64),
            ),
            ("startByte", Value::unsigned(item.start() as u64)),
        ]));
    }
    (output, truncated)
}

fn search(input: &Value) -> Result<Value, ProtocolError> {
    let request = SearchInput::parse(input)?;
    let automaton = request.automaton()?;
    let (matches, truncated) = if request.overlapping {
        collect_matches(
            automaton.find_overlapping_iter(request.haystack.as_bytes()),
            request.max_matches,
        )
    } else {
        collect_matches(
            automaton.find_iter(request.haystack.as_bytes()),
            request.max_matches,
        )
    };
    Ok(Value::object([
        (
            "asciiCaseInsensitive",
            Value::Bool(request.ascii_case_insensitive),
        ),
        (
            "haystackBytes",
            Value::unsigned(request.haystack.len() as u64),
        ),
        ("matchKind", Value::from(request.match_kind.wire())),
        ("matches", Value::array(matches)),
        ("overlapping", Value::Bool(request.overlapping)),
        (
            "patternCount",
            Value::unsigned(request.patterns.len() as u64),
        ),
        (
            "schemaVersion",
            Value::from("candlescope.aho-corasick.matches/1"),
        ),
        ("truncated", Value::Bool(truncated)),
        (
            "upstream",
            Value::object([
                (
                    "commit",
                    Value::from("17f8b32e3b7c845ef3c5429b823804f552f14ec9"),
                ),
                ("name", Value::from("aho-corasick")),
                ("version", Value::from("1.1.4")),
            ]),
        ),
    ]))
}

struct AhoCorasickAdapter;

impl Plugin for AhoCorasickAdapter {
    fn descriptor_json(&self) -> &'static str {
        DESCRIPTOR
    }

    fn invoke(
        &mut self,
        contribution_id: &str,
        input: &Value,
        _request_context: &Value,
    ) -> Result<Value, ProtocolError> {
        if contribution_id != "candlescope-aho-corasick" {
            return Err(ProtocolError::new(
                -32107,
                "CONTRIBUTION_NOT_DECLARED",
                "unknown aho-corasick Adapter contribution",
            ));
        }
        search(input)
    }

    fn health_check(&mut self) -> Result<Value, ProtocolError> {
        Ok(Value::object([
            ("status", Value::from("ready")),
            ("upstream", Value::from("aho-corasick@1.1.4")),
        ]))
    }
}

fn main() {
    if let Err(message) = serve(AhoCorasickAdapter) {
        eprintln!("aho-corasick Adapter failed: {message}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(patterns: &[&str], haystack: &str) -> Value {
        Value::object([
            (
                "patterns",
                Value::array(patterns.iter().map(|value| Value::from(*value))),
            ),
            ("haystack", Value::from(haystack)),
        ])
    }

    #[test]
    fn delegates_matching_to_upstream_and_reports_byte_offsets() {
        let result = search(&request(&["needle", "波浪"], "x波浪-needle-y")).unwrap();
        let matches = result.field("matches").unwrap().as_array().unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].field("startByte").unwrap().as_u64().unwrap(), 1);
        assert_eq!(matches[0].field("endByte").unwrap().as_u64().unwrap(), 7);
        assert_eq!(
            result.field("schemaVersion").unwrap().as_str().unwrap(),
            "candlescope.aho-corasick.matches/1"
        );
    }

    #[test]
    fn overlapping_and_truncation_are_explicit() {
        let input = Value::object([
            (
                "patterns",
                Value::array([Value::from("aba"), Value::from("ba")]),
            ),
            ("haystack", Value::from("ababa")),
            ("overlapping", Value::Bool(true)),
            ("maxMatches", Value::unsigned(2)),
        ]);
        let result = search(&input).unwrap();
        assert_eq!(
            result.field("matches").unwrap().as_array().unwrap().len(),
            2
        );
        assert!(result.field("truncated").unwrap().as_bool().unwrap());
    }

    #[test]
    fn unsafe_or_ambiguous_inputs_fail_closed() {
        let empty = request(&[""], "haystack");
        assert!(search(&empty).is_err());
        let invalid = Value::object([
            ("patterns", Value::array([Value::from("a")])),
            ("haystack", Value::from("a")),
            ("matchKind", Value::from("leftmost-longest")),
            ("overlapping", Value::Bool(true)),
        ]);
        assert!(search(&invalid).is_err());
    }
}
