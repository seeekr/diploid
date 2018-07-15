const fs = require('fs-extra')
const _ = require('lodash')

async function getPackageJson(dir, prop) {
    const packageJson = JSON.parse(await fs.readFile(`${dir}/package.json`, 'utf8'))
    return _.get(packageJson, prop)
}

class Nodejs {
    static async applicable(dir) {
        return fs.pathExists(`${dir}/package.json`)
    }

    static async preBuild(dir) {
        const lock = await fs.pathExists(`${dir}/package-lock.json`)
        return [
            `ADD package.json ${lock ? 'package-lock.json' : ''} ./`,
            `npm ${lock ? 'ci' : 'install'} -q`,
        ]
    }

    static async build(dir) {
        const cmds = []
        const buildCmd = await getPackageJson(dir, 'scripts.build')
        if (buildCmd) {
            cmds.push(`npm run build`)
        }
        return cmds
    }
}

Nodejs.baseImage = 'node'

class Gulp {
    static async applicable(dir) {
        return await fs.pathExists(`${dir}/gulpfile.js`)
    }

    static async build(dir) {
        const cmds = []
        if (!await getPackageJson(dir, 'scripts.build')) {
            cmds.push('npx gulp')
        }
        return cmds
    }
}

Gulp.depends = [Nodejs]

class Bower {
    static async applicable(dir) {
        return fs.pathExists(`${dir}/bower.json`)
    }

    static async build() {
        return ['npx bower install --allow-root -q']
    }
}

// we're depending on Nodejs here for the base image
// that contains npm, the tool we actually need
Bower.depends = [Nodejs]

module.exports = {
    Nodejs, Gulp, Bower,
}
