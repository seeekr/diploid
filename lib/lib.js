const {exec} = require('child-process-promise')

async function sh() {
    return (await exec.call(this, ...arguments, {encoding: 'utf8'}) || '').stdout.trim()
}

function interpolate(s, env) {
    const m = s.match(/\$\w+/g)
    if (!m) {
        return s
    }
    for (const substr of m) {
        const name = substr.substr(1)
        if (name in env) {
            s = s.replace(new RegExp('\\' + substr, 'g'), String(env[name]))
        }
    }
    return s
}

function normalizeLogger(logger) {
    if (process.env.NODE_ENV === 'dev') {
        return logger
    }
    return Object.assign(logger, {
        _emit(rec, noemit) {
            if (rec.msg) {
                rec['message'] = rec.msg
                delete rec.msg
            }
            require('bunyan').prototype._emit.call(logger, rec, noemit)
        },
    })
}

module.exports = {
    sh,
    interpolate,
    normalizeLogger,
}
