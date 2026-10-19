import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { startMcp, startServer } from './helpers.js'

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
        assert.match(placed.text, /^ {4}1\.2\.1 Roll out by region \[plan item, open\] \(from 1\.1\.2\.2\)$/m)
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
})
