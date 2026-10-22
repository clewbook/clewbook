# Installing the operator bot on the server

Each step is one command, run from the operator's computer with `ssh -t`; each has its rollback. The files are first staged in
`/home/clewbook/opbot-stage` (`opbot.py`, `clewbook-opbot.service`, `clewbook-opbot.sudoers`).

1. The bot's user (no login, no access to any wallet):
   `ssh -t clewbook-vps 'sudo useradd --system --no-create-home --shell /usr/sbin/nologin clewbook-opbot && id clewbook-opbot'`
   Rollback: `ssh -t clewbook-vps 'sudo userdel clewbook-opbot'`
2. Its state and log folders. systemd opens the log file before `LogsDirectory=` makes its folder, so they must exist before the start
   (without them the start fails with 209/STDOUT):
   `ssh -t clewbook-vps 'sudo install -d -o clewbook-opbot -g clewbook-opbot -m 700 /var/lib/clewbook-opbot && sudo install -d -o clewbook-opbot -g clewbook-opbot -m 750 /var/log/clewbook-opbot && sudo ls -ld /var/lib/clewbook-opbot /var/log/clewbook-opbot'`
   Rollback: `ssh -t clewbook-vps 'sudo rm -rf /var/lib/clewbook-opbot /var/log/clewbook-opbot'`
3. The program and its settings: the bot token and chat id copied from the listing job's conf, and an empty payout file, both owned by
   root, mode 600 (handed to the bot by systemd as credentials). The last line says only whether the chat id is a private chat or a
   group; for a group, add a line `user_id=<the operator's user id>`.
   `ssh -t clewbook-vps 'sudo install -d -o root -g root -m 755 /opt/clewbook-opbot && sudo install -o root -g root -m 644 /home/clewbook/opbot-stage/opbot.py /opt/clewbook-opbot/opbot.py && sudo install -d -o root -g root -m 700 /etc/clewbook-opbot && sudo install -o root -g root -m 600 /etc/clewbook-listing/telegram.conf /etc/clewbook-opbot/telegram.conf && sudo install -o root -g root -m 600 /dev/null /etc/clewbook-opbot/payout.conf && sudo awk -F= "/^chat_id=/{print (\$2<0 ? \"group chat\" : \"private chat\")}" /etc/clewbook-opbot/telegram.conf'`
   Rollback: `ssh -t clewbook-vps 'sudo rm -rf /opt/clewbook-opbot /etc/clewbook-opbot'`
4. The sudo rule (only `queue`, `approve` and `hide` of cb-listing, as the listing job's user), checked before it is used:
   `ssh -t clewbook-vps 'sudo visudo -c -f /home/clewbook/opbot-stage/clewbook-opbot.sudoers && sudo install -o root -g root -m 440 /home/clewbook/opbot-stage/clewbook-opbot.sudoers /etc/sudoers.d/clewbook-opbot && sudo visudo -c'`
   Rollback: `ssh -t clewbook-vps 'sudo rm /etc/sudoers.d/clewbook-opbot'`
5. The service (the test network host first):
   `ssh -t clewbook-vps 'sudo install -o root -g root -m 644 /home/clewbook/opbot-stage/clewbook-opbot.service /etc/systemd/system/clewbook-opbot.service && sudo systemctl daemon-reload && sudo systemctl enable --now clewbook-opbot && sleep 4 && systemctl is-active clewbook-opbot && sudo tail -n 2 /var/log/clewbook-opbot/bot.log'`
   Rollback: `ssh -t clewbook-vps 'sudo systemctl disable --now clewbook-opbot && sudo rm /etc/systemd/system/clewbook-opbot.service && sudo systemctl daemon-reload'`
6. Payout addresses: only on the server, never from Telegram. The bot reads them when it starts. Mainnet (testnet the same with
   `test=` and `utest1`/`zutest1`):
   `ssh -t clewbook-vps 'read -r -p "Mainnet payout address (u1...): " A && case "$A" in u1*) ;; *) echo "That is not a u1 address; nothing changed."; exit 1;; esac && sudo sed -i "/^main=/d" /etc/clewbook-opbot/payout.conf && echo "main=$A" | sudo tee -a /etc/clewbook-opbot/payout.conf > /dev/null && sudo systemctl restart clewbook-opbot && sudo cut -c1-14 /etc/clewbook-opbot/payout.conf'`
   Remove one: `ssh -t clewbook-vps 'sudo sed -i "/^test=/d" /etc/clewbook-opbot/payout.conf && sudo systemctl restart clewbook-opbot'`
7. The main network host as well:
   `ssh -t clewbook-vps 'sudo cp -p /etc/systemd/system/clewbook-opbot.service /etc/systemd/system/clewbook-opbot.service.before-main && sudo sed -i "s#--hosts test=http://127.0.0.1:8797 #--hosts test=http://127.0.0.1:8797,main=http://127.0.0.1:8798 #" /etc/systemd/system/clewbook-opbot.service && sudo systemctl daemon-reload && sudo systemctl restart clewbook-opbot'`
   Rollback: `ssh -t clewbook-vps 'sudo cp -p /etc/systemd/system/clewbook-opbot.service.before-main /etc/systemd/system/clewbook-opbot.service && sudo systemctl daemon-reload && sudo systemctl restart clewbook-opbot'`
