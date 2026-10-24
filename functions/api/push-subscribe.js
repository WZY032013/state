// POST /api/push-subscribe 保存推送订阅（VAPID 配置前为占位）
// 安全：必须携带有效登录 token，且订阅归属只认 token 所属手机号，
//      防止未登录写入 / 覆盖他人推送订阅。
export async function onRequest(context) {
  const { request, env } = context;
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  if (request.method !== 'POST') {
    return json({ ok: false }, 405);
  }
  try {
    const body = await request.json().catch(() => ({}));

    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return json({ ok: false, error: '未登录' }, 401);
    const tok = await env.DB.prepare('SELECT * FROM tokens WHERE token = ?').bind(token).first();
    if (!tok || tok.expires < Date.now()) return json({ ok: false, error: '登录已过期' }, 401);
    if (body.phone && body.phone !== tok.phone) return json({ ok: false, error: '身份不匹配' }, 403);

    await env.DB.prepare('CREATE TABLE IF NOT EXISTS push_subs (phone TEXT PRIMARY KEY, subJson TEXT DEFAULT \'\', ts INTEGER DEFAULT 0)').run();
    await env.DB.prepare('INSERT INTO push_subs (phone, subJson, ts) VALUES (?,?,?) ON CONFLICT(phone) DO UPDATE SET subJson = excluded.subJson, ts = excluded.ts')
      .bind(tok.phone, JSON.stringify(body.sub || {}), Date.now()).run();
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}