//! Name collisions (PROTOTYPE): a campaign name that looks like one already listed, or like a reserved name, is refused.
//!
//! Two names collide when their skeletons are equal or nearly equal. The skeleton folds case, drops accents, maps letters that look alike
//! (Cyrillic and Greek look alikes, digits that pass for letters, "rn" for "m", "vv" for "w", i and l and 1 and |) to one letter, and drops
//! everything but letters and digits. "Nearly equal" is an edit distance of 1 for names of 4 to 11 skeleton characters, 2 from 12. The name is
//! never used for anything but this comparison and display; it is never a key, a path or a link.

use unicode_normalization::UnicodeNormalization;

fn fold_char(c: char) -> Option<char> {
    Some(match c {
        // Cyrillic look alikes
        'а' => 'a', 'в' => 'b', 'е' | 'ё' | 'є' => 'e', 'к' => 'k', 'м' => 'm', 'н' => 'h', 'о' => 'o', 'р' => 'p', 'с' => 'c', 'т' => 't',
        'у' => 'y', 'х' => 'x', 'ѕ' => 's', 'і' | 'ї' => 'l', 'ј' => 'j', 'ԁ' => 'd', 'ԛ' => 'q', 'ԝ' => 'w', 'һ' => 'h', 'ӏ' => 'l',
        // Greek look alikes
        'α' => 'a', 'β' => 'b', 'ε' => 'e', 'η' => 'n', 'ι' => 'l', 'κ' => 'k', 'ν' => 'v', 'ο' => 'o', 'ρ' => 'p', 'τ' => 't', 'υ' => 'u',
        'χ' => 'x', 'ω' => 'w', 'γ' => 'y', 'μ' => 'u',
        // digits and signs that pass for letters
        '0' => 'o', '1' | '|' | '!' | 'i' | 'í' | 'ı' => 'l', '3' => 'e', '4' | '@' => 'a', '5' | '$' => 's', '7' => 't', '8' => 'b', '9' => 'g',
        'ɡ' => 'g', 'ɑ' => 'a',
        c if c.is_alphanumeric() => c,
        _ => return None,
    })
}

/// The comparison form of a name.
pub fn skeleton(name: &str) -> String {
    let lowered: String = name.nfkd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect::<String>().to_lowercase();
    let mut s: String = lowered.chars().filter_map(fold_char).collect();
    // pairs that read as one letter
    for (from, to) in [("rn", "m"), ("vv", "w"), ("cl", "d")] {
        s = s.replace(from, to);
    }
    s
}

fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Whether two names are too alike to be listed side by side.
pub fn collides(a: &str, b: &str) -> bool {
    let (x, y) = (skeleton(a), skeleton(b));
    if x.is_empty() || y.is_empty() {
        return false;
    }
    if x == y {
        return true;
    }
    let n = x.chars().count().min(y.chars().count());
    let allowed = if n >= 12 { 2 } else if n >= 4 { 1 } else { 0 };
    distance(&x, &y) <= allowed
}

/// A reserved word (for example "clewbook") that no listed name may contain, in any look alike spelling.
pub fn contains_reserved(name: &str, word: &str) -> bool {
    let w = skeleton(word);
    !w.is_empty() && skeleton(name).contains(&w)
}

/// Letters outside plain Latin (with their code points), so an operator can see that "Gаrden" is not "Garden" before approving.
pub fn unusual_letters(name: &str) -> Vec<String> {
    let mut out: Vec<String> = name.chars().filter(|c| !c.is_ascii()).map(|c| format!("{c} (U+{:04X})", c as u32)).collect();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn look_alikes_and_case_and_accents_collide() {
        assert!(collides("Garden Fund", "garden fund"));
        assert!(collides("Garden Fund", "Gаrden Fund")); // Cyrillic а
        assert!(collides("Garden Fund", "Gärden Fünd"));
        assert!(collides("Pre-seed Raise", "Pre seed Ra1se"));
        assert!(collides("Modern Art", "Mod ern Art"));
        assert!(collides("Modern Art", "Rnodern Art")); // rn for m
        assert!(collides("Garden Fund", "Garden Funds")); // one letter apart
    }

    #[test]
    fn different_names_do_not_collide() {
        assert!(!collides("Garden Fund", "School Roof"));
        assert!(!collides("Lagos billboard", "Accra billboard"));
        assert!(!collides("Ab", "Ac")); // too short for a near match
    }

    #[test]
    fn unusual_letters_are_named() {
        assert_eq!(unusual_letters("Gаrden Fund"), vec!["а (U+0430)".to_string()]);
        assert!(unusual_letters("Garden Fund").is_empty());
    }

    #[test]
    fn reserved_words_are_caught_in_disguise() {
        assert!(contains_reserved("Official C1ewbook Raise", "clewbook"));
        assert!(contains_reserved("clewb00k presale", "Clewbook"));
        assert!(!contains_reserved("Garden Fund", "clewbook"));
    }
}
