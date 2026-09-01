//! The `DbNode` napi class — the engine-binding twin of the JS `Db`
//! (index.js). Holds the engine `Arc<Db>` plus the derived-handle
//! counter that gates exclusive compaction (the FFI's §4.13 rule,
//! mirrored here: `compact` needs the counter at exactly 1 — the db
//! itself — AND sole `Arc` ownership, else `CORVID_E_BUSY`).

use std::fs::File;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use corvid::Db;
use napi_derive::napi;

use crate::error::{CResult, CorvidErr, ErrCode};

/// The db's derived-handle counter: 1 for the db itself, +1 per live
/// `CollectionNode`/`QueryNode` (decremented by their `close`, their
/// consuming terminal op, or GC finalization). Mirrors the FFI's
/// `Arc<AtomicUsize>` so `compact` keeps the same quiescence contract.
pub(crate) type Counter = Arc<AtomicUsize>;

pub(crate) struct DbInner {
    pub db: Arc<Db>,
    pub counter: Counter,
}

#[napi]
pub struct DbNode {
    inner: std::sync::Mutex<Option<DbInner>>,
}

pub(crate) fn retain(counter: &Counter) {
    counter.fetch_add(1, Ordering::SeqCst);
}

pub(crate) fn release(counter: &Counter) {
    counter.fetch_sub(1, Ordering::SeqCst);
}

#[napi]
impl DbNode {
    /// Open (or create) a file-backed database; `path: null` opens an
    /// in-memory one.
    #[napi(constructor)]
    pub fn new(path: Option<String>) -> napi::Result<Self> {
        let db = match path {
            Some(p) => Db::open(&p).map_err(CorvidErr::from)?,
            None => Db::open_in_memory().map_err(CorvidErr::from)?,
        };
        let counter: Counter = Arc::new(AtomicUsize::new(1));
        Ok(Self {
            inner: std::sync::Mutex::new(Some(DbInner {
                db: Arc::new(db),
                counter,
            })),
        })
    }

    pub(crate) fn with_inner<T>(&self, f: impl FnOnce(&DbInner) -> CResult<T>) -> CResult<T> {
        let guard = self.inner.lock().unwrap();
        match guard.as_ref() {
            Some(inner) => f(inner),
            None => Err(CorvidErr::new(
                ErrCode::Argument,
                "database handle is closed",
            )),
        }
    }

    /// Acquire a collection handle (lazily created by the engine on
    /// first write; names are validated at write time, like the ABI).
    /// Increments the derived-handle counter.
    #[napi]
    pub fn collection(&self, name: String) -> napi::Result<crate::CollectionNode> {
        Ok(self.with_inner(|inner| {
            retain(&inner.counter);
            Ok(crate::CollectionNode::new(
                Arc::clone(&inner.db),
                name,
                Arc::clone(&inner.counter),
            ))
        })?)
    }

    /// The names of the database's collections, in engine order.
    #[napi]
    pub fn collections(&self) -> napi::Result<Vec<String>> {
        Ok(self.with_inner(|inner| inner.db.collections().map_err(CorvidErr::from))?)
    }

    /// Copy the database to `path` (which must not already exist).
    #[napi]
    pub fn backup(&self, path: String) -> napi::Result<()> {
        Ok(self.with_inner(|inner| inner.db.backup(&path).map_err(CorvidErr::from))?)
    }

    /// Dump the whole database (documents, indexes, schemas, TTLs,
    /// edges, auto-id counters) to `path`.
    #[napi]
    pub fn dump_to_path(&self, path: String) -> napi::Result<()> {
        Ok(self.with_inner(|inner| {
            let file = File::create(&path).map_err(io_err)?;
            inner.db.dump(file).map_err(CorvidErr::from)
        })?)
    }

    /// Replay a dump file into this database (merging).
    #[napi]
    pub fn load_from_path(&self, path: String) -> napi::Result<()> {
        Ok(self.with_inner(|inner| {
            let file = File::open(&path).map_err(io_err)?;
            inner.db.load(file).map_err(CorvidErr::from)
        })?)
    }

    /// Replay a dump file, renaming collections per `renames`
    /// (`{ from, to }` pairs; targets validated before the stream is
    /// read).
    #[napi]
    pub fn load_from_path_with_renames(
        &self,
        path: String,
        renames: Vec<(String, String)>,
    ) -> napi::Result<()> {
        Ok(self.with_inner(|inner| {
            let file = File::open(&path).map_err(io_err)?;
            let map: std::collections::BTreeMap<String, String> = renames.into_iter().collect();
            inner
                .db
                .load_with_renames(file, &map)
                .map_err(CorvidErr::from)
        })?)
    }

    /// Compact the database file. Requires quiescence: every
    /// `Collection`/`Query` derived from this db must be closed (or
    /// have executed), otherwise `ErrCode.Busy` (19). Returns whether
    /// any data was moved out.
    #[napi]
    pub fn compact(&self) -> napi::Result<bool> {
        Ok(self.compact_inner()?)
    }

    /// Close the handle (idempotent). Derived handles may legitimately
    /// outlive it — the engine lives until the last handle drops.
    #[napi]
    pub fn close(&self) {
        let _ = self.inner.lock().unwrap().take();
    }
}

impl DbNode {
    fn compact_inner(&self) -> CResult<bool> {
        let mut guard = self.inner.lock().unwrap();
        let inner = guard
            .as_mut()
            .ok_or_else(|| CorvidErr::new(ErrCode::Argument, "database handle is closed"))?;
        if inner.counter.load(Ordering::SeqCst) != 1 {
            return Err(CorvidErr::new(
                ErrCode::Busy,
                "compact: derived handles are still open",
            ));
        }
        // Take the Arc out so exclusivity is observable, compact the
        // sole Db, re-share. `try_unwrap` failing means a handle raced
        // us — also Busy. While the lock is held the placeholder is
        // unobservable to every other call.
        let arc = std::mem::replace(&mut inner.db, Arc::new(placeholder_db()));
        match Arc::try_unwrap(arc) {
            Ok(mut db) => {
                let moved = match db.compact() {
                    Ok(m) => m,
                    Err(e) => {
                        inner.db = Arc::new(db);
                        return Err(CorvidErr::from(e));
                    }
                };
                inner.db = Arc::new(db);
                Ok(moved)
            }
            Err(arc) => {
                inner.db = arc;
                Err(CorvidErr::new(
                    ErrCode::Busy,
                    "compact: engine handles are still open",
                ))
            }
        }
    }
}

/// A stand-in while the real `Arc<Db>` is being unwrapped for
/// exclusive compaction (never observed: the mutex is held throughout).
fn placeholder_db() -> Db {
    Db::open_in_memory().expect("in-memory engine placeholder")
}

fn io_err(e: std::io::Error) -> CorvidErr {
    CorvidErr::from(corvid::Error::Io(e))
}
