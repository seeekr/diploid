const {sh, safeEval} = require('../../lib/lib')
const {findConfigFiles} = require('../../lib/diploid')
const os = require('os')
const fs = require('fs-extra')
const hbs = require('handlebars')
const _ = require('lodash')

const git = require('simple-git/promise')('.')

module.exports = {
    command: 'init',
    async handler() {
        if (!await fs.exists('.git')) {
            console.error(`needs to be called from a git repository`)
            process.exit(1)
        }

        if ((await git.status()).current !== 'master') {
            console.error(`only supported branch of ops repo is 'master'; please switch to 'master' first before trying again`)
            process.exit(1)
        }

        const configFiles = await findConfigFiles('.')
        if (!configFiles.length) {
            console.error(`did not find any diploid configuration files in current directory and below`)
            process.exit(1)
        }
        if (configFiles.length > 1) {
            console.error(`only a single diploid configuration file is currently allowed, found ${configFiles.length}: ${configFiles.join(', ')}`)
            process.exit(1)
        }

        try {
            await sh(`kubectl get ns diploid`)
        } catch (e) {
            await sh(`kubectl create ns diploid`)
        }

        const [_url, gitlab, opsRepo] = /^([^/]+)(.+)$/.exec(
            (await sh(`git config remote.origin.url`))
                .replace(/^git@([^:]+):(.+)$/, '$1/$2')
                .replace(/^https?:\/\//, ''),
        )
        const config = {...safeEval(await fs.readFile(configFiles[0], 'utf8')), gitlab, opsRepo}

        const stateFile = `${os.tmpdir()}/diploid-cm.json`
        await fs.writeFile(stateFile, JSON.stringify({
            kind: 'ConfigMap',
            apiVersion: 'v1',
            metadata: {
                name: 'diploid-config',
                namespace: 'diploid',
                labels: {app: 'diploid'},
            },
            data: {'config.json': JSON.stringify(_.pick(config, 'gitlab', 'opsRepo', 'user', 'gitlabToken'))},
        }), 'utf8')

        await sh(`kubectl apply -f ${stateFile}`)

        // only deploy diploid if necessary, leave making upgrades to 'upgrade' command
        try {
            await sh(`kubectl get deploy -n diploid diploid`)
            console.log('diploid was already deployed')
        } catch (e) {
            const yaml = hbs.compile(await fs.readFile(`${__dirname}/../../diploid.yaml`, 'utf8'))({domain: config.domain.split(' ')[0]})
            const file = `${os.tmpdir()}/diploid.yaml`
            await fs.writeFile(file, yaml, 'utf8')
            await sh(`kubectl apply -f ${file}`)
            console.log('deployed diploid server to cluster')
        }

        // after this command finished successfully:
        // - all gitlab hooks set, routes ready to get called and perform builds & deployments
        // - all configuration read & cached
    },
}
