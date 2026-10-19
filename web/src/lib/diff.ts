// The diff view of a pending change: a node's title or text as it is now, with what the change took out and what it
// brought in marked in place, as a code diff does. Blocks (paragraphs, list items, closing lines) are compared first:
// one that went is shown struck through in red, one that came in green. A block the change rewrote is compared word
// by word: the words that went are put back where they stood, struck through, before the words that took their place.

/** The elements whose children are compared as blocks, one by one, rather than as running text. */
const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'HR', 'DL', 'DT', 'DD'])

/** The largest comparison made in full: past it, the old side is shown as gone and the new one as come. */
const MAX_CELLS = 250000

type Op = '=' | '-' | '+'

/** The longest common subsequence of `a` and `b`, as the steps from one to the other; null when they are too long to compare. */
function steps<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): Op[] | null {
    const n = a.length
    const m = b.length
    if (n * m > MAX_CELLS) return null
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = same(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    const ops: Op[] = []
    for (let i = 0, j = 0; i < n || j < m; ) {
        if (i < n && j < m && same(a[i], b[j])) {
            ops.push('=')
            i++
            j++
        } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
            ops.push('+')
            j++
        } else {
            ops.push('-')
            i++
        }
    }
    return ops
}

/** Every step from `a` to `b` when they cannot be compared: all of `a` goes, all of `b` comes. */
const replaced = (n: number, m: number): Op[] => [...Array<Op>(n).fill('-'), ...Array<Op>(m).fill('+')]

const isBlock = (node: Node) => node.nodeType === Node.ELEMENT_NODE && BLOCK.has(node.nodeName)
const hasBlocks = (el: Element) => [...el.childNodes].some(isBlock)
/** The children compared as blocks: elements, and text that is not only the space between them. */
const units = (el: Element) => [...el.childNodes].filter(n => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()))
const html = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element).outerHTML : (n.textContent ?? ''))

/** A block or a run of text the change brought in (`ins`) or took out (`del`), marked as such. */
function marked(node: Node, how: 'ins' | 'del'): Node {
    const doc = node.ownerDocument!
    if (node.nodeType === Node.ELEMENT_NODE && isBlock(node)) {
        const el = node.cloneNode(true) as Element
        el.classList.add(how === 'ins' ? 'dx-add-block' : 'dx-del-block')
        return el
    }
    const wrap = doc.createElement(how)
    wrap.className = how === 'ins' ? 'dx-add' : 'dx-del'
    wrap.appendChild(node.cloneNode(true))
    return wrap
}

/** Appends to `out` the children of `now`, compared one by one with those of `was`. */
function diffChildren(was: Element, now: Element, out: Element) {
    const a = units(was)
    const b = units(now)
    const ops = steps(a, b, (x, y) => html(x) === html(y)) ?? replaced(a.length, b.length)
    let i = 0
    let j = 0
    for (let k = 0; k < ops.length; ) {
        if (ops[k] === '=') {
            out.appendChild(b[j++].cloneNode(true))
            i++
            k++
            continue
        }
        // A run of changes: what went and what came, paired in order where they are blocks of one kind.
        const gone: Node[] = []
        const come: Node[] = []
        for (; k < ops.length && ops[k] !== '='; k++) (ops[k] === '-' ? gone : come).push(ops[k] === '-' ? a[i++] : b[j++])
        const pairs = Math.min(gone.length, come.length)
        for (let p = 0; p < pairs; p++) {
            if (gone[p].nodeName === come[p].nodeName) out.append(...diffPair(gone[p], come[p]))
            else out.append(marked(gone[p], 'del'), marked(come[p], 'ins'))
        }
        gone.slice(pairs).forEach(n => out.appendChild(marked(n, 'del')))
        come.slice(pairs).forEach(n => out.appendChild(marked(n, 'ins')))
    }
}

/** A block the change rewrote: compared block by block when it holds blocks (a list), else word by word. */
function diffPair(was: Node, now: Node): Node[] {
    if (now.nodeType !== Node.ELEMENT_NODE) {
        const span = now.ownerDocument!.createElement('span')
        span.textContent = now.textContent
        diffWords(span, was.textContent ?? '')
        return [...span.childNodes]
    }
    const [a, b] = [was as Element, now as Element]
    if (hasBlocks(a) || hasBlocks(b)) {
        const out = b.cloneNode(false) as Element
        diffChildren(a, b, out)
        return [out]
    }
    // The same words in other markup (a word made bold, a link): the block is shown as it was and as it is.
    if (a.textContent === b.textContent) return [marked(a, 'del'), marked(b, 'ins')]
    const out = b.cloneNode(true) as Element
    diffWords(out, a.textContent ?? '')
    return [out]
}

/** Words, each with the spacing after it (and the spacing a text starts with, on its own). */
const tokens = (text: string) => text.match(/^\s+|\S+\s*/g) ?? []

/** The text node and the offset in it where the character at `offset` of `root`'s text is; at the end of a node rather than the start of the next. */
function pointAt(root: Element, offset: number): [Text, number] | null {
    const walk = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let first: Text | null = null
    for (let at = 0, n: Node | null; (n = walk.nextNode()); ) {
        const t = n as Text
        first ??= t
        if (offset > at && offset <= at + t.data.length) return [t, offset - at]
        at += t.data.length
    }
    return first ? [first, 0] : null
}

/** Wraps characters `from` to `to` of `root`'s text in `ins` marks, one for each text node they touch. */
function wrapAdded(root: Element, from: number, to: number) {
    const walk = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const pieces: [Text, number, number][] = []
    for (let at = 0, n: Node | null; (n = walk.nextNode()); ) {
        const t = n as Text
        const s = Math.max(from, at)
        const e = Math.min(to, at + t.data.length)
        if (e > s) pieces.push([t, s - at, e - at])
        at += t.data.length
    }
    for (const [t, s, e] of pieces) {
        const range = root.ownerDocument!.createRange()
        range.setStart(t, s)
        range.setEnd(t, e)
        const ins = root.ownerDocument!.createElement('ins')
        ins.className = 'dx-add'
        range.surroundContents(ins)
    }
}

/**
 * Marks in `el`, which holds the new text, the words that came since `was`, and puts back those that went, struck
 * through, before the words that took their place. Words are compared without the spacing after them, outside a `pre`.
 */
function diffWords(el: Element, was: string) {
    const pre = !!el.closest('pre') || el.nodeName === 'PRE'
    const text = el.textContent ?? ''
    const a = tokens(was)
    const b = tokens(text)
    const key = (t: string) => (pre ? t : t.trim())
    const ops = steps(a.map(key), b.map(key), (x, y) => x === y) ?? replaced(a.length, b.length)
    // The runs of changes, each with what went (words of the old text) and what came (characters of the new text).
    const runs: { gone: string; from: number; to: number }[] = []
    let ai = 0
    let bi = 0
    let at = 0
    for (let k = 0; k < ops.length; ) {
        if (ops[k] === '=') {
            ai++
            at += b[bi++].length
            k++
            continue
        }
        let gone = ''
        let came = ''
        for (; k < ops.length && ops[k] !== '='; k++) {
            if (ops[k] === '-') gone += a[ai++]
            else came += b[bi++]
        }
        // The mark of what came leaves out the spacing around it.
        const lead = came.length - came.trimStart().length
        runs.push({ gone: pre ? gone : gone.trim().replace(/\s+/g, ' '), from: at + lead, to: at + came.trimEnd().length })
        at += came.length
    }
    const doc = el.ownerDocument!
    // From the last run back, so that what is put in leaves the offsets of the earlier runs as they were.
    for (const run of runs.reverse()) {
        if (run.to > run.from) wrapAdded(el, run.from, run.to)
        if (!run.gone.trim()) continue
        const del = doc.createElement('del')
        del.className = 'dx-del'
        del.textContent = run.gone
        // A space keeps what went apart from the words beside it.
        const before = run.from > 0 && !/\s/.test(text[run.from - 1]) ? ' ' : ''
        const after = run.from < text.length && !/\s/.test(text[run.from]) && !/\s$/.test(run.gone) ? ' ' : ''
        const put = (...nodes: (Node | string)[]) => {
            const point = pointAt(el, run.from)
            if (!point) return el.append(...nodes)
            if (point[1] > 0) return point[0].splitText(point[1]).before(...nodes)
            // Before the words that took their place, not inside their mark.
            const ins = point[0].parentElement
            ;(ins?.matches('ins.dx-add') && ins.firstChild === point[0] ? ins : point[0]).before(...nodes)
        }
        put(...[before, del, after].filter(n => n !== ''))
    }
}

/** An inert document to take HTML apart in: nothing in it loads or runs. */
let scratch: Document | null = null
const parse = (text: string) => {
    scratch ??= document.implementation.createHTMLDocument('')
    const el = scratch.createElement('div')
    el.innerHTML = text
    return el
}

/**
 * `now`, with what changed since `was` marked in place: `ins.dx-add` and `del.dx-del` for words, the classes
 * `dx-add-block` and `dx-del-block` for whole blocks. Works for a title (running text) and for a node's text (blocks).
 */
export function diffHtml(was: string, now: string): string {
    if (was === now) return now
    const a = parse(was)
    const b = parse(now)
    const out = parse('')
    if (hasBlocks(a) || hasBlocks(b)) diffChildren(a, b, out)
    else {
        out.innerHTML = now
        diffWords(out, a.textContent ?? '')
    }
    return out.innerHTML
}
