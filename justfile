set shell := ["bash", "-euc"]
default:
    @just --list

test:
    bun test

check:
    python3 -m json.tool extension/manifest.json >/dev/null
    for f in extension/*.js; do node --check "$f"; done

build: check test
    mkdir -p dist
    cd extension && zip -qr ../dist/bookmark-mirror.zip .

dev:
    @echo 'Install the Nix package, then load its share/bookmark-mirror directory in chrome://extensions.'
