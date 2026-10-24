// POST /api/upload-assemble 分片拼接（独立路由）
// 安全：必须携带有效登录 token，且只能拼接自己创建的 uploadId。
export async function onRequest(context) {
  const { request, env } = context;
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method' }, 405);
  }
  try {
    const body = await request.json().catch(() => ({}));
    if (!body.uploadId) {
      return json({ ok: false, error: 'no uploadId' }, 400);
    }

    // 鉴权
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return json({ ok: false, error: '未登录' }, 401);
    const tok = await env.DB.prepare('SELECT * FROM tokens WHERE token = ?').bind(token).first();
    if (!tok || tok.expires < Date.now()) return json({ ok: false, error: '登录已过期' }, 401);
    const phone = tok.phone;

    await env.DB.prepare('CREATE TABLE IF NOT EXISTS upload_chunks (uploadId TEXT PRIMARY KEY, name TEXT DEFAULT \'\', mime TEXT DEFAULT \'\', size INTEGER DEFAULT 0, totalChunks INTEGER DEFAULT 0, chunks TEXT DEFAULT \'[]\', phone TEXT DEFAULT \'\', ts INTEGER DEFAULT 0)').run();
    const row = await env.DB.prepare('SELECT * FROM upload_chunks WHERE uploadId = ?').bind(body.uploadId).first();
    if (!row) {
      return json({ ok: false, error: 'no upload' }, 404);
    }
    if (row.phone && row.phone !== phone) {
      return json({ ok: false, error: 'uploadId 不属于当前用户' }, 403);
    }
    const chunks = JSON.parse(row.chunks || '[]');
    if (chunks.length !== row.totalChunks || chunks.some(c => !c)) {
      return json({ ok: false, error: 'incomplete', have: chunks.filter(Boolean).length, need: row.totalChunks }, 400);
    }
    // 分片按 3 字节切分（前端保证），各片 base64 无 padding，直接拼接即整体 base64
    const dataUrl = 'data:' + (row.mime || 'application/octet-stream') + ';base64,' + chunks.join('');
    await env.DB.prepare('DELETE FROM upload_chunks WHERE uploadId = ?').bind(body.uploadId).run();
    return json({ ok: true, dataUrl, name: row.name, size: row.size });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}