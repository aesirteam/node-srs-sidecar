'use strict'

const { RedisPool } = require('ioredis-conn-pool')

let pool_ro = new RedisPool({
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

let pool_rw = new RedisPool({
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

exports.init = () => {
  let password = process.env.DEFAULT_ADMIN_PASSWORD || Math.random().toString(36).substr(2)
  this.add_user('admin', password)
}

exports.safe_exit = () => {
  pool_ro.end().then(() => {
    setTimeout(() => pool_rw.end().then(() => {
      setTimeout(() => process.exit(), 500)
    }), 500)
  }).catch(e => e)
}

exports.get_user_info = async (entry) => {
  let client, result
  try {
    client = await pool_ro.getConnection()
    if (entry.user.length === 0) {
      result = await client.hget(entry.key, 'secret/enabled')
      return {'secret/enabled': result || '999'}
    }
    result = await client.multi()
      .hget('users', entry.user)
      .hget(entry.key, 'secret/enabled')
      .hget(entry.key, entry.user)
      .exec()
    return {user: result[0][1] ? entry.user : null, password: result[0][1], status: result[2][1] || '0', 'secret/enabled': result[1][1] || '999'}
  } catch (e) {
     throw e
  } finally {
    if (client) {
      await pool_ro.release(client)
    }
  }
}

exports.get_user_password = async (user) => {
  let client
  try {
    client = await pool_ro.getConnection()
    return await client.hget('users', user)
  } catch (e) {
    throw e
  } finally {
    if (client) {
      await pool_ro.release(client)
    }
  }
}

exports.add_user = async (user, password) => {
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

exports.del_user = async (user) => {
  let client
  try {
    client = await pool_rw.getConnection()
    // unsubscribe streams by user
    var ss = client.scanStream({match: 'p[ul][ba][ly]*/*', count: Number.MAX_SAFE_INTEGER})
    ss.on('data', (keys) => {
      if (keys.length) {
        var pipeline = client.pipeline()
        keys.forEach(key => { pipeline.hdel(key, user); })
        pipeline.hdel('users', user)
        pipeline.exec()
      }
    })
  } catch (e) {
     throw e
  } finally {
    if (client) {
      await pool_rw.release(client)
    }
  }
}

exports.subscribe = async (stream, users) => {
  let client
  try {
    client = await pool_rw.getConnection()
    var pipeline = client.pipeline()

    if (!this.secret_enabled()) {
      pipeline.hset(stream, 'secret/enabled', 1)
    }

    if (typeof users === 'string' && users === 'all') {
      Object.keys(await client.hgetall('users')).forEach(user => { pipeline.hset(stream, user, 1); })
    } else if (typeof users === 'object' && users.length) {
      users.forEach(user => { pipeline.hset(stream, user, 1); })
    }
    pipeline.exec()
  } catch (e) {
    throw e
  } finally {
    if (client) {
      await pool_rw.release(client)
    }
  }
}

exports.unsubscribe = async (stream, users) => {
  let client
  try {
    client = await pool_rw.getConnection()
    var pipeline = client.pipeline()

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
  } catch (e) {
    throw e
  } finally {
    if (client) {
      await pool_rw.release(client)
    }
  }
}

exports.secret_enabled = async (stream, status) => {
  let client
  try {
    client = await pool_rw.getConnection()
    if (status === undefined) {
      return await client.hget(stream, 'secret/enabled')
    } else {
      return await client.hset(stream, 'secret/enabled', status)
    }
  } catch (e) {
    throw e
  } finally {
    if (client) {
      await pool_rw.release(client)
    }
  }
}

exports.cluster_origin = async (stream, origin) => {
  let client
  try {
    client = await pool_rw.getConnection()
    if (origin === undefined) {
      return JSON.parse(await client.hget(stream, 'cluster/origin'))
    } else {
      return await client.hset(stream, 'cluster/origin', JSON.stringify(origin))
    }
  } catch (e) {
     throw e
  } finally {
    if (client) {
      await pool_rw.release(client)
    }
  }
}
