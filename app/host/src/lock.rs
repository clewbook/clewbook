//! One host process per campaign folder. Two host processes on the same campaign (for example a watcher left over from an earlier run while
//! the folder was replaced by a new campaign, or a command-line close while the dashboard runs) can act on stale keys, write wrong ledger
//! entries, or send the same transaction twice. `watch`, `close`, `reissue` and the dashboard take this lock; a second instance refuses to
//! start with a plain message.
//!
//! The lock is an operating-system lock (`flock`) on `private/host.lock`, held for as long as the process lives: the system releases it when
//! the process ends, however it ends (a crash, a kill, a reboot), so a lock is stale exactly when its process is gone, whatever the program is
//! called (`cb-host`, `ll-host` or any other name). Taking it is one atomic step, so two programs starting at the same moment cannot both win.
//! The file also records who holds it (process id, start time, what it is doing), for the message a second instance shows.
//!
//! Earlier versions did not take the system lock; they wrote `<pid>\n<what>` and treated the lock as held while that process ran. Such a record
//! (no start time) is still respected while its process is alive, so a new program does not take over a folder an old one is working on.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use anyhow::{Result, bail};

pub struct RunLock {
    #[cfg_attr(not(test), allow(dead_code))]
    path: PathBuf,
    file: File,
}

/// When a process started (Linux: field 22 of `/proc/<pid>/stat`, in clock ticks since boot), with the boot it belongs to, so a process id
/// that was reused (by a later process, or after a reboot) is not mistaken for the one that wrote a record.
fn start_time(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // the command name (field 2) is in parentheses and may contain spaces: count fields after the last ')'
    let rest = &stat[stat.rfind(')')? + 1..];
    let ticks = rest.split_whitespace().nth(19)?; // field 22 overall
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap_or_default();
    Some(format!("{ticks}@{}", boot.trim()))
}

fn alive(pid: u32) -> bool {
    pid != 0 && Path::new(&format!("/proc/{pid}")).exists()
}

/// What a lock file says: `pid`, `start time` (missing in the old format) and what the process was doing.
struct Record {
    pid: u32,
    start: Option<String>,
    what: String,
}

fn parse(text: &str) -> Option<Record> {
    let mut lines = text.lines();
    let pid: u32 = lines.next()?.trim().parse().ok()?;
    let second = lines.next().unwrap_or("").trim().to_string();
    match second.strip_prefix("start ") {
        Some(start) => Some(Record { pid, start: Some(start.to_string()), what: lines.next().unwrap_or("another command").trim().to_string() }),
        None => Some(Record { pid, start: None, what: if second.is_empty() { "another command".into() } else { second } }),
    }
}

fn refuse(run_dir: &Path, r: &Record) -> anyhow::Error {
    anyhow::anyhow!(
        "another host program ({}, process {}) is already working on this campaign folder ({}). \
         Stop it first, or wait for it to finish: two at once could use stale keys or send twice.",
        r.what,
        r.pid,
        run_dir.display()
    )
}

impl RunLock {
    pub fn acquire(run_dir: &Path, what: &str) -> Result<Self> {
        let dir = run_dir.join("private");
        crate::make_private_dir(&dir)?;
        let path = dir.join("host.lock");
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut file = opts.open(&path)?;
        let mut text = String::new();
        match file.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => {
                let _ = file.read_to_string(&mut text);
                let r = parse(&text).unwrap_or(Record { pid: 0, start: None, what: "another command".into() });
                return Err(refuse(run_dir, &r));
            }
            Err(fs::TryLockError::Error(e)) => bail!("could not take the lock {}: {e}", path.display()),
        }
        // We hold the system lock. What the file says is either empty (released cleanly), a process that ended, or an old-format record
        // from a program that does not take the system lock and is still running.
        file.read_to_string(&mut text)?;
        if let Some(r) = parse(&text) {
            let me = std::process::id();
            let old_and_alive = r.start.is_none() && r.pid != me && alive(r.pid);
            if old_and_alive {
                return Err(refuse(run_dir, &r)); // dropping `file` releases the system lock again
            }
            if r.pid != me {
                eprintln!("replacing a stale lock left by process {} ({}), which is no longer running", r.pid, r.what);
            }
        }
        let me = std::process::id();
        let record = format!("{me}\nstart {}\n{what}\n", start_time(me).unwrap_or_default());
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(record.as_bytes())?;
        file.sync_all()?;
        Ok(RunLock { path, file })
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for RunLock {
    fn drop(&mut self) {
        // still holding the system lock: empty the record, so the next program sees a cleanly released lock (closing the file releases it)
        let _ = self.file.set_len(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cb-lock-unit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn two_simultaneous_claims_give_exactly_one_winner() {
        let d = folder("race");
        for _round in 0..20 {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let (d, b) = (d.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        b.wait();
                        RunLock::acquire(&d, "race").ok().map(|l| {
                            std::thread::sleep(std::time::Duration::from_millis(50)); // hold it while the others try
                            drop(l);
                        })
                    })
                })
                .collect();
            let winners = handles.into_iter().filter_map(|h| h.join().unwrap()).count();
            assert_eq!(winners, 1, "exactly one of eight simultaneous claims must win");
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_released_lock_is_free_and_says_nothing_stale() {
        let d = folder("release");
        let l = RunLock::acquire(&d, "first").unwrap();
        assert!(RunLock::acquire(&d, "second").is_err(), "held: refused");
        let text = fs::read_to_string(l.path()).unwrap();
        let r = parse(&text).unwrap();
        assert_eq!((r.pid, r.what.as_str()), (std::process::id(), "first"));
        assert!(r.start.as_deref().is_some_and(|s| s.contains('@')), "the start time is recorded: {text}");
        drop(l);
        assert_eq!(fs::read_to_string(d.join("private/host.lock")).unwrap(), "", "released cleanly: empty record");
        // another test in this process may be starting a child process at this moment: until that child replaces itself with its program, it
        // briefly shares this process's open files, and with them the lock; so allow a moment
        let again = (0..40).find_map(|_| RunLock::acquire(&d, "third").ok().or_else(|| { std::thread::sleep(std::time::Duration::from_millis(25)); None }));
        assert!(again.is_some());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_record_of_a_process_that_is_gone_is_replaced() {
        let d = folder("dead");
        fs::create_dir_all(d.join("private")).unwrap();
        // a process id that is not running (pid_max is far below this)
        fs::write(d.join("private/host.lock"), "4194000\nstart 1@x\nwatch\n").unwrap();
        assert!(RunLock::acquire(&d, "new").is_ok());
        fs::write(d.join("private/host.lock"), "4194000\nwatch\n").unwrap(); // old format, dead
        assert!(RunLock::acquire(&d, "new").is_ok());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_old_format_record_of_a_running_process_is_respected() {
        let d = folder("old");
        fs::create_dir_all(d.join("private")).unwrap();
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        fs::write(d.join("private/host.lock"), format!("{}\nwatch\n", child.id())).unwrap();
        let e = RunLock::acquire(&d, "new").err().expect("an old program that is still running keeps the folder");
        assert!(e.to_string().contains("already working on this campaign folder"), "{e}");
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(RunLock::acquire(&d, "new").is_ok(), "once it is gone the lock is free");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_new_format_record_names_a_live_process_but_without_the_system_lock_it_is_free() {
        // a folder copied while its program ran elsewhere: the record names a live process that does not hold this file
        let d = folder("copy");
        fs::create_dir_all(d.join("private")).unwrap();
        fs::write(d.join("private/host.lock"), format!("{}\nstart 1@other-boot\nwatch\n", std::os::unix::process::parent_id())).unwrap();
        assert!(RunLock::acquire(&d, "new").is_ok());
        let _ = fs::remove_dir_all(&d);
    }
}
