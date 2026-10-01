/**
 * TruthScan "detect image by public URL" — Cloudflare Worker proxy.
 *
 * One call, one domain. The caller (e.g. the Devvit app) POSTs a public image
 * URL + TruthScan API key; the Worker downloads the image and runs the existing
 * presign -> upload -> /detect -> poll /query pipeline against
 * detect-image.truthscan.com, then returns the /query result.
 *
 * The API key is NOT stored here — it is passed per-request and forwarded.
 */

const IMAGE_BASE = 'https://detect-image.truthscan.com';
const STORAGE_BASE = 'https://ai-image-detector-prod.nyc3.digitaloceanspaces.com';
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_BYTES = 1024;

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  avif: 'image/avif', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff',
  gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, apikey',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

function contentTypeFor(name: string): string {
  const ext = (name.split('?')[0].split('.').pop() || '').toLowerCase();
  return CONTENT_TYPES[ext] || 'image/jpeg';
}

/** Block obviously-internal targets (defense in depth; CF Workers can't reach private nets anyway). */
function hostBlocked(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254') return true;
  if (/^(10\.|127\.|0\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method === 'GET') return json({ ok: true, service: 'truthscan-detect-url' });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }

    const apiKey = request.headers.get('apikey') || body.key;
    const url = body.url;
    if (!apiKey) return json({ error: 'missing API key (apikey header or "key" in body)' }, 403);
    if (!url || typeof url !== 'string') return json({ error: 'missing "url"' }, 400);

    let target: URL;
    try { target = new URL(url); } catch { return json({ error: 'invalid url' }, 400); }
    if (!/^https?:$/.test(target.protocol)) return json({ error: 'url must be http(s)' }, 400);
    if (hostBlocked(target)) return json({ error: 'host not allowed' }, 400);

    const maxWaitMs = Math.min(Math.max(Number(body.max_wait_seconds) || 30, 5), 30) * 1000;

    try {
      // 1. download the image
      const imgRes = await fetch(target.toString(), {
        redirect: 'follow',
        headers: { 'user-agent': 'TruthScan-DetectURL/1.0' },
      });
      if (!imgRes.ok) return json({ error: `could not fetch image (${imgRes.status})` }, 400);
      const buf = await imgRes.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) return json({ error: 'image exceeds 10MB' }, 400);
      if (buf.byteLength < MIN_BYTES) return json({ error: 'image too small (<1KB)' }, 400);

      // 2. presigned upload URL
      const fileName = (target.pathname.split('/').pop() || 'image.jpg').replace(/\s+/g, '_');
      const presignRes = await fetch(
        `${IMAGE_BASE}/get-presigned-url?file_name=${encodeURIComponent(fileName)}`,
        { headers: { apikey: apiKey } },
      );
      const presign = await presignRes.json().catch(() => ({} as any));
      if (!presignRes.ok || !presign.presigned_url || !presign.file_path) {
        return json({ error: presign.error || `presign failed (${presignRes.status})` }, presignRes.status === 403 ? 403 : 400);
      }

      // 3. upload the bytes
      const putRes = await fetch(presign.presigned_url, {
        method: 'PUT',
        headers: { 'content-type': contentTypeFor(fileName), 'x-amz-acl': 'private' },
        body: buf,
      });
      if (!putRes.ok) return json({ error: `upload failed (${putRes.status})` }, 502);

      // 4. submit for detection
      const objectUrl = `${STORAGE_BASE}/${String(presign.file_path).replace(/^\//, '')}`;
      const detectRes = await fetch(`${IMAGE_BASE}/detect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: apiKey,
          url: objectUrl,
          generate_heatmap: !!body.generate_heatmap,
          generate_analysis_details: !!body.generate_analysis_details,
          generate_preview: !!body.generate_preview,
          ...(body.model ? { model: body.model } : {}),
        }),
      });
      const detect = await detectRes.json().catch(() => ({} as any));
      if (!detectRes.ok || !detect.id) {
        return json({ error: detect.error || `detect failed (${detectRes.status})` }, detectRes.status === 403 ? 403 : 400);
      }

      if (body.wait === false) return json({ id: detect.id, status: 'pending' }, 202);

      // 5. poll /query until a result is ready
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const qRes = await fetch(`${IMAGE_BASE}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: detect.id, key: apiKey }),
        });
        const q = await qRes.json().catch(() => ({} as any));
        if (q && (q.result != null || q.final_result != null)) return json(q, 200);
      }
      return json({ id: detect.id, status: 'pending', error: 'timed out; poll /query with this id' }, 504);
    } catch (e: any) {
      return json({ error: 'internal error: ' + (e?.message || String(e)) }, 500);
    }
  },
};
