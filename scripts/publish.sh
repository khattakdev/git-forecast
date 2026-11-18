#!/usr/bin/env bash
# Publishes each package directory given, in order, skipping any whose
# version is already on npm. That makes a failed release safe to re-run:
# if core published and the CLI failed, the re-run skips core instead of
# failing on "cannot publish over the previously published version".
#
#   scripts/publish.sh packages/core packages/cli            (release.yml)
#   scripts/publish.sh --dry-run packages/core packages/cli  (try it locally)
set -euo pipefail

dry=()
if [ "${1:-}" = "--dry-run" ]; then dry=(--dry-run); shift; fi

for dir in "$@"; do
  name=$(node -p "require(require('path').resolve('$dir','package.json')).name")
  version=$(node -p "require(require('path').resolve('$dir','package.json')).version")
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "skip   $name@$version (already on npm)"
  else
    echo "publish $name@$version"
    npm publish "${dry[@]}" --workspace "$dir" --provenance --access public
  fi
done
