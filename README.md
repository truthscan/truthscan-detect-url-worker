# truthscan-detect-url (Cloudflare Worker)

One endpoint, one domain: POST a **public image URL** + a **TruthScan API key**,
get back an AI-vs-real verdict. The Worker downloads the image and runs the
existing `get-presigned-url` → `PUT` upload → `/detect` → poll `/query` pipeline
against `detect-image.truthscan.com`, then returns the `/query` result.

Built so the **Devvit app** (`truthscan-devvit`) needs to allowlist only **one**
host instead of three. Mirrors the proven `image-downloader-for-mc` pattern
already used by the MCP `detect_image` tool and the Chrome extension — but it is
**self-contained** and keyed by the caller's public API key (no internal worker
token, no backend coupling). The API key is NOT stored; it is passed per request.

## API
```
POST https://<worker-url>/
Content-Type: application/json
```
```jsonc
{
  "url": "https://i.redd.it/abc.jpg",   // REQUIRED — public image URL
  "key": "YOUR_TRUTHSCAN_API_KEY",       // or send header `apikey: <KEY>`
  "wait": true,                           // optional (default): block for the result
  "max_wait_seconds": 30,                 // optional (5–30)
  "generate_analysis_details": false,     // optional
  "generate_heatmap": false,              // optional
  "generate_preview": false,              // optional
  "model": "generic"                      // optional
}
```
Success (`200`) returns the raw `/query` body: `result` (0–100), `final_result`,
`result_details`, etc. `GET /` is a health check.

## Deploy
```bash
cd truthscan-detect-url-worker
npx wrangler deploy          # uses your already-logged-in wrangler
```
Deploys to `https://truthscan-detect-url.<account>.workers.dev`.

### Branded domain (recommended for the Devvit allowlist)
If the `truthscan.com` zone is in this Cloudflare account, uncomment the
`routes` line in `wrangler.toml` (`detect-url.truthscan.com`) and redeploy.

## Reddit image caveat
Works for **public** posts (media on `i.redd.it` is a public CDN URL). It cannot
fetch NSFW/quarantined/private-subreddit images or signed `preview.redd.it`
links — for those the client would need to send the bytes instead.

## Notes
- SSRF guard blocks private/link-local/metadata hosts (CF Workers can't reach
  private networks anyway).
- Limits: 1 KB–10 MB, supported image formats only.
- Abuse is gated by the TruthScan API key (detection costs a credit).
