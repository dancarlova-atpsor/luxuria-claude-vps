import { createClient } from '@supabase/supabase-js';

let client = null;

export function supabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY lipsesc');
  client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return client;
}

export async function getBug(bugId) {
  const { data, error } = await supabase()
    .from('bug_reports')
    .select('*')
    .eq('id', bugId)
    .maybeSingle();
  if (error) throw new Error(`getBug failed: ${error.message}`);
  return data;
}

export async function updateBugStatus(bugId, status, extraMeta = {}) {
  const { data: cur } = await supabase()
    .from('bug_reports')
    .select('metadata')
    .eq('id', bugId)
    .maybeSingle();
  const newMeta = { ...(cur?.metadata ?? {}), ...extraMeta };
  const { error } = await supabase()
    .from('bug_reports')
    .update({ status, metadata: newMeta, updated_at: new Date().toISOString() })
    .eq('id', bugId);
  if (error) throw new Error(`updateBugStatus failed: ${error.message}`);
}
