import { type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { allNodes } from '@/lib/outline'
import type { OutlineNode, RemovedNode, SoftFlag, StageInfo, StageName, TopicLayout, ViewerState } from '@/types'
import { Asks, Diff, DiffBar, Html, Messages, NodeList, RemovedRow, RowMarks, isRemoved, useOutlineCtx, withRemoved } from './NodeView'

// The lifecycle on the page (server mode, docs/adr/0005): an outline with topics shows each topic with its stages, and
// each stage with where it stands. An outline without topics is drawn as it always was (OutlineTab).

/** The stages of the lifecycle, in its order. */
export const STAGES: StageName[] = ['discussion', 'plan', 'implementation', 'verification', 'preservation']
export const STAGE_TITLE: Record<StageName, string> = { discussion: 'Discussion', plan: 'Plan', implementation: 'Implementation', verification: 'Verification', preservation: 'Preservation' }

/** What a stage's status reads as, in a word. */
const STATUS_TEXT: Record<StageInfo['status'], string> = { off: 'Off', 'not-started': 'Not started', active: 'Active', done: 'Done', 'needs-review': 'Needs review' }

/** Each soft flag: a word or two for its badge, and what it says in full. */
const FLAGS: Record<SoftFlag, [string, string]> = {
    unplanned: ['not planned', 'Nothing in an active Plan comes from this decision'],
    'no-decision': ['no decision', 'This plan item comes from no decision'],
    'unapproved-claim': ['unapproved claim', 'This plan item is built on a claim you have not approved'],
    'no-plan-item': ['no plan item', 'This task carries out no plan item'],
    unchecked: ['no check', 'No check covers this task'],
}

/**
 * What the lifecycle says of a node, as badges after its title: that a change upstream reached it and it needs
 * review, and its soft flags. None of them asks anything of the user.
 */
export function LifecycleBadges({ num }: { num: string }) {
    const { lifecycle } = useOutlineCtx()
    const own = lifecycle.nodes?.[num]
    if (!own) return null
    return (
        <>
            {own.review && (
                <span className="lc-badge review" data-review title="A change upstream reached this node: the agent looks at it again">
                    needs review
                </span>
            )}
            {own.flags?.map(f => (
                <span key={f} className="lc-badge flag" data-flag={f} title={FLAGS[f][1]}>
                    {FLAGS[f][0]}
                </span>
            ))}
        </>
    )
}

/** Whether the outline has its topics written: the page then draws topics and stages. */
export const hasTopics = (nodes: OutlineNode[]) => nodes.some(n => n.tags.includes('topic'))

/**
 * Whether a topic's or a stage's row starts open: a stage that is done or off starts collapsed to its one line, and
 * every other stage and every topic open. Undefined for any other node.
 */
export function lifecycleStartsOpen(node: OutlineNode, stages: Record<string, StageInfo>): boolean | undefined {
    // A stage a ripple reached opens: it holds what needs review.
    if (node.stage) return !['done', 'off'].includes(stages[node.num]?.status ?? '')
    if (node.tags.includes('topic')) return true
    return undefined
}

/** Clicks on controls, and text being selected, do not toggle a row. */
const isRowClick = (e: MouseEvent) => !(e.target as Element).closest('input,button,a,.extras') && !String(getSelection()).trim()

/**
 * A topic's stages as switches: each stage of the lifecycle, on or off, with where it stands. A click turns it on or
 * off, which is the user's own act; the last stage on cannot be turned off, and a topic placed inside a stage has no
 * stage before that one.
 */
export function StageSwitches({ topic }: { topic: OutlineNode }) {
    const { lifecycle, onStage } = useOutlineCtx()
    const on = topic.stages ?? []
    // A topic inside a stage starts at that stage or a later one.
    const holder = Object.entries(lifecycle.stages).find(([num]) => topic.num.startsWith(`${num}.`) && topic.num.split('.').length === num.split('.').length + 1)?.[1]
    const first = holder ? STAGES.indexOf(holder.name) : 0
    return (
        <span className="stage-switches" role="group" aria-label={`Stages of ${topic.num}`}>
            {STAGES.map((name, i) => {
                const isOn = on.includes(name)
                const stage = Object.entries(lifecycle.stages).find(([, s]) => s.topic === topic.num && s.name === name)?.[1]
                const last = isOn && on.length === 1
                const before = i < first
                const title = before
                    ? `${STAGE_TITLE[name]} comes before the stage this topic sits in`
                    : last
                      ? `${STAGE_TITLE[name]} is the only stage on: a topic always has one`
                      : isOn
                        ? `${STAGE_TITLE[name]}: ${STATUS_TEXT[stage?.status ?? 'not-started'].toLowerCase()}. Click to turn it off: its nodes are kept, folded away, and it asks nothing`
                        : `${STAGE_TITLE[name]} is off${stage ? ', its nodes kept' : ''}. Click to turn it on`
                return (
                    <button
                        key={name}
                        type="button"
                        className="stage-switch"
                        data-stage-switch={name}
                        data-status={isOn ? (stage?.status ?? 'not-started') : 'off'}
                        aria-pressed={isOn}
                        disabled={last || before}
                        title={title}
                        onClick={e => {
                            e.stopPropagation()
                            onStage(topic.num, name, !isOn)
                        }}
                    >
                        {STAGE_TITLE[name]}
                    </button>
                )
            })}
        </span>
    )
}

/**
 * The topics a topic waits for, as a badge: "waits for 1, 2", each number a click to that topic. Topics are never
 * reordered for it.
 */
function WaitsFor({ topic }: { topic: OutlineNode }) {
    const { lifecycle, onReveal } = useOutlineCtx()
    const on = lifecycle.topics[topic.num]?.waitsFor ?? []
    if (!on.length) return null
    return (
        <span className="waits-for" data-waits-for={on.join(',')} title="It waits for these topics to be done">
            waits for{' '}
            {on.map((num, i) => (
                <span key={num}>
                    {i > 0 && ', '}
                    <button
                        type="button"
                        className="link-num"
                        title={`Go to ${num} ${lifecycle.topics[num]?.title ?? ''}`.trim()}
                        onClick={e => {
                            e.stopPropagation()
                            onReveal(num, undefined, true)
                        }}
                    >
                        {num}
                    </button>
                </span>
            ))}
        </span>
    )
}

/**
 * A topic: a sticky heading with its number, title and stages, over its text and its stages. The outline's only
 * topic has no heading of its own (LifecycleView): its stages stand at the top.
 */
export function TopicSection({ node }: { node: OutlineNode }) {
    const { isOpen, toggle, current } = useOutlineCtx()
    const open = isOpen(node)
    return (
        <section className={cn('topic lc-topic', !open && 'closed')} data-topic={node.num}>
            <div
                className={cn('topic-head sticky-head', current.has(node.num) && 'current')}
                data-num={node.num}
                data-sticky
                aria-expanded={open}
                onClick={e => isRowClick(e) && toggle(node)}
            >
                <Diff node={node} />
                <ChevronDown className="tri size-4" aria-hidden="true" />
                <span className="node-title">
                    {node.num}. <span className="title-html" dangerouslySetInnerHTML={{ __html: node.titleHtml }} />
                </span>
                <WaitsFor topic={node} />
                <StageSwitches topic={node} />
                <LayoutSwitch topic={node} />
                <Messages node={node} />
                <Asks node={node} />
            </div>
            <div className="topic-body" hidden={!open}>
                <DiffBar node={node} />
                <Html className="topic-text node-html" html={node.html} hidden={!node.html} />
                <NodeList nodes={node.children} under={node.num} />
            </div>
        </section>
    )
}

/**
 * A stage of a topic: a row with its number, name and where it stands, over its nodes. One that is done collapses to
 * that row, and a Discussion or Plan done can be reopened there; the first stage on and not started is dimmed as the
 * next one; one turned off is folded away and dimmed, its nodes kept.
 */
export function StageSection({ node }: { node: OutlineNode }) {
    const { lifecycle, isOpen, toggle, statuses, onReopen } = useOutlineCtx()
    const info = lifecycle.stages[node.num]
    const open = isOpen(node)
    const status = info?.status ?? 'not-started'
    const closable = node.stage === 'discussion' || node.stage === 'plan'
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle(node)
        }
    }
    return (
        <section className={cn('group lc-stage', !open && 'closed')} data-stage={node.stage} data-status={status} data-next={info?.next || undefined}>
            <div className="row stage-head sticky-head" data-num={node.num} data-sticky aria-expanded={open} onClick={e => isRowClick(e) && toggle(node)}>
                <Diff node={node} />
                <ChevronDown className="tri size-4" aria-hidden="true" />
                <span className="num">{node.num}</span>
                <span className="node-title" role="button" tabIndex={0} onKeyDown={onKey}>
                    {node.title}
                </span>
                <span className="stage-status" data-stage-status={status}>
                    {info?.next ? 'Next' : STATUS_TEXT[status]}
                    {info?.progress && info.progress.total > 0 && (
                        <span className="stage-progress" data-progress>
                            {' '}
                            · {info.progress.done} of {info.progress.total} done
                        </span>
                    )}
                </span>
                {status === 'done' && closable && (
                    <button
                        type="button"
                        className="stage-reopen"
                        data-reopen
                        title={`Reopen ${node.title}: it is active again, and the agent is told`}
                        onClick={e => {
                            e.stopPropagation()
                            onReopen(node.num)
                        }}
                    >
                        <RotateCcw className="size-3" aria-hidden="true" /> Reopen
                    </button>
                )}
                <Messages node={node} />
                <RowMarks node={node} box={statuses.box(node)} />
            </div>
            <div className="kids" hidden={!open}>
                <StageNodes stage={node} empty={status === 'off' ? 'Turned off.' : 'Nothing here yet.'} />
            </div>
        </section>
    )
}

/**
 * The nodes of a stage, as its topic's layout lays them out. By stage they are as kept. By plan item, the Plan holds
 * each plan item with the tasks that carry it out under it, and the checks of each task under that; a task that
 * carries out two plan items stands under each, marked shared. The doing stages then hold what no plan item showed.
 */
function StageNodes({ stage, empty }: { stage: OutlineNode; empty: string }) {
    const { layoutOf, nodeByNum, links } = useOutlineCtx()
    const topic = nodeByNum.get(stage.num.split('.').slice(0, -1).join('.'))
    const byPlanItem = !!topic && layoutOf(topic) === 'plan'
    if (!byPlanItem || !topic) return stage.children.length ? <NodeList nodes={stage.children} under={stage.num} /> : <p className="stage-empty">{empty}</p>
    const inStage = (name: StageName) => (num: string) => num.startsWith(`${topic.num}.${STAGES.indexOf(name) + 1}.`)
    const tasksOf = (item: OutlineNode) => (links.get(item.num)?.usedBy ?? []).filter(inStage('implementation')).map(n => nodeByNum.get(n)).filter((n): n is OutlineNode => !!n)
    const checksOf = (task: OutlineNode) => (links.get(task.num)?.usedBy ?? []).filter(inStage('verification')).map(n => nodeByNum.get(n)).filter((n): n is OutlineNode => !!n)
    const items = allNodes(topic.children.find(c => c.stage === 'plan')?.children ?? []).filter(n => n.tags.includes('plan-item'))
    if (stage.stage === 'plan')
        return stage.children.length ? (
            <div className="lc-by-plan">
                {stage.children.map(item =>
                    item.tags.includes('plan-item') ? (
                        <div key={item.num} className="lc-plan-item" data-plan-item={item.num}>
                            <NodeList nodes={[item]} under={`plan:${item.num}`} />
                            {tasksOf(item).length > 0 && (
                                <div className="lc-carried">
                                    {tasksOf(item).map(task => {
                                        const shared = (links.get(task.num)?.from ?? []).filter(num => items.some(i => i.num === num)).length > 1
                                        return (
                                            <div key={task.num} className="lc-task" data-carried={task.num} data-shared={shared || undefined}>
                                                {shared && <span className="lc-badge shared">shared</span>}
                                                <NodeList nodes={[task]} under={`plan:${item.num}:${task.num}`} />
                                                {checksOf(task).length > 0 && (
                                                    <div className="lc-checks">
                                                        <NodeList nodes={checksOf(task)} under={`plan:${task.num}`} />
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    ) : (
                        <NodeList key={item.num} nodes={[item]} under={`plan:${item.num}`} />
                    ),
                )}
            </div>
        ) : (
            <p className="stage-empty">{empty}</p>
        )
    // A doing stage holds what no plan item showed above.
    const shown = new Set(items.flatMap(item => tasksOf(item).flatMap(task => [task.num, ...(stage.stage === 'verification' ? checksOf(task).map(c => c.num) : [])])))
    const rest = stage.children.filter(n => !shown.has(n.num))
    if (rest.length) return <NodeList nodes={rest} under={stage.num} />
    return <p className="stage-empty">{stage.children.length ? 'Shown under their plan items.' : empty}</p>
}

/** A topic's layout switch: by stage, as its nodes are kept, or by plan item. Only for a topic with a Plan. */
export function LayoutSwitch({ topic }: { topic: OutlineNode }) {
    const { layoutOf, onLayout } = useOutlineCtx()
    if (!topic.children.some(c => c.stage === 'plan')) return null
    const layout = layoutOf(topic)
    return (
        <span className="lc-layout" role="group" aria-label={`Layout of ${topic.num}`}>
            {(['stage', 'plan'] as TopicLayout[]).map(l => (
                <button
                    key={l}
                    type="button"
                    data-layout={l}
                    aria-pressed={layout === l}
                    title={l === 'stage' ? 'By stage: each stage with its nodes, as they are kept' : 'By plan item: each plan item with the tasks that carry it out, and their checks'}
                    onClick={e => {
                        e.stopPropagation()
                        onLayout(topic, l)
                    }}
                >
                    {l === 'stage' ? 'By stage' : 'By plan item'}
                </button>
            ))}
        </span>
    )
}

/**
 * An outline with topics. While it has one topic, the topic has no heading: its stage switches stand at the top, and
 * its stages under them, as the outline's top level. With more, each topic is drawn with its heading.
 */
export function LifecycleView({ nodes, removed, stageView, onStageView }: { nodes: OutlineNode[]; removed: RemovedNode[]; stageView: ViewerState['stageView']; onStageView: (view: NonNullable<ViewerState['stageView']>) => void }) {
    const view = stageView ?? { stage: '', topic: '' }
    return (
        <>
            <StageViewBar nodes={nodes} view={view} onStageView={onStageView} />
            {view.stage ? <StageView nodes={nodes} stage={view.stage} topic={view.topic} /> : <Topics nodes={nodes} removed={removed} />}
        </>
    )
}

/** The stage view's bar: the outline as it is, or one stage of every topic, with a filter by topic. */
function StageViewBar({ nodes, view, onStageView }: { nodes: OutlineNode[]; view: NonNullable<ViewerState['stageView']>; onStageView: (view: NonNullable<ViewerState['stageView']>) => void }) {
    const topics = allNodes(nodes).filter(n => n.tags.includes('topic'))
    return (
        <div className="lc-view" role="group" aria-label="Stage view">
            <span className="lc-bar-label">View</span>
            <button type="button" data-stage-view="" aria-pressed={!view.stage} onClick={() => onStageView({ stage: '', topic: view.topic })}>
                Outline
            </button>
            {STAGES.map(name => (
                <button key={name} type="button" data-stage-view={name} aria-pressed={view.stage === name} title={`${STAGE_TITLE[name]} of every topic`} onClick={() => onStageView({ stage: name, topic: view.topic })}>
                    {STAGE_TITLE[name]}
                </button>
            ))}
            {view.stage && topics.length > 1 && (
                <select aria-label="Topic" data-stage-topic value={view.topic} onChange={e => onStageView({ stage: view.stage, topic: e.target.value })}>
                    <option value="">Every topic</option>
                    {topics.map(t => (
                        <option key={t.num} value={t.id ?? t.num}>
                            {t.num}. {t.title}
                        </option>
                    ))}
                </select>
            )}
        </div>
    )
}

/** One stage of every topic (or of the one picked), each labeled with its topic. */
function StageView({ nodes, stage, topic }: { nodes: OutlineNode[]; stage: StageName; topic: string }) {
    const topics = allNodes(nodes).filter(n => n.tags.includes('topic') && (!topic || (n.id ?? n.num) === topic))
    const shown = topics.map(t => ({ t, s: t.children.find(c => c.stage === stage) })).filter(x => !!x.s)
    if (!shown.length) return <p className="stage-empty">No topic has {STAGE_TITLE[stage]}.</p>
    return (
        <div className="lc-stage-view" data-stage-view-of={stage}>
            {shown.map(({ t, s }) => (
                <div key={t.num} className="lc-stage-of" data-topic-label={t.num}>
                    <div className="lc-topic-label">
                        {t.num}. <span dangerouslySetInnerHTML={{ __html: t.titleHtml }} />
                    </div>
                    <StageSection node={s!} />
                </div>
            ))}
        </div>
    )
}

/** The topics, as kept. */
function Topics({ nodes, removed }: { nodes: OutlineNode[]; removed: RemovedNode[] }) {
    const rows = withRemoved(nodes, removed)
    const topics = nodes.filter(n => n.tags.includes('topic'))
    if (topics.length === 1 && !removed.length) {
        const [topic] = topics
        const stages = topic.children.filter(c => c.stage)
        // Its stage rows show once it has a second stage; until then its one stage's nodes are the top level.
        const shown = stages.length === 1 ? <NodeList nodes={stages[0].children} under={stages[0].num} /> : <NodeList nodes={topic.children} under={topic.num} />
        return (
            <div className="lc-one" data-topic={topic.num}>
                <div className="lc-bar">
                    <span className="lc-bar-label">Stages</span>
                    <StageSwitches topic={topic} />
                    <LayoutSwitch topic={topic} />
                </div>
                {topic.html && <Html className="topic-text node-html" html={topic.html} />}
                {shown}
            </div>
        )
    }
    return <>{rows.map(n => (isRemoved(n) ? <RemovedRow key={`removed:${n.id}`} node={n} topic /> : <TopicSection key={n.num} node={n} />))}</>
}
