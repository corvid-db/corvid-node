//! The `CollectionNode` napi class — the engine-binding twin of the JS
//! `Collection` (index.js). Holds `Arc<Db>` + name (the ABI's derived
//! handle shape); each op materializes the engine `Collection` for the
//! call, mirroring the FFI's transient-borrow pattern.

use std::sync::Arc;
use std::sync::Mutex;

use corvid::schema::{Field, FieldType, Schema};
use corvid::Metric;
use corvid::Quantization;
use napi::bindgen_prelude::{FnArgs, FromNapiValue, Function, Unknown, ValueType};
use napi::Env;
use napi_derive::napi;

use crate::db::{release, Counter};
use crate::error::{CResult, CorvidErr, ErrCode};
use crate::pred::parse_pred;
use crate::value::{key_from_js, key_to_js, napi_wrap, value_from_js, value_to_js};

pub(crate) struct CollInner {
    pub db: Arc<corvid::Db>,
    pub name: String,
    pub counter: Counter,
}

#[napi]
pub struct CollectionNode {
    inner: Mutex<Option<CollInner>>,
}

pub(crate) fn parse_metric(s: &str) -> CResult<Metric> {
    match s {
        "cosine" => Ok(Metric::Cosine),
        "dot" => Ok(Metric::Dot),
        "l2" => Ok(Metric::L2),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown metric '{s}'"),
        )),
    }
}

pub(crate) fn parse_quant(s: &str) -> CResult<Quantization> {
    match s {
        "none" => Ok(Quantization::None),
        "binary" => Ok(Quantization::Binary),
        "scalar" => Ok(Quantization::Scalar),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown quantization '{s}'"),
        )),
    }
}

pub(crate) fn parse_field_type(s: &str) -> CResult<FieldType> {
    match s {
        "any" => Ok(FieldType::Any),
        "bool" => Ok(FieldType::Bool),
        "int" => Ok(FieldType::Int),
        "float" => Ok(FieldType::Float),
        "text" => Ok(FieldType::Text),
        "bytes" => Ok(FieldType::Bytes),
        "vector" => Ok(FieldType::Vector),
        "array" => Ok(FieldType::Array),
        "map" => Ok(FieldType::Map),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown field type '{s}'"),
        )),
    }
}

pub(crate) fn field_type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::Any => "any",
        FieldType::Bool => "bool",
        FieldType::Int => "int",
        FieldType::Float => "float",
        FieldType::Text => "text",
        FieldType::Bytes => "bytes",
        FieldType::Vector => "vector",
        FieldType::Array => "array",
        FieldType::Map => "map",
    }
}

fn closed() -> CorvidErr {
    CorvidErr::new(ErrCode::Argument, "collection handle is closed")
}

/// CorvidErr → engine error (for closures that must return
/// `corvid::Result`): the message rides in an InvalidArgument.
fn engine_err(e: CorvidErr) -> corvid::Error {
    corvid::Error::InvalidArgument(e.message)
}

impl CollectionNode {
    pub(crate) fn new(db: Arc<corvid::Db>, name: String, counter: Counter) -> Self {
        Self {
            inner: Mutex::new(Some(CollInner { db, name, counter })),
        }
    }

    fn with_coll<T>(&self, f: impl FnOnce(corvid::Collection<'_>) -> CResult<T>) -> CResult<T> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or_else(closed)?;
        let coll = inner.db.collection(&inner.name);
        f(coll)
    }
}

impl Drop for CollectionNode {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.lock().unwrap().take() {
            release(&inner.counter);
        }
    }
}

#[napi(object)]
pub struct FieldDef {
    pub name: String,
    /// One of `any|bool|int|float|text|bytes|vector|array|map`.
    pub ty: String,
    pub required: bool,
    pub unique: bool,
}

#[napi]
impl CollectionNode {
    #[napi(getter)]
    pub fn name(&self) -> napi::Result<String> {
        let guard = self.inner.lock().unwrap();
        Ok(guard.as_ref().ok_or_else(closed)?.name.clone())
    }

    // -- mutations ----------------------------------------------------------

    #[napi]
    pub fn insert(&self, key: Unknown, doc: Unknown) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let v = value_from_js(&doc)?;
            coll.insert(&k, &v).map_err(CorvidErr::from)
        })?)
    }

    /// Bulk atomic insert (`put_many`): one transaction; a violating
    /// pair rolls the whole batch back.
    #[napi]
    pub fn insert_many(&self, entries: Vec<(Unknown, Unknown)>) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            let mut items: Vec<(Vec<u8>, corvid::Value)> = Vec::with_capacity(entries.len());
            for (k, v) in &entries {
                items.push((key_from_js(k)?, value_from_js(v)?));
            }
            let refs: Vec<(&[u8], &corvid::Value)> =
                items.iter().map(|(k, v)| (k.as_slice(), v)).collect();
            coll.insert_batch(&refs).map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn insert_auto(&self, env: Env, doc: Unknown<'_>) -> napi::Result<Unknown<'static>> {
        let key = self.with_coll(|coll| {
            let v = value_from_js(&doc)?;
            coll.insert_auto(&v).map_err(CorvidErr::from)
        })?;
        Ok(key_to_js(&env, &key)?)
    }

    /// Read-modify-write: the callback receives the current document
    /// (or `null` when absent) and returns the new document — `null` to
    /// delete. A throwing callback aborts with code 12 and writes
    /// nothing. (The engine's own update is the same get-then-write
    /// composition; see its docs for the linearizability caveat.)
    #[napi]
    pub fn update(
        &self,
        env: Env,
        key: Unknown,
        f: Function<'_, Unknown, Unknown>,
    ) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let current = coll.get(&k).map_err(CorvidErr::from)?;
            let arg = match &current {
                Some(v) => value_to_js(&env, v)?,
                None => crate::value::null_js(&env)?,
            };
            let ret = f
                .call(arg)
                .map_err(|e| CorvidErr::new(ErrCode::Argument, update_cb_msg(&e)))?;
            let t = ret.get_type().map_err(napi_wrap)?;
            if matches!(t, ValueType::Null | ValueType::Undefined) {
                coll.delete(&k).map_err(CorvidErr::from)?;
                Ok(())
            } else {
                let doc = value_from_js(&ret)?;
                coll.insert(&k, &doc).map_err(CorvidErr::from)
            }
        })?)
    }

    #[napi]
    pub fn patch(&self, key: Unknown, patch: Unknown) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let p = value_from_js(&patch)?;
            coll.patch(&k, &p).map_err(CorvidErr::from)
        })?)
    }

    /// Atomically write `replacement` only if the current value equals
    /// `expected` (`null` = must be absent; `replacement: null`
    /// deletes on match). Returns whether the write was applied.
    #[napi]
    pub fn compare_and_set(
        &self,
        key: Unknown,
        expected: Unknown,
        replacement: Unknown,
    ) -> napi::Result<bool> {
        Ok(self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let ex = opt_value(&expected)?;
            let re = opt_value(&replacement)?;
            coll.compare_and_set(&k, ex.as_ref(), re)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn delete(&self, key: Unknown) -> napi::Result<bool> {
        Ok(self.with_coll(|coll| coll.delete(&key_from_js(&key)?).map_err(CorvidErr::from))?)
    }

    /// Delete every document matching the predicate (built with
    /// `field()`/`and`/`or`/`not`); returns the removed count.
    #[napi]
    pub fn delete_where(&self, pred: Unknown) -> napi::Result<u32> {
        Ok(self.with_coll(|coll| {
            let p = parse_pred(&pred)?;
            coll.delete_where(p)
                .map(|n| n as u32)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn delete_batch(&self, keys: Vec<Unknown>) -> napi::Result<u32> {
        Ok(self.with_coll(|coll| {
            let mut ks: Vec<Vec<u8>> = Vec::with_capacity(keys.len());
            for k in &keys {
                ks.push(key_from_js(k)?);
            }
            let refs: Vec<&[u8]> = ks.iter().map(|k| k.as_slice()).collect();
            coll.delete_batch(&refs)
                .map(|n| n as u32)
                .map_err(CorvidErr::from)
        })?)
    }

    // -- TTL ----------------------------------------------------------------

    #[napi]
    pub fn insert_with_ttl(&self, key: Unknown, doc: Unknown, expires_at: i64) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            let k = key_from_js(&key)?;
            let v = value_from_js(&doc)?;
            coll.insert_with_ttl(&k, &v, expires_at)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn set_ttl(&self, key: Unknown, expires_at: i64) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.set_ttl(&key_from_js(&key)?, expires_at)
                .map_err(CorvidErr::from)
        })?)
    }

    /// The key's expiry instant, or `null` when it has no TTL.
    #[napi]
    pub fn get_ttl(&self, env: Env, key: Unknown<'_>) -> napi::Result<Unknown<'static>> {
        let ttl = self.with_coll(|coll| coll.ttl(&key_from_js(&key)?).map_err(CorvidErr::from))?;
        Ok(match ttl {
            None => crate::value::null_js(&env)?,
            Some(t) => value_to_js(&env, &corvid::Value::Int(t))?,
        })
    }

    #[napi]
    pub fn purge_expired(&self, now: i64) -> napi::Result<u32> {
        Ok(self.with_coll(|coll| {
            coll.purge_expired(now)
                .map(|n| n as u32)
                .map_err(CorvidErr::from)
        })?)
    }

    // -- reads ----------------------------------------------------------------

    #[napi]
    pub fn get(&self, env: Env, key: Unknown<'_>) -> napi::Result<Unknown<'static>> {
        let doc = self.with_coll(|coll| coll.get(&key_from_js(&key)?).map_err(CorvidErr::from))?;
        Ok(match doc {
            Some(v) => value_to_js(&env, &v)?,
            None => crate::value::null_js(&env)?,
        })
    }

    /// Every `(key, document)` in key order.
    #[napi]
    pub fn scan_rows(&self, env: Env) -> napi::Result<Vec<(Unknown<'static>, Unknown<'static>)>> {
        let rows = self.with_coll(|coll| coll.scan().map_err(CorvidErr::from))?;
        let mut out = Vec::with_capacity(rows.len());
        for (k, v) in rows {
            out.push((key_to_js(&env, &k)?, value_to_js(&env, &v)?));
        }
        Ok(out)
    }

    /// Stream with a callback `(key, doc) => boolean` — returning
    /// `false` stops the walk early (not an error). Returns the number
    /// of rows visited.
    #[napi]
    pub fn scan_cb(
        &self,
        env: Env,
        cb: Function<'_, FnArgs<(Unknown, Unknown)>, Unknown>,
    ) -> napi::Result<u32> {
        let mut visited: u32 = 0;
        self.with_coll(|coll| {
            coll.for_each_doc(|key, doc| {
                visited += 1;
                let kj = key_to_js(&env, key).map_err(engine_err)?;
                let dj = value_to_js(&env, &doc).map_err(engine_err)?;
                let ret = cb.call(FnArgs::from((kj, dj))).map_err(|e| {
                    corvid::Error::InvalidArgument(format!("scan callback failed: {}", e.reason))
                })?;
                let cont = match ret.get_type() {
                    Ok(ValueType::Boolean) => bool::from_unknown(ret).unwrap_or(true),
                    _ => true,
                };
                Ok(cont)
            })
            .map_err(CorvidErr::from)
        })?;
        Ok(visited)
    }

    /// Keyset pagination: up to `limit` rows strictly after `after`
    /// (`null` starts at the beginning).
    #[napi]
    pub fn page(
        &self,
        env: Env,
        after: Unknown<'_>,
        limit: u32,
    ) -> napi::Result<(Vec<(Unknown<'static>, Unknown<'static>)>, Unknown<'static>)> {
        let page = self.with_coll(|coll| {
            let after_key = opt_key(&after)?;
            coll.page(after_key.as_deref(), limit as usize)
                .map_err(CorvidErr::from)
        })?;
        let mut rows = Vec::with_capacity(page.rows.len());
        for (k, v) in page.rows {
            rows.push((key_to_js(&env, &k)?, value_to_js(&env, &v)?));
        }
        let next = match page.next {
            Some(k) => key_to_js(&env, &k)?,
            None => crate::value::null_js(&env)?,
        };
        Ok((rows, next))
    }

    #[napi]
    pub fn len(&self) -> napi::Result<u32> {
        Ok(self.with_coll(|coll| coll.len().map(|n| n as u32).map_err(CorvidErr::from))?)
    }

    #[napi]
    pub fn is_empty(&self) -> napi::Result<bool> {
        Ok(self.with_coll(|coll| coll.is_empty().map_err(CorvidErr::from))?)
    }

    // -- indexes & schema -----------------------------------------------------

    #[napi]
    pub fn create_scalar_index(&self, field: String) -> napi::Result<()> {
        Ok(self.with_coll(|coll| coll.create_scalar_index(&field).map_err(CorvidErr::from))?)
    }

    #[napi]
    pub fn create_compound_index(&self, fields: Vec<String>) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            let refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
            coll.create_compound_index(&refs).map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn create_text_index(&self, field: String) -> napi::Result<()> {
        Ok(self.with_coll(|coll| coll.create_text_index(&field).map_err(CorvidErr::from))?)
    }

    #[napi]
    pub fn create_text_index_ondisk(&self, field: String) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.create_text_index_ondisk(&field)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn create_geo_index(&self, field: String) -> napi::Result<()> {
        Ok(self.with_coll(|coll| coll.create_geo_index(&field).map_err(CorvidErr::from))?)
    }

    #[napi]
    pub fn create_vector_index(&self, field: String, metric: String) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.create_vector_index(&field, parse_metric(&metric)?)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn create_vector_index_quantized(
        &self,
        field: String,
        metric: String,
        quant: String,
    ) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.create_vector_index_quantized(&field, parse_metric(&metric)?, parse_quant(&quant)?)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn create_vector_index_ondisk(&self, field: String, metric: String) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.create_vector_index_ondisk(&field, parse_metric(&metric)?)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn create_vector_index_ondisk_quantized(
        &self,
        field: String,
        metric: String,
        quant: String,
    ) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.create_vector_index_ondisk_quantized(
                &field,
                parse_metric(&metric)?,
                parse_quant(&quant)?,
            )
            .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn create_vector_index_pq(
        &self,
        field: String,
        metric: String,
        m: u32,
        k: u32,
    ) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.create_vector_index_pq(&field, parse_metric(&metric)?, m as usize, k as usize)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn create_vector_index_ondisk_pq(
        &self,
        field: String,
        metric: String,
        m: u32,
        k: u32,
    ) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.create_vector_index_ondisk_pq(
                &field,
                parse_metric(&metric)?,
                m as usize,
                k as usize,
            )
            .map_err(CorvidErr::from)
        })?)
    }

    /// Declare the collection's schema (replaces any previous one).
    #[napi]
    pub fn set_schema(&self, fields: Vec<FieldDef>) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            let mut schema = Schema::new();
            for f in fields {
                let mut field = Field::new(f.name, parse_field_type(&f.ty)?);
                if f.required {
                    field = field.required();
                }
                if f.unique {
                    field = field.unique();
                }
                schema = schema.field(field);
            }
            coll.set_schema(&schema).map_err(CorvidErr::from)
        })?)
    }

    /// The declared schema, or `null` when none.
    #[napi]
    pub fn schema(&self) -> napi::Result<Option<Vec<FieldDef>>> {
        Ok(self.with_coll(|coll| {
            Ok(coll.schema().map(|s| {
                s.fields()
                    .iter()
                    .map(|f| FieldDef {
                        name: f.name.clone(),
                        ty: field_type_name(f.ty).to_string(),
                        required: f.required,
                        unique: f.unique,
                    })
                    .collect()
            }))
        })?)
    }

    // -- graph ----------------------------------------------------------------

    #[napi]
    pub fn link(&self, from: Unknown, relation: String, to: Unknown) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.link(&key_from_js(&from)?, &relation, &key_from_js(&to)?)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn link_weighted(
        &self,
        from: Unknown,
        relation: String,
        to: Unknown,
        weight: f64,
    ) -> napi::Result<()> {
        Ok(self.with_coll(|coll| {
            coll.link_weighted(&key_from_js(&from)?, &relation, &key_from_js(&to)?, weight)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn unlink(&self, from: Unknown, relation: String, to: Unknown) -> napi::Result<bool> {
        Ok(self.with_coll(|coll| {
            coll.unlink(&key_from_js(&from)?, &relation, &key_from_js(&to)?)
                .map_err(CorvidErr::from)
        })?)
    }

    #[napi]
    pub fn neighbors(
        &self,
        env: Env,
        from: Unknown,
        relation: String,
    ) -> napi::Result<Vec<Unknown<'static>>> {
        let keys = self.with_coll(|coll| {
            coll.neighbors(&key_from_js(&from)?, &relation)
                .map_err(CorvidErr::from)
        })?;
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            out.push(key_to_js(&env, &k)?);
        }
        Ok(out)
    }

    #[napi]
    pub fn in_neighbors(
        &self,
        env: Env,
        to: Unknown,
        relation: String,
    ) -> napi::Result<Vec<Unknown<'static>>> {
        let keys = self.with_coll(|coll| {
            coll.in_neighbors(&key_from_js(&to)?, &relation)
                .map_err(CorvidErr::from)
        })?;
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            out.push(key_to_js(&env, &k)?);
        }
        Ok(out)
    }

    #[napi]
    pub fn neighbors_weighted(
        &self,
        env: Env,
        from: Unknown,
        relation: String,
    ) -> napi::Result<Vec<(Unknown<'static>, f64)>> {
        let pairs = self.with_coll(|coll| {
            coll.neighbors_weighted(&key_from_js(&from)?, &relation)
                .map_err(CorvidErr::from)
        })?;
        let mut out = Vec::with_capacity(pairs.len());
        for (k, w) in pairs {
            out.push((key_to_js(&env, &k)?, w));
        }
        Ok(out)
    }

    #[napi]
    pub fn traverse(
        &self,
        env: Env,
        start: Unknown,
        relation: String,
        hops: u32,
    ) -> napi::Result<Vec<Unknown<'static>>> {
        let keys = self.with_coll(|coll| {
            coll.traverse(&key_from_js(&start)?, &relation, hops as usize)
                .map_err(CorvidErr::from)
        })?;
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            out.push(key_to_js(&env, &k)?);
        }
        Ok(out)
    }

    // -- geo ------------------------------------------------------------------

    fn geo_hits(
        &self,
        env: &Env,
        hits: Vec<corvid::GeoHit>,
    ) -> CResult<Vec<(Unknown<'static>, f64, Unknown<'static>)>> {
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            out.push((
                key_to_js(env, &hit.key)?,
                hit.distance_km,
                value_to_js(env, &hit.document)?,
            ));
        }
        Ok(out)
    }

    #[napi]
    pub fn geo_within_radius(
        &self,
        env: Env,
        field: String,
        lat: f64,
        lon: f64,
        radius_km: f64,
    ) -> napi::Result<Vec<(Unknown<'static>, f64, Unknown<'static>)>> {
        let hits = self.with_coll(|coll| {
            coll.geo_within_radius(&field, lat, lon, radius_km)
                .map_err(CorvidErr::from)
        })?;
        Ok(self.geo_hits(&env, hits)?)
    }

    #[napi]
    pub fn geo_within_bbox(
        &self,
        env: Env,
        field: String,
        min_lat: f64,
        min_lon: f64,
        max_lat: f64,
        max_lon: f64,
    ) -> napi::Result<Vec<(Unknown<'static>, f64, Unknown<'static>)>> {
        // bbox has no center: the engine returns plain rows and the
        // ABI reports the 0.0 distance sentinel — same here.
        let rows = self.with_coll(|coll| {
            coll.geo_within_bbox(&field, min_lat, min_lon, max_lat, max_lon)
                .map_err(CorvidErr::from)
        })?;
        let mut out = Vec::with_capacity(rows.len());
        for (k, doc) in rows {
            out.push((key_to_js(&env, &k)?, 0.0, value_to_js(&env, &doc)?));
        }
        Ok(out)
    }

    #[napi]
    pub fn geo_nearest(
        &self,
        env: Env,
        field: String,
        lat: f64,
        lon: f64,
        k: u32,
    ) -> napi::Result<Vec<(Unknown<'static>, f64, Unknown<'static>)>> {
        let hits = self.with_coll(|coll| {
            coll.geo_nearest(&field, lat, lon, k as usize)
                .map_err(CorvidErr::from)
        })?;
        Ok(self.geo_hits(&env, hits)?)
    }

    /// DIRECT positional text search (spec §4.6's erratum, engine
    /// v0.3.0's ABI addition; this binding calls the engine method
    /// directly — no query handle): documents whose `field` TEXT holds
    /// `phrase` as a consecutive, IN-ORDER run of analyzed tokens, most
    /// relevant first, ties by key, up to `k`. Rows as
    /// `(key, doc, score)` where score is the hit's BM25 phrase sum
    /// (the phrase scale, NOT the builder's fused RRF scale). `k == 0`
    /// answers `[]` — inert, never an error.
    #[napi]
    pub fn phrase_search(
        &self,
        env: Env,
        field: String,
        phrase: String,
        k: u32,
    ) -> napi::Result<Vec<(Unknown<'static>, Unknown<'static>, f32)>> {
        let hits = self.with_coll(|coll| {
            coll.phrase_search(&field, &phrase, k as usize)
                .map_err(CorvidErr::from)
        })?;
        let mut out = Vec::with_capacity(hits.len());
        for hit in hits {
            out.push((
                key_to_js(&env, &hit.key)?,
                value_to_js(&env, &hit.document)?,
                hit.score,
            ));
        }
        Ok(out)
    }

    // -- queries ----------------------------------------------------------------

    /// Begin a query over this collection (a derived handle; close it
    /// or execute it).
    #[napi]
    pub fn query(&self) -> napi::Result<crate::QueryNode> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or_else(closed)?;
        Ok(crate::QueryNode::new(
            Arc::clone(&inner.db),
            inner.name.clone(),
            Arc::clone(&inner.counter),
        ))
    }

    /// Release the handle (idempotent); also runs on GC.
    #[napi]
    pub fn close(&self) {
        if let Some(inner) = self.inner.lock().unwrap().take() {
            release(&inner.counter);
        }
    }
}

fn update_cb_msg(e: &napi::Error) -> String {
    format!("update callback failed: {}", e.reason)
}

fn opt_value(u: &Unknown) -> CResult<Option<corvid::Value>> {
    let t = u.get_type().map_err(napi_wrap)?;
    if matches!(t, ValueType::Null | ValueType::Undefined) {
        return Ok(None);
    }
    Ok(Some(value_from_js(u)?))
}

fn opt_key(u: &Unknown) -> CResult<Option<Vec<u8>>> {
    let t = u.get_type().map_err(napi_wrap)?;
    if matches!(t, ValueType::Null | ValueType::Undefined) {
        return Ok(None);
    }
    Ok(Some(key_from_js(u)?))
}
