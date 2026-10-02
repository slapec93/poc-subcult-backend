const $ = id => document.getElementById(id)
const author = () => $('author').value.trim()

async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, options)
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    return body
}

const postJson = (path, body) =>
    api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: author(), ...body }) })

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
    if (nodes.length === 0) return $('nodes').replaceChildren(el('p', { className: 'muted' }, 'Nothing found.'))
    $('nodes').replaceChildren(
        ...nodes.map(n =>
            el(
                'div',
                { className: 'card', onclick: () => showNode(n.id) },
                el('div', { className: 'kind' }, [n.kind, n.role, n.format, n.years].filter(Boolean).join(' · ')),
                el('strong', {}, n.title),
                n.where ? el('span', { className: 'muted' }, ` — ${n.where}`) : null,
                n.firstNote ? el('div', {}, n.firstNote) : null,
                el('div', {}, ...n.tags.map(tagChip)),
                el('div', { className: 'muted' }, `${n.noteCount} notes · ${n.connectionCount} connections · added by @${n.addedBy}`),
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
        [node.where, `added by @${node.addedBy}`, confirmation(node)].filter(Boolean).join(' · '),
        node.externalUrl ? el('div', {}, el('a', { href: node.externalUrl, target: '_blank' }, node.externalUrl)) : null,
    )
    fill(
        'detail-media',
        node.artworkRef ? el('img', { src: `/api/media/${node.artworkRef}`, height: 120 }) : null,
        node.audioRef ? el('audio', { src: `/api/media/${node.audioRef}`, controls: true, preload: 'none' }) : null,
    )
    $('detail-tags').replaceChildren(...node.tags.map(tagChip))
    $('detail-notes').replaceChildren(
        ...node.notes.map(n =>
            el('div', { className: 'note' }, n.text, el('div', { className: 'muted' }, `@${n.author} · ${new Date(n.createdAt).toLocaleString()} · ${confirmation(n)}`)),
        ),
    )
    $('detail-connections').replaceChildren(
        ...node.connections.map(c =>
            el(
                'div',
                { className: 'note' },
                el('span', { className: 'kind' }, `${c.label} `),
                el('a', { href: '#', onclick: e => (e.preventDefault(), showNode(c.nodeId)) }, c.nodeTitle),
                el('span', { className: 'muted' }, ` (${c.nodeKind})`),
                el('div', {}, `“${c.note}” — @${c.author}`),
                c.source ? el('a', { href: c.source, target: '_blank', className: 'muted' }, c.source) : null,
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
    $('target-suggestions').replaceChildren()
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
        if (!q || !type) return $('target-suggestions').replaceChildren()
        const results = (await Promise.all(type.to.map(kind => api(`/nodes?kind=${kind}&q=${encodeURIComponent(q)}&limit=5`)))).flat()
        $('target-suggestions').replaceChildren(
            ...results.map(n =>
                el('span', {
                    className: 'chip',
                    onclick: () => {
                        chosenTarget = n
                        $('add-connection').target.value = n.title
                        $('target-choice').textContent = `connecting to existing ${n.kind}`
                        $('target-suggestions').replaceChildren()
                        updateNewPlaceField()
                    },
                }, `${n.title} (${n.kind}${n.where ? `, ${n.where}` : ''})`),
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
    const title = form.target.value.trim()
    const target = chosenTarget
        ? { to: chosenTarget.id }
        : { toNode: { kind: type.to[0], title, where: form.targetWhere.value.trim() || undefined } }
    run(async () => {
        await postJson('/connections', {
            from: currentNode.id,
            type: type.id,
            ...target,
            note: form.note.value,
            source: form.source.value.trim() || undefined,
        })
        form.reset()
    })
})

$('add-note').addEventListener('submit', event => {
    event.preventDefault()
    run(async () => {
        await postJson(`/nodes/${currentNode.id}/notes`, { text: event.target.text.value })
        event.target.reset()
    })
})

$('add-tags').addEventListener('submit', event => {
    event.preventDefault()
    const tags = event.target.tags.value.split(',').map(t => t.trim()).filter(Boolean)
    run(async () => {
        await postJson(`/nodes/${currentNode.id}/tags`, { tags })
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
    const form = new FormData(event.target)
    form.set('author', author())
    for (const [key, value] of [...form.entries()]) {
        if (value === '' || (value instanceof File && value.size === 0)) form.delete(key)
    }
    $('create-result').hidden = false
    $('create-result').textContent = 'Saving…'
    try {
        const result = await api('/nodes', { method: 'POST', body: form })
        $('create-result').textContent = result.existing
            ? `Already existed: your note and tags were added to it.\n${JSON.stringify(result, null, 2)}`
            : JSON.stringify(result, null, 2)
        event.target.reset()
        updateKindFields()
        loadNodes()
        refreshStatus()
        showNode(result.id)
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

try {
    $('author').value = localStorage.getItem('author') || $('author').value
} catch {}
$('author').addEventListener('change', () => {
    try {
        localStorage.setItem('author', author())
    } catch {}
})

updateKindFields()
api('/connection-types').then(types => (connectionTypes = types))
loadNodes()
refreshStatus()
