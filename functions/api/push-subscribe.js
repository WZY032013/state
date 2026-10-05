// POST /api/push-subscribe 保存推送订阅（VAPID 配置前为占位）
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false }), { status: 405, headers: { 'content-type': 'application/json' } });
  }
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS push_subs (phone TEXT PRIMARY KEY, subJson TEXT DEFAULT \'\', ts INTEGER DEFAULT 0)').run();
    const body = await request.json().catch(() => ({}));
    if (body.phone) {
      await env.DB.prepare('INSERT INTO push_subs (phone, subJson, ts) VALUES (?,?,?) ON CONFLICT(phone) DO UPDATE SET subJson = excluded.subJson, ts = excluded.ts')
        .bind(body.phone, JSON.stringify(body.sub || {}), Date.now()).run();
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message || err) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
