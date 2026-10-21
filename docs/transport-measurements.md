# Resource-aware request transport

## What changed

The canonical coding MCP endpoint, Claude facade and coding backend no longer use fixed 512 KiB / implicit 100 KiB JSON limits. MCP nginx locations set client_max_body_size 0 and proxy_request_buffering off, allowing the authenticated application to admit requests according to current memory headroom instead of spooling arbitrarily large bodies at the proxy. OAuth retains its small parsers and existing nginx limits. The probe-only application still uses its deliberately bounded 64 KiB parser.

Host validation and bearer authentication precede resource admission. The facade composes Express with the SDK's exported hostHeaderValidation middleware, rather than modifying SDK private middleware internals. JSON compression is explicitly rejected with 415 because a wire-byte admission estimate does not bound decompressed JSON. Send uncompressed resumable chunks.

src/transport.js derives an advisory wire budget from the smaller of Node's cgroup-aware availableMemory() and V8 total_available_size. Half is kept as operational headroom; the remaining amount, minus in-flight reservations, is divided by a conservative 32x wire-allocation estimate. This is not a physical memory ceiling or a universal OOM guarantee. Live allocations, GC and unrelated work can change the headroom.

Before JSON.parse, a lexical scan adds reservations for structural complexity (256 bytes per object/array opener, 32 per comma, outside strings). This prevents a dense object graph from being admitted solely on cheap wire bytes. The scan handles escaped quotes/backslashes and Unicode JSON encodings without constructing the object graph. A structural resource rejection returns 413 RESOURCE_BUDGET, not an unsupported-JSON prohibition.

Content-Length is checked before parsing, and the parser limit equals the amount actually reserved. Chunked bodies have their bytes counted by Express/body-parser and reserve the currently available budget. Reservations are released on response finish/close or request abort, including parser failure. Concurrent requests reduce each other's available budget; no-headroom requests receive retryable 503. Rejected requests close their connection without retaining or logging private payload text.

X-Praxis-Request-Budget-Bytes advertises the current endpoint budget. capabilities.limits.transport and resumable host_file_write receipts describe the policy and a recommended raw chunk size of budget/8 (room for worst-case JSON escaping plus envelope overhead). Gateway results use the smaller advertised frontend/backend budget. Recommendations fluctuate, are not guarantees, and do not identify unknown upstream connector limits. A totalFileBytes value of null means no application total-file-size cap, not infinite host storage.

The existing 20-second gateway timeout stays in place for ordinary calls. Resumable upload finalization returns a durable pending state while hashing instead of requiring an arbitrarily long HTTP call; poll its status and follow recovery instructions after restart.

## Measurement method and observed lower bounds

Run node scripts/measure-transport.mjs inside the managed workspace. Each case uses a fresh Node 22.22.0 child with a 192 MiB V8 heap setting and a 30-second child deadline. It does not contact production or seek an OOM boundary. It deliberately retains synthetic client input plus serialized/parsed frontend and backend copies in one process. Real services distribute these copies, so this is a conservative allocation fixture, not an exact production RSS prediction.

2026-10-21 run, durable Praxis job 23924d89-c290-46d5-aa40-d7ed548619cf, preserved artifact praxis-transport-measure-20261021.jsonl:

- ASCII, 4,194,354 wire bytes: baseline RSS 48,365,568; peak RSS 82,845,696; 116.75 ms.
- Escaped text, 4,194,356 wire bytes: baseline 48,365,568; peak 78,217,216; 135.94 ms.
- UTF-8 emoji/accented text, 4,194,356 wire bytes: baseline 48,234,496; peak 82,808,832; 146.46 ms.
- Base64 text, 4,194,354 wire bytes: baseline 48,365,568; peak 83,308,544; 103.35 ms.
- Dense zero array, 4,194,353 wire bytes: baseline 48,189,440; peak 158,355,456; 431.11 ms.
- Empty-object array, 1,048,624 wire bytes: baseline 48,365,568; peak 171,802,624; 771.86 ms.
- Empty-array array, 1,048,624 wire bytes: baseline 48,234,496; peak 147,808,256; 674.45 ms.

The largest incremental RSS ratios were approximately 9.3x for string fixtures, 26.4x for numeric arrays and 117.7x for empty-object arrays. Structural reservations were added because a single string-derived amplification factor did not cover object-heavy JSON.

Loopback transport tests exercise authenticated multi-megabyte Unicode/escaped JSON, rejection recovery, concurrent reservations, chunked bodies, aborted requests, malformed JSON, compression rejection and no-headroom backpressure. These establish tested implementation behavior, not a maximum upstream transport size.

Separately, the existing production nginx log recorded a rejected request declaring a Content-Length of 2,027,125 bytes at 16:01:02 UTC on 2026-10-21. This shows the request reached nginx declaring that Content-Length; the log does not establish that the complete body was received. The old local 512 KiB gate rejected it; the connector's actual upper ceiling remains unknown. No production upload was replayed and no live service was reloaded during this implementation.

## Deployment verification still required

These source changes do not modify running nginx or services. A reviewed, separately authorized deployment must activate both the canonical gateway/control and facade code, the coding backend and their nginx MCP locations. Validate nginx configuration before reload. Then verify authenticated small calls, advertised budgets and one bounded chunk/resume/finalize round trip through each public endpoint. Do not claim upstream size limits from isolated tests.
