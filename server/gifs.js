// GIPHY search, proxied through this server.
//
// The API key used to be hard-coded in client/src/app.js, which ships it to
// every browser and desktop install (and into the public repository). It now
// lives only in server/.env as GIPHY_API_KEY; clients call GET /api/gifs.
//
// Results are cached briefly: the picker opens on "trending" every time and
// people tend to search the same few words, and GIPHY's free tier is rate
// limited per key - which is now shared by every user of this server.

const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const RESULT_LIMIT = 24;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const cache = new Map(); // query -> { at, gifs }

export function isGifSearchConfigured() {
  return !!(process.env.GIPHY_API_KEY || '').trim();
}

function simplify(item) {
  const images = item.images || {};
  const previewUrl = images.fixed_height_small?.url || images.fixed_height_downsampled?.url || images.fixed_width_small?.url || images.original?.url;
  const fullUrl = images.original?.url || images.downsized_medium?.url || images.fixed_height?.url || previewUrl;
  return {
    previewUrl,
    fullUrl,
    title: typeof item.title === 'string' && item.title ? item.title.slice(0, 120) : 'GIPHY GIF'
  };
}

export async function searchGifs(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const cached = cache.get(query);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.gifs;

  const params = new URLSearchParams({
    api_key: process.env.GIPHY_API_KEY.trim(),
    limit: String(RESULT_LIMIT),
    rating: 'g'
  });
  let url;
  if (query) {
    params.set('q', query);
    url = `${GIPHY_BASE}/search?${params}`;
  } else {
    url = `${GIPHY_BASE}/trending?${params}`;
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GIPHY HTTP ${res.status}`);
  const data = await res.json();
  const gifs = (data.data || [])
    .map(simplify)
    // Only GIPHY's own https media hosts - these URLs are what clients put
    // into <img src> and what the server accepts back as a GIF message.
    .filter(g => /^https:\/\/(?:media\d*|i)\.giphy\.com\//.test(g.previewUrl || '') &&
                 /^https:\/\/(?:media\d*|i)\.giphy\.com\//.test(g.fullUrl || ''));

  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(query, { at: Date.now(), gifs });
  return gifs;
}
