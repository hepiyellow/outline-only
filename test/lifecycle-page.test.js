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

    const TWO_TOPICS = `# 1. @topic @stages:discussion,plan,implementation @id:topic1 Search

## 1.1 @stage:discussion @stage-done Discussion

### 1.1.1 @agent-claim Use Redis

## 1.2 @stage:plan Plan

### 1.2.1 @plan-item Size the cluster

## 1.3 @stage:implementation Implementation

# 2. @topic @stages:implementation @id:topic2 Rollout

## 2.3 @stage:implementation Implementation

### 2.3.1 @task-done Deploy to staging

### 2.3.2 @task Deploy everywhere

@Task. Deploys it.

## 2.4 @stage:verification Verification

### 2.4.1 @task Watch the errors

@Task. Watches them.
`
    const stage = num => page.locator(`.lc-stage:has(> [data-num="${num}"])`)
    const switchOf = (topic, name) => page.locator(`[data-topic="${topic}"] [data-stage-switch="${name}"]`).first()

    test('a plain outline looks as it does today: no topic heading, no stage rows, no switches', async () => {
        await show('plain', `# 1. Goals\n\n## 1.1 @agent-claim Fast answers\n\n# 2. Plan\n\n## 2.1 Cache in Redis\n`)
        assert.equal(await page.locator('.lc-bar, .lc-stage, .lc-topic, .stage-switch').count(), 0)
        assert.equal(await page.locator('section.topic > .topic-head[data-num="2"]').count(), 1)
        assert.ok(await node('2.1').isVisible())
    })

    test('each stage shows where it stands: done collapsed, active, the next dimmed, off folded and dimmed, with progress', async () => {
        await show('stages', TWO_TOPICS)
        assert.deepEqual(
            await page.locator('.lc-stage').evaluateAll(els => els.map(el => [el.querySelector('.num').textContent, el.dataset.status, el.dataset.next ?? ''])),
            [
                ['1.1', 'done', ''],
                ['1.2', 'active', ''],
                ['1.3', 'not-started', 'true'],
                ['2.3', 'active', ''],
                ['2.4', 'off', ''],
            ],
        )
        // Done: collapsed to its one line, with a button that reopens it.
        assert.equal(await node('1.1.1').isVisible(), false)
        assert.equal(await stage('1.1').locator('[data-stage-status]').textContent(), 'Done')
        assert.equal(await stage('1.1').locator('[data-reopen]').count(), 1)
        // Active, with what is in it.
        assert.ok(await node('1.2.1').isVisible())
        assert.equal(await stage('1.3').locator('[data-stage-status]').textContent(), 'Next')
        assert.equal(await stage('1.3').locator('.stage-empty').textContent(), 'Nothing here yet.')
        assert.ok(Number(await stage('1.3').locator('> .stage-head').evaluate(el => getComputedStyle(el).opacity)) < 1)
        assert.match(await stage('2.3').locator('[data-progress]').textContent(), /1 of 2 done/)
        // Off: folded away and dimmed, its nodes kept.
        assert.equal(await node('2.4.1').isVisible(), false)
        assert.ok(Number(await stage('2.4').locator('> .stage-head').evaluate(el => getComputedStyle(el).opacity)) < 1)
        await stage('2.4').locator('> .stage-head').click()
        assert.ok(await node('2.4.1').isVisible())
        // Each topic has its heading, with its stages as switches.
        assert.deepEqual(await page.locator('[data-topic="2"] > .topic-head [data-stage-switch]').evaluateAll(els => els.map(el => [el.dataset.stageSwitch, el.getAttribute('aria-pressed'), el.dataset.status])), [
            ['discussion', 'false', 'off'],
            ['plan', 'false', 'off'],
            ['implementation', 'true', 'active'],
            ['verification', 'false', 'off'],
            ['preservation', 'false', 'off'],
        ])
        // The only stage on cannot be turned off.
        assert.equal(await switchOf('2', 'implementation').isDisabled(), true)
    })

    test('the one topic has no heading: its stage rows show once it has a second stage', async () => {
        await show('one', `# 1. @topic @stages:discussion,plan @id:topic1 Search\n\n## 1.1 @stage:discussion Discussion\n\n### 1.1.1 @agent-claim Use Redis\n\n## 1.2 @stage:plan Plan\n`)
        assert.equal(await page.locator('.lc-topic, section.topic').count(), 0)
        assert.equal(await page.locator('.lc-bar [data-stage-switch]').count(), 5)
        assert.equal(await page.locator('.lc-stage').count(), 2)
        await page.close()
        await show('alone', `# 1. @topic @stages:discussion @id:topic1 Search\n\n## 1.1 @stage:discussion Discussion\n\n### 1.1.1 @agent-claim Use Redis\n`)
        assert.equal(await page.locator('.lc-stage').count(), 0)
        assert.ok(await node('1.1.1').isVisible())
        assert.equal(await page.locator('.lc-bar [data-stage-switch]').count(), 5)
    })

    test('a stage is turned off and on from its switch, as the user’s act, and a done Discussion is reopened', async () => {
        await show('switch', TWO_TOPICS)
        const file = path.join(server.dir, 'demo', 'switch.md')
        const text = () => fs.readFileSync(file, 'utf8')
        await switchOf('1', 'plan').click()
        await until(() => /^# 1\. @topic @stages:discussion,implementation @id:topic1 Search$/m.test(text()), { what: 'Plan to be turned off' })
        // Its node is kept, and the stage folds away.
        assert.match(text(), /^### 1\.2\.1 @plan-item Size the cluster$/m)
        await until(async () => (await stage('1.2').getAttribute('data-status')) === 'off', { what: 'the stage to show off' })
        assert.equal(await node('1.2.1').isVisible(), false)
        const history = await (await fetch(`${server.url}/api/outline/demo/switch/history?num=1`, { headers: { origin: server.url } })).json()
        assert.deepEqual(history.flatMap(e => e.did ?? []), [{ what: 'turned-off', kind: 'plain', stage: 'plan' }])
        await switchOf('1', 'plan').click()
        await until(() => /@stages:discussion,plan,implementation /.test(text()), { what: 'Plan to be turned on again' })
        await until(async () => (await stage('1.2').getAttribute('data-status')) === 'active', { what: 'the stage to be active again' })
        // A stage that was off and empty goes when turned off; turned on, it comes back.
        await switchOf('2', 'preservation').click()
        await until(() => /^## 2\.5 @stage:preservation Preservation$/m.test(text()), { what: 'Preservation to be on' })
        await stage('1.1').locator('[data-reopen]').click()
        await until(() => /^## 1\.1 @stage:discussion Discussion$/m.test(text()), { what: 'Discussion to be reopened' })
        await until(async () => (await stage('1.1').getAttribute('data-status')) === 'active', { what: 'Discussion to be active' })
    })

    test('a topic shows the topics it waits for as a badge, each a click to it, and keeps its place', async () => {
        await show(
            'waits',
            `# 1. @topic @stages:discussion @id:topica Search\n\n## 1.1 @stage:discussion Discussion\n\n### 1.1.1 @agent-claim @id:aaaaa1 Use Redis\n\n# 2. @topic @stages:discussion @id:topicb Billing\n\n## 2.1 @stage:discussion Discussion\n\n### 2.1.1 @links:aaaaa1 Bill per request\n\n# 3. @topic @stages:discussion @depends:topica,topicb @id:topicc Rollout\n\n## 3.1 @stage:discussion Discussion\n`,
        )
        assert.equal(await page.locator('[data-topic="2"] > .topic-head .waits-for').textContent(), 'waits for 1')
        assert.equal(await page.locator('[data-topic="3"] > .topic-head .waits-for').textContent(), 'waits for 1, 2')
        assert.equal(await page.locator('[data-topic="1"] > .topic-head .waits-for').count(), 0)
        // Topics stay in their order.
        assert.deepEqual(await page.locator('.lc-topic').evaluateAll(els => els.map(el => el.dataset.topic)), ['1', '2', '3'])
        // A click on a number opens that topic.
        await page.locator('[data-topic="1"] > .topic-head .node-title').click()
        assert.equal(await node('1.1.1').isVisible(), false)
        await page.locator('[data-topic="2"] > .topic-head .waits-for button').click()
        await until(() => node('1.1.1').isVisible(), { what: 'topic 1 to open' })
    })

    test('a node a ripple reached says it needs review, soft flags show as badges, and a collapsed stage it reaches opens', async () => {
        const body = review => `# 1. @topic @stages:discussion,plan,implementation @id:topica Search

## 1.1 @stage:discussion Discussion

### 1.1.1 @agent-claim @id:aaaaa1 Use Redis

## 1.2 @stage:plan @stage-done Plan

### 1.2.1 @plan-item ${review ? '@needs-review ' : ''}@id:aaaaa2 @links:aaaaa1 Size the cluster

## 1.3 @stage:implementation Implementation

### 1.3.1 @task Tidy up

@Task. Tidies.
`
        await show('ripple', body(false))
        assert.equal(await stage('1.2').getAttribute('data-status'), 'done')
        assert.equal(await node('1.2.1').isVisible(), false)
        assert.equal(await node('1.3.1').locator('[data-flag="no-plan-item"]').textContent(), 'no plan item')
        assert.equal(await node('1.3.1').locator('[data-flag="no-plan-item"]').getAttribute('title'), 'This task carries out no plan item')
        // The viewer opens the stage and closes it again: closed by their own choice.
        await stage('1.2').locator('> .stage-head .node-title').click()
        await until(() => node('1.2.1').isVisible(), { what: 'the stage to open' })
        await stage('1.2').locator('> .stage-head .node-title').click()
        await until(async () => !(await node('1.2.1').isVisible()), { what: 'the stage to close' })
        fs.writeFileSync(path.join(server.dir, 'demo', 'ripple.md'), HEAD + body(true))
        await until(async () => (await stage('1.2').getAttribute('data-status')) === 'needs-review', { what: 'the stage to need review' })
        await until(() => node('1.2.1').isVisible(), { what: 'the stage to open' })
        assert.equal(await stage('1.2').locator('[data-stage-status]').textContent(), 'Needs review')
        assert.equal(await node('1.2.1').locator('[data-review]').textContent(), 'needs review')
    })

    const PLAN_ITEMS = `# 1. @topic @stages:discussion,plan,implementation,verification @id:topica Search

## 1.1 @stage:discussion Discussion

### 1.1.1 @user-approved @agent-claim @id:aaaaa1 Use Redis

## 1.2 @stage:plan Plan

### 1.2.1 @plan-item @id:aaaaa2 @links:aaaaa1 Size the cluster

### 1.2.2 @plan-item @id:aaaaa3 @links:aaaaa1 Write the client

## 1.3 @stage:implementation Implementation

### 1.3.1 @task-done @id:bbbbb1 @links:aaaaa2 Provision three nodes

### 1.3.2 @task @id:bbbbb2 @links:aaaaa2,aaaaa3 Wire config for both

@Task. Wires it.

### 1.3.3 @task Tidy up

@Task. Tidies.

## 1.4 @stage:verification Verification

### 1.4.1 @task @links:bbbbb2 Run the integration tests

@Task. Runs them.

# 2. @topic @stages:discussion,implementation @id:topicb Rollout

## 2.1 @stage:discussion Discussion

### 2.1.1 @agent-claim Region by region

## 2.3 @stage:implementation Implementation

### 2.3.1 @task Deploy

@Task. Deploys it.
`

    test('a topic is laid out by plan item: each with the tasks that carry it out and their checks, a shared task under each; same numbers', async () => {
        await show('layout', PLAN_ITEMS)
        // By stage, as kept.
        assert.equal(await page.locator('[data-carried]').count(), 0)
        await page.locator('[data-topic="1"] [data-layout="plan"]').click()
        await until(() => page.locator('[data-plan-item="1.2.1"] [data-carried]').count(), { what: 'the layout by plan item' })
        const carried = item => page.locator(`[data-plan-item="${item}"] > .lc-carried > [data-carried]`).evaluateAll(els => els.map(el => [el.dataset.carried, el.dataset.shared ?? '']))
        assert.deepEqual(await carried('1.2.1'), [['1.3.1', ''], ['1.3.2', 'true']])
        assert.deepEqual(await carried('1.2.2'), [['1.3.2', 'true']])
        assert.equal(await page.locator('[data-carried="1.3.2"] .lc-checks [data-num="1.4.1"]').count(), 2)
        // What no plan item showed stays in its stage.
        assert.deepEqual(await stage('1.3').locator('> .kids [data-num]').evaluateAll(els => els.map(el => el.dataset.num)), ['1.3.3'])
        assert.equal(await stage('1.4').locator('.stage-empty').textContent(), 'Shown under their plan items.')
        // The other topic, without a Plan, has no layout switch.
        assert.equal(await page.locator('[data-topic="2"] .lc-layout').count(), 0)
        // The choice is the viewer's, kept by the server.
        const state = await (await fetch(`${server.url}/api/state/demo/layout`, { headers: { origin: server.url } })).json()
        assert.deepEqual(state.layout, { topica: 'plan' })
        await page.reload()
        await until(() => page.locator('[data-plan-item="1.2.1"] [data-carried]').count(), { what: 'the layout after a reload' })
        await page.locator('[data-topic="1"] [data-layout="stage"]').click()
        await until(async () => (await page.locator('[data-carried]').count()) === 0, { what: 'the layout by stage' })
    })

    test('the stage view shows one stage of every topic, each labeled with its topic, with a filter by topic', async () => {
        await show('stageview', PLAN_ITEMS)
        await page.locator('[data-stage-view="implementation"]').click()
        await until(() => page.locator('.lc-stage-view').count(), { what: 'the stage view' })
        assert.deepEqual(await page.locator('.lc-stage-of').evaluateAll(els => els.map(el => [el.dataset.topicLabel, el.querySelector('.lc-topic-label').textContent])), [
            ['1', '1. Search'],
            ['2', '2. Rollout'],
        ])
        assert.deepEqual(await page.locator('.lc-stage-view .lc-stage > .stage-head').evaluateAll(els => els.map(el => el.dataset.num)), ['1.3', '2.3'])
        assert.equal(await node('1.1.1').count(), 0)
        await page.locator('[data-stage-topic]').selectOption('topicb')
        await until(async () => (await page.locator('.lc-stage-of').count()) === 1, { what: 'the filter by topic' })
        assert.ok(await node('2.3.1').isVisible())
        await page.locator('[data-stage-view="discussion"]').click()
        await until(() => node('2.1.1').isVisible(), { what: 'the other stage of the same topic' })
        const state = await (await fetch(`${server.url}/api/state/demo/stageview`, { headers: { origin: server.url } })).json()
        assert.deepEqual(state.stageView, { stage: 'discussion', topic: 'topicb' })
        await page.locator('[data-stage-view=""]').click()
        await until(() => page.locator('.lc-topic').count().then(n => n === 2), { what: 'the outline as it is' })
    })
})
