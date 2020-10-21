'use strict'

const redispool = require('./lib/redispool')(),
      s3client = require('./lib/s3client')(),
      app = require('express')()

const {
    path_resolve,
    parse_url_param,
    auth_token,
    s3AutoCleaner,
} = require('./lib/helper')(redispool, s3client)

const customError = (status, message) => {
    let err = new Error(message)
    err.status = status
    err.stack = null
    return err
}

app.post('/auth', (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', async (body) => {
        try {
            let data = JSON.parse(body),
                // publish(or play)/__defaultVhost__/live/sample
                args = parse_url_param(data.param),
                key = path_resolve(data.action.substring(3), data.vhost, data.app, data.stream),
                result = await auth_token({
                    key: key,
                    user: args.query.u,
                    token: args.query.t
                })

            if (result.status === 200) {
                if (data.action === 'on_publish') {
                    await redispool.cluster_origin(key, {
                        query: {
                            ip: data.ip,
                            vhost: data.vhost,
                            app: data.app,
                            stream: data.stream
                        },
                        origin: {
                            node: process.env.HOSTNAME,
                            ip: process.env.POD_IP, 
                            port: 1935,
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

app.post('/storage', (req, res, next) => {
    res.set('Content-Type', 'application/json')
    req.on('data', async (body) => {
        try {
            let data = JSON.parse(body)

            await s3client.fPutObject(data.url, path_resolve('./public', data.url))
            await s3client.fPutObject(data.m3u8_url, path_resolve('./public', data.m3u8_url))
            
            res.send({code: 0})
        } catch(e) {
            next(customError(500, e.message))
        }
    })
})

app.post('/api/v1/clusters', async (req, res, next) => {
    res.set('Content-Type', 'application/json')
    try {
        let key = path_resolve('publish', req.query.vhost, req.query.app, req.query.stream),
            result = await redispool.cluster_origin(key)

        res.send({code: 0, data: result})
    } catch (e) {
        next(customError(500, e.message))
    }
})

s3AutoCleaner(Number(process.env.AUTO_REMOVE_TTL_SECONDS || 180))

var server = app.listen(3000)
console.log('HTTP listening on 3000')

redispool.safe_exit(server)
