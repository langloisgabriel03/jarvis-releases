#!/data/data/com.termux/files/usr/bin/bash
# Claude Code on Android, inside Termux, without root.
#
# Claude Code is a Linux program; Termux is Android (bionic libc), so it runs inside a small
# Debian (proot-distro). Idle cost is close to zero; the real battery cost is the wake lock,
# so it is only taken by `claude-start` and released by `claude-stop`.
#
# Install (paste in Termux):
#   curl -fsSL https://raw.githubusercontent.com/langloisgabriel03/jarvis-releases/main/termux/setup.sh | bash
#
# Then:
#   claude         run Claude Code in the current Termux session (starts in your Termux home)
#   claude-start   keep a Claude Code session running in the background (tmux + wake lock)
#   claude-attach  go back to that background session (Ctrl+b then d to leave it running)
#   claude-stop    end the background session and release the wake lock
#   claude-update  update Claude Code
set -euo pipefail

DISTRO=debian
BIN="$PREFIX/bin"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ] || ! command -v pkg >/dev/null 2>&1; then
  echo "Run this inside Termux (from F-Droid or GitHub, not the old Play Store version)." >&2
  exit 1
fi

# proot-distro cannot start from inside another proot Linux (e.g. a Termux set up to open
# Ubuntu automatically). Detect it and say what to do instead of failing halfway.
if [ "$(awk '/^TracerPid:/{print $2}' /proc/self/status 2>/dev/null || echo 0)" != "0" ] || [ -n "${PROOT_DISTRIBUTION:-}" ]; then
  echo "This shell is already inside a proot Linux (Ubuntu/Debian started from Termux)." >&2
  echo "Type  exit  until you are back in plain Termux (prompt '~ \$'), then run this again." >&2
  echo "If your Termux opens a Linux automatically, remove that line from ~/.bashrc for now." >&2
  exit 1
fi

say "Termux packages"
pkg update -y
pkg install -y proot-distro tmux curl

say "Debian ($DISTRO) inside Termux"
if proot-distro login "$DISTRO" -- true >/dev/null 2>&1; then
  echo "Debian already installed."
else
  proot-distro install "$DISTRO"
fi

say "Node.js and Claude Code inside Debian"
proot-distro login "$DISTRO" -- bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git ripgrep procps
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split(\".\")[0]")" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  # Official native installer first; npm as a fallback.
  if ! curl -fsSL https://claude.ai/install.sh | bash; then
    npm install -g @anthropic-ai/claude-code
  fi
  for c in /root/.local/bin/claude /usr/local/bin/claude /usr/bin/claude; do
    if [ -x "$c" ]; then echo "Claude Code installed: $c ($("$c" --version 2>/dev/null))"; exit 0; fi
  done
  echo "Claude Code did NOT install in Debian." >&2
  exit 1
'

say "Commands: claude, claude-start, claude-attach, claude-stop, claude-update"

# Run Claude Code in Debian. Debian keeps its own home (/root: Claude Code and its login live
# there); the Termux home is mounted at ~/termux and Claude starts in it, so files are shared.
cat > "$BIN/claude" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Inside Debian this file must never run (it would start proot again): use Debian's own binary.
if [ -n "${JARVIS_IN_DEBIAN:-}" ] || [ -n "${PROOT_DISTRIBUTION:-}" ]; then
  echo "Already inside Debian: Claude Code is /root/.local/bin/claude" >&2
  exit 1
fi
exec proot-distro login debian --shared-tmp --bind "$HOME:/root/termux" -- \
  env JARVIS_IN_DEBIAN=1 PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin" bash -c '
    cd /root/termux
    for c in /root/.local/bin/claude /usr/local/bin/claude /usr/bin/claude; do
      [ -x "$c" ] && exec "$c" "$@"
    done
    echo "Claude Code is not installed in Debian. Run the setup command again." >&2
    exit 1' claude "$@"
EOF

cat > "$BIN/claude-start" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Background Claude Code: survives leaving Termux; the wake lock keeps Android from pausing it.
termux-wake-lock
if tmux has-session -t claude 2>/dev/null; then
  echo "Already running. Attach with: claude-attach"
else
  tmux new-session -d -s claude claude "$@"
  echo "Claude Code is running in the background (wake lock ON)."
  echo "  claude-attach  to see it (Ctrl+b then d to leave it running)"
  echo "  claude-stop    to end it and save battery"
fi
EOF

cat > "$BIN/claude-attach" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exec tmux attach -t claude
EOF

cat > "$BIN/claude-stop" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
tmux kill-session -t claude 2>/dev/null && echo "Background Claude Code stopped." || echo "Nothing was running."
if tmux has-session -t jarvis 2>/dev/null; then
  echo "Wake lock kept: the Jarvis server (jarvis-start) is still running."
else
  termux-wake-unlock
  echo "Wake lock released: the phone can sleep normally again."
fi
EOF

cat > "$BIN/claude-update" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exec proot-distro login debian -- env JARVIS_IN_DEBIAN=1 PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin" bash -c '
  if [ -x /root/.local/bin/claude ]; then /root/.local/bin/claude update; else npm install -g @anthropic-ai/claude-code@latest; fi'
EOF

chmod +x "$BIN/claude" "$BIN/claude-start" "$BIN/claude-attach" "$BIN/claude-stop" "$BIN/claude-update"

say "Done"
cat <<'EOF'
First run: type  claude  and follow the login link (open it in the phone's browser and
sign in with your Claude account; no API key needed).

So Android does not kill it in the background:
  1. Settings > Apps > Termux > Battery: Unrestricted (no optimisation).
  2. Android 12+: the "phantom process killer" kills Termux children at random.
     Android 14+: Developer options > "Disable child process restrictions" ON.
     Android 12-13: needs one adb command from a computer:
       adb shell "settings put global settings_enable_monitor_phantom_procs false"
  3. Only use claude-start when you need it running with the screen off; claude-stop after.
EOF
