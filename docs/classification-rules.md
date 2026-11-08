# User classification rule model

`createClassificationRuleModel(connection)` defines the isolated
`classification_rules` collection. The JWT-protected CRUD router registers the model without opening a connection.
`autoCreate`, `autoIndex` and `bufferCommands` are false. Importing the router does
not create a collection, install indexes or apply rules.

`category`, optional `title` and `source` are stored as `trim().toLowerCase()`.
Internal spaces and Unicode spelling are otherwise preserved; original financial
records are untouched. Omit `title` for a category-wide expense rule. A supplied
empty/blank/null title is invalid. `enabled` is an explicit required boolean.
Dates and `_id` have model defaults; timestamps maintain update dates on save.

Two unique indexes use simple collation and dataset-specific partial filters:

- Expenses: `owner + dataset + category + title` (filter: `dataset: expenses`).
  MongoDB indexes absent title as null, so untitled rules are also unique.
- Incomes: `owner + dataset + source` (filter: `dataset: incomes`).

Enabled and disabled rules share the same uniqueness keys. Different owners have
independent keys. These indexes must be installed in a separately authorized step
before CRUD writes become available; `unique` is a database constraint, not a Mongoose
validator. Unit tests check normalized keys and index definitions, not real
MongoDB duplicate rejection.

## CRUD API

All routes use the existing JWT middleware and derive owner exclusively from its
verified `_id` claim. Queries and the final save filter include owner. Body fields
`owner`, `_id`, dates and all unknown keys are rejected. Query parameters are not
supported. Responses use `Cache-Control: no-store`.

- `GET /classification-rules`: 200 `{rules: [...]}`, only the current user's rules.
- `POST /classification-rules`: 201 with the saved rule. Supply the model fields
  above, including explicit `enabled`; identities/timestamps are server-owned.
- `PATCH /classification-rules/:id`: 200 with the saved rule. Nonempty partial
  object; dataset is immutable. For an expense, `title: null` explicitly removes
  the optional title (POST still rejects null). Other omitted fields are unchanged.
  Loads an owner-scoped document, then performs full model validation and `save()`;
  it does not use query updates that bypass the document validation hook.
- `DELETE /classification-rules/:id`: 204 after acknowledged owner-scoped deletion.

Invalid fields, IDs and v2 assignments return 400; authentication failures 401;
missing/foreign rules 404; MongoDB duplicate-key errors 409. Unavailable connection,
catalog or required indexes return 503. A write error with uncertain outcome
returns `persistence: unknown`; do not automatically retry a creation after losing
its acknowledgement. A pre-write readiness failure returns `not_applied`.

## Database preparation

Before writes, an operator must separately prepare the ordinary collection with
simple collation and both exact named unique partial indexes defined by the model.
The API never calls createCollection/createIndex/init/syncIndexes. Each mutation
checks the live catalog; POST/PATCH check it again after document validation.
Index names, key order, unique/non-sparse/non-hidden options, partial filters and
collation must match; TTL indexes are not accepted as the required indexes.
Keep administrative DDL/restores excluded while requests run: a catalog check
cannot prevent a concurrent administrator from dropping an index afterwards.
GET remains read-only and can list existing rules while indexes are unprepared;
a missing collection reads as an empty list. No database setup is performed by
this PR. No rule application, precedence or transfer of frontend rules is included.
