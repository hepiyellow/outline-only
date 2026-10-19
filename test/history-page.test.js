import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { launchBrowser, openPage, startServer, until } from './helpers.js'

// The node history: each change shows the node as it was then, its children included.

describe('the node history', () => {
    let server, browser, page
    before(async () => {
        server = await startServer()
        browser = await launchBrowser()
    })
    after(async () => {
        await browser?.close()
        await server?.stop()
    })
    afterEach(async () => {
        page.checkErrors()
        await page.close()
    })

    const shown = num => page.locator(`.hist-tree [data-hnum="${num}"]`)
    const nums = () => page.locator('.hist-tree [data-hnum="3"] > .hist-kids > [data-hnum]').evaluateAll(els => els.map(e => e.dataset.hnum))

    test('switching to another change shows the node as it was then, at once', async () => {
        // Topic 3 loses 3.2, has 3.3 renamed and gains 3.4: its history then holds both.
        const file = path.join(server.dir, 'demo', 'sample.md')
        const text = fs.readFileSync(file, 'utf8')
        const edited = text
            .replace(/## 3\.2 Time to live\n[\s\S]*?(?=## 3\.3 )/, '')
            .replace('## 3.3 Who can flush the cache by hand\n', '## 3.3 Who may flush the cache by hand\n\n## 3.4 Warming the cache after a deploy\n\nReplay the top thousand queries before taking traffic.\n')
        assert.notEqual(edited, text)
        fs.writeFileSync(file, edited)
        await until(async () => (await (await fetch(`${server.url}/api/outline/demo/sample/history?num=3`)).json()).length === 2, { what: 'the change to be recorded' })

        page = await openPage(browser, `${server.url}/demo/sample`)
        const head = page.locator('.outline-tab [data-num="3"]')
        await head.evaluate(e => e.scrollIntoView({ block: 'center' }))
        await head.hover()
        await head.getByRole('button', { name: 'History of 3', exact: true }).click()
        // The latest change shows first, as it is.
        await shown('3.4').waitFor()
        assert.deepEqual(await nums(), ['3.1', '3.3', '3.4'])
        assert.equal(await shown('3.3').locator('> .hist-head > .title-html').innerHTML(), 'Who may flush the cache by hand')

        await page.getByRole('dialog').locator('ol button').first().click()
        await shown('3.2').waitFor()
        assert.deepEqual(await nums(), ['3.1', '3.2', '3.3'])
        assert.equal(await shown('3.3').locator('> .hist-head > .title-html').innerHTML(), 'Who can flush the cache by hand')
        assert.match(await shown('3.2').locator('> .hist-body').textContent(), /Entries expire after 60 seconds/)
        assert.doesNotMatch(await page.locator('.hist-tree').innerHTML(), /style="[^"]/)
    })
})
