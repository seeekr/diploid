const {safeEval} = require('./lib')
const esprima = require('esprima')
const estraverse = require('estraverse')
const escodegen = require('escodegen')

function loadServiceConfig(js) {
    let ast = esprima.parse(js)
    ast = estraverse.replace(ast, {
        enter(node) {
            if (node.type === 'MemberExpression') {
                const newNode = esprima.parse(`_ = {__pathExpr__: '${escodegen.generate(node)}'}`)
                return newNode.body[0].expression.right
            }
        },
    })
    return safeEval(ast, {
        from(o) {
            return o
        },
    })
}

module.exports = {
    loadServiceConfig,
}
