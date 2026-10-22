//! Sealed bid auctions (SPEC §9.1, open_payouts): every payment the host signs to a person (the refund signed with the deposit, a winner's change, the
//! return of a payment too late to bid, of a deposit without tickets, of a rejected or repeated payment) is made with an outgoing viewing
//! key that the person's page works out on its own, and that anyone works out once the host publishes its payload key at the reveal. So
//! the page and the recount both open the payment's outputs on the chain and see who it pays and how much (the independent review, C1 and
//! H2). A version 6 transaction id covers every output's note commitment and ciphertexts (ZIP 244 effecting data), so what is opened is what
//! was mined under that id.

use crate::hash;

/// The kinds of payment, part of the key: one key per deposit and kind.
pub const REFUND: &str = "refund";
pub const CHANGE: &str = "change";
pub const RETURN: &str = "return";
/// The early ticket (the second review, C1).
pub const EARLY: &str = "early";
/// The late ticket (the mentor's second review): a deposit taken back after the late ticket block is checked to have paid the person.
pub const LATE: &str = "late";

/// The X25519 secret shared by the host's payload key and the person's page key (`secret` one side's private key, `public` the other's
/// public key; both sides get the same value).
pub fn shared_secret(secret: &[u8; 32], public: &[u8; 32]) -> [u8; 32] {
    curve25519_dalek::montgomery::MontgomeryPoint(*public).mul_clamped(*secret).to_bytes()
}

/// The outgoing viewing key of the payment of `kind` for the payment or deposit `nf`.
pub fn payment_ovk(shared: &[u8; 32], nf: &str, kind: &str) -> [u8; 32] {
    let mut m = shared.to_vec();
    m.extend_from_slice(nf.as_bytes());
    m.push(0);
    m.extend_from_slice(kind.as_bytes());
    hash(b"ledgerlab_payovk", &m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_and_the_page_derive_the_same_key_and_nobody_else_does() {
        let host = crypto_box::SecretKey::from([7u8; 32]);
        let page = crypto_box::SecretKey::from([9u8; 32]);
        let other = crypto_box::SecretKey::from([11u8; 32]);
        let a = shared_secret(&host.to_bytes(), page.public_key().as_bytes());
        let b = shared_secret(&page.to_bytes(), host.public_key().as_bytes());
        assert_eq!(a, b);
        assert_ne!(a, shared_secret(&other.to_bytes(), host.public_key().as_bytes()));
        let nf = "ab".repeat(32);
        assert_ne!(payment_ovk(&a, &nf, REFUND), payment_ovk(&a, &nf, CHANGE));
        assert_ne!(payment_ovk(&a, &nf, REFUND), payment_ovk(&a, &"cd".repeat(32), REFUND));
        assert_eq!(payment_ovk(&a, &nf, RETURN), payment_ovk(&b, &nf, RETURN));
    }
}
