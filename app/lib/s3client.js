'use strict';

const Minio = require('minio').Client

const s3Client = new Minio({
    endPoint: process.env.minio_endpoint || 'pan.bigdatagz.com',
    port: Number(process.env.minio_port || 80),
    useSSL: (process.env.minio_use_ssl === 'true'),
    accessKey: process.env.minio_accessKey || '',
    secretKey: process.env.minio_secretKey || ''
})

const bucketName = process.env.minio_bucketName || '',
      bucketPrefix = process.env.minio_bucketPrefix || ''

module.exports = () => {
	return {
		fPutObject: (objectName, filePath) => s3Client.fPutObject(bucketName, bucketPrefix.concat(objectName), filePath),

		getObject: (objectName) => s3Client.getObject(bucketName, bucketPrefix.concat(objectName)),

		removeObjects: async (ttl) => {
			let stream = await s3Client.listObjects(bucketName, bucketPrefix, true), objs = []

			stream.on('data', (obj) => {
				let timeInterval =  Math.ceil((Date.now() - obj.lastModified) / 1000)
				if (obj.name.endsWith('.ts') && timeInterval >= ttl) {
					objs.push(obj.name)
				}
			}).on('end', async () => {
				//console.log(objs)
				await s3Client.removeObjects(bucketName, objs)
			}).on('error', (err) => {
				console.log(err)
			})
		}
	}
}
