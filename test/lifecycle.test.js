import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { OpError, allNodes, applyOperations, findNode, mapText, nodeHash, normalize, parseOutline, readText, serializeOutline } from '../model.js'
import { outlinePayload } from '../outline.js'
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
