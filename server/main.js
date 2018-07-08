const fs = require('fs-extra')
const os = require('os')
const Gitlab = require('node-gitlab-api/dist/es5').default
const {sh, safeEval, splitImage, interpolate, normalizeLogger} = require('../lib/lib')
const {loadServiceConfig, processConfigure} = require('../lib/config')
const {getImageConfig, getExposedPorts} = require('../lib/registry')
const {findConfigFiles} = require('../lib/diploid')
const globFiles = require('glob-promise')
const glob = require('micromatch')
const _ = require('lodash')
const moment = require('moment')
const path = require('path')
const YAML = require('js-yaml')
const Git = require('simple-git/promise')
const bunyan = require('bunyan')
const log = normalizeLogger(bunyan.createLogger({
    name: 'diploid',
    stream: process.stdout,
    level: 'trace',
    serializers: bunyan.stdSerializers,
}))

const ENV_CONF_NAME = `.diploid.conf.js`

const CONFIG_DIR = process.env.CONFIG_DIR || '.run/config'
const SOURCE_DIR = process.env.SOURCE_DIR || '.run/sources'
const STATE_DIR = process.env.STATE_DIR || '.run/state'

const DOCKER_CONFIG = `${STATE_DIR}/docker/config.json`

const USE_GVISOR = process.env.USE_GVISOR != null

const HOOKS_TOKEN = process.env.HOOKS_TOKEN || 'GXqAJyrd0YSqJxJ6gBgx6hnuwaK8AZGO'

let bootstrapConfig, config, gl, opsDir, opsGit, model, groupFile

async function init() {
    // load bootstrap config, fetch repo, read full config -- after that we can proceed with full information
    bootstrapConfig = config = JSON.parse(await fs.readFile(`${CONFIG_DIR}/config.json`, 'utf8'))

    await fs.mkdirp(SOURCE_DIR)
    opsDir = await gitClone(config.opsRepo)

    opsGit = new Git(opsDir)

    const groupFiles = await findConfigFiles(opsDir)
    if (groupFiles.length !== 1) {
        throw new Error(`expected to find exactly one '${ENV_CONF_NAME}' file in project ${config.opsRepo}, found ${groupFiles.length}`)
    }
    groupFile = groupFiles[0]

    console.log(`[status] initialized from group file: ${groupFile}`)

    gl = new Gitlab({
        url: `https://${config.gitlab}`,
        token: config.gitlabToken,
    })

    model = await loadModel()
    config = model.conf

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

    await addHooks(model)
}

const _init = init()
    .then(() => console.log(`[status] ready to deploy group "${model.name}" with ${model.services.length} services: ${model.services.map(s => s.name).join(', ')}`))
    .catch(e => {
        console.error(`failed!`, e)
        process.exit(1)
    })

const Koa = require('koa')
const app = new Koa()
const Router = require('koa-router')
const router = new Router()

router.post('/gitlab/hook', async function gitlabHook(ctx) {
    await _init

    ctx.status = 200
    ctx.flushHeaders()

    const e = ctx.request.body
    if (e.object_kind !== 'push') {
        return
    }

    // if the event was caused by us pushing our automated changes, skip processing
    if (e.commits.length && e.commits.every(c => c.message.startsWith('(bot/diploid)'))) {
        console.log('skipping processing of our own events')
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
            return
        }
        await gitClone(config.opsRepo)
        const model = await loadModel()
        for (const service of model.services) {
            await deploy(model, service)
        }
    } else {
        const model = await loadModel()
        const service = model.services.find(it => it.repo.id === e.project.id)
        if (!service) {
            console.log(`no configured service found with id #${e.project.id}`)
            return
        }

        // XXX in loadModel() we load whatever latest revision we get of the repo
        // that we're getting this event for, and it might not be the same revision
        // as we're getting notified about... inconsistencies could happen!

        const deployment = service.deployments.find(it => it.branch === branch)
        if (!deployment) {
            console.log(`configuration mismatch: no deployment found configured for service ${service.name}/${branch}`)
            return
        }
        if (deployment.commit.id !== e.checkout_sha) {
            console.log(`error: push event sha ${e.checkout_sha} -- latest available through git repo ${deployment.commit.id} -- not deploying!`)
            return
        }

        await build(path, branch, e.checkout_sha.substr(0, 8))
        await deploy(model, service, branch)
    }

    console.log('done processing request')
})

app
    .use(require('koa-body')())
    .use(router.routes())
    .use(router.allowedMethods())

app.listen(3000)

function normalizeDomain(config) {
    if (config.domain) {
        let [domain, ...domainAttrs] = config.domain.split(/\s+/)
        domainAttrs = _.fromPairs(domainAttrs.join(',').split(/[, ]+/).map(it => it.split('=')))
        Object.assign(config, {domain, domainAttrs})
    }
    return config
}

async function loadModel() {
    console.log('(re-)loading model')
    const groupConf = _.merge({
        services: {defaults: {}},
    }, bootstrapConfig, safeEval(await fs.readFile(groupFile, 'utf8')))
    normalizeDomain(groupConf)

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

                            return {
                                repo: repo.fullPath,
                                branch: branch.name,
                                env,
                                commit: branch.lastCommit,
                                prod: branch.prod,
                                glob: isGlob,
                            }
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

            // check for additional required build steps
            if (conf.configure) {
                if (!repo) {
                    console.error(`'configure' option is only valid for services with a repository (and thus build step), but service '${name}' is based on a prebuilt image -- ignoring this option`)
                    return service
                }
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

    return group
}

async function addHooks(model) {
    console.log(`ensuring hooks are set`)
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

async function deploy(model, service, onlyBranch = null) {
    console.log(`going to deploy ${model.name}/${service.name}:${onlyBranch || '(all envs)'}`)
    const {name: serviceName, conf: serviceConf, deployments} = service
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
        if (onlyBranch && branch !== onlyBranch) continue

        const conf = Object.assign({}, serviceConf, (serviceConf.byEnv || {})[env])
        const image = `${registry ? registry + '/' : ''}${imagePath}:${tag}` + (serviceConf.configure ? `-${env}` : '')

        let imageConfig
        try {
            imageConfig = await getImageConfig(imagePath, tag, registry, config.gitlab, config.user, config.gitlabToken)
        } catch (e) {
            if (e.statusCode === 404) {
                // image is not there
            } else {
                console.log('failed to read image config', e)
            }
        }
        if (service.repo) {
            const repoPath = service.repo.fullPath
            const gitDir = gitClone(repoPath, branch, tag)
            if (!imageConfig) {
                if (!await fs.exists(`${gitDir}/Dockerfile`)) {
                    console.log(`[status] image ${imagePath}:${tag} does not exist in registry ${registry}, and no Dockerfile in repo ${repoPath} branch ${branch} at ${tag} either -- cannot build, skipping!`)
                    continue
                }
                await build(service, branch, tag)
            }
        }

        const name = serviceName + (prod || !branch ? '' : `-${branch}`)

        let ports = _ports
        if (!ports) {
            if (imageConfig) {
                ports = getExposedPorts(imageConfig)
            } else {
                ports = [80]
            }
        }

        const kind = conf.stateful ? 'StatefulSet' : 'Deployment'
        const labels = {app: serviceName}
        if (!prod && branch) {
            Object.assign(labels, {branch})
        }
        const namespace = env
        let nodeSelector = null
        if (conf.node) {
            nodeSelector = {
                'kubernetes.io/hostname': conf.node,
            }
        }
        let {domain: baseDomain, domainAttrs} = config
        if (domainAttrs.mapEnv) {
            if (domainAttrs.mapEnv !== 'subdomain') {
                throw new Error('todo')
            }
            if (!prod) {
                baseDomain = `${env}.${baseDomain}`
            }
        }
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
                                                value: typeof value === 'boolean' ? `${value}` : value,
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
        const file = `${SOURCE_DIR}/${config.opsRepo}/${path.dirname(model.file)}/${serviceName}${prod ? '' : `-${env}${branch ? '-' + branch : ''}`}.yaml`
        await fs.writeFile(file, out, 'utf8')
        const status = await opsGit.status()
        const itemMsg = `deployment yaml for ${model.name}/${name} for env ${env}`
        const relFile = path.relative(`${SOURCE_DIR}/${config.opsRepo}`, file)
        if (status.not_added.includes(relFile)) {
            await opsGit.add(relFile)
            await opsGit.commit(`(bot/diploid) new ${itemMsg}`, relFile)
            console.log(`[status] new ${itemMsg}`)
        } else if (status.modified.includes(relFile)) {
            await opsGit.commit(`(bot/diploid) updated ${itemMsg}`, relFile)
            console.log(`[status] updated ${itemMsg}`)
        } else {
            console.log(`[status] unchanged, skipping ${itemMsg}`)
            continue
        }
        const [origin, current] = status.tracking.split('/')
        await opsGit.push(origin, current)

        // now we deploy
        try {
            await sh(`kubectl create ns ${namespace}`)
        } catch (e) {
            // already exists
        }
        await sh(`kubectl apply -f ${file}`)
        console.log(`[status] deployed ${model.name}/${name}:${env}`)
    }
}

async function build(service, branch, tag) {
    const path = service.repo.fullPath
    const gitDir = await gitClone(path, branch, tag)

    const image = `${getRegistryUrl()}/${path}/${branch}:${tag}`

    const runtimeArg = USE_GVISOR ? '--runtime=runsc' : ''
    await sh(`docker run ${runtimeArg} --rm -v $(pwd)/${gitDir}:/workspace -v $(pwd)/${DOCKER_CONFIG}:/root/.docker/config.json:ro gcr.io/kaniko-project/executor --destination='${image}'`)

    const {configure} = service.conf
    if (!configure) return

    const tmpDir = await fs.mkdtemp(os.tmpdir() + '/')
    for (const depl of service.deployments.filter(it => it.branch === branch)) {
        const {env} = depl
        const envDir = `${tmpDir}/${env}`
        const processed = Promise.all(
            configure.entries()
                .map(async ([file, props]) => [file, await sh(`docker run --rm ${image} cat ${file}`), props]),
        )
            .map(([file, props, content]) => processConfigure(model, depl, file, props, content))
        for (const [file, content] of processed) {
            // dump file back out
            await fs.mkdirp(`${envDir}/${path.dirname(file)}`)
            await fs.writeFile(`${envDir}/${file}`, content, 'utf8')
        }
        // write Dockerfile
        await fs.writeFile(`${envDir}/Dockerfile`, `FROM ${image}\n` + Object.keys(configure).map(f => `COPY ${f} ${f}`).join('\n'), 'utf8')
        // send off to kaniko to build
        const envImage = `${image}-${env}`
        await sh(`docker run ${runtimeArg} --rm -v $(pwd)/${envDir}:/workspace -v $(pwd)/${DOCKER_CONFIG}:/root/.docker/config.json:ro gcr.io/kaniko-project/executor --destination='${envImage}'`)
        await fs.remove(envDir)
    }
    await fs.remove(tmpDir)
}

function getGitPath(path, branch) {
    return `${SOURCE_DIR}/${path}${branch ? '/' + branch : ''}`
}

async function gitClone(path, branch = null, tag = null) {
    const targetDir = getGitPath(path, branch)
    if (!await fs.exists(targetDir)) {
        await sh(`git clone 'https://${config.user}:${config.gitlabToken}@${config.gitlab}/${path}' ${targetDir}${branch ? ' -b ' + branch : ''}`)
        if (tag) {
            await sh(`cd ${targetDir} git checkout ${tag}`)
        }
    } else if (await fs.exists(`${targetDir}/.git`)) {
        // later/bug: assuming that default branch is "master", which could be completely wrong
        await sh(`cd ${targetDir} && git fetch --all && git checkout ${tag || branch || 'master'}`)
    } else if (process.env.NODE_ENV === 'dev') {
        // OK to work with predefined non-git folder in development
        return targetDir
    } else {
        // but not in production!
        throw new Error(`folder ${targetDir} exists, but is not a git repository`)
    }
    return targetDir
}

async function getServiceConfigs(dir) {
    return await Promise.all(
        (await globFiles(`${dir}/*.k8s.js`))
            .map(async f => [path.basename(f, '.k8s.js'), loadServiceConfig(await fs.readFile(f, 'utf8'))]),
    )
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
    return `${host || config.gitlab}${port ? ':' + port : ''}`
}

async function addPorts(service, imagePath, tag = 'latest', gitlabRegistry = false) {
    try {
        const imageConfig = await getImageConfig(imagePath, tag, ...(gitlabRegistry ? [getRegistryUrl(), config.gitlab, config.user, config.gitlabToken] : []))
        const ports = getExposedPorts(imageConfig)
        if (ports && ports.length) {
            service.ports = ports
        }
    } catch (e) {
        // ignore here, image may not have been built yet
    }
    return service
}
