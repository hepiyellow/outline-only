# Plan — Lifecycle: topics, stages and links

**Status:** designed, not started. · **Source:** [Live Outline — Lifecycle & Tree Rules Handoff](https://claude.ai/code/artifact/be34c566-6753-4ce9-8286-eeced4bc91be) (2026-10-19), grilled 2026-10-20 · **Decisions:** [ADR 0005](../adr/0005-outlines-follow-a-lifecycle.md), with [ADR 0003](../adr/0003-the-server-owns-the-outline.md) and [ADR 0004](../adr/0004-the-server-lists-the-pending-actions.md) standing · **Terms:** [CONTEXT.md](../../CONTEXT.md)

## Goal

Every outline is made of **topics**, each going through the stages of one lifecycle (Discussion → Plan → Implementation → Verification → Preservation, each turned on or off per topic), and every node links to the nodes it comes from. When something changes upstream, the outline shows what it reached downstream, and the overview traces any node back to what led to it. The server guarantees the shape; the skill supplies the meaning.

Server mode only. File mode is being retired ([two-modes](two-modes.md)) and gets none of this.

## Where things stand

- **The model** (`model.js`) is a tree of numbered headings, at most six levels deep, stored as markdown; the level is the count of `#` signs. A node has one kind (plain, claim, question, option, task), written as tags on its heading line. Numbers are dense.
- **The agent** sends `change` with nine operations; a refused operation says why and what to do, which is the error path every rule below uses.
- **The queue** is the pending actions only, listed by the server and ordered by the agent (ADR 0004).
- **None of this plan exists yet:** no ids, links, topics, stages, overview or layouts.

## What was decided

Each term below is in `CONTEXT.md`; the hard-to-reverse ones are in ADR 0005.

| Question | Decision |
| --- | --- |
| Which outlines have a lifecycle | All. One nobody chose stages for is one topic with Discussion alone, which the page does not show: today's outlines read as before. |
| Scope or topic | **Topic** is the unit of work; "a top-level node" is no longer its meaning. |
| Lifecycles per domain | One chain for all work. **Presets** (coding, strategy) are text in the workflow skill; a topic stores which stages are on. |
| Who changes a topic's stages | The agent picks them and may turn a stage on; only the user turns one off (page, or by saying so, recorded as theirs). Discussion may be off, for work decided outside the outline. At least one stage stays on. |
| A stage turned off | Keeps its nodes folded away, asks nothing, comes back as it was. |
| Order | Stages never go backwards: in order within a topic, and a topic inside a stage starts at that stage or later. |
| Where nodes sit | Discussion: questions, decisions, claims, subtopics. Plan: **plan items** (no Run button). Implementation, Verification, Preservation: **tasks**; a **check** is a task in Verification. Questions and claims may sit in any stage. |
| Nested or sibling | Nodes are kept by stage; "by plan item" is a **topic layout** the page draws from the links. Plan items never become topics. No containers. |
| **Decision** | A claim in Discussion, approved or not, or the picked option of a question there. No D-labels. |
| **Link** | Stable id, points upstream only (earlier stage or same), no loops, may cross topics. |
| **Trace** / **Overview** | Ancestors and descendants through links, branching both ways, drawn in one band per stage in a side panel opened from any node. |
| **Ripple** | Never queued (ADR 0004 stands). Nodes reached are marked "needs review"; the agent clears each mark by changing the node or saying it holds. |
| Stage status | Not started (next one dimmed), active, done; doing stages are done when their tasks are, Discussion and Plan when the agent says so (not while Discussion has an unresolved question); needs review overrides. The user can reopen; a new node reopens. |
| **Dependency** | Set by the agent, or made by a link into another topic. No loops. A badge only; topics are never reordered for it. |
| **Split** / **Merge** | The agent splits a part that can be done and verified alone into a sibling topic (Discussion off, links back). The user merges, on the page or by saying so. |
| **Topic notes** | One file per project in the outlines folder; the agent adds a line per merge or rejected split, reads them before making topics. |
| Depth | Stages are headings with fixed numbers (Discussion .1 … Preservation .5). Limit 10 levels: past six, `######` and the level read from the number. |

## How to work

- On `main`, one commit per step, in order. Use the glossary's terms in code, comments and commits.
- Take a baseline `npm test` run first (with `PLAYWRIGHT_CHROMIUM` set to Google Chrome); about 31 tests already fail on `HEAD`. After each step, compare against it.
- Page work goes in `web/src` only.
- Every step is a vertical slice: model rule, MCP schema and descriptions, map text, page, skill lines and tests, so each is usable when it lands.

## Steps

### 1. Stable ids and links

Useful on today's outlines, and everything after depends on it.

- `model.js`: the server gives every node an id on `add`, and on the first read of an older outline; `@id:` is parsed and written like the other tags. Ids survive every move, removal and renumbering.
- `add` and `update` take `links`: node numbers or ids, stored as ids (`@links:`). Refused: a target that does not exist, and a link that closes a loop. A link to a node later removed is dropped, with a note in the result.
- `read` and the map show links by current number.
- Page: a node's links as chips ("from 2.1, 2.4") and the reverse on the linked node ("used by 3.2"), each a click to that node.

**Checks:** ids round-trip through parse and serialize; after a move the links still point at the same nodes; a missing target and a loop are refused with a hint.

### 2. Ten levels

- The parser reads a heading's level from its full number when it has one, and the `#` count otherwise; the writer caps `#` at six. `MAX_LEVEL` becomes 10.
- The page indents levels past six less on a narrow window.

**Checks:** a level-8 node round-trips; an eleventh level is refused.

### 3. Topics and stages in the model

- Tags: `@topic` with `@stages:` (the stages on) on a topic's heading; a stage heading is `@stage:<name>`, numbered by its place in the chain. The one topic of a plain outline and its Discussion are not written, so today's files parse unchanged.
- Operations: `add` with `stages` makes a topic; `stages { num, on }` turns stages on (the agent cannot turn one off); `record` gains `stage-off` and `merge` for what the user said in chat; `done { num }` closes a Discussion or Plan stage.
- Rules, each refused with a hint: stages in order and once; a topic inside a stage starts at that stage or later; tasks only in Implementation, Verification and Preservation; plan items only in Plan; links upstream only; at least one stage on; `done` on a Discussion with an unresolved question.
- Status per stage, as decided; a doing stage's progress (3 of 7 done) for the page.
- The first time an outline gets a second topic or a second stage, its nodes move under their stage and are renumbered once; the result lists the numbers that changed.
- Tasks in older outlines outside the doing stages are left where they are.
- Mechanical skill: topics, stages, where each node sits, links, and that "a topic is a top-level node" is gone. Workflow skill: the presets, and when a part of the work is a topic of its own.

**Checks:** every refusal has a test with its hint; a plain outline round-trips byte for byte; the one-time renumbering keeps every link.

### 4. Topics and stages on the page

- Stage rows with their status; the next stage dimmed; done stages collapsed to one line; stages turned off folded and dimmed. A plain outline looks as it does today.
- A topic row with its stages; the user turns a stage on or off there (turning one off is an action, written in the action log).
- The one topic is not shown; its stage rows show once a second stage is on.

**Checks:** a browser test per status, for turning a stage off and on, and for a plain outline unchanged.

### 5. Dependencies

- `depends { num, on }` sets a topic's dependencies; a link into another topic makes one by itself. Loops are refused.
- Page: a "waits for 1, 2" badge on the topic; no reordering.

### 6. Ripples and soft flags

- When a node changes (reworded, reopened, a check failed), the server marks every node that comes from it "needs review", with their stages; the page opens a collapsed stage it reaches. The tool result lists the marks, upstream first.
- `holds { num }` clears a mark when the node still holds; changing the node clears it too. The turn-end hook holds a turn open once over marks left unaddressed, as it does for unplaced queue items.
- Soft flags, as badges, never refused: a decision nothing in an active Plan comes from; a plan item that comes from no decision while Discussion is on; a plan item built on a claim the user has not approved; a task in Implementation that carries out no plan item while Plan is on; a task no check covers while Verification is on.
- Nothing here touches the queue.

### 7. Layouts and stage view

- Per topic, **by stage** or **by plan item** (each plan item with its tasks, then their checks, under it), same numbers; a task that carries out two plan items shows under each, marked shared.
- Across the outline, stage view: all nodes of one stage from every topic, each labeled with its topic, with a filter by topic.
- The choices are viewer state.

### 8. Overview

- A mock-up first, for the user to approve: the side panel on one wide canvas that pans in, covering the outline on a narrow window with a swipe back.
- An overview button on every node opens its trace: one band per stage from the top down, a box per linked node naming its topic, the clicked node marked, lines for the links, a long band as a count until opened. On a topic, the boxes are the topics it depends on and those that depend on it.

### 9. Split and merge

- `split { num, title, nodes }`: the nodes listed move into a new sibling topic with Discussion off; links and ids move with them; shared decisions stay where they are.
- Merge from the page (and `record` with `merge` for the user's word in chat): two topics combined stage by stage, numbers changed, ids kept, written in the action log.

### 10. Topic notes

- One file per project in the outlines folder. The agent adds a line after each merge or rejected split; the workflow skill tells it to read the notes before making topics.

## Not covered here

What Verification and Preservation hold outside code is for each workflow skill to say. A preset menu on the page can come later, on top of the workflow skill's presets.
