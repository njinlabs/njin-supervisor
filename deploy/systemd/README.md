# systemd units

Runs njin-supervisor as a service with a graceful SIGTERM-based restart triggered proactively
once its memory usage crosses a threshold — see the comments in `njin-supervisor.service` for why
(Bun's `worker.terminate()` leak, tracked upstream at
[oven-sh/bun#5709](https://github.com/oven-sh/bun/issues/5709)).

## Install

```bash
sudo cp deploy/systemd/njin-supervisor.service /etc/systemd/system/
sudo cp deploy/systemd/njin-supervisor-memcheck.service /etc/systemd/system/
sudo cp deploy/systemd/njin-supervisor-memcheck.timer /etc/systemd/system/
sudo chmod +x deploy/systemd/njin-supervisor-memcheck.sh

# Adjust WorkingDirectory in njin-supervisor.service and the ExecStart path in
# njin-supervisor-memcheck.service first if this repo doesn't live at /opt/njin-supervisor.

sudo systemctl daemon-reload
sudo systemctl enable --now njin-supervisor.service
sudo systemctl enable --now njin-supervisor-memcheck.timer
```

## Tuning

- `njin-supervisor-memcheck.sh`'s `THRESHOLD_BYTES` — restart trigger point. Keep it comfortably
  below `MemoryMax` in `njin-supervisor.service` so the graceful path always wins the race.
- `njin-supervisor.service`'s `MemoryMax` — hard safety net; only fires (ungraceful `SIGKILL`) if
  the timer-based check somehow doesn't catch it in time.
- `njin-supervisor-memcheck.timer`'s `OnUnitActiveSec` — how often the check runs (default 5min).

## Verify

```bash
systemctl status njin-supervisor.service
systemctl list-timers njin-supervisor-memcheck.timer
journalctl -u njin-supervisor.service -f
```
