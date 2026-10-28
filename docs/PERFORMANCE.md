# Download engine performance and recovery

PIDM 0.3.0 adds bounded scheduling, retry/recovery and a different temporary-file layout. These changes improve specific workloads; they are not a guarantee of higher speed on every website.

## Behavior

- At most **three active jobs**, with **two per source hostname**. Additional downloads remain queued and can be paused or removed without starting network work.
- Direct HTTP transfers share at most **twelve response-body leases**, with **eight per requested hostname**. A lease stays occupied until the body is consumed or cancelled. Probe/redirect requests can contact a different final hostname; subsequent file chunks use that final URL.
- The Connections selector is an upper bound of 1-8. Small files use fewer requests. Ranged files use a bounded work queue, normally two chunks per connection with a 256 KiB minimum chunk size. Workers take the next unfinished chunk; an already-active slow chunk is not forcibly split.
- Temporary direct-transfer failures retry at most **three times** after the initial attempt, with increasing delays. HTTP 408, 429, 500, 502, 503 and 504 are retryable. HTTP 403 is not retried automatically.
- A 429/503 `Retry-After` creates a shared cooldown for that requested hostname. Existing in-flight requests may finish, but new direct transfer requests wait. Waits longer than two minutes stop automatic attempts with a retry-later message. Pause/Remove/Exit cancels a pending wait promptly.
- Direct requests detect **30 seconds without activity**. Video requests use the video engine's **20-second socket timeout** and bounded retry settings.
- Supported native HLS/DASH downloads use up to **four concurrent fragments**, bounded by the requested Connections value. Other video protocols do not gain fragment concurrency from this option. A missing fragment fails extraction instead of being silently skipped.
- Progress projections are created only when an observer exists, at most four times a second during steady transfer, with immediate final state updates. The desktop UI continues to poll once a second.

## Disk layout and durability

Direct workers write at non-overlapping offsets into `.parts/<job-id>.data`. Prefix offsets are recorded only after the corresponding data has been synced. Active transfers checkpoint about once a second; graceful Pause and Exit wait for writers, sync the remaining prefixes and save history. A crash can lose progress since the latest checkpoint. Full power-loss recovery has not been fault-tested.

History writes sync a temporary manifest before atomic replacement. Temporary Windows file-lock errors use bounded retries; permanent filesystem errors remain visible failures rather than silently discarding history.

On supported filesystems, publication uses a hard link and removes the staging name, avoiding a second full-file read/write merge. Unsupported hard-link cases use an exclusive copy fallback. Existing completed files are never overwritten. Final publication that has already succeeded remains a completed download even if temporary cleanup needs a later retry.

Each video job has its own `.parts/<job-id>.media/` working directory, so identical concurrent video jobs do not share fragments. Final output publication is exclusive: one job can complete and a duplicate fails with an existing-file message rather than corrupting its output.

Legacy indexed direct-download parts migrate on resume after source validation. Legacy video partials in the download root remain untouched; their ownership cannot be inferred reliably enough to move or delete them automatically.

## Local comparison — 28 October 2026

An unchanged 0.2.2 engine was compared with the 0.3.0 implementation on the same Windows host using Node.js 24.22.1. Each transfer downloaded **32 MiB**, used **four connections**, and had **1,000 completed history entries**. Every completed output was SHA-256 checked.

Three fresh processes were run per engine/scenario, alternating which engine ran first. The source server and downloader shared the measured process. OS file cache, antivirus activity and background system load were not controlled. These are first/repeat runs, not proven cold/warm disk measurements. CPU time and peak RSS include the fixture server and its 32 MiB buffer. No child processes were used in these direct-transfer benchmarks.

| Scenario / metric | 0.2.2 median | 0.3.0 median |
| --- | ---: | ---: |
| Fast localhost source: elapsed | 850.6 ms | 665.7 ms |
| Fast localhost source: CPU | 515 ms | 454 ms |
| Fast localhost source: peak RSS | 121.3 MiB | 125.6 MiB |
| First data response slowed: elapsed | 1,762.2 ms | 903.3 ms |
| First data response slowed: CPU | 609 ms | 579 ms |
| First data response slowed: peak RSS | 117.5 MiB | 126.6 MiB |

The final paired medians were about 22% and 49% lower in elapsed time respectively. This is not evidence of a universal Internet throughput increase. Fast-source results varied substantially, and exploratory runs sometimes favored the older engine. The candidate made nine requests per transfer versus five in the baseline, used more memory in this comparison, and introduced data-sync checkpoints absent from the baseline. Those overheads can outweigh the benefit on some low-latency sources.

The straggler fixture deliberately slowed only its first data response. Its result demonstrates reduced exposure to a slow fixed segment, not a prediction of every server's behavior. Video extraction time, Internet bandwidth, browser/Edge behavior, cold-cache performance and agent token costs were not measured by this benchmark.

Full samples and source digests: [engine-performance.json](engine-performance.json).

## Reproduce

From the project root:

```powershell
npm run bench:downloads
node scripts/benchmark-downloads.mjs --scenario straggler
```

To compare a preserved baseline source tree against the current source:

```powershell
node scripts/compare-downloads.mjs C:\path\to\baseline\src\downloads.js
```

The comparison writes `.cache/engine-performance.json`. Keep unrelated heavy tests and builds stopped during measurement. Preserve the baseline tree's imported modules as well as its `downloads.js` file.

## Verification limits

The regression suite exercises exact-byte reconstruction, interrupted responses, validated/unvalidated retries, 429 cooldowns, request/job limits, pause during retry, migration, restart, collisions, live checkpoints, writer shutdown, cleanup failure/retry and final cleanup ownership. Real local media tests exercise HLS parallelism/missing fragments and exact DASH resolutions with audio.

Fresh Windows 10/11 machines, all storage filesystems, every public video site, real browser-store installation and exhaustive crash/power-loss testing remain outside the verified coverage. The installer is unsigned, and public binary distribution still requires the separate steps in [DISTRIBUTION.md](DISTRIBUTION.md).
