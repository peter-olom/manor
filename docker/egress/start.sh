#!/bin/sh
set -eu

node /opt/manor/egress/server.mjs --init
node /opt/manor/egress/server.mjs &
admin_pid=$!

terminate() {
  kill "$admin_pid" 2>/dev/null || true
  kill "$squid_pid" 2>/dev/null || true
}

trap terminate INT TERM
rm -f /tmp/squid.pid
squid -N -f /etc/squid/squid.conf &
squid_pid=$!

while kill -0 "$admin_pid" 2>/dev/null && kill -0 "$squid_pid" 2>/dev/null; do
  sleep 1
done

terminate
wait "$admin_pid" 2>/dev/null || true
wait "$squid_pid" 2>/dev/null || true
exit 1
