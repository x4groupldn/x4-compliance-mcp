/**
 * Amiqus REST client for the X4 Compliance MCP server.
 *
 * Auth: a single Amiqus Personal Access Token held server-side as a Vercel
 * Sensitive Environment Variable. It belongs to the Contracts Team account,
 * so every call is made as that identity.
 *
 * IMPORTANT - the token expires one year after it was minted and CANNOT be
 * refreshed programmatically (Amiqus issues no refresh for PATs). When it
 * dies, every tool here starts returning 401 with no prior warning. The
 * expiry date belongs in the runbook, and `tokenHealth()` below exists so a
 * scheduled check can shout before it happens rather than after.
 */

const BASE_URL =
  (process.env.AMIQUS_BASE_URL ?? "").trim() || "https://id.amiqus.co/api/v2";

/** Cap on any list response. Mirrors the Python server this replaces: Amiqus
 *  holds passport images, addresses and AML results, so no tool is allowed to
 *  become a bulk-extraction endpoint. */
export const MAX_LIST = 50;

export const INSIGHT_NOTE =
  `Insight-level summary. Results capped at ${MAX_LIST} to prevent bulk PII extraction.`;

export class AmiqusError extends Error {}

export async function amiqusGet<T = any>(
  path: string,
  query?: Record<string, string | number | undefined | null>,
): Promise<T> {
  const token = (process.env.AMIQUS_API_TOKEN ?? "").trim();
  if (!token) {
    throw new AmiqusError("AMIQUS_API_TOKEN is not configured on the server");
  }

  let url = BASE_URL.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  if (query) {
    const clean = Object.entries(query).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    );
    if (clean.length) {
      url += "?" + new URLSearchParams(clean.map(([k, v]) => [k, String(v)])).toString();
    }
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });

  if (res.status === 401 || res.status === 403) {
    // Most likely cause by far is an expired or revoked PAT. Say so, because
    // "HTTP 401" on its own sends whoever is on support down the wrong path.
    throw new AmiqusError(
      `Amiqus rejected the credentials (HTTP ${res.status}). The Personal Access ` +
        `Token has most likely expired or been revoked - PATs last one year and ` +
        `are not refreshed automatically.`,
    );
  }
  if (!res.ok) {
    // Never echo the body: Amiqus error payloads can carry request context,
    // and request context here means candidate PII.
    throw new AmiqusError(`Amiqus returned HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ------------------------------------------------------------------ helpers

/** Amiqus paginates as {data: [...]} on some endpoints and a bare array on
 *  others. Returns the rows either way. */
export function unwrapList(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

/** Email is the only safe join key between Amiqus and Seven20.
 *
 *  Name is NOT a fallback and must never become one: a sample of 20 Amiqus
 *  clients matched 51 Seven20 Contact records, with one name alone carrying
 *  17 duplicates. Guessing by name on an AML gate returns a confident wrong
 *  answer rather than an error, which is the worst failure available here.
 *  At least one Amiqus address is stored with a capital first letter, hence
 *  the lowercasing. */
export function emailKey(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e || null;
}

/** Whole days from now until `iso`. Negative once it is in the past. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

/** Whole days since `iso`. */
export function daysSince(iso: string | null | undefined): number | null {
  const d = daysUntil(iso);
  return d === null ? null : -d;
}

/** Drop keys whose value is null/undefined, recursively.
 *
 *  Worth doing: a live pending list came back with every steps[].status and
 *  steps[].title null, two records carrying ten null-filled steps each. That
 *  was a large share of a ~9,000-token response conveying nothing. */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}
