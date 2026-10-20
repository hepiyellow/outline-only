import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, outlineApiPath } from '@/lib/api'
import { UNTITLED, allNodes, currentPath, isStarting, linksByNum } from '@/lib/outline'
import { KIND_COLUMNS, SHOW_TITLE_CHECKBOX, Statuses, kindColumnsInView, marksChanged, type KindKey, type MarksChange } from '@/lib/status'
import { markStuck } from '@/lib/sticky'
import { topicTraceOf, traceOf } from '@/lib/trace'
import { cn } from '@/lib/utils'
import type { Lifecycle, Outline, OutlineNode, StageInfo, StageName, StatePatch, TopicLayout, ViewerState } from '@/types'
import { LifecycleView, hasTopics, lifecycleStartsOpen } from './Lifecycle'
import { agentOf } from './ModelPicker'
import { NodeHistory } from './NodeHistory'
import { Overview } from './Overview'
import { useNotify } from './Notice'
import { OutlineCtx, RemovedRow, Topic, isRemoved, withRemoved, type OutlineContext } from './NodeView'
import { waiting } from './queue'
import { RenameTitle } from './RenameTitle'

/** Which topics and parents the viewer opened or closed; the rest follow the statuses' `startsOpen`. */
export type OpenNodes = Record<string, boolean>

/** How long a parent the viewer had opened stays open after it becomes settled, in milliseconds. */
const SETTLE_PAUSE = 700

/** How long the kind marks that changed as a change was opened are drawn pulsing, a little over one grow and shrink. */
const PULSE_MS = 700

export const isOpenIn =
    (open: OpenNodes, statuses: Statuses, stages: Record<string, StageInfo> = {}) =>
    (node: OutlineNode) =>
        node.num in open ? open[node.num] : (lifecycleStartsOpen(node, stages) ?? statuses.startsOpen(node))

/** The lifecycle of an outline without topics: no topics, no stages, no marks. */
const NO_LIFECYCLE: Lifecycle = { topics: {}, stages: {}, nodes: {} }

/** Whether a node has nothing left to show: a parent that is settled, or a task the agent carried out and did not fail. */
const finished = (node: OutlineNode, statuses: Statuses) => (node.children.length ? statuses.isSettled(node) : statuses.ran(node) && !node.tags.includes('failed'))

/**
 * The Outline tab: any text before the first topic, then the topics with their nodes. An outline nobody has named yet
 * starts with the field that names it; once it has a title, the top bar shows it.
 */
/** The user's actions on nodes, from useApprovals. */
export type NodeActions = Pick<
    OutlineContext,
    | 'linked'
    | 'onCheck'
    | 'onTopicCheck'
    | 'onRun'
    | 'onReference'
    | 'onRemove'
    | 'pending'
    | 'unread'
    | 'diffs'
    | 'reviewing'
    | 'roots'
    | 'diffsAt'
    | 'held'
    | 'addedIn'
    | 'kindChangeOf'
    | 'onOpenChange'
    | 'onAccept'
    | 'onHide'
    | 'removedIn'
    | 'removedUnder'
    | 'onReviewRemoved'
    | 'unreadUnder'
    | 'messagesFor'
    | 'seen'
    | 'onSeen'
    | 'onReveal'
>

interface Props {
    outline: Outline
    /** The outline's nodes as the viewer sees them while changes wait to be opened (`shownNodes`). */
    shown: OutlineNode[]
    viewer: ViewerState
    actions: NodeActions
    onToggle: (node: OutlineNode, open: boolean) => void
    /** Changes the viewer state: the topic layouts and the stage view. */
    onViewer?: (patch: StatePatch) => void
}

/** What an outline without nodes says. One that is starting (`isStarting`) says so under it. */
const EMPTY = {
    linked: 'This outline is empty. Write to the agent below to begin.',
    unlinked: 'This outline is empty.',
}

export function OutlineTab({ outline, shown, viewer, actions, onToggle, onViewer = () => {} }: Props) {
    const root = useRef<HTMLDivElement>(null)
    const [historyOf, setHistoryOf] = useState<OutlineNode | null>(null)
    // The node whose overview is open, by number: the panel follows it as the outline changes.
    const [overviewOf, setOverviewOf] = useState<string | null>(null)
    // The changes that wait, in the diff view or not: their marks turn when they are accepted.
    const unopened = useMemo(() => new Set(actions.pending.keys()), [actions.pending])
    // The kind marks that changed as a change was accepted.
    const [pulse, setPulse] = useState<Map<string, MarksChange>>(new Map())
    const notify = useNotify()
    // A server from before topics sends none.
    const lifecycle = outline.lifecycle ?? NO_LIFECYCLE
    const act = useMemo(() => {
        const post = (body: unknown) => api(`/api/outline/${outlineApiPath(outline.project, outline.file)}/act`, body).catch((e: Error) => notify(e.message, true))
        return {
            onStage: (topic: string, name: StageName, on: boolean) => void post({ stage: { topic, name, on } }),
            onReopen: (stage: string) => void post({ reopen: stage }),
            onMerge: (num: string, into: string) => void post({ merge: { num, into } }),
        }
    }, [outline.project, outline.file, notify])
    const ctx = useMemo<OutlineContext>(() => {
        // The marks are those of the outline as it is shown: a node whose change waits keeps the kind it was read with.
        const statuses = new Statuses(shown, viewer.overrides, outline.mode, new Set(outline.unacked), unopened)
        const isOpen = isOpenIn(viewer.open, statuses, lifecycle.stages)
        return {
            ...actions,
            ...act,
            lifecycle,
            layoutOf: (topic: OutlineNode) => viewer.layout?.[topic.id ?? topic.num] ?? 'stage',
            onLayout: (topic: OutlineNode, layout: TopicLayout) => onViewer({ layout: { [topic.id ?? topic.num]: layout === 'stage' ? null : layout } }),
            nodeByNum: new Map(allNodes(shown).map(n => [n.num, n])),
            onOverview: (node: OutlineNode) => setOverviewOf(node.num),
            onHistory: setHistoryOf,
            statuses,
            // The first item about a node, as the queue column lists them.
            queued: new Map(
                waiting(outline.queue, statuses, viewer.runs, viewer.seen)
                    .filter(q => !q.missing)
                    .reverse()
                    .map(q => [q.item.num, q.item]),
            ),
            isOpen,
            kindColumns: withGone(kindColumnsInView(shown, statuses, isOpen), pulse),
            pulse,
            toggle: node => onToggle(node, !isOpen(node)),
            current: currentPath(shown),
            runs: viewer.runs,
            links: linksByNum(outline.nodes),
        }
    }, [outline, shown, viewer.open, viewer.overrides, viewer.runs, viewer.seen, viewer.layout, actions, unopened, pulse, onToggle, onViewer, act, lifecycle])

    // Accepting a change turns the marks it held back: each one that differs from before grows and shrinks once. What
    // it was is the outline as it was shown with the change not accepted, so only the click makes a difference.
    const prevUnopened = useRef<Set<string> | null>(null)
    const prevStatuses = useRef<Statuses | null>(null)
    const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    useEffect(() => () => clearTimeout(pulseTimer.current), [])
    useLayoutEffect(() => {
        const before = prevUnopened.current
        const was = prevStatuses.current
        prevUnopened.current = unopened
        if (!before || !was) return
        const opened = [...before].filter(num => !unopened.has(num))
        if (!opened.length) return
        const changes = marksChanged(was, ctx.statuses)
        if (!changes.size) return
        clearTimeout(pulseTimer.current)
        setPulse(changes)
        pulseTimer.current = setTimeout(() => setPulse(new Map()), PULSE_MS)
        // Only a change of what is unopened matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unopened])
    // After the comparison above: what the outline showed on the render before a change is opened.
    useLayoutEffect(() => {
        prevStatuses.current = ctx.statuses
    })

    // A parent that becomes settled collapses, also one the viewer had opened themselves: such a parent would stay
    // open by their choice, so it is closed here. After a pause, since a click that settles a parent closes it itself,
    // with its own animation. A task that becomes done does too, once its change is accepted (the node is read with
    // its old tags until then). A failed task stays, since it can be run again, and so does a node with a change in
    // the diff view at it or under it: it is being read.
    const settled = useRef<Set<string> | null>(null)
    const latest = useRef({ shown, open: viewer.open, statuses: ctx.statuses, onToggle, diffsAt: actions.diffsAt })
    latest.current = { shown, open: viewer.open, statuses: ctx.statuses, onToggle, diffsAt: actions.diffsAt }
    // The pauses run on, whatever the outline does meanwhile: accepting a change alters the statuses again at once, which
    // would clear a pause that a re-run of the effect below owned. What is open and settled is read when one ends.
    const settleTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
    useEffect(() => () => settleTimers.current.forEach(clearTimeout), [])
    useEffect(() => {
        const now = new Set(allNodes(shown).filter(n => finished(n, ctx.statuses)).map(n => n.num))
        const before = settled.current
        settled.current = now
        // On the first pass nothing became settled: it is how the outline was found.
        if (!before) return
        const turned = [...now].filter(num => !before.has(num))
        if (!turned.length) return
        const timer = setTimeout(() => {
            settleTimers.current.delete(timer)
            const { shown, open, statuses, onToggle, diffsAt } = latest.current
            for (const n of allNodes(shown)) if (turned.includes(n.num) && open[n.num] && finished(n, statuses) && !diffsAt(n.num).length) onToggle(n, false)
        }, SETTLE_PAUSE)
        settleTimers.current.add(timer)
        // Only a change of what is settled matters: the viewer opening a node is not one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shown, ctx.statuses])

    // A ripple that reaches a collapsed stage opens it, also one the viewer had closed: it holds what needs review.
    const reviewing = useRef<Set<string> | null>(null)
    useEffect(() => {
        const now = new Set(Object.entries(lifecycle.stages).filter(([, s]) => s.status === 'needs-review').map(([num]) => num))
        const before = reviewing.current
        reviewing.current = now
        if (!before) return
        for (const n of allNodes(shown)) if (now.has(n.num) && !before.has(n.num) && !ctx.isOpen(n)) onToggle(n, true)
        // Only a change of which stages need review matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lifecycle])

    const overviewNode = overviewOf ? (allNodes(outline.nodes).find(n => n.num === overviewOf) ?? null) : null

    // The header stack follows scrolling, resizing, and every change of the content.
    useLayoutEffect(() => {
        const el = root.current
        if (!el) return
        let queued = false
        const queue = () => {
            if (queued) return
            queued = true
            requestAnimationFrame(() => {
                queued = false
                markStuck(el)
            })
        }
        addEventListener('scroll', queue, { passive: true })
        addEventListener('resize', queue)
        const ro = new ResizeObserver(queue)
        ro.observe(el)
        return () => {
            removeEventListener('scroll', queue)
            removeEventListener('resize', queue)
            ro.disconnect()
        }
    }, [])
    useLayoutEffect(() => {
        if (root.current) markStuck(root.current)
    })

    return (
        <OutlineCtx.Provider value={ctx}>
            {overviewNode && (
                <Overview
                    node={overviewNode}
                    trace={overviewNode.tags.includes('topic') ? topicTraceOf(overviewNode, outline.nodes, lifecycle) : traceOf(overviewNode, outline.nodes, ctx.links)}
                    bottom={actions.linked ? 'var(--composer-h, 60px)' : '0px'}
                    onShow={num => {
                        // On a narrow window the panel covers the outline: it makes way for the node.
                        if (window.matchMedia('(max-width: 720px)').matches) setOverviewOf(null)
                        actions.onReveal(num)
                    }}
                    onClose={() => setOverviewOf(null)}
                />
            )}
            {historyOf && <NodeHistory project={outline.project} file={outline.file} node={historyOf} bottom={actions.linked ? 'var(--composer-h, 60px)' : '0px'} onClose={() => setHistoryOf(null)} />}
            <div ref={root} className="outline-tab" data-ck={SHOW_TITLE_CHECKBOX ? undefined : 'hidden'}>
                {outline.untitled && (
                    <h1 data-untitled className="mt-10 text-center text-xl font-semibold">
                        <RenameTitle project={outline.project} file={outline.file} title="" className="mx-auto max-w-md">
                            <span className="text-muted-foreground">{UNTITLED}</span>
                        </RenameTitle>
                    </h1>
                )}
                {outline.intro && <div className="outline-intro" dangerouslySetInnerHTML={{ __html: outline.intro }} />}
                {!outline.intro && !outline.nodes.length && (
                    <p data-empty role="status" className={cn(outline.untitled ? 'mt-3' : 'mt-10', 'text-center text-sm text-muted-foreground')}>
                        {EMPTY[actions.linked ? 'linked' : 'unlinked']}
                        {isStarting(outline, actions.linked) && (
                            // The page starts Claude sessions only, and nothing names the model before the agent attaches.
                            <span data-initializing className="mt-1 block" title="If this does not end, look at the Terminal view: the agent may be asking something there.">
                                {agentOf('', outline.model) || 'Claude'} is initializing the outline plugin
                                <Ellipsis />
                            </span>
                        )}
                    </p>
                )}
                {hasTopics(shown) ? (
                    <LifecycleView nodes={shown} removed={actions.removedIn('')} stageView={viewer.stageView} onStageView={stageView => onViewer({ stageView })} />
                ) : (
                    withRemoved(shown, actions.removedIn('')).map(n => (isRemoved(n) ? <RemovedRow key={`removed:${n.id}`} node={n} topic /> : <Topic key={n.num} node={n} />))
                )}
            </div>
        </OutlineCtx.Provider>
    )
}

/** The columns, and those of the marks that went and are still drawn while they pulse, in column order. */
function withGone(columns: KindKey[], pulse: Map<string, MarksChange>): KindKey[] {
    const gone = new Set<KindKey>()
    for (const c of pulse.values()) for (const key of Object.keys(c.gone) as KindKey[]) gone.add(key)
    return gone.size ? KIND_COLUMNS.filter(k => columns.includes(k) || gone.has(k)) : columns
}

/** Three dots that light up one after another: something is still going on. */
function Ellipsis() {
    return (
        <span className="ellipsis" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
        </span>
    )
}
