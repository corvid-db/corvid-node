//! Error mapping: engine errors → `CorvidErr` carrying the FFI error
//! code (docs/FFI.md §1.3, frozen 0..=19) so the JS layer can surface a
//! `CorvidError` with `code` + `message`.
//!
//! The wire form across the napi boundary is a JSON object in the
//! thrown Error's message (`{"corvidCode":N,"corvidMessage":"..."}`);
//! `index.js` parses it and rethrows a real `CorvidError` subclass of
//! `Error`. napi-rs cannot attach properties to thrown errors, which
//! is why the code rides in the message.

use corvid::Error;

/// The error-code table, value-identical to the C ABI's `corvid_err`
/// (docs/FFI.md §1.3). The golden fixtures pin behaviors to these
/// numbers, so the mapping must not drift from the engine enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(non_camel_case_types)]
pub enum ErrCode {
    Database = 1,
    Transaction = 2,
    Table = 3,
    Storage = 4,
    Commit = 5,
    SetDurability = 6,
    Compaction = 7,
    Decode = 8,
    CorruptIndex = 9,
    ReservedCollection = 10,
    InvalidName = 11,
    Argument = 12,
    IncompatibleFormat = 13,
    EmptyIndexTraining = 14,
    SchemaViolation = 15,
    InvalidDump = 16,
    BackupTargetExists = 17,
    Io = 18,
    /// FFI/binding-only: compact while derived handles are open.
    Busy = 19,
}

impl ErrCode {
    pub fn num(self) -> u32 {
        self as u32
    }
}

/// The internal error type: an FFI code + engine message.
#[derive(Debug)]
pub struct CorvidErr {
    pub code: u32,
    pub message: String,
}

impl CorvidErr {
    pub fn new(code: ErrCode, message: impl Into<String>) -> Self {
        Self {
            code: code.num(),
            message: message.into(),
        }
    }

    pub fn argument(message: impl Into<String>) -> Self {
        Self::new(ErrCode::Argument, message)
    }

    /// Render the thrown napi error message (the JS layer's wire form).
    fn wire(&self) -> String {
        format!(
            "{{\"corvidCode\":{},\"corvidMessage\":{}}}",
            self.code,
            json_string(&self.message)
        )
    }
}

/// Minimal JSON string escaping (no serde dependency).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl From<Error> for CorvidErr {
    fn from(e: Error) -> Self {
        let (code, message) = match &e {
            Error::Database(_) => (ErrCode::Database, e.to_string()),
            Error::Transaction(_) => (ErrCode::Transaction, e.to_string()),
            Error::Table(_) => (ErrCode::Table, e.to_string()),
            Error::Storage(_) => (ErrCode::Storage, e.to_string()),
            Error::Commit(_) => (ErrCode::Commit, e.to_string()),
            Error::SetDurability(_) => (ErrCode::SetDurability, e.to_string()),
            Error::Compaction(_) => (ErrCode::Compaction, e.to_string()),
            Error::Decode(_) => (ErrCode::Decode, e.to_string()),
            Error::CorruptIndex { context } => (
                ErrCode::CorruptIndex,
                format!("corrupt index state: {context}"),
            ),
            Error::ReservedCollection(n) => (
                ErrCode::ReservedCollection,
                format!("reserved collection name: {n}"),
            ),
            Error::InvalidName(n) => (
                ErrCode::InvalidName,
                format!("invalid name (NUL byte or `__` is not allowed): {n}"),
            ),
            Error::InvalidArgument(m) => (ErrCode::Argument, format!("invalid argument: {m}")),
            Error::IncompatibleFormat { found, expected } => (
                ErrCode::IncompatibleFormat,
                format!("incompatible format: file is v{found}, engine expects v{expected}"),
            ),
            Error::EmptyIndexTraining => (
                ErrCode::EmptyIndexTraining,
                "cannot train a PQ codebook: no usable training vectors".to_string(),
            ),
            Error::SchemaViolation(m) => {
                (ErrCode::SchemaViolation, format!("schema violation: {m}"))
            }
            Error::InvalidDump(m) => (ErrCode::InvalidDump, format!("invalid dump: {m}")),
            Error::BackupTargetExists(p) => (
                ErrCode::BackupTargetExists,
                format!("backup target already exists: {p}"),
            ),
            Error::Io(_) => (ErrCode::Io, e.to_string()),
            // The engine enum is #[non_exhaustive]; unknown future
            // variants surface as a storage-flavored error rather than
            // failing to compile the binding.
            _ => (ErrCode::Storage, e.to_string()),
        };
        CorvidErr {
            code: code.num(),
            message,
        }
    }
}

impl From<CorvidErr> for napi::Error {
    fn from(e: CorvidErr) -> napi::Error {
        napi::Error::new(napi::Status::GenericFailure, e.wire())
    }
}

impl From<napi::Error> for CorvidErr {
    fn from(e: napi::Error) -> Self {
        CorvidErr {
            code: ErrCode::Argument.num(),
            message: e.reason,
        }
    }
}

pub type CResult<T> = Result<T, CorvidErr>;
