const ENV_CONF_NAME = '.diploid.conf.js'
const {sh} = require('./lib')
const fs = require('fs-extra')

const DEV = process.env.ENV === 'dev'
const FOLLOW_SYMLINKS = DEV ? '-L' : ''

async function findConfigFiles(opsDir) {
    const files = (await sh(`find ${FOLLOW_SYMLINKS} ${opsDir} -name ${ENV_CONF_NAME}`))
        .split('\n')
    if (!DEV && await fs.pathExists(`.git`)) {
        const inGit = (await sh(`git ls-files`)).trim().split('\n')
        return files.filter(f => inGit.includes(f))
    }
    return files
}

module.exports = {
    findConfigFiles,
}
