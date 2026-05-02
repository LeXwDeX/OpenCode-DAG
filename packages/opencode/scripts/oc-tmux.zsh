#!/usr/bin/env zsh
# oc-tmux.zsh — opencode tmux integration
#
# Features:
#   - Directory-scoped sessions: each directory gets its own tmux session
#   - Resume:   run oc again in the same directory → attaches to the live session
#   - Clean exit: when opencode quits the tmux session is destroyed automatically
#   - Full env inheritance: ALL env vars from the calling shell (API keys, PATH
#     overrides, anything exported at runtime) are available in the session
#     without modifying .zshrc or restarting the system
#
# Installation — add to ~/.zshrc:
#   source /path/to/opencode/packages/opencode/scripts/oc-tmux.zsh
#
# To make `opencode` itself go through tmux by default, also add:
#   alias opencode=oc
#
# Usage:
#   oc            — start or resume opencode for current directory
#   oc ls         — list all active opencode sessions with their paths
#   oc kill [dir] — kill the opencode session for a directory (default: cwd)

oc() {
  # ── guard ──────────────────────────────────────────────────────────────────
  if ! command -v tmux &>/dev/null; then
    print "oc: tmux not found — running opencode directly" >&2
    opencode "$@"
    return
  fi

  # ── subcommands ────────────────────────────────────────────────────────────
  case "$1" in
    ls|list)
      local _found=0
      while IFS= read -r _line; do
        # _line format: "SESSION_NAME\tSESSION_PATH\tATTACHED"
        local _name="${_line%%	*}"
        local _rest="${_line#*	}"
        local _path="${_rest%%	*}"
        local _att="${_rest##*	}"
        [[ "$_name" == oc_* ]] || continue
        _found=1
        printf "  %-45s  %s\n" "$_path" "$_att"
      done < <(tmux list-sessions \
        -F '#{session_name}	#{session_path}	#{?session_attached,(attached),(background)}' \
        2>/dev/null)
      (( _found )) || print "(no opencode sessions)"
      return
      ;;
    kill)
      local _kdir="${2:-.}"
      local _kabs _ks
      _kabs="$(cd "$_kdir" && pwd -P 2>/dev/null)" \
        || { print "oc: invalid directory: $_kdir" >&2; return 1; }
      # Recompute the session name the same way oc creates it
      local _kbase="${_kabs:t}"
      local _khash
      _khash="$(printf '%s' "$_kabs" | shasum -a 1 | cut -c1-8)"
      _ks="oc_${_kbase//[^A-Za-z0-9]/_}_${_khash}"
      if tmux kill-session -t "$_ks" 2>/dev/null; then
        print "oc: killed session for $_kabs"
      else
        print "oc: no active session for $_kabs"
      fi
      return
      ;;
  esac

  # ── derive session name ────────────────────────────────────────────────────
  # Format: oc_{basename}_{sha1_8chars}
  # - basename makes it human-readable in the tmux status bar
  # - sha1 hash of full path ensures uniqueness (no collisions between
  #   paths that share the same last component)
  local _dir _base _hash _session
  _dir="$(pwd -P)"
  _base="${_dir:t}"                                              # last component
  _hash="$(printf '%s' "$_dir" | shasum -a 1 | cut -c1-8)"
  _session="oc_${_base//[^A-Za-z0-9]/_}_${_hash}"

  # ── resume: attach if session already exists ───────────────────────────────
  if tmux has-session -t "$_session" 2>/dev/null; then
    if [[ -n "$TMUX" ]]; then
      tmux switch-client -t "$_session"
    else
      tmux attach-session -t "$_session"
    fi
    return
  fi

  # ── capture current environment ───────────────────────────────────────────
  # Problem: the tmux server process may have been started by a different shell
  # (or at login time) and therefore lacks env vars that were exported only in
  # the calling terminal session — API keys, project-specific overrides, etc.
  #
  # Solution: snapshot the full calling-shell environment into a temp file and
  # source it at session startup.  The file is removed immediately after
  # sourcing, so no secrets linger on disk.  The file is 0600 (mktemp default).
  local _env_file
  _env_file="$(mktemp /tmp/.ocenv_XXXXXX.sh)"

  local _k _v _line
  while IFS= read -r _line; do
    _k="${_line%%=*}"     # key:   everything before the FIRST =
    _v="${_line#*=}"      # value: everything after  the FIRST =
    # Skip vars that must not carry over or are meaningless in a new session
    case "$_k" in
      SHLVL|TMUX|TMUX_PANE|TMUX_PLUGIN_MANAGER_PATH|\
      TERM_SESSION_ID|TERM_PROGRAM|TERM_PROGRAM_VERSION|\
      ITERM_SESSION_ID|ITERM_PROFILE|_|PWD|OLDPWD) continue ;;
    esac
    # Only POSIX-valid identifier names (skip bash internal arrays, etc.)
    [[ "$_k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # printf %q produces safely shell-quoted output; handles spaces, $, quotes
    printf 'export %s=%q\n' "$_k" "$_v"
  done < <(env) > "$_env_file"

  # ── create session ─────────────────────────────────────────────────────────
  # Sequence executed inside the tmux pane:
  #   1. source env snapshot  → full environment from calling shell
  #   2. delete the temp file → no leftover secrets
  #   3. run opencode         → interactive TUI
  #   4. on exit: kill this session → complete teardown, no ghost sessions
  tmux new-session \
    -d \
    -s "$_session" \
    -c "$_dir" \
    "source '$_env_file' 2>/dev/null; rm -f '$_env_file'; opencode; tmux kill-session -t '$_session' 2>/dev/null"

  # ── attach ─────────────────────────────────────────────────────────────────
  if [[ -n "$TMUX" ]]; then
    tmux switch-client -t "$_session"
  else
    tmux attach-session -t "$_session"
  fi
}
