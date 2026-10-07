---
name: amiqus-onboarding
description: >
  This skill should be used when the user asks about Amiqus identity
  verification, AML or onboarding checks for X4 Group contractors - for example
  "is Jane verified in Amiqus", "has this contractor passed their ID check",
  "who still has outstanding onboarding checks", "check Amiqus status for a
  runner", or any question about a runner's ID, AML or Right to Work status
  before they start. Use it whenever Amiqus data is involved.
metadata:
  version: "1.0.0"
  author: X4 Group
---

# Amiqus onboarding checks

Answer questions about contractor identity verification and AML onboarding
through the **X4 Compliance** remote connector. Amiqus is X4 Group's identity
verification and compliance platform; a runner must clear their checks before
their placement start date.

## Data model

- **Client** - a person (a contractor/runner) in Amiqus. Found by name or email.
- **Record** - one onboarding case sent to a client: a set of steps. Has an
  overall status (pending, completed, expired).
- **Step** - an individual check or form inside a record: photo ID, Right to
  Work, AML/PEP and sanctions, Source of Funds, document upload, form.
- **Form** - a questionnaire attached to a client.

A person is cleared only when every item on their most recent record is
received. An older completed record does not clear a newer outstanding one.

## Pick the right tool for the question

**Start from Amiqus** ("who is outstanding?"):

- `amiqus_chase_list` - everyone outstanding, with named missing documents, days
  waiting, days to expiry and urgency. **One call.** Use this for any "who still
  needs to..." question. Do not loop `amiqus_get_record_items` per person.

**Start from Seven20** ("who starts next week and hasn't cleared?"):

- Pull the people from Seven20 with that connector, then pass their emails to
  `amiqus_check_status`. It returns cleared / outstanding / no_record per person,
  plus an explicit `not_found` list.

**One named person:**

- `amiqus_search_clients` - find them by name or email.
- `amiqus_list_client_records` - their full onboarding history.
- `amiqus_get_record` - one record's status.
- `amiqus_get_record_items` - exactly what that record still needs.
- `amiqus_get_client_forms` - form status (status only, never answers).

**Setup and health:**

- `amiqus_list_templates` - live template ids and names. Never hardcode a
  template id; the spoken name and the stored name differ.
- `amiqus_whoami` - confirm the connection and which account the token belongs to.

## The join key is email. Never name.

When matching an Amiqus person to a Seven20 contact, match on lowercased email
only. Every client summary carries `email_key` for exactly this.

**Do not fall back to name matching when email fails.** A sample of 20 Amiqus
clients matched 51 Seven20 Contact records, with one name alone carrying 17
duplicates. On an AML gate, name matching returns a confident wrong answer
rather than an error, which is the worst failure available. If the email does
not match, report it as unmatched and let a human reconcile it.

Known causes of a miss, all seen in real data: an address differing by a single
character, a person using a different address in each system, and a first name
spelt differently in each system.

## Rules

- **Read only.** This connector cannot send or create verification requests.
  If asked to send one, say so and point the user at Amiqus directly.
- **No document contents.** Status and item names only. Never surface passport
  numbers, document images, addresses or raw form answers.
- **Never invent data.** A 401 almost always means the Amiqus token has expired;
  it lasts one year and is not auto-refreshed. Say so and stop.
- **Expiry matters more than age.** A record near expiry needs re-sending, not
  chasing. Lead with `days_to_expiry`, not `days_outstanding`.

## Related

- `outstanding-requests` builds the daily HTML tracker from `amiqus_chase_list`.
