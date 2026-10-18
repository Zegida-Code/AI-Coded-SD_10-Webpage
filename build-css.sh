#!/bin/sh
# Compile css/tailwind.src.css -> css/app.css (minified). Run after changing classes in index.html or js/.
# Needs the Tailwind v3 CLI: either `npx tailwindcss` (Node) or the standalone binary
# (https://github.com/tailwindlabs/tailwindcss/releases/tag/v3.4.16) – set TAILWIND=/path/to/tailwindcss.
set -e
cd "$(dirname "$0")"
if [ -n "$TAILWIND" ]; then TW="$TAILWIND"
elif command -v tailwindcss >/dev/null 2>&1; then TW=tailwindcss
else TW="npx --yes tailwindcss@3.4.16"; fi
$TW -c tailwind.config.js -i css/tailwind.src.css -o css/app.css --minify
echo "css/app.css rebuilt"
