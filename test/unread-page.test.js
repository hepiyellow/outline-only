import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { launchBrowser, startServer, until } from './helpers.js'

describe('unread changes', () => {
    let server, browser, page
    before(async () => {
        server = await startServer()
        browser = await launchBrowser()
    })
    after(async () => {
        await browser?.close()
        await server?.stop()
    })
    const open = async (options = {}) => {
        page = await browser.newPage({ viewport: { width: 1200, height: 900 }, ...options })
        const errors = []
        page.on('pageerror', e => errors.push(e))
        page.checkErrors = () => {
            if (errors.length) throw errors[0]
        }
        await page.goto(`${server.url}/demo/sample`)
        await page.locator('[data-topbar] [data-title]').waitFor()
    }
    beforeEach(async () => {
        server.swap('demo/sample', 'demo/sample')
        server.resetState()
    })
    afterEach(async () => {
        page.checkErrors()
        await page.close()
    })

    const node = num => page.locator(`.outline-tab [data-num="${num}"]`)
    const text = num => node(num).locator('.node-html').textContent()
    /** The diff bar of a node in the diff view, and its buttons. */
    const bar = num => page.locator(`.outline-tab [data-diff-bar="${num}"]`)
    const accept = num => bar(num).locator('[data-accept]')
    const readState = async () => (await (await fetch(`${server.url}/api/state/demo/sample`)).json()).read
    /** On a first visit every node below the topics (20 in sample.md) counts as read; this waits until the page has recorded it. */
    const firstVisit = () => until(async () => Object.keys((await (await fetch(`${server.url}/api/state/demo/sample`)).json()).read).length >= 20, { what: 'the first visit to be recorded' })

    test('a rewritten node keeps what was read, with a diff button; a new node is a bare row with a plus until it is accepted', async () => {
        await open()
        await firstVisit()
        assert.equal(await page.locator('.outline-tab .env').count(), 0)
        server.swap('demo/sample', 'demo/sample-edited')
        await node('3.4').waitFor()
        assert.match(await text('2.3'), /and the index version/)
        assert.equal(await node('2.3').locator('> .env').getAttribute('data-change'), 'changed')
        // The added node is there, with its title and nothing of its text, and the column has its indicator.
        const plus = node('3.4').locator('> .env')
        assert.equal(await plus.getAttribute('data-change'), 'added')
        assert.match(await node('3.4').locator('.title-html').textContent(), /Warming the cache after a deploy/)
        assert.equal((await text('3.4')).trim(), '')
        assert.equal(await page.locator('[aria-label="Changes to open"] [data-unread="3.4"]').getAttribute('data-change'), 'added')
        // Approving 4.1 is the user's own doing, recorded by the agent: nothing to open.
        assert.equal(await node('4.1').locator('> .env').count(), 0)
        // The plus shows it in the diff view, whole and marked as new: it waits there until it is accepted.
        await plus.click()
        await page.waitForFunction(() => /Replay the top thousand queries/.test(document.querySelector('.outline-tab [data-num="3.4"] .node-html')?.textContent ?? ''))
        assert.equal(await node('3.4').getAttribute('data-diff'), 'added')
        assert.equal(await plus.getAttribute('aria-pressed'), 'true')
        assert.match(await bar('3.4').textContent(), /Added/)
        assert.equal(await page.locator('[data-unread="3.4"]').count(), 1)
        await accept('3.4').click()
        await bar('3.4').waitFor({ state: 'detached' })
        assert.equal(await node('3.4').locator('> .env').count(), 0)
        assert.equal(await node('3.4').getAttribute('data-diff'), null)
        assert.equal(await page.locator('[data-unread="3.4"]').count(), 0)
        // 2.3 is in the action queue, so the column shows it once, there: it has no change indicator of its own, and
        // its item says the node changed.
        assert.equal(await page.locator('[data-unread="2.3"]').count(), 0)
        assert.match(await page.locator('[aria-label="Your queue"] [data-queue="2.3"]').getAttribute('title'), /it changed since you read it/)
    })

    test('a changed node that is not in the action queue has a change indicator, below the queue and a divider', async () => {
        await open()
        await firstVisit()
        assert.equal(await page.locator('[data-queue-divider]').count(), 0)
        const file = path.join(server.dir, 'demo', 'sample.md')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(## 3\.2 Time to live\n\n)/, '$1Entries now live for ten minutes. '))
        const indicator = page.locator('[aria-label="Changes to open"] [data-unread="3.2"]')
        await indicator.waitFor()
        const top = selector => page.locator(selector).evaluate(e => e.getBoundingClientRect().top)
        assert.ok((await top('[aria-label="Your queue"] li:last-child')) < (await top('[data-queue-divider]')))
        assert.ok((await top('[data-queue-divider]')) < (await top('[data-unread="3.2"]')))
        // It shows the node and points at its diff button, and opens nothing.
        await indicator.click()
        await page.waitForFunction(() => document.querySelector('.outline-tab [data-num="3.2"] > .env')?.hasAttribute('data-pulse'))
        assert.doesNotMatch(await text('3.2'), /ten minutes/)
    })

    /** Rewrites the outline's file the way an agent does. */
    const rewrite = change => {
        const file = path.join(server.dir, 'demo', 'sample.md')
        const before = fs.readFileSync(file, 'utf8')
        const after = change(before)
        assert.notEqual(after, before)
        fs.writeFileSync(file, after)
    }

    test('a change of kind alone waits too: the row keeps the marks it had, and the indicator shows the new one', async () => {
        await open()
        await firstVisit()
        const own = () => node('3.3').locator('> .marks .km[data-own]')
        assert.equal(await own().count(), 0)
        rewrite(text => text.replace('## 3.3 Who can flush', '## 3.3 @agent-claim Who can flush'))
        const indicator = page.locator('[aria-label="Changes to open"] [data-unread="3.3"]')
        await indicator.waitFor()
        // Opening it brings a claim, so that is what the indicator is drawn with; the row itself has no mark yet.
        assert.equal(await indicator.getAttribute('data-mark'), 'claim')
        assert.equal(await own().count(), 0)
        // The diff says the kind changes; the mark comes with accepting it.
        await node('3.3').locator('> .env').click()
        assert.equal((await bar('3.3').locator('[data-kind-change]').textContent()).trim(), 'plain → claim')
        assert.equal(await own().count(), 0)
        await accept('3.3').click()
        await own().waitFor()
        assert.equal(await own().getAttribute('data-kind'), 'claim')
        assert.equal(await page.locator('[data-unread="3.3"]').count(), 0)
    })

    test('a topic waits like any node: its title and text stay as read until its change is accepted', async () => {
        await open()
        await firstVisit()
        const title = () => node('3').locator('.title-html').textContent()
        rewrite(text => text.replace('# 3. Invalidation\n', '# 3. Invalidation rules\n\nWhat drops an entry, and when.\n'))
        const button = node('3').locator('> .env')
        await button.waitFor()
        assert.equal(await title(), 'Invalidation')
        await button.click()
        // The diff: the word added to the title, and the paragraph added to the text.
        await node('3').locator('.title-html ins.dx-add').waitFor()
        assert.equal(await node('3').locator('.title-html ins.dx-add').textContent(), 'rules')
        const topicText = page.locator('.outline-tab .topic:has(> [data-num="3"]) .topic-text')
        assert.match(await topicText.locator('.dx-add-block').textContent(), /What drops an entry, and when\./)
        await accept('3').click()
        await page.waitForFunction(() => document.querySelector('.outline-tab [data-num="3"] .title-html').textContent === 'Invalidation rules')
        assert.equal(await page.locator('.outline-tab .dx-add, .outline-tab .dx-add-block').count(), 0)
        assert.match(await topicText.textContent(), /What drops an entry, and when\./)
        assert.equal(await node('3').locator('> .env').count(), 0)
    })

    test('a closed parent shows the diff button for what waits under it; a click shows all of it, to accept one at a time or all at once', async () => {
        await open()
        await firstVisit()
        rewrite(text => text.replace('## 3.2 Time to live\n', '## 3.2 Time to live\n\nNow ten minutes.\n').replace('## 3.3 Who can flush the cache by hand\n', '## 3.3 Who can flush the cache by hand\n\nOperators only.\n'))
        await node('3.2').locator('> .env').waitFor()
        // Open, topic 3 has no button of its own: 3.2 and 3.3 show theirs.
        assert.equal(await node('3').locator('> .env').count(), 0)
        await node('3').click()
        const button = node('3').locator('> .env')
        await button.waitFor()
        assert.equal(await button.getAttribute('data-change'), 'under')
        assert.match(await button.getAttribute('title'), /^2 changes under this node/)
        await button.click()
        // The parent opens on both changes, each in the diff view with its own Accept, and the parent's bar accepts both.
        await bar('3.2').waitFor()
        assert.match(await node('3.2').locator('.node-html .dx-add-block').textContent(), /Now ten minutes/)
        assert.match(await node('3.3').locator('.node-html .dx-add-block').textContent(), /Operators only/)
        assert.match(await bar('3').textContent(), /2 changes under this node/)
        assert.equal(await page.locator('[data-unread]').count(), 2)
        // One at a time: 3.2 is taken in, 3.3 still waits.
        await accept('3.2').click()
        await until(async () => /ten minutes/.test((await readState())['3.2']), { what: 'the first change to be taken in' })
        assert.doesNotMatch((await readState())['3.3'], /Operators only/)
        assert.equal(await node('3.2').locator('.dx-add-block').count(), 0)
        assert.deepEqual(await page.locator('[data-unread]').evaluateAll(els => els.map(e => e.dataset.unread)), ['3.3'])
        // Then the rest, from the parent.
        assert.equal((await bar('3').locator('[data-accept-all]').textContent()).trim(), 'Accept')
        await bar('3').locator('[data-accept-all]').click()
        await until(async () => /Operators only/.test((await readState())['3.3']), { what: 'the other change to be taken in' })
        await bar('3').waitFor({ state: 'detached' })
        assert.equal(await node('3').locator('> .env').count(), 0)
        assert.equal(await page.locator('[data-unread]').count(), 0)
        assert.equal(await page.locator('.outline-tab .diff-bar').count(), 0)
    })

    test('a new topic comes with everything under it: one row and one indicator until its plus is clicked', async () => {
        await open()
        await firstVisit()
        rewrite(text => text.replace('# @queue\n', '# 5. Monitoring\n\nWhat to watch.\n\n## 5.1 @options Which dashboard\n\n### 5.1.1 @option_A Grafana\n\n### 5.1.2 @option_B Datadog\n\n# @queue\n- 5.1 @decide Pick a dashboard.\n'))
        const plus = node('5').locator('> .env')
        await plus.waitFor()
        assert.equal(await plus.getAttribute('data-change'), 'added')
        assert.equal(await node('5.1').count(), 0)
        assert.deepEqual(await page.locator('[data-unread]').evaluateAll(els => els.map(e => e.dataset.unread)), ['5'])
        // The action item of a node inside it shows the added topic, which is what there is to click first.
        await page.locator('[aria-label="Your queue"] [data-queue="5.1"]').click()
        await page.waitForFunction(() => document.querySelector('.outline-tab [data-num="5"]')?.hasAttribute('data-qmark'))
        assert.equal(await node('5.1').count(), 0)
        await plus.click()
        await node('5.1.2').waitFor()
        assert.equal(await page.locator('.outline-tab .topic:has(> [data-num="5"])').getAttribute('data-diff'), 'added')
        assert.match(await bar('5').textContent(), /Added, with 3 nodes under it/)
        // Nothing in it can be picked before it is accepted.
        assert.equal(await node('5.1.1').locator('[data-pick]').getAttribute('aria-disabled'), 'true')
        await accept('5').click()
        await bar('5').waitFor({ state: 'detached' })
        assert.equal(await page.locator('.outline-tab .env').count(), 0)
        assert.equal(await page.locator('[data-unread]').count(), 0)
        assert.equal(await node('5.1.1').locator('[data-pick]').getAttribute('aria-disabled'), 'false')
    })

    test('a task whose change is not accepted shows no button to run it: what there is to run has not been read', async () => {
        await open()
        await firstVisit()
        assert.equal(await node('2.4').locator('[data-run]').count(), 1)
        rewrite(text => text.replace(/(## 2\.4 @action Measure the hit rate on staging\n)/, '$1\nOn production instead.\n'))
        await node('2.4').locator('> .env').waitFor()
        assert.equal(await node('2.4').locator('[data-run]').count(), 0)
        await node('2.4').locator('> .env').click()
        await bar('2.4').waitFor()
        assert.equal(await node('2.4').locator('[data-run]').count(), 0)
        await accept('2.4').click()
        await node('2.4').locator('[data-run]').waitFor()
        assert.match(await text('2.4'), /On production instead\./)
    })

    test('a task the agent carried out collapses once its change is accepted, also one the viewer had collapsed', async () => {
        await open()
        await firstVisit()
        rewrite(text => text.replace(/(## 2\.4 @action Measure the hit rate on staging\n)/, '$1\nOn production instead.\n'))
        await node('2.4').locator('> .env').click()
        await accept('2.4').click()
        await node('2.4').locator('[data-run]').waitFor()
        // The viewer closes it: from now on the diff has to open it again to be shown.
        await node('2.4').locator('.node-title').click()
        assert.equal(await node('2.4').getAttribute('aria-expanded'), 'false')
        rewrite(text => text.replace('## 2.4 @action Measure', '## 2.4 @action @ran Measure').replace('On production instead.', 'Hit rate was 91%.'))
        await node('2.4').locator('> .env').click()
        await page.waitForFunction(() => [...document.querySelectorAll('.outline-tab [data-num="2.4"] .node-html ins')].some(e => e.textContent === 'Hit rate was 91%.'))
        assert.match(await bar('2.4').textContent(), /now done/)
        // It stays open while its diff is shown.
        await new Promise(r => setTimeout(r, 1000))
        assert.equal(await node('2.4').getAttribute('aria-expanded'), 'true')
        await accept('2.4').click()
        // After a pause it closes by itself, and the viewer can open it again. Nothing is open under topic 2 any more,
        // so that closes too: the viewer opens it to see the row.
        await page.waitForFunction(() => document.querySelector('.outline-tab [data-num="2.4"]')?.getAttribute('aria-expanded') === 'false')
        await node('2.4').locator('.node-title').waitFor({ state: 'hidden' })
        await node('2').locator('.node-title').click()
        await node('2.4').locator('.node-title').click()
        assert.equal(await node('2.4').getAttribute('aria-expanded'), 'true')
    })

    test('nodes renumbered after a removed one are not changes to read', async () => {
        await open()
        await firstVisit()
        // 2.3 goes; 2.4 and 2.5 take the numbers before theirs.
        const file = path.join(server.dir, 'demo', 'sample.md')
        const text = fs.readFileSync(file, 'utf8')
        const titles = { 2.4: await node('2.4').locator('.title-html').textContent(), 2.5: await node('2.5').locator('.title-html').textContent() }
        const edited = text.replace(/## 2\.3 [\s\S]*?(?=## 2\.4 )/, '').replace('## 2.4 ', '## 2.3 ').replace('## 2.5 ', '## 2.4 ')
        assert.notEqual(edited, text)
        fs.writeFileSync(file, edited)
        await node('2.5').waitFor({ state: 'detached' })
        assert.equal(await node('2.3').locator('.title-html').textContent(), titles[2.4])
        assert.equal(await node('2.4').locator('.title-html').textContent(), titles[2.5])
        assert.equal(await page.locator('.outline-tab .env').count(), 0)
        assert.equal(await page.locator('[data-unread]').count(), 0)
        await until(async () => !('2.5' in (await readState())), { what: 'the last number to be forgotten' })
    })

    test('the diff view marks the words that went and the words that came; accepting takes in the new text', async () => {
        await open()
        await firstVisit()
        server.swap('demo/sample', 'demo/sample-edited')
        await node('2.3').locator('> .env').waitFor()
        await node('2.3').locator('> .env').click()
        await bar('2.3').waitFor()
        const html = node('2.3').locator('.node-html')
        const marked = sel => html.locator(sel).evaluateAll(els => els.map(e => e.textContent.trim()))
        // Struck through where they stood, before the words that took their place.
        assert.deepEqual(await marked('del.dx-del'), ['index version.', 'index version.', 'the locale has to be'])
        assert.deepEqual(await marked('ins.dx-add'), ['tenant.', 'tenant.', 'tenant as well as by', 'both are'])
        assert.match(await text('2.3'), /Results differ by tenant as well as by locale, so the locale has to be both are part of it\./)
        assert.match(await node('2.3').locator('.closing').first().textContent(), /the locale and the index version\.\s*tenant\./)
        // Nothing is taken in until it is accepted.
        assert.match((await readState())['2.3'], /and the index version/)
        await accept('2.3').click()
        await bar('2.3').waitFor({ state: 'detached' })
        assert.doesNotMatch(await html.innerHTML(), /dx-/)
        assert.match(await text('2.3'), /Results differ by tenant as well as by locale/)
        assert.match(await node('2.3').locator('.closing').first().textContent(), /the locale and the tenant/)
        assert.equal(await node('2.3').locator('> .env').count(), 0)
        // What is left to open is the node that was added.
        assert.deepEqual(await page.locator('[data-unread]').evaluateAll(els => els.map(e => e.dataset.unread)), ['3.4'])
        assert.match((await readState())['2.3'], /and the tenant/)
    })

    test('the diff button of a node whose diff is shown hides it again: the node reads as it was read', async () => {
        await open()
        await firstVisit()
        server.swap('demo/sample', 'demo/sample-edited')
        const button = node('2.3').locator('> .env')
        await button.click()
        await bar('2.3').waitFor()
        assert.equal(await button.getAttribute('aria-pressed'), 'true')
        await button.click()
        await bar('2.3').waitFor({ state: 'detached' })
        assert.equal(await button.getAttribute('aria-pressed'), 'false')
        assert.match(await text('2.3'), /and the index version/)
        assert.doesNotMatch(await node('2.3').locator('.node-html').innerHTML(), /dx-/)
        assert.match((await readState())['2.3'], /and the index version/)
    })

    test('a list in the text is compared item by item: an item that went is struck through, one that came is green', async () => {
        await open()
        await firstVisit()
        rewrite(text => text.replace('## 3.3 Who can flush the cache by hand\n', '## 3.3 Who can flush the cache by hand\n\n- Operators\n- Support\n'))
        await node('3.3').locator('> .env').click()
        await accept('3.3').click()
        await bar('3.3').waitFor({ state: 'detached' })
        rewrite(text => text.replace('- Operators\n- Support\n', '- On-call engineers\n- Operators\n'))
        await node('3.3').locator('> .env').click()
        await bar('3.3').waitFor()
        const items = await node('3.3').locator('.node-html li').evaluateAll(els => els.map(e => [e.className, e.textContent.trim()]))
        assert.deepEqual(items, [
            ['dx-add-block', 'On-call engineers'],
            ['', 'Operators'],
            ['dx-del-block', 'Support'],
        ])
    })

    test('a parent’s hover button shows every change under it in the diff view, and the parent stays where it is', async () => {
        await open()
        await firstVisit()
        server.swap('demo/sample', 'demo/sample-edited')
        await node('2.3').locator('> .env').waitFor()
        // Scrolled so that topic 2 is well below the top of the window, and not stuck.
        await node('1').evaluate(e => e.scrollIntoView({ block: 'start' }))
        const head = node('2')
        await head.scrollIntoViewIfNeeded()
        await page.evaluate(() => scrollBy(0, -250))
        const topBefore = await head.evaluate(e => e.getBoundingClientRect().top)
        await head.hover()
        const button = head.locator('.ask-diff')
        assert.equal(await button.getAttribute('data-unread-under'), '1')
        await button.click()
        await bar('2.3').waitFor()
        assert.match(await text('2.3'), /Results differ by tenant as well as by locale/)
        assert.equal(await head.locator('.ask-diff').count(), 0)
        const topAfter = await head.evaluate(e => e.getBoundingClientRect().top)
        assert.ok(Math.abs(topAfter - topBefore) < 1, `the parent moved from ${topBefore} to ${topAfter}`)
        await bar('2').locator('[data-accept-all]').click()
        await until(async () => /and the tenant/.test((await readState())['2.3']), { what: 'the change to be taken in' })
        assert.equal(await node('2.3').locator('> .env').count(), 0)
    })

    test('a collapsed parent’s hover button opens it on its changes', async () => {
        await open()
        await firstVisit()
        server.swap('demo/sample', 'demo/sample-edited')
        await node('2.3').locator('> .env').waitFor()
        await node('2').click()
        await node('2.3').waitFor({ state: 'hidden' })
        await node('2').hover()
        await node('2').locator('.ask-diff').click()
        await bar('2.3').waitFor()
        assert.equal(await node('2.3').isVisible(), true)
        // Nothing is taken in until it is accepted.
        assert.match((await readState())['2.3'], /and the index version/)
    })

    test('what was read survives a reload', async () => {
        await open()
        await firstVisit()
        server.swap('demo/sample', 'demo/sample-edited')
        await node('2.3').locator('> .env').waitFor()
        await page.reload()
        await node('2.3').locator('> .env').waitFor()
        assert.match(await text('2.3'), /and the index version/)
    })

    test('the action item of a changed node shows the node and points at its diff button: the change is opened first', async () => {
        await open()
        await firstVisit()
        await page.getByRole('button', { name: 'Collapse all' }).click()
        server.swap('demo/sample', 'demo/sample-edited')
        await node('3.4').waitFor({ state: 'attached' })
        await page.locator('[aria-label="Your queue"] [data-queue="2.3"]').click()
        await page.waitForFunction(() => document.querySelector('.outline-tab [data-num="2.3"] > .env')?.hasAttribute('data-pulse'))
        assert.equal(await node('2.3').isVisible(), true)
        // It only shows the node: the change is still unread, and its diff not open.
        assert.match(await text('2.3'), /and the index version/)
        assert.equal(await bar('2.3').count(), 0)
    })
})

// What only the server knows of a change: that its agent took a node out, and when it changed each node. So these run
// on an outline in server mode, changed through the agent's API as its tools do.
describe('removed nodes, and the order of the changes, in server mode', () => {
    let server, browser, page
    before(async () => {
        server = await startServer()
        browser = await launchBrowser()
    })
    after(async () => {
        await browser?.close()
        await server?.stop()
    })
    beforeEach(async () => {
        server.swap('demo/sample', 'demo/sample', 'server')
        server.resetState()
        fs.rmSync(path.join(server.dir, '.ledger'), { recursive: true, force: true })
        page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
        const errors = []
        page.on('pageerror', e => errors.push(e))
        page.checkErrors = () => {
            if (errors.length) throw errors[0]
        }
        await page.goto(`${server.url}/demo/sample`)
        await page.locator('[data-topbar] [data-title]').waitFor()
        await until(async () => Object.keys((await (await fetch(`${server.url}/api/state/demo/sample`)).json()).read).length >= 20, { what: 'the first visit to be recorded' })
    })
    afterEach(async () => {
        page.checkErrors()
        await page.close()
    })

    const node = num => page.locator(`.outline-tab [data-num="${num}"]`)
    /** A change of the outline, as the agent's `change` tool sends it. */
    const change = async ops => {
        const res = await fetch(`${server.url}/api/agent/change`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-outline-agent': '1' }, body: JSON.stringify({ outline: 'demo/sample', ops }) })
        const result = await res.json()
        assert.equal(result.ok, true, result.text)
        return result
    }
    /** The rows under topic 2, in the order they are drawn: a node's number, or `-` and the number a removed one had. */
    const rows = () =>
        page.locator('.outline-tab .topic:has(> [data-num="2"]) > .topic-body > .nodes').evaluate(list => [...list.children].map(el => (el.matches('[data-removed]') ? `-${el.querySelector('s').textContent}` : (el.dataset.num ?? el.querySelector('[data-num]').dataset.num))))

    test('a node the agent takes out stays where it stood, struck through with a minus, until its removal is accepted', async () => {
        const title = await node('2.4').locator('.title-html').textContent()
        await change([{ op: 'remove', num: '2.3' }])
        const row = page.locator('.outline-tab [data-removed]')
        await row.waitFor()
        // Its row is where it was. The nodes after it carry their new numbers at once, and that is not a change to open.
        assert.deepEqual(await rows(), ['2.1', '2.2', '-2.3', '2.3', '2.4'])
        assert.equal(await row.locator('.title-html').textContent(), 'Cache key')
        assert.equal(await node('2.3').locator('.title-html').textContent(), title)
        assert.equal(await page.locator('.outline-tab [data-num] > .env').count(), 0)
        // The column has its indicator, a minus, which shows the row and points at its minus.
        const indicator = page.locator('[aria-label="Changes to open"] [data-removed-item]')
        assert.equal(await indicator.getAttribute('data-change'), 'removed')
        assert.equal((await indicator.textContent()).trim(), '2.3')
        await indicator.click()
        await page.waitForFunction(() => document.querySelector('.outline-tab [data-removed] > .env')?.hasAttribute('data-pulse'))
        // The minus shows it in the diff view, in red; accepting lets it go, for good.
        await row.locator('> .env').click()
        assert.equal(await row.getAttribute('data-diff'), 'removed')
        await row.locator('[data-accept]').click()
        await row.waitFor({ state: 'detached' })
        assert.equal(await indicator.count(), 0)
        assert.deepEqual(await rows(), ['2.1', '2.2', '2.3', '2.4'])
        await page.reload()
        await node('2.4').waitFor()
        assert.equal(await page.locator('.outline-tab [data-removed]').count(), 0)
    })

    test('a parent taken out is one row that counts what went with it; a closed parent shows the diff button for a removal under it', async () => {
        await change([{ op: 'remove', num: '3.1' }])
        const row = page.locator('.outline-tab [data-removed]')
        await row.waitFor()
        assert.equal(await row.count(), 1)
        assert.match(await row.textContent(), /Events that drop entries\s+and 4 under it/)
        // Collapsed, topic 3 says something waits under it, and a click on its button shows that too.
        await node('3').click()
        const button = node('3').locator('> .env')
        await button.waitFor()
        assert.match(await button.getAttribute('title'), /^1 change under this node/)
        await button.click()
        await page.locator('.outline-tab [data-removed][data-diff="removed"]').waitFor()
        assert.match(await page.locator('.outline-tab [data-diff-bar="3"]').textContent(), /1 change under this node/)
        await page.locator('.outline-tab [data-diff-bar="3"] [data-accept-all]').click()
        await page.locator('[data-removed-item]').waitFor({ state: 'detached' })
        assert.equal(await page.locator('.outline-tab [data-removed]').count(), 0)
    })

    test('a node that came and went before the viewer opened it leaves no row', async () => {
        await change([{ op: 'add', num: '2.6', title: 'Short lived' }])
        await node('2.6').locator('> .env[data-change="added"]').waitFor()
        await change([{ op: 'remove', num: '2.6' }])
        await node('2.6').waitFor({ state: 'detached' })
        assert.equal(await page.locator('.outline-tab [data-removed]').count(), 0)
        assert.equal(await page.locator('[data-removed-item], [data-unread]').count(), 0)
    })

    test('the changes are in the outline’s order, or by the button on the divider the oldest first', async () => {
        await change([{ op: 'add', num: '4.3', title: 'Then everyone' }])
        await new Promise(r => setTimeout(r, 20))
        await change([{ op: 'add', num: '2.6', title: 'Cache size' }])
        const shown = () => page.locator('[aria-label="Changes to open"] [data-unread]').evaluateAll(els => els.map(e => e.dataset.unread))
        await page.locator('[data-unread="2.6"]').waitFor()
        assert.deepEqual(await shown(), ['2.6', '4.3'])
        const order = page.locator('[data-queue-order]')
        assert.equal(await order.getAttribute('data-queue-order'), 'number')
        await order.click()
        await page.locator('[data-queue-order="time"]').waitFor()
        assert.deepEqual(await shown(), ['4.3', '2.6'])
        // The choice is the viewer's, kept with the rest of what the page remembers for them.
        assert.equal((await (await fetch(`${server.url}/api/state/demo/sample`)).json()).order, 'time')
        await page.reload()
        await page.locator('[data-queue-order="time"]').waitFor()
        assert.deepEqual(await shown(), ['4.3', '2.6'])
    })
})
