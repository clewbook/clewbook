//! The chain height, for "the deadline is still ahead" (PROTOTYPE): one gRPC-web GetLatestBlock call to a lightwalletd server the operator
//! chooses (never an address from a record). The same call the pages make (app/web/www/public.js, tipOf).

use anyhow::{Result, anyhow, ensure};
use std::io::Read;
use std::time::Duration;

pub const DEFAULT_TESTNET: &str = "https://zjs.zec.rocks/testnet";
pub const DEFAULT_MAINNET: &str = "https://zjs.zec.rocks/mainnet";

fn varint(b: &[u8]) -> Option<(u64, usize)> {
    let mut v = 0u64;
    for (i, x) in b.iter().enumerate().take(10) {
        v |= u64::from(x & 0x7f) << (7 * i);
        if x & 0x80 == 0 {
            return Some((v, i + 1));
        }
    }
    None
}

pub fn latest_height(server: &str) -> Result<u32> {
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout(Duration::from_secs(15)).redirects(0).build();
    let resp = agent
        .post(&format!("{}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock", server.trim_end_matches('/')))
        .set("content-type", "application/grpc-web+proto")
        .set("x-grpc-web", "1")
        .send_bytes(&[0, 0, 0, 0, 0])
        .map_err(|e| anyhow!("the chain server could not be read: {e}"))?;
    let mut buf = vec![];
    resp.into_reader().take(4096).read_to_end(&mut buf)?;
    ensure!(buf.len() >= 5 && buf[0] == 0, "unexpected answer from the chain server");
    let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
    let msg = buf.get(5..5 + len).ok_or_else(|| anyhow!("short answer from the chain server"))?;
    // BlockID { uint64 height = 1; bytes hash = 2; }
    let mut i = 0;
    while i < msg.len() {
        let (key, n) = varint(&msg[i..]).ok_or_else(|| anyhow!("bad answer"))?;
        i += n;
        match (key >> 3, key & 7) {
            (1, 0) => {
                let (h, _) = varint(&msg[i..]).ok_or_else(|| anyhow!("bad answer"))?;
                return u32::try_from(h).map_err(|_| anyhow!("bad height"));
            }
            (_, 0) => i += varint(&msg[i..]).ok_or_else(|| anyhow!("bad answer"))?.1,
            (_, 2) => {
                let (l, n) = varint(&msg[i..]).ok_or_else(|| anyhow!("bad answer"))?;
                i += n + l as usize;
            }
            _ => return Err(anyhow!("bad answer")),
        }
    }
    Err(anyhow!("the chain server's answer has no height"))
}
