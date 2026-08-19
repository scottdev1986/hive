#!/usr/bin/env bash
# Install Ghostty terminfo database into Hive's machine home for dev use.
# For release builds, this is handled by the build script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Get HIVE_HOME, defaulting to ~/.hive
HIVE_HOME="${HIVE_HOME:-$HOME/.hive}"

# machineHiveHome logic: if HIVE_HOME is under instances/, use default home
if [[ "$HIVE_HOME" == *"/instances/"* ]]; then
    HIVE_HOME="${HOME}/.hive"
fi

TERMINFO_SRC="$REPO_ROOT/resources/terminfo"
TERMINFO_DEST="$HIVE_HOME/terminfo"

if [ ! -d "$TERMINFO_SRC" ]; then
    echo "Error: Terminfo source not found at $TERMINFO_SRC"
    echo "Run: tic -x -o resources/terminfo resources/terminfo-src/xterm-ghostty.ti"
    exit 1
fi

echo "Installing Ghostty terminfo to $TERMINFO_DEST"
mkdir -p "$TERMINFO_DEST"
cp -r "$TERMINFO_SRC"/* "$TERMINFO_DEST"/

echo "Terminfo installed successfully"
echo "Verify with: TERMINFO=$TERMINFO_DEST infocmp xterm-ghostty"
