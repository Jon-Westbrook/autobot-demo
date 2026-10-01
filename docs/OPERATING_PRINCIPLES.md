# Operating principles

Durable principles only. What the system *is* belongs in [README](../README.md);
where it currently stands belongs in [Current status](CURRENT_STATUS.md); execution
semantics belong only in the [canonical contract](EXECUTION_CONTRACT.md).

## Growth first

Build a disciplined research, execution and promotion system for long-term
compounding. Daily/near-daily Growth comes first; intraday, crypto and other
fast-money systems are a later, separate lane. The durable product is the research
process, the execution discipline and the evidence, not any single strategy or
exciting equity curve.

## Explicit, minimal, symmetrical

One canonical path beats several legacy ones. Contract semantics, accounting and
eligibility live in one place; a candidate owns only its own features and its target
vector. Treat one-off exceptions, stale assumptions and hidden coupling as warning
signs: a special case named after a specific strategy is a defect.

Minimalism means the smallest trustworthy system, not the fewest files at any cost.
Delete dead code and preserve useful regression coverage. When retiring something,
port the coverage that still describes real behaviour rather than dropping it with
the code. Git history is the archive; do not build parallel archive trees.

Update the canonical documents instead of adding a status file per tranche.

## Contract and evidence symmetry

Every result must identify its data, signal time, execution time, fills, costs and
implementation. Research, historical replay, modeled, paper and future live are
separate surfaces; only compare evidence with aligned assumptions. Never relabel
prior results, hide missing data, splice validation windows across contract
versions, or mistake a contract badge for exact execution parity.

Changing the contract changes its version and its content hash, and the amendment
states its reason. The replay refuses to run against a document it does not
recognise.

## Never fabricate an observation

No interpolation, synthetic bar, forward fill, prior-day substitution or silent
NaN-to-zero. Missing required data is an honest reason-coded `NO_REBALANCE`. A
modelling assumption that is not a market observation - a dividend settlement date,
a cash rate - is recorded explicitly with its basis and its known limitations.

Equally: a single missing minute must not void evidence that does not depend on it.
Conservatism means refusing to invent data, not discarding real data.

## Earn promotion

Discovery -> promotion validation -> canonical replay evidence -> modeled -> paper ->
tiny live -> scaled live.

Promotion validation is independent of the search: it reads a window no objective was
allowed to see, and nothing it reports feeds a score. Repeatedly optimising
against the final test destroys the only unbiased estimate available.

Test friction and stress costs, the reserved holdout, rolling-window stability, path
robustness, parameter neighbourhoods, dependency ablation and worst episodes. Accept
honest failures over impressive but unreliable performance. Operational readiness and
paper success alone do not authorize real capital.

## Research discipline

Keep objectives and guardrails explicit while leaving the solution space open. An
objective must be checked for what it *actually* rewards, not what it was intended to
reward: measure return above the risk-free alternative, or a candidate that parks in
cash will win on carry. Gate the degenerate cases explicitly rather than hoping the
search avoids them.

A lab winner is a candidate, never automatic permission for production deployment.

## Operational discipline

Keep modeled, paper and live evidence distinct, with truthful reporting of decisions,
intent, orders, fills, state transitions and errors. Do not commit runtime data,
downloaded market data, caches or secrets. Preserve evidence before resets and
cutovers. After a change, observe real cycles before another redesign. At meaningful
milestones verify, commit and push.

Before live capital, review credential rotation, paper/live separation, least
privilege, secret exposure, host hardening and monitoring.

## Default review question

Does this change make the system more explicit, consistent, testable and easier to
trust? Completing one gate does not authorize the next.
