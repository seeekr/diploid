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

const path = require('path')

async function main() {
    const model = JSON.parse(await fs.readFile('model.json', 'utf8'))
    const {domain} = model.conf

    for (const {name, conf, deployments} of model.services) {
        if (!deployments) continue
        for (const {repo, branch, env, commit, glob, prod, ports: _ports} of deployments) {
            if (!repo) continue
            const imagePath = `${repo}/${branch}`
            const tag = commit.short
            const image = `${REGISTRY_URL}/${imagePath}:${tag}`

            // const ports = _ports || getExposedPorts(await getImageConfig(imagePath, tag, GITLAB_DOMAIN, REGISTRY_URL, GITLAB_USER, GITLAB_TOKEN))
            const ports = _ports || [80]

            const kind = conf.stateful ? 'StatefulSet' : 'Deployment'
            const labels = {app: name}
            const namespace = env
            let [baseDomain, ...domainAttrs] = domain.split(/\s+/)
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
                                        volumeMounts,
                                    },
                                ],
                                volumes,
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
            await fs.writeFile(`sources/${OPS_PROJECT}/${path.dirname(model.file)}/${name}${prod ? '' : '-' + env}.yaml`, out, 'utf8')
        }
    }
}

main()
    .then(() => console.log('done'))
    .catch(e => console.error(`failed: ${e.message || e}`, e))
