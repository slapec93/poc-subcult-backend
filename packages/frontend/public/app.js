import { generatePrivateKey, privateKeyToAccount } from 'https://esm.sh/viem@2/accounts'

const $ = id => document.getElementById(id)
const KEY_STORAGE = 'subcult-signing-key'

let account = null

function loadAccount(fresh = false) {
    let key = null
    try {
        key = fresh ? null : localStorage.getItem(KEY_STORAGE)
    } catch {}
    if (!key) {
        key = generatePrivateKey()
        try {
            localStorage.setItem(KEY_STORAGE, key)
        } catch {}
    }
    account = privateKeyToAccount(key)
    $('address').textContent = account.address
}

const owner = () => account.address.toLowerCase()
const short = address => `${address.slice(0, 6)}…${address.slice(-4)}`

async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, options)
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    return body
}

const postJson = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// prepare → sign → submit: the server never signs on the user's behalf.
async function submit(type, payload) {
    const { record, message } = await postJson('/records/prepare', { type, owner: owner(), payload })
    const signature = await account.signMessage({ message })
    return postJson('/records', { ...record, signature })
}

async function uploadMedia(file) {
    if (!file || file.size === 0) return undefined
    const form = new FormData()
    form.set('file', file)
    return (await api('/media', { method: 'POST', body: form })).ref
}

const present = children => children.filter(c => c !== null && c !== undefined && c !== false)

function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props)
    node.append(...present(children))
    return node
}

const fill = (id, ...children) => $(id).replaceChildren(...present(children))
const confirmation = item => (item.confirmed ? 'on-chain' : 'not yet on-chain')
const tagChip = tag => el('span', { className: 'chip', onclick: () => filterByTag(tag) }, `#${tag}`)

let connectionTypes = []
let currentNode = null
let chosenTarget = null

function renderCards(nodes) {
    if (nodes.length === 0) return fill('nodes', el('p', { className: 'muted' }, 'Nothing found.'))
    fill(
        'nodes',
        ...nodes.map(n =>
            el(
                'div',
                { className: 'card', onclick: () => showNode(n.id) },
                el('div', { className: 'kind' }, [n.kind, n.role, n.format, n.years].filter(Boolean).join(' · ')),
                el('strong', {}, n.title),
                n.where ? el('span', { className: 'muted' }, ` — ${n.where}`) : null,
                n.firstNote ? el('div', {}, n.firstNote) : null,
                el('div', {}, ...n.tags.map(tagChip)),
                el('div', { className: 'muted' }, `${n.noteCount} notes · ${n.connectionCount} connections · added by ${short(n.owner)}`),
            ),
        ),
    )
}

async function loadNodes() {
    const query = new URLSearchParams()
    if ($('filter-kind').value) query.set('kind', $('filter-kind').value)
    if ($('filter-q').value.trim()) query.set('q', $('filter-q').value.trim())
    for (const tag of $('filter-tags').value.split(',').map(t => t.trim()).filter(Boolean)) query.append('tag', tag)
    renderCards(await api(`/nodes?${query}`))
}

function filterByTag(tag) {
    $('filter-tags').value = tag
    loadNodes()
}

async function showNode(id) {
    const node = await api(`/nodes/${id}`)
    currentNode = node
    $('detail').hidden = false
    $('detail-error').textContent = ''
    $('detail-kind').textContent = [node.kind, node.role, node.format, node.years].filter(Boolean).join(' · ')
    $('detail-title').textContent = node.title
    fill(
        'detail-meta',
        [node.where, `added by ${short(node.owner)}`, confirmation(node)].filter(Boolean).join(' · '),
        node.externalUrl ? el('div', {}, el('a', { href: node.externalUrl, target: '_blank', rel: 'noopener' }, node.externalUrl)) : null,
    )
    fill(
        'detail-media',
        node.artworkRef ? el('img', { src: `/api/media/${node.artworkRef}`, height: 120 }) : null,
        node.audioRef ? el('audio', { src: `/api/media/${node.audioRef}`, controls: true, preload: 'none' }) : null,
    )
    fill('detail-tags', ...node.tags.map(tagChip))
    fill(
        'detail-notes',
        ...node.notes.map(n =>
            el('div', { className: 'note' }, n.text, el('div', { className: 'muted' }, `${short(n.owner)} · ${new Date(n.createdAt).toLocaleString()} · ${confirmation(n)}`)),
        ),
    )
    fill(
        'detail-connections',
        ...node.connections.map(c =>
            el(
                'div',
                { className: 'note' },
                el('span', { className: 'kind' }, `${c.label} `),
                el('a', { href: '#', onclick: e => (e.preventDefault(), showNode(c.nodeId)) }, c.nodeTitle),
                el('span', { className: 'muted' }, ` (${c.nodeKind})`),
                el('div', {}, `“${c.note}” — ${short(c.owner)}`),
                c.source ? el('a', { href: c.source, target: '_blank', rel: 'noopener', className: 'muted' }, c.source) : null,
            ),
        ),
    )
    const types = connectionTypes.filter(t => t.from.includes(node.kind))
    $('add-connection').hidden = types.length === 0
    $('add-connection').type.replaceChildren(...types.map(t => el('option', { value: t.id }, `${t.label} (${t.to.join('/')})`)))
    resetTarget()
}

const selectedType = () => connectionTypes.find(t => t.id === $('add-connection').type.value)

function resetTarget() {
    chosenTarget = null
    $('add-connection').target.value = ''
    fill('target-suggestions')
    $('target-choice').textContent = ''
    updateNewPlaceField()
}

function updateNewPlaceField() {
    const type = selectedType()
    document.querySelector('.new-place').hidden = !(type?.to.includes('place') && !chosenTarget)
}

let targetTimer
$('add-connection').target.addEventListener('input', event => {
    chosenTarget = null
    $('target-choice').textContent = ''
    updateNewPlaceField()
    clearTimeout(targetTimer)
    targetTimer = setTimeout(async () => {
        const q = event.target.value.trim()
        const type = selectedType()
        if (!q || !type) return fill('target-suggestions')
        const results = (await Promise.all(type.to.map(kind => api(`/nodes?kind=${kind}&q=${encodeURIComponent(q)}&limit=5`)))).flat()
        fill(
            'target-suggestions',
            ...results.map(n =>
                el(
                    'span',
                    {
                        className: 'chip',
                        onclick: () => {
                            chosenTarget = n
                            $('add-connection').target.value = n.title
                            $('target-choice').textContent = `connecting to existing ${n.kind}`
                            fill('target-suggestions')
                            updateNewPlaceField()
                        },
                    },
                    `${n.title} (${n.kind}${n.where ? `, ${n.where}` : ''})`,
                ),
            ),
        )
    }, 250)
})
$('add-connection').type.addEventListener('change', resetTarget)

async function run(action) {
    $('detail-error').textContent = ''
    try {
        await action()
        await showNode(currentNode.id)
        loadNodes()
        refreshStatus()
    } catch (err) {
        $('detail-error').textContent = err.message
    }
}

$('add-connection').addEventListener('submit', event => {
    event.preventDefault()
    const form = event.target
    const type = selectedType()
    run(async () => {
        const to = chosenTarget
            ? chosenTarget.id
            : (await submit('add_node', { kind: type.to[0], title: form.target.value, where: form.targetWhere.value })).nodeId
        await submit('add_connection', { from: currentNode.id, type: type.id, to, note: form.note.value, source: form.source.value })
        form.reset()
    })
})

$('add-note').addEventListener('submit', event => {
    event.preventDefault()
    run(async () => {
        await submit('add_note', { node: currentNode.id, text: event.target.text.value })
        event.target.reset()
    })
})

$('add-tags').addEventListener('submit', event => {
    event.preventDefault()
    const tags = event.target.tags.value.split(',').map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean)
    run(async () => {
        for (const tag of new Set(tags)) {
            if (!currentNode.tags.includes(tag)) await submit('add_tag', { node: currentNode.id, tag })
        }
        event.target.reset()
    })
})

function updateKindFields() {
    const isSound = $('create').kind.value === 'sound'
    for (const node of document.querySelectorAll('.sound-only')) node.hidden = !isSound
}
$('create').kind.addEventListener('change', updateKindFields)

$('create').addEventListener('submit', async event => {
    event.preventDefault()
    const form = event.target
    $('create-result').hidden = false
    $('create-result').textContent = 'Uploading and signing…'
    try {
        const isSound = form.kind.value === 'sound'
        const [audioRef, artworkRef] = await Promise.all([
            isSound ? uploadMedia(form.audio.files[0]) : undefined,
            uploadMedia(form.artwork.files[0]),
        ])
        const payload = { audioRef, artworkRef }
        for (const field of ['kind', 'title', 'role', 'where', 'years', 'externalUrl', 'note', 'tags']) payload[field] = form[field].value
        if (isSound) payload.format = form.format.value
        const result = await submit('add_node', payload)
        $('create-result').textContent = result.existing
            ? `Already existed: your note and tags were added to it.\n${JSON.stringify(result, null, 2)}`
            : JSON.stringify(result, null, 2)
        form.reset()
        updateKindFields()
        loadNodes()
        refreshStatus()
        showNode(result.nodeId)
    } catch (err) {
        $('create-result').textContent = err.message
    }
})

async function refreshStatus() {
    $('status').textContent = JSON.stringify(await api('/status'), null, 2)
}

let filterTimer
for (const id of ['filter-q', 'filter-tags']) {
    $(id).addEventListener('input', () => {
        clearTimeout(filterTimer)
        filterTimer = setTimeout(loadNodes, 300)
    })
}
$('filter-kind').addEventListener('change', loadNodes)
$('refresh-status').addEventListener('click', refreshStatus)
$('new-key').addEventListener('click', () => loadAccount(true))

loadAccount()
updateKindFields()
api('/connection-types').then(types => (connectionTypes = types))
loadNodes()
refreshStatus()
