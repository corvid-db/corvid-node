//! The JS ↔ engine `Value` mapping (docs/PLAN.md §4 — the binding's
//! value contract).
//!
//! JS → engine:
//! - `null` / `undefined`        → `Null`
//! - `boolean`                   → `Bool`
//! - `number`                    → `Int` when it is an integer value,
//!   not `-0`, and within ±2^53 (the exact-f64 integer range); every
//!   other number (`0.5`, `inf`, `NaN`, `-0.0`) → `Float`; a
//!   `CorvidFloat` marker object forces `Float` for integer-valued
//!   doubles
//! - `bigint`                    → `Int` (full i64; out of range throws)
//! - `string`                    → `Text`
//! - `Buffer`/`Uint8Array`       → `Bytes` (copied)
//! - `Float32Array`              → `Vector` (copied)
//! - `Array`                     → `Array` (recursive)
//! - plain object                → `Map` (recursive; string keys)
//!
//! engine → JS:
//! - `Int`   → `number` when within ±2^53, else `BigInt`
//! - `Float` → `number` **with f64 bits preserved** (NaN payloads and
//!   `-0.0` survive the round trip; JS arithmetic may canonicalize NaN
//!   afterwards — compare bits, not `===`, when the payload matters)
//! - `Bytes` → `Buffer`, `Vector` → `Float32Array`, `Map` → plain
//!   object (keys in the engine's sorted order)
//!
//! The Int/Float collapse for safe integers is deliberate and
//! documented: JS numbers are unmarked f64s. The engine's numeric
//! interop (filters, ordering, unique equality) treats `2` and `2.0`
//! as the same value, so the collapse is behavior-preserving; the
//! group-aggregation key tags (`i:2` vs `f:0.5`) remain observable.

use std::collections::BTreeMap;

use corvid::Value;
use napi::bindgen_prelude::{
    BigInt, Buffer, Float32Array, FromNapiValue, Null, Object, ToNapiValue, Unknown, ValueType,
};
use napi::Env;
use napi::JsValue;

use crate::error::{CResult, CorvidErr, ErrCode};

const MAX_SAFE: i64 = 9_007_199_254_740_991; // 2^53 - 1

/// Lift a napi-layer error into `CorvidErr` (code 12 — argument).
pub fn napi_wrap(e: napi::Error) -> CorvidErr {
    CorvidErr {
        code: ErrCode::Argument.num(),
        message: e.reason,
    }
}

fn argument(msg: &str) -> CorvidErr {
    CorvidErr::new(ErrCode::Argument, msg)
}

/// Convert an arbitrary JS value into an engine `Value`.
pub fn value_from_js(u: &Unknown) -> CResult<Value> {
    match u.get_type().map_err(napi_wrap)? {
        ValueType::Null | ValueType::Undefined => Ok(Value::Null),
        ValueType::Boolean => Ok(Value::Bool(bool::from_unknown(*u).map_err(napi_wrap)?)),
        ValueType::Number => {
            let n = f64::from_unknown(*u).map_err(napi_wrap)?;
            if n.is_finite()
                && n.fract() == 0.0
                && !n.is_sign_negative()
                && n.abs() <= MAX_SAFE as f64
            {
                Ok(Value::Int(n as i64))
            } else {
                Ok(Value::Float(n))
            }
        }
        ValueType::BigInt => {
            let b = BigInt::from_unknown(*u).map_err(napi_wrap)?;
            let (i, ok) = b.get_i64();
            if !ok {
                return Err(argument("bigint is outside the i64 range"));
            }
            Ok(Value::Int(i))
        }
        ValueType::String => Ok(Value::Text(String::from_unknown(*u).map_err(napi_wrap)?)),
        ValueType::Object => {
            // Typed arrays first: `is_buffer` is true for typed arrays
            // on some N-API runtimes, and Buffer IS a Uint8Array.
            if u.is_typedarray().map_err(napi_wrap)? {
                if let Ok(ta) = Float32Array::from_unknown(*u) {
                    return Ok(Value::Vector(ta.as_ref().to_vec()));
                }
                // Every other typed array (Uint8Array/Buffer included)
                // maps to its raw bytes.
                let buf: Buffer = Buffer::from_unknown(*u).map_err(napi_wrap)?;
                return Ok(Value::Bytes(buf.as_ref().to_vec()));
            }
            if u.is_buffer().map_err(napi_wrap)? {
                let buf: Buffer = Buffer::from_unknown(*u).map_err(napi_wrap)?;
                return Ok(Value::Bytes(buf.as_ref().to_vec()));
            }
            if u.is_array().map_err(napi_wrap)? {
                let items: Vec<Unknown> = Vec::from_unknown(*u).map_err(napi_wrap)?;
                let mut out = Vec::with_capacity(items.len());
                for item in &items {
                    out.push(value_from_js(item)?);
                }
                return Ok(Value::Array(out));
            }
            // Plain object → Map (own enumerable string-keyed properties).
            let obj = Object::from_unknown(*u).map_err(napi_wrap)?;
            let keys = Object::keys(&obj).map_err(napi_wrap)?;
            // The CorvidFloat marker (see index.js): an object whose
            // single own key is `__corvidFloat` maps to a typed engine
            // Float — the escape hatch for integer-valued doubles that
            // must NOT collapse to Int.
            if keys.len() == 1 && keys[0] == "__corvidFloat" {
                if let Some(n) = obj.get::<f64>("__corvidFloat").map_err(napi_wrap)? {
                    return Ok(Value::Float(n));
                }
            }
            let mut map = BTreeMap::new();
            for key in keys {
                let val: Unknown = obj
                    .get::<Unknown>(&key)
                    .map_err(napi_wrap)?
                    .ok_or_else(|| argument("property vanished while reading an object"))?;
                map.insert(key, value_from_js(&val)?);
            }
            Ok(Value::Map(map))
        }
        _ => Err(argument(
            "unsupported JS value kind (function/symbol/external)",
        )),
    }
}

/// Convert an engine `Value` into a JS value (see the module docs for
/// the mapping and its fidelity notes).
pub fn value_to_js(env: &Env, v: &Value) -> CResult<Unknown<'static>> {
    match v {
        Value::Null => out(env, Null),
        Value::Bool(b) => out(env, *b),
        Value::Int(i) => {
            if i.unsigned_abs() <= MAX_SAFE as u64 {
                out(env, *i as f64)
            } else {
                out(env, BigInt::from(*i))
            }
        }
        Value::Float(f) => out(env, *f),
        Value::Text(s) => out(env, s.clone()),
        Value::Bytes(b) => out(env, Buffer::from(b.clone())),
        Value::Vector(f32s) => out(env, Float32Array::new(f32s.clone())),
        Value::Array(items) => {
            let mut xs: Vec<Unknown> = Vec::with_capacity(items.len());
            for item in items {
                xs.push(value_to_js(env, item)?);
            }
            out(env, xs)
        }
        Value::Map(map) => {
            let mut obj = Object::new(env).map_err(napi_wrap)?;
            for (k, val) in map {
                obj.set(k.as_str(), value_to_js(env, val)?)
                    .map_err(napi_wrap)?;
            }
            out(env, obj)
        }
    }
}

/// Wrap any `ToNapiValue` (Buffer, Float32Array, Null, Object, ...) into
/// an `Unknown` for uniform composition.
fn out<T: ToNapiValue>(env: &Env, v: T) -> CResult<Unknown<'static>> {
    // SAFETY: `raw` comes straight from V8 under a live `Env`; the
    // rewrap borrows the same lifetime. Both unsafe calls are the
    // documented napi-rs escape hatches.
    unsafe {
        let raw = T::to_napi_value(env.raw(), v).map_err(napi_wrap)?;
        Ok(Unknown::from_raw_unchecked(env.raw(), raw))
    }
}

/// A key: string (UTF-8 encoded) or Buffer/Uint8Array (raw bytes).
pub fn key_from_js(u: &Unknown) -> CResult<Vec<u8>> {
    let t = u.get_type().map_err(napi_wrap)?;
    if t == ValueType::String {
        let s = String::from_unknown(*u).map_err(napi_wrap)?;
        return Ok(s.into_bytes());
    }
    if t == ValueType::Object && u.is_buffer().map_err(napi_wrap)? {
        let buf: Buffer = Buffer::from_unknown(*u).map_err(napi_wrap)?;
        return Ok(buf.as_ref().to_vec());
    }
    Err(argument("keys must be strings or Buffers"))
}

/// Keys out: valid UTF-8 → string, anything else → Buffer.
pub fn key_to_js(env: &Env, k: &[u8]) -> CResult<Unknown<'static>> {
    match std::str::from_utf8(k) {
        Ok(s) => out(env, s),
        _ => out(env, Buffer::from(k.to_vec())),
    }
}

/// Null out (a plain JS `null`).
pub fn null_js(env: &Env) -> CResult<Unknown<'static>> {
    out(env, Null)
}
