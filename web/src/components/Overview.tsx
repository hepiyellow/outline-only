import { useLayoutEffect, useRef, useState, type TouchEvent } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Trace } from '@/lib/trace'
import type { OutlineNode } from '@/types'

/** A band with more boxes than this shows their count until it is opened. */
const BAND_MAX = 6

/** How far a finger has to swipe right on a narrow window to close the panel, in pixels. */
const SWIPE = 60

interface Line {
    key: string
    d: string
}

/**
 * The overview: a node's trace in a panel at the side of the outline (on a narrow window it covers the outline, and a
 * swipe right or the back arrow closes it). One band per stage from the top down, a box per node naming its topic, the
 * node clicked marked, and a line for each link. A band with many boxes shows their count until opened. A click on a
 * box shows that node in the outline.
 *
 * The window is the outline area, as the node history's: from the top bar to the input box (`bottom`).
 */
export function Overview({ node, trace, bottom, onShow, onClose }: { node: OutlineNode; trace: Trace; bottom: string; onShow: (num: string) => void; onClose: () => void }) {
    const canvas = useRef<HTMLDivElement>(null)
    const [opened, setOpened] = useState<Set<string>>(new Set())
    const [lines, setLines] = useState<Line[]>([])
    const swipe = useRef<number | null>(null)
    const shownIn = (key: string, count: number) => count <= BAND_MAX || opened.has(key)

    // The lines follow the boxes: drawn once they are laid out, and again when the panel changes size.
    useLayoutEffect(() => {
        const el = canvas.current
        if (!el) return
        const draw = () => {
            const base = el.getBoundingClientRect()
            // A box hidden in a band shown as its count is reached at the count.
            const at = (num: string) => el.querySelector<HTMLElement>(`[data-trace-num="${CSS.escape(num)}"]`) ?? el.querySelector<HTMLElement>(`[data-band-of~="${CSS.escape(num)}"]`)
            const out: Line[] = []
            for (const [from, to] of trace.edges) {
                const a = at(from)?.getBoundingClientRect()
                const b = at(to)?.getBoundingClientRect()
                if (!a || !b) continue
                const x1 = a.left + a.width / 2 - base.left
                const x2 = b.left + b.width / 2 - base.left
                // Downstream is in a later band, below; within one band the line goes between the sides of the boxes.
                const same = Math.abs(a.top - b.top) < 4
                const y1 = (same ? a.top + a.height / 2 : a.bottom) - base.top
                const y2 = (same ? b.top + b.height / 2 : b.top) - base.top
                const bend = same ? -24 : (y2 - y1) / 2
                out.push({ key: `${from}>${to}`, d: same ? `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 + bend}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}` })
            }
            setLines(out)
        }
        draw()
        const ro = new ResizeObserver(draw)
        ro.observe(el)
        return () => ro.disconnect()
    }, [trace, opened])

    const onTouchStart = (e: TouchEvent) => (swipe.current = e.touches[0]?.clientX ?? null)
    const onTouchEnd = (e: TouchEvent) => {
        const start = swipe.current
        swipe.current = null
        if (start !== null && (e.changedTouches[0]?.clientX ?? start) - start > SWIPE) onClose()
    }
    const links = trace.edges.length
    return (
        <aside className="overview" data-overview={node.num} style={{ bottom }} aria-label={`Trace of ${node.num}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <header className="overview-head">
                <button type="button" className="overview-back" aria-label="Back to the outline" onClick={onClose}>
                    <ArrowLeft className="size-4" />
                </button>
                <span className="overview-title">
                    Overview of <span className="num">{node.num}</span> <span dangerouslySetInnerHTML={{ __html: node.titleHtml }} />
                </span>
                <button type="button" className="overview-close" aria-label="Close the trace" onClick={onClose}>
                    <X className="size-4" />
                </button>
            </header>
            {!links && <p className="overview-empty">Nothing links to this {node.tags.includes('topic') ? 'topic, and it waits for nothing' : 'node, and it links to nothing'}.</p>}
            <div ref={canvas} className="overview-canvas">
                <svg className="overview-lines" aria-hidden="true">
                    {lines.map(l => (
                        <path key={l.key} d={l.d} data-edge={l.key} />
                    ))}
                </svg>
                {trace.bands.map(band => (
                    <section key={band.key} className="overview-band" data-band={band.key}>
                        <div className="overview-band-label">{band.label}</div>
                        {shownIn(band.key, band.boxes.length) ? (
                            <div className="overview-boxes">
                                {band.boxes.map(box => (
                                    <button
                                        key={box.num}
                                        type="button"
                                        className={cn('overview-box', box.role === 'self' && 'self')}
                                        data-trace-num={box.num}
                                        data-role={box.role}
                                        title={`Show ${box.num} in the outline`}
                                        onClick={() => onShow(box.num)}
                                    >
                                        <span className="num">{box.num}</span> <span className="overview-box-title" dangerouslySetInnerHTML={{ __html: box.titleHtml }} />
                                        {box.topicTitle && <span className="overview-box-topic">{box.topicTitle}</span>}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <button type="button" className="overview-count" data-band-of={band.boxes.map(b => b.num).join(' ')} onClick={() => setOpened(o => new Set(o).add(band.key))}>
                                {band.boxes.length} nodes: show them
                            </button>
                        )}
                    </section>
                ))}
            </div>
        </aside>
    )
}
