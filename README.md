# h3browserconformance

Browser and WPT-oriented WebTransport-over-HTTP/3 conformance harnesses.

This repository is intentionally separate from picoquic. It contains the generic
browser automation, scenario manifests, browser expected-result ledgers, and WPT
adapter logic. picoquic only needs to provide a compatible test server such as
`pico_baton`.

## Layout

- `browser/`: static harness page and browser-specific smoke runners.
- `e2e/`: manifest-driven browser scenarios and expected-result ledgers.
- `wpt/`: Web Platform Tests adapter and expected-result validation.

## Requirements

- Node.js 22 or newer.
- `openssl` for local test certificates.
- A built picoquic `pico_baton` binary for server-backed smoke/browser runs.
- Browser binaries or drivers for browser-specific lanes.

## Picoquic Integration

Build picoquic first:

```sh
cmake -S /path/to/picoquic -B /path/to/picoquic/build -DPICOQUIC_FETCH_PTLS:BOOL=ON
cmake --build /path/to/picoquic/build -j$(nproc) --target pico_baton
```

Run validation commands against that checkout:

```sh
npm run e2e:list -- --picoquic-root /path/to/picoquic
npm run e2e:support -- --picoquic-root /path/to/picoquic
npm run e2e:coverage -- --picoquic-root /path/to/picoquic
npm run wpt:list -- --picoquic-root /path/to/picoquic
npm run wpt:server-smoke -- --picoquic-root /path/to/picoquic --baton-bin /path/to/picoquic/build/pico_baton
```

The same paths can be provided through environment variables:

- `PICOQUIC_REPO_ROOT`
- `PICO_BATON_BIN`
- `PICOQUIC_WT_WEB_ROOT`
- `PICOQUIC_WT_PORT`

## Browser Runs

Chrome and Edge use the Chromium DevTools runner:

```sh
PICOQUIC_REPO_ROOT=/path/to/picoquic \
PICO_BATON_BIN=/path/to/picoquic/build/pico_baton \
CHROME_BIN=google-chrome \
npm run chrome:smoke
```

Firefox requires `geckodriver`; Safari requires `safaridriver --enable`.
The E2E runner selects the browser lane with `--browser`:

```sh
npm run e2e:list -- --picoquic-root /path/to/picoquic
node e2e/runners/run-browser.mjs --browser chrome --picoquic-root /path/to/picoquic --json
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

