# WebTransport WPT Adapter

This directory contains the skeleton used to connect WebTransport-over-HTTP/3
implementations to the Web Platform Tests `webtransport/` suite.

List the initial target subset without a WPT checkout:

```sh
node wpt/run-wpt.mjs list
```

List matching tests from a local WPT checkout:

```sh
node wpt/run-wpt.mjs list --wpt-root /path/to/wpt
```

Validate an expected-result manifest against the current target subset:

```sh
node wpt/run-wpt.mjs list \
  --expected wpt/expected/chrome-stable.json
```

Smoke-test an implementation server lifecycle adapter. The server binary is
built from the implementation checkout under test; this repository does not
vendor that C source.

```sh
cmake -S /path/to/picoquic -B /path/to/picoquic/build \
  -DPICOQUIC_FETCH_PTLS:BOOL=ON
cmake --build /path/to/picoquic/build -j$(sysctl -n hw.ncpu) --target pico_baton
node wpt/run-wpt.mjs server-smoke \
  --implementation-root /path/to/picoquic \
  --server-bin /path/to/picoquic/build/pico_baton
```

Dry-run the selected upstream WPT invocation without launching a browser:

```sh
node wpt/run-wpt.mjs run \
  --wpt-root /path/to/wpt \
  --browser chrome \
  --test constructor.https.sub.any.js \
  --dry-run
```

Run the selected upstream WPT subset with WPT's own WebTransport-over-H3
server enabled:

```sh
node wpt/run-wpt.mjs run \
  --wpt-root /path/to/wpt \
  --browser chrome \
  --expected wpt/expected/chrome-stable.json
```

The `run` command is opt-in and uses WPT's upstream WebTransport server via
`wpt run --enable-webtransport-h3`. It is a browser API/WPT gate, not yet a
implementation-server WPT conformance claim. Later commits should add
implementation server/handler shims so the same target subset can be run
against specific implementations directly.

Expected-result manifests live under
`wpt/expected/`; Chrome, Edge, Firefox, and Safari stable
manifests are validated by CTest. Keep entries tied to tests in the listed WPT
target subset so stale browser caveats fail fast.
