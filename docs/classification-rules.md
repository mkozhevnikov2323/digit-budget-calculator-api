# User classification rule model

`createClassificationRuleModel(connection)` defines the isolated
`classification_rules` collection. Nothing imports it into application bootstrap;
`autoCreate` and `autoIndex` are false. This change does not create a collection,
install indexes, connect to MongoDB or apply any rules.

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
before CRUD becomes available; `unique` is a database constraint, not a Mongoose
validator. Unit tests check normalized keys and index definitions, not real
MongoDB duplicate rejection.

Future CRUD must derive the authorized owner, scope every access by that owner,
validate whole documents and use `save()`. Query updates/bulk writes bypass the
full-document validation hook; `runValidators` alone is insufficient. No CRUD,
automatic classification, rule precedence or transfer of frontend rules is
implemented here. Assignments reuse the v2 domain compatibility validator.
