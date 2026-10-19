# Outlines follow a lifecycle: topics, stages and links

An outline used to be a free tree of nodes, so nothing in it said where the work stood (still deciding, planning, building, checking) or what a change upstream did to the work built on it. We are making every outline a set of **topics**, each going through the stages of one fixed lifecycle, with **links** from each node to the nodes it comes from. The server keeps the shape and the links; the skill decides what is a topic and what the work means. [The plan](../plans/lifecycle.md) has the steps; the terms are in [CONTEXT.md](../../CONTEXT.md).

## Decisions

- **Every outline has a lifecycle, and today's outlines need no migration.** An outline nobody chose stages for is one topic with Discussion alone, and the page shows neither the topic nor the stage: it reads as it does today.
- **One chain for all work:** Discussion, Plan, Implementation, Verification, Preservation, each turned on or off per topic. There are no lifecycles per domain and no definition format; presets are text in the workflow skill. The agent may turn a stage on, never off; only the user turns one off, on the page or by saying so (recorded as the user's act, as `record` is). A stage turned off keeps its nodes.
- **Stages never go backwards.** A topic's stages are in order, and a topic placed inside a stage starts at that stage or later. Links point upstream only, to an earlier stage or the same one, and never form a loop. Dependencies between topics never form a loop either.
- **Inside a topic, nodes are kept by stage; nesting is a layout.** Tasks (and checks, which are tasks) live only in Implementation, Verification and Preservation; plan items only in Plan. The page draws a topic by stage or by plan item from the links. Only what is a topic of its own is the agent's to arrange. There are no containers: a topic holds topics only inside its stages.
- **Stages are headings with fixed numbers, and the depth limit is ten.** A stage's number is its place in the chain, so adding a decision never renumbers a plan item. Past six levels a heading is written with `######` and its level read from its full number, so storage stays markdown ([ADR 0003](0003-the-server-owns-the-outline.md)).
- **Links hold stable ids**, written as a tag on each node; the page shows a link by the node's current number.
- **A ripple never adds to the action queue** ([ADR 0004](0004-the-server-lists-the-pending-actions.md) stands). What needs the user is a pending action already; every other node a ripple reaches is marked "needs review", and the agent clears each mark by changing the node or saying it still holds.

## Considered Options

- **A lifecycle per domain (coding, UI, strategy) defined in data files**, as the handoff proposed. Rejected: one chain with toggles says the same, and the server then needs no schema and no rules per domain.
- **Containers that hold topics and no stages.** Rejected: a Discussion that holds shared decisions beside its subtopics does the same with one rule fewer.
- **Stages as tags rather than headings**, to save a level per topic. Rejected: every new decision would renumber the plan items after it.
- **A "review" pending action for nodes a ripple reached.** Rejected: one ripple would fill the queue with items to read, which ADR 0004 ruled out.

## Consequences

Numbers are no longer fully dense: a topic's stages keep their place in the chain with gaps for stages not on. An outline is renumbered once, the first time it gets a second topic or a second stage, as its nodes move under their stage; ids keep every link, and the page's per-node state follows the new numbers as it does after a move. An outline from before may hold tasks outside the doing stages; they are left where they are, and the rule applies to tasks added after. The mechanical skill's "a topic is a top-level node" no longer holds.
