// POST /api/upload-assemble 分片拼接（独立路由）
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method' }), { status: 405, headers: { 'content-type': 'application/json' } });
  }
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS upload_chunks (uploadId TEXT PRIMARY KEY, name TEXT DEFAULT \'\', mime TEXT DEFAULT \'\', size INTEGER DEFAULT 0, totalChunks INTEGER DEFAULT 0, chunks TEXT DEFAULT \'[]\', phone TEXT DEFAULT \'\', ts INTEGER DEFAULT 0)').run();
    const body = await request.json().catch(() => ({}));
    if (!body.uploadId) {
      return new Response(JSON.stringify({ ok: false, error: 'no uploadId' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const row = await env.DB.prepare('SELECT * FROM upload_chunks WHERE uploadId = ?').bind(body.uploadId).first();
    if (!row) {
      return new Response(JSON.stringify({ ok: false, error: 'no upload' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    const chunks = JSON.parse(row.chunks || '[]');
    if (chunks.length !== row.totalChunks || chunks.some(c => !c)) {
      return new Response(JSON.stringify({ ok: false, error: 'incomplete', have: chunks.filter(Boolean).length, need: row.totalChunks }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const dataUrl = 'data:' + (row.mime || 'application/octet-stream') + ';base64,' + chunks.join('');
    await env.DB.prepare('DELETE FROM upload_chunks WHERE uploadId = ?').bind(body.uploadId).run();
    return new Response(JSON.stringify({ ok: true, dataUrl: dataUrl, name: row.name, size: row.size }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message || err) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
