import { createContext, useContext, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { Check, ChevronDown, ClipboardCopy, Copy, History, Reply, Sparkle, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/send'
import type { Statuses } from '@/lib/status'
import { DONE_PILL, FAILED_PILL, contentHtml, liveHtml, type NodeContent } from '@/lib/content'
import { allNodes, type NodeLinks } from '@/lib/outline'
import type { Box, KindKey, MarksChange } from '@/lib/status'
import type { Lifecycle, Message, OutlineNode, QueueItem, RemovedNode, StageName } from '@/types'
import { NodeMessages } from './Inbox'
import { useNotify } from './Notice'
import type { PendingChange } from '@/lib/pending'
import { DIFF_ICON, MINUS_ICON, PLUS_ICON } from './queue'
import { LifecycleBadges, StageSection, TopicSection } from './Lifecycle'
import { Marks, StatusBox, Tick, type OwnRole } from './StatusBox'

/** What every node of the Outline tab needs: statuses, which nodes are open, the current path, and the user's actions. */
export interface OutlineContext {
    statuses: Statuses
    isOpen: (node: OutlineNode) => boolean
    toggle: (node: OutlineNode) => void
    current: Set<string>
    /** Linked to a session: messages go to it, and the reference button adds to the input box. */
    linked: boolean
    /** Actions the user asked the agent to run, waiting for it to mark them @ran. */
    runs: Record<string, number | string>
    /** The queue items still waiting for the user, by the node they are about. */
    queued: Map<string, QueueItem>
    onCheck: (node: OutlineNode) => void
    onTopicCheck: (topic: OutlineNode) => void
    onRun: (node: OutlineNode) => void
    onReference: (node: OutlineNode) => void
    /** The trash button: asks the agent to take the node out of the outline, once the user has said why. */
    onRemove: (node: OutlineNode) => void
    /** Opens the node's history: its changes, and the node as it was at each. */
    onHistory: (node: OutlineNode) => void
    /** The changes that wait for the viewer to open them, by node: changed nodes, and nodes added. */
    pending: ReadonlyMap<string, PendingChange>
    /** Nodes changed since the viewer read them: what they read, shown until they open the diff. */
    unread: Map<string, NodeContent>
    /** Changed nodes in the diff view: their title and text as they are now, with what changed marked. */
    diffs: Map<string, NodeContent>
    /** The changes in the diff view (node numbers, and `removed:<id>`), each with the number it is at or under. */
    reviewing: ReadonlyMap<string, string>
    /** The nodes whose diff button opened the diff view: they can accept every change under them at once. */
    roots: ReadonlySet<string>
    /** The changes in the diff view at a node or under it. */
    diffsAt: (num: string) => string[]
    /** Whether a node takes no action yet: its change, or that of the added node it is in, is not accepted. */
    held: (num: string) => boolean
    /** Whether a node is an added node whose diff is open, or inside one. */
    addedIn: (num: string) => boolean
    /** A changed node whose kind mark changes: the mark it had, and the one accepting it brings. */
    kindChangeOf: (num: string) => { from?: KindKey; to?: KindKey } | undefined
    /** A click on a node's diff button: opens the diff of its own change and of every change under it. */
    onOpenChange: (node: OutlineNode) => void
    /** Accepts changes in the diff view: the nodes then read as they are now, and removed ones are gone. */
    onAccept: (keys: string[]) => void
    /** Hides the diff view at a node and under it (or of one removed node): its changes wait again. */
    onHide: (key: string) => void
    /** The nodes taken out since the viewer last looked that stood directly under a node (`''`: the topics). */
    removedIn: (parent: string) => RemovedNode[]
    /** How many nodes were taken out anywhere under a node, whose diff is not open. */
    removedUnder: (num: string) => number
    /** A click on a removed row's minus: the row shows in the diff view, to be accepted. */
    onReviewRemoved: (node: RemovedNode) => void
    /** The nodes under a node with a change whose diff is not open. */
    unreadUnder: (num: string) => string[]
    /** The agent's messages about a node or any node under it. */
    messagesFor: (num: string) => Message[]
    seen: Record<string, number>
    onSeen: (ids: string[]) => void
    /** Opens the way to a node and scrolls to it; `then` runs once it is there, and `inside` opens the node itself too. */
    onReveal: (num: string, then?: (el: HTMLElement) => void, inside?: boolean) => void
    /** The columns of the kind marks of the rows in view, in the order they are drawn (`kindColumnsInView`). */
    kindColumns: KindKey[]
    /** Node number → the kind marks that changed as a change was opened: they pulse once. */
    pulse: Map<string, MarksChange>
    /** Node number → its links by the numbers the nodes have now (server mode). */
    links: Map<string, NodeLinks>
    /** Server mode: the outline's topics and stages, with where each stage stands. */
    lifecycle: Lifecycle
    /** The user turns a stage of a topic on or off. */
    onStage: (topic: string, name: StageName, on: boolean) => void
    /** The user reopens a Discussion or a Plan the agent closed. */
    onReopen: (stage: string) => void
}

export const OutlineCtx = createContext<OutlineContext | null>(null)

export const useOutlineCtx = () => {
    const ctx = useContext(OutlineCtx)
    if (!ctx) throw new Error('OutlineCtx missing')
    return ctx
}

/** Server HTML: React sets it, and leaves its children alone. */
export function Html({ html, className, hidden }: { html: string; className?: string; hidden?: boolean }) {
    return <div className={className} hidden={hidden} dangerouslySetInnerHTML={{ __html: html }} />
}

/** The node's title, then the tags the page draws for it. */
function Title({ node, titleHtml }: { node: OutlineNode; titleHtml: string }) {
    const { statuses } = useOutlineCtx()
    const group = statuses.isGroup(node)
    return (
        <span className="node-title">
            <span className="title-html" dangerouslySetInnerHTML={{ __html: titleHtml }} />
            {group && (
                <span className="pill pill-pick" title="Choose exactly one of the options below">
                    ◉ Pick one
                </span>
            )}
            {!node.children.length && node.tags.includes('options') && (
                <span className="pill pill-options" title="Options proposed, no recommendation yet">
                    ❓ Options
                </span>
            )}
            {statuses.isOption(node) && node.tags.includes('recommended') && (
                <span className="pill pill-recommended" title="The option the agent recommends">
                    <Sparkle aria-hidden="true" /> Recommended
                </span>
            )}
            {/* An action the agent ran says so on its Action line; without that line, here. */}
            {(node.tags.includes('ran') || node.tags.includes('failed')) && !node.closing.some(c => c.kind === 'action') && (
                <span dangerouslySetInnerHTML={{ __html: node.tags.includes('ran') ? DONE_PILL : FAILED_PILL }} />
            )}
        </span>
    )
}

/** Scrolls to the button in a node's text that runs its action, and pulses it, once the node has opened. */
function pointAtRun(num: string) {
    setTimeout(() => {
        const button = document.querySelector(`.outline-tab [data-text-of="${CSS.escape(num)}"] [data-run]`)
        if (!button) return
        button.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        button.removeAttribute('data-pulse')
        void (button as HTMLElement).offsetWidth
        button.setAttribute('data-pulse', '')
    }, 0)
}

/** Makes a checkbox, or a row's own kind icon, grow and shrink: this is where to look, or to click. */
function pulseBox(box: HTMLElement) {
    box.removeAttribute('data-pulse')
    void box.offsetWidth
    box.setAttribute('data-pulse', '')
}

/** Shows the button that picks an option and pulses it: the option's Run button waits for the pick. */
function pointAtPick(num: string) {
    const button = document.querySelector<HTMLElement>(`.outline-tab [data-pick-of="${CSS.escape(num)}"] [data-pick]`)
    if (!button) return
    button.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    pulseBox(button)
}

/** Whether a row holds the button that picks it: an option, unless it is a bare row (added, its diff not open). */
const usePickable = (node: OutlineNode) => {
    const { statuses, pending, reviewing } = useOutlineCtx()
    return statuses.isOption(node) && !(pending.get(node.num)?.kind === 'added' && !reviewing.has(node.num))
}

/**
 * An option's pick button, first in its text, with a line that says what a click on it does. It is where an option is
 * picked: nothing left of a title does that. Once picked it says so, and a click takes the pick back; picking another
 * option moves the pick. An option whose change waits is not picked: the user has not accepted what they would pick.
 */
function PickLine({ node, className, hidden }: { node: OutlineNode; className?: string; hidden?: boolean }) {
    const { statuses, held, onCheck } = useOutlineCtx()
    const box = statuses.box(node)
    const question = statuses.parent(node)
    const picked = box.state !== 'open'
    const other = question?.children.find(c => c !== node && statuses.effective(c))
    const unread = held(node.num)
    const line = unread
        ? 'Accept the change of this option before you pick it.'
        : picked
          ? `Your answer to ${question?.num}. A click takes it back.`
          : other
            ? `Answers ${question?.num} with this option instead of ${other.option ? `(${other.option})` : other.num}.`
            : `Answers ${question?.num} with this option.`
    return (
        <div className={cn('pick-line', className)} hidden={hidden} data-pick-of={node.num}>
            <button
                type="button"
                className="pill pick"
                data-pick
                data-state={box.state}
                data-waiting={box.waiting || undefined}
                data-off={unread || undefined}
                aria-pressed={picked}
                aria-disabled={unread}
                title={box.waiting || box.state === 'pending' ? box.title : undefined}
                onClick={e => {
                    e.stopPropagation()
                    onCheck(node)
                }}
            >
                {picked && <Tick state="approved" radio={false} />}
                {picked ? 'Picked' : 'Pick this option'}
            </button>
            <span className="pick-what">{line}</span>
        </div>
    )
}

/**
 * A node's text. The Action button in it runs the action, then shows a turning ring until the agent marks the action
 * done or failed. A failed one can be run again.
 */
function NodeText({ node, html, className, hidden }: { node: OutlineNode; html: string; className: string; hidden?: boolean }) {
    const { runs, onRun, statuses } = useOutlineCtx()
    const sent = !!runs[node.num]
    // An option's action waits for its option to be picked: until then its Run button is off.
    const unpicked = statuses.isOption(node) && !statuses.effective(node)
    const root = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        for (const button of root.current?.querySelectorAll<HTMLButtonElement>('[data-run]') ?? []) {
            // Looks off but takes the click: it points at the option's pick button, which is what to do first.
            button.toggleAttribute('data-off', unpicked)
            button.setAttribute('aria-disabled', String(unpicked))
            // The button's own title comes back once its option is picked.
            button.dataset.title ??= button.title
            button.title = unpicked ? 'Pick this option first: click to see its button' : button.dataset.title
        }
    }, [html, unpicked])
    return (
        <div
            ref={root}
            className={className}
            hidden={hidden}
            data-text-of={node.num}
            data-run-sent={sent || undefined}
            data-run-off={unpicked || undefined}
            onClick={e => {
                if (!(e.target as Element).closest('[data-run]')) return
                e.stopPropagation()
                if (unpicked) return pointAtPick(node.num)
                if (!sent) onRun(node)
            }}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    )
}

/** Copies a reference to the node (or, linked to a session, adds it to the input box). */
function Ask({ node }: { node: OutlineNode }) {
    const { linked, onReference } = useOutlineCtx()
    const label = linked ? 'Add a reference to this item to the message box' : 'Copy a reference to paste into the chat'
    return (
        <button
            type="button"
            className="ask"
            title={label}
            aria-label={label}
            onClick={e => {
                e.stopPropagation()
                onReference(node)
            }}
        >
            {linked ? <Reply className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
    )
}

/** Copies the node's markdown, with everything under it, to paste into another session as a handoff. */
function CopyMarkdownButton({ node }: { node: OutlineNode }) {
    const notify = useNotify()
    if (node.markdown === undefined) return null
    const label = node.children.length ? 'Copy the markdown of this item and everything under it' : 'Copy the markdown of this item'
    return (
        <button
            type="button"
            className="ask"
            data-copy-markdown
            title={label}
            aria-label={`Copy the markdown of ${node.num}`}
            onClick={async e => {
                e.stopPropagation()
                const ok = await copyText(node.markdown ?? '')
                notify(ok ? `Copied ${node.num} as markdown` : 'The clipboard is not available', !ok)
            }}
        >
            <ClipboardCopy className="size-3.5" />
        </button>
    )
}

/** The node's history, on hover: its changes, with the node as it was at each. */
function HistoryButton({ node }: { node: OutlineNode }) {
    const { onHistory } = useOutlineCtx()
    return (
        <button
            type="button"
            className="ask"
            title="History: the changes to this node"
            aria-label={`History of ${node.num}`}
            onClick={e => {
                e.stopPropagation()
                onHistory(node)
            }}
        >
            <History className="size-3.5" />
        </button>
    )
}

/** Asks to take the node out of the outline, on hover: linked to a session, it waits in the input box for the user's reason. */
function RemoveButton({ node }: { node: OutlineNode }) {
    const { linked, onRemove } = useOutlineCtx()
    const label = linked ? 'Remove this item: adds it to the message box, for you to say why' : 'Remove this item: copies the request to paste into the chat'
    return (
        <button
            type="button"
            className="ask"
            data-remove
            title={label}
            aria-label={`Remove ${node.num}`}
            onClick={e => {
                e.stopPropagation()
                onRemove(node)
            }}
        >
            <Trash2 className="size-3.5" />
        </button>
    )
}

/** A parent's buttons on hover: the reference, the markdown copy, the history, the trash, and the diff of everything changed under it. */
export function Asks({ node }: { node: OutlineNode }) {
    const { unreadUnder, onOpenChange } = useOutlineCtx()
    const under = unreadUnder(node.num).length
    return (
        <span className="asks">
            <Ask node={node} />
            <CopyMarkdownButton node={node} />
            <HistoryButton node={node} />
            <RemoveButton node={node} />
            {under > 0 && (
                <button
                    type="button"
                    className="ask-diff"
                    data-unread-under={under}
                    title={`${under} change${under === 1 ? '' : 's'} under this node since you read ${under === 1 ? 'it' : 'them'}: click to see all`}
                    aria-label={`See what changed under ${node.num}`}
                    onClick={e => {
                        e.stopPropagation()
                        onOpenChange(node)
                    }}
                >
                    {DIFF_ICON}
                </button>
            )}
        </span>
    )
}

/**
 * The diff button, the one icon left of a title: the node has a change the viewer has not accepted. A plus over a minus
 * for a node that changed, a plus for one that was added. A closed parent shows it for the changes under it, which
 * nothing else on screen would say; an open one leaves that to its nodes. A click opens the diff of the node's change
 * and of every change under it; on a node whose diff is open, it hides the diff again.
 */
export function Diff({ node }: { node: OutlineNode }) {
    const { pending, reviewing, unreadUnder, removedUnder, isOpen, onOpenChange, onHide } = useOutlineCtx()
    const own = pending.get(node.num)
    const shown = !!own && reviewing.has(node.num)
    const under = !own && !isOpen(node) ? unreadUnder(node.num).length + removedUnder(node.num) : 0
    if (!own && !under) return null
    const added = own?.kind === 'added'
    const title = shown
        ? 'Showing what changed: click to hide it again'
        : added
          ? 'Added since you last looked: click to see it'
          : own
            ? `Changed since you read it${own.done ? ', and now done' : ''}: click to see what changed`
            : `${under} change${under === 1 ? '' : 's'} under this node since you read ${under === 1 ? 'it' : 'them'}: click to see ${under === 1 ? 'it' : 'them'}`
    return (
        <button
            type="button"
            className="env"
            data-change={added ? 'added' : own ? 'changed' : 'under'}
            data-open={shown || undefined}
            // The new content has the agent's Done tag: the change is an action carried out, which the icon shows in yellow.
            data-done={own?.done || undefined}
            aria-pressed={own ? shown : undefined}
            title={title}
            aria-label={shown ? `Hide what changed in ${node.num}` : added ? `See the new node ${node.num}` : own ? `See what changed in ${node.num}` : `See what changed under ${node.num}`}
            onClick={e => {
                e.stopPropagation()
                if (shown) onHide(node.num)
                else onOpenChange(node)
            }}
        >
            {added ? PLUS_ICON : DIFF_ICON}
        </button>
    )
}

/** What a kind mark is, in a word or two, for the diff bar. */
const KIND_NAME: Record<KindKey, string> = {
    claim: 'claim',
    'claim-approved': 'approved claim',
    question: 'question',
    answered: 'answered question',
    action: 'task',
    done: 'done task',
    failed: 'failed task',
}

/**
 * The bar of a node in the diff view, above its text: what the change is (changed, with its kind if that changed too,
 * or added), and the button that accepts it. On the node whose diff button opened the view, it also accepts every
 * change under it at once, and hides the diff.
 */
export function DiffBar({ node }: { node: OutlineNode }) {
    const { pending, reviewing, roots, diffsAt, kindChangeOf, onAccept, onHide } = useOutlineCtx()
    const own = reviewing.has(node.num) ? pending.get(node.num) : undefined
    const root = roots.has(node.num)
    const all = root ? diffsAt(node.num) : []
    if (!own && !all.length) return null
    const kind = own?.kind === 'changed' ? kindChangeOf(node.num) : undefined
    const under = own?.kind === 'added' ? allNodes([node]).length - 1 : 0
    const others = all.filter(key => key !== node.num).length
    return (
        <div className="diff-bar" data-diff-bar={node.num} onClick={e => e.stopPropagation()}>
            {own ? (
                <span className="diff-what" data-change={own.kind}>
                    {own.kind === 'added' ? `Added${under ? `, with ${under} node${under === 1 ? '' : 's'} under it` : ''}` : `Changed${own.done ? ', and now done' : ''}`}
                </span>
            ) : (
                <span className="diff-what" data-change="under">
                    {others} change{others === 1 ? '' : 's'} under this node
                </span>
            )}
            {kind && (
                <span className="diff-kind" data-kind-change>
                    {kind.from ? KIND_NAME[kind.from] : 'plain'} → {kind.to ? KIND_NAME[kind.to] : 'plain'}
                </span>
            )}
            <span className="diff-buttons">
                {own && (
                    <button type="button" className="diff-btn accept" data-accept title="Accept this change: the node then reads as it is now" onClick={() => onAccept([node.num])}>
                        <Check aria-hidden="true" /> Accept
                    </button>
                )}
                {others > 0 && (
                    <button type="button" className="diff-btn accept" data-accept-all title="Accept every change shown here and under this node" onClick={() => onAccept(all)}>
                        <Check aria-hidden="true" /> {all.length === 1 ? 'Accept' : `Accept all ${all.length}`}
                    </button>
                )}
                {root && (
                    <button type="button" className="diff-btn" data-hide-diff title="Hide the diff: the changes wait behind their diff buttons again" aria-label={`Hide the diff of ${node.num}`} onClick={() => onHide(node.num)}>
                        <X aria-hidden="true" />
                    </button>
                )}
            </span>
        </div>
    )
}

/** How a node is drawn in the diff view: whole and new (the added node itself), or changed. */
const useDiffMark = (node: OutlineNode) => {
    const { pending, reviewing } = useOutlineCtx()
    return reviewing.has(node.num) ? (pending.get(node.num)?.kind === 'added' ? 'added' : 'changed') : undefined
}

/**
 * The kind marks at the right of a row's title: every kind mark a row has is there, and none is at its left, where the
 * diff button stands alone. An
 * action's triangle is the action indicator, which runs nothing: a click opens the node and shows the button in its
 * text that does. A parent's bubbles show the first node under it of their kind, and then what there is to act on: an
 * action's button, or that node's own icon.
 */
export function RowMarks({ node, box }: { node: OutlineNode; box: Box }) {
    const { runs, onReveal, kindColumns, pulse, statuses, isOpen, toggle } = useOutlineCtx()
    const leaf = !node.children.length
    const option = statuses.isOption(node)
    const mark = box.mark
    const action = mark === 'action' || mark === 'failed'
    const ownRole: OwnRole =
        leaf && action
            ? {
                  as: 'point',
                  onPoint: () => {
                      if (!isOpen(node)) toggle(node)
                      pointAtRun(node.num)
                  },
              }
            : { as: 'mark' }
    return (
        <Marks
            box={box}
            ownRole={ownRole}
            ownRunning={mark === 'action' && !!runs[node.num]}
            columns={kindColumns}
            pulse={pulse.get(node.num)}
            below={option}
            picked={option && box.state !== 'open'}
            isRunning={num => !!runs[num]}
            onShow={(num, key) =>
                onReveal(
                    num,
                    el => {
                        if (key === 'action' || key === 'failed') return pointAtRun(num)
                        const own = el.querySelector<HTMLElement>(':scope > .marks [data-own]')
                        if (own) pulseBox(own)
                    },
                    true,
                )
            }
        />
    )
}

/**
 * A node's links, as chips after its title: the nodes it comes from ("from 2.1, 2.4") and those that come from it
 * ("used by 3.2"). Each number is a click to that node.
 */
function LinkChips({ node }: { node: OutlineNode }) {
    const { links, lifecycle, onReveal } = useOutlineCtx()
    const own = links.get(node.num) ?? { from: [], usedBy: [] }
    if (!own.from.length && !own.usedBy.length && !lifecycle.nodes?.[node.num]) return null
    const chip = (what: 'from' | 'used-by', nums: string[]) =>
        nums.length > 0 && (
            <span className="link-chip" data-links={what}>
                {what === 'from' ? 'from' : 'used by'}{' '}
                {nums.map((num, i) => (
                    <span key={num}>
                        {i > 0 && ', '}
                        <button
                            type="button"
                            className="link-num"
                            data-link-to={num}
                            title={`Go to ${num}`}
                            onClick={e => {
                                e.stopPropagation()
                                onReveal(num)
                            }}
                        >
                            {num}
                        </button>
                    </span>
                ))}
            </span>
        )
    return (
        <span className="link-chips">
            {chip('from', own.from)}
            {chip('used-by', own.usedBy)}
            <LifecycleBadges num={node.num} />
        </span>
    )
}

/** A node's envelope, when the agent has messages about it. */
export function Messages({ node }: { node: OutlineNode }) {
    const { messagesFor, seen, onSeen, onReveal } = useOutlineCtx()
    return <NodeMessages num={node.num} messages={messagesFor(node.num)} seen={seen} onSeen={onSeen} onReveal={onReveal} />
}

/**
 * Whether the row calls for the user: its node is in the queue, or it is an option of a question that is, since the
 * options are where that question is answered. Only such a row draws its empty box in full; elsewhere the box is faint.
 */
const useAsked = (node: OutlineNode) => {
    const { queued, statuses } = useOutlineCtx()
    const parent = statuses.parent(node)
    return queued.has(node.num) || (!!parent && statuses.isOption(node) && queued.has(parent.num)) || undefined
}

/**
 * What a node shows: what the viewer read, while its change waits; the diff of it, once the diff is open; and in an
 * added node whose diff is open, the text without the button that runs a task, which is not accepted yet.
 */
const useShown = (node: OutlineNode): NodeContent => {
    const { unread, diffs, addedIn } = useOutlineCtx()
    return diffs.get(node.num) ?? unread.get(node.num) ?? { titleHtml: node.titleHtml, html: addedIn(node.num) ? contentHtml(node) : liveHtml(node) }
}

/** Clicks on controls, and text being selected, do not toggle a row. */
const isRowClick = (e: MouseEvent) => !(e.target as Element).closest('input,button,a,.extras') && !String(getSelection()).trim()

/**
 * The nodes under a node (`under`: its number, or `''` for the topics), with the rows of those taken out since the
 * viewer last looked, each where it stood.
 */
export function withRemoved<T>(rows: T[], removed: RemovedNode[]): (T | RemovedNode)[] {
    const out: (T | RemovedNode)[] = [...rows]
    // A place is one among the nodes that stayed: each removed row put in before it moves the later ones along.
    ;[...removed].sort((a, b) => a.index - b.index).forEach((r, k) => out.splice(Math.min(r.index + k, out.length), 0, r))
    return out
}

// A removed row has no children: a node of the outline has, empty or not (a node's own id is no mark of either).
export const isRemoved = (row: OutlineNode | RemovedNode): row is RemovedNode => !('children' in row)

export function NodeList({ nodes, under }: { nodes: OutlineNode[]; under: string }) {
    const { removedIn } = useOutlineCtx()
    return (
        <div className="nodes">
            {withRemoved(nodes, removedIn(under)).map(n =>
                // A node whose only nodes were taken out is still drawn as a parent: their rows stand under it.
                isRemoved(n) ? (
                    <RemovedRow key={`removed:${n.id}`} node={n} />
                ) : n.tags.includes('topic') ? (
                    <TopicSection key={n.num} node={n} />
                ) : n.stage ? (
                    <StageSection key={n.num} node={n} />
                ) : n.children.length || removedIn(n.num).length ? (
                    <Group key={n.num} node={n} />
                ) : (
                    <Leaf key={n.num} node={n} />
                ),
            )}
        </div>
    )
}

/**
 * A node the agent took out, where it stood: its old number struck through, its title, and the minus that shows it in
 * the diff view, where it is accepted. It is not a node of the outline any more: it is not counted, and the nodes
 * after it carry their new numbers.
 */
export function RemovedRow({ node, topic }: { node: RemovedNode; topic?: boolean }) {
    const { reviewing, onReviewRemoved, onHide, onAccept } = useOutlineCtx()
    const key = `removed:${node.id}`
    const shown = reviewing.has(key)
    return (
        <div className={topic ? 'topic-head removed' : 'row leaf removed'} data-removed={node.id} data-diff={shown ? 'removed' : undefined}>
            <button
                type="button"
                className="env"
                data-change="removed"
                data-open={shown || undefined}
                aria-pressed={shown}
                title={shown ? 'Showing the removal: click to hide it again' : 'Removed since you last looked: click to see it'}
                aria-label={shown ? `Hide the removal of ${node.num}` : `See the removal of ${node.num}`}
                onClick={e => {
                    e.stopPropagation()
                    if (shown) onHide(key)
                    else onReviewRemoved(node)
                }}
            >
                {MINUS_ICON}
            </button>
            {!topic && (
                <span className="num">
                    <s>{node.num}</s>
                </span>
            )}
            <span className="node-title">
                {topic && <s>{node.num}.</s>} <span className="title-html" dangerouslySetInnerHTML={{ __html: node.titleHtml }} />
                {node.count > 0 && <span className="removed-count"> and {node.count} under it</span>}
            </span>
            {shown && (
                <span className="diff-bar removed-bar" data-diff-bar={key}>
                    <span className="diff-what" data-change="removed">
                        Removed
                    </span>
                    <span className="diff-buttons">
                        <button type="button" className="diff-btn accept" data-accept title="Accept this removal: the row goes" onClick={() => onAccept([key])}>
                            <Check aria-hidden="true" /> Accept
                        </button>
                    </span>
                </span>
            )}
        </div>
    )
}

/** The level from which a node's children are indented less on a narrow window: past six levels the outline would run out of room. */
const DEEP = 6

/** A node with children: a header row that sticks while they scroll by, and collapses them. */
function Group({ node }: { node: OutlineNode }) {
    const { statuses, isOpen, toggle, current, onCheck } = useOutlineCtx()
    const open = isOpen(node)
    const box = statuses.box(node)
    const shown = useShown(node)
    const asked = useAsked(node)
    const pickable = usePickable(node)
    const diff = useDiffMark(node)
    const count = node.children.length
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle(node)
        }
    }
    return (
        <div className={cn('group', !open && 'closed')} data-diff={diff} data-deep={node.level >= DEEP || undefined}>
            <div
                className={cn('row parent sticky-head', box.done && 'done', current.has(node.num) && 'current')}
                data-num={node.num}
                data-asked={asked}
                data-sticky
                aria-expanded={open}
                onClick={e => isRowClick(e) && toggle(node)}
            >
                <Diff node={node} />
                <StatusBox box={box} onToggle={() => onCheck(node)} />
                <ChevronDown className="tri size-4" aria-hidden="true" />
                <span className="num">{node.num}</span>
                <Title node={node} titleHtml={shown.titleHtml} />
                <LinkChips node={node} />
                <Messages node={node} />
                <span className="kc" role="button" tabIndex={0} title={`${count} direct child${count === 1 ? '' : 'ren'} — click the row to collapse or expand`} onKeyDown={onKey}>
                    <span>{count}</span>
                </span>
                <RowMarks node={node} box={box} />
                <Asks node={node} />
            </div>
            <div className="kids" hidden={!open}>
                <DiffBar node={node} />
                {pickable && <PickLine node={node} className="group-pick" />}
                <NodeText node={node} className="group-text node-html" html={shown.html} hidden={!shown.html} />
                <NodeList nodes={node.children} under={node.num} />
            </div>
        </div>
    )
}

/** A node without children: a title row with its number and title, and its text below (an option's starts with its pick button), which an approved or done node starts with hidden. */
function Leaf({ node }: { node: OutlineNode }) {
    const { statuses, isOpen, toggle, current, onCheck } = useOutlineCtx()
    const box = statuses.box(node)
    const shown = useShown(node)
    const asked = useAsked(node)
    const open = isOpen(node)
    const pickable = usePickable(node)
    const diff = useDiffMark(node)
    // Only a node with text has something to hide; an option's pick button is in its text.
    const text = !!shown.html || pickable
    return (
        <div
            className={cn('row leaf', text && 'has-text', text && !open && 'closed', box.done && 'done', current.has(node.num) && 'current')}
            data-num={node.num}
            data-asked={asked}
            data-diff={diff}
            aria-expanded={text ? open : undefined}
            onClick={e => text && isRowClick(e) && toggle(node)}
        >
            <Diff node={node} />
            <StatusBox box={box} onToggle={() => onCheck(node)} />
            {text && <ChevronDown className="tri size-4" aria-hidden="true" />}
            <span className="num">{node.num}</span>
            <Title node={node} titleHtml={shown.titleHtml} />
            <LinkChips node={node} />
            <Messages node={node} />
            <RowMarks node={node} box={box} />
            <span className="asks">
                <Ask node={node} />
                <CopyMarkdownButton node={node} />
                <HistoryButton node={node} />
                <RemoveButton node={node} />
            </span>
            <DiffBar node={node} />
            {pickable && <PickLine node={node} hidden={!open} />}
            <NodeText node={node} className="node-html" html={shown.html} hidden={!open} />
        </div>
    )
}

/** A topic: a sticky heading over its text and nodes; an approved one starts collapsed. */
export function Topic({ node }: { node: OutlineNode }) {
    const { statuses, isOpen, toggle, current, onTopicCheck } = useOutlineCtx()
    const open = isOpen(node)
    const box = statuses.topicBox(node)
    const asked = useAsked(node)
    const shown = useShown(node)
    const diff = useDiffMark(node)
    return (
        <section className={cn('topic', !open && 'closed', box.done && 'done')} data-diff={diff}>
            <div
                className={cn('topic-head sticky-head', current.has(node.num) && 'current')}
                data-num={node.num}
                data-asked={asked}
                data-sticky
                aria-expanded={open}
                onClick={e => isRowClick(e) && toggle(node)}
            >
                <Diff node={node} />
                <StatusBox box={box} onToggle={() => onTopicCheck(node)} />
                <ChevronDown className="tri size-4" aria-hidden="true" />
                <span className="node-title">
                    {node.num}. <span className="title-html" dangerouslySetInnerHTML={{ __html: shown.titleHtml }} />
                </span>
                <LinkChips node={node} />
                <Messages node={node} />
                <RowMarks node={node} box={box} />
                <Asks node={node} />
            </div>
            <div className="topic-body" hidden={!open}>
                <DiffBar node={node} />
                <NodeText node={node} className="topic-text node-html" html={shown.html} hidden={!shown.html} />
                <NodeList nodes={node.children} under={node.num} />
            </div>
        </section>
    )
}
