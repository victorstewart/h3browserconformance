# Picoquic Native WebTransport Conformance

This directory preserves the broad native WebTransport conformance sources that
were split out of the picoquic pull request. They are kept here because they are
generic conformance infrastructure, not picoquic library code.

The picoquic PR should keep only focused implementation regression tests. This
external suite can use these sources as the basis for optional native
conformance checks without making the picoquic review carry the full matrix.

Snapshot files:

- `webtransport_test.c`
- `webtransport_wire_test.c`
- `h3zero_stream_test.c`
- `h3zerotest.c`
