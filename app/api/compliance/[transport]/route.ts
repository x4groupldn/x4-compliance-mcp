/**
 * X4 Compliance MCP endpoint - Amiqus.
 *
 * INSTALL AS: app/api/compliance/[transport]/route.ts
 *   -> serves https://<project>.vercel.app/api/compliance/mcp
 *
 * Scope (v1): READ ONLY. The Python plugin this replaces also exposed
 * amiqus_create_record; it is deliberately absent here. A mis-fired create
 * sends a real verification request to a real candidate's inbox, so writes
 * come back only once the read side has been trusted in daily use.
 *
 * Why this is a separate deployment from x4-sales rather than another route
 * on it: AML and identity data wants its own blast radius, its own secret and
 * its own retention posture. The ~50-line auth gate below is copied from the
 * sales server rather than shared - at one file that is cheaper than a package.
 *
 * Seven20 is deliberately NOT reached from here. Compliance users already have
 * the Seven20 connector running as their own Salesforce login, which keeps
 * per-user access control intact. A service identity in this project would
 * hand every user the same scope. Joins happen above, on email.
 *
 * Required env (set as Vercel *Sensitive* Environment Variables, Production):
 *   AMIQUS_API_TOKEN    Amiqus Personal Access Token, Contracts Team account.
 *                       EXPIRES ONE YEAR AFTER IT WAS MINTED. Not refreshable.
 *   MCP_SHARED_SECRET   gate for this endpoint; fails closed if unset.
 *
 * Optional env:
 *   MCP_SHARED_SECRET_PREVIOUS  the outgoing secret during a rotation. While
 *                               set, BOTH are accepted so nobody is locked out
 *                               mid-week. Use of the old one is logged; when
 *                               those log lines stop, delete this and redeploy.
 *   AMIQUS_BASE_URL             override the API base. Defaults to v2 live.
 */

import { createMcpHandler } from "mcp-handler";
import { timingSafeEqual } from "node:crypto";
import { registerAmiqusTools } from "../../../../lib/tools";
import { registerChaseTools } from "../../../../lib/chase";

export const runtime = "nodejs";
export const maxDuration = 30;


const handler = createMcpHandler(
  (server) => {
    registerAmiqusTools(server);
    registerChaseTools(server);
  },
  {
    serverInfo: { name: "x4-compliance", version: "0.3.0" },
    verboseLogs: false,
  },
);

// ---------------------------------------------------------------- auth gate

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Accepts the shared secret as `Authorization: Bearer <secret>` or `?k=<secret>`.
 * The header is preferred; the query form exists because a connector UI may not
 * expose a custom-header field. Fails closed when the secret is unset.
 */
function authorised(req: Request): "current" | "previous" | false {
  const secret = (process.env.MCP_SHARED_SECRET ?? "").trim();
  if (!secret) return false;

  const previous = (process.env.MCP_SHARED_SECRET_PREVIOUS ?? "").trim();
  const bearer = (req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const k = (new URL(req.url).searchParams.get("k") ?? "").trim();

  for (const presented of [bearer, k]) {
    if (!presented) continue;
    if (constantTimeEquals(presented, secret)) return "current";
    if (previous && constantTimeEquals(presented, previous)) return "previous";
  }
  return false;
}

async function guarded(req: Request) {
  const via = authorised(req);

  if (!via) {
    // 403 deliberately, with no WWW-Authenticate header: a 401 + Bearer
    // challenge can send an MCP client off into OAuth discovery, which this
    // endpoint does not implement.
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (via === "previous") {
    console.warn("[gate] authenticated with MCP_SHARED_SECRET_PREVIOUS");
  }

  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
