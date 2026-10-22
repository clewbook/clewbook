#!/usr/bin/env python3
"""End to end check of the operator bot on the test network (no money but test coins): a stand in for Telegram's API on this computer, the
real bot, a real blind bid host (test network) with a quick test auction whose coin wallet holds a little, and a real cb-listing on a
throwaway folder. It plays the owner and a stranger and checks every command, the confirm buttons, the rate limit, the "bids are open"
alert and a real close.

Usage: python3 app/opbot/opbot-e2e.py <host url> <campaign id> <cb-listing binary> <listing folder> <testnet payout address> <work folder>
"""
import http.server, json, os, subprocess, sys, threading, time

HOST, CID, LISTING, LDIR, PAYOUT, WORK = sys.argv[1:7]
SHORT, OWNER, STRANGER, PORT = CID[:8], 111, 999, 18931
failed = 0


def check(name, ok, extra=""):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + str(extra)[:220]) if extra else ''}", flush=True)
    failed += 0 if ok else 1


class Fake:
    updates, sent, lock, next_id = [], [], threading.Lock(), 1


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        method = self.path.rsplit("/", 1)[-1]
        assert self.path.startswith("/botTEST-TOKEN/"), self.path
        result = True
        if method == "getUpdates":
            end = time.time() + min(body.get("timeout", 1), 2)
            while time.time() < end:
                with Fake.lock:
                    ready = [u for u in Fake.updates if u["update_id"] >= body.get("offset", 0)]
                if ready:
                    break
                time.sleep(0.1)
            result = ready
        elif method == "sendMessage":
            with Fake.lock:
                Fake.sent.append(body)
            result = {"message_id": len(Fake.sent)}
        out = json.dumps({"ok": True, "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(out)


def push(kind, user, payload):
    with Fake.lock:
        uid = Fake.next_id
        Fake.next_id += 1
        if kind == "message":
            Fake.updates.append({"update_id": uid, "message": {"message_id": uid, "from": {"id": user}, "chat": {"id": user}, "text": payload}})
        else:
            Fake.updates.append({"update_id": uid, "callback_query": {"id": str(uid), "from": {"id": user}, "message": {"chat": {"id": user}}, "data": payload}})


ALERTS = ("the coin wallet is low", "the bids are open", "hours left to close", "hour left to close", "did not finish")


def replies_after(n, wait=6.0, want=1, alerts=False):
    """The bot's messages after the n-th, without its alerts (they come on their own schedule) unless asked for."""
    keep = lambda m: alerts or not any(a in m["text"] for a in ALERTS)
    end = time.time() + wait
    while time.time() < end:
        with Fake.lock:
            got = [m for m in Fake.sent[n:] if keep(m)]
        if len(got) >= want:
            break
        time.sleep(0.2)
    with Fake.lock:
        return [m for m in Fake.sent[n:] if keep(m)]


def say(text, user=OWNER, wait=8.0):
    n = len(Fake.sent)
    push("message", user, text)
    r = replies_after(n, wait)
    return r[0]["text"] if r else None, (r[0].get("reply_markup") if r else None)


def press(markup, which, user=OWNER, wait=60.0):
    data = markup["inline_keyboard"][0][0 if which == "ok" else 1]["callback_data"]
    n = len(Fake.sent)
    push("callback", user, data)
    r = replies_after(n, wait)
    return r[0]["text"] if r else None


def status():
    return json.loads(subprocess.run(["curl", "-s", f"{HOST}/api/campaigns/{CID}"], capture_output=True, text=True).stdout)


def start_bot(payout_lines):
    creds = os.path.join(WORK, "creds")
    os.makedirs(creds, exist_ok=True)
    with open(os.path.join(creds, "telegram"), "w") as f:
        f.write(f"token=TEST-TOKEN\nchat_id={OWNER}\napi=http://127.0.0.1:{PORT}\n")
    with open(os.path.join(creds, "payout"), "w") as f:
        f.write(payout_lines)
    log = open(os.path.join(WORK, "bot.log"), "a")
    return subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "opbot.py"), "--hosts", f"test={HOST}", "--listing", f"{LISTING} --dir {LDIR}",
                             "--state", os.path.join(WORK, "state.json"), "--credentials", creds, "--poll-timeout", "1", "--alert-every", "5"], stdout=log, stderr=log)


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    bot = start_bot(f"test={PAYOUT}\n")
    try:
        time.sleep(2)
        text, _ = say("/status", user=STRANGER, wait=4)
        botlog = open(os.path.join(WORK, "bot.log")).read()
        check("a stranger gets no answer, and is logged", text is None and f"ignored a message from user {STRANGER}" in botlog)
        text, _ = say("/help")
        check("/help lists the commands", text and "/send_coin_back" in text and "/approve" in text, text)
        text, _ = say("/status")
        check("/status names the auction, its network, deadline, deposits, coin wallet and treasury", text and f"({SHORT}, testnet, blind bid)" in text and "coin wallet" in text and "treasury" in text and "can close now" in text, text)
        text, _ = say("/queue", wait=30)
        check("/queue answers with the listing job's queue", text is not None, text)
        text, _ = say("/approve zzzz")
        check("/approve refuses something that is not a fingerprint", text and "not a host fingerprint" in text, text)
        text, _ = say("/approve 0000 0000 0000 0000 0000 Test Label", wait=30)
        check("/approve passes a well formed fingerprint and label to the listing job (which answers for an unknown host)", text is not None and "not a host fingerprint" not in text, text)
        text, _ = say(f"/hide {'ab' * 32}", wait=30)
        check("/hide passes a campaign id to the listing job", text is not None, text)
        text, _ = say("/hide ; rm -rf /")
        check("/hide refuses anything that is not a fingerprint or an id (no shell, no odd words)", text and "neither" in text, text)
        text, _ = say(f"/send_treasury {SHORT}")
        check("/send_treasury before the close: nothing to send", text and "nothing to send" in text, text)
        s = status()
        if s.get("phase") == "open":
            text, _ = say(f"/close {SHORT}")
            check("/close before the deadline is refused with the reason", text and "cannot be closed now" in text and "deadline" in text, text)
        time.sleep(61)  # a fresh minute for the rate limit (10 commands so far)
        # the coin wallet: wait until the host has seen the funding, then send it back through the bot
        end = time.time() + 600
        while time.time() < end and not ((status().get("sealed") or {}).get("coins_back_zat") or 0):
            time.sleep(10)
        amount = (status().get("sealed") or {}).get("coins_back_zat") or 0
        check("the host sees the coin wallet's funding", amount > 0, amount)
        text, markup = say(f"/send_coin_back {SHORT}")
        check("/send_coin_back asks first, with the exact amount and the payout address", markup and f"{amount / 1e8:.8f}".rstrip("0") in text and PAYOUT[:8] in text, text)
        got = press(markup, "ok", user=STRANGER, wait=4)
        check("a stranger pressing Confirm is ignored", got is None)
        got = press(markup, "no")
        check("Cancel sends nothing", got and "Cancelled" in got, got)
        got = press(markup, "ok", wait=4)
        check("a used button does not work again", got and "expired" in got, got)
        text, markup = say(f"/send_coin_back {SHORT}")
        got = press(markup, "ok", wait=300)
        check("Confirm sends the coin wallet back: a transaction id", got and got.startswith("Done: transaction ") and len(got.split()[-1]) == 64, got)
        # the rate limit: after a quiet minute, 12 commands at once get at most 10 answers
        time.sleep(61)
        n = len(Fake.sent)
        for _ in range(12):
            push("message", OWNER, "/help")
        r = replies_after(n, wait=15, want=12)
        told = [m for m in r if m["text"].startswith("Too many commands at once")]
        check("the rate limit: 12 commands in a burst, 10 answered and the owner told once", len(r) == 11 and len(told) == 1, [m["text"][:30] for m in r])
        time.sleep(61)
        # the alert when the bids open, then a real close through the bot
        z = status()["sealed"]
        wait = z["round_time"] - time.time()
        print(f"waiting {max(0, int(wait))} s for drand round {z['round']}", flush=True)
        end = time.time() + max(0, wait) + 900
        alert = None
        while time.time() < end and not alert:
            with Fake.lock:
                alert = next((m["text"] for m in Fake.sent if "the bids are open" in m["text"]), None)
            time.sleep(5)
        check("the alert when the bids open names the last block to close", alert and "Close before block" in alert and f"/close {SHORT}" in alert, alert)
        text, markup = say(f"/close {SHORT}")
        check("/close asks first, naming what it does and the last block", markup and "cannot be undone" in text and "Close before block" in text, text)
        got = press(markup, "ok", wait=600)
        check("Confirm closes the auction", got and got.startswith("Done"), got)
        text, _ = say("/status")
        check("/status shows it closed", text and f"({SHORT}, testnet, blind bid): closed" in text, text)
    finally:
        bot.terminate()
    # without a testnet payout address the money commands say so
    bot = start_bot("")
    try:
        time.sleep(2)
        text, _ = say(f"/send_coin_back {SHORT}")
        check('without a testnet payout address: "No testnet payout address saved."', text == "No testnet payout address saved.", text)
    finally:
        bot.terminate()
        srv.shutdown()
    print("ALL PASS" if not failed else f"{failed} check(s) failed", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
