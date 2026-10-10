// NexChat bot SDK for Node 18+. No dependencies.
//
//   const { Bot } = require('./nexchat');
//   const bot = await Bot.login({ baseUrl: BASE, username: 'robo_helper', password: '...' });
//   await bot.send(channelId, 'hello');
//
// BASE is the bot-api function URL, e.g. https://<project>.supabase.co/functions/v1/bot-api

class NexChatError extends Error {
  constructor(status, message) { super(message); this.name = 'NexChatError'; this.status = status; }
}

async function call(baseUrl, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new NexChatError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

class Bot {
  constructor({ baseUrl, accessToken, userId, credentials }) {
    this.baseUrl = baseUrl; this.token = accessToken; this.userId = userId; this._creds = credentials;
  }

  // Log in with the bot's username and password.
  static async login({ baseUrl, username, password }) {
    const s = await call(baseUrl, '/v1/auth/login', { method: 'POST', body: { username, password } });
    return new Bot({ baseUrl, accessToken: s.access_token, userId: s.user_id, credentials: { username, password } });
  }

  // Every call runs through here. On 401 (token expired) it logs in again once.
  async req(method, path, body, retried = false) {
    try {
      return await call(this.baseUrl, path, { method, token: this.token, body });
    } catch (e) {
      if (e.status === 401 && !retried && this._creds) {
        const fresh = await Bot.login({ baseUrl: this.baseUrl, ...this._creds });
        this.token = fresh.token; this.userId = fresh.userId;
        return this.req(method, path, body, true);
      }
      throw e;
    }
  }

  me() { return this.req('GET', '/v1/me'); }
  servers() { return this.req('GET', '/v1/servers').then((r) => r.servers); }
  channels(serverId) { return this.req('GET', `/v1/servers/${serverId}/channels`).then((r) => r.channels); }
  messages(channelId, { limit = 50 } = {}) { return this.req('GET', `/v1/channels/${channelId}/messages?limit=${limit}`).then((r) => r.messages); }
  send(channelId, content) { return this.req('POST', `/v1/channels/${channelId}/messages`, { content }); }
  friends() { return this.req('GET', '/v1/friends').then((r) => r.friendships); }
  addFriend(username) { return this.req('POST', '/v1/friends', { username }); }
  acceptFriend(userId) { return this.req('POST', '/v1/friends/accept', { user_id: userId }); }
}

// Developer tools: manage your bots with a developer token (nxdev_...).
class Developer {
  constructor({ baseUrl, token }) { this.baseUrl = baseUrl; this.token = token; }
  status() { return call(this.baseUrl, '/v1/dev/status', { token: this.token }); }
  bots() { return call(this.baseUrl, '/v1/bots', { token: this.token }).then((r) => r.bots); }
  createBot({ username, password, displayName }) {
    return call(this.baseUrl, '/v1/bots', { method: 'POST', token: this.token, body: { username, password, display_name: displayName } });
  }
  deleteBot(botId) { return call(this.baseUrl, '/v1/bots/delete', { method: 'POST', token: this.token, body: { bot_id: botId } }); }
}

module.exports = { Bot, Developer, NexChatError };
