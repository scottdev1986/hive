#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 DAEMON_PID OUTPUT_CSV" >&2
  exit 2
fi

daemon_pid=$1
output=$2
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
process_snapshot=$(ps -axo pid=,ppid=,rss=)
tree_pids=$(printf '%s\n' "$process_snapshot" | awk -v root="$daemon_pid" '
  { pid[NR]=$1; ppid[NR]=$2 }
  END {
    wanted[root]=1
    changed=1
    while (changed) {
      changed=0
      for (i=1; i<=NR; i++) {
        if (wanted[ppid[i]] && !wanted[pid[i]]) {
          wanted[pid[i]]=1
          changed=1
        }
      }
    }
    for (i=1; i<=NR; i++) if (wanted[pid[i]]) print pid[i]
  }
')

if [ -z "$tree_pids" ]; then
  echo "daemon PID $daemon_pid was not found" >&2
  exit 1
fi

pid_csv=$(printf '%s\n' "$tree_pids" | paste -sd, -)
child_processes=$(printf '%s\n' "$tree_pids" | awk 'NF { n++ } END { print n-1 }')
rss_kib=$(printf '%s\n' "$process_snapshot" | awk -v roots="$pid_csv" '
  BEGIN { n=split(roots, ids, ","); for (i=1; i<=n; i++) wanted[ids[i]]=1 }
  wanted[$1] { sum += $3 }
  END { print sum+0 }
')
open_fds=$(lsof -nP -a -p "$pid_csv" | awk '
  NR > 1 && $4 ~ /^[0-9]+[A-Za-z]*$/ { n++ }
  END { print n+0 }
')

if [ ! -s "$output" ]; then
  printf 'timestamp,daemon_pid,child_processes,open_fds,rss_kib\n' >> "$output"
fi
printf '%s,%s,%s,%s,%s\n' \
  "$timestamp" "$daemon_pid" "$child_processes" "$open_fds" "$rss_kib" | tee -a "$output"
