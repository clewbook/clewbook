//! Canonical JSON (SPEC §0): sorted keys, no whitespace, integers only.
//!
//! This covers the subset of RFC 8785 our objects use (ASCII strings, integers, nested
//! objects and arrays); floats are rejected rather than formatted.

use anyhow::{Result, bail};
use serde::Serialize;
use serde_json::Value;

pub fn to_canonical<T: Serialize>(value: &T) -> Result<String> {
    let mut out = String::new();
    write(&serde_json::to_value(value)?, &mut out)?;
    Ok(out)
}

fn write(value: &Value, out: &mut String) -> Result<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => out.push_str(&value.to_string()),
        Value::Number(n) => {
            if !(n.is_u64() || n.is_i64()) {
                bail!("canonical JSON only allows integers, found {n}");
            }
            out.push_str(&n.to_string());
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_keys_and_strips_whitespace() {
        let v = serde_json::json!({"b": 1, "a": {"d": [1, 2], "c": "x"}});
        assert_eq!(to_canonical(&v).unwrap(), r#"{"a":{"c":"x","d":[1,2]},"b":1}"#);
    }

    #[test]
    fn rejects_floats() {
        assert!(to_canonical(&serde_json::json!({"a": 1.5})).is_err());
    }
}
