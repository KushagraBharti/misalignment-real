# Crossed framing study (v3)

Two additional cells extend v2:

1. The simulation system prompt with the locked generated photorealistic JPEG.
2. The real-life system prompt with the locked rendered JPEG.

Ten calls per cell across the same four model IDs: 80 new calls. The runner
executes the existing v2 POST handler in Node with only its environment catalogue
overridden. It adapts the Cloudflare environment binding to process.env; it does
not modify any original protocol or route file. Model order and condition order
follow the v2 plan, with concurrency four, a 120-second provider timeout, and zero
automatic retries. No previous trial content enters a request. The route continues
to validate the actual JPEG hash and send image bytes as multimodal input.

Run from `recreation/`:

```sh
# Offline validation of all 80 request constructions; no provider calls.
node scripts/run-crossed-study.mjs

# Paid run, using the parent repository's ignored .env file.
node --env-file=../.env scripts/run-crossed-study.mjs --execute

# Generate the report and matrix after completion.
node scripts/report-crossed-study.mjs research/crossed-TIMESTAMP
```

Every run has a separate timestamped folder. Each response is saved immediately.
After an interruption, use `--execute --resume=research/crossed-TIMESTAMP`.
Completed/error records are never retried. A request interrupted before its record
was saved may already have been billed; inspect provider logs before resuming.

The request snapshots contain complete JPEG data URLs and no authentication
headers. The manifest captures full prompts and image hashes. Records preserve
provider responses, public statements, usage and errors. Temperature, seed and
reasoning effort remain unspecified, exactly as in v2; provider defaults apply.

The report combines new crossed conditions with the previous v2 summary, clearly
labeling the different collection dates. It does not pool their observations or
represent them as a new contemporaneous randomized four-condition run.
