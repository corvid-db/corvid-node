//! corvid-node — the Node.js binding for the corvid engine.
//!
//! This crate is the *engine-binding layer*: it compiles the corvid
//! engine in (git dep pinned to an exact release tag) and exposes it
//! through napi-rs classes. The public, idiomatic OOP surface
//! (`Db`, `Collection`, `Query`, `field()`, `CorvidError`) lives in the
//! JavaScript layer (`index.js`) which wraps these classes — see
//! docs/PLAN.md for the architecture ruling.

use napi_derive::napi;

mod collection;
mod db;
mod error;
mod pred;
mod query;
mod value;

pub use collection::CollectionNode;
pub use db::DbNode;
pub use error::{CorvidErr, ErrCode};
pub use query::QueryNode;

/// The FFI-ABI generation this binding's OOP surface covers
/// (docs/FFI.md §1.3 stability policy; `corvid_ffi_version` = 1).
#[napi]
pub fn ffi_version() -> u32 {
    1
}
