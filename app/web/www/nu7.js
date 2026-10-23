// NU7 (ZIP 218): blocks every 25 s instead of 75 s from these heights on. The same table as ll_core::rules::nu7_height: a private test
// chain has none. A campaign made from NU7 on has three times the blocks in each window; one made before keeps its own (its rules are signed).
export const NU7_HEIGHT = { main: 3543405, test: 4465026 };

/** Whether a campaign starting at `startHeight` on `network` was made after NU7. */
export const afterNu7 = (network, startHeight) => NU7_HEIGHT[network] != null && startHeight >= NU7_HEIGHT[network];

/** The first block to measure the block time from, `span` blocks back from `tip`, but never before NU7 once the tip is past it: blocks of
 *  75 s and 25 s together would give a time that is neither. */
export function firstMeasured(network, tip, span) {
  const a = NU7_HEIGHT[network];
  const h0 = Math.max(1, tip - span);
  return a != null && tip >= a ? Math.max(h0, a) : h0;
}
