'use strict'

const fs = require('fs'),
      crypto = require('crypto'),
      CronJob = require('cron').CronJob

const encode_token_md5 = (account, password, nonce) => {
    let md5 = crypto.createHash('md5')
    md5.update(account.concat(':', password, '@', nonce))
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

const path_resolve = (...args) => {
    return args.reduce((previous, current) => {
        var s = previous
        s += '/'
        s += current
        return s
    })
}

const getFiles = async (dir) => {
  let dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  let files = await Promise.all(dirents.map((dirent) => {
    let res = path_resolve(dir, dirent.name)
    return dirent.isDirectory() ? getFiles(res) : res
  }))
  return Array.prototype.concat(...files)
}

const fileExpire = async (file, ttl) => {
    let stats = await fs.promises.stat(file),
        timeInterval =  Math.ceil((Date.now() - stats.mtimeMs) / 1000)
    // console.log(file, timeInterval, timeInterval >= ttl)
    return timeInterval >= ttl
}

module.exports = (redis, s3) => {
    return {
        path_resolve: path_resolve,
        
        parse_url_ext: (args, ...allowExts) => {
            let dir = /^\/(\w+\/)/.exec(args.pathname) || []

            args['dir'] = dir.length === 0 ? '/' : dir[1]
            allowExts.forEach(ext => {
                if(args.pathname.endsWith(ext)) {
                    return args['ext'] = ext
                }
            })
            return args
        },

        parse_url_param: (param) => {
            let args = {query:{u:'', t:''}}, match = /^\?u=(\w+)&t=(\w+)$/.exec(param)
            if (match) {
                args.query.u = match[1]
                args.query.t = match[2]
            }
            return args
        },
        
        fileExists:  async (file, isDirectory) => {
            try {
                await fs.promises.access(file)
            } catch (err) {
                if (err.code === 'ENOENT') { 
                    if (typeof isDirectory === 'boolean' && isDirectory) {
                        fs.mkdirSync(file)
                    } 
                    return false 
                }
                console.log(err)
            }
            return true
        },
        
        fileReadStream: (file) => fs.createReadStream(file),

        fileWriteStream: (file) => fs.createWriteStream(file),

        fileAutoCleaner: (ttl) => {
            if (typeof ttl === 'number' && ttl > 0) {
                new CronJob('0/10 * * * * *', async () => {
                    let allFiles = await getFiles(path_resolve(__dirname, '..','public'))
                    allFiles.forEach(file => (async() => {
                        let expire = await fileExpire(file, ttl)
                        if (expire)  { fs.unlinkSync(file) }
                    })())
                }, null, true, 'Asia/Shanghai')
            }
        },

        s3AutoCleaner: (ttl) => {
            if (typeof ttl === 'number' && ttl > 0) {
                new CronJob('0/10 * * * * *', async () => {
                    await s3.removeObjects(ttl)
                }, null, true, 'Asia/Shanghai')
            }
        },

        auth_user: async (req, res, next) => {
            let [user, password] = parse_header_authorization(req)
            
            if(user && password) {
                let _password
                try {
                    _password = await redis.get_user_password(user)
                } catch (e) {
                    return next(customError(500, e.message))
                }
                if (_password === password) { return next() }
            }

            send_header_unauthorized(res)
        },

        auth_admin: async (req, res, next) => {
            let [user, password] = parse_header_authorization(req)
            if (user === 'admin' && password) {
                let _password
                try {
                    _password = await redis.get_user_password('admin')
                } catch (e) {
                    return next(customError(500, e.message))
                }
                if (_password === password) { return next() }
            }

            send_header_unauthorized(res)
        },

        auth_token: async (entry) => {
            let info, result = {status: 200, msg: {code: 0}}
            try {
                info = await redis.get_user_info(entry)
            } catch (e) {
                result.status = 500
                result.msg = {err: e.message}
                return result
            }

            if (!info.stream.exists) {
                result.status = 403
                result.msg = {err: 'stream_not_exists'}
                return result
            }

            if (info.stream['secret/enabled'] === 1) {
                if (!info.user.exists) {
                    result.status = 403
                    result.msg = {err: 'user_not_exists'}
                    return result
                }

                if (!info.user.subscribed) {
                    result.status = 403
                    result.msg = {err: 'user_unsubscribe'}
                    return result
                }

                let nonce = (entry.token.length > 32) ? entry.token.substring(32) : null
                if (!nonce || encode_token_md5(info.user.account, info.user.password, nonce) != entry.token) {
                    result.status = 401
                    result.msg = {err: 'user_auth_fail'}
                }

            }

            return result
        },

        user_token: (req, res, next) => {
            let [login, password] = parse_header_authorization(req), obj = {user: login}
            obj['nonce'] = crypto.randomBytes(5).toString('hex')
            obj['token'] = encode_token_md5(login, password, obj.nonce)
            obj['param'] = '?u='; obj['param'] += login; obj['param'] += '&t='; obj['param'] += obj.token
            
            res.set('Content-Type', 'application/json')
            res.send(obj)
        },
    }
}
