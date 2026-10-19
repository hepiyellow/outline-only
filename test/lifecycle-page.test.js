import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { launchBrowser, openPage, startServer, until } from './helpers.js'

// The lifecycle on the page (server mode): links, levels, topics and stages, dependencies, review marks, layouts and
// the overview.

const HEAD = 'Title: Lifecycle\nMode: server\n\n'

describe('the lifecycle on the page', () => {
    let server, browser, page
    /** Writes outline demo/<name> and opens its page. */
    async function show(name, body, viewport = { width: 1200, height: 900 }) {
        fs.writeFileSync(path.join(server.dir, 'demo', `${name}.md`), HEAD + body)
        page = await openPage(browser, `${server.url}/demo/${name}`, { viewport })
        await page.locator('.outline-tab').waitFor()
        return page
    }
    const node = num => page.locator(`.outline-tab [data-num="${num}"]`)

    before(async () => {
        server = await startServer()
        browser = await launchBrowser()
    })
    after(async () => {
        await browser?.close()
        await server?.stop()
    })
    afterEach(async () => {
        page?.checkErrors()
        await page?.close()
    })

    test('a node’s links show as chips, both ways, and each is a click to its node', async () => {
        await show(
            'links',
            `# 1. Decisions

## 1.1 @agent-claim @id:aaaaa1 Use Redis

## 1.2 @agent-claim @id:aaaaa2 Keep a minute of staleness

# 2. Plan

## 2.1 @links:aaaaa1,aaaaa2 Size the cluster
`,
        )
        assert.equal(await node('2.1').locator('[data-links="from"]').textContent(), 'from 1.1, 1.2')
        assert.equal(await node('1.1').locator('[data-links="used-by"]').textContent(), 'used by 2.1')
        assert.equal(await node('1.1').locator('[data-links="from"]').count(), 0)
        // A plain node without links has no chips.
        assert.equal(await node('2').locator('.link-chips').count(), 0)
        // 1 starts collapsed, its nodes being claims: the click opens the way to 1.1.
        assert.equal(await node('1.1').isVisible(), false)
        await node('2.1').locator('[data-link-to="1.1"]').click()
        await until(() => node('1.1').isVisible(), { what: '1.1 to be shown' })
    })

    test('a node eight levels deep shows under its parent, and past six levels a narrow window indents less', async () => {
        const lines = []
        for (let level = 1; level <= 8; level++) lines.push(`${'#'.repeat(Math.min(level, 6))} ${Array(level).fill(1).join('.')}${level === 1 ? '.' : ''} Level ${level}`, '', 'Text.', '')
        await show('deep', lines.join('\n'), { width: 600, height: 900 })
        const deep = node('1.1.1.1.1.1.1.1')
        await deep.waitFor()
        assert.match(await deep.locator('.node-title').textContent(), /Level 8/)
        const indent = num => page.locator(`.group:has(> [data-num="${num}"]) > .kids`).evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))
        assert.equal(await indent('1.1.1.1'), 24)
        assert.equal(await indent('1.1.1.1.1.1'), 10)
        // On a wide window every level is indented alike.
        await page.setViewportSize({ width: 1200, height: 900 })
        assert.equal(await indent('1.1.1.1.1.1'), 24)
    })
})
