const assert = require('assert')
const {loadServiceConfig, processConfigure} = require('../lib/config')
const YAML = require('js-yaml')

describe('config', function () {
    describe('loadServiceConfig', function () {
        it('should turn property access into named path', function () {
            const config = loadServiceConfig(`config = { test: services.svc1 }`)
            assert.equal(config.test.__pathExpr__, 'services.svc1')
        })
    })

    describe('processConfigure', function () {
        it.only('should apply configured changes to the given file', function () {
            const model = {
                services: [
                    {
                        name: 'db',
                        ports: ['3306'],
                        conf: {
                            env: {MYSQL_PW: 'test', MYSQL_DATABASE: 'mydb'},
                            byEnv: {production: {env: {MYSQL_PW: 'prod'}}},
                        },
                    },
                ],
                conf: {},
            }
            const fileInput = {
                parameters: {
                    db_pw: 'default',
                    something_else: 123,
                },
            }
            const configureProps = {
                'parameters.db_*': {__pathExpr__: 'services.db.env'},
                'env=production parameters.prod': true,
                'env=test parameters.test': true,
            }

            // run for env=production, branch=master, prod=true
            {
                const [_f, _content, res] = processConfigure(
                    model,
                    {env: 'production', branch: 'master', prod: true},
                    'config.yaml',
                    configureProps,
                    YAML.safeDump(fileInput))

                assert.deepStrictEqual(res, {
                    'parameters': {
                        'db_pw': 'prod',
                        'something_else': 123,
                        'db_database': 'mydb',
                        'db_host': 'db',
                        'db_port': '3306',
                        'prod': true,
                    },
                })
            }

            // run for env=test, branch=branch1, prod=false
            {
                const [_f, _content, res] = processConfigure(
                    model,
                    {env: 'test', branch: 'branch1', prod: false},
                    'config.yaml',
                    configureProps,
                    YAML.safeDump(fileInput))

                assert.deepStrictEqual(res, {
                    'parameters': {
                        'db_pw': 'test',
                        'something_else': 123,
                        'db_database': 'mydb',
                        'db_host': 'db-branch1',
                        'db_port': '3306',
                        'test': true,
                    },
                })
            }
        })
    })
})
