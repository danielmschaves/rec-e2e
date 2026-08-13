<!--
Keep this short. The two sections reviewers rely on are "How I verified it" and
"What I did not verify" — an honest gap is more useful than implied coverage.
-->

## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!-- The problem, or the request. Link an issue if there is one. -->

## How I verified it

<!-- Paste real output. `npm run check` covers typecheck + all three suites. -->

```
```

- [ ] `npm run check` passes
- [ ] `npm run check:smoke` passes, or the change doesn't touch the UI
- [ ] Added or updated assertions for the behaviour I changed

## What I did not verify

<!--
Be specific. Standing gaps in this repo: live Google API calls and live model
calls are not exercised by any suite. If your change touches those paths, say
so.
-->

## Notes for the reviewer

<!-- Anything non-obvious: a decision you went back and forth on, a trade-off. -->

---

- [ ] Schema changed → migration baseline regenerated (see CONTRIBUTING.md)
- [ ] New env var → documented in `docs/OPERATIONS.md` and `.env.example`
- [ ] No secrets, tokens or real personal data in the diff
