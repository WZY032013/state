// POST /api/upload-chunk 分片上传（独立路由，优先于 [[path]].js catch-all）
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
    const existing = await env.DB.prepare('SELECT * FROM upload_chunks WHERE uploadId = ?').bind(body.uploadId).first();
    let chunks = existing ? JSON.parse(existing.chunks || '[]') : [];
    chunks[body.index] = body.data;
    if (!existing) {
      await env.DB.prepare('INSERT INTO upload_chunks (uploadId, name, mime, size, totalChunks, chunks, phone, ts) VALUES (?,?,?,?,?,?,?,?)')
        .bind(body.uploadId, body.name || '', body.mime || '', body.size || 0, body.totalChunks || 0, JSON.stringify(chunks), body.phone || '', Date.now()).run();
    } else {
      await env.DB.prepare('UPDATE upload_chunks SET chunks = ? WHERE uploadId = ?').bind(JSON.stringify(chunks), body.uploadId).run();
    }
    const got = chunks.filter(Boolean).length;
    return new Response(JSON.stringify({ ok: true, received: got, total: body.totalChunks || 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message || err) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
