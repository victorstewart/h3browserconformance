# Picoquic Adapter

This adapter describes how to run the generic browser and WPT conformance
checks against a picoquic checkout.

The conformance repository does not vendor picoquic C source. The picoquic
checkout under test remains the source of truth for:

- the `pico_baton` server implementation,
- native C regression tests,
- HTTP/3 and WebTransport protocol implementation details.

## Build Server

Build `pico_baton` from the picoquic checkout under test:

```sh
cmake -S /path/to/picoquic -B /path/to/picoquic/build \
  -DPICOQUIC_FETCH_PTLS:BOOL=ON
cmake --build /path/to/picoquic/build -j$(nproc) --target pico_baton
```

Then pass that binary to this suite:

```sh
node wpt/run-wpt.mjs server-smoke \
  --implementation-root /path/to/picoquic \
  --server-bin /path/to/picoquic/build/pico_baton
```

The legacy picoquic-specific aliases `--picoquic-root`, `--baton-bin`,
`PICOQUIC_REPO_ROOT`, and `PICO_BATON_BIN` remain accepted for existing CI,
but new integrations should prefer the generic names.

## Native Tests

Native C tests are not copied into this repository. Run them from the picoquic
checkout itself so they stay current with the implementation being tested.

