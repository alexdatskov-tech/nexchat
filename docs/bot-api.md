# NexChat Bot API

Bots are normal NexChat accounts with a username and password. You make them
in **Profile → Developer**, then run your bot code on any server that can
reach the internet (a VPS, a home machine, a Raspberry Pi).

Developer status is for making bots. It never gives platform admin rank.

Status: **phase 1**. Available now: login, your profile, servers, channels,
messages, friends. Not yet: file uploads, replies, slash commands, buttons,
and custom bot HTML. Those are listed at the end.

---

## 1. Set up the backend (once)

In the Supabase SQL editor, run these in order. Each is safe to re-run.

1. `supabase/join_by_invite.sql`
2. `supabase/profiles_is_bot.sql`
3. `supabase/bots.sql`

Then deploy the function (from the repo root, with the Supabase CLI):

```bash
supabase functions deploy bot-api --no-verify-jwt
```

Your base URL is:

```
https://<project>.supabase.co/functions/v1/bot-api
```

All paths below are relative to it and start with `/v1`.

## 2. Make a developer token and a bot

1. Sign in to NexChat, open **Profile → Developer**.
2. Press **Create developer token** and copy it. It is shown once.
3. Under **Bots**, enter a username (3–24 characters: `a–z`, `0–9`, `_`),
   a display name and a password (10+ characters). Press **Create bot**.

Keep the developer token secret. Anyone with it can create and delete your
bots. Pressing **Create developer token** again replaces the old token.

## 3. Credentials

| Credential | Used for | How to get it |
|---|---|---|
| Developer token `nxdev_…` | Managing bots: create, list, delete | Profile → Developer |
| Bot session (access token) | Everything the bot does in chat | `POST /v1/auth/login` with the bot's username and password |

A developer token cannot send messages. Chat actions always run as the bot,
so the same server permissions apply to it as to any member.

## 4. Endpoints

Errors come back as `{ "error": "message" }` with an HTTP status code.

### Public

| Method & path | Body | Returns |
|---|---|---|
| `POST /v1/auth/login` | `{ username, password }` | `{ access_token, refresh_token, expires_in, user_id }` |

Access tokens expire after about an hour. The SDKs log in again automatically.

### Developer token or developer session: managing bots

| Method & path | Body | Returns |
|---|---|---|
| `GET /v1/dev/status` | | `{ is_developer, has_token, token_created_at, last_used_at }` |
| `POST /v1/dev/token` | | `{ token }`. Session only, not a developer token. Shown once |
| `POST /v1/bots` | `{ username, password, display_name? }` | `{ id, user_id, username }` (201) |
| `GET /v1/bots` | | `{ bots: [...] }` |
| `POST /v1/bots/delete` | `{ bot_id }` | `{ ok: true }` |

Each developer can have up to 10 bots.

### Bot session: chat

| Method & path | Body | Returns |
|---|---|---|
| `GET /v1/me` | | the bot's profile |
| `GET /v1/servers` | | `{ servers: [{ id, name, description }] }` |
| `GET /v1/servers/{serverId}/channels` | | `{ channels: [...] }` |
| `GET /v1/channels/{channelId}/messages?limit=50` | | `{ messages: [{ id, content, created_at, author_id }] }`, newest first. Limit 1–100 |
| `POST /v1/channels/{channelId}/messages` | `{ content }` (1–2000 characters) | `{ id, created_at }` (201) |
| `GET /v1/friends` | | `{ friendships: [...] }` |
| `POST /v1/friends` | `{ username }` | `{ ok: true }` |
| `POST /v1/friends/accept` | `{ user_id }` | `{ ok: true }` |

### Limits

- Bot chat calls: 120 per minute per bot.
- Developer calls: 60 per minute per developer.
- Login: 10 attempts per minute per username.
- Going over returns `429`.

## 5. Quick start

### curl

```bash
BASE=https://<project>.supabase.co/functions/v1/bot-api

TOKEN=$(curl -s -X POST $BASE/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"robo_helper","password":"your-password"}' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

curl -s -X POST $BASE/v1/channels/<channel-id>/messages \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"content":"hello from a script"}'
```

### Node (18+, no dependencies)

Copy `sdk/node/nexchat.js` into your project.

```js
const { Bot } = require('./nexchat');
const bot = await Bot.login({ baseUrl: BASE, username: 'robo_helper', password: '…' });
await bot.send(channelId, 'hello');
```

A complete example that replies `pong` to `!ping` is in `examples/node-echo.js`.

### Python (3.8+, no dependencies)

Copy `sdk/python/nexchat.py`.

```python
from nexchat import Bot
bot = Bot.login(base_url=BASE, username="robo_helper", password="…")
bot.send(channel_id, "hello")
```

### Shell

`sdk/shell/nexchat.sh` needs only `curl`:

```bash
source sdk/shell/nexchat.sh
nx_login "$BASE" robo_helper "$PASSWORD"
nx_send "$BASE" <channel-id> "hello"
```

## 6. Run a bot on a VPS

Any Linux box with Node 18+ or Python 3.8+ works. Keep the password in an
environment file, not in code.

```ini
# /etc/systemd/system/nexchat-bot.service
[Unit]
Description=NexChat bot
After=network-online.target

[Service]
WorkingDirectory=/opt/nexchat-bot
EnvironmentFile=/opt/nexchat-bot/.env
ExecStart=/usr/bin/node examples/node-echo.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`.env` holds `BASE`, `BOT_USER`, `BOT_PASS` and `CHANNEL`. Then:
`sudo systemctl enable --now nexchat-bot`.

## 7. Security notes

- The bot's password is only ever sent to `/v1/auth/login`, over HTTPS.
- Developer tokens are stored as SHA-256 hashes. NexChat cannot show a token
  again after you close the dialog.
- Bots can only read and post where their account has access. They are
  ordinary members, not admins.
- Dev signup does not make you an admin. Platform admin rank is still set by
  the owner.

## 8. Not yet (later phases)

- File uploads from bots.
- Replying to a specific message.
- Slash commands and interactive buttons.
- Custom bot HTML. When it arrives it will run in a sandboxed frame. Outside
  requests go through a proxy that only allows hosts the server admin
  approves. Anything not on the list is blocked.
