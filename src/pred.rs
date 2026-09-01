//! Predicate descriptors: the JS layer's `field()`/`and`/`or`/`not`
//! builders produce plain descriptor objects; `parse_pred` converts
//! one into an engine `Predicate` at the single crossing point
//! (`query.filter` / `deleteWhere`).

use corvid::filter::{field, CmpOp, Predicate};
use napi::bindgen_prelude::{FromNapiValue, Object, Unknown};

use crate::error::{CResult, CorvidErr, ErrCode};
use crate::value::{napi_wrap, value_from_js};

fn get_str(obj: &Object, key: &str) -> CResult<String> {
    obj.get::<String>(key)
        .map_err(napi_wrap)?
        .ok_or_else(|| CorvidErr::new(ErrCode::Argument, format!("predicate lacks '{key}'")))
}

fn get_f64(obj: &Object, key: &str) -> CResult<f64> {
    obj.get::<f64>(key)
        .map_err(napi_wrap)?
        .ok_or_else(|| CorvidErr::new(ErrCode::Argument, format!("predicate lacks '{key}'")))
}

fn get_unknown<'a>(obj: &Object<'_>, key: &str) -> CResult<Unknown<'a>> {
    obj.get::<Unknown>(key)
        .map_err(napi_wrap)?
        .ok_or_else(|| CorvidErr::new(ErrCode::Argument, format!("predicate lacks '{key}'")))
}

fn parse_cmp(s: &str) -> CResult<CmpOp> {
    match s {
        "eq" => Ok(CmpOp::Eq),
        "ne" => Ok(CmpOp::Ne),
        "lt" => Ok(CmpOp::Lt),
        "le" => Ok(CmpOp::Le),
        "gt" => Ok(CmpOp::Gt),
        "ge" => Ok(CmpOp::Ge),
        _ => Err(CorvidErr::new(
            ErrCode::Argument,
            format!("unknown comparison '{s}'"),
        )),
    }
}

pub(crate) fn parse_pred(u: &Unknown<'_>) -> CResult<Predicate> {
    let obj = Object::from_unknown(*u).map_err(napi_wrap)?;
    let op = get_str(&obj, "op")?;
    match op.as_str() {
        "exists" => Ok(field(&get_str(&obj, "path")?).exists()),
        "cmp" => {
            let path = get_str(&obj, "path")?;
            let cmp = parse_cmp(&get_str(&obj, "cmp")?)?;
            let value = value_from_js(&get_unknown(&obj, "value")?)?;
            Ok(match cmp {
                CmpOp::Eq => field(&path).eq(value),
                CmpOp::Ne => field(&path).ne(value),
                CmpOp::Lt => field(&path).lt(value),
                CmpOp::Le => field(&path).le(value),
                CmpOp::Gt => field(&path).gt(value),
                CmpOp::Ge => field(&path).ge(value),
            })
        }
        "in" => {
            let path = get_str(&obj, "path")?;
            let values: Vec<Unknown> = obj
                .get::<Vec<Unknown>>("values")
                .map_err(napi_wrap)?
                .ok_or_else(|| CorvidErr::argument("predicate lacks 'values'"))?;
            let mut parsed = Vec::with_capacity(values.len());
            for v in &values {
                parsed.push(value_from_js(v)?);
            }
            Ok(field(&path).is_in(parsed))
        }
        "between" => {
            let path = get_str(&obj, "path")?;
            let low = value_from_js(&get_unknown(&obj, "low")?)?;
            let high = value_from_js(&get_unknown(&obj, "high")?)?;
            Ok(field(&path).between(low, high))
        }
        "startsWith" => {
            let path = get_str(&obj, "path")?;
            let prefix = get_str(&obj, "prefix")?;
            Ok(field(&path).starts_with(prefix))
        }
        "contains" => {
            let path = get_str(&obj, "path")?;
            let substring = get_str(&obj, "substring")?;
            Ok(field(&path).contains(substring))
        }
        "geoWithin" => {
            let path = get_str(&obj, "path")?;
            let lat = get_f64(&obj, "lat")?;
            let lon = get_f64(&obj, "lon")?;
            let radius_km = get_f64(&obj, "radiusKm")?;
            Ok(field(&path).within_km(lat, lon, radius_km))
        }
        "and" | "or" => {
            let children: Vec<Unknown> = obj
                .get::<Vec<Unknown>>("children")
                .map_err(napi_wrap)?
                .ok_or_else(|| CorvidErr::argument("predicate lacks 'children'"))?;
            let mut iter = children.iter().map(parse_pred);
            let first = iter
                .next()
                .ok_or_else(|| CorvidErr::argument("and/or need at least one child"))??;
            let is_and = op == "and";
            iter.try_fold(first, |a, b| {
                b.map(|b| if is_and { a.and(b) } else { a.or(b) })
            })
        }
        "not" => {
            let child = parse_pred(&get_unknown(&obj, "child")?)?;
            Ok(Predicate::Not(Box::new(child)))
        }
        other => Err(CorvidErr::argument(format!(
            "unknown predicate op '{other}'"
        ))),
    }
}
