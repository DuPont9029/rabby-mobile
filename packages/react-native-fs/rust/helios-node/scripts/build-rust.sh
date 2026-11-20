#!/usr/bin/env bash
# Builds librabby_helios_node.so for one Android ABI.
# usage: build-rust.sh <abi> <output.so> <ndk-toolchain-bin> <api-level>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ABI="${1:?abi}"; OUTPUT="${2:?output}"; TOOLCHAIN_BIN="${3:?toolchain bin}"; API="${4:?api level}"

CARGO_BIN="${CARGO:-$(command -v cargo || true)}"
if [[ -z "${CARGO_BIN}" && -x "${HOME}/.cargo/bin/cargo" ]]; then CARGO_BIN="${HOME}/.cargo/bin/cargo"; fi
[[ -x "${CARGO_BIN}" ]] || { echo "cargo is required to build Helios (Rust 1.95.0)" >&2; exit 1; }

case "${ABI}" in
  arm64-v8a)   RUST_TARGET="aarch64-linux-android";   CLANG="aarch64-linux-android${API}-clang" ;;
  armeabi-v7a) RUST_TARGET="armv7-linux-androideabi"; CLANG="armv7a-linux-androideabi${API}-clang" ;;
  x86)         RUST_TARGET="i686-linux-android";      CLANG="i686-linux-android${API}-clang" ;;
  x86_64)      RUST_TARGET="x86_64-linux-android";    CLANG="x86_64-linux-android${API}-clang" ;;
  *) echo "unsupported Android ABI for Helios: ${ABI}" >&2; exit 2 ;;
esac

"${SCRIPT_DIR}/fetch-helios.sh"

TARGET_ENV="$(echo "${RUST_TARGET}" | tr 'a-z-' 'A-Z_')"
TARGET_LOWER="$(echo "${RUST_TARGET}" | tr '-' '_')"
BUILD_ROOT="$(dirname "${OUTPUT}")/cargo-target"
CARGO_HOME_DIR="${CARGO_HOME:-${HOME}/.cargo}"
SEP=$'\x1f'
FLAGS="--remap-path-prefix=${CARGO_HOME_DIR}=/cargo${SEP}-Clink-arg=-Wl,-soname,librabby_helios_node.so${SEP}-Clink-arg=-Wl,-z,max-page-size=16384"

mkdir -p "$(dirname "${OUTPUT}")"
env \
  "CC_${TARGET_LOWER}=${TOOLCHAIN_BIN}/${CLANG}" \
  "CXX_${TARGET_LOWER}=${TOOLCHAIN_BIN}/${CLANG}++" \
  "AR_${TARGET_LOWER}=${TOOLCHAIN_BIN}/llvm-ar" \
  "RANLIB_${TARGET_LOWER}=${TOOLCHAIN_BIN}/llvm-ranlib" \
  "CARGO_TARGET_${TARGET_ENV}_LINKER=${TOOLCHAIN_BIN}/${CLANG}" \
  "CARGO_TARGET_DIR=${BUILD_ROOT}" \
  "CARGO_ENCODED_RUSTFLAGS=${FLAGS}" \
  "PATH=${TOOLCHAIN_BIN}:${PATH}" \
  "${CARGO_BIN}" +1.95.0 build \
    --manifest-path "${CRATE_DIR}/Cargo.toml" \
    --release --locked --lib \
    --target "${RUST_TARGET}"
cp "${BUILD_ROOT}/${RUST_TARGET}/release/librabby_helios_node.so" "${OUTPUT}"
