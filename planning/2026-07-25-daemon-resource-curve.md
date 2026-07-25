# Daemon resource curve

A single point proves nothing about a leak. This is the fresh-daemon baseline for a later, same-method comparison.

## Baseline

At the `hive_status({"detail":"active"})` reading immediately before measurement, 6 agents were live (5 others plus this recorder): `c13`, `capacity`, `worktrees`, `refs`, `leak-audit`, and `review`. `worktrees` was reported working in the first reading; its later transition to idle does not change the live count. Two unrelated probe sessions appeared after this baseline and are not included in the 6-agent count.

| Timestamp (UTC) | Daemon PID | Recursive children | Numeric open FDs | Tree RSS (KiB) |
| --- | ---: | ---: | ---: | ---: |
| 2026-07-25T16:57:21Z | 5545 | 44 | 624 | 4,743,952 |

The aggregate included normal active work, notably Swift and Zig test subprocesses. The daemon process itself was 729,424 KiB RSS with 29 numeric descriptors; the direct `hive-sessiond serve` child had 15 descriptors. The baseline is notable for the daemon's RSS, but neither 44 children nor 624 tree-wide descriptors is plainly disproportionate to six live agents plus their active tools. Do not call this a leak or a clean bill of health without the second point.

## Exact method

The daemon was identified by this exact command:

```console
$ ps -axo pid=,ppid=,rss=,etime=,command= | rg '[h]ive|[s]essiond'
 5545     1 724368    05:38 /Users/scottkellar/Projects/hive/.dev/root/current/hive daemon
 5564  5545   6480    05:37 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond serve
 5787  5564  10144    05:36 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond host
16509  5564  37168    02:57 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond host
16671  5564  29872    02:56 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond host
35501  5564   8640    00:47 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond host
36092  5564  10368    00:46 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond host
36131  5564   9968    00:46 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond host
36214  5564   9648    00:46 /Users/scottkellar/Projects/hive/.dev/root/versions/0.0.0/hive-sessiond host
```

The recorder takes one `ps -axo pid=,ppid=,rss=` snapshot, finds the daemon's recursive descendants by repeated parent-PID closure, and uses that same PID set for all three metrics:

- child count is PID-set size minus the daemon;
- RSS is the sum of the `ps` RSS column, in KiB;
- open FDs are rows from one `lsof -nP -a -p "$pid_csv"` call whose FD column matches `^[0-9]+[A-Za-z]*$`. This deliberately excludes `cwd`, `txt`, and `mem` rows.

The exact implementation is [`scripts/record-daemon-resources.sh`](../scripts/record-daemon-resources.sh). It takes the daemon PID and CSV path. When invoked from a Hive-owned shell, that shell is a real member of the daemon tree and is counted; take the second reading from the same context.

Raw output from the baseline's first, single `lsof` snapshot was:

```text
total 624
5545 29
5564 15
5571 14
5787 14
5788 5
5936 16
16509 14
16510 5
16671 14
16682 5
16684 23
16850 23
16949 3
17036 3
35501 14
35507 5
35683 5
35684 47
36092 14
36093 5
36131 14
36149 5
36214 14
36247 5
36321 5
36322 47
36532 5
36533 47
37051 5
37052 50
38937 11
38971 11
39512 11
39627 5
39629 8
39630 3
39745 11
40502 61
42382 6
52578 5
52582 6
52583 3
52925 9
53898 4
```

The raw aggregate output, using RSS and children from the single `ps` snapshot and FDs from that first `lsof` snapshot, is:

```text
timestamp,daemon_pid,child_processes,open_fds,rss_kib
2026-07-25T16:57:21Z,5545,44,624,4743952
```

The exploratory command originally called `lsof` a second time while printing the row; that second read was 625 because the live tree changed by one descriptor. The committed baseline intentionally uses the fully recorded first snapshot (`total 624`), and the recorder makes exactly one `lsof` call so later rows have the same semantics.

## Second reading

After ten sessions have been created through normal use, from a Hive agent shell run: `scripts/record-daemon-resources.sh "$(pgrep -f '/hive daemon$')" planning/2026-07-25-daemon-resource-curve.csv`.
