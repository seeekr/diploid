const PACKS = require('./build/packs')
const buildPacks = Object.values(PACKS)
const _ = require('lodash')
const toposort = require('toposort')

function baseImage(pack) {
    if (pack.baseImage) {
        return [pack.baseImage]
    }
    if (pack.depends) {
        return _.uniq(buildPacks.filter(it => pack.depends.includes(it)).flatMap(baseImage))
    }
    return null
}

function commonBaseImage(packs) {
    return _.uniq(packs.flatMap(p => baseImage(p)))
}

async function preBuild(packs, dir) {
    return await apply(packs, 'preBuild', dir)
}

async function build(packs, dir) {
    return await apply(packs, 'build', dir)
}

async function apply(packs, fn, dir) {
    return _.flatten(await Promise.all(
        packs.map(async p => p[fn] ? await p[fn](dir) : []),
    ))
}

function depSort(items) {
    const ordered = []
    const graph = []
    for (const p of items) {
        if (!p.depends || !p.depends.length) {
            ordered.push(p.name)
        } else {
            graph.push(...(p.depends || []).map(d => [p.name, d]))
        }
    }
    return _.uniq([...ordered, ...toposort(graph).reverse()])
}

function order(packs) {
    return depSort(packs.map(p => ({
        name: p.name,
        depends: (p.depends || []).map(p => p.name),
    }))).map(p => PACKS[p])
}

module.exports = {
    commonBaseImage,
    preBuild,
    build,
    order,
    depSort,
}
