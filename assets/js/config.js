// =============================================================================
// NEXCHAT CONFIG
// Get these from: Supabase Dashboard -> Settings -> API
// Both values below are DESIGNED to be public/client-side. Never put the
// service_role key or DB password here or in any file that ships to the browser.
// =============================================================================
window.NEXCHAT_CONFIG = {
  SUPABASE_URL: 'https://xqzibelnvjlmavgrpyve.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxemliZWxudmpsbWF2Z3JweXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNjg5NjYsImV4cCI6MjEwMjY0NDk2Nn0.kW3xwbSvlaSnhU_eGSjIR8E2HzdxtYvBRxy4wbJ_Xgo',

  // File signing. Leave empty to use the legacy in-browser signer. Once the
  // `nexchat-storage` Edge Function is deployed (see supabase/README.md), set:
  //   STORAGE_ENDPOINT: 'https://xqzibelnvjlmavgrpyve.supabase.co/functions/v1/nexchat-storage',
  STORAGE_ENDPOINT: '',
  // CloudGate on Wasmer: where every NEW upload goes (chat files, avatars,
  // icons, wallpapers, and each user's encrypted drive). Old iDrive e2 links
  // already in the database keep working through the signer above.
  // This login ships to every browser, so treat the bucket as readable by
  // anyone who looks; private drive files are encrypted before upload.
  CLOUDGATE: {
    // Tried in order. If one can't be reached (or answers 5xx), the next one
    // takes over. Every endpoint must run the same CloudGate API, with the
    // same login and category. The fallback is a placeholder: point it at a
    // second deployment of cloudgate-wasmer when you have one.
    endpoints: [
      { name: 'wasmer', endpoint: 'https://alexd-us1-s3.wasmer.app' },
      { name: 'fallback', endpoint: 'https://cloudgate-fallback.placeholder.invalid' },
    ],
    user: 'admin',
    pass: 'admin!',
    category: 'nexchats-us1',
    cdn: 'd1dncmkdpaif79.cloudfront.net',
    // Default My Drive size for a user with no quota of their own yet. Admins
    // change it per user (Admin -> Users, or Storage requests).
    driveQuotaGB: 5,
    // Largest single file in My Drive, in GB.
    driveMaxFileGB: 5,
  },
  // TURN relays (optional). Only used when two people can't connect directly
  // (strict NAT / school & office networks). A free public relay is the
  // fallback; your own TURN (e.g. a free Metered or Cloudflare TURN key) is
  // far faster. Format: [{ urls: 'turn:host:3478', username: '...', credential: '...' }]
  TURN_SERVERS: null,
};
