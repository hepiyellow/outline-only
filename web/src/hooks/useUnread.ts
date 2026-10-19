import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { contentHtml, isRead, parseVersion, readVersion, wording, type NodeContent } from '@/lib/content'
import { diffHtml } from '@/lib/diff'
import { allNodes, pathNums } from '@/lib/outline'
import type { PendingChange } from '@/lib/pending'
import type { Outline, OutlineNode, RemovedNode, StatePatch, ViewerState } from '@/types'

/**
 * Pending changes: what the agent changed in the outline since the viewer read it waits until they open it, so the
 * outline does not change under them. What they read of each node (its title, text and kind) is kept in the viewer
 * state, topics included.
 *
 * - A node that reads differently from what they read is `changed`: the page keeps showing what they read, with a
 *   diff button.
 * - A node they have not read is `added`: it is there as a bare row, with a plus, and everything under it comes with
 *   it.
 *
 * The diff button opens the diff view of the node and of every change under it (`review`): a changed node shows its
 * title and text as they are now, with the words that went struck through and those that came marked; an added one is
 * there whole; a removed one is a row struck through. Each change waits there until the viewer accepts it, alone or
 * with every other change under the node they opened (`accept`), or hides the diff again (`hide`).
 *
 * What is not a change: every node on a first visit, a node that only changed its number (the agent renumbers the
 * nodes after a removed one), and the user's own approval or pick, which applies at once.
 */
export function useUnread(outline: Outline, viewer: ViewerState, stateLoaded: boolean, patch: (p: StatePatch) => Promise<void>) {
    const nodes = useMemo(() => allNodes(outline.nodes), [outline])
    const byNum = useMemo(() => new Map(nodes.map(n => [n.num, n])), [nodes])
    /**
     * The changes in the diff view, each with where it is: a changed or added node by its number, and a removed node
     * (`removed:<id>`) by the number of the node it stood under. The nodes whose diff button opened them are `roots`.
     */
    const [shownDiffs, setShownDiffs] = useState<Map<string, string>>(new Map())
    const [roots, setRoots] = useState<Set<string>>(new Set())
    const latest = useRef(outline)
    latest.current = outline

    /**
     * The changes that wait, in outline order, and what counts as read without asking (`settle`): a node number with
     * the version to keep for it, or null for a number the outline no longer has.
     */
    const { pending, settle } = useMemo(() => {
        const pending = new Map<string, PendingChange>()
        const settle: Record<string, string | null> = {}
        if (!stateLoaded) return { pending, settle }
        const read = viewer.read
        const first = !Object.keys(read).length
        // A viewer state from before topics were tracked has none of them: they are there, not new.
        const topicsTracked = Object.keys(read).some(num => !num.includes('.'))
        // What the viewer read under a number that no longer reads so: a node that reads like one of these only changed
        // its number, which is not a change to open.
        const movedFrom = new Map<string, string[]>()
        for (const [num, version] of Object.entries(read)) {
            if (byNum.has(num) && isRead(version, byNum.get(num)!)) continue
            movedFrom.set(wording(version), [...(movedFrom.get(wording(version)) ?? []), num])
        }
        // Read under another number: a node whose kind alone changed reads like its own entry, and that is a change.
        const moved = (node: OutlineNode, version: string) => (movedFrom.get(wording(version)) ?? []).some(num => num !== node.num)
        const added: string[] = []
        for (const node of nodes) {
            const version = readVersion(node)
            const was = read[node.num]
            // Inside a node that is new to the viewer: it comes with that node.
            if (added.some(num => node.num.startsWith(`${num}.`))) continue
            if (was !== undefined && isRead(was, node)) {
                if (was !== version) settle[node.num] = version
            } else if (first || moved(node, version) || (was === undefined && node.level === 1 && !topicsTracked)) settle[node.num] = version
            else if (was === undefined) {
                added.push(node.num)
                pending.set(node.num, { kind: 'added' })
            } else pending.set(node.num, { kind: 'changed', was: parseVersion(was), done: node.tags.includes('ran') })
        }
        for (const num of Object.keys(read)) if (!byNum.has(num)) settle[num] = null
        return { pending, settle }
    }, [nodes, byNum, viewer.read, stateLoaded])

    useEffect(() => {
        if (Object.keys(settle).length) patch({ read: settle })
    }, [settle, patch])

    /** The changes in the diff view: of a node, only one that still waits (another window may have accepted it). */
    const reviewing = useMemo(() => new Map([...shownDiffs].filter(([key]) => key.startsWith('removed:') || pending.has(key))), [shownDiffs, pending])

    /** Changed nodes as the viewer read them, shown until they open the diff. */
    const unread = useMemo(() => {
        const map = new Map<string, NodeContent>()
        for (const [num, change] of pending) if (change.kind === 'changed' && change.was && !reviewing.has(num)) map.set(num, change.was)
        return map
    }, [pending, reviewing])

    /** Changed nodes in the diff view: their title and text as they are now, with what changed marked. */
    const diffs = useMemo(() => {
        const map = new Map<string, NodeContent>()
        for (const [num, change] of pending) {
            const node = byNum.get(num)
            if (change.kind !== 'changed' || !change.was || !node || !reviewing.has(num)) continue
            map.set(num, { titleHtml: diffHtml(change.was.titleHtml, node.titleHtml), html: diffHtml(change.was.html, contentHtml(node)) })
        }
        return map
    }, [pending, reviewing, byNum])

    const unreadNums = useMemo(() => [...pending.keys()], [pending])

    const now = (num: string) => allNodes(latest.current.nodes).find(n => n.num === num)

    /** The nodes under `num` (not `num` itself) with a change whose diff is not open yet, in outline order. */
    const unreadUnder = useCallback((num: string) => unreadNums.filter(n => n.startsWith(`${num}.`) && !reviewing.has(n)), [unreadNums, reviewing])

    /** What a node and everything under it reads as now: what accepting an added node records. */
    const versionsUnder = (num: string) => Object.fromEntries(allNodes(now(num) ? [now(num)!] : []).map(n => [n.num, readVersion(n)]))

    /** The changes in the diff view at a node or anywhere under it, its own first. */
    const diffsAt = useCallback((num: string) => [...reviewing].filter(([, at]) => at === num || at.startsWith(`${num}.`)).map(([key]) => key), [reviewing])

    /**
     * A click on a node's diff button: opens the diff view of the node's own change and of every change under it,
     * the nodes taken out there (`removed`) included, and opens the way to each so that it shows.
     */
    const review = useCallback(
        (node: OutlineNode, removed: RemovedNode[] = []) => {
            const changes: [string, string][] = [
                ...unreadNums.filter(n => n === node.num || n.startsWith(`${node.num}.`)).map((n): [string, string] => [n, n]),
                ...removed.map((t): [string, string] => [`removed:${t.id}`, t.parent]),
            ]
            if (!changes.length) return
            setShownDiffs(d => new Map([...d, ...changes]))
            setRoots(r => new Set(r).add(node.num))
            const open: Record<string, boolean> = { [node.num]: true }
            for (const [, at] of changes) if (at) for (const n of pathNums(at)) open[n] = true
            patch({ open })
        },
        [unreadNums, patch],
    )

    /** Accepts changes in the diff view: each node then reads as it is now, and a removed one is gone. */
    const accept = useCallback(
        (keys: string[]) => {
            const read: Record<string, string> = {}
            const seen: Record<string, number> = {}
            for (const key of keys) {
                if (key.startsWith('removed:')) seen[key] = 1
                else if (pending.get(key)?.kind === 'added') Object.assign(read, versionsUnder(key))
                else if (now(key)) read[key] = readVersion(now(key)!)
            }
            setShownDiffs(d => new Map([...d].filter(([key]) => !keys.includes(key))))
            patch({ ...(Object.keys(read).length ? { read } : {}), ...(Object.keys(seen).length ? { seen } : {}) })
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [pending, patch],
    )

    /** A click on a removed row's minus: the row shows as a change in the diff view, to be accepted. */
    const reviewRemoved = useCallback((t: RemovedNode) => setShownDiffs(d => new Map(d).set(`removed:${t.id}`, t.parent)), [])

    /**
     * Closes the diff view at a node and under it, or of one removed node (`removed:<id>`): the changes wait behind
     * their diff buttons again.
     */
    const hide = useCallback(
        (num: string) => {
            const keys = num.startsWith('removed:') ? [num] : diffsAt(num)
            setShownDiffs(d => new Map([...d].filter(([key]) => !keys.includes(key))))
            setRoots(r => new Set([...r].filter(n => n !== num && !n.startsWith(`${num}.`))))
        },
        [diffsAt],
    )

    return { pending, unread, diffs, reviewing, roots, unreadNums, unreadUnder, diffsAt, review, reviewRemoved, accept, hide }
}
