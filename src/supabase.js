import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ynvuqkxigszejzuipxkz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InludnVxa3hpZ3N6ZWp6dWlweGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2OTIzOTIsImV4cCI6MjA4OTI2ODM5Mn0.5oBq2ifrKTlgbg_pusVB58Gb9B06D-Ld2MyHO9Qk-3A';

// Every Supabase request — auth token refresh, DB queries, realtime auth —
// goes through this fetch wrapper. If any individual request hangs for more
// than 10 seconds it is aborted, so the app can never get stuck indefinitely.
function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: fetchWithTimeout },
});
