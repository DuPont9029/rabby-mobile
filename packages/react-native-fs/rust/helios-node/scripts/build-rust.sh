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
# Weak references that nothing in this library defines (aws-lc's sdallocx,
# OPENSSL_memory_* and getrandom, zstd's trace hooks) would otherwise be
# resolved at load time against whatever the app process exports. React
# Native's libjsi.so exports a *data* symbol named sdallocx; aws-lc called it
# as its free() and crashed. Pin them to NULL here (the version script then
# makes them local), so the libraries always use their built-in defaults.
FLAGS="--remap-path-prefix=${CARGO_HOME_DIR}=/cargo${SEP}-Clink-arg=-Wl,-soname,librabby_helios_node.so${SEP}-Clink-arg=-Wl,-z,max-page-size=16384"
for weak in sdallocx OPENSSL_memory_alloc OPENSSL_memory_free OPENSSL_memory_get_size OPENSSL_memory_realloc ZSTD_trace_decompress_begin ZSTD_trace_decompress_end getrandom; do
  FLAGS+="${SEP}-Clink-arg=-Wl,--defsym=${weak}=0"
done

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
LIBRARY="${BUILD_ROOT}/${RUST_TARGET}/release/librabby_helios_node.so"
# Guard: the library may only import from the system libc/libm/libdl.
UNEXPECTED="$("${TOOLCHAIN_BIN}/llvm-nm" -D --undefined-only "${LIBRARY}" | grep -v -E '@(LIBC|LIBDL|LIBM)' || true)"
if [[ -n "${UNEXPECTED}" ]]; then
  echo "librabby_helios_node.so imports unexpected symbols:" >&2
  echo "${UNEXPECTED}" >&2
  exit 1
fi
cp "${LIBRARY}" "${OUTPUT}"
