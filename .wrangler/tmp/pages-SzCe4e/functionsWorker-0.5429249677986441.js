var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/[[path]].js
var ADMIN_PHONE = "13385387338";
var MSG_TTL = 30 * 24 * 60 * 60 * 1e3;
var MAX_MSGS = 500;
var TOKEN_TTL = 60 * 60 * 24 * 30;
var PRESENCE_TTL = 60;
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
function ok(data) {
  return json({ ok: true, ...data });
}
__name(ok, "ok");
function fail(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}
__name(fail, "fail");
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyData = await crypto.subtle.digest("SHA-256", enc.encode(password + ":" + salt));
  return btoa(String.fromCharCode(...new Uint8Array(keyData)));
}
__name(hashPassword, "hashPassword");
function makeSalt() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
__name(makeSalt, "makeSalt");
function makeToken() {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
}
__name(makeToken, "makeToken");
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
__name(makeId, "makeId");
async function getUser(env, phone) {
  return await env.STATING.get("user:" + phone, "json");
}
__name(getUser, "getUser");
async function saveUser(env, user) {
  await env.STATING.put("user:" + user.phone, JSON.stringify(user));
  const idx = await getUserIndex(env);
  if (!idx.includes(user.phone)) {
    idx.push(user.phone);
    await env.STATING.put("user_index", JSON.stringify(idx));
  }
}
__name(saveUser, "saveUser");
async function getUserIndex(env) {
  return await env.STATING.get("user_index", "json") || [];
}
__name(getUserIndex, "getUserIndex");
async function getGroup(env, code) {
  return await env.STATING.get("group:" + code.toUpperCase(), "json");
}
__name(getGroup, "getGroup");
async function saveGroup(env, group) {
  await env.STATING.put("group:" + group.code.toUpperCase(), JSON.stringify(group));
  const idx = await getGroupIndex(env);
  if (!idx.includes(group.code.toUpperCase())) {
    idx.push(group.code.toUpperCase());
    await env.STATING.put("group_index", JSON.stringify(idx));
  }
}
__name(saveGroup, "saveGroup");
async function deleteGroupKV(env, code) {
  code = code.toUpperCase();
  await env.STATING.delete("group:" + code);
  await env.STATING.delete("msgs:" + code);
  await env.STATING.delete("presence_g:" + code);
  const idx = await getGroupIndex(env);
  const i = idx.indexOf(code);
  if (i >= 0) {
    idx.splice(i, 1);
    await env.STATING.put("group_index", JSON.stringify(idx));
  }
}
__name(deleteGroupKV, "deleteGroupKV");
async function getGroupIndex(env) {
  return await env.STATING.get("group_index", "json") || [];
}
__name(getGroupIndex, "getGroupIndex");
async function getMessages(env, code) {
  code = code.toUpperCase();
  let msgs = await env.STATING.get("msgs:" + code, "json") || [];
  const cutoff = Date.now() - MSG_TTL;
  const before = msgs.length;
  msgs = msgs.filter((m) => m.ts > cutoff);
  if (msgs.length !== before) {
    await env.STATING.put("msgs:" + code, JSON.stringify(msgs));
  }
  return msgs;
}
__name(getMessages, "getMessages");
async function addMessage(env, code, msg) {
  code = code.toUpperCase();
  let msgs = await getMessages(env, code);
  msgs.push(msg);
  if (msgs.length > MAX_MSGS) msgs = msgs.slice(-MAX_MSGS);
  await env.STATING.put("msgs:" + code, JSON.stringify(msgs));
}
__name(addMessage, "addMessage");
async function clearMessages(env, code) {
  await env.STATING.put("msgs:" + code.toUpperCase(), JSON.stringify([]));
}
__name(clearMessages, "clearMessages");
async function getGroupPresence(env, code) {
  return await env.STATING.get("presence_g:" + code.toUpperCase(), "json") || {};
}
__name(getGroupPresence, "getGroupPresence");
async function updateGroupPresence(env, code, phone, info) {
  code = code.toUpperCase();
  const p = await getGroupPresence(env, code);
  p[phone] = { ...info, lastSeen: Date.now() };
  await env.STATING.put("presence_g:" + code, JSON.stringify(p), { expirationTtl: PRESENCE_TTL });
  return p;
}
__name(updateGroupPresence, "updateGroupPresence");
async function removeGroupPresence(env, code, phone) {
  code = code.toUpperCase();
  const p = await getGroupPresence(env, code);
  delete p[phone];
  await env.STATING.put("presence_g:" + code, JSON.stringify(p), { expirationTtl: PRESENCE_TTL });
}
__name(removeGroupPresence, "removeGroupPresence");
async function getGlobalPresence(env) {
  const phones = await getUserIndex(env);
  const result = {};
  for (const phone of phones) {
    const data = await env.STATING.get("presence_u:" + phone, "json");
    if (data) result[phone] = data;
  }
  return result;
}
__name(getGlobalPresence, "getGlobalPresence");
async function updateGlobalPresence(env, phone, info) {
  await env.STATING.put("presence_u:" + phone, JSON.stringify({ ...info, lastSeen: Date.now() }), { expirationTtl: PRESENCE_TTL });
}
__name(updateGlobalPresence, "updateGlobalPresence");
async function authUser(env, request) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const data = await env.STATING.get("token:" + token, "json");
  if (!data) return null;
  if (data.expires < Date.now()) {
    await env.STATING.delete("token:" + token);
    return null;
  }
  const user = await getUser(env, data.phone);
  if (!user) return null;
  return user;
}
__name(authUser, "authUser");
async function createToken(env, phone) {
  const token = makeToken();
  const expires = Date.now() + TOKEN_TTL * 1e3;
  await env.STATING.put("token:" + token, JSON.stringify({ phone, expires }), { expirationTtl: TOKEN_TTL });
  return token;
}
__name(createToken, "createToken");
function publicUser(u) {
  if (!u) return null;
  return {
    phone: u.phone,
    nickname: u.nickname,
    avatar: u.avatar,
    email: u.email || "\u65E0",
    isAdmin: u.phone === ADMIN_PHONE,
    createdAt: u.createdAt,
    joinedGroups: u.joinedGroups || []
  };
}
__name(publicUser, "publicUser");
async function handleRegister(env, body) {
  const { phone, password, nickname, avatar, email } = body;
  if (!phone || !password || !nickname) return fail("\u8BF7\u586B\u5199\u5B8C\u6574\u4FE1\u606F");
  if (!/^\d{6,15}$/.test(phone)) return fail("\u624B\u673A\u53F7\u683C\u5F0F\u4E0D\u6B63\u786E");
  if (password.length < 4) return fail("\u5BC6\u7801\u81F3\u5C114\u4F4D");
  const existing = await getUser(env, phone);
  if (existing) return fail("\u8BE5\u624B\u673A\u53F7\u5DF2\u6CE8\u518C\uFF0C\u8BF7\u76F4\u63A5\u767B\u5F55");
  const salt = makeSalt();
  const passHash = await hashPassword(password, salt);
  const user = {
    phone,
    nickname,
    avatar: avatar || "\u{1F600}",
    email: email || "\u65E0",
    passHash,
    passSalt: salt,
    joinedGroups: [],
    createdAt: Date.now()
  };
  await saveUser(env, user);
  const token = await createToken(env, phone);
  return ok({ token, user: publicUser(user) });
}
__name(handleRegister, "handleRegister");
async function handleLogin(env, body) {
  const { phone, password } = body;
  if (!phone || !password) return fail("\u8BF7\u8F93\u5165\u624B\u673A\u53F7\u548C\u5BC6\u7801");
  const user = await getUser(env, phone);
  if (!user) return fail("\u8BE5\u624B\u673A\u53F7\u672A\u6CE8\u518C");
  const passHash = await hashPassword(password, user.passSalt);
  if (passHash !== user.passHash) return fail("\u5BC6\u7801\u9519\u8BEF");
  const token = await createToken(env, phone);
  return ok({ token, user: publicUser(user) });
}
__name(handleLogin, "handleLogin");
async function handleUsers(env) {
  const phones = await getUserIndex(env);
  const users = [];
  const presence = await getGlobalPresence(env);
  for (const phone of phones) {
    const u = await getUser(env, phone);
    if (u) {
      const p = presence[phone];
      users.push({
        ...publicUser(u),
        online: !!(p && Date.now() - p.lastSeen < 15e3),
        lastSeen: p ? p.lastSeen : u.createdAt
      });
    }
  }
  users.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  return ok({ users });
}
__name(handleUsers, "handleUsers");
async function handleCreateGroup(env, user, body) {
  const { code, name, avatar } = body;
  if (!code || !name) return fail("\u8BF7\u586B\u5199\u7FA4\u804A\u540D\u79F0\u548C\u9080\u8BF7\u7801");
  if (!/^[A-Za-z0-9]{6}$/.test(code)) return fail("\u9080\u8BF7\u7801\u5FC5\u987B\u662F6\u4F4D\u5B57\u6BCD\u6216\u6570\u5B57");
  const upperCode = code.toUpperCase();
  const existing = await getGroup(env, upperCode);
  if (existing) return fail("\u8BE5\u9080\u8BF7\u7801\u5DF2\u88AB\u4F7F\u7528");
  const group = {
    code: upperCode,
    name,
    avatar: avatar || "\u{1F4AC}",
    createdBy: user.phone,
    owner: user.phone,
    members: [user.phone],
    createdAt: Date.now()
  };
  await saveGroup(env, group);
  if (!user.joinedGroups.includes(upperCode)) {
    user.joinedGroups.push(upperCode);
    await saveUser(env, user);
  }
  return ok({ group });
}
__name(handleCreateGroup, "handleCreateGroup");
async function handleJoinGroup(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail("\u7FA4\u804A\u4E0D\u5B58\u5728");
  if (!group.members.includes(user.phone)) {
    group.members.push(user.phone);
    await saveGroup(env, group);
  }
  if (!user.joinedGroups.includes(code)) {
    user.joinedGroups.push(code);
    await saveUser(env, user);
  }
  return ok({ group });
}
__name(handleJoinGroup, "handleJoinGroup");
async function handleLeaveGroup(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail("\u7FA4\u804A\u4E0D\u5B58\u5728");
  if (group.owner === user.phone) return fail("\u7FA4\u4E3B\u4E0D\u80FD\u9000\u51FA\u7FA4\u804A\uFF0C\u8BF7\u6CE8\u9500\u7FA4\u804A");
  group.members = group.members.filter((p) => p !== user.phone);
  await saveGroup(env, group);
  user.joinedGroups = (user.joinedGroups || []).filter((c) => c !== code);
  await saveUser(env, user);
  await removeGroupPresence(env, code, user.phone);
  return ok({});
}
__name(handleLeaveGroup, "handleLeaveGroup");
async function handleDeleteGroup(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail("\u7FA4\u804A\u4E0D\u5B58\u5728");
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) {
    return fail("\u53EA\u6709\u7FA4\u4E3B\u6216\u7BA1\u7406\u5458\u53EF\u4EE5\u6CE8\u9500\u7FA4\u804A");
  }
  for (const phone of group.members) {
    const u = await getUser(env, phone);
    if (u) {
      u.joinedGroups = (u.joinedGroups || []).filter((c) => c !== code);
      await saveUser(env, u);
    }
  }
  await deleteGroupKV(env, code);
  return ok({});
}
__name(handleDeleteGroup, "handleDeleteGroup");
async function handleGetGroup(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail("\u7FA4\u804A\u4E0D\u5B58\u5728");
  const msgs = await getMessages(env, code);
  const presence = await getGroupPresence(env, code);
  const onlineMembers = {};
  for (const [phone, info] of Object.entries(presence)) {
    if (Date.now() - info.lastSeen < 15e3) onlineMembers[phone] = info;
  }
  return ok({
    group: { ...group, isOwner: group.owner === user.phone, isMember: group.members.includes(user.phone) },
    messages: msgs,
    onlineMembers,
    isAdmin: user.phone === ADMIN_PHONE
  });
}
__name(handleGetGroup, "handleGetGroup");
async function handleSendMessage(env, user, code, body) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail("\u7FA4\u804A\u4E0D\u5B58\u5728");
  if (!group.members.includes(user.phone)) return fail("\u4F60\u4E0D\u662F\u7FA4\u6210\u5458");
  const { text, type, imageData } = body;
  if (!text && !imageData) return fail("\u6D88\u606F\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
  const msg = {
    id: makeId(),
    senderPhone: user.phone,
    senderNickname: user.nickname,
    senderAvatar: user.avatar,
    text: text || "",
    type: type || "text",
    imageData: imageData || null,
    ts: Date.now()
  };
  await addMessage(env, code, msg);
  return ok({ message: msg });
}
__name(handleSendMessage, "handleSendMessage");
async function handleClearMessages(env, user, code) {
  code = code.toUpperCase();
  const group = await getGroup(env, code);
  if (!group) return fail("\u7FA4\u804A\u4E0D\u5B58\u5728");
  if (group.owner !== user.phone && user.phone !== ADMIN_PHONE) {
    return fail("\u53EA\u6709\u7FA4\u4E3B\u6216\u7BA1\u7406\u5458\u53EF\u4EE5\u6E05\u7A7A\u6D88\u606F");
  }
  await clearMessages(env, code);
  return ok({});
}
__name(handleClearMessages, "handleClearMessages");
async function handleMyGroups(env, user) {
  const groups = [];
  for (const code of user.joinedGroups || []) {
    const g = await getGroup(env, code);
    if (g) {
      const msgs = await getMessages(env, code);
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      groups.push({
        code: g.code,
        name: g.name,
        avatar: g.avatar,
        owner: g.owner,
        isOwner: g.owner === user.phone,
        memberCount: g.members.length,
        lastMsgTs: lastMsg ? lastMsg.ts : g.createdAt
      });
    }
  }
  return ok({ groups });
}
__name(handleMyGroups, "handleMyGroups");
async function handleAdminUserGroups(env, user, targetPhone) {
  if (user.phone !== ADMIN_PHONE) return fail("\u65E0\u6743\u9650", 403);
  const target = await getUser(env, targetPhone);
  if (!target) return fail("\u7528\u6237\u4E0D\u5B58\u5728");
  const groups = [];
  for (const code of target.joinedGroups || []) {
    const g = await getGroup(env, code);
    if (g) {
      const msgs = await getMessages(env, code);
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      groups.push({
        code: g.code,
        name: g.name,
        avatar: g.avatar,
        owner: g.owner,
        createdBy: g.createdBy,
        msgCount: msgs.length,
        lastMsgTs: lastMsg ? lastMsg.ts : g.createdAt
      });
    }
  }
  return ok({ user: publicUser(target), groups });
}
__name(handleAdminUserGroups, "handleAdminUserGroups");
async function handleBeat(env, user, code) {
  await updateGlobalPresence(env, user.phone, {
    nickname: user.nickname,
    avatar: user.avatar
  });
  if (code) {
    const group = await getGroup(env, code);
    if (group && group.members.includes(user.phone)) {
      await updateGroupPresence(env, code, user.phone, {
        nickname: user.nickname,
        avatar: user.avatar
      });
    }
  }
  return ok({});
}
__name(handleBeat, "handleBeat");
async function handleDeleteAccount(env, user) {
  const phone = user.phone;
  for (const code of user.joinedGroups || []) {
    const g = await getGroup(env, code);
    if (g) {
      if (g.owner === phone) {
        for (const m of g.members) {
          if (m !== phone) {
            const u = await getUser(env, m);
            if (u) {
              u.joinedGroups = (u.joinedGroups || []).filter((c) => c !== code);
              await saveUser(env, u);
            }
          }
        }
        await deleteGroupKV(env, code);
      } else {
        g.members = g.members.filter((p) => p !== phone);
        await saveGroup(env, g);
      }
    }
  }
  await env.STATING.delete("user:" + phone);
  await env.STATING.delete("presence_u:" + phone);
  const idx = await getUserIndex(env);
  const i = idx.indexOf(phone);
  if (i >= 0) {
    idx.splice(i, 1);
    await env.STATING.put("user_index", JSON.stringify(idx));
  }
  return ok({});
}
__name(handleDeleteAccount, "handleDeleteAccount");
async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method;
  if (parts[0] === "register" && method === "POST") {
    return handleRegister(env, await request.json());
  }
  if (parts[0] === "login" && method === "POST") {
    return handleLogin(env, await request.json());
  }
  const user = await authUser(env, request);
  if (!user) return fail("\u672A\u767B\u5F55\u6216\u767B\u5F55\u5DF2\u8FC7\u671F", 401);
  try {
    if (parts[0] === "me" && method === "GET") {
      return ok({ user: publicUser(user) });
    }
    if (parts[0] === "beat" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      return handleBeat(env, user, body.code || null);
    }
    if (parts[0] === "users" && method === "GET") {
      return handleUsers(env);
    }
    if (parts[0] === "my-groups" && method === "GET") {
      return handleMyGroups(env, user);
    }
    if (parts[0] === "groups" && parts.length === 1 && method === "POST") {
      return handleCreateGroup(env, user, await request.json());
    }
    if (parts[0] === "groups" && parts.length === 1 && method === "GET") {
      const codes = await getGroupIndex(env);
      const groups = [];
      for (const code of codes) {
        const g = await getGroup(env, code);
        if (g) groups.push({ code: g.code, name: g.name, avatar: g.avatar, memberCount: g.members.length });
      }
      return ok({ groups });
    }
    if (parts[0] === "groups" && parts[1]) {
      const code = parts[1];
      if (parts.length === 2 && method === "GET") {
        return handleGetGroup(env, user, code);
      }
      if (parts[2] === "join" && method === "POST") {
        return handleJoinGroup(env, user, code);
      }
      if (parts[2] === "leave" && method === "POST") {
        return handleLeaveGroup(env, user, code);
      }
      if (parts.length === 2 && method === "DELETE") {
        return handleDeleteGroup(env, user, code);
      }
      if (parts[2] === "messages" && parts.length === 3 && method === "GET") {
        const result = await handleGetGroup(env, user, code);
        return result;
      }
      if (parts[2] === "messages" && parts.length === 3 && method === "POST") {
        return handleSendMessage(env, user, code, await request.json());
      }
      if (parts[2] === "messages" && parts[3] === "clear" && method === "POST") {
        return handleClearMessages(env, user, code);
      }
    }
    if (parts[0] === "admin" && parts[1] === "users" && parts[3] === "groups" && method === "GET") {
      return handleAdminUserGroups(env, user, parts[2]);
    }
    if (parts[0] === "delete-account" && method === "POST") {
      return handleDeleteAccount(env, user);
    }
    return fail("\u672A\u77E5\u7684API\u8DEF\u5F84: " + url.pathname, 404);
  } catch (e) {
    return fail("\u670D\u52A1\u5668\u9519\u8BEF: " + e.message, 500);
  }
}
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-SzCe4e/functionsRoutes-0.8212569702649892.mjs
var routes = [
  {
    routePath: "/api/:path*",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
