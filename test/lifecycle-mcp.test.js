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
})
