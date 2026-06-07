# Pico Baton Conformance Server

This directory contains the expanded `pico_baton` server used by the browser
and WPT conformance suites. It intentionally lives outside picoquic so the
picoquic pull request only carries WebTransport implementation changes and
small in-repo regression tests.

Build it against a picoquic checkout:

```sh
cmake -S native/pico_baton -B build/pico_baton \
  -DPICOQUIC_ROOT=/path/to/picoquic \
  -DPICOQUIC_FETCH_PTLS:BOOL=ON
cmake --build build/pico_baton -j$(nproc) --target pico_baton
```

Use the resulting binary with the existing runners by setting `PICO_BATON_BIN`
or passing `--baton-bin`.
