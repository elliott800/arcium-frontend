# Pinned list layers

**Source:** Data Hub brief (Nov 17), "Proposed improvement: pin another list as a top tree layer".
**State:** proposed.

Let any drill view load one or more saved watchlists, bundles or trackers as extra top-level layers, each
drilled on its own, without leaving the current search. Today each list can be drilled only in its own place:
watchlists in the Portfolio Maker, bundles in the Recorder, trackers nowhere.

## How it would work

1. A **"Pin a list" control** above every drill table opens a picker of all hub lists, grouped Watchlists /
   Bundles / Trackers, with search.
2. Each pinned list becomes a **top tree layer** named after it, e.g. `★ Yahoo Nasdaq 100 (bundle)`, above
   the view's own top level.
3. Under it, the list's members drill exactly like the view's own items (Instrument/Reference → … → data
   stream), so the same rate checklists and selection work.
4. The **current search still applies** inside every layer, so a tag query narrows the pinned lists too.
5. **Unpin** removes the layer; pins are kept per view per user, like a remembered tab.

## Why it is cheap to build

All three are already hub lists (`wh_lists` + `wh_list_members`), the Recorder already turns a list's members
into drill branches, and the drill tree (`src/lib/drillTree.ts`) already supports a lazily loaded top layer.
The work is the picker, a `pinned` layer in each view's tree, and remembering the pins (user preferences).

## Decisions for the owner

- Read-only layers, or allow recording switches inside a pinned layer?
- Should trackers get their own full view as well, beside the pin?
- Pins per user, or shared across the workspace?
