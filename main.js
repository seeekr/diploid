// set up routes for hooks: probably just POST /gitlab/push
// get from env:
// gitlab personal access token
// which gitlab project url we're supposed to configure ourselves from, plus path

// on push to deployed project: figure out if we need to take action, and which one, execute it
// on push to "ops" project: execute the steps below similar to on first run of this tool


// checkout gitlab "ops" project
// (keep it cached; next time do git fetch && git reset --hard origin(/<branch>?))
// read relevant configuration, validate + normalize
// if config changed: update/reload our own config


// deployment:
// need full kubectl access

const Koa = require('koa')
const app = new Koa()
const Router = require('koa-router')
const router = new Router()

router.post('/gitlab/hook', async ctx => {
    console.log(ctx.request.body)
    ctx.status = 200
})

app
    .use(require('koa-body')())
    .use(router.routes())
    .use(router.allowedMethods())

app.listen(3000)
