'use strict'

const redispool = require('./lib/redispool')(),
      s3client = require('./lib/s3client')(),
      app = require('express')()

const {
    path_resolve,
    parse_url_ext,
    auth_user,
    auth_admin,
    auth_token,
    user_token,
    fileExists,
    fileReadStream,
    fileWriteStream,
    fileAutoCleaner,
} = require('./lib/helper')(redispool)

const customError = (status, message) => {
    let err = new Error(message)
    err.status = status
    err.stack = null
    return err
}

app.param('cmd', (req, res, next) => {
    if (req.params.cmd === 'query' || req.params.cmd === 'add' || req.params.cmd === 'update' || req.params.cmd === 'delete'){
        return next()
    }
    next(customError(403, 'only allow query/add/update/delete'))
})

app.use('/', async (req, res, next) => {
    let args = parse_url_ext(req._parsedUrl, '.m3u8', '.ts')
    
    if (!args.ext) {
        next()
    } else {
        let key = path_resolve('play', '__defaultVhost__', /^\/(\w+\/\w+)/.exec(args.pathname)[1]),
            result = await auth_token({
                key: key,
                user: (req.query.u || '').trim(),
                token: (req.query.t || '').trim()
            })

        if (result.status === 200) {
            res.set('Content-Type', 'application/vnd.apple.mpegurl')

            try {
                if (args.ext === '.m3u8') {
                    let data = '', 
                        ts_suffix = args.search ? `.ts${args.search}` : '.ts',
                        stream = await s3client.getObject(args.pathname)
                    
                    stream.on('data', (chunk) => { 
                        data += String(chunk).replace(/.ts/g, ts_suffix) 
                    }).on('end', () => { 
                        res.send(data)
                    }).on('error', (err) => { 
                         throw err 
                    })

                } else if (args.ext === '.ts') {
                    let ts_path = path_resolve(__dirname, 'public', args.dir),
                        ts_file = path_resolve(__dirname, 'public', args.pathname.substring(1))

                    await fileExists(ts_path, true)
                    
                    let exists = await fileExists(ts_file)
                    if (exists) {
                        res.set('edge-cache', 'HIT')
                        fileReadStream(ts_file).pipe(res)
                    } else {
                        res.set('edge-cache', 'MISS')
                        let stream = await s3client.getObject(args.pathname)
                        stream.pipe(res)
                        stream.pipe(fileWriteStream(ts_file))
                    }
                }
            } catch (err) {
                next(customError(500, err.message))
            }
        } else {
            if (result.status === 401) { 
                res.set('WWW-Authenticate', 'Basic realm=Authorization Required') 
            }
            res.status(result.status).send(result.msg)
        }

    }
})

app.get('/user/token', auth_user, user_token)

app.post('/user/:account/:cmd', auth_admin, (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', async (body) => {
        try {
            let data = JSON.parse(body), obj = {cmd: req.params.cmd, account: req.params.account}

            if (obj.cmd === 'add' || obj.cmd === 'update') {
                let password = data.password || Math.random().toString(36).substr(2)
                obj['password'] = password
                await redispool.add_user(obj.account, obj.password)
            } else if (obj.cmd === 'delete') {
                await redispool.del_user(obj.account)
            } else if (obj.cmd === 'query') {
                if(!data.users || data.users === undefined) {
                    throw 'users not define'
                }
                obj['account'] = undefined
                obj['data'] = await redispool.query_users(data.users)
            }

            res.send(obj)
        } catch (e) {
            next(customError(500, e.message)) 
        }
    })
})

app.post('/stream/:vhost/:app/:stream', auth_admin, (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', async (body) => {
        try {
            let data = JSON.parse(body), cmd = data.cmd || 'subscribe', mode = data.type || 'publish'

            if ((cmd === "subscribe" || cmd === "unsubscribe" || cmd === 'query') && (!data.users || data.users === undefined)) {
                throw 'users not define'
            } else if (cmd === "secret" && (!data.enabled || data.enabled === undefined)) {
                throw 'enabled not define'
            }

            let obj = {cmd: cmd, stream: path_resolve(mode, req.params.vhost, req.params.app, req.params.stream), data: data}

            if (cmd === 'subscribe') {
                await redispool.subscribe_stream(obj.stream, data.users)
            } else if (cmd === 'unsubscribe') {
                await redispool.unsubscribe_stream(obj.stream, data.users)
            } else if (cmd === 'query'){
                obj['data'] = await redispool.query_stream(obj.stream, data.users)
            } else if (cmd === 'secret'){
                await redispool.stream_secret(obj.stream, data.enabled === 'true' ? 1 : 0)
            }

            res.send(obj)
        } catch (e) {
            next(customError(500, e.message))
        }
    })
})

fileAutoCleaner(Number(process.env.AUTO_REMOVE_TTL_SECONDS || 180))

var server = app.listen(3000)
console.log('HTTP listening on 3000')

redispool.safe_exit(server)
