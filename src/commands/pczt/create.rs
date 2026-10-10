#![allow(deprecated)]
use std::{num::NonZeroUsize, path::PathBuf, str::FromStr};

use anyhow::anyhow;
use clap::Args;
use crate::rng::OsRng;
use tokio::{
    fs::File,
    io::{AsyncWriteExt, stdout},
};
use uuid::Uuid;

use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        Account as _,
        wallet::{
            ConfirmationsPolicy, create_pczt_from_proposal,
            input_selection::{
                GreedyInputSelector, LockedInputPolicy, NonEmptyBTreeSet, SpendPolicy,
            },
            propose_transfer,
        },
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock};
use zcash_protocol::{
    ShieldedPool,
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zip321::{Payment, TransactionRequest};

use crate::{commands::select_account, config::WalletConfig, data::get_db_paths, error};

// Options accepted for the `pczt create` command
#[derive(Debug, Args)]
pub(crate) struct Command {
    /// The UUID of the account to send funds from
    account_id: Option<Uuid>,

    /// The recipient's Unified, Sapling or transparent address
    #[arg(long)]
    address: String,

    /// The amount in zatoshis
    #[arg(long)]
    value: u64,

    /// A memo to send to the recipient
    #[arg(long)]
    memo: Option<String>,

    /// Override the transaction expiry height. 0 disables expiry entirely
    /// (used for pre-signed refund tickets that may be broadcast much later).
    #[arg(long)]
    expiry_height: Option<u32>,

    /// Use a discarded outgoing viewing key, so nobody (not even holders of this
    /// wallet's viewing keys) can recover the recipient or memo of the outputs.
    #[arg(long)]
    discard_ovk: bool,

    /// Minimum confirmations required for notes to be spendable, applied to trusted
    /// and untrusted notes alike. Defaults to the standard policy (3 trusted / 10 untrusted).
    #[arg(long)]
    min_confirmations: Option<std::num::NonZeroU32>,

    /// Prefer notes locked by these owner labels (see `wallet lock-note`; repeatable). With the
    /// notes' values covering the payment exactly, this spends exactly those notes.
    #[arg(long)]
    spend_locked_by: Vec<String>,

    /// Note management: the number of notes to maintain in the wallet
    #[arg(long)]
    #[arg(default_value_t = 4)]
    target_note_count: usize,

    /// Note management: the minimum allowed value for split change amounts
    #[arg(long)]
    #[arg(default_value_t = 10000000)]
    min_split_output_value: u64,

    /// Path to a file to which to write the PCZT. If not provided, writes to stdout.
    #[arg(long)]
    output: Option<PathBuf>,
}

impl Command {
    pub(crate) async fn run(self, wallet_dir: Option<String>) -> Result<(), anyhow::Error> {
        let config = WalletConfig::read(wallet_dir.as_ref())?;
        let params = config.network();

        let (_, db_data) = get_db_paths(wallet_dir.as_ref());
        let mut db_data = WalletDb::for_path(db_data, params, SystemClock, OsRng)?;
        let account = select_account(&db_data, self.account_id)?;

        // Create the PCZT.
        let change_strategy = MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Orchard,
            DustOutputPolicy::default(),
            SplitPolicy::with_min_output_value(
                NonZeroUsize::new(self.target_note_count)
                    .ok_or(anyhow!("target note count must be nonzero"))?,
                Zatoshis::from_u64(self.min_split_output_value)?,
            ),
        );
        let input_selector = GreedyInputSelector::new();

        let request = TransactionRequest::new(vec![
            Payment::new(
                ZcashAddress::from_str(&self.address)
                    .map_err(|_| error::Error::InvalidRecipient)?,
                Some(Zatoshis::from_u64(self.value).map_err(|_| error::Error::InvalidAmount)?),
                self.memo
                    .map(|memo| Memo::from_str(&memo))
                    .transpose()?
                    .map(MemoBytes::from),
                None,
                None,
                vec![],
            )
            .map_err(|e| e.with_index(0))?,
        ])
        .map_err(error::Error::from)?;

        let proposal = propose_transfer(
            &mut db_data,
            &params,
            account.id(),
            &input_selector,
            &change_strategy,
            request,
            self.min_confirmations.map_or_else(ConfirmationsPolicy::default, |n| {
                ConfirmationsPolicy::new_symmetrical(n, true)
            }),
            // Preserve the pre-upgrade behavior: transfers never spend
            // transparent UTXOs; they must be shielded first.
            &NonEmptyBTreeSet::from_set(
                self.spend_locked_by
                    .iter()
                    .map(|label| crate::commands::wallet::lock_note::lock_owner_from_label(label))
                    .collect(),
            )
            .map_or_else(SpendPolicy::default, |owners| {
                SpendPolicy::default()
                    .with_locked_input_policy(LockedInputPolicy::PreferLocked(owners))
            }),
            None,
            None,
        )
        .map_err(error::Error::from)?;

        let pczt = create_pczt_from_proposal(
            &mut db_data,
            &params,
            &SystemClock,
            &mut OsRng,
            account.id(),
            if self.discard_ovk {
                OvkPolicy::Discard
            } else {
                OvkPolicy::Sender
            },
            &proposal,
            // Builder-derived expiry unless overridden (0 = never expires).
            self.expiry_height
                .map(zcash_protocol::consensus::BlockHeight::from_u32),
            zcash_primitives::transaction::builder::BundlePadding::DEFAULT,
        )
        .map_err(error::Error::from)?;

        let pczt_bytes = pczt
            .serialize()
            .map_err(|e| anyhow!("Failed to serialize PCZT: {:?}", e))?;
        if let Some(output_path) = &self.output {
            let mut file = File::create(output_path).await?;
            file.write_all(&pczt_bytes).await?;
            file.flush().await?;
        } else {
            let mut stdout = stdout();
            stdout.write_all(&pczt_bytes).await?;
            stdout.flush().await?;
        }

        Ok(())
    }
}
