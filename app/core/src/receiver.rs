//! Refund receivers: raw 43-byte Orchard/Ironwood receivers, converted to and from
//! Unified Address strings.

use anyhow::{Result, anyhow, bail};
use zcash_address::unified::{self, Container, Encoding};
use zcash_protocol::consensus::NetworkType;

/// ZIP 316 typecode of an Orchard receiver (also used for Ironwood payments).
pub const TYPECODE_ORCHARD: u8 = 0x03;

/// Extracts the Orchard receiver from a Unified Address.
pub fn orchard_receiver(ua: &str) -> Result<(NetworkType, [u8; 43])> {
    let (net, _, addr) =
        unified::Address::decode(ua).map_err(|e| anyhow!("not a Unified Address: {e}"))?;
    for item in addr.items() {
        if let unified::Receiver::Orchard(raw) = item {
            return Ok((net, raw));
        }
    }
    bail!("the refund address has no Orchard/Ironwood receiver")
}

/// Encodes an Orchard receiver as a single-receiver Unified Address.
pub fn encode_orchard(net: NetworkType, raw: [u8; 43]) -> Result<String> {
    let addr = unified::Address::try_from_items(
        unified::Revision::R0,
        vec![unified::Uitem::Data(unified::Receiver::Orchard(raw))],
    )
    .map_err(|e| anyhow!("cannot encode receiver: {e}"))?;
    Ok(addr.encode(&net))
}

pub fn network_type(name: &str) -> Result<NetworkType> {
    match name {
        "main" => Ok(NetworkType::Main),
        "test" => Ok(NetworkType::Test),
        "regtest" => Ok(NetworkType::Regtest),
        _ => bail!("unknown network {name}"),
    }
}

/// Whether two UFVK strings hold the same keys. The same key has several valid encodings
/// (`uview…` Revision 0, `uvf…` Revision 1), so compare decoded items, never strings.
pub fn same_ufvk(a: &str, b: &str) -> Result<bool> {
    let (na, _, ka) = unified::Ufvk::decode(a).map_err(|e| anyhow!("bad UFVK: {e}"))?;
    let (nb, _, kb) = unified::Ufvk::decode(b).map_err(|e| anyhow!("bad UFVK: {e}"))?;
    let mut ia = ka.items();
    let mut ib = kb.items();
    ia.sort_by_key(|i| format!("{i:?}"));
    ib.sort_by_key(|i| format!("{i:?}"));
    Ok(na == nb && ia == ib)
}

/// The receivers inside a Unified Address, as short readable names (for logs and tests).
pub fn describe(ua: &str) -> Result<Vec<String>> {
    let (net, _, addr) =
        unified::Address::decode(ua).map_err(|e| anyhow!("not a Unified Address: {e}"))?;
    let mut out = vec![format!("network: {net:?}")];
    for item in addr.items() {
        out.push(match item {
            unified::Receiver::Orchard(raw) => format!("orchard/ironwood: {}", hex::encode(raw)),
            unified::Receiver::Sapling(raw) => format!("sapling: {}", hex::encode(raw)),
            unified::Receiver::P2pkh(raw) => format!("transparent p2pkh: {}", hex::encode(raw)),
            unified::Receiver::P2sh(raw) => format!("transparent p2sh: {}", hex::encode(raw)),
            other => format!("other: {other:?}"),
        });
    }
    Ok(out)
}

/// Re-encodes a Unified Address in the standard Revision 0 form that today's wallets accept
/// (`u1…` on mainnet, `utest1…` on testnet), carrying the same receivers. The prerelease
/// libraries write the Revision 2 form (`zu1…` / `zutest1…`), which current wallets reject.
pub fn to_standard(ua: &str) -> Result<String> {
    let (net, _, addr) =
        unified::Address::decode(ua).map_err(|e| anyhow!("not a Unified Address: {e}"))?;
    let items: Vec<_> = addr.items().into_iter().map(unified::Uitem::Data).collect();
    let r0 = unified::Address::try_from_items(unified::Revision::R0, items)
        .map_err(|e| anyhow!("cannot encode in the standard form: {e}"))?;
    Ok(r0.encode(&net))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_form_has_the_same_receivers() {
        let net = NetworkType::Test;
        let items = vec![
            unified::Uitem::Data(unified::Receiver::Orchard([7u8; 43])),
            unified::Uitem::Data(unified::Receiver::Sapling([9u8; 43])),
        ];
        let r2 = unified::Address::try_from_items(unified::Revision::R2, items).unwrap().encode(&net);
        assert!(r2.starts_with("zutest1"), "{r2}");
        let std = to_standard(&r2).unwrap();
        assert!(std.starts_with("utest1"), "{std}");
        assert_eq!(describe(&r2).unwrap(), describe(&std).unwrap());
        assert_eq!(orchard_receiver(&r2).unwrap(), orchard_receiver(&std).unwrap());
        // mainnet
        let m = unified::Address::try_from_items(
            unified::Revision::R2,
            vec![unified::Uitem::Data(unified::Receiver::Orchard([1u8; 43]))],
        ).unwrap().encode(&NetworkType::Main);
        assert!(m.starts_with("zu1"));
        assert!(to_standard(&m).unwrap().starts_with("u1"));
    }
}
