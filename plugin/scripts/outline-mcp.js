#!/usr/bin/env node
// The plugin's MCP server: three tools, `start`, `read` and `change`, passed on to the outline server, which owns the
// outline and writes its file. This process keeps nothing but which outline its session has. It speaks MCP over stdio
// (one JSON-RPC message per line) with Node's own modules only; stdout belongs to MCP, so it logs to stderr.
import path from 'node:path'
import readline from 'node:readline'
import { call, findServer, tmuxSession } from './lib.js'

const VERSION = '0.3.0'

/** What the agent's tool gives its MCP servers: the session id (Claude Code; Codex's name is unverified) and the working folder. */
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || ''
const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd()
/** Set when the page started this session from a workspace: the outline files under the workspace's name. */
const PROJECT = process.env.OUTLINE_PROJECT || path.basename(CWD)

/** The outline this session has, as `project/file`, once a call has found it. */
let outline = ''

const text = { type: 'string' }
const STAGE = { enum: ['discussion', 'plan', 'implementation', 'verification', 'preservation'] }
const NODE = {
    title: { ...text, description: 'Short title, 2 to 8 words, no tags or numbers.' },
    text: { ...text, description: "The node's text as markdown (paragraphs, bullets, code, tables; no headings)." },
    summary: { ...text, description: "One sentence summing up a long node's own text. Never an answer." },
    recommendation: { ...text, description: 'What you recommend and why, on a node that is not a choice between options.' },
    task: {
        ...text,
        description:
            'Makes the node a task of the outline: something for you to do in this session, which the user runs from the page (not a subagent, and not an item of a to-do list of your own). One short sentence on what you will do when the user runs it, with no file names and nothing the text already says.',
    },
    status: { enum: ['open', 'claim'], description: 'claim: settled in the conversation, or something you are certain of. Never set for what still needs the user.' },
    ask: { type: 'boolean', description: 'true asks the user to approve this node: while it is a claim they have not approved, it is a pending action in the queue. Not for a task or an option.' },
    links: {
        type: 'array',
        items: text,
        description:
            'The nodes this one comes from, by number (2.1): the decisions a plan item carries out, the plan item a task carries out, the task a check checks. A link points upstream and never closes a loop; the server keeps it through every renumbering. update: the whole list ([] clears it).',
    },
}
const OPTION = { type: 'object', properties: { title: NODE.title, text: NODE.text, recommended: { type: 'boolean' }, task: NODE.task, links: NODE.links }, required: ['title'] }

const TOOLS = [
    {
        name: 'start',
        description:
            'Open the outline of this conversation, or reattach to the one it already has. Returns the link of its page and its map. Call it once when the outline skill is invoked, and again whenever a tool says the session has no outline.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { ...text, description: "The conversation's subject, as the outline's name. Leave it out when nothing has been discussed yet, and call start again with it once there is a subject. Ignored once the outline has a name: the user renames it on the page." },
                model: { ...text, description: 'Your model name and reasoning effort as you know them, e.g. "Claude Opus 5.5, high". Leave out what you do not know; never guess.' },
                outline: { ...text, description: 'Only to attach this session to an existing outline: its "project/file".' },
                workflow: { ...text, description: 'Only when the user named a workflow skill for this outline: its name as you load it, e.g. "my-plugin:my-workflow". Leave it out otherwise: the answer says which workflow skill the outline has.' },
            },
        },
    },
    {
        name: 'read',
        description:
            'Read the outline as it is now: every node, or with num one node and its descendants. Read a node before you update it whenever you no longer have its text in front of you.',
        inputSchema: { type: 'object', properties: { num: { ...text, description: 'A node number such as 2.1. Leave out for the whole outline.' } } },
    },
    {
        name: 'change',
        description: [
            'Change the outline: a list of operations applied together, all or none. Make one call per turn, after your answer is decided. The result carries what the user did on the page since you were last told, and a map of the outline.',
            'Operations (op):',
            'Topics and stages: an outline is made of topics, each going through the stages Discussion, Plan, Implementation, Verification, Preservation, with each stage on or off. An outline nobody chose stages for is one topic with Discussion alone, not written: its nodes are the top level. Once it has a second topic or a second stage, its nodes move under 1.1 (the Discussion of topic 1) and are renumbered once; from then on a topic\'s children are its stages, numbered by their place in that order (Discussion .1, Plan .2, Implementation .3, Verification .4, Preservation .5), and nodes go under a stage. Tasks sit only in Implementation, Verification (a check is a task there) and Preservation; plan items only in Plan; questions and claims anywhere.',
            '- add { num, title, text?, summary?, recommendation?, status?, ask?, task?, outcome?, failed?, plan?, links?, options?, children? }: a new node. num is its full path (2.4), the next free number under its parent, at most ten levels deep. options makes it a question the user answers by picking one; children are nodes under it, numbered in order. outcome adds it as a task you already carried out, because the user asked for it in chat. links names the nodes it comes from. plan makes it a plan item. With stages { num, title, text?, stages } instead, it is a new topic, at the top level or inside a stage, with the stages listed on, in order; a topic inside a stage starts at that stage or a later one.',
            '- update { num, title?, text?, summary?, recommendation?, task?, status?, ask?, recommended?, plan?, links? }: each field given replaces that whole field ("" clears it), so write the full new text.',
            '- move { num, under }: puts a node under another parent ("" for the top level), where it takes the next number.',
            '- remove { num }: takes a node out with everything under it; the siblings after it are renumbered, and a link to a node taken out is dropped.',
            '- record { num, decision, stage? }: what the user decided in chat. approve, reopen, or pick (num is the option); stage-off with stage when the user said to turn a stage of topic num off (it keeps its nodes, folded away; adapt the topic to it). Only what the user said, never your own judgment.',
            '- stages { num?, on }: turns stages of topic num on (num left out: the outline\'s one topic). You never turn one off: only the user does.',
            '- done { num }: closes the Discussion or Plan stage num: its deciding or planning is done. Refused while a Discussion holds an unresolved question. Implementation, Verification and Preservation are done once their tasks are.',
            '- finish { num, outcome, failed? }: you carried out what the node describes, so it shows as a task done; outcome says what happened. The node is a task the user ran, or any node about something the user asked you in chat to do.',
            '- acknowledge {}: you took in the ticks the user made on the page and nothing in the outline follows from them. Any change made after you were told of a tick acknowledges it, so send this only in a change that holds nothing else.',
            '- message { text, num? }: a note for the inbox about something the outline does not hold.',
            '- queue { items: [{ num }] }: the order of the queue, most important first. The queue is the pending actions (an open question, a task to run, a claim that asks for approval): the server lists them from the nodes, and you only order them. A node with no pending action is left out; one you do not list keeps the place it had.',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                ops: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            op: { enum: ['add', 'update', 'move', 'remove', 'record', 'finish', 'stages', 'done', 'acknowledge', 'message', 'queue'] },
                            num: { ...text, description: 'Full-path node number, e.g. 2.1.3.' },
                            ...NODE,
                            options: { type: 'array', items: OPTION, description: 'add: the options of a question, at least two; at most one recommended.' },
                            children: { type: 'array', items: { type: 'object' }, description: 'add: nodes under the new node, each shaped like an add without num.' },
                            recommended: { type: 'boolean', description: 'update: marks an option as the one you recommend.' },
                            under: { ...text, description: 'move: the number of the new parent, or "" for the top level.' },
                            decision: { enum: ['approve', 'reopen', 'pick', 'stage-off'], description: 'record.' },
                            stages: { type: 'array', items: STAGE, description: 'add: makes the node a topic, with these stages on, in the lifecycle\'s order.' },
                            on: { type: 'array', items: STAGE, description: 'stages: the stages to turn on.' },
                            stage: { ...STAGE, description: 'record with stage-off: the stage the user turned off.' },
                            plan: { type: 'boolean', description: 'add, update: the node is a plan item: it says what will be done, sits in a Plan stage, and has no Run button. Its tasks in Implementation link to it.' },
                            outcome: { ...text, description: 'finish, or an add of something you already did: what happened, in one or two sentences.' },
                            failed: { type: 'boolean', description: 'finish, or an add with outcome: you tried and it did not work.' },
                            items: {
                                type: 'array',
                                description: 'queue: the pending actions, most important first.',
                                items: { type: 'object', properties: { num: text }, required: ['num'] },
                            },
                        },
                        required: ['op'],
                    },
                },
            },
            required: ['ops'],
        },
    },
]

const NO_SERVER =
    'The outline server is not running and could not be started. Ask the user to open the Outline Only app, or to run `npm start` in the outline-only checkout, then try again.'

async function callTool(name, args) {
    if (!TOOLS.some(t => t.name === name)) throw new Error(`unknown tool: ${name}`)
    const port = await findServer({ start: true })
    if (!port) return { content: [{ type: 'text', text: NO_SERVER }], isError: true }
    const who = { session: SESSION, cwd: CWD, outline: (name === 'start' && args.outline) || outline }
    const body = name === 'start' ? { ...who, project: PROJECT, terminal: tmuxSession(), title: args.title, model: args.model, workflow: args.workflow } : name === 'read' ? { ...who, num: args.num } : { ...who, ops: args.ops }
    const result = await call(port, name, body)
    if (result.outline) outline = result.outline
    return { content: [{ type: 'text', text: result.text || '' }], isError: !result.ok }
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

async function handle({ id, method, params }) {
    // A message without an id is a notification: nothing answers it.
    if (id === undefined || id === null) return
    try {
        if (method === 'initialize')
            return send({
                id,
                result: {
                    protocolVersion: params?.protocolVersion || '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'outline', version: VERSION },
                    instructions: 'The outline tools belong to the outline skill: use them only once the user has invoked it in this conversation, and from then on after each answer that adds or changes something.',
                },
            })
        if (method === 'ping') return send({ id, result: {} })
        if (method === 'tools/list') return send({ id, result: { tools: TOOLS } })
        if (method === 'tools/call') return send({ id, result: await callTool(params?.name, params?.arguments || {}) })
        send({ id, error: { code: -32601, message: `method not found: ${method}` } })
    } catch (e) {
        console.error(e.stack || e.message)
        if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: `The outline tool failed: ${e.message}` }], isError: true } })
        else send({ id, error: { code: -32603, message: e.message } })
    }
}

// Calls are answered in the order they arrive, so two changes never race each other.
let last = Promise.resolve()
readline.createInterface({ input: process.stdin }).on('line', line => {
    if (!line.trim()) return
    let message
    try {
        message = JSON.parse(line)
    } catch {
        return send({ id: null, error: { code: -32700, message: 'parse error' } })
    }
    last = last.then(() => handle(message))
})
// When the agent's session ends, stdin closes: end too.
process.stdin.on('end', () => last.finally(() => process.exit(0)))
