// Level 3 (SPEC §3.1): checks a ticket's zero-knowledge proof in the background. Loaded only when the person presses "Check the proof too".
// The page can stop it at any time by ending this worker.
import init, { Checker } from './proof/ll_proofcheck.js';

self.onmessage = async (e) => {
  try {
    postMessage({ type: 'status', text: 'Loading the proof checker…' });
    await init();
    postMessage({ type: 'status', text: 'Preparing the proof checker. This happens once and can take up to a minute on a phone…' });
    const checker = new Checker();
    postMessage({ type: 'status', text: 'Checking the proof…' });
    postMessage({ type: 'result', ok: checker.verify(e.data.raw_hex, e.data.branch) });
  } catch (err) {
    postMessage({ type: 'error', text: String(err && err.message || err) });
  }
};
