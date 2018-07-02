const ENV_CONF_NAME = '.diploid.conf.js'
const {sh} = require('./lib')

async function findConfigFiles(opsDir) {
    return (await sh(`find -L ${opsDir} -name ${ENV_CONF_NAME}`)).split(/\s+/).filter(it => it)
}

module.exports = {
    findConfigFiles,
}
