# Pure recurrence observations (F2)

This module will operate only on prevalidated, single-owner synthetic or trusted snapshots. It does not read MongoDB, serve HTTP, authorize users, assign economic roles, classify spending layers, or write manual decisions.

Inputs use explicit completed UTC month ranges and coverage metadata. Missing coverage is not a zero-transaction month. Category/source and similar-expense observations are independent. A label-only category is not a verified system/custom identity, and income source is not a verified payer.

Grouping is intentionally exact (no fuzzy, case-folding or Unicode normalization). Recurrence thresholds, confidence, 12-month defaults, yearly recurrence, persistent review decisions, APIs, owner authorization, query completeness, and money conversion require separate product/data-contract review.

The engine is not wired into any application route; it cannot modify existing finances. Any live integration requires approved owner isolation, completeness proofs, and bounded history reads.
