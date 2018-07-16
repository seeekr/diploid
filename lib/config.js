const {safeEval} = require('./lib')
const esprima = require('esprima')
const estraverse = require('estraverse')
const escodegen = require('escodegen')
const YAML = require('js-yaml')
const path = require('path')
const _ = require('lodash')

function loadServiceConfig(js) {
    let ast = esprima.parse(js)
    ast = estraverse.replace(ast, {
        enter(node) {
            if (node.type === 'MemberExpression') {
                const newNode = esprima.parse(`_ = {__pathExpr__: '${escodegen.generate(node)}'}`)
                return newNode.body[0].expression.right
            }
        },
    })
    return safeEval(ast, {
        from(...args) {
            return args
        },
    })
}

function isPrimitive(val) {
    return val == null || ['number', 'string', 'boolean'].includes(typeof val)
}

function getCaseMod(array) {
    let caseMod
    const chars = array.join('').replace(/[^a-z]/ig, '')
    if (/[a-z]+/.test(chars)) {
        caseMod = 'toLowerCase'
    } else if (/[A-Z]+/.test(chars)) {
        caseMod = 'toUpperCase'
    } else {
        caseMod = 'toString'
    }
    return s => s && s[caseMod]()
}

function evalPathExprs(rhs, model, env, branch, prod) {
    if (_.isPlainObject(rhs) && rhs.__pathExpr__) {
        rhs = [rhs]
    }
    if (_.isArray(rhs) && rhs.every(rhs => rhs == null || typeof rhs === 'object' && rhs.__pathExpr__)) {
        const context = {
            services: model.services.reduce((ret, s) => {
                const deploymentName = s.name + (prod || !branch ? '' : `-${branch}`)
                const host = deploymentName
                const port = s.ports && s.ports[0]
                const merged = _.merge(
                    {deploymentName, host, port},
                    s.conf,
                    (s.conf.byEnv || {})[env],
                )
                if (!merged.env) {
                    merged.env = {}
                }
                const envPrefix = commonPrefix(Object.keys(merged.env))
                const caseMod = getCaseMod(Object.keys(merged.env))
                Object.assign(merged.env, {
                    [envPrefix + caseMod('host')]: host,
                    [envPrefix + caseMod('port')]: port,
                })
                ret[s.name] = merged
                return ret
            }, {}),
            vars: model.conf.vars || {},
        }
        rhs = _.merge({}, ...rhs.map(rhs => rhs && _.get(context, rhs.__pathExpr__)))
    }
    return rhs
}

function parseAttrs(str, {noPath}) {
    const items = str.split(' ')
    if (noPath) {
        return {
            attrs: items.reduce((ret, item) => {
                const [k, v] = item.split('=')
                ret[k] = typeof v !== 'undefined' ? v : true
                return ret
            }, {}),
        }
    }
    let path, attrs = {}
    for (const item of items) {
        const ix = item.indexOf('=')
        if (ix === -1) {
            if (path) {
                console.log(`invalid key ${str}, ignoring ${path}`)
                continue
            }
            path = item
        } else {
            attrs[item.substring(0, ix)] = item.substr(ix + 1)
        }
    }
    return {path, attrs}
}

function processConfigure(model, deployment, file, props, content) {
    const {env, branch, prod} = deployment
    // copy file from container
    const type = path.extname(file).replace(/^\./, '')
    let loadFn, dumpFn
    if (['yaml', 'yml'].includes(type)) {
        loadFn = YAML.safeLoad
        dumpFn = YAML.safeDump
    } else {
        console.log(`unsupported file type: ${file}`)
        return
    }
    const o = content ? loadFn(content) : {}
    // apply modifications
    for (const [k, v] of Object.entries(props)) {
        let {path, attrs} = parseAttrs(k)
        let forEnv
        for (const [ak, av] of Object.entries(attrs)) {
            if (ak === 'env') {
                forEnv = av
            } else {
                console.log(`unknown attr ${ak}, ignoring`)
            }
        }
        if (forEnv && forEnv !== env) continue
        const pathEls = path.split('.')
        const last = pathEls[pathEls.length - 1]
        const ix = last.indexOf('*')
        let match
        if (ix !== -1) {
            match = last
            pathEls.splice(-1, 1)
        }
        let cur = o
        for (const pathEl of pathEls) {
            if (!(pathEl in cur)) {
                cur[pathEl] = {}
            }
            cur = cur[pathEl]
        }

        // normalize RHS
        const rhs = evalPathExprs(v, model, env, branch, prod)

        // apply
        if (match) {
            if (typeof rhs !== 'object') {
                console.log(`we have a property-match intention for ${k}, but right-hand side is not an object: ${JSON.stringify(rhs)} -- skipping`)
                continue
            }
            const re = new RegExp(last.replace('*', '(.*)'))
            const done = {}
            const matchingSourceKeys = Object.keys(cur).map(it => {
                const m = it.match(re)
                if (m) {
                    return m[1]
                }
            }).filter(it => it)
            if (!rhs) {
                for (const key of matchingSourceKeys) {
                    cur[key] = null
                }
                continue
            }
            const targetKeys = Object.keys(rhs)
            for (const key of matchingSourceKeys) {
                const matching = targetKeys.filter(k => k.toLowerCase().indexOf(key.toLowerCase()) !== -1)
                if (matching.length === 1) {
                    done[matching[0]] = true
                    _.merge(cur, {[last.replace('*', key)]: rhs[matching[0]]})
                }
                // (later) more (error) handling here would be nice
            }
            let rhsCommonPrefix, lhsStub, caseMod
            for (const [rhk, rhv] of Object.entries(rhs)) {
                if (done[rhk]) continue
                if (!rhsCommonPrefix) {
                    rhsCommonPrefix = commonPrefix(targetKeys)
                    lhsStub = last.replace('*', '')
                    if (matchingSourceKeys.length) {
                        caseMod = getCaseMod(matchingSourceKeys)
                    }
                }
                let key = rhk
                if (rhsCommonPrefix && rhsCommonPrefix !== lhsStub) {
                    key = key.replace(new RegExp(`^${rhsCommonPrefix}`), '')
                }
                if (caseMod) {
                    key = caseMod(key)
                }
                _.merge(cur, {[last.replace('*', key)]: rhv})
            }
        } else {
            if (isPrimitive(rhs)) {
                _.set(o, pathEls.join('.'), rhs)
            } else {
                _.merge(cur, rhs)
            }
        }
    }
    return [file, dumpFn(o), o]
}

function commonPrefix(array) {
    if (!array || array.length < 2) return ''
    const arr = array.concat().sort(),
        a1 = arr[0], a2 = arr[arr.length - 1]
    let i = 0
    while (i < a1.length && a1.charAt(i) === a2.charAt(i)) i++
    return a1.substring(0, i)
}

module.exports = {
    loadServiceConfig,
    processConfigure,
    evalPathExprs,
    parseAttrs,
}
