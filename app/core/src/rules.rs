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
    /// Sealed bid auction only (mode `"sealed_auction"`, SPEC §9): tranches, pricing, the drand round, the late ticket block and how the host
    /// sends the coins. Absent in every other campaign, whose rules and ids are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed: Option<crate::sealed::Sealed>,
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

    /// A sealed bid auction (SPEC §9). It is not an `auction` in the older sense: its payments are deposits, not bids.
    pub fn is_sealed(&self) -> bool {
        self.mode == "sealed_auction" && self.sealed.is_some()
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
        // the second review, M4: only the networks this project knows (a relay or a page decides separately whether it takes regtest)
        if !matches!(self.network.as_str(), "main" | "test" | "regtest") {
            bail!("the network must be main, test or regtest, not {:?}", self.network);
        }
        if let Some(n) = &self.name {
            check_name(n)?;
        }
        if !(MIN_TICKET_K..=MAX_TICKET_K).contains(&self.ticket_k) {
            bail!("the ticket window K must be between {MIN_TICKET_K} and {MAX_TICKET_K} blocks, not {}", self.ticket_k);
        }
        if self.mode == "sealed_auction" {
            return self.validate_sealed();
        }
        if self.sealed.is_some() {
            bail!("blind bid settings belong only to a blind bid auction");
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

    /// The rules of a sealed bid auction (SPEC §9): its own settings, items, the hidden viewing key's hash, a treasury, and none of the
    /// fields that belong to the other modes.
    fn validate_sealed(&self) -> Result<()> {
        let Some(s) = &self.sealed else { bail!("a blind bid auction needs its blind bid settings") };
        if self.goal_zat.is_some() || self.campaign_ufvk.is_some() || self.cap_zat.is_some() || self.early_close.is_some() || self.pricing.is_some() || self.settle_window.is_some() {
            bail!("a blind bid auction has no goal, public viewing key, hard cap, early close, older pricing field or settlement window");
        }
        if !self.items.is_some_and(|n| n > 0) || self.ufvk_hash.is_none() || self.treasury_address.is_none() || self.treasury_ufvk.is_none() {
            bail!("a blind bid auction needs a number of items, the hash of its viewing key, a treasury address and its viewing key");
        }
        if self.reserve_zat == Some(0) {
            bail!("leave the reserve out instead of setting it to zero");
        }
        s.check(self)
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

#[cfg(test)]
mod sealed_tests {
    use super::*;
    use crate::sealed::{COIN_CUTOFF_BLOCKS, COIN_ZAT, CoinSending, QUICKNET_CHAIN_HASH, Sealed};

    /// Every existing campaign type, as published (testnet demo campaigns and the mainnet ones): the id each one was published under is still
    /// the id of its rules, and they all still validate. Adding the sealed bid mode must never change them.
    #[test]
    fn existing_campaign_ids_are_unchanged() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/testdata/existing-rules");
        let mut seen = 0;
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let id = p.file_stem().unwrap().to_str().unwrap().to_string();
            let r: Rules = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
            assert_eq!(hex::encode(r.id().unwrap()), id, "{}", p.display());
            r.validate().unwrap_or_else(|e| panic!("{id}: {e}"));
            assert!(r.sealed.is_none() && !r.is_sealed());
            seen += 1;
        }
        assert!(seen >= 8, "fundraisers (plain, hard cap, early close, named), uniform and pay your bid auctions, mainnet and testnet");
    }

    pub(crate) fn sealed_rules() -> Rules {
        let mut r: Rules = serde_json::from_str(r#"{"v":1,"network":"test","mode":"sealed_auction","items":1,"start_height":100,"deadline_height":1000,"ticket_k":30,"close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":10000000,"ufvk_hash":"aa","treasury_address":"utest1x","treasury_ufvk":"uviewtest1x","ledger_pubkey":"aa","payload_pubkey":"bb"}"#).unwrap();
        r.sealed = Some(Sealed {
            tranches_zat: vec![10_000_000, 30_000_000, 50_000_000, 100_000_000],
            pricing: "uniform".into(),
            drand_chain: QUICKNET_CHAIN_HASH.into(),
            drand_round: 40_000_000,
            claim_after: 1_500,
            coin_zat: COIN_ZAT,
            coin_cutoff: COIN_CUTOFF_BLOCKS,
            coin_sending: CoinSending::AtOnce,
            timing: Default::default(),
            open_payouts: false,
            long_tag: false,
            early_key: false,
            coin_margin: 0,
        });
        r
    }

    #[test]
    fn a_sealed_bid_auction_validates_and_has_its_own_id() {
        let r = sealed_rules();
        r.validate().unwrap();
        assert!(r.is_sealed() && !r.is_auction() && !r.is_uniform());
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains(r#""sealed":{"#) && json.contains(r#""coin_sending":{"mode":"at_once"}"#), "{json}");
        let back: Rules = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id().unwrap(), r.id().unwrap());
        // every setting is part of the id
        let mut other = sealed_rules();
        other.sealed.as_mut().unwrap().coin_sending = CoinSending::EveryBids { n: 3 };
        assert_ne!(other.id().unwrap(), r.id().unwrap());
        for p in ["second", "pay_your_bid"] {
            let mut x = sealed_rules();
            x.sealed.as_mut().unwrap().pricing = p.into();
            x.validate().unwrap();
        }
    }

    #[test]
    fn the_quick_test_timing_is_written_only_when_chosen_and_never_on_the_main_network() {
        let r = sealed_rules();
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("timing"), "{json}");
        let mut q = sealed_rules();
        q.sealed.as_mut().unwrap().timing = crate::sealed::Timing::Quick;
        q.validate().unwrap();
        let qj = serde_json::to_string(&q).unwrap();
        assert!(qj.contains(r#""timing":"quick""#), "{qj}");
        assert_ne!(q.id().unwrap(), r.id().unwrap());
        let back: Rules = serde_json::from_str(&qj).unwrap();
        assert_eq!(back.id().unwrap(), q.id().unwrap());
        let mut m = q.clone();
        m.network = "main".into();
        let e = m.sealed.as_ref().unwrap().check(&m).unwrap_err().to_string();
        assert!(e.contains("quick test timing is for the test network only"), "{e}");
    }

    #[test]
    fn the_published_sealed_proof_auctions_keep_their_ids() {
        // P1 to P4 of 20 Oct 2026 on the public test network, made before the timing setting existed
        let mut seen = 0;
        for e in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/existing-sealed-rules")).unwrap() {
            let p = e.unwrap().path();
            let id = p.file_stem().unwrap().to_str().unwrap().to_string();
            let r: Rules = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
            assert_eq!(hex::encode(r.id().unwrap()), id, "{}", p.display());
            r.validate().unwrap_or_else(|e| panic!("{id}: {e}"));
            assert!(r.sealed.as_ref().unwrap().timing.is_standard());
            seen += 1;
        }
        assert_eq!(seen, 4);
    }

    #[test]
    fn code_that_does_not_know_the_mode_refuses_it() {
        // an older reader drops the unknown "sealed" key, gets a different id, and refuses the campaign; the unknown mode is refused too
        let r = sealed_rules();
        let mut v: serde_json::Value = serde_json::to_value(&r).unwrap();
        v.as_object_mut().unwrap().remove("sealed");
        let older: Rules = serde_json::from_value(v).unwrap();
        assert_ne!(older.id().unwrap(), r.id().unwrap());
        assert!(older.validate().is_err());
        assert!(!older.is_auction());
    }

    #[test]
    fn bad_sealed_settings_are_refused() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Rules)>)> = vec![
            ("no tranches", Box::new(|r| r.sealed.as_mut().unwrap().tranches_zat.clear())),
            ("eleven tranches", Box::new(|r| { r.sealed.as_mut().unwrap().tranches_zat = (1..=11).map(|i| i * 10_000_000).collect(); })),
            ("tranches out of order", Box::new(|r| r.sealed.as_mut().unwrap().tranches_zat = vec![10_000_000, 50_000_000, 30_000_000])),
            ("smallest is not the minimum", Box::new(|r| r.min_contribution_zat = 20_000)),
            ("a tranche too small for a bid", Box::new(|r| { r.sealed.as_mut().unwrap().tranches_zat = vec![10_000, 30_000_000]; r.min_contribution_zat = 10_000; })),
            ("unknown pricing", Box::new(|r| r.sealed.as_mut().unwrap().pricing = "dutch".into())),
            ("another drand chain", Box::new(|r| r.sealed.as_mut().unwrap().drand_chain = "dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493".into())),
            ("late tickets before the deadline", Box::new(|r| r.sealed.as_mut().unwrap().claim_after = 1000)),
            ("a coin too small", Box::new(|r| r.sealed.as_mut().unwrap().coin_zat = 1_000)),
            ("a cutoff too short", Box::new(|r| r.sealed.as_mut().unwrap().coin_cutoff = 2)),
            ("every 0 bids", Box::new(|r| r.sealed.as_mut().unwrap().coin_sending = CoinSending::EveryBids { n: 0 })),
            ("no items", Box::new(|r| r.items = None)),
            ("no treasury", Box::new(|r| r.treasury_ufvk = None)),
            ("a goal", Box::new(|r| r.goal_zat = Some(1))),
            ("a public viewing key", Box::new(|r| r.campaign_ufvk = Some("uviewtest1x".into()))),
            ("the older pricing field", Box::new(|r| r.pricing = Some("uniform".into()))),
            ("a zero reserve", Box::new(|r| r.reserve_zat = Some(0))),
            ("no sealed settings", Box::new(|r| r.sealed = None)),
        ];
        for (name, f) in cases {
            let mut r = sealed_rules();
            f(&mut r);
            assert!(r.validate().is_err(), "{name} must be refused");
        }
        // sealed settings on another mode are refused
        let mut raise: Rules = serde_json::from_str(r#"{"v":1,"network":"test","mode":"raise","goal_zat":5000000,"start_height":100,"deadline_height":200,"ticket_k":30,"close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":20000,"campaign_ufvk":"uvftest1x","ledger_pubkey":"aa","payload_pubkey":"bb"}"#).unwrap();
        raise.validate().unwrap();
        raise.sealed = sealed_rules().sealed;
        assert!(raise.validate().is_err());
    }

    #[test]
    fn a_payment_counts_as_the_tranche_at_or_below_it() {
        let s = sealed_rules().sealed.unwrap();
        assert_eq!(s.tranche_of(30_000_000), Some(30_000_000));
        assert_eq!(s.tranche_of(20_000_000), Some(10_000_000));
        assert_eq!(s.tranche_of(200_000_000), Some(100_000_000));
        assert_eq!(s.tranche_of(9_999_999), None);
        assert_eq!(s.cutoff_height(1000), 990);
    }
}
