// The capability card's content, built from a campaign's committed rules (the summary the WebAssembly module returns after it has checked the
// rules against the campaign id, plus the rules themselves). Only the descriptions of the engine's checks are fixed text; every value and every
// "this applies" decision comes from the rules. Shared with the recount page, which lists the same "not checked" items.

/** What a recount cannot see or did not run, whatever the campaign. Remove the anchoring line once anchoring is built. */
export const NOT_CHECKED = [
  ['the amount each payment message promised', "it needs the contributor's one time secret, which only a published challenge reveals"],
  ['the proof inside each refund ticket', 'it is checked only on a contributor\'s own device, when they press "Check the proof too"'],
  ['Ticket anchors', "whether each ticket's chain anchor is still valid is not checked"],
  ['Ledger anchoring', "once the campaign is closed, the host signs the list's fingerprint (the number of entries and the hash of the last one), but it is not anchored on any public ledger"],
  ['When each ticket was issued', "the issue height in the list is the host's own statement; the recount cannot check it"],
  ['Whether the host spent a contribution first', 'nothing prevents it; R5 and R6 show such a spend after it happens'],
  ['This page', "its code is served by the project's own server; the command line recount can be built from the source instead"],
];

/** The ticket checks, by level (SPEC section 3.1). `when` says when the contributor's page runs the level. */
export const LEVELS = [
  { level: 1, when: 'automatic, on every ticket', chip: 'open', ids: ['readable', 'matches_list', 'shape', 'signatures', 'network_version', 'no_expiry', 'fee', 'spends_your_coin', 'coin_unspent', 'coin_used_by_list', 'your_amount'],
    what: 'The ticket is the one the signed list names, has the expected shape, carries valid signatures, is for the network version in use, has no expiry height, pays the stated fee, spends your contribution, and the coin is unspent.' },
  { level: 2, when: 'automatic, on tickets issued in the current format', chip: 'open', ids: ['pays_you'],
    what: 'The refund output is recomputed from the values sealed with the ticket and the address you gave, and must equal the output inside the ticket itself. Older tickets cannot be checked this way and say so.' },
  { level: 3, when: 'only when you press "Check the proof too"', chip: 'open', ids: ['proof'],
    what: 'The zero knowledge proof inside the ticket is verified on your device by a separate module that is downloaded only on request.' },
  { level: 4, when: 'not built yet', chip: 'nc', ids: ['anchor'],
    what: "The ticket's chain anchor is checked to be a real earlier state of the chain." },
];

const NET = { test: { label: 'Test network', money: 'no real money', ticker: 'TAZ' }, main: { label: 'Main network', money: 'real money', ticker: 'ZEC' } };

/** Which recount checks apply to this campaign, from its rules: R1 to R8 and R4b always, R9 to R12 for a uniform-price auction. */
export function appliesTo(rules) {
  const uniform = rules.mode === 'auction' && rules.pricing === 'uniform';
  return { uniform, checks: ['R1', 'R2', 'R3', 'R4', 'R4b', 'R5', 'R6', 'R7', 'R8', ...(uniform ? ['R9', 'R10', 'R11', 'R12'] : [])] };
}

/** The values the card prints, all taken from the rules. `secondsPerBlock` is a measurement or null. */
export function cardModel(summary, rules, secondsPerBlock = null) {
  const net = NET[summary.network] || { label: summary.network, money: '', ticker: summary.ticker };
  const { uniform, checks } = appliesTo(rules);
  const terms = [
    ['Type', rules.mode === 'auction' ? (uniform ? 'Auction, one price for every winner' : 'Auction') : 'Fundraiser'],
    ['Network', summary.network === 'main' ? 'Mainnet' : summary.network === 'test' ? 'Testnet' : `${net.label}`],
    // a fundraiser with a hard cap says "soft cap" and "hard cap"; one without keeps the word "goal"
    ...(rules.mode !== 'raise' ? [['Items for sale', String(summary.items)]] : summary.cap_zat == null ? [['Goal', { amount: summary.goal_zat, ticker: net.ticker }]] : [
      ['Soft cap', { amount: summary.goal_zat, ticker: net.ticker }],
      ['Hard cap (payments over it are refunded at the close)', { amount: summary.cap_zat, ticker: net.ticker }],
    ]),
    ...(uniform ? [['Reserve price', { amount: summary.reserve_zat, ticker: net.ticker }]] : []),
    ['Smallest contribution', { amount: summary.min_zat, ticker: net.ticker }],
    ['Refund fee kept', { amount: summary.fee_zat, ticker: net.ticker }],
    ['Deadline', { block: summary.deadline_height }],
    ['Ticket window', { blocks: summary.ticket_k, seconds: secondsPerBlock ? summary.ticket_k * secondsPerBlock : null }],
    ['Reissue window after a network upgrade', { blocks: rules.reissue_window, seconds: secondsPerBlock ? rules.reissue_window * secondsPerBlock : null }],
    ...(uniform ? [['Settlement window', { blocks: summary.settle_window, seconds: secondsPerBlock ? summary.settle_window * secondsPerBlock : null }]] : []),
  ];
  const notChecked = [...NOT_CHECKED];
  if (rules.mode === 'auction') notChecked.splice(1, 0, ['Your amount (on the ticket check)', 'in an auction, bid amounts are not on the public list before the close, so the list cannot show the amount you meant to pay']);
  return { net, terms, checks, uniform, notChecked, levels: LEVELS };
}
