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

const HOOKS_URL = 'https://gitlabhookstest.eu.ngrok.io/gitlab/hook'
const HOOKS_TOKEN = 'GXqAJyrd0YSqJxJ6gBgx6hnuwaK8AZGO'

async function main() {
    const model = JSON.parse(await fs.readFile('model.json', 'utf8'))

    // hook for
    // - ops project
    // - all services that were matched to a repo
    for (const repo of [model.repo, ..._.map(model.services, 'repo').filter(it => it)]) {
        const hooks = await gl.ProjectHooks.all(repo.id)
        if (!hooks.some(h => h.url === HOOKS_URL)) {
            await gl.ProjectHooks.add(repo.id, HOOKS_URL, {
                push_events: true,
                token: HOOKS_TOKEN,
                enable_ssl_verification: true,
            })
            console.log(`hook created for ${repo.fullPath}`)
        }
    }
}

main()
    .then(() => console.log('done'))
    .catch(e => console.error(`failed: ${e.message || e}`, e))
