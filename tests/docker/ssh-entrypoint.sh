#!/bin/sh
set -eu
test -f /fixture/host_key || ssh-keygen -q -t ed25519 -N '' -f /fixture/host_key
test -f /fixture/client_key || ssh-keygen -q -t ed25519 -N 'local-key-passphrase' -f /fixture/client_key
cp /fixture/client_key.pub /home/tunnel/.ssh/authorized_keys
chown -R tunnel:tunnel /home/tunnel/.ssh
chmod 700 /home/tunnel/.ssh
chmod 600 /home/tunnel/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e
