#!/bin/sh
# Give every script URL in index.html a new version so browsers (and GitHub Pages' 10-minute cache)
# never mix files from two releases. Run before committing a release:  ./bump-version.sh
set -e
cd "$(dirname "$0")"
v="$(date +%Y-%m-%d).$(git rev-parse --short HEAD 2>/dev/null || date +%H%M%S)-$(date +%H%M%S)"
sed -i.bak -E "s/\?v=[A-Za-z0-9._-]+/?v=$v/g" index.html && rm -f index.html.bak
echo "index.html scripts now use ?v=$v"
