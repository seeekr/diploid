const fs = require('fs-extra')
const Gitlab = require('node-gitlab-api/dist/es5').default
const {sh, interpolate, normalizeLogger, splitImage} = require('../lib/lib')
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
const REGISTRY_URL = (function () {
    let {registry} = glConf
    registry = registry.replace(/^https?:\/\//, '')
    const [host, port] = registry.split(':')
    return `${host || GITLAB_DOMAIN}${port ? ':' + port : ''}`
})()
const GITLAB_USER = glConf.user
const GITLAB_TOKEN = glConf.token
const OPS_PROJECT = glConf.masterRepo

const gl = new Gitlab({
    url: `https://${GITLAB_DOMAIN}`,
    token: GITLAB_TOKEN,
})

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

    const services = (await Promise.all(
        (await getServiceConfigs(path.dirname(groupFile))).map(async ([name, serviceConf]) => {
            const conf = _.merge(
                {},
                _.omit(groupConf, ['domain', 'services']),
                groupConf.services.defaults || {},
                groupConf.services[name] || {},
                serviceConf,
            )
            const envConfigs = _.merge({}, groupEnvConfigs, _.omit(conf, ['domain', 'services']))

            const service = {name, conf}

            const repo = repos[serviceConf.repo || name]
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
        repo: Object.values(repos).find(r => r.fullPath === OPS_PROJECT),
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

async function addPorts(service, imagePath, tag = 'latest', gitlabRegistry = false) {
    try {
        const imageConfig = await getImageConfig(imagePath, tag, ...(gitlabRegistry ? [REGISTRY_URL, GITLAB_DOMAIN, GITLAB_USER, GITLAB_TOKEN] : []))
        const ports = getExposedPorts(imageConfig)
        if (ports && ports.length) {
            service.ports = ports
        }
    } catch (e) {
        // ignore here, image may not have been built yet
    }
    return service
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
