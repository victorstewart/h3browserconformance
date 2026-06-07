# h3browserconformance

Browser and WPT-oriented WebTransport-over-HTTP/3 conformance harnesses.

This repository is intentionally separate from picoquic. It contains the generic
browser automation, scenario manifests, browser expected-result ledgers, and WPT
adapter logic. Implementations provide their own compatible test server binary.

## Layout

- `browser/`: static harness page and browser-specific smoke runners.
- `e2e/`: manifest-driven browser scenarios and expected-result ledgers.
- `wpt/`: Web Platform Tests adapter and expected-result validation.
- `adapters/`: implementation-specific integration notes.

## Requirements

- Node.js 22 or newer.
- `openssl` for local test certificates.
- A built implementation server binary for server-backed smoke/browser runs.
- Browser binaries or drivers for browser-specific lanes.

## Implementation Integration

The suite does not vendor implementation source. Build a compatible server from
the implementation checkout under test, then pass that checkout and server
binary to the generic runners. For picoquic, see
`adapters/picoquic/README.md`.

```sh
cmake -S /path/to/picoquic -B /path/to/picoquic/build \
  -DPICOQUIC_FETCH_PTLS:BOOL=ON
cmake --build /path/to/picoquic/build -j$(nproc) --target pico_baton
```

Run validation commands against that checkout:

```sh
npm run e2e:list -- --implementation-root /path/to/picoquic
npm run e2e:support -- --implementation-root /path/to/picoquic
npm run e2e:coverage -- --implementation-root /path/to/picoquic
npm run wpt:list -- --implementation-root /path/to/picoquic
npm run wpt:server-smoke -- \
  --implementation-root /path/to/picoquic \
  --server-bin /path/to/picoquic/build/pico_baton
```

The same paths can be provided through environment variables:

- `WT_CONFORMANCE_IMPLEMENTATION_ROOT`
- `WT_CONFORMANCE_SERVER_BIN`
- `WT_CONFORMANCE_WEB_ROOT`
- `WT_CONFORMANCE_PORT`

Legacy picoquic-specific aliases remain accepted for existing CI:
`PICOQUIC_REPO_ROOT`, `PICO_BATON_BIN`, `PICOQUIC_WT_WEB_ROOT`, and
`PICOQUIC_WT_PORT`.

## Browser Runs

Chrome and Edge use the Chromium DevTools runner:

```sh
WT_CONFORMANCE_IMPLEMENTATION_ROOT=/path/to/picoquic \
WT_CONFORMANCE_SERVER_BIN=/path/to/picoquic/build/pico_baton \
CHROME_BIN=google-chrome \
npm run chrome:smoke
```

Firefox requires `geckodriver`; Safari requires `safaridriver --enable`.
The E2E runner selects the browser lane with `--browser`:

```sh
npm run e2e:list -- --implementation-root /path/to/picoquic
node e2e/runners/run-browser.mjs --browser chrome --implementation-root /path/to/picoquic --json
```

## WPT Adapter

The WPT adapter can validate the selected WebTransport subset without a WPT
checkout:

```sh
npm run wpt:list
```

With a WPT checkout, dry-run the selected invocation:

```sh
node wpt/run-wpt.mjs run --wpt-root /path/to/wpt --browser chrome --dry-run
```
