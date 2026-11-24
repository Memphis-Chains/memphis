#!/usr/bin/env bash
# Publish only the chat gateway, through a socket outside the hosting document root.
set -euo pipefail

target="${PUBLIC_CHAT_SSH_HOST:-lhpl}"
config="${PUBLIC_CHAT_SSH_CONFIG:-$HOME/.ssh/lhpl-active/config}"
ssh_args=(-F "$config" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no
  -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -T)
remote_home=$(ssh "${ssh_args[@]}" "$target" 'pwd -P')
[[ "$remote_home" =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 1
socket="$remote_home/.memphis-chat/run/gateway.sock"
guard="$HOME/memphis/skills/halt-aware-destructive-ops/check.sh"
if [[ -x "$guard" ]]; then "$guard" "$socket"; fi

ssh "${ssh_args[@]}" "$target" 'umask 077 && mkdir -p "$HOME/.memphis-chat/run" && cd "$HOME/.memphis-chat/run" && php' <<'PHP'
<?php
// OpenSSH leaves a socket after disconnect. Never remove a live listener or a regular file.
$lock = fopen('prepare.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX)) exit(1);
$name = 'gateway.sock';
if (is_link($name)) exit(1);
if (file_exists($name)) {
    if (filetype($name) !== 'socket') exit(1);
    $test = @stream_socket_client('unix://' . getcwd() . '/' . $name, $errno, $message, 1);
    if ($test || $errno !== 111 || !unlink($name)) exit(1);
}
PHP

exec ssh "${ssh_args[@]}" -N -o ExitOnForwardFailure=yes -R "$socket:127.0.0.1:9100" "$target"
