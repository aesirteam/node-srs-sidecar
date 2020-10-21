'use strict'

const { RedisPool } = require('ioredis-conn-pool')

const pool_ro = new RedisPool({
  redis: {
    sentinels: [{ host: (process.env.redis_sentinel_host || '127.0.0.1'), port: (process.env.redis_sentinel_port || '26379')}],
    name: (process.env.redis_name || 'mymaster'),
    password: (process.env.redis_pass || ''),
    db: (process.env.redis_database || '0'),
    role: 'slave',
  },
  pool: {
    min: (process.env.redis_pool_min || '3'),
    max: (process.env.redis_pool_max || '10')
  }
})

const pool_rw = new RedisPool({
  redis: {
    sentinels: [{ host: (process.env.redis_sentinel_host || '127.0.0.1'), port: (process.env.redis_sentinel_port || '26379')}],
    name: (process.env.redis_name || 'mymaster'),
    password: (process.env.redis_pass || ''),
    db: (process.env.redis_database || '0'),
  },
  pool: {
    min: (process.env.redis_pool_min || '3'),
    max: (process.env.redis_pool_max || '10')
  }
})

const add_user = async (user, password) => {
  let client
  try {
    client = await pool_rw.getConnection()
    return await client.hset('users', user, password)
  } catch (e) {
    throw e
  } finally {
    if (client) {
      await pool_rw.release(client)
    }
  }
}

module.exports = () => {

  let password = process.env.DEFAULT_ADMIN_PASSWORD || Math.random().toString(36).substr(2)
  add_user('admin', password)

  return {
    get_user_info: async (entry) => {
      let client, obj = { stream: {exists: false}, user: {exists: false}}
      try {
        client = await pool_ro.getConnection()

        let results = await client.pipeline()
          .exists(entry.key)
          .hget('users', entry.user)
          .hget(entry.key, 'secret/enabled')
          .hget(entry.key, entry.user)
          .exec()
        
        obj.stream['key'] = entry.key
        obj.stream.exists = results[0][1] === 1
        if (obj.stream.exists) {
          obj.stream['secret/enabled'] = Number(results[2][1])
        }
        
        obj.user['account'] = entry.user
        obj.user.exists = results[1][1] != null
        if (obj.user.exists) {
          obj.user['password'] = results[1][1]
          obj.user['subscribed'] = results[3][1] === '1' 
        }

        return obj
      } 
      catch (e) { throw e }
      finally { if (client) { await pool_ro.release(client) } }
    },

    get_user_password: async (user) => {
      let client
      try {
        client = await pool_ro.getConnection()
        return await client.hget('users', user)
      }
      catch (e) { throw e }
      finally { if (client) { await pool_ro.release(client) } }
    },

    add_user: add_user,

    del_user: async (user) => {
      let client
      try {
        client = await pool_rw.getConnection()
        // unsubscribe streams by user
        client.scanStream({match: 'p[ul][ba][ly]*/*', count: Number.MAX_SAFE_INTEGER}).on('data', (keys) => {
          if (keys.length) {
            let pipeline = client.pipeline()
            keys.forEach(key => { pipeline.hdel(key, user) })
            pipeline.hdel('users', user).exec()
          }
        })
      }
      catch (e) { throw e }
      finally { if (client) { await pool_rw.release(client) } }
    },

    query_users: async (users) => {
      let client
      try {
        client = await pool_ro.getConnection()

        if (typeof users === 'string' && users === 'all') {
          return await client.hgetall('users')
        } else if (typeof users === 'object' && users.length) {
          let pipeline = client.pipeline(), obj = {}, i = 0
          users.forEach(user => { pipeline.hget('users', user) })
          let vals = await pipeline.exec()
          users.forEach(user => { obj[user] = vals[i++][1] })
          return obj
        }
      }
      catch (e) { throw e }
      finally { if (client) { await pool_ro.release(client) } }
    },

    subscribe_stream: async (stream, users) => {
      let client
      try {
        client = await pool_rw.getConnection()
        let pipeline = client.pipeline()

        if (!await this.stream_secret(stream)) {
          pipeline.hset(stream, 'secret/enabled', 1)
        }

        if (typeof users === 'string' && users === 'all') {
          Object.keys(await client.hgetall('users')).forEach(user => { pipeline.hset(stream, user, 1) })
        } else if (typeof users === 'object' && users.length) {
          users.forEach(user => { pipeline.hset(stream, user, 1) })
        }
        pipeline.exec()
      }
      catch (e) { throw e }
      finally { if (client) { await pool_rw.release(client) } }
    },

    unsubscribe_stream: async (stream, users) => {
      let client
      try {
        client = await pool_rw.getConnection()
        let pipeline = client.pipeline()

        if (typeof users === 'string' && users === 'all') {
          Object.keys(await client.hgetall(stream)).forEach(user => {
            if (user != 'admin' && user != 'secret/enabled') {
              pipeline.hdel(stream, user) 
            }
          })
        } else if (typeof users === 'object' && users.length) {
          users.forEach(user => {
            if (user != 'admin' && user != 'secret/enabled') {
              pipeline.hdel(stream, user) 
            }
          })
        }
        pipeline.exec()
      }
      catch (e) { throw e }
      finally { if (client) { await pool_rw.release(client) } }
    },

    query_stream: async (stream, users) => {
      let client
      try {
        client = await pool_ro.getConnection()
      
        if (typeof users === 'string' && users === 'all') {
          return await client.hgetall(stream)
        } else if (typeof users === 'object' && users.length) {
          let pipeline = client.pipeline(), obj = {}, i = 0
          users.forEach(user => { pipeline.hget(stream, user) })
          let vals = await pipeline.exec()
          users.forEach(user => { obj[user] = vals[i++][1] })
          return obj
        }
      }
      catch (e) { throw e }
      finally { if (client) { await pool_ro.release(client) } }
    },

    stream_secret: async (stream, enabled) => {
      let client
      try {
        client = await pool_rw.getConnection()
        if (enabled === undefined) {
          return await client.hget(stream, 'secret/enabled')
        } else {
          return await client.hset(stream, 'secret/enabled', enabled)
        }
      }
      catch (e) { throw e }
      finally { if (client) { await pool_rw.release(client) } }
    },

    cluster_origin: async (stream, origin) => {
      let client
      try {
        client = await pool_rw.getConnection()
        if (origin === undefined) {
          return JSON.parse(await client.hget(stream, 'cluster/origin'))
        } else {
          return await client.hset(stream, 'cluster/origin', JSON.stringify(origin))
        }
      }
      catch (e) { throw e }
      finally { if (client) { await pool_rw.release(client) } }
    },

    safe_exit: (server) => {
      process.on('SIGINT', () => {
        server.close(() => {
          pool_ro.end().then(() => {
            setTimeout(() => pool_rw.end().then(() => {
              setTimeout(() => process.exit(), 500)
            }), 500)
          }).catch(e => e)
        })
      })
    },
    
  }
}
