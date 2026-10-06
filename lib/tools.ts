/**
 * Amiqus tools for the X4 Compliance MCP server.
 *
 * Port of servers/amiqus_server.py from the local `amiqus` Claude plugin. Tool
 * names and argument names are deliberately identical so the existing skills
 * (amiqus-onboarding, outstanding-requests) keep working unchanged.
 *
 * Registration style: server.registerTool(name, {title, description,
 * inputSchema: z.object({...})}, handler) on mcp-handler v2.x / zod 4.x.
 * Do NOT switch to server.tool() - the wrong signature registers nothing
 * without erroring.
 *
 * READ ONLY. The Python original also exposed amiqus_create_record; it is
 * deliberately absent. A mis-fired create sends a real verification request to
 * a real candidate's inbox, so writes wait until the read side is trusted.
 *
 * Output is JSON, matching the Python server byte-for-byte in shape, because
 * the skills parse it.
 */

import { z } from "zod";
import {
  amiqusGet,
  unwrapList,
  stripNulls,
  emailKey,
  daysSince,
  daysUntil,
  MAX_LIST,
  INSIGHT_NOTE,
} from "./amiqus";
import { fetchRecordItems } from "./chase";

type Json = Record<string, any>;

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(stripNulls(data), null, 2) }],
});

const asInt = (v: unknown) => {
  const n = Number.parseInt(String(v), 10);
  return Number.isNaN(n) ? v : n;
};

// ---------------------------------------------------------------- summaries

/** Amiqus returns `name` as a string on some endpoints and an object on
 *  others. Normalise, and carry `email_key` so callers never hand-roll the
 *  lowercasing the Seven20 join depends on. */
function clientSummary(c: Json | null | undefined): Json | null {
  if (!c || typeof c !== "object") return (c as any) ?? null;
  let name: any = c.name;
  if (name && typeof name === "object") {
    name =
      name.name ||
      name.full_name ||
      `${name.first_name ?? ""} ${name.last_name ?? ""}`.trim();
  }
  if (!name) name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  return {
    id: c.id,
    name: name || null,
    email: c.email,
    email_key: emailKey(c.email),
    reference: c.reference,
    created_at: c.created_at,
  };
}

function stepSummary(s: Json): Json {
  if (!s || typeof s !== "object") return s;
  return {
    id: s.id,
    type: s.type,
    status: s.status,
    title: s.title || s.name,
    reviewed: s.reviewed,
  };
}

const DONE_STEP_STATES = new Set(["completed", "reviewed", "passed"]);

/** Adds days_outstanding and days_to_expiry, which the raw payload makes you
 *  compute from timestamps every single time. Several live records expire
 *  within days and nothing surfaced it. */
function recordSummary(r: Json): Json {
  if (!r || typeof r !== "object") return r;
  const out: Json = {
    id: r.id,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    expired_at: r.expired_at,
    days_outstanding: daysSince(r.created_at),
    days_to_expiry: daysUntil(r.expired_at),
    reference: r.reference,
  };
  if (r.client && typeof r.client === "object") out.client = clientSummary(r.client);
  else if (r.client !== null && r.client !== undefined) out.client_id = r.client;

  if (Array.isArray(r.steps)) {
    out.steps = r.steps.map(stepSummary);
    out.steps_total = r.steps.length;
    out.steps_complete = r.steps.filter(
      (s: any) => s && typeof s === "object" && DONE_STEP_STATES.has(s.status),
    ).length;
  }
  return out;
}

// -------------------------------------------------------------------- tools

export function registerAmiqusTools(server: any) {
  server.registerTool(
    "amiqus_whoami",
    {
      title: "Amiqus connection check",
      description:
        "Confirm which Amiqus account this connector is authenticated as, and " +
        "that the API token is still valid. Use it to check the connection.",
      inputSchema: z.object({}),
    },
    async () => {
      const me = await amiqusGet<Json>("/me");
      return json({
        id: me.id,
        name: me.name,
        email: me.email,
        is_verified: me.is_verified,
      });
    },
  );

  server.registerTool(
    "amiqus_search_clients",
    {
      title: "Search Amiqus clients",
      description:
        "Find people (clients) in Amiqus by name or email. Returns id, name, " +
        "email and reference. Use to locate a contractor before checking status.",
      inputSchema: z.object({
        query: z.string().describe("Name or email to search for."),
        limit: z.number().int().optional().describe("Max results (capped at 50)."),
      }),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const payload = await amiqusGet<Json>("/clients", {
        search: query,
        per_page: Math.min(limit ?? 20, MAX_LIST),
      });
      const rows = unwrapList(payload).slice(0, MAX_LIST);
      return json({ clients: rows.map(clientSummary), count: rows.length });
    },
  );

  server.registerTool(
    "amiqus_list_records",
    {
      title: "List Amiqus verification records",
      description:
        "List verification records across the team, optionally filtered by " +
        "status (pending, completed, expired), assignee or creator. Use for " +
        "onboarding chase lists. Insight-level summaries only, capped at 50.",
      inputSchema: z.object({
        status: z.string().optional().describe("Filter by record status, e.g. 'pending'."),
        assignee: z.string().optional().describe("Filter by assignee user id."),
        creator: z.string().optional().describe("Filter by creator user id."),
        limit: z.number().int().optional().describe("Max results (capped at 50)."),
      }),
    },
    async (args: { status?: string; assignee?: string; creator?: string; limit?: number }) => {
      const payload = await amiqusGet<Json>("/records", {
        status: args.status,
        assignee: args.assignee,
        creator: args.creator,
        expand: "client",
        per_page: Math.min(args.limit ?? 20, MAX_LIST),
      });
      const rows = unwrapList(payload).slice(0, MAX_LIST);
      const meta = (payload as Json)?.meta;
      return json({
        records: rows.map(recordSummary),
        count: rows.length,
        total_available: meta && typeof meta === "object" ? meta.total : null,
        note: INSIGHT_NOTE,
      });
    },
  );

  server.registerTool(
    "amiqus_get_record",
    {
      title: "Get one Amiqus record",
      description:
        "Fetch a single verification record by id, with its client expanded.",
      inputSchema: z.object({
        record_id: z.string().describe("The Amiqus record id."),
      }),
    },
    async ({ record_id }: { record_id: string }) => {
      const payload = await amiqusGet<Json>(`/records/${encodeURIComponent(record_id)}`, {
        expand: "client",
      });
      const rec = payload?.data ?? payload;
      return json(recordSummary(rec));
    },
  );

  server.registerTool(
    "amiqus_get_record_items",
    {
      title: "Get a record's required items",
      description:
        "For one record, list every required item (checks + documents) by real " +
        "name with whether it has been received or is still outstanding, plus " +
        "candidate-facing instructions. For the whole outstanding list at once, " +
        "use amiqus_chase_list instead of calling this per person.",
      inputSchema: z.object({
        record_id: z.string().describe("The Amiqus record id."),
      }),
    },
    async ({ record_id }: { record_id: string }) => {
      const resolved = await fetchRecordItems(record_id);
      return json({ record_id: asInt(record_id), ...resolved });
    },
  );

  server.registerTool(
    "amiqus_list_client_records",
    {
      title: "List one client's records",
      description:
        "List every verification record belonging to one Amiqus client. Use " +
        "after amiqus_search_clients to see a contractor's onboarding history.",
      inputSchema: z.object({
        client_id: z.string().describe("The Amiqus client id."),
      }),
    },
    async ({ client_id }: { client_id: string }) => {
      const payload = await amiqusGet<Json>(
        `/clients/${encodeURIComponent(client_id)}/records`,
      );
      const rows = unwrapList(payload).slice(0, MAX_LIST);
      return json({ records: rows.map(recordSummary), count: rows.length });
    },
  );

  server.registerTool(
    "amiqus_list_templates",
    {
      title: "List onboarding templates",
      description:
        "List the team's live onboarding record templates (id + name), e.g. " +
        "'UK Sole Trader', 'X4 Employees', 'UK Umbrella'. Call this to resolve " +
        "a spoken template name to its live template id. Never hardcode ids.",
      inputSchema: z.object({
        include_disabled: z
          .boolean()
          .optional()
          .describe("Include disabled/example templates too (default false)."),
      }),
    },
    async ({ include_disabled }: { include_disabled?: boolean }) => {
      const payload = await amiqusGet<Json>("/templates/records", { per_page: 100 });
      const templates = unwrapList(payload)
        .filter((t: any) => t && typeof t === "object")
        .filter((t: Json) => include_disabled || t.is_enabled)
        .map((t: Json) => ({
          id: t.id,
          name: t.name,
          is_enabled: t.is_enabled,
          description: t.description,
        }));
      return json({ templates, count: templates.length });
    },
  );

  server.registerTool(
    "amiqus_get_client_forms",
    {
      title: "Get a client's forms",
      description:
        "List a client's forms with their status, or fetch one form's status by " +
        "reference. Status only: field-level answers are PII and are never " +
        "returned in bulk.",
      inputSchema: z.object({
        client_id: z.string().describe("The Amiqus client id."),
        reference: z
          .string()
          .optional()
          .describe("A single form reference. Omit to list all of the client's forms."),
      }),
    },
    async ({ client_id, reference }: { client_id: string; reference?: string }) => {
      const cid = encodeURIComponent(client_id);
      if (reference) {
        const payload = await amiqusGet<Json>(
          `/clients/${cid}/forms/${encodeURIComponent(reference)}`,
        );
        const form: Json = payload?.data ?? payload ?? {};
        return json({
          reference: form.reference ?? reference,
          status: form.status,
          title: form.title ?? form.name,
          submitted_at: form.submitted_at,
          note: "Form status only. Field-level answers are PII and are not returned in bulk.",
        });
      }
      const payload = await amiqusGet<Json>(`/clients/${cid}/forms`);
      const rows = unwrapList(payload)
        .filter((f: any) => f && typeof f === "object")
        .slice(0, MAX_LIST);
      return json({
        forms: rows.map((f: Json) => ({
          reference: f.reference,
          status: f.status,
          title: f.title ?? f.name,
          submitted_at: f.submitted_at,
        })),
        count: rows.length,
      });
    },
  );
}
