'use strict'

const express = require('express'),
      basicAuth = require('express-basic-auth'),
      pool = require('./lib/redispool'),
      s3 = require('./lib/s3client'),
      path = require('path'),
      url = require('url'),
      util = require('util'),
      crypto = require('crypto'),
      app = express();

const customError = (status, message) => {
    let err = new Error(message)
    err.status = status
    err.stack = null
    return err
}

const encode_token_md5 = (user, password, nonce) => {
    let md5 = crypto.createHash('md5')
    md5.update(user.concat(':', password, '@', nonce))
    return md5.digest('hex').concat(nonce)
}

const parse_header_authorization = (req) => {
    let b64auth = (req.headers.authorization || '').split(' ')[1] || ''
    return Buffer.from(b64auth, 'base64').toString().split(':')
}

const send_header_unauthorized = (res) => {
    res.set('WWW-Authenticate', 'Basic realm=Authorization Required')
    res.status(401).send('Unauthorized')
}

const verfiy_user_token = async (entry) => {
    let info, result = {status: 200, msg: {code: 0}}
    try {
        info = await pool.get_user_info(entry)
    } catch (e) {
        result.status = 500
        result.msg = {err: e.message}
        return result
    }

    if (info['secret/enabled'] === '1') {
        if (!info.user || !info.password) {
            result.status = 401
            result.msg = {err: 'user_unauthorized'}
        } else if (info.status === '0') {  // status=1: subscribe  status=0: unsubscribe
            result.status = 403
            result.msg = {err: 'user_unsubscribe'}
        } else {
            let nonce = (entry.token.length > 32) ? entry.token.substring(32) : null
            if (!nonce || encode_token_md5(info.user, info.password, nonce) != entry.token) {
                result.status = 401
                result.msg = {err: 'user_token_fail'}
            }
        }
    } else if (info['secret/enabled'] === '999') {
        result.status = 404
        result.msg = {err: 'stream not exists'}
    }

    return result
}

const auth_user = async (req, res, next) => {
    let [user, password] = parse_header_authorization(req)
    
    if(user && password) {
        let _password
        try {
            _password = await pool.get_user_password(user)
        } catch (e) {
            return next(customError(500, e.message))
        }
        if (_password === password) { return next() }
    }

    send_header_unauthorized(res)
}

const auth_admin = async (req, res, next) => {
    let [user, password] = parse_header_authorization(req)
    if (user && password && user === 'admin') {
        await auth_user(req, res, next)
    }

    send_header_unauthorized(res)
}

const auth_token = async (req, res, next) => {
    let path_parse = (_url) => {
        let params = url.parse(_url)
        let args = path.parse(params.pathname)
        args['search'] = params.search
        args['pathname'] = params.pathname.substring(1)
        return args
    }, args = path_parse(req.url), data = ''
    
    if ( args.ext === '.m3u8' || args.ext === '.ts') {
        let result = await verfiy_user_token({
            key: util.format('play/%s%s/%s', '__defaultVhost__', args.dir, /^\w+/.exec(args.name)[0]),
            user: (req.query.u || '').trim(),
            token: (req.query.t || '').trim()
        })

        if (result.status === 200) {
            res.set('Content-Type', 'application/vnd.apple.mpegurl')
            s3.getObject(args.pathname, (err, stream) => {
                if (err) { return res.status(500).send(err.message) }

                if (args.ext === '.ts') { return stream.pipe(res) }
                
                stream.on('data', (chunk) => {
                    let ts_suffix = args.search ? '.ts'.concat(args.search) : '.ts'
                    data += String(chunk).replace(/.ts/g, ts_suffix)
                })

                stream.on('error', (err) => {
                    throw err
                })

                stream.on('end', () => {
                    res.send(data)
                })
            })
        } else if (result.status === 401) {
            send_header_unauthorized(res)
        } else {
            res.status(result.status).send(result.msg)
        }
        return
    }

    next()
}

pool.init()
s3.init()

app.use('/', auth_token, express.static(path.join(__dirname, 'public')))

app.param('mode', (req, res, next) => {
    if (req.params.mode === 'publish' || req.params.mode === 'play') {
        return next()
    }
    next(customError(403, 'only allow publish/play'))
})

app.param('cmd', (req, res, next) => {
    if (req.params.cmd === 'add' || req.params.cmd === 'update' || req.params.cmd === 'delete'){
        return next()
    }
    next(customError(403, 'only allow add/update/del'))
})

app.param('sub', (req, res, next) => {
    if (req.params.sub === 'subscribe' || req.params.sub === 'unsubscribe' || req.params.sub === 'secret'){
        return next()
    }
    next(customError(403, 'only allow subscribe/unsubscribe/secret'))
})

app.post('/auth/:mode', (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', async (body) => {
        try {
            let data = JSON.parse(body),
                // publish(or play)/__defaultVhost__/live/sample
                args = url.parse(data.param || '', true),
                key = util.format('%s/%s/%s/%s', req.params.mode, data.vhost, data.app, data.stream)

            let result = await verfiy_user_token({
                key: key,
                user: (args.query.u || '').trim(),
                token: (args.query.t || '').trim()
            })

            if (result.status === 200 || result.status === 401) {
                if (req.params.mode === 'publish') {
                    await pool.cluster_origin(key, {
                        query: {
                            ip: data.ip,
                            vhost: data.vhost,
                            app: data.app,
                            stream: data.stream
                        },
                        origin: {
                            ip: process.env.POD_IP, 
                            port: Number(process.env.ORIGIN_SVC_SERVICE_PORT || 1935),
                            vhost: data.vhost
                        }
                    })
                }
                res.send({code: 0})    
            } else {
                res.status(result.status).send(result.msg)
            }
        } catch(e) { 
            next(customError(500, e.message)) 
        }
    })
})

app.get('/user/token', auth_user, (req, res, next) => {
    let [login, password] = parse_header_authorization(req), obj = {user: login}
    obj['nonce'] = crypto.randomBytes(5).toString('hex')
    obj['token'] = encode_token_md5(login, password, obj.nonce)
    obj['param'] = util.format('?u=%s&t=%s', login, obj.token)

    res.set('Content-Type', 'application/json')
    res.send(obj)
})

app.post('/user/:account/:cmd', auth_admin, (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', async (body) => {
        try {
            let data = JSON.parse(body), obj = {action: req.params.cmd, account: req.params.account}

            if (obj.action === 'add' || obj.action === 'update') {
                let password = data.password || Math.random().toString(36).substr(2)
                await pool.add_user(obj.account, password)
                obj['password'] = password
            } else if (obj.action === 'delete') {
                await pool.del_user(obj.account)
            }

            res.send(obj)
        } catch (e) {
            next(customError(500, e.message)) 
        }
    })
})

app.post('/:mode/:vhost/:app/:stream/:sub', auth_admin, (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', async (body) => {
        try {
            let data = JSON.parse(body), action = req.params.sub

            if ((action === "subscribe" || action === "unsubscribe") && (!data.users || data.users === undefined)) {
                throw 'users not define'
            } else if (action === "secret" && (!data.enabled || data.enabled === undefined)) {
                throw 'enabled not define'
            }

            let stream = util.format('%s/%s/%s/%s', req.params.mode, req.params.vhost, req.params.app, req.params.stream),
            obj = {action: action, stream: stream, data: data}

            if (action === 'subscribe') {
                await pool.subscribe(stream, data.users)
            } else if (action === 'unsubscribe') {
                await pool.unsubscribe(stream, data.users)
            } else if (action === 'secret'){
                await pool.secret_enabled(stream, data.enabled === 'true' ? 1 : 0)
            }

            res.send(obj)
        } catch (e) {
            next(customError(500, e.message))
        }
    })
})

app.post('/storage', (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', (body) => {
        try {
            let data = JSON.parse(body)

            s3.fPutObject(data.url, util.format('./public/%s', data.url), (err, etag) => {
                if (err) { throw err }
                s3.fPutObject(data.m3u8_url, util.format('./public/%s', data.m3u8_url), (err, etag) => {
                    if (err) { throw err }
                    res.send({code: 0})
                })
            })
        } catch(e) {
            next(customError(500, e.message))
        }
    })
})

app.post('/api/v1/clusters', async (req, res, next) => {
    res.set('Content-Type', 'application/json')
    try {
        let stream = util.format('publish/%s/%s/%s', req.query.vhost, req.query.app, req.query.stream),
            result = await pool.cluster_origin(stream)

        res.send({code: 0, data: result})

    } catch (e) {
        next(customError(500, e.message))
    }
})

var server = app.listen(3000)
console.log('HTTP listening on 3000')

process.on('SIGINT', () => {
    server.close(() => {
        pool.safe_exit()
    })
})
