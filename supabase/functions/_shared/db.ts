// Service-role Supabase client for edge functions.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
  }
  return client;
}

export function flag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((Deno.env.get(name) ?? "").toLowerCase());
}
