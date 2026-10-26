#!/data/data/com.termux/files/usr/bin/bash
# Jarvis server on the phone: the Jarvis app talks to Claude Code running in Termux (Debian),
# no PC and no Tailscale needed. Run termux/setup.sh first (it installs Debian + Claude Code).
#
# Install / update (paste in Termux):
#   curl -fsSL https://raw.githubusercontent.com/langloisgabriel03/jarvis-releases/main/termux/jarvis-setup.sh | bash
#
# Then:
#   jarvis-start   start the server in the background (wake lock on); the app finds it by itself
#   jarvis-stop    stop it and release the wake lock
#   jarvis-log     show the server log (Ctrl+C to quit)
set -euo pipefail

RAW=https://raw.githubusercontent.com/langloisgabriel03/jarvis-releases/main/termux/server
BIN="$PREFIX/bin"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

if [ "$(awk '/^TracerPid:/{print $2}' /proc/self/status 2>/dev/null || echo 0)" != "0" ] || [ -n "${PROOT_DISTRIBUTION:-}" ]; then
  echo "Run this in plain Termux (prompt '~ \$'), not inside Ubuntu/Debian. Type exit first." >&2
  exit 1
fi
if ! proot-distro login debian -- test -x /root/.local/bin/claude -o -x /usr/local/bin/claude -o -x /usr/bin/claude 2>/dev/null; then
  echo "Claude Code is not installed yet. Run first:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/langloisgabriel03/jarvis-releases/main/termux/setup.sh | bash" >&2
  exit 1
fi

say "Jarvis server files"
proot-distro login debian -- env RAW="$RAW" bash -euo pipefail -c '
  mkdir -p /root/jarvis-server && cd /root/jarvis-server
  for f in package.json package-lock.json server.js app.js claude.js config.js persona.js whisper.js; do
    curl -fsSL "$RAW/$f" -o "$f.new" && mv "$f.new" "$f"
  done
  npm ci --omit=dev --no-audit --no-fund
'

# Settings (.env). Kept on updates; the token must be the same as on the PCs and in the app.
if proot-distro login debian -- test -f /root/jarvis-server/.env; then
  echo "Settings kept (/root/jarvis-server/.env in Debian)."
else
  say "Settings"
  echo "Paste the Jarvis token (tray menu of a PC > Copy token), then press Enter:"
  read -r TOKEN < /dev/tty
  [ -n "$TOKEN" ] || { echo "The token cannot be empty." >&2; exit 1; }
  echo "Answer language, en or fr [fr]:"
  read -r LANG_CHOICE < /dev/tty || true
  echo "Your city, for weather (optional, e.g. Montreal, Quebec, Canada):"
  read -r CITY < /dev/tty || true
  proot-distro login debian -- env T="$TOKEN" L="${LANG_CHOICE:-fr}" C="${CITY:-}" bash -c '
    cat > /root/jarvis-server/.env <<ENV
PORT=8787
JARVIS_BIND=127.0.0.1
JARVIS_NAME=phone
JARVIS_TOKEN=$T
JARVIS_MODEL=haiku
JARVIS_LANGUAGE=$L
JARVIS_WEB_SEARCH=1
JARVIS_LOCATION=$C
JARVIS_ACTIONS=off
JARVIS_CLAUDE_PATH=$(for c in /root/.local/bin/claude /usr/local/bin/claude /usr/bin/claude; do [ -x "$c" ] && echo "$c" && break; done)
ENV
    chmod 600 /root/jarvis-server/.env'
fi

# Whisper (whisper.cpp): understands French and English mixed in one sentence. The app sends the
# question's audio here and uses Whisper's text instead of Android's. Set WHISPER=0 to skip,
# WHISPER_MODEL=small-q5_1 for better accuracy (slower, ~190 MB) instead of base-q5_1 (~60 MB).
if [ "${WHISPER:-1}" != "0" ]; then
  say "Whisper speech-to-text (first time: ~5-10 min to compile)"
  proot-distro login debian -- env MODEL="${WHISPER_MODEL:-base-q5_1}" bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    command -v cmake >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1 || { apt-get update; apt-get install -y --no-install-recommends build-essential cmake git; }
    if [ -d /root/whisper.cpp/.git ]; then
      git -C /root/whisper.cpp pull -q --ff-only || true
    else
      git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp /root/whisper.cpp
    fi
    cd /root/whisper.cpp
    cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF > /dev/null
    cmake --build build -j4 --target whisper-cli > /dev/null
    [ -f "models/ggml-$MODEL.bin" ] || sh ./models/download-ggml-model.sh "$MODEL" > /dev/null
    test -x build/bin/whisper-cli && test -f "models/ggml-$MODEL.bin"
    ENV=/root/jarvis-server/.env
    sed -i "/^JARVIS_WHISPER_/d" "$ENV"
    printf "JARVIS_WHISPER_BIN=/root/whisper.cpp/build/bin/whisper-cli\nJARVIS_WHISPER_MODEL=/root/whisper.cpp/models/ggml-%s.bin\nJARVIS_WHISPER_THREADS=4\n" "$MODEL" >> "$ENV"
    echo "Whisper ready ($MODEL)."
  ' || echo "Whisper could not be installed: the app keeps using Android's recognizer."
fi

say "Commands: jarvis-start, jarvis-stop, jarvis-log"

# Stops every Jarvis server in Debian, including one left running outside the "jarvis" tmux session
# (an old version holding port 8787 keeps answering the app while the new one cannot start).
cat > "$BIN/jarvis-kill-servers" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
proot-distro login debian -- bash -c '
  n=0
  for d in /proc/[0-9]*; do
    [ -r "$d/cmdline" ] || continue
    # "node server.js" as separate arguments (a shell whose command text mentions it does not count)
    if tr "\0" "\n" < "$d/cmdline" 2>/dev/null | awk "prev ~ /(^|\/)node\$/ && \$0 == \"server.js\" { f = 1 } { prev = \$0 } END { exit !f }"; then
      kill "${d#/proc/}" 2>/dev/null && n=$((n+1))
    fi
  done
  [ "$n" -gt 0 ] && echo "Stopped $n Jarvis server process(es)."
  true
'
EOF

cat > "$BIN/jarvis-start" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Jarvis server in the background (tmux session "jarvis"); the wake lock keeps it alive with the screen off.
if tmux has-session -t jarvis 2>/dev/null; then
  echo "Jarvis server already running."
else
  jarvis-kill-servers # an old server outside tmux would keep port 8787
  termux-wake-lock
  tmux new-session -d -s jarvis \
    "proot-distro login debian -- env JARVIS_IN_DEBIAN=1 bash -c 'cd /root/jarvis-server && node server.js 2>&1 | tee -a /root/jarvis-server/console.log'"
  echo -n "Starting"
fi
for i in $(seq 1 40); do
  if curl -fsS -m 2 http://127.0.0.1:8787/health 2>/dev/null; then
    echo
    echo "Jarvis server is up. Open the Jarvis app: it uses this phone first."
    exit 0
  fi
  echo -n "."
  sleep 1
done
echo
echo "Not answering yet. See what happens with: jarvis-log"
EOF

cat > "$BIN/jarvis-stop" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
tmux kill-session -t jarvis 2>/dev/null && echo "Jarvis server stopped." || echo "Jarvis server was not running."
jarvis-kill-servers
# Keep the wake lock if a background Claude Code session still needs it.
if tmux has-session -t claude 2>/dev/null; then
  echo "Wake lock kept: claude-start is still running."
else
  termux-wake-unlock
  echo "Wake lock released."
fi
EOF

cat > "$BIN/jarvis-log" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
exec proot-distro login debian -- tail -n 40 -f /root/jarvis-server/console.log /root/jarvis-server/jarvis.log
EOF

chmod +x "$BIN/jarvis-start" "$BIN/jarvis-stop" "$BIN/jarvis-log" "$BIN/jarvis-kill-servers"

# Updating: a running server still has the old code in memory, so restart it with the new files.
if tmux has-session -t jarvis 2>/dev/null || curl -fsS -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then
  say "Restarting the running Jarvis server with the new version"
  tmux kill-session -t jarvis 2>/dev/null || true
  "$BIN/jarvis-kill-servers" || true
  "$BIN/jarvis-start" || true
fi

say "Done"
cat <<'EOF'
Start it:  jarvis-start
The Jarvis app tries this phone first (http://127.0.0.1:8787), then your PCs through Tailscale.
On this phone: chat, role-play and web search. PC actions (open apps...) need a PC.

To start it automatically when the phone boots: install the Termux:Boot app, open it once, then
  mkdir -p ~/.termux/boot && printf '#!/data/data/com.termux/files/usr/bin/sh\njarvis-start\n' > ~/.termux/boot/jarvis && chmod +x ~/.termux/boot/jarvis
EOF
