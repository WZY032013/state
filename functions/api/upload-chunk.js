// POST /api/upload-chunk 分片上传（独立路由，优先于 [[path]].js catch-all）
// 安全：必须携带有效登录 token；uploadId 与 token 所属手机号强绑定，
//      防止未登录写入 D1，以及冒用他人 uploadId 拼接数据。
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

    // 服务端只认 token 的身份，不信任请求体里的 phone
    if (body.phone && body.phone !== phone) return json({ ok: false, error: '身份不匹配' }, 403);

    await env.DB.prepare('CREATE TABLE IF NOT EXISTS upload_chunks (uploadId TEXT PRIMARY KEY, name TEXT DEFAULT \'\', mime TEXT DEFAULT \'\', size INTEGER DEFAULT 0, totalChunks INTEGER DEFAULT 0, chunks TEXT DEFAULT \'[]\', phone TEXT DEFAULT \'\', ts INTEGER DEFAULT 0)').run();
    const existing = await env.DB.prepare('SELECT * FROM upload_chunks WHERE uploadId = ?').bind(body.uploadId).first();
    if (existing && existing.phone && existing.phone !== phone) {
      return json({ ok: false, error: 'uploadId 不属于当前用户' }, 403);
    }
    let chunks = existing ? JSON.parse(existing.chunks || '[]') : [];
    chunks[body.index] = body.data;
    if (!existing) {
      await env.DB.prepare('INSERT INTO upload_chunks (uploadId, name, mime, size, totalChunks, chunks, phone, ts) VALUES (?,?,?,?,?,?,?,?)')
        .bind(body.uploadId, body.name || '', body.mime || '', body.size || 0, body.totalChunks || 0, JSON.stringify(chunks), phone, Date.now()).run();
    } else {
      await env.DB.prepare('UPDATE upload_chunks SET chunks = ? WHERE uploadId = ?').bind(JSON.stringify(chunks), body.uploadId).run();
    }
    const got = chunks.filter(Boolean).length;
    return json({ ok: true, received: got, total: body.totalChunks || 0 });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}