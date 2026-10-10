# Spec

How the game works **now**, one file per system. Code and docs cite a section by its anchor,
`§mess-call`, and `pnpm lint` fails on an anchor that names no heading here
(`scripts/check-refs.mjs`).

| File | Covers |
|---|---|
| `architecture.md` | kernel and hosts, run-ahead and playback, saves and migrations, content loading and validation, the API and its build, dev instruments |
| `narrator-calls.md` | hooks, when the narrator is called, the call path, transport, retries and failure, models and budgets |
| `narrator-story.md` | the narrator's levers and the translator, the digest, notes, threads and arcs, card history, prompt rules, the staging prompt |
| `cards.md` | decisions on screen: card shape, sides and effects, aftermath, the queue, policy decisions, cards delivered in person |
| `commerce.md` | jobs and offers, passages, pay, markets and buying, reserves |
| `travel.md` | ports and routes, voyages, travel stages, departure prep and the departure gate, course plotting |
| `dockside.md` | dock maps, the graft, locals, the floor set, dock hands, staging, the captain ashore |
| `equipment.md` | machines, faults, symptoms, heat, integrity, diagnosis, repair, parts and tools, servicing |
| `work.md` | problems, tasks, claims, activities, the planner, supplies, the hand truck, what crew know |
| `ship.md` | the hull contract, the ships, berths and lockers, the arms locker |
| `time-and-watches.md` | the ship's day, play speed, the watch bill, the bell, the helm |
| `crew-life.md` | needs, thoughts and mood, the galley and mess call, dirt and cleaning, sleep and cabins |
| `social.md` | recreation and activities, interests, affinity, relationships, the private talk |
| `hull-and-field.md` | the asteroid field, the hull bar, scars, ship loss, intercom and reporting |
| `expeditions.md` | bodies and wounds, weapons, landing sites and the Boathouse, the expedition and the muster, the fight, morale and postures, the plan menu |
| `client.md` | the renderer, scene and camera, headline, ship's log, inspector, labels, the phone, dev tools |

## Writing a section

- **Current state, present tense.** What the game does, not how it came to do it. No "now",
  "used to", "no longer", "was renamed"; no prompt or schema version numbers; no measurements,
  playthrough reports or test lists. Git history keeps those.
- **Headings are anchors.** `##` for an area, `###` for a mechanic. The anchor is the GitHub slug
  of the heading (lowercase, punctuation dropped, spaces to hyphens), so keep code and
  punctuation out of headings. Anchors are unique across every file here: name the mechanic
  specifically ("Galley provisions", not "Provisions"). Renaming a heading means updating every
  `§` citation of it; the check finds them.
- **Precise where it matters.** Name config keys with their defaults (`galley.lowBelowDays`, 2),
  events, commands, problems and code locations when a reader would need them to find the code.
  Rules and their edge cases, yes; implementation walk-throughs, no: the code is the detail.
- **Why, briefly, when it is not obvious.** One or two sentences after the rule, starting
  "Why:": a rejected alternative, the failure it prevents, or the owner's ruling (quote it when
  the words are the reason). A choice that constrains the whole design belongs in
  `docs/DECISIONS.md` instead and is cited as `D<n>`.
- **Cross-reference, do not repeat.** Each fact lives in one section; others cite it with
  `§<anchor>`.
- **Short.** Plain prose and bullets, lines wrapped at 100 columns, as the rest of `docs/`.

## What goes in `docs/DECISIONS.md` instead

A decision is a choice between real alternatives that shapes much of the design and that someone
would otherwise reopen: the stack, determinism, the narrator's authority, an owner ruling that
rules something out. It records the choice, what was rejected and why, in a few lines. How a
mechanic works is never a decision; it goes here.
