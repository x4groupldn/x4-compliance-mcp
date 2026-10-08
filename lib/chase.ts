/**
 * Composite chase tools for the X4 Compliance MCP server.
 *
 * These exist because the daily question - "who is outstanding and what are
 * they missing" - costs 1 + N calls through the passthrough tools.
 * `amiqus_list_records` reports "0 of 2 complete" but every steps[].title and
 * steps[].status comes back null, so the actual document names only appear via
 * /records/{id}/steps, one record at a time. With 22 pending records that is
 * 23 round trips and the "what counts as outstanding" judgement re-derived in
 * the prompt each run.
 *
 * The fan-out moves here instead: one call in, capped concurrency out, one
 * answer back, and the definition of outstanding living in code where it can
 * be diffed and tested. For an AML gate that determinism is worth more than
 * the flexibility it costs.
 *
 * The passthrough tools in ./tools stay exactly as they are. This is additive -
 * unanticipated questions still work the way they always did.
 */

import { z } from "zod";
import {
  amiqusGet,
  unwrapList,
  stripNulls,
  emailKey,
  daysSince,
  daysUntil,
  flattenName,
  MAX_LIST,
} from "./amiqus";

type Json = Record<string, any>;

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(stripNulls(data), null, 2) }],
});

/**
 * Bounded-concurrency map.
 *
 * Amiqus rate limits (the Python original carried an explicit 429 handler) and
 * this function has 30 seconds, so firing 50 requests at once is how you turn a
 * working chase list into a 429 storm. Five in flight keeps a 22-record list
 * at roughly five sequential rounds.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const DONE_ITEM_STATES = new Set(["complete", "accepted", "passed", "reviewed", "clear"]);

/**
 * Resolve one record's steps into named items with received/outstanding state.
 *
 * Shared with amiqus_get_record_items so the single-record view and the chase
 * list can never disagree about what "outstanding" means.
 */
export async function fetchRecordItems(recordId: string | number) {
  const payload = await amiqusGet<Json>(
    `/records/${encodeURIComponent(String(recordId))}/steps`,
    { expand: "check,document,form", per_page: 100 },
  );
  const items = unwrapList(payload)
    .filter((st: any) => st && typeof st === "object")
    .map((st: Json) => {
      const stepType: string = st.type ?? "";
      const nestedRaw = st.document ?? st.check ?? st.form ?? {};
      const nested: Json = nestedRaw && typeof nestedRaw === "object" ? nestedRaw : {};
      const tail = stepType.split(".").pop() ?? "";
      const name =
        nested.name || tail.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
      const nstatus: string | null = nested.status ?? null;
      const completedAt = st.completed_at ?? nested.completed_at ?? null;
      const outstanding =
        !completedAt && !DONE_ITEM_STATES.has((nstatus ?? "").toLowerCase());
      const kind = stepType.startsWith("check")
        ? "check"
        : stepType === "form"
          ? "form"
          : "document";
      return {
        name,
        kind,
        type: stepType,
        status: nstatus,
        completed_at: completedAt,
        outstanding,
        instructions:
          nested.config && typeof nested.config === "object"
            ? nested.config.instructions
            : null,
      };
    });
  const total = items.length;
  const received = items.filter((i) => !i.outstanding).length;
  return {
    total,
    received,
    outstanding: total - received,
    all_received: total > 0 && received === total,
    items,
  };
}

/** Expiry drives the ordering: it is the only thing on a record that turns a
 *  chase into a re-send. Anything already past is called out separately so it
 *  never sits quietly in the middle of a list. */
function urgencyOf(daysToExpiry: number | null): string {
  if (daysToExpiry === null) return "no_expiry";
  if (daysToExpiry < 0) return "expired";
  if (daysToExpiry <= 3) return "expiring";
  if (daysToExpiry <= 7) return "soon";
  return "ok";
}

export function registerChaseTools(server: any) {
  server.registerTool(
    "amiqus_chase_list",
    {
      title: "Outstanding onboarding chase list",
      description:
        "THE daily Compliance question in one call: everyone with outstanding " +
        "onboarding, the actual names of the documents they still owe, how long " +
        "they have been waiting and how many days until the request expires, " +
        "ordered by urgency. Use this instead of amiqus_list_records followed by " +
        "amiqus_get_record_items per person.",
      inputSchema: z.object({
        status: z
          .string()
          .optional()
          .describe("Record status to chase. Defaults to 'pending'."),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max records to resolve (capped at 50)."),
      }),
    },
    async ({ status, limit }: { status?: string; limit?: number }) => {
      const cap = Math.min(limit ?? MAX_LIST, MAX_LIST);
      const payload = await amiqusGet<Json>("/records", {
        status: status ?? "pending",
        expand: "client",
        per_page: cap,
      });
      const records = unwrapList(payload).slice(0, cap);

      // One failing record must not take the whole list down. A chase list that
      // silently drops a person is worse than one that says it could not read them.
      const rows = await mapLimit(records, 5, async (r: Json) => {
        const base = {
          record_id: r.id,
          name: flattenName(r.client?.name, r.client),
          email: r.client?.email ?? null,
          email_key: emailKey(r.client?.email),
          created_at: r.created_at,
          expired_at: r.expired_at,
          days_outstanding: daysSince(r.created_at),
          days_to_expiry: daysUntil(r.expired_at),
          urgency: urgencyOf(daysUntil(r.expired_at)),
        };
        try {
          const resolved = await fetchRecordItems(r.id);
          return {
            ...base,
            received: resolved.items.filter((i) => !i.outstanding).map((i) => i.name),
            missing: resolved.items.filter((i) => i.outstanding).map((i) => i.name),
            items_total: resolved.total,
            items_received: resolved.received,
            // Full item objects as well as the name lists above: the chase
            // dashboard needs kind and candidate-facing instructions, and these
            // were already fetched, so discarding them just forced a second
            // round of per-record calls to get them back.
            items: resolved.items,
          };
        } catch (e: any) {
          return { ...base, error: String(e?.message ?? e) };
        }
      });

      const order = ["expired", "expiring", "soon", "ok", "no_expiry"];
      rows.sort(
        (a, b) =>
          order.indexOf(a.urgency) - order.indexOf(b.urgency) ||
          (a.days_to_expiry ?? 9999) - (b.days_to_expiry ?? 9999),
      );

      const failed = rows.filter((r: any) => r.error);
      return json({
        as_of: new Date().toISOString().slice(0, 10),
        status: status ?? "pending",
        counts: {
          total: rows.length,
          expired: rows.filter((r) => r.urgency === "expired").length,
          expiring_within_3_days: rows.filter((r) => r.urgency === "expiring").length,
          nothing_received: rows.filter((r: any) => r.items_received === 0).length,
          unreadable: failed.length,
        },
        outstanding: rows,
        note:
          "Insight-level summary, capped at " +
          MAX_LIST +
          " records. Document names only; no document contents or ID images.",
      });
    },
  );

  server.registerTool(
    "amiqus_person_status",
    {
      title: "Onboarding status for one person",
      description:
        "Status for ONE named person in plain English: 'is Jane Smith verified', " +
        "'has Bob cleared his checks', 'what is X still waiting on', 'where is " +
        "Y up to with onboarding'. Give it a name or an email and it returns " +
        "whether they are cleared, what they still owe by document name, how " +
        "long it has been outstanding and when the request expires. Use this " +
        "rather than chaining amiqus_search_clients, amiqus_list_client_records " +
        "and amiqus_get_record_items. If the name matches more than one person " +
        "it returns the candidates and asks rather than guessing.",
      inputSchema: z.object({
        query: z.string().describe("A person's name or email address."),
      }),
    },
    async ({ query }: { query: string }) => {
      const payload = await amiqusGet<Json>("/clients", { search: query, per_page: 10 });
      const matches = unwrapList(payload).filter((c: any) => c && typeof c === "object");

      if (!matches.length) {
        return json({
          query,
          state: "not_found",
          note: "Nobody in Amiqus matches that name or email. They may not have been onboarded yet.",
        });
      }

      // A name search is fine when a human has named the person - they can
      // confirm. What is never fine is picking one silently: "Todd Johnson"
      // matches 17 Seven20 contacts, and the equivalent collision here would
      // mean reporting one person's AML status as another's. Ask instead.
      const exactEmail = matches.find((c: Json) => emailKey(c.email) === emailKey(query));
      const chosen = exactEmail ?? (matches.length === 1 ? matches[0] : null);
      if (!chosen) {
        return json({
          query,
          state: "ambiguous",
          note: "More than one person matches. Ask which one; do not guess.",
          candidates: matches.slice(0, 10).map((c: Json) => ({
            id: c.id,
            name: flattenName(c.name, c),
            email: c.email,
          })),
        });
      }

      const recPayload = await amiqusGet<Json>(
        `/clients/${encodeURIComponent(String(chosen.id))}/records`,
      );
      const records = unwrapList(recPayload);
      if (!records.length) {
        return json({
          query,
          client_id: chosen.id,
          name: flattenName(chosen.name, chosen),
          state: "no_record",
          note: "This person exists in Amiqus but has no onboarding record.",
        });
      }

      // Newest first: an older completed record does not clear a newer
      // outstanding one.
      const sorted = records.sort(
        (a: Json, b: Json) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0),
      );
      const latest = sorted[0];
      const resolved = await fetchRecordItems(latest.id);

      return json({
        query,
        client_id: chosen.id,
        name: flattenName(chosen.name, chosen),
        state: resolved.all_received ? "cleared" : "outstanding",
        record_id: latest.id,
        record_status: latest.status,
        created_at: latest.created_at,
        days_outstanding: daysSince(latest.created_at),
        days_to_expiry: daysUntil(latest.expired_at),
        urgency: urgencyOf(daysUntil(latest.expired_at)),
        received: resolved.items.filter((i) => !i.outstanding).map((i) => i.name),
        missing: resolved.items.filter((i) => i.outstanding).map((i) => i.name),
        items: resolved.items,
        earlier_records: sorted.length - 1,
        note: "Most recent record only. earlier_records counts older ones; use amiqus_list_client_records for the full history.",
      });
    },
  );

  server.registerTool(
    "amiqus_check_status",
    {
      title: "Check onboarding status for a list of people",
      description:
        "Given email addresses (typically pulled from Seven20 for upcoming " +
        "starters), return each person's Amiqus onboarding state: cleared, " +
        "outstanding with named missing documents, or no record found. Matching " +
        "is on lowercased email ONLY - never fall back to name. Returns a " +
        "not_found list so people who cannot be matched are visible rather than " +
        "silently absent.",
      inputSchema: z.object({
        emails: z
          .array(z.string())
          .describe("Email addresses to check, normally from Seven20. Max 25."),
      }),
    },
    async ({ emails }: { emails: string[] }) => {
      // Name is NOT a fallback and must never become one: a sample of 20 Amiqus
      // clients matched 51 Seven20 Contact records, one name carrying 17
      // duplicates. Matching on name here would return a confident wrong answer
      // on an AML gate rather than an error.
      const wanted = Array.from(
        new Set(emails.map(emailKey).filter((e): e is string => Boolean(e))),
      ).slice(0, 25);

      const results = await mapLimit(wanted, 5, async (email) => {
        try {
          const clientPayload = await amiqusGet<Json>("/clients", {
            search: email,
            per_page: 10,
          });
          const match = unwrapList(clientPayload).find(
            (c: Json) => emailKey(c?.email) === email,
          );
          if (!match) return { email, state: "no_record", reason: "no Amiqus client" };

          const recPayload = await amiqusGet<Json>(
            `/clients/${encodeURIComponent(String(match.id))}/records`,
          );
          const records = unwrapList(recPayload);
          if (!records.length) {
            return {
              email,
              client_id: match.id,
              state: "no_record",
              reason: "client exists, no onboarding record",
            };
          }
          // Most recent record wins: an older completed one does not clear a
          // newer outstanding request.
          const latest = records.sort(
            (a: Json, b: Json) =>
              Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0),
          )[0];
          const resolved = await fetchRecordItems(latest.id);
          return {
            email,
            client_id: match.id,
            record_id: latest.id,
            record_status: latest.status,
            state: resolved.all_received ? "cleared" : "outstanding",
            missing: resolved.items.filter((i) => i.outstanding).map((i) => i.name),
            days_to_expiry: daysUntil(latest.expired_at),
            urgency: urgencyOf(daysUntil(latest.expired_at)),
          };
        } catch (e: any) {
          return { email, state: "error", reason: String(e?.message ?? e) };
        }
      });

      const notFound = results.filter((r) => r.state === "no_record").map((r) => r.email);
      return json({
        checked: wanted.length,
        skipped: Math.max(0, emails.length - wanted.length),
        counts: {
          cleared: results.filter((r) => r.state === "cleared").length,
          outstanding: results.filter((r) => r.state === "outstanding").length,
          no_record: notFound.length,
          errored: results.filter((r) => r.state === "error").length,
        },
        results,
        not_found: notFound,
        note:
          "Matched on lowercased email only. An address that differs by one " +
          "character, or a person using a different address in each system, " +
          "appears here as no_record and needs reconciling by hand.",
      });
    },
  );
}
