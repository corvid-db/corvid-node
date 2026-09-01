//! The `QueryNode` napi class — the engine-binding twin of the JS
//! `Query` fluent builder (index.js). Like the FFI's `QueryHandle`, it
//! stores the builder's parts (`Arc<Db>`, name, filters, sources,
//! knobs) and materializes the real engine `QueryBuilder` exactly once,
//! at the executing call — which CONSUMES the handle (mirroring the
//! engine's by-value `run(self)`). The JS wrapper supplies the fluent
//! chaining; ranking-parameter validation stays at execution, exactly
//! as the engine and the ABI do it.

use std::sync::Arc;
use std::sync::Mutex;

use corvid::filter::Predicate;
use corvid::Metric;
use napi::bindgen_prelude::Unknown;
use napi::Env;
use napi_derive::napi;

use crate::db::{release, Counter};
use crate::error::{CResult, CorvidErr, ErrCode};
use crate::pred::parse_pred;
use crate::value::{key_to_js, value_from_js, value_to_js};

enum Source {
    Vector {
        field: String,
        query: Vec<f32>,
        k: usize,
        metric: Metric,
    },
    Text {
        field: String,
        query: String,
        k: usize,
    },
}

pub(crate) struct QueryInner {
    db: Arc<corvid::Db>,
    name: String,
    counter: Counter,
    filters: Vec<Predicate>,
    sources: Vec<Source>,
    rrf_k: f32,
    mmr_lambda: Option<f32>,
    limit: Option<usize>,
    offset: usize,
    order_by: Option<(String, bool)>,
    projection: Option<Vec<String>>,
    approx: bool,
}

impl QueryInner {
    /// Materialize the engine builder from the stored parts, applying
    /// them in the engine's own builder order. `fuse_rrf` is applied
    /// unconditionally with `rrf_k` (initialized to the engine's
    /// `DEFAULT_RRF_K`), which is identical to the engine's default
    /// fused state.
    fn build(&self) -> corvid::QueryBuilder<'_> {
        let coll = self.db.collection(&self.name);
        let mut b = coll.query();
        for f in &self.filters {
            b = b.filter(f.clone());
        }
        for s in &self.sources {
            match s {
                Source::Vector {
                    field,
                    query,
                    k,
                    metric,
                } => {
                    b = b.vector(field.clone(), query.clone(), *k, *metric);
                }
                Source::Text { field, query, k } => {
                    b = b.text(field.clone(), query.clone(), *k);
                }
            }
        }
        b = b.fuse_rrf(self.rrf_k);
        if let Some(l) = self.mmr_lambda {
            b = b.rerank_mmr(l);
        }
        if self.approx {
            b = b.approx();
        }
        if let Some((field, desc)) = &self.order_by {
            b = b.order_by(field.clone(), *desc);
        }
        if let Some(fields) = &self.projection {
            b = b.select(fields.iter().cloned());
        }
        if self.offset > 0 {
            b = b.offset(self.offset);
        }
        if let Some(n) = self.limit {
            b = b.limit(n);
        }
        b
    }
}

#[napi]
pub struct QueryNode {
    inner: Mutex<Option<QueryInner>>,
}

impl QueryNode {
    pub(crate) fn new(db: Arc<corvid::Db>, name: String, counter: Counter) -> Self {
        // A query is a derived handle: count it until the executing
        // terminal op (or close/drop) releases it — the §4.13 gate.
        crate::db::retain(&counter);
        Self {
            inner: Mutex::new(Some(QueryInner {
                db,
                name,
                counter,
                filters: Vec::new(),
                sources: Vec::new(),
                rrf_k: corvid::DEFAULT_RRF_K,
                mmr_lambda: None,
                limit: None,
                offset: 0,
                order_by: None,
                projection: None,
                approx: false,
            })),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut QueryInner) -> CResult<R>) -> CResult<R> {
        let mut guard = self.inner.lock().unwrap();
        match guard.as_mut() {
            Some(inner) => f(inner),
            None => Err(CorvidErr::new(
                ErrCode::Argument,
                "query was already executed or closed",
            )),
        }
    }

    /// Take the inner state (consume) — terminal ops run through this,
    /// releasing the derived-handle counter exactly once.
    fn consume(&self) -> CResult<QueryInner> {
        let mut guard = self.inner.lock().unwrap();
        match guard.take() {
            Some(inner) => {
                release(&inner.counter);
                Ok(inner)
            }
            None => Err(CorvidErr::new(
                ErrCode::Argument,
                "query was already executed or closed",
            )),
        }
    }
}

impl Drop for QueryNode {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.lock().unwrap().take() {
            release(&inner.counter);
        }
    }
}

#[napi]
impl QueryNode {
    // -- setters (the JS layer chains these fluently) -----------------------

    #[napi]
    pub fn filter(&self, pred: Unknown) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.filters.push(parse_pred(&pred)?);
            Ok(())
        })?)
    }

    #[napi]
    pub fn vector(
        &self,
        field: String,
        query: Unknown,
        k: u32,
        metric: String,
    ) -> napi::Result<()> {
        Ok(self.with(|inner| {
            let v = value_from_js(&query)?;
            let elems = match v {
                corvid::Value::Vector(f) => f,
                _ => return Err(CorvidErr::argument("query.vector wants a Float32Array")),
            };
            let m = crate::collection::parse_metric(&metric)?;
            inner.sources.push(Source::Vector {
                field,
                query: elems,
                k: k as usize,
                metric: m,
            });
            Ok(())
        })?)
    }

    #[napi]
    pub fn text(&self, field: String, query: String, k: u32) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.sources.push(Source::Text {
                field,
                query,
                k: k as usize,
            });
            Ok(())
        })?)
    }

    #[napi]
    pub fn fuse_rrf(&self, k: f64) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.rrf_k = k as f32;
            Ok(())
        })?)
    }

    #[napi]
    pub fn rerank_mmr(&self, lambda: f64) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.mmr_lambda = Some(lambda as f32);
            Ok(())
        })?)
    }

    #[napi]
    pub fn approx(&self) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.approx = true;
            Ok(())
        })?)
    }

    #[napi]
    pub fn limit(&self, n: u32) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.limit = Some(n as usize);
            Ok(())
        })?)
    }

    #[napi]
    pub fn offset(&self, n: u32) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.offset = n as usize;
            Ok(())
        })?)
    }

    #[napi]
    pub fn order_by(&self, field: String, descending: bool) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.order_by = Some((field, descending));
            Ok(())
        })?)
    }

    #[napi]
    pub fn select(&self, fields: Vec<String>) -> napi::Result<()> {
        Ok(self.with(|inner| {
            inner.projection = Some(fields);
            Ok(())
        })?)
    }

    // -- terminal (consuming) ops --------------------------------------------

    /// Execute; rows as `(key, doc, score)` tuples (score 0 for pure
    /// filter/order queries). Consumes the builder.
    #[napi]
    pub fn run(&self, env: Env) -> napi::Result<Vec<(Unknown<'_>, Unknown<'_>, f32)>> {
        let inner = self.consume()?;
        let rows = inner.build().run().map_err(CorvidErr::from)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push((
                key_to_js(&env, &row.key)?,
                value_to_js(&env, &row.document)?,
                row.score,
            ));
        }
        Ok(out)
    }

    #[napi]
    pub fn count(&self) -> napi::Result<u32> {
        let inner = self.consume()?;
        Ok(inner.build().count().map_err(CorvidErr::from)? as u32)
    }

    #[napi]
    pub fn count_distinct(&self, field: String) -> napi::Result<u32> {
        let inner = self.consume()?;
        Ok(inner
            .build()
            .count_distinct(&field)
            .map_err(CorvidErr::from)? as u32)
    }

    #[napi]
    pub fn sum(&self, field: String) -> napi::Result<f64> {
        let inner = self.consume()?;
        Ok(inner.build().sum(&field).map_err(CorvidErr::from)?)
    }

    /// The filtered mean, or `null` when no document has the field.
    #[napi]
    pub fn avg(&self, field: String) -> napi::Result<Option<f64>> {
        let inner = self.consume()?;
        Ok(inner.build().avg(&field).map_err(CorvidErr::from)?)
    }

    #[napi]
    pub fn min(&self, env: Env, field: String) -> napi::Result<Unknown<'static>> {
        let inner = self.consume()?;
        let v = inner.build().min(&field).map_err(CorvidErr::from)?;
        match v {
            Some(v) => Ok(value_to_js(&env, &v)?),
            None => Ok(crate::value::null_js(&env)?),
        }
    }

    #[napi]
    pub fn max(&self, env: Env, field: String) -> napi::Result<Unknown<'static>> {
        let inner = self.consume()?;
        let v = inner.build().max(&field).map_err(CorvidErr::from)?;
        match v {
            Some(v) => Ok(value_to_js(&env, &v)?),
            None => Ok(crate::value::null_js(&env)?),
        }
    }

    /// Group counts, ordered pairs (the engine's group-key formatting:
    /// text bare; int/float type-tagged `i:1` / `f:0.5`; ascending).
    #[napi]
    pub fn group_count(&self, field: String) -> napi::Result<Vec<(String, u32)>> {
        let inner = self.consume()?;
        let m = inner.build().group_count(&field).map_err(CorvidErr::from)?;
        Ok(m.into_iter().map(|(k, v)| (k, v as u32)).collect())
    }

    #[napi]
    pub fn group_sum(
        &self,
        group_field: String,
        value_field: String,
    ) -> napi::Result<Vec<(String, f64)>> {
        let inner = self.consume()?;
        let m = inner
            .build()
            .group_sum(&group_field, &value_field)
            .map_err(CorvidErr::from)?;
        Ok(m.into_iter().collect())
    }

    #[napi]
    pub fn group_avg(
        &self,
        group_field: String,
        value_field: String,
    ) -> napi::Result<Vec<(String, f64)>> {
        let inner = self.consume()?;
        let m = inner
            .build()
            .group_avg(&group_field, &value_field)
            .map_err(CorvidErr::from)?;
        Ok(m.into_iter().collect())
    }

    /// Abandon the builder without executing (the free path).
    #[napi]
    pub fn close(&self) {
        if let Some(inner) = self.inner.lock().unwrap().take() {
            release(&inner.counter);
        }
    }
}
