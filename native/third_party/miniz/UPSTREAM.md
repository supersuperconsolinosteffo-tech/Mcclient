# miniz dependency provenance

- Upstream: https://github.com/richgel999/miniz
- Imported release tag: `3.0.2`
- Resolved source commit: `293d4db1b7d0ffee9756d035b9ac6f7431ef8492`
- License: MIT; see `LICENSE`.
- The Windows launcher uses miniz's raw DEFLATE decoder and CRC-32 implementation. The upstream source/header files are kept intact; the generated `miniz_export.h` equivalent here intentionally defines an empty export macro because these sources are statically linked into the executable.
