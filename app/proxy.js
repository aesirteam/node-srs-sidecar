'use strict'

const Axios = require('axios'),
      app = require('express')()

const {
    path_resolve,
    parse_url_ext,
    fileExists,
    fileReadStream,
    fileWriteStream,
    fileAutoCleaner,
} = require('./lib/helper')()

const upstream = {
    baseURL: process.env.UPSTREAM_URL || 'http://live.bigdatagz.com',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
}

app.use('/', async (req, res, next) => {
    let args = parse_url_ext(req._parsedUrl, '.m3u8', '.ts')

    if (!args.ext) {
        next()
    } else if (args.ext === '.m3u8') {
        upstream['responseType'] = 'document'
        Axios.get(req.originalUrl, upstream).then(response => {
            res.send(response.data)
        }).catch(err => {
            res.status(err.response.status).send(err.response.statusText)
        })

    } else if (args.ext === '.ts') {
        let ts_path = path_resolve(__dirname, 'public', args.dir),
            ts_file = path_resolve(__dirname, 'public', args.pathname.substring(1))

        await fileExists(ts_path, true)

        let exists = await fileExists(ts_file)
        if (exists) {
            let m3u8Url = req.originalUrl.replace(/(-\d+\.ts)/, '.m3u8')
            upstream['responseType'] = 'document'
            Axios.head(m3u8Url, upstream).then(response => {
                res.set('edge-cache', 'HIT')
                fileReadStream(ts_file).pipe(res)
            }).catch(err => {
               res.status(err.response.status).send(err.response.statusText)
            })
        } else {
            upstream['responseType'] = 'stream'
            Axios.get(req.originalUrl, upstream).then(response => {
                res.set('edge-cache', 'MISS')
                response.data.pipe(res)
                response.data.pipe(fileWriteStream(ts_file))
            }).catch(err => {
                res.status(err.response.status).send(err.response.statusText)
            })
        }
    }
})

fileAutoCleaner(Number(process.env.AUTO_REMOVE_TTL_SECONDS || 180))

var server = app.listen(3000)
console.log('HTTP listening on 3000')
