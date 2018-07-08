const {sh} = require('../../lib/lib')
const request = require('request-promise')
const cp = require('child_process')

module.exports = {
    command: 'deploy <service>',
    build(yargs) {
        yargs
            .option('env', {
                alias: 'e',
            })
    },
    async handler(args) {
        const env = args.e || args.env // XXX issue in yargs? one doesn't propagate to the other; works outside of commands
        console.log(`deploying ${args.service} to ${env}...`)
        let baseUrl
        let proc
        if (!args.dev) {
            proc = cp.spawn('kubectl', `port-forward -n diploid diploid :80`.split(' '))
            const port = await new Promise(resolve => {
                proc.stdout.on('data', data => {
                    const m = data.match(/127\.0\.0\.1:(\d+)/)
                    if (m) resolve(m[1])
                })
            })
            baseUrl = `http://localhost:${port}`
        } else {
            baseUrl = 'http://localhost:3000'
        }
        try {
            await request.post(`${baseUrl}/deploy/${args.service}/${env}`)
            console.log(`OK`)
        } catch (e) {
            console.error(`error: ${e.message}`)
        } finally {
            if (proc) {
                proc.kill()
            }
        }
    },
}
