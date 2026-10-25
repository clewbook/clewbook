#!/usr/bin/env python3
"""Clewbook operator bot: the owner's Telegram commands for the hosts on the server (the blind bid hosts, test and main network) and the
listing job (the owner's request of 23 Oct 2026).

It polls Telegram (getUpdates, no webhook, no open port), answers only the owner's user id in the owner's chat, and acts only through the
hosts' dashboard API on 127.0.0.1 and three listing commands (queue, approve, hide), each run as a list of arguments, never through a shell.
It reads no wallet and holds no key: closing and sending happen inside the host program, which checks everything again.

Secrets come as systemd credentials (files owned by root, mode 600, handed to the service by LoadCredential=):
  telegram  token=<bot token>, chat_id=<the owner's chat id>, optionally user_id=<the owner's user id> (else the chat id: a private chat)
            and api=<Telegram API base> (tests only)
  payout    main=<the owner's mainnet address>, test=<the owner's testnet address>: the only places money is ever sent to
The token is never printed or logged.

Usage: opbot.py --hosts test=http://127.0.0.1:8797,main=http://127.0.0.1:8798 --state /var/lib/clewbook-opbot/state.json
               --listing 'sudo -n -u clewbook-listing /opt/clewbook-listing/cb-listing --dir /var/lib/clewbook-listing'
"""
import argparse, json, os, re, secrets, shlex, subprocess, sys, time, urllib.error, urllib.request

HELP = """Commands:
/status  every campaign on the server's hosts
/queue  the listing queue
/approve <fingerprint> [label]  approve a host (without a label: the name it suggested)
/hide <fingerprint or campaign id>  hide a host or a campaign from the home page
/close <short id>  close a blind bid auction (asks first)
/send_treasury <short id>  send the treasury to your payout address (asks first)
/send_coin_back <short id>  send the coin wallet back to your payout address (asks first)
/help  this list"""

SECONDS_PER_BLOCK = {"main": 75, "test": 25}  # before NU7 on the main network; the test network runs NU7's 25 s blocks
RATE = (10, 60)  # at most 10 commands (and button presses) a minute
CONFIRM_SECONDS = 300  # a confirm button works for 5 minutes
COIN_LOW_ZAT = 45_000  # about three more bids' small payments with their fees
FINGERPRINT = re.compile(r"^[0-9a-f]{4}( ?[0-9a-f]{4}){4}$")
CAMPAIGN_ID = re.compile(r"^[0-9a-f]{64}$")
SHORT_ID = re.compile(r"^[0-9a-f]{8}$")
LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .,'&()-]{0,29}$")


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def read_conf(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def zec(zat, ticker):
    s = f"{zat / 1e8:.8f}".rstrip("0").rstrip(".")
    return f"{s} {ticker}"


def short_addr(a):
    return f"{a[:8]}…{a[-6:]}" if len(a) > 20 else a


def eta(blocks, network):
    s = max(0, blocks) * SECONDS_PER_BLOCK.get(network, 75)
    return f"about {s // 3600} h {s % 3600 // 60:02d} min" if s >= 3600 else f"about {s // 60} min"


class Telegram:
    def __init__(self, conf):
        self.api = conf.get("api", "https://api.telegram.org").rstrip("/")
        self.token = conf["token"]

    def call(self, method, body, timeout=40):
        req = urllib.request.Request(f"{self.api}/bot{self.token}/{method}", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Telegram {method} answered HTTP {e.code}") from None  # never the address, which holds the token
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RuntimeError(f"Telegram {method} could not be reached ({type(e).__name__})") from None


class Bot:
    def __init__(self, tg, conf, payout, hosts, listing, state_path):
        self.tg, self.hosts, self.listing, self.state_path = tg, hosts, listing, state_path
        self.chat_id = int(conf["chat_id"])
        self.user_id = int(conf.get("user_id", conf["chat_id"]))
        self.payout = payout
        self.pending = {}  # confirm token -> (expires, action)
        self.recent = []  # times of recent commands, for the rate limit
        self.told_limit = 0.0  # when the owner was last told about the rate limit
        try:
            with open(state_path, encoding="utf-8") as f:
                self.state = json.load(f)
        except (OSError, ValueError):
            self.state = {"offset": 0, "alerts": []}

    def save(self):
        tmp = f"{self.state_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f)
        os.replace(tmp, self.state_path)

    def say(self, text, buttons=None):
        body = {"chat_id": self.chat_id, "text": text, "disable_web_page_preview": True}
        if buttons:
            body["reply_markup"] = {"inline_keyboard": [buttons]}
        self.tg.call("sendMessage", body)

    # ---------- the hosts, through their dashboard API ----------
    def api(self, base, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"{base}/api/{path}", data=data, headers={"content-type": "application/json", "x-dashboard": "1"})
        try:
            with urllib.request.urlopen(req, timeout=600 if body is not None else 30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read())
            except ValueError:
                return {"ok": False, "error": f"the host answered HTTP {e.code}"}

    def campaigns(self):
        """Every campaign on every host: (host name, base, full status)."""
        out = []
        for name, base in self.hosts.items():
            try:
                for c in self.api(base, "campaigns").get("campaigns", []):
                    out.append((name, base, self.api(base, f"campaigns/{c['id']}")))
            except (urllib.error.URLError, OSError, ValueError) as e:
                out.append((name, base, {"ok": False, "error": f"the {name} host could not be reached ({type(e).__name__})"}))
        return out

    def find(self, short):
        hits = [(n, b, s) for n, b, s in self.campaigns() if s.get("ok") and s.get("short") == short]
        return hits[0] if len(hits) == 1 else None

    @staticmethod
    def close_window(s):
        """For a blind bid auction: (can close now, why not, last block to close)."""
        z = s.get("sealed") or {}
        if not z:
            return False, "only blind bid auctions are closed from here; use the dashboard", None
        last = z.get("claim_after")
        if s.get("phase") == "closed":
            left = s.get("close_unfinished") or []
            return bool(left), "it is closed" if not left else "", last
        if s.get("closing"):
            return False, "a close is already running", last
        if s.get("phase") != "deadline_passed":
            return False, f"the deadline (block {s.get('deadline_height'):,}) has not passed", last
        if time.time() < z.get("round_time", 0):
            return False, f"the bids open at {time.strftime('%a %d %b %H:%M UTC', time.gmtime(z['round_time']))}", last
        if s.get("tip") is not None and last is not None and s["tip"] > last:
            return False, f"the late tickets work since block {last + 1:,}: it is too late to close", last
        return True, "", last

    def status_text(self):
        lines = []
        for host, _, s in self.campaigns():
            if not s.get("ok"):
                lines.append(f"[{host}] {s.get('error', 'no answer')}")
                continue
            t, z = s.get("ticker", ""), s.get("sealed") or {}
            name = s.get("name") or "(no name)"
            head = f"{name} ({s['short']}, {s['network']}net, {'blind bid' if z else s.get('mode')}): {s.get('phase', '?').replace('_', ' ')}"
            row = [head]
            if s.get("tip") is not None and s.get("phase") == "open":
                row.append(f"deadline block {s['deadline_height']:,}, {s['blocks_left']:,} blocks left ({eta(s['blocks_left'], s['network'])})")
            if z:
                tr = (s.get("self_check") or {}).get("treasury_zat") or 0
                row.append(f"deposits {z.get('deposits') if z.get('deposits') is not None else '?'}, coin wallet {zec(z.get('coin_balance_zat') or 0, t)}, treasury {zec(tr, t)}")
                can, why, last = self.close_window(s)
                if s.get("phase") != "closed" or can:
                    row.append(f"can close now: {'yes' if can else 'no, ' + why}; last block to close {last:,}" if last else f"can close now: {'yes' if can else 'no, ' + why}")
                if z.get("did_not_finish"):
                    row.append("marked: did not finish")
            lines.append("\n".join(row))
        return "\n\n".join(lines) or "No campaigns on the server's hosts."

    # ---------- the listing job ----------
    def listing_run(self, args):
        r = subprocess.run(self.listing + args, capture_output=True, text=True, timeout=120, shell=False)
        out = (r.stdout + r.stderr).strip()
        return out[-3500:] if out else ("done" if r.returncode == 0 else f"failed (exit {r.returncode})")

    # ---------- commands ----------
    def ask(self, text, action):
        token = secrets.token_hex(8)
        self.pending[token] = (time.time() + CONFIRM_SECONDS, action)
        self.say(text, [{"text": "Confirm", "callback_data": f"ok:{token}"}, {"text": "Cancel", "callback_data": f"no:{token}"}])

    def command(self, text):
        parts = text.strip().split()
        cmd, args = parts[0].split("@")[0].lower(), parts[1:]
        if cmd in ("/help", "/start"):
            return self.say(HELP)
        if cmd == "/status":
            return self.say(self.status_text())
        if cmd == "/queue":
            return self.say(self.listing_run(["queue"]))
        if cmd == "/approve":
            if not args:
                return self.say("Usage: /approve <fingerprint> [label]")
            fp = " ".join(args[:5]) if len(args) >= 5 and all(len(a) == 4 for a in args[:5]) else args[0]
            rest = args[5:] if fp != args[0] else args[1:]
            fp = fp.replace(" ", "").lower()
            if not re.fullmatch(r"[0-9a-f]{20}", fp):
                return self.say("That is not a host fingerprint (20 hex characters, spaces allowed).")
            label = " ".join(rest)
            if label and not LABEL.fullmatch(label):
                return self.say("A label is plain text: letters, digits, spaces and . , ' & ( ) -, at most 30 characters.")
            log(f"approve {fp} label {label!r}")
            return self.say(self.listing_run(["approve", fp] + (["--label", label] if label else [])))
        if cmd == "/hide":
            if not args:
                return self.say("Usage: /hide <fingerprint or campaign id>")
            what = "".join(args).lower()
            if not (re.fullmatch(r"[0-9a-f]{20}", what) or CAMPAIGN_ID.fullmatch(what)):
                return self.say("That is neither a host fingerprint nor a campaign id.")
            log(f"hide {what}")
            return self.say(self.listing_run(["hide", what]))
        if cmd in ("/close", "/send_treasury", "/send_coin_back"):
            if len(args) != 1 or not SHORT_ID.fullmatch(args[0].lower()):
                return self.say(f"Usage: {cmd} <short id> (the first 8 characters of the campaign id, as /status shows them)")
            hit = self.find(args[0].lower())
            if not hit:
                return self.say("No campaign on the server's hosts has that short id.")
            return getattr(self, cmd[1:])(*hit, check_only=False)
        return self.say("Unknown command. /help lists them.")

    def close(self, host, base, s, check_only):
        can, why, last = self.close_window(s)
        if not can:
            return self.say(f"{s.get('name') or s['short']} cannot be closed now: {why}.")
        if check_only:
            return True
        net = "mainnet" if s["network"] == "main" else "testnet"
        text = (f"Close {s.get('name') or s['short']} ({s['short']}, {net}) now? This fetches the drand round, opens every bid, settles the winners into "
                f"the auction's treasury and sends everyone else their signed refund. It cannot be undone. Close before block {last + 1:,}.")
        return self.ask(text, ("close", host, s["id"]))

    def payout_for(self, s):
        return self.payout.get("main" if s["network"] == "main" else "test", "")

    def send_treasury(self, host, base, s, check_only):
        amount = (s.get("self_check") or {}).get("treasury_send_zat") or 0
        to = self.payout_for(s)
        if s.get("phase") != "closed" or not amount:
            return self.say(f"{s.get('name') or s['short']}: nothing to send from the treasury now (it is sent after the close, once settlements are mined).")
        if not to:
            return self.say(f"No {s['network']}net payout address saved.")
        if check_only:
            return True
        return self.ask(f"Send {zec(amount, s['ticker'])} (after the network fee) from the treasury of {s.get('name') or s['short']} to your {s['network']}net payout address {short_addr(to)}?", ("send_treasury", host, s["id"]))

    def send_coin_back(self, host, base, s, check_only):
        z = s.get("sealed") or {}
        amount, to = z.get("coins_back_zat") or 0, self.payout_for(s)
        if not z:
            return self.say("Only a blind bid auction has a coin wallet.")
        if not amount and s.get("phase") != "closed":
            return self.say(f"{s.get('name') or s['short']}: the coin wallet holds nothing to send back.")
        if not to:
            return self.say(f"No {s['network']}net payout address saved.")
        if check_only:
            return True
        what = f"{zec(amount, s['ticker'])} (after the network fee)" if amount else "what is left (the host reads the wallet first)"
        return self.ask(f"Send {what} from the coin wallet of {s.get('name') or s['short']} back to your {s['network']}net payout address {short_addr(to)}?", ("send_coin_back", host, s["id"]))

    def confirmed(self, token, yes):
        entry = self.pending.pop(token, None)
        if not entry or entry[0] < time.time():
            return self.say("That button has expired. Send the command again.")
        _, (kind, host, cid) = entry
        if not yes:
            log(f"{kind} {cid[:8]} cancelled")
            return self.say("Cancelled. Nothing was sent.")
        base = self.hosts[host]
        s = self.api(base, f"campaigns/{cid}")
        # the same checks again, with the host's state now
        if not s.get("ok") or getattr(self, kind)(host, base, s, check_only=True) is not True:
            return
        log(f"{kind} {cid[:8]} confirmed")
        if kind == "close":
            r = self.api(base, f"campaigns/{cid}/close", {"confirm": True, "confirm_mainnet": s["network"] == "main"})
        elif kind == "send_treasury":
            r = self.api(base, f"campaigns/{cid}/treasury-send", {"address": self.payout_for(s)})
        else:
            r = self.api(base, f"campaigns/{cid}/coins-send", {"address": self.payout_for(s)})
        log(f"{kind} {cid[:8]}: {'ok' if r.get('ok') else 'refused'} {r.get('txid', '')} {r.get('error', '')}")
        if r.get("ok"):
            detail = f"transaction {r['txid']}" if r.get("txid") else "; ".join(r.get("log") or []) or "done"
            return self.say(f"Done: {detail}")
        return self.say(f"Not done: {r.get('error', 'the host refused')}")

    # ---------- the updates ----------
    def allowed(self, sender, chat):
        return sender == self.user_id and chat == self.chat_id

    def limited(self):
        """The owner's commands and button presses, at most RATE[0] a minute; over it the owner is told once a minute (a stranger never gets here)."""
        now = time.time()
        self.recent = [t for t in self.recent if t > now - RATE[1]]
        if len(self.recent) >= RATE[0]:
            if now - self.told_limit > RATE[1]:
                self.told_limit = now
                self.say(f"Too many commands at once: at most {RATE[0]} a minute. Wait a moment and send it again.")
            return True
        self.recent.append(now)
        return False

    def handle(self, u):
        if "message" in u:
            m = u["message"]
            sender, chat, text = (m.get("from") or {}).get("id"), (m.get("chat") or {}).get("id"), m.get("text") or ""
            if not self.allowed(sender, chat):
                log(f"ignored a message from user {sender} in chat {chat}")
                return
            if not text.startswith("/"):
                return
            if self.limited():
                log("rate limit: a command was dropped")
                return
            log(f"command {text.split()[0]}")
            try:
                self.command(text)
            except Exception as e:  # one failed command never stops the bot
                log(f"command failed: {type(e).__name__}: {e}")
                self.say(f"That command failed: {e}")
        elif "callback_query" in u:
            q = u["callback_query"]
            sender, chat = (q.get("from") or {}).get("id"), ((q.get("message") or {}).get("chat") or {}).get("id")
            try:
                self.tg.call("answerCallbackQuery", {"callback_query_id": q["id"]})
            except RuntimeError:
                pass
            if not self.allowed(sender, chat):
                log(f"ignored a button press from user {sender} in chat {chat}")
                return
            if self.limited():
                log("rate limit: a button press was dropped")
                return
            kind, _, token = (q.get("data") or "").partition(":")
            try:
                self.confirmed(token, kind == "ok")
            except Exception as e:
                log(f"confirm failed: {type(e).__name__}: {e}")
                self.say(f"That failed: {e}")

    # ---------- the alerts ----------
    def alert_once(self, key, text):
        if key in self.state["alerts"]:
            return
        self.state["alerts"].append(key)
        self.save()
        log(f"alert {key}")
        self.say(text)

    def alerts(self):
        for _, _, s in self.campaigns():
            z = s.get("sealed") or {}
            if not s.get("ok") or not z or s.get("tip") is None:
                continue
            name, cid, tip, t = s.get("name") or s["short"], s["short"], s["tip"], s.get("ticker", "")
            last = z.get("claim_after")
            if s.get("phase") != "closed" and last is not None and time.time() >= z.get("round_time", 1 << 62) and tip <= last:
                left = last + 1 - tip
                self.alert_once(f"open:{cid}", f"{name} ({cid}, {s['network']}net): the bids are open. Close before block {last + 1:,} ({eta(left, s['network'])}). /close {cid}")
                secs = left * SECONDS_PER_BLOCK.get(s["network"], 75)
                if secs <= 6 * 3600:
                    self.alert_once(f"6h:{cid}", f"{name} ({cid}): about 6 hours left to close (before block {last + 1:,}). /close {cid}")
                if secs <= 3600:
                    self.alert_once(f"1h:{cid}", f"{name} ({cid}): about 1 hour left to close (before block {last + 1:,}). /close {cid}")
            cutoff = z.get("cutoff")
            bal = z.get("coin_balance_zat")
            if s.get("phase") == "open" and cutoff and tip <= cutoff and bal is not None:
                if bal < COIN_LOW_ZAT:
                    self.alert_once(f"coinlow:{cid}:{bal // 10_000}", f"{name} ({cid}): the coin wallet is low, {zec(bal, t)} left (each bid's small payment costs about 0.00015 {t}). Fund it at {z.get('coin_address', '?')}")
            # a payment without a bid message the auction can read: not a bid, it stays in the auction wallet (once per payment)
            for p in z.get("not_in_auction") or []:
                self.alert_once(f"nia:{cid}:{p['txid']}:{p.get('action', 0)}", f"{name} ({cid}): a payment of {zec(p['value_zat'], t)} came in that is not a bid ({p['reason']}; block {p['height']:,}, transaction {p['txid']}). It stays in the auction wallet.")
            if z.get("did_not_finish"):
                self.alert_once(f"dnf:{cid}", f"{name} ({cid}, {s['network']}net) is marked \"did not finish\": the host did not close before the late tickets became valid.")

    def run(self, poll_timeout=25, alert_every=60, rounds=None):
        last_alerts = 0.0
        while rounds is None or rounds > 0:
            if rounds is not None:
                rounds -= 1
            try:
                r = self.tg.call("getUpdates", {"offset": self.state.get("offset", 0), "timeout": poll_timeout, "allowed_updates": ["message", "callback_query"]}, timeout=poll_timeout + 15)
                for u in r.get("result", []):
                    self.state["offset"] = u["update_id"] + 1
                    self.save()
                    self.handle(u)
            except RuntimeError as e:
                log(str(e))
                time.sleep(5)
            if time.time() - last_alerts >= alert_every:
                last_alerts = time.time()
                try:
                    self.alerts()
                except Exception as e:
                    log(f"alerts failed: {type(e).__name__}: {e}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hosts", required=True, help="name=url,... (the hosts' dashboards on 127.0.0.1)")
    ap.add_argument("--listing", required=True, help="the cb-listing command, as words")
    ap.add_argument("--state", required=True)
    ap.add_argument("--credentials", default=os.environ.get("CREDENTIALS_DIRECTORY", ""), help="folder with the telegram and payout files")
    ap.add_argument("--poll-timeout", type=int, default=25, help=argparse.SUPPRESS)  # tests
    ap.add_argument("--alert-every", type=int, default=60, help=argparse.SUPPRESS)  # tests
    a = ap.parse_args()
    hosts = dict(h.split("=", 1) for h in a.hosts.split(","))
    for name, url in hosts.items():
        if not re.fullmatch(r"http://(127\.0\.0\.1|localhost):\d+", url):
            sys.exit(f"the {name} host must be on 127.0.0.1, not {url}")
    conf = read_conf(os.path.join(a.credentials, "telegram"))
    payout = read_conf(os.path.join(a.credentials, "payout"))
    bot = Bot(Telegram(conf), conf, payout, hosts, shlex.split(a.listing), a.state)
    log(f"started: hosts {', '.join(hosts)}; payout addresses for {', '.join(sorted(k for k in payout if k in ('main', 'test'))) or 'none'}")
    bot.run(poll_timeout=a.poll_timeout, alert_every=a.alert_every)


if __name__ == "__main__":
    main()
