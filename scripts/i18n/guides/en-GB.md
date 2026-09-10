# en-GB translation guide

Apply `default.md` first, then these English (United Kingdom) rules.

- Use British English spellings for all words.
- Prefer -ise to -ize (including -isation nouns like itemisation and
  authorisation), -our to -or (behaviour), -re to -er, and -lled to -eled
  (where appropriate).
- Do not "correct" words that are identical in British English: check
  (verify), program (software), central (proper names like Central African
  CFA Franc), or technical tokens like .zip.
- Avoid using American phrases and wordings (e.g. refer to maths instead of
  math, rubbish instead of trash).
- Prefer British examples and currency (British Pound/GBP) where appropriate.
- Retain en-US wording where it matches British English - do not unnecessarily update strings.

## Sparse overlay

`en-GB.json` stores only keys that differ from `en-US` — everything else is
inherited at runtime (`en-GB → en-US`). When new `en-US` keys arrive, compare
each against British English; if identical, omit the key (do not set it —
`set` rejects inherited values). Use `bun i18n prune --locale en-GB` to list
keys that can be dropped back to inheritance.
