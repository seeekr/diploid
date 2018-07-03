const {sh} = require('../../lib/lib')

module.exports = {
    command: 'log',
    async handler() {
        let podName
        try {
            podName = await sh(`kubectl get pod -n diploid -l app=diploid -ojsonpath={.metadata.name}`)
        } catch (e) {
            // ignore
        }

        if (!podName) {
            console.error(`error: no running diploid pod found`)
            process.exit(1)
        }

        const logs = (await sh(`kubectl logs -n diploid ${podName} diploid`)).split('\n').map(it => it.startsWith('[status] ') ? it.substr(9) : '')
        console.log(logs.join(''))
    },
}
