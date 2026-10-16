//! PROTOTYPE, testnet only, not merged and not deployed: listing other hosts' campaigns on a home page by an approved host key.
//!
//! - `record`: the signed listing record (host key and campaign ledger key over the same domain tagged bytes);
//! - `host`: the host's long lived key (made once, kept in a mode 600 file, never printed) and making a record for a campaign folder;
//! - `job`: the data folder, a pass (checks and decisions), the operator's lists, the outputs;
//! - `recount` and `chain`: the recount check before listing (the browser's recount module over the relays' ledger and the chain);
//! - `fetch`: reading a stranger's relay safely; `names`: name collisions; `serve`: the submission endpoint; `tip`: the chain height.

#[cfg(feature = "recount")]
pub mod chain;
pub mod fetch;
pub mod host;
pub mod job;
pub mod names;
pub mod record;
#[cfg(feature = "recount")]
pub mod recount;
pub mod serve;
pub mod tip;
