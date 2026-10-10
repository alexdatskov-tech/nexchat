"""NexChat bot SDK for Python 3.8+. Standard library only.

    from nexchat import Bot
    bot = Bot.login(base_url=BASE, username="robo_helper", password="...")
    bot.send(channel_id, "hello")

BASE is the bot-api function URL, e.g. https://<project>.supabase.co/functions/v1/bot-api
"""
import json
import urllib.error
import urllib.request


class NexChatError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _call(base_url, path, method="GET", token=None, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error")
        except Exception:
            msg = None
        raise NexChatError(e.code, msg or f"Request failed ({e.code})")


class Bot:
    def __init__(self, base_url, access_token, user_id, credentials):
        self.base_url = base_url
        self.token = access_token
        self.user_id = user_id
        self._creds = credentials

    @classmethod
    def login(cls, base_url, username, password):
        s = _call(base_url, "/v1/auth/login", "POST", body={"username": username, "password": password})
        return cls(base_url, s["access_token"], s["user_id"], (username, password))

    def _req(self, method, path, body=None, retried=False):
        try:
            return _call(self.base_url, path, method, self.token, body)
        except NexChatError as e:
            if e.status == 401 and not retried and self._creds:
                fresh = Bot.login(self.base_url, *self._creds)
                self.token, self.user_id = fresh.token, fresh.user_id
                return self._req(method, path, body, retried=True)
            raise

    def me(self):
        return self._req("GET", "/v1/me")

    def servers(self):
        return self._req("GET", "/v1/servers")["servers"]

    def channels(self, server_id):
        return self._req("GET", f"/v1/servers/{server_id}/channels")["channels"]

    def messages(self, channel_id, limit=50):
        return self._req("GET", f"/v1/channels/{channel_id}/messages?limit={limit}")["messages"]

    def send(self, channel_id, content):
        return self._req("POST", f"/v1/channels/{channel_id}/messages", {"content": content})

    def friends(self):
        return self._req("GET", "/v1/friends")["friendships"]

    def add_friend(self, username):
        return self._req("POST", "/v1/friends", {"username": username})

    def accept_friend(self, user_id):
        return self._req("POST", "/v1/friends/accept", {"user_id": user_id})


class Developer:
    """Manage bots with a developer token (nxdev_...)."""

    def __init__(self, base_url, token):
        self.base_url = base_url
        self.token = token

    def status(self):
        return _call(self.base_url, "/v1/dev/status", token=self.token)

    def bots(self):
        return _call(self.base_url, "/v1/bots", token=self.token)["bots"]

    def create_bot(self, username, password, display_name=""):
        return _call(self.base_url, "/v1/bots", "POST", self.token,
                     {"username": username, "password": password, "display_name": display_name})

    def delete_bot(self, bot_id):
        return _call(self.base_url, "/v1/bots/delete", "POST", self.token, {"bot_id": bot_id})
