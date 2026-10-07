---
name: outstanding-requests
description: >
  Use this skill when the user wants to see or build the outstanding contract
  requests / onboarding tracker for X4 Group Compliance. Triggers include:
  "what contract requests are outstanding", "outstanding contract requests",
  "show me the outstanding onboarding", "who still needs to complete onboarding",
  "build the compliance tracker", "outstanding onboarding tracker",
  "onboarding chase list", or any request for a dashboard of open Amiqus
  onboarding requests and which documents are still missing. Produces an
  interactive HTML dashboard plus a short chat summary. Run daily.
metadata:
  version: "1.0.0"
  author: X4 Group
---

# Outstanding Contract Requests dashboard

Build an interactive HTML dashboard of every open Amiqus onboarding request,
showing which candidates are waiting and exactly which documents and checks are
still outstanding.

Served by the **X4 Compliance** remote connector. There is no local plugin and
no install step.

## Procedure

1. Call `amiqus_chase_list` with `status: "pending"`. One call. It returns every
   outstanding record already resolved into named items, with `days_outstanding`,
   `days_to_expiry` and an `urgency` band, sorted expired first.

   Do NOT call `amiqus_list_records` and then `amiqus_get_record_items` per
   person. That was the old shape and costs one call per record; the connector
   now does that fan-out server-side.

2. Check `counts.unreadable`. If it is above zero, some records could not be
   resolved and carry an `error` field. Name them in the chat summary rather
   than letting them vanish from the list.

3. Build the template's JSON from the response, one entry per element of
   `outstanding`:

   ```
   {
     "generated_at": "<current UTC ISO timestamp>",
     "records": [
       {
         "id": <record_id>,
         "name": "<name>",
         "created_at": "<created_at>",
         "expired_at": "<expired_at>",
         "received": <items_received>,
         "total": <items_total>,
         "klass": "<'ready' if total>0 and received==total, else 'wait'>",
         "items": [ <the items array, unchanged> ]
       }
     ]
   }
   ```

   **Drop `email` and `email_key`.** The connector returns them because the
   Seven20 join needs them; the dashboard must not carry them. See Rules.

4. Read the bundled template at `references/dashboard_template.html`, replace
   the token `__DATA__` (it appears once, as `const DATA=__DATA__;`) with that
   JSON, and write the result to the outputs folder as
   `Outstanding Contract Requests.html`. Change nothing else in the template.

5. Present the file so the user can open or pin it.

6. Give a short chat summary: total open, how many are waiting on the candidate
   vs ready to review, and name the two or three most urgent. Lead with
   `counts.expired` and `counts.expiring_within_3_days` - those are the ones
   that need a re-send, not a chase.

## Rules

- **PII.** Names and item status only. Never put candidate emails, passport
  numbers, document images, addresses or raw form answers into the dashboard or
  the chat summary. `amiqus_chase_list` returns `email` and `email_key` for the
  Seven20 join; strip both before rendering. This is an internal Compliance view.
- **Never invent data.** If the tool errors with a 401, the Amiqus token has
  most likely expired - it lasts one year and is not auto-refreshed. Say so and
  stop. Do not fall back to guessing or to a cached list.
- **Point in time.** The footer shows when it was generated. Re-run daily.
- **Styling.** Keep the template's layout exactly as bundled so the output looks
  the same every run.

## Related

- `amiqus-onboarding` for ad-hoc questions about one person.
- `amiqus_check_status` when the question starts from Seven20 ("who starts next
  week and hasn't cleared"), rather than from Amiqus.
