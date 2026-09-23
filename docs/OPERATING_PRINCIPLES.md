# Operating principles

This is the repository's canonical operating-principles document, consolidated
from the read-only project reference `AUTOBOT_OPERATING_PRINCIPLES.md`.
Current state and sequencing belong in [Current status and roadmap](CURRENT_STATUS.md);
planned execution semantics belong only in the [canonical contract](EXECUTION_CONTRACT.md).

## Growth first

Build a disciplined research, execution and promotion system for long-term
compounding. Daily/near-daily Growth comes first; intraday scalping,
crypto/perpetuals and other fast-money systems are a later, separate lane.
The durable product is the research process, execution discipline and evidence,
not any single strategy or exciting equity curve.

## Explicit, minimal, symmetrical

Prefer consistent naming, layout, lifecycle boundaries and schedules. Treat
one-off exceptions, stale assumptions and hidden coupling as warning signs.
Use family-first strategy IDs. Keep each strategy independently deployable;
no global multi-strategy runner or shared mutable strategy state. Keep
strategy-specific research with its lane and reusable research in `backtester/`.
Shared infrastructure requires an explicit bounded design, not accidental coupling.
Some lane-local duplication is acceptable when it preserves clarity and independent
deployment. Minimalism means the smallest trustworthy system, not the fewest
files at any cost. Delete dead code; preserve useful regression coverage and
historical evidence. Audit tests for current relevance and uncovered high-risk paths.
Update the canonical documents instead of creating a new status file per tranche.
Lane runbooks and dated research results may remain scoped references, never
competing project roadmaps or copies of the normative execution contract.

## Contract and evidence symmetry

Every result must identify data, signal time, execution time, fills, costs and
implementation. Research, historical replay, modeled, paper and future live
remain separate surfaces; only compare evidence with aligned assumptions.
Never relabel legacy results, hide missing data, splice validation windows or
mistake a family-level contract badge for exact execution parity.
Modeled is the strategy brain; paper/live consume recorded intent and perform
execution/readiness/safety checks without recomputing the strategy.

## Earn promotion

Discovery -> research -> robustness and execution-contract testing -> canonical
replay -> modeled -> paper -> tiny live -> scaled live. Freeze candidates and
reproduce research winners before promotion. Test friction/stress costs,
holdout, walk-forward, Monte Carlo, parameter sensitivity, worst episodes,
turnover/exposure and timing sensitivity. Flag fragile timing-dependent edges.
Accept honest failures over impressive but unreliable performance.
Operational readiness and paper success alone do not authorize real capital.

## Research discipline

Keep objectives and guardrails explicit while leaving the solution space open.
Deepen a promising family, then challenge it with alternatives. A bounded lab
has one thesis, baseline and score; incompatible research questions stay separate.
Use causal evaluation, versioned evaluators and reproducible evidence. A lab
winner is a candidate, never automatic permission for production deployment.

## Operational discipline

Keep modeled, paper and live evidence distinct, with truthful reporting and
filterable decisions, intent, orders, fills, state transitions and errors.
Do not commit runtime data, downloaded CSVs, caches or secrets. Preserve evidence
before resets/cutovers. Keep logs/state lane-local and cron entries explicit.
After a change, observe real cycles before another redesign. At meaningful
milestones, verify, commit, push and consider a release tag as a rollback point.
Before live capital, review credential rotation, paper/live separation, least
privilege, secret exposure, VPS hardening, SSH protections and monitoring.

## Default review question

Does this change make the system more explicit, consistent, testable and easier
to trust? Each approved tranche ends with evidence and the operator review; completing
one gate does not authorize the next.
