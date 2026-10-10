# Backend setup

## 1. Announcements (required for the megaphone / Home feed)

Open Supabase → **SQL editor**, paste `announcements.sql`, run it. It is safe
to re-run. The last statement prints two `true` columns when it worked.

Until it has been run, the app simply hides announcements; the Admin page
shows a reminder in its Announcements tab.

## 2. Roles, platform tools and the private drive (required for Owner / Sudo Admin and My Drive)

Paste `roles_and_powers.sql` into the SQL editor and run it (safe to re-run).
It makes **alexd** the one and only Owner, keeps existing admins as Admins,
and adds:

| | Owner | Sudo Admin | Admin |
|---|---|---|---|
| Ban regular users | yes | yes | yes |
| Ban admins | yes | yes | no |
| Ban sudo admins | yes | no | no |
| Ban the owner | - | no | no |
| Give/remove Admin | yes | yes | no |
| Give/remove Sudo Admin | yes | no | no |
| See every server + who is in it, read & post without joining | yes | yes | no |
| Set a user's password (signs them out everywhere) | yes | yes (not the owner) | no |
| Delete accounts | yes | yes (not the owner) | no |

The rule underneath all of it: you can only act on people ranked **below**
you. The database enforces this; the buttons in the admin panel just follow
it. Existing passwords can never be viewed (Supabase stores only a one-way
hash), DMs stay private, and nobody can read another user's drive key.

The final query prints the owner's username and `true` for each part.

## 2b. Drive storage quotas and storage requests

Paste `storage_quota.sql` into the SQL editor and run it, after `roles_and_powers.sql`
and the `roles_v2` parts (it uses their `nx_rank`, `nx_can` and `nx_audit`). Safe to re-run.

It adds:

- `profiles.drive_quota_gb` (default 5). Only staff can change it; the database
  refuses changes from anyone else, so nobody can raise their own quota.
- The **Manage drive storage** permission, which the Owner tab can switch per role
  (Sudo Admin and Admin have it by default).
- `storage_requests`: users ask for more space from My Drive, staff approve or decline
  from **Admin -> Storage requests**. Approving sets the new size straight away.
- `admin_set_drive_quota()` for setting a size directly from a user's drawer in the admin panel.

Uploads are checked against the quota in the browser before they are encrypted and
sent. That check is a convenience: the bucket itself is not quota-enforced.

## 3. CloudGate storage (where new uploads go)

`assets/js/config.js -> CLOUDGATE` points at the Wasmer CloudGate app. Endpoints are tried
in order (`endpoints`): if the Wasmer app can't be reached or answers 5xx, the next one takes
over. The second entry is a placeholder; point it at another deployment of the same
CloudGate API. All new uploads land in the `nexchats-us1` category:

- `attachments/...` - chat files, avatars, icons, wallpapers (permanent
  CloudFront links, nothing expires)
- `vault/<user id>/...` - each user's **My Drive**, encrypted in the browser
  (AES-256-GCM, file names included) with a per-user key from
  `user_vault_keys`

Old iDrive e2 links already in the database keep working through the signer
below. The CloudGate login in `config.js` is public like the rest of the site,
so treat the bucket as listable by anyone; that is why drive files are
encrypted before upload. To hide the login, proxy the CloudGate API through a
Supabase Edge Function the same way as the signer below.

## 4. File storage signer (for the old iDrive e2 links)

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
