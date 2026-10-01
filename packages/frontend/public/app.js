const api = path => fetch(`/api${path}`).then(res => res.json())
const $ = id => document.getElementById(id)

function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props)
    node.append(...children)
    return node
}

function entityChip(entity) {
    return el('span', { className: 'chip', title: entity.type, onclick: () => showEntity(entity.id) }, `${entity.type}: ${entity.name}`)
}

function renderObjects(objects) {
    if (objects.length === 0) {
        $('objects').replaceChildren(el('p', {}, 'No matching objects.'))
        return
    }
    $('objects').replaceChildren(
        ...objects.map(o =>
            el(
                'div',
                { className: 'object' },
                el('strong', {}, `${o.title} `),
                el('small', {}, `${o.kind} by ${o.author} · ${new Date(o.created_at).toLocaleString()} · `,
                    o.block_number ? `block ${o.block_number}` : 'not yet on-chain'),
                el('p', {}, o.note),
                o.artwork_ref ? el('img', { src: `/api/media/${o.artwork_ref}`, height: 80 }) : '',
                o.audio_ref ? el('audio', { src: `/api/media/${o.audio_ref}`, controls: true, preload: 'none' }) : '',
                o.external_url ? el('a', { href: o.external_url, target: '_blank' }, o.external_url) : '',
                el('div', {}, ...o.entities.map(entityChip)),
                el('small', {}, `id ${o.id}`),
            ),
        ),
    )
}

async function loadObjects() {
    const tags = $('filter').value.split(',').map(t => t.trim()).filter(Boolean)
    const query = new URLSearchParams(tags.map(tag => ['tag', tag]))
    $('list-title').textContent = tags.length ? `Tagged ${tags.join(' + ')}` : 'Latest'
    renderObjects(await api(`/objects?${query}`))
}

async function showEntity(id) {
    const entity = await api(`/entities/${id}`)
    $('list-title').textContent = `${entity.type}: ${entity.name}`
    renderObjects(entity.objects)
}

async function refreshStatus() {
    $('status').textContent = JSON.stringify(await api('/status'), null, 2)
}

$('create').addEventListener('submit', async event => {
    event.preventDefault()
    const form = new FormData(event.target)
    const tags = String(form.get('tags')).split(',').map(name => ({ type: 'tag', name: name.trim() }))
    const others = String(form.get('others')).split('\n').map(line => {
        const [type, ...rest] = line.split(':')
        return { type: type.trim(), name: rest.join(':').trim() }
    })
    form.set('entities', JSON.stringify([...tags, ...others].filter(e => e.type && e.name)))
    for (const field of ['tags', 'others']) form.delete(field)
    for (const field of ['audio', 'artwork', 'externalUrl']) {
        const value = form.get(field)
        if (!value || value.size === 0) form.delete(field)
    }
    $('create-result').textContent = 'Uploading...'
    const res = await fetch('/api/objects', { method: 'POST', body: form })
    $('create-result').textContent = JSON.stringify(await res.json(), null, 2)
    loadObjects()
    refreshStatus()
})

let autocompleteTimer
$('autocomplete').addEventListener('input', event => {
    clearTimeout(autocompleteTimer)
    autocompleteTimer = setTimeout(async () => {
        const q = event.target.value.trim()
        const results = q ? await api(`/entities?q=${encodeURIComponent(q)}`) : []
        $('suggestions').replaceChildren(...results.map(entityChip))
    }, 200)
})

let filterTimer
$('filter').addEventListener('input', () => {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(loadObjects, 300)
})
$('refresh-status').addEventListener('click', refreshStatus)

loadObjects()
refreshStatus()
