// Example bot: replies "pong" to "!ping" in one channel.
// Run:  BASE=https://<project>.supabase.co/functions/v1/bot-api \
//       BOT_USER=robo_helper BOT_PASS=... CHANNEL=<channel-id> node node-echo.js
const { Bot } = require('../sdk/node/nexchat');

(async () => {
  const { BASE, BOT_USER, BOT_PASS, CHANNEL } = process.env;
  const bot = await Bot.login({ baseUrl: BASE, username: BOT_USER, password: BOT_PASS });
  let seen = new Set();
  let first = true;
  console.log('logged in as', bot.userId);
  for (;;) {
    try {
      const msgs = await bot.messages(CHANNEL, { limit: 30 });
      for (const m of msgs.reverse()) {       // oldest first
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!first && m.author_id !== bot.userId && m.content.trim() === '!ping') {
          await bot.send(CHANNEL, 'pong');
        }
      }
      first = false;
      if (seen.size > 500) seen = new Set([...seen].slice(-200));
    } catch (e) {
      console.error('poll failed:', e.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
})();
