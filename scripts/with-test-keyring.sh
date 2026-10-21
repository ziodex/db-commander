#!/usr/bin/env bash
# Disposable Secret Service for Linux desktop CI; never uses the login keyring.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then exec "$@"; fi
# Always use a private bus, even when the runner already has a desktop session.
if [[ "${SQLCOMMANDER_PRIVATE_TEST_BUS:-}" != 1 ]]; then
  exec dbus-run-session -- env SQLCOMMANDER_PRIVATE_TEST_BUS=1 bash "$0" "$@"
fi
keyring_test_directory=$(mktemp -d)
export XDG_DATA_HOME="$keyring_test_directory/data"
export XDG_RUNTIME_DIR="$keyring_test_directory/runtime"
mkdir -m 700 -p "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
cleanup_keyring() {
  kill "$keyring_test_pid" 2>/dev/null || true
  wait "$keyring_test_pid" 2>/dev/null || true
  rm -rf -- "$keyring_test_directory"
}
printf '%s' 'dbcommander-disposable-test-keyring' | gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory="$XDG_RUNTIME_DIR/keyring" > "$keyring_test_directory/daemon.log" 2>&1 &
keyring_test_pid=$!
trap cleanup_keyring EXIT
if ! gdbus wait --session --timeout 20 org.freedesktop.secrets; then cat "$keyring_test_directory/daemon.log"; exit 1; fi
"$@"
