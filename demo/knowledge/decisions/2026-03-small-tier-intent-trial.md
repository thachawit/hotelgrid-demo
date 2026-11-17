# Decision 2026-03-18: small tier for guest intent classification — REJECTED

Owner: team-guest-ai · Reviewer: team-finops

## What we tried
Routed assistant.intent to the small tier for 10% of traffic at the pilot hotel for one week.

## Result
English intent accuracy held within 1 point. Thai accuracy dropped by about 15 points; Thai guests are roughly half of
chat volume at Bangkok properties. Complaints about "the bot misunderstood me" doubled in LINE.

## Decision
Rejected. Any future model swap on a guest-facing route must report the Thai slice separately with its own pass bar
(non-inferiority margin 2 points) and must ship behind a gateway canary with automatic revert.

## Lesson
Aggregate accuracy hid the Thai regression. Always slice by language.
