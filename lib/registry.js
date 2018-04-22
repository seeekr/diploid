const request = require('request-promise')
// request.debug = true
const _ = require('lodash')

async function getImageConfig(imagePath, tag, GITLAB_DOMAIN, REGISTRY_URL, GITLAB_USER, GITLAB_TOKEN) {
    const tokenUrl = `https://${GITLAB_DOMAIN}/jwt/auth?client_id=docker&scope=repository:${imagePath}:pull&service=container_registry`
    const {token} = await request(tokenUrl, {
        auth: {
            user: GITLAB_USER,
            password: GITLAB_TOKEN,
        },
        json: true,
    })
    const registryImageUrl = `https://${REGISTRY_URL}/v2/${imagePath}`
    const requestConfig = {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.docker.distribution.manifest.v2+json',
        },
        json: true,
    }
    const manifest = await request(`${registryImageUrl}/manifests/${tag}`, requestConfig)
    return await request(`${registryImageUrl}/blobs/${manifest.config.digest}`, requestConfig)
}

function getExposedPorts(imageConfig) {
    const ports = []
    for (const [k, v] of Object.entries(imageConfig.container_config.ExposedPorts)) {
        if (!_.empty(v)) {
            throw new Error(`value of exposed port is not empty, no code paths to deal with this: key=${k} value=${JSON.stringify(v)}`)
        }
        const [port, type] = k.split('/')
        if (type !== 'tcp') {
            throw new Error(`unsupported port type ${type}`)
        }
        ports.push(+port)
    }
    return ports
}

module.exports = {
    getImageConfig,
    getExposedPorts,
}
