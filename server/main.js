// set up routes for hooks: probably just POST /gitlab/push
// get from env:
// gitlab personal access token
// which gitlab project url we're supposed to configure ourselves from, plus path

// on push to deployed project: figure out if we need to take action, and which one, execute it
// on push to "ops" project: execute the steps below similar to on first run of this tool


// checkout gitlab "ops" project
// (keep it cached; next time do git fetch && git reset --hard origin(/<branch>?))
// read relevant configuration, validate + normalize
// if config changed: update/reload our own config


// deployment:
// need full kubectl access

const fs = require('fs-extra')
const Gitlab = require('node-gitlab-api/dist/es5').default
const {sh, safeEval, splitImage, interpolate} = require('../lib/lib')
const {getImageConfig, getExposedPorts} = require('../lib/registry')
const {findConfigFiles} = require('../lib/diploid')
const globFiles = require('glob-promise')
const glob = require('micromatch')
const _ = require('lodash')
const moment = require('moment')
const path = require('path')
const YAML = require('js-yaml')

const ENV_CONF_NAME = `.diploid.conf.js`

const CONFIG_DIR = process.env.CONFIG_DIR || '.run/config'
const SOURCE_DIR = process.env.SOURCE_DIR || '.run/sources'
const STATE_DIR = process.env.STATE_DIR || '.run/state'

const DOCKER_CONFIG = `${STATE_DIR}/docker/config.json`

const USE_GVISOR = process.env.USE_GVISOR != null

const HOOKS_TOKEN = process.env.HOOKS_TOKEN || 'GXqAJyrd0YSqJxJ6gBgx6hnuwaK8AZGO'

const git = require('simple-git/promise')(SOURCE_DIR)

let config, gl, opsDir, model, groupFile

async function init() {
    config = JSON.parse(await fs.readFile(`${CONFIG_DIR}/config.json`, 'utf8'))

    // create docker config.json with registry auth
    const dockerConfig = {
        auths: {
            [getRegistryUrl()]: {
                email: 'not@val.id',
                auth: Buffer.from(`${config.user}:${config.gitlabToken}`).toString('base64'),
            },
        },
    }

    {
        const existed = await fs.exists(DOCKER_CONFIG)
        const prev = existed && await fs.readFile(DOCKER_CONFIG, 'utf8')
        if (!existed) {
            await fs.mkdirp(path.dirname(DOCKER_CONFIG))
        }
        const content = JSON.stringify(dockerConfig)
        if (prev !== content) {
            await fs.writeFile(DOCKER_CONFIG, content, 'utf8')
            console.log(`[status] ${existed ? 'updated' : 'created'} docker registry config file`)
        }
    }

    // create registry credentials for k8s if necessary
    try {
        await sh('kubectl get secret registry -n diploid')
    } catch (e) {
        await sh(`kubectl create secret -n diploid docker-registry registry --docker-server='${getRegistryUrl()}' --docker-username='${config.user}' --docker-password='${config.gitlabToken}' --docker-email='not@val.id'`)
        console.log(`[status] created docker registry secret`)
    }

    gl = new Gitlab({
        url: `https://${config.domain}`,
        token: config.gitlabToken,
    })

    // on daemon start:
    // go through all configured gitlab/master repo entries
    // add hook to master repo if not present
    // build up the models if not already in the db
    // add hooks to all relevant repos if not present

    await fs.mkdirp(SOURCE_DIR)
    opsDir = await gitClone(config.opsRepo)

    const groupFiles = findConfigFiles(opsDir)
    if (groupFiles.length !== 1) {
        throw new Error(`expected to find exactly one '${ENV_CONF_NAME}' file in project ${config.opsRepo}, found ${groupFiles.length}`)
    }
    groupFile = groupFiles[0]

    console.log(`[status] initialized from group file: ${groupFile}`)

    model = await loadModel()

    await addHooks(model)
}

const _init = init()
    .catch(e => {
        console.error(`failed: ${e.message || e}`, e)
        throw e
    })

const Koa = require('koa')
const app = new Koa()
const Router = require('koa-router')
const router = new Router()

router.post('/gitlab/hook', async ctx => {
    await _init

    const e = ctx.request.body
    if (e.object_kind !== 'push') {
        ctx.status = 200
        return
    }

    // if the event was caused by us pushing our automated changes, skip processing
    if (e.commits.every(c => c.message.startsWith('(bot/diploid)'))) {
        ctx.status = 200
        return
    }

    // if it's a configured service:
    // - checkout code
    // - build image
    // - deploy as configured, if necessary

    // if it's the ops repo:
    // - do the full run: git update, reload model, deploy all

    const path = e.project.path_with_namespace
    const branch = e.ref.replace(/^refs\/heads\//, '')
    if (path === config.opsRepo) {
        if (branch !== 'master') {
            console.log(`watching only master branch of repo ${path}, ignoring changes to branch: ${branch}`)
            ctx.status = 200
            return
        }
        await gitClone(config.opsRepo)
        const model = await loadModel()
        for (const service of model.services) {
            await deploy(model, service)
        }
    } else {
        const gitDir = await gitClone(path, branch)
        const tag = e.checkout_sha.substr(0, 8)
        const imagePath = `${path}/${branch}`

        const runtimeArg = USE_GVISOR ? '--runtime=runsc' : ''
        await sh(`docker run ${runtimeArg} --rm -v ${gitDir}:/workspace -v ${DOCKER_CONFIG}:/root/.docker/config.json:ro gcr.io/kaniko-project/executor --destination='${getRegistryUrl()}/${imagePath}:${tag}'`)

        const model = await loadModel()
        const service = model.services.find(it => it.repo.id === e.project.id)
        if (!service) {
            console.log(`no configured service found with id #${e.project.id}`)
            ctx.status = 200
            return
        }

        await deploy(model, service)
    }

    console.log(ctx.request.body)
    ctx.status = 200
})

app
    .use(require('koa-body')())
    .use(router.routes())
    .use(router.allowedMethods())

app.listen(3000)

async function loadModel() {
    const groupConf = _.merge({
        services: {defaults: {}},
    }, safeEval(await fs.readFile(groupFile, 'utf8')))

    const NON_ENV_KEYS = ['domain', 'services', 'gitlabToken', 'registry', 'user']
    const groupEnvConfigs = _.omit(groupConf, NON_ENV_KEYS)
    const repos = _.keyBy(await loadRepos(), 'path')

    const services = (await Promise.all(
        (await getServiceConfigs(path.dirname(groupFile))).map(async ([name, k8sConf]) => {
            const conf = _.merge(
                {},
                _.omit(groupConf, NON_ENV_KEYS),
                groupConf.services.defaults || {},
                groupConf.services[name] || {},
                k8sConf,
            )
            const envConfigs = _.merge({}, groupEnvConfigs, _.omit(conf, NON_ENV_KEYS))

            const service = {name, conf}

            const repo = repos[k8sConf.repo || name]
            if (repo) {
                const branchToEnv = _.reduce(envConfigs, (ret, conf, name) => Object.assign(ret, {[conf.branch]: name}), {})
                const prodBranchName = (conf.production || {}).branch
                repo.branches = repo.branches
                    .map(branch => Object.assign(branch, {
                        prod: prodBranchName && glob.isMatch(branch.name, prodBranchName) || false,
                        stale: moment(branch.lastCommit.date).isBefore(moment().subtract(60, 'days')),
                    }))
                    .filter(({stale, prod, merged}) => prod || (!stale && !merged))
                const deployments = await Promise.all(
                    _.sortBy(repo.branches, b => prodBranchName && glob.isMatch(b.name, prodBranchName) ? 10000 + b.id : b.id)
                        .reverse()
                        .map(async branch => {
                            // match branch to target environment
                            let env = branchToEnv[branch.name]
                            let isGlob = null
                            if (!env) {
                                const results = Object.entries(branchToEnv).map(([pattern, targetEnv]) => ([glob.isMatch(branch.name, pattern), pattern, targetEnv]))
                                let curMatch = null
                                let curGlob = null
                                for (const [matches, pattern, targetEnv] of results) {
                                    if (!matches) continue
                                    let isGlob = pattern.includes('*')
                                    if (!curMatch || (curGlob && !isGlob) || targetEnv.length > curMatch.length) {
                                        env = targetEnv
                                        curMatch = pattern
                                        curGlob = isGlob
                                    }
                                }
                                if (env) {
                                    isGlob = curGlob
                                }
                            }
                            const imagePath = `${repo.fullPath}/${branch.name}`
                            const tag = branch.lastCommit.short

                            return await addPorts(Object.assign({
                                repo: repo.fullPath,
                                branch: branch.name,
                                env,
                                commit: branch.lastCommit,
                                prod: branch.prod,
                                glob: isGlob,
                            }), imagePath, tag, true)
                        }),
                )
                Object.assign(service, {repo, deployments})
            } else {
                const explicitEnvs = _.omit(groupConf.services[name] || {}, ['domain'])
                if (Object.values(explicitEnvs).some(v => Object.keys(v).includes('branch'))) {
                    log.error('%s: branches configured for %s but no matching repository found', groupFile, name)
                    return service
                }
                if (!conf.image) {
                    log.error('%s: no repository found for %s and no explicit image configured, cannot generate deployment!', groupFile, name)
                    return service
                }

                const [imagePath, tag] = splitImage(conf.image)
                await addPorts(service, imagePath, tag)
            }

            return service
        }),
    )).filter(it => it)

    const group = {
        name: path.basename(path.dirname(groupFile)),
        file: groupFile.split(opsDir + '/')[1],
        conf: groupConf,
        repo: Object.values(repos).find(r => r.fullPath === config.opsRepo),
        services,
    }

    const out = JSON.stringify(group, null, 4)
    await fs.mkdirp(STATE_DIR)
    await fs.writeFile(`${STATE_DIR}/${group.name}.json`, out, 'utf8')
}

async function addHooks(model) {
    // hook for
    // - ops project
    // - all services that were matched to a repo
    let hookUrl
    if (process.env.INGRESS_URL) {
        hookUrl = process.env.INGRESS_URL
    } else {
        const ingress = JSON.parse(await sh(`kubectl get ing diploid -n diploid -o json`))
        hookUrl = `https://${ingress.spec.rules[0].host}${ingress.spec.rules[0].paths[0].path}`
    }
    hookUrl += '/gitlab/hook'
    for (const repo of [model.repo, ..._.map(model.services, 'repo').filter(it => it)]) {
        const hooks = await gl.ProjectHooks.all(repo.id)
        if (!hooks.some(h => h.url === hookUrl)) {
            await gl.ProjectHooks.add(repo.id, hookUrl, {
                push_events: true,
                token: HOOKS_TOKEN,
                enable_ssl_verification: true,
            })
            console.log(`[status] hook created for ${repo.fullPath}`)
        }
    }
}

async function deploy(model, service) {
    const {name, conf: serviceConf, deployments} = service
    let toDeploy
    if (deployments) {
        toDeploy = deployments.map(({repo, branch, env, commit, glob, prod, ports}) => ({
            env,
            imagePath: `${repo}/${branch}`,
            tag: commit.short,
            registry: getRegistryUrl(),
            branch,
            glob,
            prod,
            ports,
        }))
    } else {
        toDeploy = _.uniq(['production', ...Object.keys(serviceConf.byEnv || {})]).map(env => {
            const conf = Object.assign({}, serviceConf, (serviceConf.byEnv || {})[env])
            const [imagePath, tag] = splitImage(conf.image)
            return {
                env,
                imagePath,
                tag,
                prod: env === 'production',
                ports: conf.ports,
            }
        })
    }
    for (const {env, imagePath, tag, registry, branch, glob, prod, ports: _ports} of toDeploy) {
        const conf = Object.assign({}, serviceConf, (serviceConf.byEnv || {})[env])
        const image = `${registry ? registry + '/' : ''}${imagePath}:${tag}`

        let ports = _ports
        if (!ports) {
            try {
                ports = getExposedPorts(await getImageConfig(imagePath, tag, registry, config.domain, config.user, config.gitlabToken))
            } catch (e) {
                ports = [80]
            }
        }

        const kind = conf.stateful ? 'StatefulSet' : 'Deployment'
        const labels = {app: name}
        const namespace = env
        let nodeSelector = null
        if (conf.node) {
            nodeSelector = {
                'kubernetes.io/hostname': conf.node,
            }
        }
        let [baseDomain, ...domainAttrs] = config.domain.split(/\s+/)
        const context = {
            name,
            namespace,
            env,
            domain: baseDomain,
        }

        const map = (typeof conf.map === 'string' ? [conf.map] : conf.map || [])
        const volumes = []
        const volumeMounts = []
        for (const item of map) {
            const parts = item.split(':')
            const type = parts[0][0] === '/' ? 'host' : parts.shift()
            const from = parts.shift()
            const to = parts[0][0] === '/' ? parts.shift() : from
            const flags = parts

            if (type !== 'host') {
                log.error('unknown volume mapping type %s', type)
                throw new Error()
            }

            const hostPath = interpolate(from, context)
            const mountPath = interpolate(to, context)

            const safeFrom = hostPath.replace(/\W+/g, '-').replace(/^-/, '').replace(/-{2,}/g, '')
            const name = `${type}-${safeFrom}`
            volumes.push({
                name,
                hostPath: {path: hostPath},
            })
            volumeMounts.push({
                name,
                mountPath,
                ...(/ro|readonly/i.test(flags.join(',')) ? {readOnly: true} : null),
            })
        }
        let affinity = null
        if (conf.unique) {
            if (/\bnode\b/i.test(conf.unique)) {
                affinity = {
                    podAntiAffinity: {
                        requiredDuringSchedulingIgnoredDuringExecution: [
                            {
                                labelSelector: {matchExpressions: [{key: 'app', operator: 'In', values: [name]}]},
                                topologyKey: 'kubernetes.io/hostname',
                            },
                        ],
                    },
                }
            } else {
                log.error('only per-node uniqueness value is supported, got: %s -- not generating deployment', conf.unique)
                continue
            }
        }

        const serviceOpts = (conf.service || '').split(/[, ]+/).reduce((ret, o) => {
            if (o) {
                const [k, v] = o.split('=')
                ret[k] = v
            }
            return ret
        }, {})
        let clusterIP = null
        if (serviceOpts.proxy && ['0', 'false', 'off', 'no'].includes(serviceOpts.proxy)) {
            clusterIP = 'None'
        }

        const items = [
            {
                kind,
                apiVersion: 'apps/v1',
                metadata: {
                    name,
                    namespace,
                    labels,
                },
                spec: {
                    selector: {matchLabels: labels},
                    ...(kind === 'StatefulSet' ? {serviceName: name} : {}),
                    template: {
                        metadata: {labels},
                        spec: {
                            ...(nodeSelector ? {nodeSelector} : {}),
                            containers: [
                                {
                                    name,
                                    image,
                                    ports: ports.map(port => ({containerPort: port})),
                                    ...(conf.env ? {
                                        env: Object.entries(conf.env)
                                            .map(([name, value]) => ({
                                                name,
                                                value,
                                            })),
                                    } : {}),
                                    volumeMounts,
                                },
                            ],
                            volumes,
                            ...(affinity ? {affinity} : {}),
                        },
                    },
                },
            },
            {
                kind: 'Service',
                apiVersion: 'v1',
                metadata: {
                    name,
                    namespace,
                    labels,
                },
                spec: {
                    ports: ports.map(port => ({port})),
                    ...(clusterIP ? {clusterIP} : {}),
                    selector: labels,
                },
            },
        ]
        if (conf.ingress == null || conf.ingress) {
            const annotations = {
                'kubernetes.io/ingress.class': 'nginx',
                'kubernetes.io/tls-acme': 'true',
                'ingress.kubernetes.io/ssl-redirect': 'true',
            }
            domainAttrs = _.fromPairs(domainAttrs.join(',').split(/[, ]+/).map(it => it.split('=')))
            if (domainAttrs.mapEnv) {
                if (domainAttrs.mapEnv !== 'subdomain') {
                    throw new Error('todo')
                }
                if (!prod) {
                    baseDomain = `${env}.${baseDomain}`
                }
            }
            let {url} = conf
            if (glob) {
                url = `${url}/${branch}`
            }
            const URL = require('url').URL
            url = new URL(interpolate(url, context))
            const host = url.hostname
            const path = url.pathname

            const ingress = {
                kind: 'Ingress',
                apiVersion: 'extensions/v1beta1',
                metadata: {
                    name,
                    namespace,
                    labels,
                    annotations,
                },
                spec: {
                    tls: [{
                        hosts: [host],
                        secretName: `tls-${host.replace(/\./g, '-')}`,
                    }],
                    rules: [{
                        host: host,
                        http: {
                            paths: [{
                                path,
                                backend: {serviceName: name, servicePort: ports[0]},
                            }],
                        },
                    }],
                },
            }
            if (conf.cors) {
                Object.assign(annotations, {
                    'ingress.kubernetes.io/enable-cors': 'true',
                    'ingress.kubernetes.io/cors-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'ingress.kubernetes.io/cors-allow-origin': '*',
                    'ingress.kubernetes.io/cors-allow-headers': 'Authorization, Accept, Content-Type',
                    'ingress.kubernetes.io/cors-allow-credentials': 'true',
                })
            }
            items.push(ingress)
        }

        const out = items
            .map(it => YAML.safeDump(it, {noRefs: true, noCompatMode: true, lineWidth: 240}))
            .join('\n---\n\n')
        const file = `${SOURCE_DIR}/${config.opsRepo}/${path.dirname(model.file)}/${name}${prod ? '' : '-' + env}.yaml`
        await fs.writeFile(file, out, 'utf8')
        const status = await git.status()
        const itemMsg = `deployment yaml for ${model.name}/${name} for env ${env}`
        if (status.not_added.includes(file)) {
            await git.add(file)
            await git.commit(`(bot/diploid) new ${itemMsg}`)
            console.log(`[status] new ${itemMsg}`)
        } else if (status.modified.includes(file)) {
            await git.commit(`(bot/diploid) updated ${itemMsg}`)
            console.log(`[status] updated ${itemMsg}`)
        } else {
            continue
        }
        const [origin, current] = status.tracking.split('/')
        await git.push(origin, current)

        // now we deploy
        await sh(`kubectl apply -f ${file}`)
        console.log(`[status] deployed ${model.name}/${name}:${env}`)
    }
}

async function gitClone(path, branch = null) {
    const targetDir = `${SOURCE_DIR}/${path}${branch ? '/' + branch : ''}`
    if (!await fs.exists(targetDir)) {
        await sh(`git clone 'https://${config.user}:${config.gitlabToken}@${config.domain}/${path}' ${targetDir}${branch ? ' -b ' + branch : ''}`)
    } else if (await fs.exists(`${targetDir}/.git`)) {
        await sh(`cd ${targetDir} && git fetch --all`)
    } else if (process.env.NODE_ENV === 'dev') {
        // OK to work with predefined non-git folder in development
    } else {
        // but not in production!
        throw new Error(`folder ${targetDir} exists, but is not a git repository`)
    }
    return targetDir
}

async function getServiceConfigs(dir) {
    return await Promise.all((await globFiles(`${dir}/*.k8s.js`)).map(async f => [path.basename(f, '.k8s.js'), safeEval(await fs.readFile(f, 'utf8'))]))
}

async function loadRepos() {
    return await Promise.all(
        (await gl.Projects.all())
            .map(async p => ({
                id: p.id,
                path: p.path,
                namespace: p.namespace.path,
                fullPath: p.path_with_namespace,
                branches: await loadBranches(p.id),
            })),
    )
}

async function loadBranches(pid) {
    return (await gl.Branches.all(pid))
        .map(b => ({
            id: b.id,
            name: b.name,
            merged: b.merged,
            lastCommit: {
                id: b.commit.id,
                short: b.commit.short_id,
                date: moment(b.commit.committed_date).toDate(),
            },
        }))
}

function getRegistryUrl() {
    let {registry} = config
    registry = registry.replace(/^https?:\/\//, '')
    const [host, port] = registry.split(':')
    return `${host || config.domain}${port ? ':' + port : ''}`
}

async function addPorts(service, imagePath, tag = 'latest', gitlabRegistry = false) {
    try {
        const imageConfig = await getImageConfig(imagePath, tag, ...(gitlabRegistry ? [getRegistryUrl(), config.domain, config.user, config.gitlabToken] : []))
        const ports = getExposedPorts(imageConfig)
        if (ports && ports.length) {
            service.ports = ports
        }
    } catch (e) {
        // ignore here, image may not have been built yet
    }
    return service
}
