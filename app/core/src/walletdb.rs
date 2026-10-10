//! Read-only access to a `zcash_client_sqlite` wallet database: the notes an account
//! received, with nullifiers, memos, spends and lock state.

use std::path::Path;

use anyhow::Result;
use rusqlite::{Connection, OpenFlags};

use crate::recount::{ChainNote, Spend};

#[derive(Clone, Debug)]
pub struct WalletNote {
    pub note: ChainNote,
    pub memo_raw: Option<Vec<u8>>,
    pub lock_owner: Option<String>,
    pub lock_expiry: Option<u32>,
}

/// Txids are stored in internal byte order; display order is reversed.
fn display_txid(raw: &[u8]) -> String {
    let mut b = raw.to_vec();
    b.reverse();
    hex::encode(b)
}

pub use crate::memo_text;

fn open(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?)
}

pub fn read_notes(path: &Path) -> Result<Vec<WalletNote>> {
    let conn = open(path)?;
    let mut stmt = conn.prepare(
        "SELECT t.txid, n.action_index, n.value, n.nf, t.mined_height, n.memo, n.is_change,
                n.lock_owner, n.lock_expiry_height,
                (SELECT st.txid FROM ironwood_received_note_spends s
                   JOIN transactions st ON st.id_tx = s.transaction_id
                  WHERE s.ironwood_received_note_id = n.id
                  ORDER BY st.mined_height IS NULL, st.mined_height LIMIT 1),
                (SELECT st.mined_height FROM ironwood_received_note_spends s
                   JOIN transactions st ON st.id_tx = s.transaction_id
                  WHERE s.ironwood_received_note_id = n.id
                  ORDER BY st.mined_height IS NULL, st.mined_height LIMIT 1),
                t.tx_index
           FROM ironwood_received_notes n JOIN transactions t ON t.id_tx = n.transaction_id
          ORDER BY n.id",
    )?;
    let rows = stmt.query_map([], |r| {
        let txid: Vec<u8> = r.get(0)?;
        let nf: Option<Vec<u8>> = r.get(3)?;
        let memo: Option<Vec<u8>> = r.get(5)?;
        let lock_owner: Option<Vec<u8>> = r.get(7)?;
        let spent_txid: Option<Vec<u8>> = r.get(9)?;
        Ok(WalletNote {
            note: ChainNote {
                txid: display_txid(&txid),
                action: r.get(1)?,
                value_zat: r.get::<_, i64>(2)? as u64,
                nf: nf.map(hex::encode),
                height: r.get(4)?,
                tx_index: r.get(11)?,
                memo_text: memo.as_deref().and_then(memo_text),
                is_change: r.get(6)?,
                spent_by: spent_txid.map(|t| Spend {
                    txid: display_txid(&t),
                    height: r.get(10).ok().flatten(),
                }),
            },
            memo_raw: memo,
            lock_owner: lock_owner.map(hex::encode),
            lock_expiry: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The highest block the wallet has scanned.
pub fn scanned_height(path: &Path) -> Result<Option<u32>> {
    let conn = open(path)?;
    Ok(conn.query_row("SELECT MAX(height) FROM blocks", [], |r| r.get(0))?)
}

/// The first account's unified full viewing key.
pub fn account_ufvk(path: &Path) -> Result<Option<String>> {
    let conn = open(path)?;
    Ok(conn.query_row("SELECT ufvk FROM accounts ORDER BY id LIMIT 1", [], |r| r.get(0))?)
}
