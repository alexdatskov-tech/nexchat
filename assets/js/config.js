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
  // TURN relays (optional). Only used when two people can't connect directly
  // (strict NAT / school & office networks). A free public relay is the
  // fallback; your own TURN (e.g. a free Metered or Cloudflare TURN key) is
  // far faster. Format: [{ urls: 'turn:host:3478', username: '...', credential: '...' }]
  TURN_SERVERS: null,
};
