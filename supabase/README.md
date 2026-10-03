# Backend setup

## 1. Announcements (required for the megaphone / Home feed)

Open Supabase → **SQL editor**, paste `announcements.sql`, run it. It is safe
to re-run. The last statement prints two `true` columns when it worked.

Until it has been run, the app simply hides announcements; the Admin page
shows a reminder in its Announcements tab.

## 2. File storage signer (strongly recommended)

Attachments live in an iDrive e2 bucket. Today the bucket's access key and
**secret key** are embedded in
`assets/js/vendor/core/runtime/net/xhr-transport-polyfill.min.js` (only
base64-encoded), which ships to every visitor. Anyone can extract them and
read, overwrite or delete every file in the bucket.

`functions/nexchat-storage` moves signing to the server:

```bash
supabase login
supabase link --project-ref xqzibelnvjlmavgrpyve
supabase secrets set S3_HOST=s3.us-west-4.idrivee2.com S3_REGION=us-west-4 \
  S3_BUCKET=robo-test S3_ACCESS_KEY=<NEW access key> S3_SECRET_KEY=<NEW secret key>
supabase functions deploy nexchat-storage
```

Then:

1. In `assets/js/config.js` set
   `STORAGE_ENDPOINT: 'https://xqzibelnvjlmavgrpyve.supabase.co/functions/v1/nexchat-storage'`.
2. Remove the polyfill `<script>` tag from the HTML pages and delete the file.
3. **Rotate the iDrive keys** (create a new access key in the iDrive e2
   console, use it in step `secrets set`, delete the old one). The old key is
   in this public repository's git history, so it must be treated as leaked
   no matter what.

The function checks the signed-in user: DM files are only signed for
participants of that DM, server files for members of that server.

## 3. TURN relay (optional, makes calls work on strict networks)

Calls connect peer-to-peer. On some networks (schools, offices, some mobile
carriers) that is impossible and traffic has to go through a TURN relay. The
app falls back to a free public relay, which is shared and throttled — a call
forced through it is slow. A free TURN key from Metered or Cloudflare is far
better; put it in `assets/js/config.js`:

```js
TURN_SERVERS: [
  { urls: ['turn:<host>:3478', 'turns:<host>:5349'], username: '<user>', credential: '<pass>' },
],
```

The in-call **Connection** panel (signal icon) tells you whether a call is
direct or relayed.
