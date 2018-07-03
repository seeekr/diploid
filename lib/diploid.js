const ENV_CONF_NAME = '.diploid.conf.js'
const {sh} = require('./lib')

async function findConfigFiles(opsDir) {
    return (await Promise.all(
        (await sh(`find ${opsDir} -name ${ENV_CONF_NAME}`))
            .split('\n')
            .filter(it => it)
            .map(it => sh(`git ls-files ${it}`)),
    )).filter(it => it)
}

module.exports = {
    findConfigFiles,
}
