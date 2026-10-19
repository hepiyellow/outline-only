import { type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OutlineNode, RemovedNode, StageInfo, StageName } from '@/types'
import { Asks, Diff, DiffBar, Html, Messages, NodeList, RemovedRow, RowMarks, isRemoved, useOutlineCtx, withRemoved } from './NodeView'

// The lifecycle on the page (server mode, docs/adr/0005): an outline with topics shows each topic with its stages, and
// each stage with where it stands. An outline without topics is drawn as it always was (OutlineTab).

/** The stages of the lifecycle, in its order. */
export const STAGES: StageName[] = ['discussion', 'plan', 'implementation', 'verification', 'preservation']
export const STAGE_TITLE: Record<StageName, string> = { discussion: 'Discussion', plan: 'Plan', implementation: 'Implementation', verification: 'Verification', preservation: 'Preservation' }

/** What a stage's status reads as, in a word. */
const STATUS_TEXT: Record<StageInfo['status'], string> = { off: 'Off', 'not-started': 'Not started', active: 'Active', done: 'Done' }

/** Whether the outline has its topics written: the page then draws topics and stages. */
export const hasTopics = (nodes: OutlineNode[]) => nodes.some(n => n.tags.includes('topic'))

/**
 * Whether a topic's or a stage's row starts open: a stage that is done or off starts collapsed to its one line, and
 * every other stage and every topic open. Undefined for any other node.
 */
export function lifecycleStartsOpen(node: OutlineNode, stages: Record<string, StageInfo>): boolean | undefined {
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
                <StageSwitches topic={node} />
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
                {node.children.length ? <NodeList nodes={node.children} under={node.num} /> : <p className="stage-empty">{status === 'off' ? 'Turned off.' : 'Nothing here yet.'}</p>}
            </div>
        </section>
    )
}

/**
 * An outline with topics. While it has one topic, the topic has no heading: its stage switches stand at the top, and
 * its stages under them, as the outline's top level. With more, each topic is drawn with its heading.
 */
export function LifecycleView({ nodes, removed }: { nodes: OutlineNode[]; removed: RemovedNode[] }) {
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
                </div>
                {topic.html && <Html className="topic-text node-html" html={topic.html} />}
                {shown}
            </div>
        )
    }
    return <>{rows.map(n => (isRemoved(n) ? <RemovedRow key={`removed:${n.id}`} node={n} topic /> : <TopicSection key={n.num} node={n} />))}</>
}
