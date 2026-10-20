import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { OpError, allNodes, applyOperations, applyUserSet, findNode, lifecycleOf, mapText, nodeHash, normalize, parseOutline, readText, serializeOutline } from '../model.js'
import { countCheckboxProgress, outlinePayload } from '../outline.js'
import { FIXTURES, ROOT, inServerMode } from './helpers.js'

// The lifecycle of an outline (docs/plans/lifecycle.md, ADR 0005), as the model keeps it: links, levels, topics and
// stages, dependencies, ripples, split and merge.

const HEAD = 'Title: Lifecycle\nMode: server\n\n'

/** A model from an outline's text. */
const outline = body => parseOutline(HEAD + body)

/** Applies operations as `change` does: to the model, then the server's own rules. Returns the result. */
function change(model, ops, shown) {
    const result = applyOperations(model, ops, shown ?? everyNodeSeen(model))
    normalize(model, result.touched)
    return result
}

/** The stale-write guard's record of a model whose every node the agent has seen. */
const everyNodeSeen = model => Object.fromEntries(allNodes(model.nodes).map(n => [n.num, nodeHash(n)]))

/** Asserts that the operations are refused, with a reason matching `reason` and a hint matching `hint`. */
function refused(model, ops, reason, hint) {
    assert.throws(
        () => applyOperations(structuredClone(model), ops, everyNodeSeen(structuredClone(model))),
        e => {
            assert.ok(e instanceof OpError, e.stack)
            assert.match(e.message, reason)
            if (hint) assert.match(e.hint, hint)
            return true
        },
    )
}

const PLAIN = `# 1. Goals

## 1.1 @agent-claim Fast answers

## 1.2 Fresh results

# 2. Plan

## 2.1 Cache in Redis

## 2.2 Measure the hit rate
`

describe('a plain outline from before', () => {
    // serialized/ holds what the server wrote of each fixture before outlines had a lifecycle.
    for (const [name, from] of [
        ['sample.md', path.join(FIXTURES, 'outlines/demo/sample.md')],
        ['sample-edited.md', path.join(FIXTURES, 'outlines/demo/sample-edited.md')],
        ['rate-limiting.md', path.join(ROOT, 'examples/demo/rate-limiting.md')],
    ])
        test(`parses and serializes byte for byte as before: ${name}`, () => {
            const before = fs.readFileSync(path.join(FIXTURES, 'serialized', name), 'utf8')
            assert.equal(serializeOutline(parseOutline(inServerMode(fs.readFileSync(from, 'utf8')))), before)
            // What the server wrote reads back as itself.
            assert.equal(serializeOutline(parseOutline(before)), before)
        })

    test('gets no ids and no links by being read or changed', () => {
        const model = outline(PLAIN)
        change(model, [{ op: 'update', num: '1.2', text: 'Within a minute.' }])
        assert.doesNotMatch(serializeOutline(model), /@id:|@links:/)
    })
})

describe('stable ids and links', () => {
    test('links name nodes by number and are kept as ids, which round-trip through parse and serialize', () => {
        const model = outline(PLAIN)
        const result = change(model, [{ op: 'add', num: '2.3', title: 'Warm the cache', links: ['2.1', '1.1'] }])
        assert.deepEqual(result.notes, [])
        const text = serializeOutline(model)
        const target = findNode(model, '2.1')
        assert.match(target.id, /^[a-z0-9]{6}$/)
        assert.match(text, new RegExp(`^## 2\\.1 @id:${target.id} Cache in Redis$`, 'm'))
        assert.match(text, new RegExp(`^## 2\\.3 @current @links:${target.id},${findNode(model, '1.1').id} Warm the cache$`, 'm'))
        // The claim keeps its tags before the id.
        assert.match(text, /^## 1\.1 @agent-claim @id:[a-z0-9]{6} Fast answers$/m)
        const again = parseOutline(text)
        assert.equal(serializeOutline(again), text)
        assert.deepEqual(findNode(again, '2.3').links, [target.id, findNode(model, '1.1').id])
        // The page reads them too, and they stay out of the title.
        const page = outlinePayload(text)
        const node = page.nodes[1].children[2]
        assert.equal(node.title, 'Warm the cache')
        assert.deepEqual(node.links, findNode(model, '2.3').links)
        assert.equal(page.nodes[1].children[0].id, target.id)
    })

    test('an id is given once, and the node keeps it', () => {
        const model = outline(PLAIN)
        change(model, [{ op: 'add', num: '2.3', title: 'Warm the cache', links: ['2.1'] }])
        const id = findNode(model, '2.1').id
        change(model, [{ op: 'add', num: '2.4', title: 'Size the cluster', links: ['2.1'] }])
        assert.equal(findNode(model, '2.1').id, id)
        assert.equal(findNode(model, '2.4').links[0], id)
    })

    test('after a move and a removal the links still point at the same nodes', () => {
        const model = outline(PLAIN)
        change(model, [{ op: 'add', num: '2.3', title: 'Warm the cache', links: ['2.1', '1.2'] }])
        const result = change(model, [
            { op: 'move', num: '2.1', under: '1' },
            { op: 'remove', num: '1.1' },
        ])
        // 2.1 went to 1.3, then 1.2 and 1.3 moved up one; 2.2 and 2.3 moved up to 2.1 and 2.2.
        assert.equal(findNode(model, '1.2').title, 'Cache in Redis')
        assert.equal(findNode(model, '1.1').title, 'Fresh results')
        assert.equal(result.renumbered.get('2.3'), '2.2')
        const warm = findNode(model, '2.2')
        assert.equal(warm.title, 'Warm the cache')
        assert.deepEqual(
            warm.links.map(id => findNode(model, ['1.1', '1.2'].find(n => findNode(model, n).id === id)).title),
            ['Cache in Redis', 'Fresh results'],
        )
        assert.match(mapText(model), /^ {2}2\.2 Warm the cache \[open\] \(from 1\.2, 1\.1\)/m)
    })

    test('read shows a node’s links by current number, both ways', () => {
        const model = outline(PLAIN)
        change(model, [{ op: 'add', num: '2.3', title: 'Warm the cache', links: ['2.1'] }])
        assert.match(readText(model, '2.3').text, /^2\.3 Warm the cache \[open\]\nLinks: from 2\.1$/m)
        assert.match(readText(model, '2.1').text, /^2\.1 Cache in Redis \[open\]\nLinks: used by 2\.3$/m)
    })

    test('a link to a node that is not there, or to the node itself, is refused with a hint', () => {
        const model = outline(PLAIN)
        refused(model, [{ op: 'add', num: '2.3', title: 'Warm the cache', links: ['2.9'] }], /links to "2\.9", and there is no such node/, /The nodes are:\n1 Goals/)
        refused(model, [{ op: 'update', num: '2.1', links: ['2.1'] }], /links to itself/, /another node/)
        refused(model, [{ op: 'update', num: '2.1', links: '1.1' }], /are not a list/, /links: \["2\.1"/)
    })

    test('a link that closes a loop is refused with a hint', () => {
        const model = outline(PLAIN)
        change(model, [
            { op: 'update', num: '2.1', links: ['1.1'] },
            { op: 'update', num: '2.2', links: ['2.1'] },
        ])
        refused(model, [{ op: 'update', num: '1.1', links: ['2.2'] }], /A link from node 1\.1 to 2\.2 would close a loop: 2\.2 already comes from 1\.1/, /Links point upstream only/)
    })

    test('a link to a node later removed is dropped, with a note in the result', () => {
        const model = outline(PLAIN)
        change(model, [{ op: 'add', num: '2.3', title: 'Warm the cache', links: ['2.1', '1.1'] }])
        const result = change(model, [{ op: 'remove', num: '2.1' }])
        assert.deepEqual(result.notes, ['2.2 no longer links to 2.1, which was taken out.'])
        assert.equal(findNode(model, '2.2').links.length, 1)
    })

    test('the children and options of an add link to each other by their numbers', () => {
        const model = outline(PLAIN)
        change(model, [{ op: 'add', num: '3', title: 'Rollout', children: [{ title: 'Behind a flag' }, { title: 'Turn it on', links: ['3.1'] }] }])
        assert.equal(findNode(model, '3.2').links[0], findNode(model, '3.1').id)
    })
})

/** An outline with one chain of nodes `depth` levels deep: 1, 1.1, 1.1.1, … */
function chain(depth) {
    const lines = []
    for (let level = 1; level <= depth; level++) {
        const num = Array(level).fill(1).join('.')
        lines.push(`${'#'.repeat(Math.min(level, 6))} ${num}${level === 1 ? '.' : ''} Level ${level}`, '')
    }
    return lines.join('\n')
}

describe('ten levels', () => {
    test('a level-8 node round-trips: written with six # signs, its level read from its number', () => {
        const model = outline(chain(8))
        const deep = findNode(model, '1.1.1.1.1.1.1.1')
        assert.equal(deep.level, 8)
        assert.equal(findNode(model, '1.1.1.1.1.1.1').children[0], deep)
        const text = serializeOutline(model)
        assert.match(text, /^###### 1\.1\.1\.1\.1\.1\.1\.1 Level 8$/m)
        assert.equal(text, HEAD + chain(8))
        // The page reads it as deep, under its parent.
        let node = outlinePayload(text).nodes[0]
        while (node.children.length) node = node.children[0]
        assert.equal(node.level, 8)
        assert.equal(node.num, '1.1.1.1.1.1.1.1')
    })

    test('a heading of six # signs with a number of six parts or fewer reads as before', () => {
        const model = outline('# 1. Top\n\n###### 1.1 Too many signs\n')
        assert.equal(findNode(model, '1.1').level, 6)
        assert.equal(serializeOutline(model), HEAD + '# 1. Top\n\n###### 1.1 Too many signs\n')
    })

    test('nodes are added down to the tenth level, and an eleventh is refused', () => {
        const model = outline(chain(9))
        change(model, [{ op: 'add', num: '1.1.1.1.1.1.1.1.1.1', title: 'Level 10' }])
        assert.equal(findNode(model, '1.1.1.1.1.1.1.1.1.1').level, 10)
        refused(model, [{ op: 'add', num: '1.1.1.1.1.1.1.1.1.1.1', title: 'Level 11' }], /would be 11 levels deep; nodes nest at most 10/, /bullets/)
        refused(model, [{ op: 'add', num: '2', title: 'Deep', children: [{ title: 'a', children: [{ title: 'b', children: [{ title: 'c', children: [{ title: 'd', children: [{ title: 'e', children: [{ title: 'f', children: [{ title: 'g', children: [{ title: 'h', children: [{ title: 'i', children: [{ title: 'j' }] }] }] }] }] }] }] }] }] }] }], /11 levels deep/)
    })

    test('a move that would take nodes past the tenth level is refused', () => {
        const model = outline(chain(6) + '\n# 2. Branch\n\n## 2.1 Down\n\n### 2.1.1 Further\n\n#### 2.1.1.1 Still\n\n##### 2.1.1.1.1 Deepest\n')
        refused(model, [{ op: 'move', num: '2', under: '1.1.1.1.1.1' }], /deeper than 10 levels/, /higher up/)
        change(model, [{ op: 'move', num: '2.1.1', under: '1.1.1.1.1.1' }])
        assert.equal(findNode(model, '1.1.1.1.1.1.1.1.1').level, 9)
    })
})

describe('topics and stages', () => {
    const stagesOn = model => lifecycleOf(model).stages

    test('the first second stage writes the outline’s one topic: its nodes move under 1.1 and are renumbered once, links kept', () => {
        const model = outline(PLAIN)
        change(model, [{ op: 'add', num: '2.3', title: 'Warm the cache', links: ['1.1'] }])
        const result = change(model, [{ op: 'stages', on: ['plan'] }])
        const text = serializeOutline(model)
        assert.match(text, /^# 1\. @current @topic @stages:discussion,plan @id:[a-z0-9]{6} Lifecycle$/m)
        assert.match(text, /^## 1\.1 @stage:discussion Discussion$/m)
        assert.match(text, /^### 1\.1\.1 Goals$/m)
        assert.match(text, /^#### 1\.1\.1\.1 @agent-claim @id:[a-z0-9]{6} Fast answers$/m)
        assert.match(text, /^## 1\.2 @stage:plan Plan$/m)
        assert.deepEqual([...result.renumbered].slice(0, 3), [['1', '1.1.1'], ['1.1', '1.1.1.1'], ['1.2', '1.1.1.2']])
        assert.match(result.notes[0], /its nodes moved under 1\.1, the Discussion of topic 1/)
        // The link goes with the nodes.
        assert.equal(findNode(model, '1.1.2.3').links[0], findNode(model, '1.1.1.1').id)
        assert.equal(serializeOutline(parseOutline(text)), text)
        assert.deepEqual(stagesOn(model), {
            1.1: { topic: '1', name: 'discussion', on: true, status: 'active' },
            1.2: { topic: '1', name: 'plan', on: true, status: 'not-started', next: true },
        })
        assert.match(mapText(model), /^1 Lifecycle \[topic, stages on: discussion, plan\]/m)
        assert.match(mapText(model), /^ {2}1\.2 Plan \[stage, not started\]$/m)
    })

    test('a second topic writes the first: the new one is 2, and starts with the stages it is given', () => {
        const model = outline(PLAIN)
        refused(model, [{ op: 'add', num: '3', title: 'Rollout', stages: ['plan', 'implementation'] }], /next free number at the top level is 2/, /became topic 1 \(under 1\.1, its Discussion\) to stand beside it, so add it as 2/)
        change(model, [{ op: 'add', num: '2', title: 'Rollout', stages: ['plan', 'implementation'] }])
        const text = serializeOutline(model)
        assert.match(text, /^# 2\. @current @topic @stages:plan,implementation @id:[a-z0-9]{6} Rollout$/m)
        assert.match(text, /^## 2\.2 @stage:plan Plan\n\n## 2\.3 @stage:implementation Implementation$/m)
        assert.doesNotMatch(text, /^## 2\.1 /m)
        assert.equal(findNode(model, '1.1.2').title, 'Plan')
        // An empty outline's first topic is topic 1 itself.
        const empty = outline('')
        change(empty, [{ op: 'add', num: '1', title: 'Search', stages: ['discussion', 'plan'] }])
        assert.equal(empty.nodes.length, 1)
        assert.deepEqual(empty.nodes[0].children.map(c => c.num), ['1.1', '1.2'])
    })

    test('nodes go under a stage, and each stage holds only what may sit there', () => {
        const model = outline('')
        change(model, [{ op: 'add', num: '1', title: 'Search', stages: ['discussion', 'plan', 'implementation', 'verification'] }])
        change(model, [
            { op: 'add', num: '1.1.1', title: 'Use Redis', status: 'claim' },
            { op: 'add', num: '1.2.1', title: 'Size the cluster', plan: true, links: ['1.1.1'] },
            { op: 'add', num: '1.2.2', title: 'Plans may hold claims', status: 'claim' },
            { op: 'add', num: '1.3.1', title: 'Write the client', task: 'Writes the cache client.', links: ['1.2.1'] },
            { op: 'add', num: '1.4.1', title: 'Run the tests', task: 'Runs the tests.', links: ['1.3.1'] },
            { op: 'add', num: '1.2.3', title: 'What the plan leaves out' },
        ])
        assert.match(serializeOutline(model), /^### 1\.2\.1 @plan-item @id:[a-z0-9]{6} @links:[a-z0-9]{6} Size the cluster$/m)
        assert.match(mapText(model), /^ {4}1\.2\.1 Size the cluster \[plan item, open\] \(from 1\.1\.1\)$/m)
        refused(model, [{ op: 'add', num: '1.1.2', title: 'Deploy', task: 'Deploys it.' }], /1\.1\.2 is a task, and Discussion holds no tasks/, /Implementation, Verification \(where a task is a check\) and Preservation: place it under 1\.3 Implementation, 1\.4 Verification/)
        refused(model, [{ op: 'add', num: '1.2.4', title: 'Deploy', task: 'Deploys it.' }], /Plan holds no tasks/)
        refused(model, [{ op: 'add', num: '1.3.2', title: 'Cache keys', plan: true }], /only a Plan stage holds plan items/, /Place it under 1\.2 Plan/)
        refused(model, [{ op: 'update', num: '1.1.1', plan: true }], /only a Plan stage holds plan items/)
        refused(model, [{ op: 'update', num: '1.2.3', task: 'Does it.' }], /1\.2\.3 is a task, and Plan holds no tasks/)
        refused(model, [{ op: 'update', num: '1.2.1', task: 'Does it.' }], /is a plan item, so it cannot become a task too/)
        refused(model, [{ op: 'finish', num: '1.1.1', outcome: 'Done.' }], /claim/)
        refused(model, [{ op: 'add', num: '1.2.4', title: 'A task plan', plan: true, task: 'Does it.' }], /added as a plan item and as a task/)
        refused(model, [{ op: 'add', num: '2', title: 'Loose node' }], /the top level of this outline holds topics/, /Add it under a stage of a topic, such as 1\.1/)
        refused(model, [{ op: 'add', num: '1.6', title: 'Under the topic' }], /Under the topic 1 stand its stages, not nodes/, /1\.1 Discussion, 1\.2 Plan/)
        refused(model, [{ op: 'add', num: '1.5.1', title: 'Commit' }], /There is no parent 1\.5/)
        refused(model, [{ op: 'move', num: '1.3.1', under: '1.1' }], /Discussion holds no tasks/)
        refused(model, [{ op: 'move', num: '1.2', under: '1.3' }], /a stage stays in its topic/)
        refused(model, [{ op: 'remove', num: '1.2' }], /a stage is never taken out: only the user turns one off/)
        refused(model, [{ op: 'update', num: '1.2', title: 'Planning' }], /is a stage: its heading is its name/)
        refused(model, [{ op: 'update', num: '1', task: 'Does it.' }], /is a topic, and a topic has no task/)
        refused(model, [{ op: 'update', num: '1.1.1', links: ['1'] }], /which is a topic/, /link to the nodes in it/)
        refused(model, [{ op: 'finish', num: '1.2', outcome: 'Planned.' }], /is a stage, not a task/, /\{ op: "done", num: "1\.2" \}/)
    })

    test('a plan item in an outline without topics is refused: it has no Plan', () => {
        refused(outline(PLAIN), [{ op: 'add', num: '2.3', title: 'Cache keys', plan: true }], /this outline has no Plan/, /Turn Plan on first/)
    })

    test('links point upstream only, to the same stage or an earlier one, across topics too', () => {
        const model = outline('')
        change(model, [
            { op: 'add', num: '1', title: 'Search', stages: ['discussion', 'plan'] },
            { op: 'add', num: '1.1.1', title: 'Use Redis', status: 'claim' },
            { op: 'add', num: '1.2.1', title: 'Size the cluster', plan: true, links: ['1.1.1'] },
            { op: 'add', num: '2', title: 'Rollout', stages: ['discussion', 'implementation'] },
            { op: 'add', num: '2.3.1', title: 'Deploy', task: 'Deploys it.', links: ['1.2.1'] },
        ])
        refused(model, [{ op: 'add', num: '1.1.2', title: 'Eviction', links: ['1.2.1'] }], /1\.1\.2 \(Discussion\) would link to 1\.2\.1 \(Plan\), a later stage/, /upstream only/)
        refused(model, [{ op: 'add', num: '2.1.1', title: 'Regions', links: ['2.3.1'] }], /\(Discussion\) would link to 2\.3\.1 \(Implementation\)/)
        // A move that would leave a link pointing downstream is refused too.
        refused(model, [{ op: 'move', num: '1.1.1', under: '2.3' }], /a later stage/)
    })

    test('stages are given in order, each once, from the lifecycle’s', () => {
        const model = outline('')
        refused(model, [{ op: 'add', num: '1', title: 'Search', stages: ['plan', 'discussion'] }], /out of order: discussion comes after plan/, /Stages never go backwards/)
        refused(model, [{ op: 'add', num: '1', title: 'Search', stages: ['plan', 'plan'] }], /list plan twice/, /once/)
        refused(model, [{ op: 'add', num: '1', title: 'Search', stages: ['review'] }], /"review" is not a stage/, /discussion, plan, implementation, verification, preservation/)
        refused(model, [{ op: 'add', num: '1', title: 'Search', stages: [] }], /not a list of stages/)
        refused(model, [{ op: 'add', num: '1', title: 'Search', stages: ['plan'], children: [{ title: 'x' }] }], /a topic holds its nodes in its stages/, /in this same change/)
    })

    test('a topic placed inside a stage starts at that stage or a later one', () => {
        const model = outline('')
        change(model, [{ op: 'add', num: '1', title: 'Search', stages: ['discussion', 'plan'] }])
        refused(model, [{ op: 'add', num: '1.2.1', title: 'Indexing', stages: ['discussion', 'plan'] }], /would start at Discussion inside 1\.2 Plan, and stages never go backwards/, /Plan or later stages only/)
        change(model, [{ op: 'add', num: '1.1.1', title: 'Shared decision', status: 'claim' }, { op: 'add', num: '1.1.2', title: 'Indexing', stages: ['discussion', 'implementation'] }])
        assert.deepEqual(findNode(model, '1.1.2').children.map(c => c.num), ['1.1.2.1', '1.1.2.3'])
        refused(model, [{ op: 'add', num: '1.1.1.1', title: 'Under a node', stages: ['plan'] }], /A topic sits at the top level of the outline or inside a stage, and 1\.1\.1 is a node/)
        change(model, [{ op: 'add', num: '1.2.1', title: 'Rollout', stages: ['plan'] }])
        refused(model, [{ op: 'stages', num: '1.2.1', on: ['discussion'] }], /sits inside 1\.2 Plan, so it cannot turn Discussion on/)
        refused(model, [{ op: 'move', num: '1.1.2', under: '1.2' }], /would start at Discussion, and stages never go backwards/)
        assert.equal(lifecycleOf(model).topics['1.1.2'].title, 'Indexing')
    })

    test('the agent turns stages on and never off; the user turns one off, and it keeps its nodes', () => {
        const model = outline('')
        change(model, [{ op: 'add', num: '1', title: 'Search', stages: ['discussion', 'plan'] }, { op: 'add', num: '1.2.1', title: 'Size it', plan: true }])
        refused(model, [{ op: 'stages', num: '1', off: ['plan'] }], /Only the user turns a stage off/, /decision: "stage-off"/)
        const result = change(model, [{ op: 'stages', num: '1', on: ['verification', 'plan'] }])
        assert.deepEqual(model.nodes[0].stages, ['discussion', 'plan', 'verification'])
        assert.deepEqual(result.notes, ['Plan of 1 is on already.'])
        // What the user said in chat: Plan off. Its nodes stay, folded away, and ask nothing; an empty stage turned off goes.
        const off = change(model, [
            { op: 'record', num: '1', decision: 'stage-off', stage: 'plan' },
            { op: 'record', num: '1', decision: 'stage-off', stage: 'verification' },
        ])
        assert.deepEqual(off.decisions.map(d => [d.what, d.stage, d.num]), [['turned-off', 'plan', '1'], ['turned-off', 'verification', '1']])
        assert.deepEqual(model.nodes[0].children.map(c => c.num), ['1.1', '1.2'])
        assert.equal(lifecycleOf(model).stages['1.2'].status, 'off')
        assert.match(serializeOutline(model), /^# 1\. @current @topic @stages:discussion @id:[a-z0-9]{6} Search$/m)
        refused(model, [{ op: 'add', num: '1.2.2', title: 'More plan', plan: true }], /Plan of 1 is off: the user turned it off/, /on: \["plan"\]/)
        refused(model, [{ op: 'record', num: '1', decision: 'stage-off', stage: 'discussion' }], /only stage on for 1, and a topic always has a stage on/)
        refused(model, [{ op: 'record', num: '1', decision: 'stage-off', stage: 'plan' }], /Plan of 1 is off already/)
        // Turned on again, it is as it was.
        change(model, [{ op: 'stages', num: '1', on: ['plan'] }])
        assert.equal(findNode(model, '1.2.1').title, 'Size it')
        assert.equal(lifecycleOf(model).stages['1.2'].status, 'active')
    })

    test('a stage turned off asks nothing: its pending actions leave the queue', () => {
        const model = outline('')
        change(model, [
            { op: 'add', num: '1', title: 'Search', stages: ['discussion', 'implementation'] },
            { op: 'add', num: '1.3.1', title: 'Deploy', task: 'Deploys it.' },
        ])
        assert.deepEqual(model.queue.map(q => q.num), ['1.3.1'])
        change(model, [{ op: 'record', num: '1', decision: 'stage-off', stage: 'implementation' }])
        assert.deepEqual(model.queue, [])
    })

    test('a stage is not started, active, then done: the doing stages by their tasks, Discussion and Plan when the agent says so', () => {
        const model = outline('')
        change(model, [{ op: 'add', num: '1', title: 'Search', stages: ['discussion', 'plan', 'implementation'] }])
        assert.deepEqual(
            Object.values(lifecycleOf(model).stages).map(s => [s.name, s.status, !!s.next]),
            [['discussion', 'not-started', true], ['plan', 'not-started', false], ['implementation', 'not-started', false]],
        )
        change(model, [
            { op: 'add', num: '1.1.1', title: 'Where to cache', options: [{ title: 'Redis' }, { title: 'Memory' }] },
            { op: 'add', num: '1.3.1', title: 'Write the client', task: 'Writes it.' },
            { op: 'add', num: '1.3.2', title: 'Wire it in', task: 'Wires it.' },
        ])
        refused(model, [{ op: 'done', num: '1.1' }], /1\.1 Discussion has an unresolved question: 1\.1\.1 Where to cache/, /the user picks an option, or you recommend one/)
        refused(model, [{ op: 'done', num: '1.2' }], /holds nothing yet/)
        refused(model, [{ op: 'done', num: '1.3' }], /done once every task in it is/, /Finish its tasks/)
        refused(model, [{ op: 'done', num: '1.1.1' }], /is not a stage/)
        change(model, [{ op: 'update', num: '1.1.1.1', recommended: true }, { op: 'finish', num: '1.3.1', outcome: 'Written.' }])
        assert.deepEqual(lifecycleOf(model).stages['1.3'], { topic: '1', name: 'implementation', on: true, status: 'active', progress: { done: 1, total: 2 } })
        assert.match(mapText(model), /^ {2}1\.3 Implementation \[stage, active, 1 of 2 tasks done\]$/m)
        change(model, [{ op: 'done', num: '1.1' }, { op: 'finish', num: '1.3.2', outcome: 'Wired.' }])
        assert.match(serializeOutline(model), /^## 1\.1 @stage:discussion @stage-done Discussion$/m)
        assert.equal(lifecycleOf(model).stages['1.1'].status, 'done')
        assert.equal(lifecycleOf(model).stages['1.2'].next, true)
        assert.equal(lifecycleOf(model).stages['1.3'].status, 'done')
        // A node added to a done stage opens it again.
        const reopened = change(model, [{ op: 'add', num: '1.1.2', title: 'Eviction', status: 'claim' }, { op: 'add', num: '1.3.3', title: 'Metrics', task: 'Adds them.' }])
        assert.deepEqual(reopened.notes, ['1.1 Discussion is open again: a node was added to it.'])
        assert.equal(lifecycleOf(model).stages['1.1'].status, 'active')
        assert.equal(lifecycleOf(model).stages['1.3'].status, 'active')
    })

    test('tasks of an outline from before stay where they are when it gets topics, and can still be finished', () => {
        const model = outline('# 1. Work\n\n## 1.1 @task Measure it\n\n@Task. Measures it.\n')
        change(model, [{ op: 'stages', on: ['implementation'] }])
        assert.equal(findNode(model, '1.1.1.1').task, 'proposed')
        change(model, [{ op: 'finish', num: '1.1.1.1', outcome: 'Measured.' }])
        assert.equal(findNode(model, '1.1.1.1').task, 'done')
        // In the one topic of an outline without topics, tasks sit where they always did.
        const plain = outline(PLAIN)
        change(plain, [{ op: 'add', num: '2.3', title: 'Deploy', task: 'Deploys it.' }])
        assert.equal(findNode(plain, '2.3').task, 'proposed')
    })

    test('a topic’s heading and its stages’ have no status of their own and take no tick', () => {
        const model = outline('')
        change(model, [{ op: 'add', num: '1', title: 'Search', stages: ['discussion', 'plan'] }, { op: 'add', num: '1.1.1', title: 'Use Redis', status: 'claim' }])
        assert.doesNotMatch(serializeOutline(model), /@agent-claim @topic|@agent-claim @stage/)
        assert.deepEqual(applyUserSet(model, [{ num: '1', approved: true }, { num: '1.1', approved: true }]), [])
    })

    test('the page reads a topic’s stages and a stage’s name, and the outline list counts only the nodes in stages', () => {
        const text = `${HEAD}# 1. @topic @stages:discussion,plan @id:abc123 Search\n\n## 1.1 @stage:discussion @stage-done Discussion\n\n### 1.1.1 @agent-claim Use Redis\n\n## 1.2 @stage:plan Plan\n\n### 1.2.1 @plan-item Size it\n`
        const [topic] = outlinePayload(text).nodes
        assert.equal(topic.title, 'Search')
        assert.deepEqual(topic.stages, ['discussion', 'plan'])
        assert.deepEqual(topic.tags, ['topic'])
        assert.deepEqual(topic.children.map(c => [c.stage, c.title, c.tags]), [['discussion', 'Discussion', ['stage-done']], ['plan', 'Plan', []]])
        assert.deepEqual(topic.children[1].children[0].tags, ['plan-item'])
        assert.deepEqual(countCheckboxProgress(text), { total: 2, done: 0, agent: 1, open: 1 })
    })
})

describe('dependencies', () => {
    /** An outline with three topics, each with Discussion and Plan, and a node in each stage. */
    function three() {
        const model = outline('')
        const ops = []
        for (const [num, title] of [['1', 'Search'], ['2', 'Rollout'], ['3', 'Billing']])
            ops.push(
                { op: 'add', num, title, stages: ['discussion', 'plan'] },
                { op: 'add', num: `${num}.1.1`, title: `${title} decision`, status: 'claim' },
                { op: 'add', num: `${num}.2.1`, title: `${title} plan`, plan: true },
            )
        change(model, ops)
        return model
    }

    test('the agent sets the topics a topic waits for, and a link into another topic makes one by itself', () => {
        const model = three()
        change(model, [{ op: 'depends', num: '3', on: ['1'] }])
        assert.match(serializeOutline(model), /^# 3\. @current @topic @stages:discussion,plan @depends:[a-z0-9]{6} @id:[a-z0-9]{6} Billing$/m)
        change(model, [{ op: 'update', num: '3.2.1', links: ['2.1.1'] }])
        assert.deepEqual(lifecycleOf(model).topics['3'].waitsFor, ['1', '2'])
        assert.deepEqual(lifecycleOf(model).topics['1'].waitsFor, [])
        assert.match(mapText(model), /^3 Billing \[topic, stages on: discussion, plan; waits for 1, 2\]/m)
        // The list replaces the one it had.
        change(model, [{ op: 'depends', num: '3', on: [] }])
        assert.deepEqual(lifecycleOf(model).topics['3'].waitsFor, ['2'])
    })

    test('dependencies never form a loop, whether set or made by links', () => {
        const model = three()
        change(model, [{ op: 'depends', num: '2', on: ['1'] }, { op: 'depends', num: '3', on: ['2'] }])
        refused(model, [{ op: 'depends', num: '1', on: ['3'] }], /would wait for each other in a loop: 1 waits for 3 waits for 2 waits for 1/, /never form a loop/)
        refused(model, [{ op: 'update', num: '1.2.1', links: ['3.1.1'] }], /in a loop: 1 waits for 3 waits for 2 waits for 1/)
        refused(model, [{ op: 'depends', num: '1', on: ['1'] }], /cannot wait for itself/)
        refused(model, [{ op: 'depends', num: '1', on: ['1.1.1'] }], /1\.1\.1 is not a topic/, /2 Rollout; 3 Billing/)
        refused(model, [{ op: 'depends', on: ['2'] }], /A depends operation needs the number of its topic/, /The topics are: 1 Search; 2 Rollout; 3 Billing/)
    })

    test('a subtopic’s link to a decision its Discussion shares makes no dependency', () => {
        const model = three()
        change(model, [{ op: 'add', num: '1.1.2', title: 'Indexing', stages: ['discussion', 'plan'] }, { op: 'add', num: '1.1.2.2.1', title: 'Index plan', plan: true, links: ['1.1.1'] }])
        assert.deepEqual(lifecycleOf(model).topics['1.1.2'].waitsFor, [])
    })

    test('a topic taken out is no longer waited for, with a note', () => {
        const model = three()
        change(model, [{ op: 'depends', num: '3', on: ['1', '2'] }])
        const result = change(model, [{ op: 'remove', num: '1' }])
        assert.deepEqual(result.notes, ['2 no longer waits for 1, which was taken out.'])
        assert.deepEqual(lifecycleOf(model).topics['2'].waitsFor, ['1'])
        assert.equal(lifecycleOf(model).topics['1'].title, 'Rollout')
    })
})

