import { allNodes, type NodeLinks } from '@/lib/outline'
import type { Lifecycle, OutlineNode, StageName } from '@/types'

/** The stages of the lifecycle, in its order: the overview's bands, from the top down. */
const STAGES: StageName[] = ['discussion', 'plan', 'implementation', 'verification', 'preservation']

/** A box of the overview: a node of the trace (or a topic), where it sits, and how it stands to the one clicked. */
export interface TraceBox {
    num: string
    title: string
    titleHtml: string
    /** The topic it sits in, by number and title; empty in an outline without topics. */
    topic: string
    topicTitle: string
    /** `self` for the node the overview is of; `from` for what it comes from; `to` for what comes from it. */
    role: 'from' | 'self' | 'to'
}

/** A band of the overview: one stage (or, for a topic, those it waits for, itself, and those that wait for it). */
export interface TraceBand {
    key: string
    label: string
    boxes: TraceBox[]
}

/** A node's trace, laid out: its bands from the top down, and the links between the boxes, upstream first (`[from, to]`). */
export interface Trace {
    bands: TraceBand[]
    edges: [string, string][]
}

/** Where a node sits: the nearest stage and topic above it (a topic's heading sits in its own). */
function placeOf(num: string, byNum: Map<string, OutlineNode>) {
    const parts = num.split('.')
    let topic: OutlineNode | undefined
    let stage: StageName | undefined
    for (let i = 1; i <= parts.length; i++) {
        const n = byNum.get(parts.slice(0, i).join('.'))
        if (n?.tags.includes('topic')) {
            topic = n
            stage = undefined
        } else if (n?.stage) stage = n.stage
    }
    return { topic, stage: stage ?? 'discussion' }
}

/**
 * A node's trace: every node it comes from, through link after link, and every node that comes from it, never their
 * other branches. Each is a box in the band of its stage. In an outline without topics, every node is in Discussion.
 */
export function traceOf(node: OutlineNode, nodes: OutlineNode[], links: Map<string, NodeLinks>): Trace {
    const byNum = new Map(allNodes(nodes).map(n => [n.num, n]))
    const order = new Map(allNodes(nodes).map((n, i) => [n.num, i]))
    const role = new Map<string, TraceBox['role']>([[node.num, 'self']])
    const edges: [string, string][] = []
    const walk = (dir: 'from' | 'usedBy') => {
        for (let front = [node.num]; front.length; ) {
            const next: string[] = []
            for (const num of front)
                for (const other of links.get(num)?.[dir] ?? []) {
                    edges.push(dir === 'from' ? [other, num] : [num, other])
                    if (role.has(other)) continue
                    role.set(other, dir === 'from' ? 'from' : 'to')
                    next.push(other)
                }
            front = next
        }
    }
    walk('from')
    walk('usedBy')
    const bands = STAGES.map(stage => ({ key: stage, label: stage[0].toUpperCase() + stage.slice(1), boxes: [] as TraceBox[] }))
    for (const num of [...role.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
        const n = byNum.get(num)
        if (!n) continue
        const { topic, stage } = placeOf(num, byNum)
        bands[STAGES.indexOf(stage)].boxes.push({ num, title: n.title, titleHtml: n.titleHtml, topic: topic?.num ?? '', topicTitle: topic?.title ?? '', role: role.get(num)! })
    }
    return { bands: bands.filter(b => b.boxes.length), edges: [...new Map(edges.map(e => [e.join('>'), e])).values()] }
}

/** A topic's overview: the topics it waits for above it, and those that wait for it below. */
export function topicTraceOf(topic: OutlineNode, nodes: OutlineNode[], lifecycle: Lifecycle): Trace {
    const byNum = new Map(allNodes(nodes).map(n => [n.num, n]))
    const box = (num: string, role: TraceBox['role']): TraceBox => {
        const n = byNum.get(num)
        return { num, title: n?.title ?? lifecycle.topics[num]?.title ?? num, titleHtml: n?.titleHtml ?? lifecycle.topics[num]?.title ?? num, topic: num, topicTitle: '', role }
    }
    const waitsFor = lifecycle.topics[topic.num]?.waitsFor ?? []
    const waitedBy = Object.entries(lifecycle.topics)
        .filter(([, t]) => t.waitsFor.includes(topic.num))
        .map(([num]) => num)
    const bands: TraceBand[] = [
        { key: 'waits-for', label: 'It waits for', boxes: waitsFor.map(num => box(num, 'from')) },
        { key: 'self', label: 'Topic', boxes: [box(topic.num, 'self')] },
        { key: 'waited-by', label: 'Waiting for it', boxes: waitedBy.map(num => box(num, 'to')) },
    ]
    return { bands: bands.filter(b => b.boxes.length), edges: [...waitsFor.map((num): [string, string] => [num, topic.num]), ...waitedBy.map((num): [string, string] => [topic.num, num])] }
}
