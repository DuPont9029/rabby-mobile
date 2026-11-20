#!/usr/bin/env bash
# Fetches a16z/helios at a pinned commit into vendor/helios and applies
# patches/helios.patch (Android: no hickory-dns, no OpenSSL, Mozilla roots
# instead of the platform verifier; in-process JSON-RPC methods).
set -euo pipefail
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELIOS_COMMIT="2af9b41887e069144ee56cd710f3ddca195473f8"
HELIOS_COMMIT_FULL_PREFIX="${HELIOS_COMMIT}"
DEST="${CRATE_DIR}/vendor/helios"
STAMP="${DEST}/.rabby-patched"
PATCH_SUM="$(shasum -a 256 "${CRATE_DIR}/patches/helios.patch" | cut -d' ' -f1)"
if [[ -f "${STAMP}" && "$(cat "${STAMP}")" == "${HELIOS_COMMIT}:${PATCH_SUM}" ]]; then
  exit 0
fi
rm -rf "${DEST}"
mkdir -p "${CRATE_DIR}/vendor"
git clone --quiet https://github.com/a16z/helios.git "${DEST}"
git -C "${DEST}" checkout --quiet "${HELIOS_COMMIT}"
case "$(git -C "${DEST}" rev-parse HEAD)" in
  "${HELIOS_COMMIT_FULL_PREFIX}"*) ;;
  *) echo "helios checkout mismatch" >&2; exit 1 ;;
esac
git -C "${DEST}" apply "${CRATE_DIR}/patches/helios.patch"
printf '%s' "${HELIOS_COMMIT}:${PATCH_SUM}" > "${STAMP}"
