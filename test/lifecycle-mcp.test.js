import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { runHook, startMcp, startServer } from './helpers.js'

// The lifecycle through the agent's tools: what the agent sends, what the server writes, and what it is told.
describe('the lifecycle through the MCP tools', () => {
    let server, mcp, file
    const outlineText = () => fs.readFileSync(file, 'utf8')

    before(async () => {
        server = await startServer()
        mcp = startMcp(server)
        const started = await mcp.tool('start', { title: 'Search caching' })
        file = path.join(server.dir, 'shop', `${/Page: (\S+)/.exec(started.text)[1].split('/').pop()}.md`)
    })
    after(async () => {
        mcp.stop()
        await server.stop()
    })

    test('links are given by number, kept as ids, and shown by number in the map and in read', async () => {
        const built = await mcp.tool('change', {
            ops: [
                { op: 'add', num: '1', title: 'Cache placement', children: [{ title: 'A shared Redis cluster', status: 'claim' }] },
                { op: 'add', num: '2', title: 'Rollout', children: [{ title: 'Size the cluster', links: ['1.1'] }] },
            ],
        })
        assert.equal(built.error, false, built.text)
        assert.match(built.text, /^ {2}2\.1 Size the cluster \[open\] \(from 1\.1\)/m)
        assert.match(outlineText(), /^## 1\.1 @agent-claim @id:([a-z0-9]{6}) A shared Redis cluster$/m)
        const id = /^## 1\.1 @agent-claim @id:([a-z0-9]{6})/m.exec(outlineText())[1]
        assert.match(outlineText(), new RegExp(`^## 2\\.1 @links:${id} Size the cluster$`, 'm'))
        const read = await mcp.tool('read', { num: '1.1' })
        assert.match(read.text, /^Links: used by 2\.1$/m)
    })

    test('a link survives a move, and one that closes a loop is refused, with what to do', async () => {
        await mcp.tool('change', { ops: [{ op: 'move', num: '1.1', under: '2' }] })
        const read = await mcp.tool('read', { num: '2.1' })
        assert.match(read.text, /^Links: from 2\.2$/m)
        const loop = await mcp.tool('change', { ops: [{ op: 'update', num: '2.2', links: ['2.1'] }] })
        assert.equal(loop.error, true)
        assert.match(loop.text, /^Nothing was applied\. Operation 1 of 1 \(update 2\.2\): A link from node 2\.2 to 2\.1 would close a loop/m)
        assert.match(loop.text, /Links point upstream only/)
    })

    test('a second stage writes the outline’s one topic, and the result lists the numbers that changed', async () => {
        const result = await mcp.tool('change', { ops: [{ op: 'stages', on: ['plan', 'implementation'] }] })
        assert.equal(result.error, false, result.text)
        assert.match(result.text, /^Note: The outline is written as topics now: its nodes moved under 1\.1/m)
        assert.match(result.text, /^Numbers changed \(use the new ones in chat, and update any node text that names the old ones\): 1 -> 1\.1\.1; 2 -> 1\.1\.2; 2\.1 -> 1\.1\.2\.1; 2\.2 -> 1\.1\.2\.2$/m)
        assert.match(result.text, /^Map:\n1 Search caching \[topic, stages on: discussion, plan, implementation\] <- current\n {2}1\.1 Discussion \[stage, active\]$/m)
        assert.match(result.text, /^ {6}1\.1\.2\.1 Size the cluster \[open\] \(from 1\.1\.2\.2\)$/m)
        assert.match(outlineText(), /^# 1\. @current @topic @stages:discussion,plan,implementation @id:[a-z0-9]{6} Search caching$/m)
    })

    test('a node placed where it may not sit is refused, with where it goes', async () => {
        const task = await mcp.tool('change', { ops: [{ op: 'add', num: '1.1.3', title: 'Deploy', task: 'Deploys the cache.' }] })
        assert.equal(task.error, true)
        assert.match(task.text, /1\.1\.3 is a task, and Discussion holds no tasks\.\n\nTasks sit in Implementation, Verification \(where a task is a check\) and Preservation: place it under 1\.3 Implementation/)
        const placed = await mcp.tool('change', {
            ops: [
                { op: 'add', num: '1.2.1', title: 'Roll out by region', plan: true, links: ['1.1.2.2'] },
                { op: 'add', num: '1.3.1', title: 'Deploy', task: 'Deploys the cache.', links: ['1.2.1'] },
            ],
        })
        assert.equal(placed.error, false, placed.text)
        assert.match(placed.text, /^ {4}1\.2\.1 Roll out by region \[plan item, open, flags: built on a claim the user has not approved\] \(from 1\.1\.2\.2\)$/m)
        assert.match(placed.text, /^ {2}1\.3 Implementation \[stage, active, 0 of 1 tasks done\]$/m)
    })

    test('a stage the user turned off in chat is recorded as their act, in the action log', async () => {
        const off = await mcp.tool('change', { ops: [{ op: 'record', num: '1', decision: 'stage-off', stage: 'implementation' }] })
        assert.equal(off.error, false, off.text)
        assert.match(off.text, /^ {2}1\.3 Implementation \[stage, off\]$/m)
        const history = await (await fetch(`${server.url}/api/outline/shop/${path.basename(file, '.md')}/history?num=1`, { headers: { origin: server.url } })).json()
        assert.deepEqual(history.flatMap(e => e.did ?? []), [{ what: 'turned-off', kind: 'plain', stage: 'implementation' }])
        // A stage turned off asks nothing: its task is not in the queue.
        assert.doesNotMatch(off.text, /^Queue:/m)
    })

    test('a stage the user turns on or off on the page is in the action log, and the agent is told with its next call', async () => {
        const act = body =>
            fetch(`${server.url}/api/outline/shop/${path.basename(file, '.md')}/act`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.url }, body: JSON.stringify(body) })
        assert.equal((await act({ stage: { topic: '1', name: 'implementation', on: true } })).status, 200)
        assert.equal((await act({ stage: { topic: '1', name: 'plan', on: false } })).status, 200)
        // A topic always has a stage on, and what is not a topic has none.
        assert.equal((await act({ stage: { topic: '1.1', name: 'plan', on: false } })).status, 400)
        const read = await mcp.tool('read', { num: '1' })
        assert.match(read.text, /^- turned Implementation on for 1 Search caching$/m)
        assert.match(read.text, /^- turned Plan off for 1 Search caching: it keeps its nodes, folded away, and asks nothing; adapt the topic to it$/m)
        assert.match(outlineText(), /^# 1\. @current @topic @stages:discussion,implementation @id:[a-z0-9]{6} Search caching$/m)
        const history = await (await fetch(`${server.url}/api/outline/shop/${path.basename(file, '.md')}/history?num=1`, { headers: { origin: server.url } })).json()
        assert.deepEqual(
            history.flatMap(e => e.did ?? []).map(d => `${d.what} ${d.stage}`),
            ['turned-off implementation', 'turned-on implementation', 'turned-off plan'],
        )
    })

    test('a reworded decision lists what it reached; the turn-end hook holds the turn open once over marks left', async () => {
        await mcp.tool('read', { num: '1.1.2.2' })
        const changed = await mcp.tool('change', { ops: [{ op: 'update', num: '1.1.2.2', text: 'Sized for twice the load.' }, { op: 'queue', items: [{ num: '1.3.1' }] }] })
        assert.equal(changed.error, false, changed.text)
        assert.match(changed.text, /^This change reached what comes from it, marked as needing review, upstream first:\n- 1\.1\.2\.1 Size the cluster\n- 1\.2\.1 Roll out by region\n- 1\.3\.1 Deploy\nChange each one/m)
        const held = await runHook(server, { hook_event_name: 'Stop', stop_hook_active: false })
        assert.match(held, /A change upstream reached these nodes, and they need review:\\n- 1\.1\.2\.1 Size the cluster/)
        // Once: the same marks do not hold the next turn.
        assert.equal(await runHook(server, { hook_event_name: 'Stop', stop_hook_active: false }), '')
        const cleared = await mcp.tool('change', { ops: [{ op: 'holds', num: '1.1.2.1' }, { op: 'holds', num: '1.2.1' }, { op: 'holds', num: '1.3.1' }] })
        assert.doesNotMatch(cleared.text, /needs review/)
    })

    test('an approval the user takes back on the page reaches what was built on it, and the agent is told', async () => {
        const act = body =>
            fetch(`${server.url}/api/outline/shop/${path.basename(file, '.md')}/act`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.url }, body: JSON.stringify(body) })
        await act({ set: [{ num: '1.1.2.2', approved: true }] })
        await act({ set: [{ num: '1.1.2.2', approved: false }] })
        assert.match(outlineText(), /^#### 1\.1\.2\.1 @needs-review /m)
        const read = await mcp.tool('read', { num: '1.1.2.1' })
        assert.match(read.text, /^- so 1\.1\.2\.2 A shared Redis cluster changed, and what comes from it needs review: 1\.1\.2\.1 Size the cluster; 1\.2\.1 Roll out by region; 1\.3\.1 Deploy$/m)
    })

    test('the agent splits part of a topic off; the user merges it back on the page, and the agent is told what changed', async () => {
        const split = await mcp.tool('change', { ops: [{ op: 'split', num: '1', title: 'Rollout', nodes: ['1.3.1'] }] })
        assert.equal(split.error, false, split.text)
        assert.match(split.text, /^Numbers changed .*: 1\.3\.1 -> 2\.3\.1$/m)
        assert.match(split.text, /^2 Rollout \[topic, stages on: implementation; waits for 1\]/m)
        const act = body =>
            fetch(`${server.url}/api/outline/shop/${path.basename(file, '.md')}/act`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.url }, body: JSON.stringify(body) })
        assert.equal((await act({ merge: { num: '2', into: '1' } })).status, 200)
        assert.equal((await act({ merge: { num: '1', into: '1' } })).status, 400)
        assert.doesNotMatch(outlineText(), /^# 2\. /m)
        assert.match(outlineText(), /^### 1\.3\.1 .*Deploy$/m)
        const read = await mcp.tool('read', { num: '1' })
        assert.match(read.text, /^- merged the topic "Rollout" into 1 Search caching: its nodes are under the stages of 1 now, with their links\. Numbers changed: 2\.3\.1 -> 1\.3\.1; 2 -> 1\. If you had split it off, add a line to the topic notes/m)
        const history = await (await fetch(`${server.url}/api/outline/shop/${path.basename(file, '.md')}/history?num=1`, { headers: { origin: server.url } })).json()
        assert.deepEqual(history.flatMap(e => e.did ?? []).at(-1), { what: 'merged', kind: 'plain', from: 'Rollout' })
    })

    test('the project’s topic notes: start hands them over with their path, and a note adds a line', async () => {
        const notes = path.join(server.dir, '.topic-notes', 'shop.md')
        const first = await mcp.tool('start', {})
        assert.match(first.text, new RegExp(`The project "shop" has no topic notes yet \\(${notes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): after the user merges topics you split, or rejects a split, add one with a note operation\\.`))
        const noted = await mcp.tool('change', { ops: [{ op: 'note', text: 'Keeps a rollout and its checks in one topic.' }] })
        assert.equal(noted.error, false, noted.text)
        assert.match(noted.text, /^Added to the topic notes of "shop" \(.*\.topic-notes\/shop\.md\): Keeps a rollout and its checks in one topic\.$/m)
        assert.match(fs.readFileSync(notes, 'utf8'), /^# Topic notes: shop\n\nHow the user wants work divided into topics\..*\n\n- \d{4}-\d\d-\d\d: Keeps a rollout and its checks in one topic\.\n$/)
        const again = await mcp.tool('start', {})
        assert.match(again.text, /^Topic notes of the project "shop" \(.*\): read them before you make topics or split one\.\n# Topic notes: shop\n/m)
        assert.match(again.text, /^- \d{4}-\d\d-\d\d: Keeps a rollout and its checks in one topic\.$/m)
        const bad = await mcp.tool('change', { ops: [{ op: 'note', text: 'Two\nlines' }] })
        assert.equal(bad.error, true)
        assert.match(bad.text, /A topic note is one line/)
        // Topic notes are not an outline: the list does not show them.
        const list = await (await fetch(`${server.url}/api/outlines`, { headers: { origin: server.url } })).json()
        assert.ok(!list.outlines.some(o => o.file === 'shop' || o.project === '.topic-notes'))
    })
})
