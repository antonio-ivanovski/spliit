# pt-BR translation guide

Apply `default.md` first, then these Brazilian Portuguese rules.

- Use contemporary Brazilian Portuguese with a friendly `você`/impersonal UI voice. Avoid European Portuguese vocabulary and spelling (e.g. _configurações_ not _definições_, _arquivo_ not _ficheiro_).
- Prefer common Brazilian terms and natural Brazilian word order; do not translate literally from English or European Portuguese. Brand labels stay as-is: `Spliit Cloud` (never `Importação do Spliit Cloud`).
- Preserve accents, contractions, gender/number agreement, and Brazilian punctuation. Rephrase when a short label can avoid unnecessary gender. Recurrence is `Diária`/`Semanal` (never `DiDiária`).
- Keep Brazilian terminology consistent for expenses, shares, balances, and settlements, while preserving all numeric values and currency codes. Fixed-rate import wording must describe a single exchange rate per currency pair fetched from Frankfurter (not "menos preciso/zerado").
- Use concise action labels and avoid formal legalistic language in ordinary UI text.
- Exclusive settlement term: _acerto_ (noun) and _acertar_ (verb). Never _reembolso_. Prefer _acerto_ over _liquidação_ when both appear. Income placeholder `Salário ou reembolso` is repayment, not settlement, and is the only allowed _reembolso_.

## Sparse overlay

`pt-BR.json` stores only keys that differ from `pt` — everything else is
inherited at runtime (`pt-BR → pt → en-US`). When new keys arrive, translate
into Brazilian Portuguese; if the Brazilian wording matches the `pt` value,
omit the key (do not set it — `set` rejects inherited values). Use
`bun i18n prune --locale pt-BR` to list keys that can be dropped back to
inheritance.
