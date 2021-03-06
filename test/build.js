const assert = require('assert')
const {depSort} = require('../lib/builds')

describe('build', function () {
    describe('builds#depSort()', function () {
        it.only('should sort items according to dependency graph', function () {
            const items = [
                {name: 'a', depends: ['A']},
                {name: 'b', depends: ['B']},
                {name: 'A'},
                {name: 'B'},
            ]
            const actual = depSort(items)
            assert.deepStrictEqual(actual, ['A', 'B', 'b', 'a'])
        })
    })
})
