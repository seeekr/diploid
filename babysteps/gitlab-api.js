const fs = require('fs-extra')
const Gitlab = require('node-gitlab-api/dist/es5').default
const {sh, interpolate, normalizeLogger} = require('../lib/lib')
const {getImageConfig, getExposedPorts} = require('../lib/registry')
const globFiles = require('glob-promise')
const glob = require('micromatch')
const _ = require('lodash')
const moment = require('moment')
const YAML = require('js-yaml')
const bunyan = require('bunyan')
const log = normalizeLogger(bunyan.createLogger({
    name: 'renderApp',
    stream: process.stdout,
    level: 'trace',
    serializers: bunyan.stdSerializers,
}))

const glConf = JSON.parse(fs.readFileSync('config/env.json', 'utf8'))
const GITLAB_DOMAIN = glConf.domain
const GITLAB_USER = glConf.user
const GITLAB_TOKEN = glConf.token
const OPS_PROJECT = glConf.masterRepo

const gl = new Gitlab({
    url: `https://${GITLAB_DOMAIN}`,
    token: GITLAB_TOKEN,
})
const REGISTRY = function () {
    if (GITLAB_DOMAIN === 'gitlab.com') {
        return 'registry.gitlab.com'
    } else {
        return GITLAB_DOMAIN
    }
}()

const ENV_CONF_NAME = `.diploid.conf.js`
const SOURCE_DIR = 'sources'

async function main() {

    // on daemon start:
    // go through all configured gitlab/master repo entries
    // add hook to master repo if not present
    // build up the models if not already in the db
    // add hooks to all relevant repos if not present

    await fs.mkdirp(SOURCE_DIR)
    const opsDir = await gitClone(OPS_PROJECT)

    const groupFiles = (await sh(`find -L ${opsDir} -name ${ENV_CONF_NAME}`)).split(/\s+/).filter(it => it)
    if (groupFiles.length !== 1) {
        throw new Error(`expected to find exactly one '${ENV_CONF_NAME}' file in project ${OPS_PROJECT}, found ${groupFiles.length}`)
    }

    const groupFile = groupFiles[0]
    const groupConf = _.merge({
        services: {defaults: {}},
    }, safeEval(await fs.readFile(groupFile, 'utf8')))
    const groupEnvConfigs = _.omit(groupConf, ['domain', 'services'])
    const repos = _.keyBy(await loadRepos(), 'path')

    const services = await Promise.all(
        (await getServiceConfigs(path.dirname(groupFile))).map(async ([basename, serviceConf]) => {
            const name = serviceConf.repo || basename
            const conf = _.merge(
                {},
                _.omit(groupConf, ['domain', 'services']),
                groupConf.services.defaults || {},
                groupConf.services[name] || {},
                serviceConf,
            )
            const envConfigs = _.merge({}, groupEnvConfigs, _.omit(conf, ['domain', 'services']))

            const service = {name, conf}

            const repo = repos[name]
            if (repo) {
                // if no hook set yet (determine from db): add a hook for commits to this repo --> for building, updating model, taking action if necessary (e.g. changed ports)
                console.log(repo.path)
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

                            let ports = null
                            try {
                                const imageConfig = await getImageConfig(imagePath, tag, GITLAB_DOMAIN, 4567, GITLAB_USER, GITLAB_TOKEN)
                                ports = getExposedPorts(imageConfig)
                            } catch (e) {
                                // ignore here, image may not have been built yet
                            }

                            return Object.assign({
                                repo: repo.fullPath,
                                branch: branch.name,
                                env,
                                commit: branch.lastCommit,
                                glob: isGlob,
                            }, ports ? {ports} : {})
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
            }

            return service
        }),
    )

    const group = {
        name: path.basename(path.dirname(groupFile)),
        file: groupFile.split(opsDir + '/')[1],
        conf: groupConf,
        services,
    }

    const out = JSON.stringify(group, null, 4)
    // console.log(out)
    await fs.writeFile('model.json', out, 'utf8')

    // read all relevant files in the path:
    // - environments config
    // - list of projects/services
    // - map those to source repositories
    // - check out those source repos
    // - read the k8s.js files

    // match which projects are of interest to us
}

async function gitClone(path) {
    const targetDir = `${SOURCE_DIR}/${path}`
    if (!await fs.exists(targetDir)) {
        await sh(`git clone 'https://${GITLAB_USER}:${GITLAB_TOKEN}@${GITLAB_DOMAIN}/${path}' ${targetDir}`)
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

async function generateDeployment() {
    const kind = conf.stateful ? 'StatefulSet' : 'Deployment'
    const labels = {app: name}
    const namespace = env
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
                template: {
                    metadata: {labels},
                    spec: {
                        containers: [
                            {
                                name,
                                image,
                                ports: ports.map(port => ({containerPort: port})),
                            },
                        ],
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
        let [baseDomain, ...attrs] = conf.domain.split(/\s+/)
        attrs = _.fromPairs(attrs.join(',').split(/[, ]+/).map(it => it.split('=')))
        if (attrs.mapEnv) {
            if (attrs.mapEnv !== 'subdomain') {
                throw new Error('todo')
            }
            if (!isProd) {
                baseDomain = `${env}.${baseDomain}`
            }
        }
        let {url} = conf
        if (isGlob) {
            url = `${url}/${branch.name}`
        }
        const URL = require('url').URL
        url = new URL(interpolate(url, {
            name,
            namespace,
            env,
            domain: baseDomain,
        }))
        const domain = url.hostname
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
                    hosts: [domain],
                    secretName: `${domain.replace(/\./g, '-')}-tls`,
                }],
                rules: [{
                    host: domain,
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

    for (const item of items) {
        console.log(YAML.safeDump(item, {noRefs: true, noCompatMode: true, lineWidth: 240}))
        console.log('---\n')
    }
}

const parseJs = require('esprima').parse
const staticEval = require('static-eval')
const path = require('path')

function safeEval(s) {
    if (!s) {
        return null
    }
    const ast = parseJs(s)
    return staticEval(ast.body[0].expression.right)
}

main()
    .then(() => console.log('done'))
    .catch(e => console.error(`failed: ${e.message || e}`, e))
