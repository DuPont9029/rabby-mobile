# rabby-helios-node

In-process [a16z Helios](https://github.com/a16z/helios) light client for
Ethereum mainnet, built as its own Android shared library
(`librabby_helios_node.so`) with a small C ABI (`include/rabby_helios.h`).

- **Source**: Helios 0.12.0 at a pinned commit, fetched by
  `scripts/fetch-helios.sh` into `vendor/` and patched with
  `patches/helios.patch`:
  - no hickory-dns (Android has no `/etc/resolv.conf`);
  - no OpenSSL; rustls with the Mozilla root store instead of the platform
    verifier (which needs JNI setup on Android);
  - an in-process JSON-RPC methods handle (no network server).
- **Trust root**: the first sync starts from a finalized checkpoint that at
  least 3 distinct operators agree on; later starts reuse the checkpoint
  Helios stores in its data directory.
- **Execution RPCs** are data sources only (every answer is proof-checked);
  the node retries and rotates through the configured list.
- **Linking**: unresolved weak references (aws-lc `sdallocx`,
  `OPENSSL_memory_*`, zstd trace hooks, `getrandom`) are pinned to NULL at
  link time, and the build fails if the library imports anything beyond
  libc/libm/libdl. React Native's `libjsi.so` exports a data symbol named
  `sdallocx`, which otherwise crashed the app.

Build: `scripts/build-rust.sh <abi> <out.so> <ndk-toolchain-bin> <api>`
(called by `android/CMakeLists.txt`). Tests: `cargo test --release --lib`;
manual end-to-end check: `cargo run --release --example e2e -- <data_dir>`.
