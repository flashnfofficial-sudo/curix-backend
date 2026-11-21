// Netlify Function: /.netlify/functions/music   (Music Detective: real audio fingerprinting with AudD)
// The app records a short clip (WAV) and sends it here. AudD matches it against its music database,
// exactly like Shazam. An ordinary text AI cannot do this, so it is NOT used here.
// Env vars: AUDD_API_TOKEN (get one at dashboard.audd.io), CURIX_APP_TOKEN (already set).

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const needToken = process.env.CURIX_APP_TOKEN;
  const got = event.headers['x-curix-token'] || event.headers['X-Curix-Token'];
  if (!needToken || got !== needToken) return json(401, { error: 'Unauthorized' });
  const key = process.env.AUDD_API_TOKEN;
  if (!key) return json(500, { error: 'AUDD_API_TOKEN is not set on the server (get a token at dashboard.audd.io)' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const audio = String(body.audio || '');
  if (!audio || audio.length > 4000000) return json(400, { error: 'Audio missing or too long' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(audio, 'base64')], { type: 'audio/wav' }), 'clip.wav');
    form.append('return', 'apple_music,spotify');
    form.append('api_token', key);
    const r = await fetch('https://api.audd.io/', { method: 'POST', body: form, signal: ctl.signal });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    if (data.status === 'error') {
      const e = data.error || {};
      return json(502, { error: `AudD: ${e.error_message || 'error'} (#${e.error_code || '?'})`.slice(0, 250) });
    }
    if (!r.ok) return json(502, { error: 'AudD error ' + r.status });
    const x = data.result;
    if (!x) return json(200, { found: false });

    const am = x.apple_music || {};
    const sp = x.spotify || {};
    let art = '';
    if (am.artwork && am.artwork.url) art = String(am.artwork.url).replace('{w}', '600').replace('{h}', '600');
    else if (sp.album && sp.album.images && sp.album.images[0]) art = sp.album.images[0].url;
    return json(200, {
      found: true,
      title: x.title || '',
      artist: x.artist || '',
      album: x.album || (sp.album && sp.album.name) || '',
      release: x.release_date || (sp.album && sp.album.release_date) || '',
      label: x.label || '',
      artwork: art,
      spotify: (sp.external_urls && sp.external_urls.spotify) || '',
      apple: am.url || '',
      songlink: x.song_link || '',
    });
  } catch (e) {
    return json(502, { error: 'Music recognition failed: ' + (e.name === 'AbortError' ? 'timeout' : e.message) });
  } finally {
    clearTimeout(timer);
  }
};
