import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Store the client on globalThis so Vite HMR re-executions of this module
// reuse the same instance instead of creating a new one that fights for the
// same Web Lock used by Supabase's auth token refresh.
if (!globalThis.__nw_supabase) {
    globalThis.__nw_supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export const supabase = globalThis.__nw_supabase;
