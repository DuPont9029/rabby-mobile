# Rabby Safe SVG Rust core

This crate is the memory-safe SVG parsing and rasterization core used by the
Rabby Mobile native filesystem/media boundary. It is not a general SVG viewer.

The public C ABI accepts only a local input file and writes a PNG to a caller-
selected private temporary path. Before calling `resvg`, it enforces Rabby's
static SVG profile: bounded input, XML depth and node counts, no DTD/entities,
scripts, event handlers, or external references.

A sanitizing step first deletes what cannot take effect in a static,
font-free rendering, so common on-chain NFT artwork is accepted: `@font-face`
and `@keyframes` stylesheet rules (SVG-supplied fonts are never loaded) and
SMIL animation elements (`animate`, `animateMotion`, `animateTransform`,
`set`; the first frame is rendered). This step only removes bytes, and the
full profile check runs on its output.

Embedded images must be `data:` URLs. PNG, JPEG, GIF and WebP are accepted
after their dimensions are read from the header and checked against per-image
and total pixel budgets. A nested `image/svg+xml` document is sanitized and
checked with the same profile one level down, where it may not embed images.
The renderer repeats these checks on the exact bytes it decodes.
Bounded static text, local `textPath`s and simple stylesheets are converted
to paths with the bundled Basic font; characters it has no glyph for are left
out. The profile rejects other CSS at-rules and escapes, external resources
and excessive text. It never scans device fonts or loads fonts supplied by an
SVG or the network.

`assets/basic/Basic-Regular.ttf` is distributed under the SIL Open Font License
1.1 in `assets/basic/OFL.txt`.

`resvg` is pinned exactly in `Cargo.toml`; `Cargo.lock` is committed for
reproducible Android and iOS builds. Generated `target/` and `build/` outputs
are ignored.

The crate is licensed under MIT. `resvg` and its dependency tree retain their
own upstream MIT/Apache-2.0-compatible license notices in Cargo metadata.
