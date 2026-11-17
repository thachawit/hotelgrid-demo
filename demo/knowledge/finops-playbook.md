# AI FinOps playbook (team-finops)

## Order of levers
1. Free wins: prompt caching, batch for non-urgent work, trimming context, capping agent loops, removing unused seats.
2. Quality-trading changes: lower effort, smaller model, routing by task. Each needs a shadow eval on the golden set
   with the Thai slice reported separately, then a gateway canary with automatic revert.
3. Vendor or tool switches: total cost of ownership including migration time, contract exit and data residency (PDPA).

## Measure outcomes, not tokens
Cost per resolved signal, cost per 1,000 guest chats, cost per merged PR. A cheaper call that needs retries is not
cheaper.

## Decision rule for model swaps
Switch only if the candidate is within 2 points of the baseline on overall accuracy AND on the Thai slice, the lower
bound of the Thai difference CI is above -5 points, and the savings repay migration effort within 3 months.

## Approval
Model or tool swaps are L3: the service owner approves and the change ships through the gateway canary
(25% -> 50% -> 100%) with online-eval watch.
