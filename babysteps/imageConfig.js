require('dotenv').config()

const request = require('request-promise')
// request.debug = true

const GITLAB_USER = 'seeekr'
const {GITLAB_TOKEN} = process.env

const GITLAB_DOMAIN = 'gitlab.proudsourcing.de'
const REGISTRY_PORT = 4567

async function main() {
    const imagePath = 'axiomcat/canvas-engine/backend/privacy'
    const tag = 'f6dc7e0'

    const tokenUrl = `https://${GITLAB_DOMAIN}/jwt/auth?client_id=docker&scope=repository:${imagePath}:pull&service=container_registry`
    const {token} = await request(tokenUrl, {
        auth: {
            user: GITLAB_USER,
            password: GITLAB_TOKEN,
        },
        json: true,
    })
    const registryImageUrl = `https://${GITLAB_DOMAIN}:${REGISTRY_PORT}/v2/${imagePath}`
    const requestConfig = {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.docker.distribution.manifest.v2+json',
        },
        json: true,
    }
    const manifest = await request(`${registryImageUrl}/manifests/${tag}`, requestConfig)
    const imageConfig = await request(`${registryImageUrl}/blobs/${manifest.config.digest}`, requestConfig)
    const ports = []
    for (const [k, v] of Object.entries(imageConfig.container_config.ExposedPorts)) {
        const [port, type] = k.split('/')
        if (type !== 'tcp') {
            throw new Error(`unsupported port type ${type}`)
        }
        ports.push(+port)
    }
    console.log(ports)
}

main()
    .then(() => console.log('done'))
    .catch(e => console.error(`failed: ${e.message || e}`))
