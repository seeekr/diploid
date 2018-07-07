const assert = require('assert')
const {loadServiceConfig} = require('../lib/config')

describe('main', function () {
    describe('loadServiceConfig', function () {
        it('should turn property access into named path', function () {
            const config = loadServiceConfig(`config = { test: services.svc1 }`)
            assert.equal(config.test.__pathExpr__, 'services.svc1')
        })
    })
})
