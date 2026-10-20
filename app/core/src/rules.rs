//! Campaign rules (SPEC §1).

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::{canon::to_canonical, hash};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rules {
    pub v: u32,
    pub network: String,
    /// `"raise"` or `"auction"`.
    pub mode: String,
    /// Raise: the amount that must be reached by the deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_zat: Option<u64>,
    /// Auction: number of items; the top `items` bids win.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<u32>,
    pub start_height: u32,
    pub deadline_height: u32,
    pub ticket_k: u32,
    pub close_grace: u32,
    pub reissue_window: u32,
    pub refund_fee_zat: u64,
    pub min_contribution_zat: u64,
    /// Raise: the campaign's UFVK, public from the start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub campaign_ufvk: Option<String>,
    /// Auction: `BLAKE2b-256("ledgerlab_ufvk", ufvk)`; the UFVK is revealed at close.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ufvk_hash: Option<String>,
    /// The campaign's payment address (a unified address). Part of the committed rules, so a
    /// link that carries only the campaign id cannot be made to point at another address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pay_to: Option<String>,
    /// Auction pricing: `"uniform"` (every winner pays the clearing price; SPEC §8). Absent: the
    /// older pay-your-bid sweep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<String>,
    /// Uniform auction: the reserve price (net of the fee, i.e. what the treasury receives), the
    /// floor of the clearing price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserve_zat: Option<u64>,
    /// Uniform auction: how many blocks after the deadline the host has to settle every winner (default
    /// `ticket_k`). Block times can be short, so a demo-sized window is larger than K.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settle_window: Option<u32>,
    /// Uniform auction: where the clearing prices are paid, and the PUBLIC viewing key of that
    /// dedicated account (so anyone can see what the treasury received).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub treasury_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub treasury_ufvk: Option<String>,
    /// Optional public name of the campaign, chosen by the host (SPEC §3). Plain text only (see `check_name`). Absent in older campaigns,
    /// whose rules and ids are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Fundraiser only: the host may close before the deadline once the goal is met (SPEC §4). Written only as `true`; left out of
    /// older campaigns (and of any campaign that does not allow it), whose rules and ids are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub early_close: Option<bool>,
    /// Fundraiser only: the hard cap, the most the campaign keeps (SPEC §4). At the close, the contributions not taken back are kept in chain
    /// order while they fit under it; a payment that does not fit is refunded whole, by its own ticket. The goal (the soft cap) is counted on the
    /// kept amount. Left out of every campaign without one, whose rules and ids are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap_zat: Option<u64>,
    pub ledger_pubkey: String,
    pub payload_pubkey: String,
}

/// The longest campaign name, in characters.
pub const MAX_NAME_CHARS: usize = 60;

/// A campaign name is public and part of the signed rules. It must be plain text: 1 to 60 characters, no leading or trailing space, no line
/// breaks or other control characters, no `<` or `>` (nothing that could pass for markup), and none of the invisible or direction-changing
/// characters that can make one name look like another.
pub fn check_name(name: &str) -> Result<()> {
    let n = name.chars().count();
    if n == 0 || n > MAX_NAME_CHARS {
        bail!("the campaign name must be 1 to {MAX_NAME_CHARS} characters, not {n}");
    }
    if name != name.trim() || name.contains("  ") {
        bail!("the campaign name must not start or end with a space or contain two spaces in a row");
    }
    for c in name.chars() {
        let cp = c as u32;
        let invisible = matches!(cp, 0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180E | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF9..=0xFFFB | 0xE0000..=0xE0FFF);
        if c.is_control() || invisible || c == '<' || c == '>' {
            bail!("the campaign name may not contain control, invisible or direction-changing characters, or the signs < and >");
        }
        if c.is_whitespace() && c != ' ' {
            bail!("the campaign name may only contain ordinary spaces");
        }
    }
    Ok(())
}

/// The longest settlement window a campaign may commit to (about a day at 75 s blocks).
pub const MAX_SETTLE_WINDOW: u32 = 1000;
/// The ticket window K (blocks) is chosen per campaign when it is created, within these bounds. Default 30 (see SPEC).
pub const MIN_TICKET_K: u32 = 10;
pub const MAX_TICKET_K: u32 = 1000;
pub const DEFAULT_TICKET_K: u32 = 30;

pub fn ufvk_hash(ufvk: &str) -> String {
    hex::encode(hash(b"ledgerlab_ufvk", ufvk.as_bytes()))
}

impl Rules {
    /// `rules_id = BLAKE2b-256("ledgerlab_rules", canonical JSON)`.
    pub fn id(&self) -> Result<[u8; 32]> {
        Ok(hash(b"ledgerlab_rules", to_canonical(self)?.as_bytes()))
    }

    /// An amount as people read it: trimmed (no trailing zeros, never rounded) with this network's unit, for example "0.0099 TAZ" or "1 ZEC".
    pub fn amount(&self, zat: u64) -> String {
        format!("{} {}", crate::coin(zat), if self.network == "main" { "ZEC" } else { "TAZ" })
    }

    /// After this height a contributor's page may broadcast their own ticket if the host has
    /// not closed: deadline + K (`ticket_k`). The contribute page, the recount page and the recount's
    /// hint all use this one rule. `close_grace` is kept in the rules (it is part of every campaign's
    /// id) but no longer decides anything: it was equal to K when K was fixed at 10.
    pub fn self_refund_after(&self) -> u32 {
        self.deadline_height + self.ticket_k
    }

    /// Whether the host may close this campaign before its deadline (a fundraiser whose rules say so, once the goal is met).
    pub fn allows_early_close(&self) -> bool {
        self.mode == "raise" && self.early_close == Some(true)
    }

    /// A plain warning when a fundraiser's hard cap is less than twice its goal (allowed, but risky): a payment that does not fit under the cap
    /// is refunded, so with little room above the goal the campaign can miss its goal even when enough was paid in.
    pub fn cap_warning(&self) -> Option<String> {
        let (cap, goal) = (self.cap_zat?, self.goal_zat?);
        (cap < goal.saturating_mul(2)).then(|| {
            "The hard cap is less than twice the soft cap: a payment that does not fit under the hard cap is refunded, so the campaign can miss its soft cap even when enough was paid in.".to_string()
        })
    }

    pub fn is_auction(&self) -> bool {
        self.mode == "auction"
    }

    pub fn is_uniform(&self) -> bool {
        self.is_auction() && self.pricing.as_deref() == Some("uniform")
    }

    /// Uniform auction: the host must settle every winner by this height (deadline + settle window,
    /// default K); after it, winners may self-refund.
    pub fn settle_by(&self) -> u32 {
        self.deadline_height + self.settle_window.unwrap_or(self.ticket_k)
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(n) = &self.name {
            check_name(n)?;
        }
        if !(MIN_TICKET_K..=MAX_TICKET_K).contains(&self.ticket_k) {
            bail!("the ticket window K must be between {MIN_TICKET_K} and {MAX_TICKET_K} blocks, not {}", self.ticket_k);
        }
        if self.pricing.is_some() || self.reserve_zat.is_some() || self.treasury_address.is_some() || self.treasury_ufvk.is_some() {
            if !(self.is_uniform() && self.reserve_zat.is_some_and(|r| r > 0) && self.treasury_address.is_some() && self.treasury_ufvk.is_some()) {
                bail!("a uniform-price auction needs pricing \"uniform\", a reserve above zero, a treasury address and its viewing key");
            }
        }
        if let Some(w) = self.settle_window {
            if !self.is_uniform() {
                bail!("a settlement window only applies to a uniform-price auction");
            }
            if w < self.ticket_k || w > MAX_SETTLE_WINDOW {
                bail!("the settlement window must be between {} (K) and {MAX_SETTLE_WINDOW} blocks, not {w}", self.ticket_k);
            }
        }
        if let Some(cap) = self.cap_zat {
            if self.mode != "raise" {
                bail!("only a fundraiser can have a hard cap; an auction has its number of items instead");
            }
            if self.goal_zat.is_some_and(|g| cap < g) {
                bail!("the hard cap must be at least the goal (the soft cap)");
            }
            if cap < self.min_contribution_zat {
                bail!("the hard cap must be at least the smallest contribution");
            }
        }
        match self.early_close {
            Some(true) if self.mode != "raise" => bail!("only a fundraiser can allow closing early; an auction never can"),
            Some(false) => bail!("leave early_close out instead of setting it to false"),
            _ => {}
        }
        match self.mode.as_str() {
            "raise" if self.goal_zat.is_some() && self.campaign_ufvk.is_some() => Ok(()),
            "auction" if self.items.is_some_and(|n| n > 0) && self.ufvk_hash.is_some() => Ok(()),
            m => bail!("rules for mode {m:?} are missing required fields"),
        }
    }
}

#[cfg(test)]
mod name_tests {
    use super::*;

    fn base() -> Rules {
        serde_json::from_str(r#"{"v":1,"network":"test","mode":"raise","goal_zat":5000000,"start_height":100,"deadline_height":200,"ticket_k":30,"close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":20000,"campaign_ufvk":"uvftest1x","ledger_pubkey":"aa","payload_pubkey":"bb"}"#).unwrap()
    }

    #[test]
    fn amounts_are_trimmed_with_the_networks_unit() {
        let mut r = base();
        assert_eq!(r.amount(990_000), "0.0099 TAZ");
        assert_eq!(r.amount(1), "0.00000001 TAZ");
        assert_eq!(r.amount(0), "0 TAZ");
        r.network = "main".into();
        assert_eq!(r.amount(100_000_000), "1 ZEC");
        assert_eq!(r.amount(123_456_789), "1.23456789 ZEC");
    }

    #[test]
    fn contributors_may_self_refund_after_deadline_plus_k_not_close_grace() {
        // the same rule as the contribute page (`refundMode`) and the recount page: deadline + ticket_k
        let r = base(); // K 30, close_grace 10
        assert_eq!(r.self_refund_after(), 230);
    }

    #[test]
    fn a_campaign_without_a_name_is_unchanged() {
        let r = base();
        assert!(r.name.is_none());
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("name"), "no name key when unset: {json}");
        r.validate().unwrap();
        // the id of a nameless campaign is what it was before names existed: it is the hash of the canonical JSON without the key
        let id = hex::encode(r.id().unwrap());
        let again: Rules = serde_json::from_str(&json).unwrap();
        assert_eq!(hex::encode(again.id().unwrap()), id);
    }

    #[test]
    fn the_name_is_part_of_the_id() {
        let plain = base();
        let mut named = base();
        named.name = Some("Radio mast".into());
        named.validate().unwrap();
        assert_ne!(plain.id().unwrap(), named.id().unwrap());
        let mut other = base();
        other.name = Some("Radio mast 2".into());
        assert_ne!(named.id().unwrap(), other.id().unwrap());
        let back: Rules = serde_json::from_str(&serde_json::to_string(&named).unwrap()).unwrap();
        assert_eq!(back.name.as_deref(), Some("Radio mast"));
        assert_eq!(back.id().unwrap(), named.id().unwrap());
    }

    #[test]
    fn length_limits() {
        assert!(check_name("a").is_ok());
        assert!(check_name(&"x".repeat(60)).is_ok());
        assert!(check_name(&"é".repeat(60)).is_ok(), "the limit counts characters, not bytes");
        assert!(check_name(&"x".repeat(61)).is_err());
        assert!(check_name("").is_err());
    }

    #[test]
    fn unusual_characters() {
        for ok in ["Café Ünïcode", "Lagos Community Radio Mast", "Stage 2: lights & sound", "Quiz night 2026 (rematch)", "東京の屋台", "Hello ☕"] {
            assert!(check_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            " leading", "trailing ", "two  spaces", "line\nbreak", "tab\there", "nul\0byte", "<b>bold</b>", "a > b", "<script>",
            "evil\u{202E}txt", "zero\u{200B}width", "bom\u{FEFF}x", "tag\u{E0041}x", "nbsp\u{00A0}x", "hair\u{2009}x", "sep\u{2028}x", "soft\u{00AD}hyphen",
        ] {
            assert!(check_name(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn validate_refuses_a_bad_name_inside_rules() {
        let mut r = base();
        r.name = Some("<b>x</b>".into());
        assert!(r.validate().is_err());
        r.name = Some("x".repeat(61));
        assert!(r.validate().is_err());
    }
}
